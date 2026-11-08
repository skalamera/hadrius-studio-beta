// Grounded redesign review for one slide. Claude compares the RECORDED and TODAY screenshots with the production
// release commits that changed this screen's source and lists concrete UI changes. verifyRedesign keeps a change
// only when deterministic checks back it: its commit is one of the release commits; a new label is on today's screen
// AND is a label string in today's source; a removed/renamed label is gone from today's screen AND was a label string
// in the code before. Data (names, counts), empty tables, styling-only edits and swapped images fail these checks.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { containsPhrase, normalizeText, labelsInDiffLine } from './ui-strings.mjs';
import { digest } from './contracts.mjs';
import { fileDigest } from './review-cache.mjs';
import { decodePng, compareImages } from './compare.mjs';

export { labelsInDiffLine };

export const SUBSTANTIVE_KINDS = Object.freeze(['added', 'removed', 'renamed', 'moved']);
const KINDS = new Set([...SUBSTANTIVE_KINDS, 'restyled']);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, max) : null);

/** A +/- diff line that adds or removes text reading like a UI label (quoted literal or JSX text). */
export const isLabelLine = (line) => labelsInDiffLine(line).length > 0;

/** Busy screens collect dozens of release commits (refactors, API hooks, design-system batches). Show the judge the
 *  ones most likely to explain a visible change first: commits whose diff adds/removes label text, newest first within
 *  equal scores. Excerpts lead with label lines. */
export function rankCommits(commits, excerptOf, { max = 12, labelLinesMax = 20, otherLinesMax = 8 } = {}) {
  return commits.map((c, order) => {
    const lines = String(excerptOf(c.sha, c.files) || '').split('\n').filter(Boolean);
    const labels = lines.filter(isLabelLine), other = lines.filter((l) => !isLabelLine(l));
    return { ...c, excerpt: [...labels.slice(0, labelLinesMax), ...other.slice(0, otherLinesMax)].join('\n'), score: labels.length, order };
  }).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, max).map(({ score, order, ...c }) => c);
}

