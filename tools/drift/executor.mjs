// Execute APPROVED drift jobs end to end (tools/drift/README.md "Executing approved jobs"):
//   claim (approved -> in_progress, CAS) -> resolve inputs -> [rebaseline if missing] ->
//   renderer/drift_update.py -> verification ok -> publish.mjs (Drive -> Pylon -> library) ->
//   published (+links) | failed (+reason, what was / wasn't changed, rollback result).
// Slack: short thread notes via the service (POST ?action=note; falls back to a direct Slack thread
// reply when the deployed service predates the note route) plus the service's own status replies.
// Concurrency 1 (lock file), per-stage timeouts, crash-safe journal per attempt.
// Import-safe: no side effects; every dependency injected. The bridge wires real clients (credentials stay in its env).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openJournal, publishCandidate, rollbackPublish, PublishError, md5File, sha256File } from './publish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'drift-exec');
export const TIMEOUTS = Object.freeze({ rebaselineMs: 30 * 60_000, renderMs: 75 * 60_000, lockStaleMs: 4 * 3600_000 });

export class ExecError extends Error { constructor(code, detail = null) { super(`${code}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); this.code = code; this.detail = detail; } }
const fail = (code, detail) => { throw new ExecError(code, detail); };

// ------------------------------------------------------------------ lock (concurrency 1)
export function acquireLock(file, { staleMs = TIMEOUTS.lockStaleMs, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid, host: os.hostname(), at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { release: () => { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === pid) fs.rmSync(file, { force: true }); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = null; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable = stale */ }
      let alive = false; try { if (cur?.pid) { process.kill(cur.pid, 0); alive = true; } } catch { alive = false; }
      const old = cur?.at && Date.now() - Date.parse(cur.at) > staleMs;
      if (alive && !old) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

// ------------------------------------------------------------------ inputs
/**
 * Contract (set by the weekly job submitter in job.details.execution; every path absolute):
 *   { schema:1, scriptName, weeklyDir?, identifiedScript?, candidateManifest?, changeManifest?,
 *     rebaselineDir?, buildDir?, recordingsDir?, reportPath? }
 * Fallbacks: weeklyDir = the folder holding job.json above a change's evidence path; identifiedScript =
 * weeklyDir/identified-base.script.json; candidateManifest = weeklyDir/candidate-manifest.json;
 * recordingsDir = out/_recordings/<recording.id>; buildDir = out/<name>/_build; reportPath =
 * out/<name>/report.json. Narration changes come from the APPROVED details.changes[].newNarration.
 */
export function resolveInputs(job, { repo = REPO } = {}) {
  const d = job.details || {};
  const ex = d.execution || {};
  const name = ex.scriptName || d.video?.name || job.video_name;
  if (!name || /^_studio/.test(name)) fail('invalid_script_name', name);
  let weeklyDir = ex.weeklyDir || null;
  if (!weeklyDir) {
    for (const c of d.changes || []) {
      for (let p = c.after?.path || c.before?.path; p && p !== path.dirname(p); p = path.dirname(p)) {
        if (fs.existsSync(path.join(p, 'job.json')) && fs.existsSync(path.join(p, 'identified-base.script.json'))) { weeklyDir = p; break; }
      }
      if (weeklyDir) break;
    }
  }
  const identifiedScript = ex.identifiedScript || (weeklyDir && path.join(weeklyDir, 'identified-base.script.json'));
  if (!identifiedScript || !fs.existsSync(identifiedScript)) fail('missing_identified_script', 'job.details.execution.identifiedScript / weeklyDir not found on this machine');
  const script = JSON.parse(fs.readFileSync(identifiedScript, 'utf8'));
  if (!Array.isArray(script.steps) || script.steps.some((s) => !s.id)) fail('script_needs_stable_step_ids');
  const recordingsDir = ex.recordingsDir || path.join(repo, 'out', '_recordings', script.recording?.id || '');
  if (!script.recording?.id || !fs.existsSync(recordingsDir)) fail('missing_recordings_dir', recordingsDir);
  const buildDir = ex.buildDir || path.join(repo, 'out', name, '_build');
  if (!fs.existsSync(buildDir)) fail('missing_build_dir', `${buildDir} (render.sh wipes out/<name>; the baseline _build is required)`);
  const reportPath = ex.reportPath || path.join(repo, 'out', name, 'report.json');
  const candidateManifest = ex.candidateManifest || (weeklyDir && path.join(weeklyDir, 'candidate-manifest.json'));
  return { name, weeklyDir, identifiedScript, script, recordingsDir, buildDir, reportPath: fs.existsSync(reportPath) ? reportPath : null,
    candidateManifest: candidateManifest && fs.existsSync(candidateManifest) ? candidateManifest : null, changeManifest: ex.changeManifest || null,
    rebaselineDir: ex.rebaselineDir || null, originalVideo: path.join(repo, 'out', name, `${name}.mp4`) };
}

/**
 * Build the drift_update change manifest ONLY from what was approved: screenshot/target changes from the
 * weekly candidate manifest (each must belong to an approved step and match its approved "after"
 * evidence bytes), narration from details.changes[].newNarration.
 */
export function buildChangeManifest(job, inputs, baselineManifestHash) {
  const steps = inputs.script.steps;
  const approved = (job.details?.changes || []).filter((c) => Number.isInteger(c.index) && steps[c.index]);
  if (!approved.length) fail('no_approved_changes');
  const byId = new Map();
  const add = (stepId) => { if (!byId.has(stepId)) byId.set(stepId, { stepId }); return byId.get(stepId); };
  const approvedIds = new Set(approved.map((c) => steps[c.index].id));
  if (inputs.candidateManifest) {
    const cm = JSON.parse(fs.readFileSync(inputs.candidateManifest, 'utf8'));
    for (const c of cm.changes || []) {
      if (!approvedIds.has(c.stepId)) fail('unapproved_step_in_candidate', c.stepId);
      const e = add(c.stepId);
      if (c.imagePath) {
        const p = path.isAbsolute(c.imagePath) ? c.imagePath : path.resolve(path.dirname(inputs.candidateManifest), c.imagePath);
        if (!fs.existsSync(p)) fail('missing_screenshot', p);
        const sha = sha256File(p);
        if (c.sha256 && c.sha256 !== sha) fail('screenshot_hash_mismatch', p);
        const ap = approved.find((a) => steps[a.index].id === c.stepId)?.after?.path;
        if (ap && fs.existsSync(ap) && sha256File(ap) !== sha) fail('approved_evidence_mismatch', `step ${c.stepId}: candidate screenshot is not the approved "after" image`);
        e.screenshot = { path: p, sha256: sha };
      }
      if (c.target) e.target = c.target;
      if (c.dpr != null) e.dpr = c.dpr;
    }
  }
  for (const c of approved) {
    if (!(c.changeTypes || []).includes('narration') || c.newNarration == null) continue;
    const st = steps[c.index];
    if ((st.narration || '') !== (c.oldNarration || '')) fail('old_text_mismatch', `step ${c.step}`);
    add(st.id).narration = { oldText: st.narration, newText: String(c.newNarration) };
  }
  if (!byId.size) fail('no_executable_changes', 'approved job has neither a candidate screenshot/target change nor approved narration text');
  return { baselineManifestHash, changes: [...byId.values()] };
}

// ------------------------------------------------------------------ subprocess runner
export function runProcess(cmd, args, { cwd = REPO, timeoutMs, env = process.env, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; if (err.length > 200_000) err = err.slice(-100_000); });
    const t = setTimeout(() => { log(`[drift-exec] timeout: ${cmd} ${args[1] || ''}`); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, stdout: out, stderr: err, timedOut: signal === 'SIGTERM' || signal === 'SIGKILL' }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e), timedOut: false }); });
  });
}
const lastJson = (s) => { const lines = String(s || '').trim().split('\n'); for (let i = lines.length - 1; i >= 0; i--) { const t = lines.slice(i).join('\n'); try { return JSON.parse(t); } catch { /* keep going */ } } return null; };
const PY = () => path.join(REPO, '.venv', 'bin', 'python');

export async function defaultRebaseline({ name, output, log }) {
  const r = await runProcess(PY(), ['-m', 'renderer.rebaseline', '--repo', REPO, '--name', name, '--output', output], { timeoutMs: TIMEOUTS.rebaselineMs, log, env: { ...process.env, TMPDIR: path.dirname(output) } });
  if (r.code !== 0) fail(r.timedOut ? 'rebaseline_timeout' : 'rebaseline_failed', (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | '));
  const v = readPyJson(path.join(output, 'verification.json'));
  if (v.ok === false) fail('rebaseline_unverified', path.join(output, 'verification.json'));
  return output;
}

export async function defaultRender({ args, log }) {
  const r = await runProcess(PY(), ['-m', 'renderer.drift_update', ...args], { timeoutMs: TIMEOUTS.renderMs, log, env: { ...process.env, TMPDIR: path.join(os.homedir(), '.hermes', 'cache', 'scratch') } });
  const j = lastJson(r.stdout);
  if (r.timedOut) fail('render_timeout');
  if (j?.rejected) fail(`render_rejected:${j.rejected}`, j.detail);
  if (r.code !== 0 && !j) fail('render_failed', (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
  return j || {};
}

/** JSON written by Python's json module may contain bare Infinity/NaN (e.g. PSNR/SNR of identical audio). */
export function readPyJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8').replace(/([:\[,]\s*)-?(?:Infinity|NaN)\b/g, '$1null'));
}

/** Strict check of drift_update's verification.json before anything is published. */
export function checkVerification(outputDir) {
  const f = path.join(outputDir, 'verification.json');
  if (!fs.existsSync(f)) fail('verification_missing', f);
  const v = readPyJson(f);
  if (v.ok !== true) fail('verification_failed', v.rejected || 'verification.json ok=false');
  if (v.dry_run) fail('verification_dry_run');
  if (v.noop) fail('noop_candidate', 'the approved change set rendered to the baseline itself; nothing to publish');
  if (!v.candidate || !fs.existsSync(v.candidate)) fail('candidate_missing', v.candidate);
  if (sha256File(v.candidate) !== v.candidate_sha256) fail('candidate_hash_mismatch');
  if (v.source_unchanged === false) fail('source_files_changed_during_render');
  const cells = v.plan?.cell_map || [];
  const fNew = v.plan?.frames?.new, fBase = v.plan?.frames?.base;
  const reused = cells.filter((c) => c.action === 'reuse').reduce((a, c) => a + (c.new[1] - c.new[0]), 0);
  return { file: f, v, candidate: v.candidate, sha256: v.candidate_sha256, framesPreservedPct: fNew ? Math.round((reused / fNew) * 1000) / 10 : null,
    oldDurationSec: fBase ? Math.round((fBase / 30) * 10) / 10 : null, newDurationSec: fNew ? Math.round((fNew / 30) * 10) / 10 : null, elevenLabsChars: v.elevenlabs_characters || 0,
    candidateScript: v.candidate_script, dirtySlides: v.plan?.dirty_slides || [] };
}

// ------------------------------------------------------------------ notes
async function note(deps, job, text) {
  try {
    if (!deps.noteViaService) throw Object.assign(new Error('no service note route'), { fallback: true });
    await deps.jobs.note({ id: job.id, note: text, by: deps.whoami });
  } catch (e) {
    const missingRoute = e?.fallback || e?.status === 400 || e?.status === 404;
    if (missingRoute) deps.noteViaService = false;
    if (missingRoute && deps.slackThreadReply && job.slack_ts) {
      try { await deps.slackThreadReply(job, text); return; } catch (e2) { deps.log(`[drift-exec] slack note failed: ${e2?.message || e2}`); }
    } else deps.log(`[drift-exec] note failed: ${e?.message || e}`);
  }
}
const mmss = (s) => (s == null ? '?' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

// ------------------------------------------------------------------ execute
/**
 * deps: {jobs, whoami, stateRoot, publishDeps:{drive,pylon,library,local,recordings}, getTargets(name)->{driveFileId,pylonArticleId,title},
 *        render?, rebaseline?, slackThreadReply?, undoUrl?(job), log?, now?}
 * Returns {status: 'skipped'|'published'|'failed', reason?, links?}
 */
export async function executeJob(job, deps) {
  deps = { log: () => {}, noteViaService: true, stateRoot: DEFAULT_STATE_ROOT, render: defaultRender, rebaseline: defaultRebaseline, ...deps };
  if (job.kind !== 'auto_update') return { status: 'skipped', reason: 'not_auto_update' };
  const jobDir = path.join(deps.stateRoot, job.id);
  const lock = acquireLock(path.join(deps.stateRoot, 'executor.lock'));
  if (!lock) return { status: 'skipped', reason: 'another_execution_running' };
  try {
    // Attempt dir: resume the latest unfinished attempt only if WE own an in_progress job; a fresh claim starts a new attempt.
    const attempts = fs.existsSync(jobDir) ? fs.readdirSync(jobDir).filter((d) => /^attempt-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])) : [];
    let attemptDir, journal, current = job;
    if (job.status === 'in_progress') {
      const last = attempts.at(-1);
      const j = last && openJournal(path.join(jobDir, last, 'journal.json'));
      if (!j || j.get('owner') !== deps.whoami) return { status: 'skipped', reason: 'in_progress_elsewhere' };
      const fin = j.get('finished');
      if (fin) {
        // Finished locally but the service never heard: re-send the final status only (no work redone).
        try { await deps.jobs.progress({ id: job.id, status: fin.status, note: fin.status === 'published' ? 'Published by the drift executor' : `${fin.stage}: ${fin.reason}`, links: fin.links || null, by: deps.whoami }); }
        catch (e) { return { status: 'skipped', reason: `final_status_unsent: ${e?.message || e}` }; }
        return { status: fin.status, resent: true };
      }
      attemptDir = path.join(jobDir, last); journal = j;
      deps.log(`[drift-exec] resuming ${job.video_name} (${job.id}) ${last}`);
      await note(deps, job, `⚙️ Update resumed on ${os.hostname()} after an interruption: re-checking what was already done before redoing anything.`);
    } else if (job.status === 'approved') {
      try { const claimed = (await deps.jobs.progress({ id: job.id, status: 'in_progress', note: `Executor started on ${os.hostname()}`, by: deps.whoami, expectedVersion: job.version })).job; current = claimed ? { ...claimed, details: job.details } : job; }
      catch (e) { if (e?.status === 409 || e?.code === 'conflict') return { status: 'skipped', reason: 'claimed_elsewhere' }; throw e; }
      attemptDir = path.join(jobDir, `attempt-${attempts.length + 1}`);
      fs.mkdirSync(attemptDir, { recursive: true });
      journal = openJournal(path.join(attemptDir, 'journal.json'));
      journal.set('owner', deps.whoami); journal.set('jobId', job.id); journal.set('startedAt', new Date().toISOString());
    } else return { status: 'skipped', reason: `status_${job.status}` };

    let stage = 'inputs';
    try {
      const inputs = resolveInputs(current, { repo: deps.repo || REPO });
      const targets = await deps.getTargets(inputs.name);
      if (!targets?.driveFileId) fail('missing_drive_file_id', 'the script has no driveVideoId; drift updates never create a new Drive file');
      journal.set('targets', targets);

      stage = 'rebaseline';
      let rebaselineDir = inputs.rebaselineDir || journal.get('rebaselineDir');
      if (!rebaselineDir) {
        await note(deps, current, `⚙️ Update started on ${os.hostname()}. No rebaseline for this video yet: building one now (a one-time, disclosed lossy re-encode of the published MP4 into independently decodable cells).`);
        rebaselineDir = await deps.rebaseline({ name: inputs.name, output: path.join(attemptDir, 'rebaseline'), log: deps.log });
        journal.set('rebaselineDir', rebaselineDir); journal.set('rebaselineBuilt', true);
      } else if (!journal.get('startNoted')) await note(deps, current, `⚙️ Update started on ${os.hostname()}: rendering only the approved steps (rebaseline ${path.basename(rebaselineDir)}).`);
      journal.set('startNoted', true);
      const rbManifest = readPyJson(path.join(rebaselineDir, 'baseline-manifest.json'));
      const baselineManifestHash = sha256File(path.join(rebaselineDir, 'baseline-manifest.json'));

      stage = 'render';
      let ver = journal.get('render')?.output ? (() => { try { return checkVerification(journal.get('render').output); } catch { return null; } })() : null;
      if (!ver) {
        const changes = inputs.changeManifest ? JSON.parse(fs.readFileSync(inputs.changeManifest, 'utf8')) : buildChangeManifest(current, inputs, baselineManifestHash);
        if (changes.baselineManifestHash !== baselineManifestHash) fail('baseline_manifest_conflict');
        const cmPath = path.join(attemptDir, `change-manifest-${Date.now()}.json`);
        fs.writeFileSync(cmPath, JSON.stringify(changes, null, 2) + '\n');
        const output = path.join(attemptDir, `render-${Date.now()}`);
        journal.set('render', { output, changeManifest: cmPath, startedAt: new Date().toISOString() });
        const args = ['--rebaseline-dir', rebaselineDir, '--script', inputs.identifiedScript, '--recordings-dir', inputs.recordingsDir, '--changes', cmPath,
          '--build-dir', inputs.buildDir, '--output', output, ...(inputs.reportPath ? ['--report', inputs.reportPath] : [])];
        await deps.render({ args, log: deps.log, output });
        ver = checkVerification(output);
        journal.merge('render', { ok: true, candidate: ver.candidate, sha256: ver.sha256 });
        await note(deps, current, `✅ Candidate verified (preservation checks passed): ≈${ver.framesPreservedPct ?? '?'}% of frames reused unchanged, duration ${mmss(ver.oldDurationSec)} → ${mmss(ver.newDurationSec)}, ${ver.elevenLabsChars} ElevenLabs characters. Publishing to the same Drive file, the same Pylon article (video only) and the shared script.`);
      }

      stage = 'publish';
      const candidateScript = readPyJson(ver.candidateScript);
      const candRec = path.join(journal.get('render').output, 'candidate', '_recordings', candidateScript.recording?.id || '');
      const ctx = { jobId: job.id, name: inputs.name, title: targets.title || inputs.script.title || inputs.name, driveFileId: targets.driveFileId, pylonArticleId: targets.pylonArticleId || null,
        candidatePath: ver.candidate, candidateSha256: ver.sha256, candidateScript, identifiedBase: inputs.script,
        candidateRecordingsDir: fs.existsSync(candRec) ? candRec : null,
        baselineMd5: rbManifest.original?.sha256 && fs.existsSync(inputs.originalVideo) && sha256File(inputs.originalVideo) === rbManifest.original.sha256 ? md5File(inputs.originalVideo) : null };
      if (!ctx.baselineMd5) fail('baseline_video_missing', 'out/<name>/<name>.mp4 must be the rebaseline\'s original (it proves Drive still holds the baseline)');
      const pub = await publishCandidate(ctx, { ...deps.publishDeps, log: deps.log }, journal);

      stage = 'finish';
      const undo = deps.undoUrl ? deps.undoUrl(current) : null;
      const links = Object.fromEntries(Object.entries({ drive: pub.links.drive, pylon: pub.links.pylon, undo }).filter(([, v]) => typeof v === 'string' && /^https:\/\//.test(v)));
      const pyl = pub.pylon?.skipped ? 'no Pylon article linked (skipped)' : pub.pylon?.mode === 'drive_link' ? 'Pylon article links the same Drive file (no edit needed)' : 'Pylon article: video swapped, rest of the article unchanged';
      await note(deps, current, `🚀 Published.\n• Drive: same file, new revision (previous revision kept forever)${pub.links.drive ? ` <${pub.links.drive}|open>` : ''}\n• ${pyl}${pub.links.pylon ? ` <${pub.links.pylon}|open>` : ''}\n• Shared script updated (previous revision saved)${undo ? `\n<${undo}|↩️ Undo update> (opens Studio → Updates → Undo)` : ''}`);
      journal.set('finished', { status: 'published', at: new Date().toISOString(), links });
      try { await deps.jobs.progress({ id: job.id, status: 'published', note: 'Published by the drift executor', links, by: deps.whoami }); }
      catch (e) { deps.log(`[drift-exec] published ${job.id} but could not record it on the service (retried next poll): ${e?.message || e}`); }
      return { status: 'published', links, journal: journal.file };
    } catch (e) {
      const reason = e?.code || 'error';
      const applied = e?.applied || [];
      const rb = e?.rollback;
      const changed = !applied.length ? 'Nothing was changed on Drive, Pylon or the shared script.'
        : `Applied before the failure: ${applied.join(', ')}. Automatic rollback: ${rb?.ok ? 'done, everything restored' : `INCOMPLETE ${JSON.stringify(rb?.steps || {})} — run Undo from Studio → Updates (bridge POST /drift/jobs/${job.id}/rollback) on ${os.hostname()}`}.`;
      const msg = `⚠️ Update failed at *${e?.stage || stage}*: \`${reason}\`${e?.detail ? ` — ${String(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)).slice(0, 400)}` : (e instanceof ExecError || e instanceof PublishError) ? '' : ` — ${String(e?.message || e).slice(0, 300)}`}\n${changed}`;
      journal.set('finished', { status: 'failed', reason, stage: e?.stage || stage, message: String(e?.message || e).slice(0, 1000), at: new Date().toISOString(), applied, rollback: rb || null });
      await note(deps, current, msg);
      try { await deps.jobs.progress({ id: job.id, status: 'failed', note: `${e?.stage || stage}: ${reason}`.slice(0, 2000), by: deps.whoami }); }
      catch (pe) { deps.log(`[drift-exec] could not mark ${job.id} failed: ${pe?.message || pe}`); }
      return { status: 'failed', reason, stage: e?.stage || stage, applied, rollback: rb || null, journal: journal.file };
    }
  } finally { lock.release(); }
}

