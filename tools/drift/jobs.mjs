// Drift job client + job-details builder for the shared drift-job service
// (webhook-service api/studio-drift.ts). Import-safe: no side effects, no .env reads; the secret
// comes from an injected getter so callers decide where it lives (the bridge uses process.env).
import { createHash } from 'node:crypto';

export const DRIFT_CHANNEL = 'C0CD42Y6RU6';
export const KINDS = Object.freeze(['auto_update', 'manual_rerecord']);
export const DECISIONS = Object.freeze(['approve', 'deny', 'claim', 'rerecorded', 'dismiss']);
const DEFAULT_LIBRARY_URL = 'https://pylon-webhook-service.vercel.app/api/studio-beta-scripts';

/** Service URL on the same host as the bridge's shared library (STUDIO_LIBRARY_URL). */
export function serviceUrlFrom(libraryUrl = DEFAULT_LIBRARY_URL) {
  let u;
  try { u = new URL(libraryUrl || DEFAULT_LIBRARY_URL); } catch { u = new URL(DEFAULT_LIBRARY_URL); }
  return `${u.origin}/api/studio-drift`;
}

export class DriftServiceError extends Error {
  constructor(message, { status = 0, code = 'error', body = null } = {}) { super(message); this.status = status; this.code = code; this.body = body; }
}

/**
 * @param {{baseUrl:string,getSecret:()=>string,fetchImpl?:typeof fetch,timeoutMs?:number}} opts
 */
export function createJobsClient({ baseUrl, getSecret, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (!baseUrl) throw new Error('baseUrl required');
  async function call(method, { query = null, body = null } = {}) {
    const secret = String(getSecret?.() || '').trim();
    if (!secret) throw new DriftServiceError('Drift jobs are not configured on this machine: STUDIO_SHARED_SECRET is missing from the bridge .env.', { code: 'not_configured' });
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(baseUrl + (qs === '?' ? '' : qs), { method, signal: ctl.signal,
        headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new DriftServiceError(`Drift job service unreachable (${baseUrl}): ${e?.name === 'AbortError' ? 'timed out' : e?.message || e}`, { code: 'unreachable' });
    } finally { clearTimeout(t); }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. Vercel 404 page) */ }
    if (r.status === 404 && !json?.error) throw new DriftServiceError(`The drift job service isn't deployed yet (${baseUrl} returned 404). Deploy webhook-service with api/studio-drift.ts.`, { status: 404, code: 'service_missing' });
    if (r.status === 401) throw new DriftServiceError('The drift job service rejected this machine\'s STUDIO_SHARED_SECRET (401).', { status: 401, code: 'unauthorized' });
    if (!r.ok) throw new DriftServiceError(json?.error || `drift job service returned HTTP ${r.status}`, { status: r.status, code: r.status === 409 ? 'conflict' : 'http_error', body: json });
    return json ?? {};
  }
  return {
    baseUrl,
    /** → {created, job} */
    create: (job) => call('POST', { body: { video_name: job.video_name, video_title: job.video_title, kind: job.kind, fingerprint: job.fingerprint, details: job.details, created_by: job.created_by } }),
    /** → {count, jobs} */
    list: ({ status, kind, limit } = {}) => call('GET', { query: { status: Array.isArray(status) ? status.join(',') : status, kind: Array.isArray(kind) ? kind.join(',') : kind, limit } }),
    get: (id) => call('GET', { query: { id } }),
    /** CAS decision. 409 → DriftServiceError{code:'conflict', body:{error, decided_by, status, job}} */
    decide: ({ id, decision, by, via, note = null, expectedVersion = null }) => call('POST', { query: { action: 'decide' }, body: { id, decision, by, via, note, expectedVersion } }),
    progress: ({ id, status, note = null, links = null, by = null, expectedVersion = null }) => call('PATCH', { body: { id, status, note, links, by, expectedVersion } }),
    attachSlack: ({ id, channel, ts, blocks = null }) => call('POST', { query: { action: 'slack' }, body: { id, channel, ts, blocks } }),
    /** Thread reply on the job's Slack message (executor progress notes); no state change. */
    note: ({ id, note, by = null }) => call('POST', { query: { action: 'note' }, body: { id, note, by } }),
  };
}

