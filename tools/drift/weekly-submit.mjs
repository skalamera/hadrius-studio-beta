// Weekly run -> drift jobs. Reads each video's job.json from a weekly.mjs run directory, decides whether it
// should become a Slack approval job, and builds the job payload with jobs.buildJobDetails (Drive/Pylon links
// from the script, proposed narration from the classifier's judge, slide durations from out/<name>/assembly.json).
// Pure + import-safe: all I/O is injected (the bridge passes fs readers; tests pass fakes). Never posts anything:
// the bridge's submitDriftJob does that, and only when the caller asked for a live (non-dry) submit.
import { buildJobDetails, fingerprintOf, plainReason } from './jobs.mjs';
import { confirmsProductionUiCodeChange } from './release-evidence.mjs';
import { selectWeeklyJobs, selectedJob, SELECTION_POLICY } from './ui-selection.mjs';
import {semanticRepairCheck} from './semantic-repair-proof.mjs';

/** Step reason codes that mean "the automation account could not see / load the recorded data", not UI drift. */
export const ACCOUNT_CODES = Object.freeze(['record_not_visible', 'page_not_loaded', 'data_missing', 'page_error']);
const CHANGE_VERDICTS = new Set(['slide_update', 'moved_highlight', 'narration_review', 'full_rerecord']);
const UNVERIFIED_UI_CODES = new Set(['empty_state', 'empty_state_data_unverified', 'redesign_release_unconfirmed', 'chrome_release_unconfirmed', 'redesign_unreviewed', 'redesign_not_confirmed', 'no_frontend_release', 'no_release_touched_screen', 'review_pending']);
/** Service statuses during which a video already has a live job (a new one would be a second Slack thread). */
export const OPEN_STATUSES = Object.freeze(['pending_approval', 'approved', 'in_progress', 'needs_rerecord']);
export const BLOCKED_ACCOUNT_LABEL = "blocked: automation account can't see records";

const codesOf = (s) => (s?.reasons || []).map((r) => r.code);

/**
 * What a weekly job.json means for Slack. Returns
 * {decision:'post'|'blocked_account_visibility'|'skip', reason, uiEvidenceSteps, accountSteps, chromeOnlySteps, verdictMayChangeWithAccess}
 */
