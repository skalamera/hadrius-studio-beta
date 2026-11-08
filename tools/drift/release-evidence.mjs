// Evidence contract for "a production frontend release redesigned this screen". Screenshot metrics, empty states,
// data, narration and repo-wide diffs never establish it on their own. Evidence comes from release-provider.mjs
// (deploy bracket + screen-anchored source files + release commits) and is confirmed only by a redesign review whose
// counted changes were each verified against today's DOM and the code (redesign-judge.mjs). Pure; imported by the
// bridge through weekly-submit.mjs, so keep it dependency-free.
export const PRODUCTION_FRONTEND_ENVIRONMENT = 'Production – hadrius-frontend';
const SHA40 = /^[0-9a-f]{40}$/;
const SUBSTANTIVE = new Set(['added', 'removed', 'renamed', 'moved']);
const UI_SOURCE_PATH = /^(?:apps\/hadrius-app\/(?:pages|src|styles)|packages\/[a-z0-9_-]+\/src)\/.+\.(?:tsx?|jsx?|css|scss|sass)$/i;
const PAGE_FILE = /^apps\/hadrius-app\/pages\/.+\.(tsx|ts|jsx|js)$/;
const time = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
const short = (sha) => String(sha || '').slice(0, 12);

export function isUiSourcePath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..') || !UI_SOURCE_PATH.test(path)) return false;
  if (/(^|\/)(?:api|generated|__tests__|tests|mocks)(?:\/|$)/i.test(path)) return false;
  if (/(?:\.d\.ts|\.(?:test|spec|stories)\.[^.]+)$/i.test(path)) return false;
  return true;
}

/**
 * True only for status 'candidates' evidence with: production deploys bracketing recording and capture
 * (baseline live at recording < current live by capture), a page entry file, UI screen files, release commits limited
 * to those files, and a confirmed review with >= 1 verified substantive change tied to one of those commits.
 * chrome=true additionally needs that commit to touch an app-shell file (rendered by _app.tsx, not by the page).
 */
export function confirmsProductionUiCodeChange(ev, { chrome = false } = {}) {
  if (!ev || ev.status !== 'candidates' || ev.environment !== PRODUCTION_FRONTEND_ENVIRONMENT) return false;
  if (!SHA40.test(ev.baselineSha || '') || !SHA40.test(ev.currentSha || '') || ev.baselineSha === ev.currentSha) return false;
  const [rec, cap, bd, cd] = [time(ev.recordedAt), time(ev.capturedAt), time(ev.baselineDeployedAt), time(ev.currentDeployedAt)];
  if (![rec, cap, bd, cd].every(Number.isFinite) || !(bd <= rec && rec < cd && cd <= cap)) return false;
  if (!PAGE_FILE.test(ev.routeEntryFile || '') || !Array.isArray(ev.screenFiles) || !ev.screenFiles.length || !ev.screenFiles.every(isUiSourcePath)) return false;
  const screen = new Set(ev.screenFiles);
  const commits = new Map();
  for (const c of ev.commits || []) {
    if (!SHA40.test(c?.sha || '') || !Array.isArray(c.files) || !c.files.length || !c.files.every((f) => screen.has(f))) return false;
    commits.set(c.sha, c);
  }
  if (!commits.size || ev.redesign?.confirmed !== true) return false;
  const verified = (ev.redesign.changes || []).filter((ch) => ch?.verified === true && SUBSTANTIVE.has(ch.kind) && commits.has(ch.commit));
  if (!verified.length) return false;
  if (!chrome) return true;
  const shell = new Set(ev.shellFiles || []);
  return verified.some((ch) => commits.get(ch.commit).files.some((f) => shell.has(f)));
}

/** One line for classifier reasons and logs. */
export function describeRelease(ev) {
  const prs = new Map((ev.commits || []).map((c) => [c.sha, c.pr ? `#${c.pr}` : short(c.sha)]));
  const parts = (ev.redesign?.changes || []).filter((c) => c.verified).slice(0, 4).map((c) => `${c.kind} ${JSON.stringify(c.after ?? c.before)} (${prs.get(c.commit)})`);
  return `production ${short(ev.baselineSha)} -> ${short(ev.currentSha)}: ${parts.join('; ')}`;
}

/** Classifier gate for a slide whose pixels crossed the redesign (or chrome) threshold. */
export function releaseGate(ev, { chrome = false } = {}) {
  const unconfirmed = chrome ? 'chrome_release_unconfirmed' : 'redesign_release_unconfirmed';
  if (!ev) return { ok: false, code: unconfirmed, detail: 'no production release evidence for this slide' };
  if (ev.status === 'no_release') return { ok: false, code: 'no_frontend_release', detail: `no production frontend release between the recording and today (build ${short(ev.baselineSha)} live both times)` };
  if (ev.status === 'no_release_touched_screen') return { ok: false, code: 'no_release_touched_screen', detail: `no production release since the recording changed the ${ev.screenFiles?.length ?? 0} source file(s) that render this screen's text` };
  if (ev.status !== 'candidates') return { ok: false, code: unconfirmed, detail: `production release check: ${ev.status ?? 'unknown'}` };
  if (!ev.redesign && ev.reviewPending) return { ok: false, code: 'review_pending', detail: `${ev.commits?.length ?? 0} release commit(s) changed this screen's source; review deferred (${ev.reviewPending}), not unchanged` };
  if (!ev.redesign) return { ok: false, code: 'redesign_unreviewed', needsRedesignJudge: true, detail: `${ev.commits?.length ?? 0} release commit(s) changed this screen's source; redesign review pending` };
  if (!confirmsProductionUiCodeChange(ev, { chrome })) {
    return { ok: false, code: 'redesign_not_confirmed', detail: ev.redesign.error ? `redesign review failed: ${ev.redesign.error}` : `no verified UI change${ev.redesign.reason ? ` (${ev.redesign.reason})` : ''}` };
  }
  return { ok: true, detail: describeRelease(ev) };
}