/** One poll: approved auto_update jobs (oldest first) plus our own interrupted in_progress jobs. */
export async function pollOnce(deps) {
  const { jobs = [] } = await deps.jobs.list({ status: ['approved', 'in_progress'], kind: 'auto_update', limit: 50 });
  const results = [];
  for (const j of [...jobs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (deps.isBusy?.()) { results.push({ id: j.id, status: 'skipped', reason: 'bridge_busy' }); break; }
    const r = await executeJob(j, deps);
    results.push({ id: j.id, ...r });
    if (r.reason === 'another_execution_running') break;
  }
  return results;
}

/** Local executor state for a job (the panel's Undo button and the rollback route use it). */
export function localJobState(jobId, stateRoot = DEFAULT_STATE_ROOT) {
  const dir = path.join(stateRoot, jobId);
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !fs.existsSync(dir)) return null;
  const last = fs.readdirSync(dir).filter((d) => /^attempt-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])).at(-1);
  if (!last) return null;
  const j = openJournal(path.join(dir, last, 'journal.json'));
  const s = j.state;
  const rolledBack = s.rollback?.ok && s.rollback.reason?.startsWith('manual') ? s.rollback.at : null;
  return { attempt: last, journal: j.file, finished: s.finished || null, canRollback: s.finished?.status === 'published' && !rolledBack, rolledBackAt: rolledBack, rollback: s.rollback || null };
}