export function buildRedesignPrompt({ title, stepNumber, stepCount, recordedPath, todayPath, todayText, commits }) {
  const releases = commits.map((c) => [
    `- commit ${c.sha.slice(0, 12)}${c.pr ? ` (PR #${c.pr})` : ''}${c.date ? ` ${c.date.slice(0, 10)}` : ''}: ${c.subject}`,
    `  files: ${c.files.join(', ')}`,
    c.excerpt ? `  diff excerpt:\n${c.excerpt.split('\n').map((l) => `    ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  return [
    'You are deciding whether ONE screen of the Hadrius web app was REDESIGNED between the moment a walkthrough video recorded it and today.',
    `Use the Read tool to open both screenshots. RECORDED (old, from the video): ${recordedPath}`,
    `TODAY (live product now): ${todayPath}`,
    'Never mix them up: "before" always describes RECORDED and "after" always describes TODAY.',
    `Video: "${title}", slide ${stepNumber} of ${stepCount}.`,
    todayText ? `Visible text on TODAY's page (DOM innerText, truncated):\n"""\n${String(todayText).slice(0, 3000)}\n"""` : '',
    'Production frontend releases that changed the source files rendering this screen since the recording:',
    releases || '(none)',
    'The only question: would the RECORDED slide now mislead a viewer about the INTERFACE, not about the data? Set "redesigned" to true only then: a control, tab, column header, section, field label or navigation item was added, removed, renamed, or moved to a different place.',
    'It does NOT mislead about the interface when only the data differs (records, rows, counts, names, dates or statuses), a table or list is empty, the page is loading or shows an error, or only styling changed (fonts, colours, spacing, icons, badge or button styling) with the same controls in the same places.',
    'For each UI change, quote the exact visible label text: "before" as shown in RECORDED (null if the element is new) and "after" as shown in TODAY (null if it was removed). Name the commit (first 12 characters) from the list whose change explains it, or null if none does.',
    'kind is one of: added, removed, renamed, moved, restyled.',
    'Reply with ONLY this JSON, no prose: {"redesigned": boolean, "changes": [{"element": "short description", "kind": "added|removed|renamed|moved|restyled", "before": "text or null", "after": "text or null", "commit": "12-char sha or null"}], "data_differences": ["short description"], "reason": "one sentence"}',
  ].filter(Boolean).join('\n');
}

export function parseRedesignJudge(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('redesign_judge_not_object');
  if (typeof obj.redesigned !== 'boolean') throw new Error('redesign_judge_missing_redesigned');
  if (!Array.isArray(obj.changes)) throw new Error('redesign_judge_missing_changes');
  const reason = text(obj.reason, 500);
  if (!reason) throw new Error('redesign_judge_missing_reason');
  const changes = obj.changes.slice(0, 12).map((c) => ({ element: text(c?.element, 160) ?? '', kind: KINDS.has(c?.kind) ? c.kind : 'restyled',
    before: text(c?.before, 160), after: text(c?.after, 160), commit: text(c?.commit, 40) }));
  const data = Array.isArray(obj.data_differences) ? obj.data_differences.map((d) => text(d, 200)).filter(Boolean).slice(0, 8) : [];
  return { redesigned: obj.redesigned, changes, data_differences: data, reason };
}

/** Deterministic check of every claimed change (see header). confirmed = judge said redesigned AND >= 1 verified change. */
// A change is tied to its release only when the cited commit's own diff adds (+) the new label or removes (-) the old
// one. An "added" label that was already a label in the old code of the screen's files was hidden from the recording
// (account, permission or data), not added by a release, so it can't make the old video misleading.
// The sidebar, nav bars and account menu are on every screen: a change that lives only there makes the old video
// misleading only when the slide uses that element (its narration, caption or click target names the label).
export function verifyRedesign({ judge, commits, todayText, currentStrings, baselineStrings, baselineScreenStrings = baselineStrings, diffLabelsOf = null, slideText = '', isShellChange = () => false }) {
  const find = (id) => { const p = String(id || '').toLowerCase(); return p.length >= 7 ? commits.find((c) => c.sha.startsWith(p)) ?? null : null; };
  const isLabel = (t, set) => { const n = normalizeText(t); return set.has(n) || set.has(n.replace(/\s*\(?\d+\)?$/, '').trim()); };
  const has = (lists, phrase, side) => !!phrase && !!lists && (lists[side] || []).some((l) => containsPhrase(l, phrase));
  const tiedIn = (lists, ch) => {
    const adds = has(lists, ch.after, 'added'), drops = has(lists, ch.before, 'removed');
    if (ch.kind === 'added') return adds;
    if (ch.kind === 'removed') return drops;
    if (ch.kind === 'renamed') return adds || drops;
    return adds || drops || has(lists, ch.after, 'removed') || has(lists, ch.before, 'added');
  };
  const changes = [], rejected = [];
  for (const ch of judge.changes) {
    const commit = find(ch.commit);
    const why = [];
    if (!SUBSTANTIVE_KINDS.includes(ch.kind)) why.push('styling_only');
    if (!commit) why.push('no_matching_release_commit');
    if (ch.kind !== 'removed') {
      if (!ch.after) why.push('after_missing');
      else {
        if (!containsPhrase(todayText, ch.after)) why.push('after_not_on_screen_today');
        if (!isLabel(ch.after, currentStrings)) why.push('after_not_a_label_in_code');
      }
    }
    if (ch.kind === 'removed' || ch.kind === 'renamed') {
      if (!ch.before) why.push('before_missing');
      else {
        if (containsPhrase(todayText, ch.before)) why.push('before_still_on_screen_today');
        if (!isLabel(ch.before, baselineStrings)) why.push('before_not_a_label_in_code');
      }
    }
    if (commit && SUBSTANTIVE_KINDS.includes(ch.kind)) {
      const d = diffLabelsOf ? diffLabelsOf(commit.sha) : null;
      if (!tiedIn(d, ch)) why.push('not_in_commit_diff');
    }
    if (ch.kind === 'added' && ch.after && isLabel(ch.after, baselineScreenStrings)) why.push('after_already_in_old_code');
    // Last, and only for otherwise-verified changes (it walks the import graph at both commits).
    if (!why.length && !containsPhrase(slideText, ch.after) && !containsPhrase(slideText, ch.before) && isShellChange(ch)) why.push('shell_change_not_used_on_slide');
    const out = { ...ch, commit: commit?.sha ?? null, verified: why.length === 0 };
    if (why.length) rejected.push({ ...out, why }); else changes.push(out);
  }
  return { confirmed: judge.redesigned === true && changes.length > 0, changes, rejected, reason: judge.reason, dataDifferences: judge.data_differences, raw: judge };
}

/** Claude judge via the claude CLI (same path as the narration judge). `cs` injects coverage-scan helpers in tests. */
export function makeRedesignJudge({ runModel = null, timeoutMs = 300_000, cs = null } = {}) {
  return async (input) => {
    const lib = cs ?? await import('../coverage-scan.mjs');
    const run = runModel ?? lib.runClaude;
    const meta = {};
    const addDirs = [input?.recordedPath && dirname(resolve(input.recordedPath)), input?.todayPath && dirname(resolve(input.todayPath))].filter(Boolean);
    const raw = await run(buildRedesignPrompt(input), { allowedTools: 'Read', addDirs, maxTurns: 8, timeout: timeoutMs, model: lib.decisionModel(), onMeta: (m) => Object.assign(meta, m) });
    return { ...parseRedesignJudge(lib.extractJson(raw)), model: meta.model ?? null, costUsd: meta.costUsd ?? null };
  };
}

/**
 * Reuse data for one slide's review. A review compares the RECORDED slide with TODAY's screen, so a prior answer
 * stays valid while both look the same: the slot is the recorded slide (video, step, its content and image bytes);
 * reuse also requires today's screen to match the screen the answer was given for (redesignReusable). Keying on
 * release commits instead was measured on the 10/30 sweep: shared files (sidebar, design system) change every week,
 * so a commit-keyed answer was never reusable a week later. Deterministic verification always reruns on fresh evidence.
 */
export function redesignCacheInputs({ evidence, releaseEvidence, script, step, paths, todayText = '', todayRects = null }) {
  const codeLabels = releaseEvidence?.uiStringsAt ? releaseEvidence.uiStringsAt(evidence.currentSha, evidence.screenFiles || []) : null;
  // Today's interface text in screen order (labels in today's code only; record names and counts are data).
  const labelSequence = [], seen = new Set();
  for (const raw of String(todayText ?? '').split('\n')) {
    const l = normalizeText(raw), bare = l.replace(/\s*\(?\d+\)?$/, '').trim();
    const label = !codeLabels ? l : codeLabels.has(l) ? l : codeLabels.has(bare) ? bare : null;
    if (label && !seen.has(label)) { seen.add(label); labelSequence.push(label); }
  }
  const slotInputs = { video: script?.name ?? null, recordingId: script?.recording?.id ?? null, step: step.index,
    stepDigest: digest({ action: step.action ?? null, narration: step.narration ?? null, caption: step.caption ?? null,
      target: step.target ? { name: step.target.name ?? null, text: step.target.text ?? null, label: step.target.label ?? null } : null, media: step.media ?? null }),
    recordedImage: fileDigest(paths?.recorded), routeEntryFile: evidence.routeEntryFile ?? null };
  return { slot: slotInputs.recordedImage && paths?.today ? digest(slotInputs) : null, slotInputs, labelSequence,
    citable: (evidence.commits || []).map((c) => c.sha), todayPath: paths?.today ?? null,
    rects: { dynamicRects: todayRects?.dynamicRects ?? [], dataRects: todayRects?.dataRects ?? [] } };
}

/** A stored review is reusable when today's screen looks like the screen it was given for: same interface text in the
 *  same order, no change outside data/dynamic areas, and the release commits it was given still in this slide's list. */
export function redesignReusable(record, cache, { readPng = (p) => decodePng(readFileSync(p)) } = {}) {
  if (!cache?.todayPath || !record?.todayImage) return false;
  if (JSON.stringify(record.labelSequence ?? null) !== JSON.stringify(cache.labelSequence)) return false;
  // The release commits the answer could cite must all still be release commits for this slide. (Model citations that
  // were never release commits are rejected by verification on every run, so they do not block reuse.)
  if (!Array.isArray(record.citable)) return false;
  const now = new Set(cache.citable || []);
  if (!record.citable.every((sha) => now.has(sha))) return false;
  const rects = (k) => [...(record.rects?.[k] || []), ...(cache.rects?.[k] || [])];
  let r;
  try { r = compareImages(readPng(record.todayImage), readPng(cache.todayPath), { dynamicRects: rects('dynamicRects'), dataRects: rects('dataRects') }); } catch { return false; }
  return r.dimensionsMatch === true && (r.classification === 'unchanged' || r.dataOnly === true);
}

/** What a stored review keeps besides the answer: the screen it was given for. */
export const redesignCacheExtra = (cache, key, store) => ({ labelSequence: cache.labelSequence, rects: cache.rects, citable: cache.citable,
  todayImage: store.putFile('redesign', key, cache.todayPath) });

/** Review one release-candidate slide and attach the verified result to its evidence. A judge returning null (not in
 *  the review sample, nothing cached) leaves the slide unreviewed. Any error fails closed (confirmed:false). */
export async function reviewRedesign({ redesignJudge, releaseEvidence, evidence, script, step, paths, todayText = '', todayRects = null, log = () => {} }) {
  try {
    const commits = rankCommits(evidence.commits, (sha, files) => (releaseEvidence?.excerpt ? releaseEvidence.excerpt(sha, files) : ''));
    log(`redesign review for slide ${step.index + 1}: ${commits.length} release commit(s)`);
    const cache = redesignCacheInputs({ evidence, releaseEvidence, script, step, paths, todayText, todayRects });
    const judge = await redesignJudge({ title: script.title ?? script.name, stepNumber: step.index + 1, stepCount: script.steps.length,
      recordedPath: paths.recorded, todayPath: paths.today, todayText, commits, cache });
    if (!judge) return evidence;
    // Per-run model budget reached: the slide stays pending (never unchanged); a later run reviews it.
    if (judge.pending) return { ...evidence, reviewPending: judge.pending };
    const touchedFiles = [...new Set(evidence.commits.flatMap((c) => releaseEvidence.filesTouched(c.sha)))];
    // A change is "shell" when each label it names is rendered only by the app shell at its own commit: the old label
    // at the recorded build, the new one at today's build.
    const shellAt = (sha, phrase) => !!releaseEvidence.shellOnlyLabel?.(sha, evidence.routeEntryFile, phrase);
    const isShellChange = (ch) => {
      const sides = [ch.after && shellAt(evidence.currentSha, ch.after), ch.before && shellAt(evidence.baselineSha, ch.before)].filter((x) => x !== null && x !== undefined && x !== '');
      return sides.length > 0 && sides.every(Boolean);
    };
    const redesign = verifyRedesign({ judge, commits: evidence.commits, todayText,
      currentStrings: releaseEvidence.uiStringsAt(evidence.currentSha, evidence.screenFiles),
      baselineStrings: releaseEvidence.uiStringsAt(evidence.baselineSha, touchedFiles),
      baselineScreenStrings: releaseEvidence.uiStringsAt(evidence.baselineSha, [...new Set([...(evidence.screenFiles || []), ...touchedFiles])]),
      diffLabelsOf: (sha) => (releaseEvidence.diffLabels ? releaseEvidence.diffLabels(sha) : null),
      slideText: [step.narration, step.caption, step.target?.name, step.target?.text, step.target?.label].filter(Boolean).join('\n'), isShellChange });
    return { ...evidence, redesign };
  } catch (e) {
    return { ...evidence, redesign: { confirmed: false, error: String(e?.message || e).slice(0, 200), changes: [], rejected: [] } };
  }
}
