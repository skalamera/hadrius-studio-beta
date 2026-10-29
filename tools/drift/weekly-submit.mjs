// Weekly run -> drift jobs. Reads each video's job.json from a weekly.mjs run directory, decides whether it
// should become a Slack approval job, and builds the job payload with jobs.buildJobDetails (Drive/Pylon links
// from the script, proposed narration from the classifier's judge, slide durations from out/<name>/assembly.json).
// Pure + import-safe: all I/O is injected (the bridge passes fs readers; tests pass fakes). Never posts anything:
// the bridge's submitDriftJob does that, and only when the caller asked for a live (non-dry) submit.
import { buildJobDetails, fingerprintOf, plainReason } from './jobs.mjs';

/** Step reason codes that mean "the automation account could not see / load the recorded data", not UI drift. */
export const ACCOUNT_CODES = Object.freeze(['record_not_visible', 'page_not_loaded', 'data_missing', 'page_error']);
const CHANGE_VERDICTS = new Set(['slide_update', 'moved_highlight', 'narration_review', 'full_rerecord']);
/** Service statuses during which a video already has a live job (a new one would be a second Slack thread). */
export const OPEN_STATUSES = Object.freeze(['pending_approval', 'approved', 'in_progress', 'needs_rerecord']);
export const BLOCKED_ACCOUNT_LABEL = "blocked: automation account can't see records";

const codesOf = (s) => (s?.reasons || []).map((r) => r.code);

/**
 * What a weekly job.json means for Slack. Returns
 * {decision:'post'|'blocked_account_visibility'|'skip', reason, uiEvidenceSteps, accountSteps, chromeOnlySteps, verdictMayChangeWithAccess}
 */
export function assessVideo(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const accountSteps = steps.filter((s) => s.verdict === 'unverified' && codesOf(s).some((c) => ACCOUNT_CODES.includes(c))).map((s) => s.index);
  // UI-change evidence: a changed step backed by at least one non-account reason, or a changed sidebar/header.
  const uiEvidenceSteps = steps.filter((s) => (CHANGE_VERDICTS.has(s.verdict) && codesOf(s).some((c) => !ACCOUNT_CODES.includes(c))) || s.chromeChanged).map((s) => s.index);
  const chromeOnlySteps = steps.filter((s) => s.chromeChanged && !CHANGE_VERDICTS.has(s.verdict)).map((s) => s.index);
  const base = { uiEvidenceSteps, accountSteps, chromeOnlySteps, verdictMayChangeWithAccess: false };
  if (!job || job.status !== 'ok') return { ...base, decision: 'skip', reason: `no_verdict:${job?.status ?? 'missing_job'}` };
  if (!uiEvidenceSteps.length) {
    if (accountSteps.length) return { ...base, decision: 'blocked_account_visibility', reason: BLOCKED_ACCOUNT_LABEL };
    if (job.verdict === 'unchanged') return { ...base, decision: 'skip', reason: job.complete === false ? 'unchanged_partially_verified' : 'unchanged' };
    return { ...base, decision: 'skip', reason: 'no_ui_change_evidence' };
  }
  // mixed_old_new_ui forces a re-record whenever a slide is kept; if the kept slides are only unverified because
  // of the account, a later run with record access may find a targeted update instead.
  const mixed = (job.reasons || []).some((r) => r.code === 'mixed_old_new_ui');
  const kept = steps.filter((s) => s.verdict === 'unchanged' || s.verdict === 'unverified');
  return { ...base, decision: 'post', reason: 'ui_change', verdictMayChangeWithAccess: !!(mixed && accountSteps.length && kept.length && kept.every((s) => s.verdict === 'unchanged' || accountSteps.includes(s.index))) };
}

/** The judge's rewrite for steps it found inaccurate (never for data_missing / claim_missing). {index: text} */
export function proposedNarrationOf(job) {
  const out = {};
  for (const s of job?.steps || []) {
    const j = s.judge;
    if (s.verdict === 'narration_review' && j && j.accurate === false && !j.data_missing && !j.claim_missing && j.suggested_rewrite && codesOf(s).includes('narration_inaccurate')) out[s.index] = j.suggested_rewrite;
  }
  return out;
}

export function linksFrom(script, { pylonUrl = null } = {}) {
  const drive = script?.driveVideoUrl || (script?.driveVideoId ? `https://drive.google.com/file/d/${script.driveVideoId}/view` : null);
  const pylon = script?.pylonArticleUrl || (script?.pylonArticleId && pylonUrl ? pylonUrl({ id: script.pylonArticleId }) : null);
  return { drive, pylon, studio: null };
}

