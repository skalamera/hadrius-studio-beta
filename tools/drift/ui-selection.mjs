// One selection policy for offline review, weekly render candidates and notification payloads.
// Pure: no filesystem, model, browser, or service calls. Raw classifier diagnostics stay untouched.
import { containsPhrase, normalizeText } from './ui-strings.mjs';
import { confirmsProductionUiCodeChange, describeRelease } from './release-evidence.mjs';
import { digest } from './contracts.mjs';
import { assessRepair, REPAIR_POLICY, BLOCKER_TEXT } from './repairability.mjs';

export const SELECTION_POLICY = 'misleading-interface-v1';
export const UI_CODES = new Set(['page_redesigned', 'persistent_chrome_changed', 'ui_changed']);
const CHANGE_VERDICTS = new Set(['slide_update', 'moved_highlight', 'narration_review', 'full_rerecord']);
export const codesOf = (s) => s?.reasons ? s.reasons.map(r => r.code) : (s?.codes || []).map(c => c.split(':').at(-1));
export const slideText = (s) => [s?.narration, s?.caption, s?.target?.name, s?.target?.text, s?.target?.label].filter(Boolean).join('\n');
const jsonHash = (value) => digest(JSON.parse(JSON.stringify(value)));
const inputHashOf = (job) => jsonHash({ name:job.name,status:job.status,verdict:job.verdict??null,complete:job.complete??null,
  reasons:job.reasons??[],steps:job.steps??[],scriptHash:job.scriptHash??null });
const scopeHashOf = (s) => jsonHash({policy:s.policy,name:s.name,status:s.status,sourceHash:s.sourceHash,slides:s.slides,repair:s.repair??null});
export const selectionMarker = (selection) => ({policy:selection.policy,status:'finalized',inputHash:selection.inputHash,names:selection.names});

/** Numeric record IDs and query/data/tenant parameters do not make separate page routes. */
export function normalizedRoute(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const path = new URL(url, 'https://app.hadrius.com').pathname;
    return path.replace(/\/\d+(?=\/|$)/g, '/:id');
  } catch { return null; }
}

const verifiedChanges = (s) => {
  const bySha = new Map((s.commits || []).map(c => [c.sha, c]));
  return (s.redesign?.changes || []).filter(c => c.verified).map(c => ({ element: c.element, kind: c.kind, before: c.before, after: c.after,
    pr: bySha.get(c.commit)?.pr ?? null, sha: c.commit, subject: bySha.get(c.commit)?.subject ?? null }));
};
const labelOf = (c) => normalizeText(String((c.kind === 'removed' ? c.before : c.after ?? c.before) ?? '').replace(/\([^)]*\)/g, ' '));
const signatureOf = (c) => `${c.kind}|${labelOf(c)}`;

/** Cross-page repetition is an app-frame heuristic, not a code-proven location. Unknown routes do not vote. */
export function appFrameSignatures(merged, routeOf, minPages = 3) {
  const pages = new Map();
  for (const v of merged.values()) for (const s of v.steps || []) {
    if (!s.redesignConfirmed) continue;
    const route = routeOf(v, s.index);
    if (!route) continue;
    for (const c of verifiedChanges(s)) {
      const k = signatureOf(c);
      if (!pages.has(k)) pages.set(k, new Set());
      pages.get(k).add(route);
    }
  }
  return new Set([...pages].filter(([, set]) => set.size >= minPages).map(([k]) => k));
}

/** A video appears in the first group that applies. Only flagged.slides are update scope, never the other groups. */
export function sortVideos(merged, { routeOf = () => null, slideTextOf = () => '', minPages = 3 } = {}) {
  const frame = appFrameSignatures(merged, routeOf, minPages);
  const out = { flagged: [], newControlsOnly: [], frameOnly: [], frameChanges: [...frame] };
  for (const v of merged.values()) {
    const groups = { mislead: [], added: [], frame: [] };
    for (const s of v.steps || []) {
      if (!s.redesignConfirmed) continue;
      const text = slideTextOf(v, s.index), all = verifiedChanges(s);
      const page = all.filter(c => !frame.has(signatureOf(c)) || containsPhrase(text, c.after) || containsPhrase(text, c.before));
      const entry = (changes) => ({ index: s.index, verdict: s.verdict, codes: s.codes, reason: s.redesign?.reason ?? null, changes });
      const mislead = page.filter(c => c.kind !== 'added');
      if (mislead.length) groups.mislead.push(entry(mislead));
      else if (page.length) groups.added.push(entry(page));
      else if (all.length) groups.frame.push(entry(all));
    }
    const entry = (slides) => ({ name: v.name, runDir: v.runDir, before: v.before, after: v.after, stepCount: (v.steps || []).length, slides });
    if (groups.mislead.length) out.flagged.push(entry(groups.mislead));
    else if (groups.added.length) out.newControlsOnly.push(entry(groups.added));
    else if (groups.frame.length) out.frameOnly.push(entry(groups.frame));
  }
  return out;
}