/** Manual one-click rollback of a published job (restores Drive revision, Pylon body, shared script). */
export async function rollbackJob(jobId, deps) {
  deps = { log: () => {}, stateRoot: DEFAULT_STATE_ROOT, noteViaService: true, ...deps };
  const st = localJobState(jobId, deps.stateRoot);
  if (!st) fail('no_local_record', 'this job was not executed on this machine (the rollback record lives with the executor)');
  if (st.finished?.status !== 'published') fail('not_published', st.finished?.status || 'unfinished');
  if (st.rolledBackAt) fail('already_rolled_back', st.rolledBackAt);
  const lock = acquireLock(path.join(deps.stateRoot, 'executor.lock'));
  if (!lock) fail('busy', 'an update is running; try again when it finishes');
  try {
    const journal = openJournal(st.journal);
    const res = await rollbackPublish(journal, { ...deps.publishDeps, log: deps.log }, { reason: `manual by ${deps.whoami}` });
    let job = null; try { job = (await deps.jobs.get(jobId)).job; } catch { /* note best-effort */ }
    if (job) await note(deps, job, res.ok
      ? `↩️ Update rolled back by ${deps.whoami}: Drive file restored to its previous revision (same id), Pylon article body restored, shared script restored.`
      : `⚠️ Rollback by ${deps.whoami} was incomplete: ${JSON.stringify(res.steps)}`);
    return res;
  } finally { lock.release(); }
}