/** Per-step seconds from assembly.json slides ({step, sdur}); null when it doesn't map onto the script. */
export function durationsFrom(assembly, script) {
  const n = script?.steps?.length || 0;
  if (!assembly || !Array.isArray(assembly.slides) || !n) return { slideDurations: null, oldDurationSec: assembly?.duration ?? null };
  const d = new Array(n).fill(0);
  for (const sl of assembly.slides) { if (!Number.isInteger(sl.step) || sl.step < 0 || sl.step >= n) return { slideDurations: null, oldDurationSec: assembly.duration ?? null }; d[sl.step] += Number(sl.sdur) || 0; }
  return { slideDurations: d.map((x) => Math.round(x * 1000) / 1000), oldDurationSec: typeof assembly.duration === 'number' ? assembly.duration : null };
}

/**
 * Stable fingerprint: the judge's rewrite text is model output and differs run to run, so it only counts as
 * "a narration change was proposed" — otherwise every weekly run would post the same drift again.
 */
export function stableFingerprint(payload) {
  const changes = (payload.details?.changes || []).map((c) => ({ ...c, newNarration: c.newNarration ? 'proposed' : null }));
  return fingerprintOf({ name: payload.video_name, kind: payload.kind, changes });
}

/** Build the payload for one video. Adds chrome-only evidence steps and the account-access note. */
export function buildPayload({ job, script, assembly = null, prs = [], pylonUrl = null, assessment = assessVideo(job), createdBy = 'weekly-drift' }) {
  const proposedNarration = proposedNarrationOf(job);
  const { slideDurations, oldDurationSec } = durationsFrom(assembly, script);
  const payload = buildJobDetails({ weeklyJob: job, script, links: linksFrom(script, { pylonUrl }), prs, proposedNarration, slideDurations, oldDurationSec, createdBy });
  const d = payload.details;
  const listed = new Set(d.changes.map((c) => c.index));
  // A sidebar/header redesign seen on slides that are otherwise unverified is still evidence the reviewer needs.
  for (const s of (job.steps || []).filter((x) => x.chromeChanged && !listed.has(x.index))) {
    d.changes.push({ step: s.index + 1, index: s.index, verdict: s.verdict, action: s.action || null, changeTypes: ['screenshot'], reasonCodes: ['persistent_chrome_changed'],
      why: [plainReason({ code: 'persistent_chrome_changed' }), ...(s.reasons || []).filter((r) => ACCOUNT_CODES.includes(r.code)).slice(0, 1).map(() => "The rest of this slide couldn't be checked: the automation account can't see the recorded record.")],
      narrationFlagged: false, oldNarration: script?.steps?.[s.index]?.narration ?? null, newNarration: null, metrics: s.metrics ? { diff: s.metrics.diff ?? null, ssim: s.metrics.ssimMasked ?? null } : null,
      before: s.evidence?.recorded ? { path: s.evidence.recorded } : null, after: s.evidence?.today ? { path: s.evidence.today } : null, diff: s.evidence?.diff ? { path: s.evidence.diff } : null });
  }
  d.changes.sort((a, b) => a.index - b.index);
  // Say plainly which reasons are the account's visibility gap rather than drift (buildJobDetails keeps the raw text).
  for (const c of d.changes) c.why = (c.why || []).map((w, i) => (ACCOUNT_CODES.includes(c.reasonCodes?.[i]) && !/^Not UI drift/.test(w) ? `Not UI drift — the automation account can't see this record: ${w}` : w));
  d.reasons = [...new Set(d.changes.flatMap((c) => c.why))].slice(0, 20);
  if (assessment.accountSteps.length) {
    const note = `Step(s) ${assessment.accountSteps.map((i) => i + 1).join(', ')} couldn't be verified: the automation account can't see the recorded records (not UI drift).${assessment.verdictMayChangeWithAccess ? ' The re-record verdict depends on those steps and may change once the account has access.' : ''}`;
    d.reasons = [...d.reasons, note].slice(0, 20);
    d.accountLimited = { steps: assessment.accountSteps.map((i) => i + 1), verdictMayChangeWithAccess: assessment.verdictMayChangeWithAccess };
  }
  payload.fingerprint = stableFingerprint(payload);
  return payload;
}

/**
 * Decide + build for every video of a run.
 * io: {readJson(path)->obj|null, readScript(name)->script|null, readAssembly(name)->obj|null}
 * @returns [{name, decision, reason, verdict, kind?, payload?, assessment}]
 */
export function prepareSubmissions({ summary, runDir, names = null, io, prsByName = {}, pylonUrl = null, createdBy = 'weekly-drift' }) {
  const wanted = names?.length ? new Set(names) : null;
  const seen = new Set();
  const out = [];
  for (const v of summary?.videos || []) {
    if (wanted && !wanted.has(v.name)) continue;
    if (seen.has(v.name)) continue; // a name appears once per run; guard anyway
    seen.add(v.name);
    const job = io.readJson(`${runDir}/${v.name}/job.json`);
    const assessment = assessVideo(job);
    const row = { name: v.name, verdict: job?.verdict ?? null, complete: job?.complete ?? null, status: job?.status ?? v.status, decision: assessment.decision, reason: assessment.reason, assessment, summary: job?.summary ?? v.summary ?? null };
    if (assessment.decision === 'post') {
      const script = io.readScript(v.name);
      if (!script) { row.decision = 'skip'; row.reason = 'script_not_found'; out.push(row); continue; }
      try {
        row.payload = buildPayload({ job, script, assembly: io.readAssembly(v.name), prs: prsByName[v.name] || [], pylonUrl, assessment, createdBy });
        row.kind = row.payload.kind;
      } catch (e) { row.decision = 'skip'; row.reason = `payload_error:${String(e?.message || e).slice(0, 200)}`; }
    }
    out.push(row);
  }
  return out;
}