/** Validate live job evidence, then adapt to the same view the saved offline reports use. */
export function selectWeeklyJobs(jobs, { readScript = () => null } = {}) {
  const views = new Map(), byName = new Map(), sources = new Map(), inputs = new Map();
  for (const job of jobs) {
    if (!job?.name) continue;
    const script = readScript(job.name);
    inputs.set(job.name, { job, script });
    sources.set(job.name,{sourceHash:inputHashOf(job),scriptHash:jsonHash(script??null)});
    let missingContext = false;
    const steps = (job.status === 'ok' ? job.steps || [] : []).map(s => {
      const ev = s.uiReleaseEvidence, codes = codesOf(s);
      const qualifies = CHANGE_VERDICTS.has(s.verdict) && codes.some(c => UI_CODES.has(c))
        && confirmsProductionUiCodeChange(ev, { chrome: !codes.some(c => c === 'page_redesigned' || c === 'ui_changed') });
      const scriptStep = script?.steps?.find((st, i) => (st.index ?? i) === s.index);
      const context = s.uiContext ?? (scriptStep ? { route: ev?.routePath ?? s.todayUrl ?? scriptStep.url ?? scriptStep.route, slideText: slideText(scriptStep) } : null);
      if (qualifies && !context) missingContext = true;
      // Validate every selected claim, not just the existence of one valid claim somewhere in the review.
      const changes = qualifies ? ev.redesign.changes.filter(ch => confirmsProductionUiCodeChange({ ...ev, redesign: { ...ev.redesign, changes: [ch] } })) : [];
      return { index: s.index, verdict: s.verdict, codes: (s.reasons || []).map(r => `${r.verdict}:${r.code}`),
        redesignConfirmed: qualifies && !!context, commits: ev?.commits ?? [], redesign: ev?.redesign ? { ...ev.redesign, changes } : null,
        route: normalizedRoute(context?.route), slideText: context?.slideText ?? '' };
    });
    views.set(job.name, { name: job.name, before: job.verdict, after: job.verdict, steps });
    byName.set(job.name, { policy: SELECTION_POLICY, name: job.name, status: 'skip',
      reason: missingContext ? 'selection_context_missing' : 'no_release_confirmed_ui_redesign', slides: [] });
  }
  const review = sortVideos(views, { routeOf: (v, index) => v.steps.find(s => s.index === index)?.route,
    slideTextOf: (v, index) => v.steps.find(s => s.index === index)?.slideText ?? '' });
  const frame = new Set(review.frameChanges);
  for (const [group, reason] of [['newControlsOnly', 'ui_additions_only'], ['frameOnly', 'unused_app_frame_changes'], ['flagged', 'ui_change']]) {
    for (const v of review[group]) {
      const entry = { policy: SELECTION_POLICY, ...v, status: group === 'flagged' ? 'selected' : 'skip', reason, slides: group === 'flagged' ? v.slides : [] };
      // Whether replacing only these slides leaves the video accurate, decided from the same raw inputs.
      if (group === 'flagged') { const { job, script } = inputs.get(v.name);
        entry.repair = assessRepair({ name: job.name, steps: job.steps || [], scriptSteps: script?.steps || [], slides: v.slides, isFrame: (c) => frame.has(signatureOf(c)) }); }
      byName.set(v.name, entry);
    }
  }
  const names=[...byName.keys()].sort();
  const inputHash=jsonHash({policy:SELECTION_POLICY,repairPolicy:REPAIR_POLICY,sources:names.map(name=>({name,...sources.get(name)}))});
  for(const [name,entry] of byName){entry.sourceHash=sources.get(name).sourceHash;entry.scopeHash=scopeHashOf(entry);}
  return { policy: SELECTION_POLICY, review, byName, names, inputHash };
}

const sameChange = (a, b) => a.kind === b.kind && a.before === b.before && a.after === b.after && a.commit === b.sha;