// ---------------------------------------------------------------- job details from a weekly result
/** Plain-English reason for a classifier reason code (tools/drift/classify.mjs). */
export function plainReason(r) {
  const d = r?.detail ? String(r.detail) : '';
  switch (r?.code) {
    case 'screenshot_changed': return `The page looks different today (${d.replace(/^diff /, '').replace(/ non-dynamic/, ' of the screen changed')}).`;
    case 'persistent_chrome_changed': return 'The app\'s sidebar/header (seen on every slide) changed.';
    case 'target_moved': return `The element clicked in this step ${d.replace(/^target /, '')}, so the highlight box must move.`;
    case 'target_renamed': return `The clicked element was renamed (${d}).`;
    case 'narration_inaccurate': return `The narration may no longer match the screen: ${d}`;
    case 'narration_unchecked': return `The screen changed and the narration wasn't checked automatically (${d}).`;
    case 'narration_contradicted': return `The narration describes something the page no longer has: ${d}`;
    case 'target_missing': case 'target_ambiguous': case 'target_not_navigation': return `The element this step clicks can't be found reliably today (${d}).`;
    case 'route_changed': return `The page moved to a different address (${d}).`;
    case 'flow_changed': return `Clicking the recorded element no longer leads to the next recorded page (${d}).`;
    case 'page_redesigned': return `The page was substantially redesigned (${d}).`;
    case 'viewport_changed': return 'The screenshot size no longer matches the recording.';
    case 'mixed_old_new_ui': return `Updating only some slides would mix old and new UI (${d}).`;
    default: return d || String(r?.code || 'changed');
  }
}

const UPDATE_VERDICTS = new Set(['slide_update', 'moved_highlight', 'narration_review']);
const wordsOf = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const WORDS_PER_SEC = 2.4; // matches the renderer's narration pacing estimate

/**
 * Turn one weekly.mjs job.json (plus local context) into the service's job payload.
 * Pure: everything it needs is passed in. Fingerprint = video + kind + per-step change types/reason
 * codes + proposed narration text, NOT screenshot bytes or run paths, so the same drift found again
 * next week maps to the same open job.
 *
 * @param {object} p
 * @param {object} p.weeklyJob     tools/drift/weekly.mjs runVideo() result (job.json)
 * @param {object} [p.script]      the saved script ({title, module, steps:[{narration}], driveVideoId, pylonArticleId…})
 * @param {object} [p.links]       {drive, pylon, studio}
 * @param {Array}  [p.prs]         merged PRs that triggered the check: [{number, title, url}]
 * @param {object} [p.proposedNarration] {stepIndex: new narration text}
 * @param {Array}  [p.slideDurations]   seconds per step from assembly.json (sdur), for preservation estimates
 * @param {number} [p.oldDurationSec]   current video duration
 */