/**
 * Client-side dedupe against the service's existing jobs (server dedupe covers the same fingerprint; this also
 * stops a second thread for a video that already has an open job under an older fingerprint).
 */
export function dedupeAgainst(rows, existingJobs = []) {
  for (const r of rows) {
    if (r.decision !== 'post') continue;
    const same = existingJobs.find((j) => j.video_name === r.name && j.fingerprint === r.payload.fingerprint && ['pending_approval', 'approved', 'in_progress', 'needs_rerecord', 'denied', 'dismissed'].includes(j.status));
    if (same) { r.decision = 'duplicate'; r.reason = `same drift already has job ${same.id} (${same.status})`; r.existingJob = { id: same.id, status: same.status }; continue; }
    const open = existingJobs.find((j) => j.video_name === r.name && OPEN_STATUSES.includes(j.status));
    if (open) { r.decision = 'duplicate'; r.reason = `video already has an open job ${open.id} (${open.status}); not opening a second thread`; r.existingJob = { id: open.id, status: open.status }; }
  }
  return rows;
}

const topReasons = (r) => {
  if (r.payload) return [...(r.payload.details.rerecordReason || []), ...(r.payload.details.reasons || [])].slice(0, 4);
  return r.summary ? [r.summary.slice(0, 300)] : [];
};

/** Human-readable dry-run/submit summary (markdown). */
export function humanSummary(rows, { runDir, dryRun, generatedAt = new Date().toISOString() } = {}) {
  const L = [`# Drift submit ${dryRun ? 'DRY RUN (nothing posted, no jobs created)' : 'report'}`, '', `Run: \`${runDir}\`  `, `Generated: ${generatedAt}`, ''];
  const count = (d) => rows.filter((r) => r.decision === d).length;
  L.push(`Would post: ${count('post')} · Blocked (account can't see records): ${count('blocked_account_visibility')} · Duplicate: ${count('duplicate')} · Skipped: ${count('skip')}`, '');
  for (const r of rows) {
    const verb = r.decision === 'post' ? (dryRun ? `WOULD POST as ${r.kind}` : `POSTED as ${r.kind}`) : r.decision === 'blocked_account_visibility' ? `NOT POSTED — ${BLOCKED_ACCOUNT_LABEL}` : r.decision === 'duplicate' ? `NOT POSTED — duplicate: ${r.reason}` : `NOT POSTED — ${r.reason}`;
    L.push(`## ${r.name}`, `- Verdict: ${r.verdict ?? '—'}${r.complete === false ? ' (incomplete)' : ''}; status ${r.status}`, `- ${verb}`);
    if (r.payload) L.push(`- Fingerprint: \`${r.payload.fingerprint}\`; changed steps: ${r.payload.details.changes.map((c) => c.step).join(', ') || 'none'}`);
    const acc = r.assessment?.accountSteps || [];
    if (acc.length) L.push(`- Caused by the account's missing record access (unverified, not drift): step(s) ${acc.map((i) => i + 1).join(', ')}${r.assessment.verdictMayChangeWithAccess ? ' — the re-record verdict depends on these and may change once access is fixed' : ''}`);
    if (r.assessment?.uiEvidenceSteps?.length) L.push(`- Real UI-change evidence on step(s): ${r.assessment.uiEvidenceSteps.map((i) => i + 1).join(', ')}`);
    for (const t of topReasons(r)) L.push(`  - ${t.replace(/\n/g, ' ')}`);
    if (r.slack?.error) L.push(`- Slack: ${r.slack.error}`);
    L.push('');
  }
  return L.join('\n');
}

/** Readable plain-text rendering of a Block Kit message (for review without Slack). */
export function blocksToText(msg) {
  const out = [];
  for (const b of msg.blocks || []) {
    if (b.type === 'header') out.push(`=== ${b.text.text} ===`);
    else if (b.type === 'section') out.push(b.text.text);
    else if (b.type === 'context') out.push(`(${b.elements.map((e) => e.text).join(' ')})`);
    else if (b.type === 'divider') out.push('----------------------------------------');
    else if (b.type === 'actions') out.push('[ ' + b.elements.map((e) => e.text.text + (e.url ? ` -> ${e.url}` : '')).join(' ] [ ') + ' ]');
  }
  for (const o of msg.overflow || []) out.push('— thread reply —', o);
  for (const im of msg.images || []) out.push(`— thread images, step ${im.step}: ${im.files.map((f) => f.title).join(' | ')}`);
  return out.join('\n\n');
}