/** Scope a job to the selected changes only. This is a projection, never a rewrite of the raw job/classify evidence. */
export function selectedJob(job, selection) {
  if (selection?.policy !== SELECTION_POLICY || selection.status !== 'selected' || selection.name !== job?.name) return null;
  if(selection.sourceHash!==inputHashOf(job)||selection.scopeHash!==scopeHashOf(selection))return null;
  const repair = selection.repair;
  if (repair?.policy !== REPAIR_POLICY) return null;
  const actionOf = new Map(repair.actions.map(a => [a.index, a.action]));
  const steps = [], evidenceOf = new Map();
  for (const chosen of selection.slides) {
    const original = job.steps.find(s => s.index === chosen.index), ev = original?.uiReleaseEvidence;
    if (!original || !CHANGE_VERDICTS.has(original.verdict) || !confirmsProductionUiCodeChange(ev)) continue;
    const changes = ev.redesign.changes.filter(ch => ch.kind !== 'added' && chosen.changes.some(c => sameChange(ch, c))
      && confirmsProductionUiCodeChange({ ...ev, redesign: { ...ev.redesign, changes: [ch] } }));
    if (!changes.length) continue;
    const commits = ev.commits.filter(c => changes.some(ch => ch.commit === c.sha));
    const evidence = { ...ev, commits, redesign: { confirmed: true, changes, rejected: [], reason: 'Selected misleading interface changes only' } };
    evidenceOf.set(original.index, evidence);
    const reasons = (original.reasons || []).filter(r => UI_CODES.has(r.code)).map(r => ({ ...r, detail: describeRelease(evidence) }));
    if (repair.decision === 'auto') {
      const move = actionOf.get(original.index) === 'replace_screenshot_and_move_highlight';
      if (move) reasons.push(...(original.reasons || []).filter(r => r.code === 'target_moved'));
      steps.push({ ...original, verdict: move ? 'moved_highlight' : 'slide_update', uiReleaseEvidence: evidence, reasons });
    } else steps.push({ ...original, uiReleaseEvidence: evidence, reasons });
  }
  // Kept slides that show the same verified change are replaced with it (repairability v2), carrying that change.
  // Only an automatic repair replaces them; a manual re-record redoes the whole video (the notes list them).
  for (const a of repair.decision === 'auto' ? repair.actions.filter(x => x.extendedFrom != null) : []) {
    const original = job.steps.find(s => s.index === a.index), src = evidenceOf.get(a.extendedFrom);
    if (!original || !src) continue;
    const changes = src.redesign.changes.filter(ch => ch.kind === a.change?.kind && ch.before === a.change?.before && ch.after === a.change?.after);
    if (!changes.length) continue;
    const evidence = { ...src, commits: src.commits.filter(c => changes.some(ch => ch.commit === c.sha)), redesign: { ...src.redesign, changes } };
    const reasons = [{ step: a.index, verdict: 'slide_update', code: 'kept_slide_shows_verified_change',
      detail: `Shows the same verified change as step ${a.extendedFrom + 1}: “${a.change.before}” is now “${a.change.after}”. ${describeRelease(evidence)}` }];
    steps.push({ ...original, verdict: 'slide_update', uiReleaseEvidence: evidence, reasons });
  }
  steps.sort((x, y) => x.index - y.index);
  if (!steps.length) return null;
  const rank = ['unchanged', 'unchanged_with_data_drift', 'slide_update', 'moved_highlight', 'narration_review', 'full_rerecord'];
  // The raw run's whole-video verdict (and its mixed_old_new_ui rule) is superseded by the repairability decision.
  const reasons = repair.blockers.map(b => ({ step: null, verdict: 'full_rerecord', code: `repair_${b.code}`,
    detail: `${BLOCKER_TEXT[b.code] ?? b.code} ${b.items.map(x => `Slide ${x.index + 1}: ${x.detail}.`).join(' ')}` }));
  const verdict = repair.decision === 'auto' ? steps.reduce((v, s) => rank.indexOf(s.verdict) > rank.indexOf(v) ? s.verdict : v, 'unchanged') : 'full_rerecord';
  return { ...job, steps, verdict, reasons,
    summary: `Release-confirmed misleading interface change on step(s) ${steps.map(s => s.index + 1).join(', ')}; ${repair.decision === 'auto' ? 'selective repair verified safe' : 'automatic repair blocked pending the listed evidence or supported changes'}.` };
}