export function buildJobDetails({ weeklyJob, script = null, links = {}, prs = [], proposedNarration = {}, slideDurations = null, oldDurationSec = null, createdBy = 'weekly-drift' }) {
  const wj = weeklyJob || {};
  const name = String(wj.name || script?.name || '').trim();
  if (!name) throw new Error('weeklyJob.name required');
  const scriptSteps = Array.isArray(script?.steps) ? script.steps : [];
  const steps = Array.isArray(wj.steps) ? wj.steps : [];
  const narr = (i) => String(scriptSteps[i]?.narration ?? steps.find((s) => s.index === i)?.narration ?? '');
  const changes = [];
  for (const s of steps) {
    if (!UPDATE_VERDICTS.has(s.verdict) && s.verdict !== 'full_rerecord') continue;
    const codes = (s.reasons || []).map((r) => r.code);
    const types = [];
    if (codes.some((c) => c === 'screenshot_changed' || c === 'persistent_chrome_changed') || s.verdict === 'slide_update') types.push('screenshot');
    if (codes.includes('target_moved')) types.push('highlight');
    const newText = proposedNarration?.[s.index] ?? proposedNarration?.[String(s.index)];
    if (newText != null && String(newText).trim() !== narr(s.index).trim()) types.push('narration');
    changes.push({
      step: s.index + 1, index: s.index, verdict: s.verdict, action: s.action || null, changeTypes: types.length ? types : ['screenshot'], reasonCodes: codes,
      why: (s.reasons || []).map(plainReason),
      narrationFlagged: s.verdict === 'narration_review',
      oldNarration: narr(s.index) || null,
      newNarration: types.includes('narration') ? String(newText) : null,
      metrics: s.metrics ? { diff: s.metrics.diff ?? null, ssim: s.metrics.ssimMasked ?? null } : null,
      before: s.evidence?.recorded ? { path: s.evidence.recorded } : null,
      after: s.evidence?.today ? { path: s.evidence.today } : null,
      diff: s.evidence?.diff ? { path: s.evidence.diff } : null,
    });
  }
  const changedIdx = new Set(changes.map((c) => c.index));
  const allIdx = (scriptSteps.length ? scriptSteps.map((_, i) => i) : steps.map((s) => s.index));
  const unchanged = allIdx.filter((i) => !changedIdx.has(i));
  const unverified = steps.filter((s) => s.verdict === 'unverified').map((s) => ({ step: s.index + 1, why: (s.reasons || []).map(plainReason) }));
  const narrationChanged = changes.filter((c) => c.changeTypes.includes('narration'));

  // Kind: anything needing a re-record, or a narration flag without replacement text, can't be auto-updated.
  const rerecordReasons = [];
  if (wj.verdict === 'full_rerecord') rerecordReasons.push(...(steps.flatMap((s) => (s.reasons || []).filter((r) => r.verdict === 'full_rerecord').map((r) => `Step ${s.index + 1}: ${plainReason(r)}`))));
  for (const r of (wj.reasons || [])) if (r.step == null && r.verdict === 'full_rerecord') rerecordReasons.push(plainReason(r));
  const flaggedNoText = changes.filter((c) => c.narrationFlagged && !c.changeTypes.includes('narration'));
  if (flaggedNoText.length) rerecordReasons.push(`Narration on step(s) ${flaggedNoText.map((c) => c.step).join(', ')} may be wrong and no replacement text was proposed — a person needs to rewrite it.`);
  if (wj.candidateError) rerecordReasons.push(`The automatic candidate could not be built (${wj.candidateError}).`);
  const kind = wj.verdict === 'full_rerecord' || rerecordReasons.length ? 'manual_rerecord' : 'auto_update';

  // What stays untouched.
  let framesPreservedPct = null, newDurationSec = oldDurationSec;
  if (Array.isArray(slideDurations) && slideDurations.length === allIdx.length) {
    const total = slideDurations.reduce((a, b) => a + (Number(b) || 0), 0);
    const kept = unchanged.reduce((a, i) => a + (Number(slideDurations[i]) || 0), 0);
    framesPreservedPct = total > 0 ? Math.round((kept / total) * 1000) / 10 : null;
  } else if (allIdx.length) framesPreservedPct = Math.round((unchanged.length / allIdx.length) * 1000) / 10;
  if (oldDurationSec != null) {
    const delta = narrationChanged.reduce((a, c) => a + (wordsOf(c.newNarration) - wordsOf(c.oldNarration)) / WORDS_PER_SEC, 0);
    newDurationSec = Math.round((oldDurationSec + delta) * 10) / 10;
  }

  const details = {
    schema: 1,
    video: { name, title: script?.title || wj.title || name, module: script?.module || null, stepCount: allIdx.length },
    links: { drive: links.drive || null, pylon: links.pylon || null, studio: links.studio || null },
    detection: {
      source: prs?.length ? 'merged_prs+recapture' : 'weekly_recapture',
      prs: (prs || []).map((p) => ({ number: p.number ?? null, title: p.title ?? null, url: p.url ?? null })),
      runAt: wj.finishedAt || wj.startedAt || null, verdict: wj.verdict || null, complete: wj.complete ?? null, summary: wj.summary || null,
      contactSheet: wj.evidence?.contactSheet || null,
    },
    reasons: [...new Set(changes.flatMap((c) => c.why))].slice(0, 20),
    changes,
    untouched: {
      steps: unchanged.map((i) => i + 1),
      narrationUnchangedSteps: allIdx.filter((i) => !narrationChanged.some((c) => c.index === i)).map((i) => i + 1),
      unverified,
      framesPreservedPct,
      oldDurationSec, newDurationSec,
    },
    elevenLabsChars: narrationChanged.reduce((a, c) => a + String(c.newNarration || '').length, 0),
    rerecordReason: kind === 'manual_rerecord' ? [...new Set(rerecordReasons)] : [],
  };
  const fingerprint = fingerprintOf({ name, kind, changes });
  return { video_name: name, video_title: details.video.title, kind, fingerprint, details, created_by: createdBy };
}

export function fingerprintOf({ name, kind, changes }) {
  const basis = { name, kind, changes: (changes || []).map((c) => ({ i: c.index, t: [...c.changeTypes].sort(), r: [...(c.reasonCodes || [])].sort(), n: c.newNarration || null })).sort((a, b) => a.i - b.i) };
  return 'fp1-' + createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 40);
}