export function assessVideo(job, { selection = null } = {}) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const accountSteps = steps.filter((s) => s.verdict === 'unverified' && codesOf(s).some((c) => ACCOUNT_CODES.includes(c))).map((s) => s.index);
  // Weekly notifications are limited to redesign candidates backed by a route-matched production UI-code diff.
  // Other signals (narration, route/flow, target movement, ordinary pixel changes) are out of this scan's scope.
  const confirmsUi = (s) => CHANGE_VERDICTS.has(s.verdict) && (
    ((codesOf(s).includes('page_redesigned') || codesOf(s).includes('ui_changed')) && confirmsProductionUiCodeChange(s.uiReleaseEvidence))
    || (codesOf(s).includes('persistent_chrome_changed') && confirmsProductionUiCodeChange(s.uiReleaseEvidence, { chrome: true }))
    // Repairability v2: a kept slide replaced because it shows the same verified change carries that change's evidence.
    || (codesOf(s).includes('kept_slide_shows_verified_change') && confirmsProductionUiCodeChange(s.uiReleaseEvidence)));
  const projected = selectedJob(job, selection);
  const uiEvidenceSteps = (projected?.steps || []).map(s => s.index);
  const chromeOnlySteps = [];
  const base = { uiEvidenceSteps, accountSteps, chromeOnlySteps, verdictMayChangeWithAccess: false, selection };
  if (job?.status === 'excluded') return { ...base, decision: 'excluded', reason: `excluded (${job.exclusion?.rule ?? 'exclusions.json'})` };
  if (!job || job.status !== 'ok') return { ...base, decision: 'skip', reason: `no_verdict:${job?.status ?? 'missing_job'}` };
  if (!uiEvidenceSteps.length) {
    if (steps.some(confirmsUi) && !selection) return { ...base, decision: 'skip', reason: 'weekly_selection_required' };
    if (selection && ['ui_additions_only', 'unused_app_frame_changes', 'selection_context_missing'].includes(selection.reason))
      return { ...base, decision: 'skip', reason: selection.reason };
    if (accountSteps.length) return { ...base, decision: 'blocked_account_visibility', reason: BLOCKED_ACCOUNT_LABEL };
    if (steps.some((s) => codesOf(s).some((c) => UNVERIFIED_UI_CODES.has(c)))) {
      const emptyData = steps.some((s) => codesOf(s).some((c) => c === 'empty_state' || c === 'empty_state_data_unverified'));
      return { ...base, decision: 'skip', reason: emptyData ? 'empty_or_missing_data_unverified' : 'no_release_confirmed_ui_redesign' };
    }
    if (job.verdict === 'unchanged') return { ...base, decision: 'skip', reason: job.complete === false ? 'unchanged_partially_verified' : 'unchanged' };
    // Shared tenants: other people's records come and go; data-only differences are not posted.
    if (job.verdict === 'unchanged_with_data_drift') return { ...base, decision: 'skip', reason: 'data_drift_only' };
    return { ...base, decision: 'skip', reason: 'no_release_confirmed_ui_redesign' };
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

/** Only the fresh, independently checked, same-intent repair plan may replace weekly narration. */
export function verifiedNarrationOf(job,script,selection){
  if(selection?.repair?.decision!=='auto')return {};
  const changes=(selection.slides??[]).flatMap(s=>s.changes),out={};
  for(const action of selection.repair.actions??[]){
    if(typeof action.newNarration!=='string')continue;
    const step=job.steps?.find(s=>s.index===action.index),original=script.steps?.find((s,i)=>(s.index??i)===action.index);
    const checked=semanticRepairCheck(step,original,changes,job.name);
    if(checked?.executionReady&&checked.review.narration.status==='rewrite'
      &&checked.review.narration.suggestedNarration===action.newNarration)out[action.index]=action.newNarration;
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
  assessment=assessVideo(job,{selection:assessment?.selection});
  const sourceJob = selectedJob(job, assessment.selection);
  if (assessment.decision !== 'post' || !sourceJob) throw new Error('weekly_selection_required');
  const { slideDurations, oldDurationSec } = durationsFrom(assembly, script);
  const payload = buildJobDetails({ weeklyJob: sourceJob, script, links: linksFrom(script, { pylonUrl }), prs: [], proposedNarration: verifiedNarrationOf(job,script,assessment.selection), slideDurations, oldDurationSec, createdBy });
  const d = payload.details;
  d.detection.source = 'production_release_diff+recapture';
  if(payload.kind==='auto_update'&&job.candidateInputs)d.execution={...job.candidateInputs};
  d.untouched.unverified = (job.steps || []).filter(s => s.verdict === 'unverified').map(s => ({ step: s.index + 1, why: (s.reasons || []).map(plainReason) }));
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
/**
 * requireCertifiedPreview (default true = the Slack/job posting path): an auto_update row is only 'post' when it carries
 * the certified video Approve will publish. Internal callers that decide WHAT TO RENDER (render-repairs, prepare-repairs,
 * selection-replay) pass false: for them 'post' means "eligible for an automatic repair", nothing is posted.
 */
export function prepareSubmissions({ summary, runDir, names = null, io, prsByName = {}, pylonUrl = null, createdBy = 'weekly-drift', exclude = null, includeAutomaticRepairs = false, requireCertifiedPreview = true }) {
  const wanted = names?.length ? new Set(names) : null;
  // Build context from the full run BEFORE applying a request's names filter. Never trust cached job.uiSelection.
  const jobs = new Map(), scripts = new Map();
  for (const v of summary?.videos || []) if (!jobs.has(v.name)) {
    jobs.set(v.name, io.readJson(`${runDir}/${v.name}/job.json`));
    scripts.set(v.name, io.readScript(v.name));
  }
  const selection = selectWeeklyJobs([...jobs].map(([name, j]) => j ? ({ ...j, name }) : ({name,status:'missing_job',steps:[]})), { readScript: n => scripts.get(n) });
  const marker=summary?.uiSelection;
  const finalized=marker?.policy===SELECTION_POLICY&&marker.status==='finalized'&&marker.inputHash===selection.inputHash
    &&JSON.stringify(marker.names)===JSON.stringify(selection.names);
  // Automatic repairs and operational evidence/setup holds are not human re-record approval jobs unless
  // includeAutomaticRepairs is explicitly requested. A completed automation report must be bound to THIS full-batch selection.
  const parentReport=!summary?.automation&&includeAutomaticRepairs?io.readJson(`${runDir}/../latest.json`):null;
  const automated=summary?.automation||(parentReport?.preparationDir===runDir?{status:'finished',report:`${runDir}/../latest.json`}:null);
  const automationReport=automated?.report?(parentReport&&automated.report===`${runDir}/../latest.json`?parentReport:io.readJson(automated.report)):null;
  const selectedPairs=selection.review.flagged.flatMap(v=>v.slides.map(s=>`${v.name}#${s.index}`)).sort();
  const automationValid=automationReport?.schema===1&&automationReport.finishedAt
    &&(automationReport.sourceSelectionInputHash===selection.inputHash||automationReport.preparationDir===runDir)
    &&JSON.stringify(automationReport.names?.slice().sort())===JSON.stringify(selection.names)
    &&JSON.stringify(automationReport.selectedPairs?.slice().sort())===JSON.stringify(selectedPairs)
    &&Array.isArray(automationReport.rows)&&automationReport.rows.length===selection.names.length
    &&new Set(automationReport.rows.map(r=>r.name)).size===selection.names.length;
  let preparedJobs=null,preparedSelection=null;
  if(includeAutomaticRepairs&&automationValid&&automationReport.preparationDir){
    if(automationReport.preparationDir===runDir){preparedJobs=jobs;preparedSelection=selection;}
    else{
      preparedJobs=new Map();
      for(const name of automationReport.names||[]){const pj=io.readJson(`${automationReport.preparationDir}/${name}/job.json`);preparedJobs.set(name,pj?{...pj,name}:null);}
      preparedSelection=selectWeeklyJobs([...preparedJobs].map(([name,j])=>j?({...j,name}):({name,status:'missing_job',steps:[]})),{readScript:n=>scripts.get(n)});
    }
  }
  const seen = new Set();
  const out = [];
  for (const v of summary?.videos || []) {
    if (wanted && !wanted.has(v.name)) continue;
    if (seen.has(v.name)) continue; // a name appears once per run; guard anyway
    seen.add(v.name);
    const rawJob = jobs.get(v.name), job = rawJob ? { ...rawJob, name: v.name } : null;
    const assessment = assessVideo(job, { selection: selection.byName.get(v.name) });
    if(assessment.decision!=='excluded'){
      if (!summary?.finishedAt) { assessment.decision = 'skip'; assessment.reason = 'weekly_run_incomplete'; }
      else if(!finalized){assessment.decision='skip';assessment.reason='weekly_selection_required';}
    }
    const row = { name: v.name, verdict: job?.verdict ?? null, complete: job?.complete ?? null, status: job?.status ?? v.status, decision: assessment.decision, reason: assessment.reason, assessment, summary: job?.summary ?? v.summary ?? null };
    // Temporary module exclusions (exclusions.json) apply at submit time too, also to runs made before the exclusion:
    // an excluded video is never posted.
    const ex = exclude ? exclude(v.name) : null;
    if (ex && row.decision !== 'excluded') { row.decision = 'excluded'; row.reason = `excluded (${ex.rule})`; }
    if (row.decision === 'excluded') { row.exclusion = ex ?? job?.exclusion ?? null; out.push(row); continue; }
    let activeJob=job,activeAssessment=assessment;
    if(automated&&row.decision==='post'){
      const automatic=automationValid?automationReport.rows.find(r=>r.name===v.name):null;
      const canSubmitAuto=includeAutomaticRepairs&&automatic?.status==='automatically_repaired'
        &&automatic.qa?.ok===true&&automatic.result?.candidate&&automatic.result?.sha256&&automatic.result?.verification;
      if(canSubmitAuto){
        const prepJob=preparedJobs?.get(v.name)??job;
        const prepSel=preparedSelection?.byName.get(v.name)??selection.byName.get(v.name);
        const prepAssessment=assessVideo(prepJob,{selection:prepSel});
        if(!prepJob||prepAssessment.decision!=='post'){
          row.decision='skip';row.reason='automation_prepared_job_invalid';
          row.automation={status:automatic.status,reason:'automation_prepared_job_invalid'};
          out.push(row);continue;
        }
        activeJob=prepJob;activeAssessment=prepAssessment;
        row.verdict=prepJob.verdict??row.verdict;row.assessment=prepAssessment;
        row.automation={status:'automatically_repaired',reason:automatic.reason??null,candidate:automatic.result.candidate,
          sha256:automatic.result.sha256,verification:automatic.result.verification,automaticQa:automatic.result.automaticQa??null,
          baselineDir:automatic.qa?.baselineDir??null};
      }else if(!automatic||automatic.status!=='human_required'){
        row.decision='skip';row.reason=automatic?.status??'automation_report_unverified';
        row.automation=automatic?{status:automatic.status,reason:automatic.reason??null}:null;
        out.push(row);continue;
      }else{
        // Only positively established unsupported changes enter the human approval/re-record queue.
        row.automation={status:'human_required',reason:automatic.reason};
      }
    }
    if (activeAssessment.decision === 'post') {
      const script = scripts.get(v.name);
      if (!script) { row.decision = 'skip'; row.reason = 'script_not_found'; out.push(row); continue; }
      try {
        row.payload = buildPayload({ job: activeJob, script, assembly: io.readAssembly(v.name), prs: prsByName[v.name] || [], pylonUrl, assessment: activeAssessment, createdBy });
        if (row.automation?.status === 'automatically_repaired') {
          if (row.payload.kind !== 'auto_update') throw new Error(`expected auto_update for automatically_repaired, got ${row.payload.kind}`);
          row.payload.details.execution = {
            ...(row.payload.details.execution || {}),
            ...(row.automation.baselineDir ? { rebaselineDir: row.automation.baselineDir } : {}),
            ...(activeJob.candidate?.recordingPath ? { candidateRecordingsDir: activeJob.candidate.recordingPath } : {}),
            automaticResult: {
              candidate: row.automation.candidate,
              sha256: row.automation.sha256,
              verification: row.automation.verification,
              automaticQa: row.automation.automaticQa,
              baselineDir: row.automation.baselineDir,
            },
          };
        }
        // Preview-bound approval: an update is only ever offered for approval together with the exact, already
        // rendered and automatically certified video that Approve will publish (uploaded into the Slack thread).
        // Without one there is nothing a person could look at before approving, so it is not posted.
        // Automation established this change cannot be repaired automatically: it is a re-record for a person, never an
        // auto_update that would be rendered only after someone approved it.
        if (row.automation?.status === 'human_required' && row.payload.kind !== 'manual_rerecord') {
          row.payload.kind = 'manual_rerecord';
          delete row.payload.details.execution;
          row.payload.details.rerecordReason = [...new Set([...(row.payload.details.rerecordReason || []), `The automatic repair can't make this change (${row.automation.reason || 'unsupported change'}): a person needs to re-record it.`])];
          row.payload.fingerprint = stableFingerprint(row.payload);
        }
        const ar = row.payload.details.execution?.automaticResult;
        if (row.payload.kind === 'auto_update' && requireCertifiedPreview) {
          if (!ar?.candidate || !/^[0-9a-f]{64}$/.test(String(ar.sha256 || ''))) { row.decision = 'skip'; row.reason = 'no_certified_preview'; row.kind = row.payload.kind; out.push(row); continue; }
          row.payload.details.preview = { path: ar.candidate, sha256: ar.sha256, verification: ar.verification ?? null };
        }
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
  L.push(`Would post: ${count('post')} · Blocked (account can't see records): ${count('blocked_account_visibility')} · Duplicate: ${count('duplicate')} · Excluded: ${count('excluded')} · Skipped: ${count('skip')}`, '');
  for (const r of rows) {
    const verb = r.decision === 'post' ? (dryRun ? `WOULD POST as ${r.kind}` : `POSTED as ${r.kind}`) : r.decision === 'blocked_account_visibility' ? `NOT POSTED — ${BLOCKED_ACCOUNT_LABEL}` : r.decision === 'duplicate' ? `NOT POSTED — duplicate: ${r.reason}` : r.decision === 'excluded' ? `NOT POSTED — ${r.reason}` : `NOT POSTED — ${r.reason}`;
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
  if (msg.video) out.push(`— thread video (first reply): ${msg.video.filename} sha256 ${msg.video.sha256} (${msg.video.path})`);
  for (const im of msg.images || []) out.push(`— thread images, step ${im.step}: ${im.files.map((f) => f.title).join(' | ')}`);
  return out.join('\n\n');
}
