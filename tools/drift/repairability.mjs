// Can a flagged video be repaired by replacing only its selected slides, without leaving it misleading?
// Auto repair needs positive evidence on every check; failed or unprovable checks hold the repair
// with exact slides and evidence. A hold is not proof of necessary human re-recording. Pure: no I/O.
import { containsPhrase, normalizeText, visibleLines } from './ui-strings.mjs';
import { normalizedRoute } from './ui-selection.mjs'; // function declaration: safe across the import cycle
import { semanticRepairCheck } from './semantic-repair-proof.mjs';
import { digest } from './contracts.mjs';
import { FLOW_EQUIVALENCE_SOURCE as FLOW_SOURCE } from './flow-equivalence.mjs';

// Exclude ONLY additional reviews: every raw finding, target, guard and release field stays bound.
export function flowStepDigest(step) {
  const { semanticRepair: _semantic, flowEquivalence: _flow, ...original } = step ?? {};
  return digest(JSON.parse(JSON.stringify(original)));
}

// Pure half of the gate. The filesystem half MUST reload/revalidate the proof before candidate use.
// This is not a general alias map, model opinion, or semantic-review flow_changed exemption.
export function flowEquivalenceCheck(step, scriptStep, name) {
  try {
    const proof = step?.flowEquivalence, b = proof?.binding;
    const current=step?.uiReleaseEvidence?.currentSha;
    const legacy=b?.source&&!Object.hasOwn(b.source,'reviewedAtCommit')&&!Object.hasOwn(b.source,'captureCommit');
    if (proof?.schema !== 'saved-flow-equivalence-v1' || proof.verified !== true
      || proof.scope !== 'single_mode_switch_route_alias_only' || !b
      || proof.bindingDigest !== digest(b) || b.schema !== proof.schema
      || !name || b.videoName !== name || b.stepIndex !== step.index || b.nextStepIndex !== step.index + 1
      || b.jobStepDigest !== flowStepDigest(step) || b.scriptStepDigest !== digest(scriptStep)
      || !/^[a-f0-9]{40}$/.test(current??'') || b.source?.verified !== true || b.source.commit !== current
      || (legacy?current!==FLOW_SOURCE.commit:b.source.reviewedAtCommit!==FLOW_SOURCE.commit||b.source.captureCommit!==current)
      || b.source.repository !== FLOW_SOURCE.repository
      || b.routeAlias?.sourceCommit !== FLOW_SOURCE.commit || b.routeAlias.from !== `https://app.hadrius.com${FLOW_SOURCE.from}`
      || b.routeAlias.to !== `https://app.hadrius.com${FLOW_SOURCE.to}` || b.routeAlias.sourceFile !== FLOW_SOURCE.files[0].path
      || b.target?.label !== FLOW_SOURCE.action || b.execution?.clicked !== true || b.execution.performed !== 'click'
      || b.execution.afterClickUrl !== b.routeAlias.to || b.postcondition?.resultingMode !== FLOW_SOURCE.resultingMode
      || b.postcondition.visibleOppositeControl !== FLOW_SOURCE.postcondition
      || b.postcondition.evidence !== 'next_saved_capture_visible_text'
      || digest(b.postcondition.screenshot) !== digest(b.files.postScreenshot)
      || b.files?.preScreenshot?.path !== step.evidence?.today
      || b.files?.preScreenshot?.sha256 === b.files?.postScreenshot?.sha256
      || scriptStep?.index !== step.index || scriptStep.action !== 'click' || scriptStep.target?.name !== FLOW_SOURCE.action
      || scriptStep.target?.role !== 'button' || scriptStep.url !== b.routeAlias.from
      || step.action !== 'click' || step.target?.status !== 'resolved' || step.target.recordedName !== FLOW_SOURCE.action
      || step.target.todayName !== FLOW_SOURCE.action || step.target.method !== b.target.method
      || !['role_name', 'name_any_role'].includes(b.target.method)
      || (step.reasons || []).filter(r => r.code === 'flow_changed').length !== 1) return null;
    if (!Array.isArray(b.source.files) || b.source.files.length !== FLOW_SOURCE.files.length
      || FLOW_SOURCE.files.some(pin => {
        const found = b.source.files.filter(file => file.path === pin.path);
        return found.length !== 1 || found[0].sha256 !== pin.sha256 || found[0].blobSha !== pin.blobSha
          || found[0].gitObject !== `${current}:${pin.path}`;
      })) return null;
    return proof;
  } catch { return null; }
}

// v4 retains conservative defaults, allowing only exact-input-bound, independently verified
// same-intent narration repair. Unknown evidence never waives a workflow, target or fixture check.
export const REPAIR_POLICY = 'repairability-v4';
const PROVEN_KEPT = new Set(['unchanged', 'unchanged_with_data_drift']);
const TARGET_CODES = new Set(['target_missing', 'target_ambiguous', 'target_renamed', 'flow_changed']);
const NARRATION_CODES = new Set(['narration_contradicted', 'narration_inaccurate']);
const WHY_UNVERIFIED = {
  needs_fixture: 'replay stopped before a data-changing step, so there is no current screenshot',
  not_captured: 'no current screenshot', empty_state: 'current page showed an empty list',
  page_not_loaded: 'current page did not finish loading', page_error: 'current page showed an error',
  record_not_visible: 'the automation account cannot see the recorded record', data_missing: 'recorded data is missing today',
  target_unverified: 'the recorded click target could not be confirmed', redesign_not_confirmed: 'screenshot changed but no release-verified change',
  redesign_unreviewed: 'screenshot changed but was not reviewed', no_release_touched_screen: 'screenshot changed with no release touching this screen',
};
const codesOf = (s) => (s?.reasons || []).map((r) => r.code);
// A kept slide can only be replaced when today's capture of it is a real, loaded, verified page.
const UNHEALTHY = new Set(['needs_fixture', 'not_captured', 'empty_state', 'page_not_loaded', 'page_error', 'record_not_visible', 'data_missing', 'target_unverified']);
const quote = (t) => `“${String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)}”`;
// The label a viewer would now look for in vain: the old text of a renamed or removed element.
const staleLabel = (c) => (c.kind === 'renamed' || c.kind === 'removed') && c.before ? c.before : null;
const UI_NOUN = 'tabs?|buttons?|menus?|pages?|panels?|fields?|columns?|sections?|links?|options?|dropdowns?|filters?|cards?|toggles?|views?';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does spoken text refer to this UI label? Multi-word labels: phrase match. A one-word label is also an ordinary word
 *  ("we manage rules"), so it counts only when quoted, followed by a UI noun ("the manage tab") or capitalised
 *  mid-sentence ("open Manage"). */
export function mentionsLabel(text, label) {
  const l = String(label ?? '').trim();
  if (!l || !text) return false;
  if (/\s/.test(normalizeText(l))) return containsPhrase(text, l);
  const w = esc(l);
  return new RegExp(`["“‘']${w}["”’']`, 'i').test(text) || new RegExp(`\\b${w}\\s+(?:${UI_NOUN})\\b`, 'i').test(text)
    || new RegExp(`(?<![.!?]\\s|^)(?<=\\S\\s)${w}\\b`).test(text);
}
/** Is this label one of the visible lines (a heading, tab, column or button), not just a word inside other text? */
const onScreen = (text, label) => !!text && !!label && visibleLines(text).has(normalizeText(label));

/**
 * @param {object} p
 * @param {Array} p.steps        job steps: {index, verdict, reasons, uiContext:{route, slideText, visibleText}, evidence:{today}}
 * @param {Array} p.scriptSteps  saved script steps (recorded url, narration, caption, target)
 * @param {Array} p.slides       selected slides: [{index, changes:[{kind, before, after, element}]}]
 * @param {(change)=>boolean} p.isFrame  true for app-frame (sidebar/header) changes
 */
export function assessRepair({ name = null, steps = [], scriptSteps = [], slides = [], isFrame = () => false }) {
  const blockers = new Map(), notes = [], actions = [];
  const block = (code, index, detail) => { if (!blockers.has(code)) blockers.set(code, []); blockers.get(code).push({ index, detail }); };
  const stepOf = (i) => steps.find((s) => s.index === i);
  const scriptOf = (i) => scriptSteps.find((s, n) => (s.index ?? n) === i);
  const recordedRoute = (i) => normalizedRoute(scriptOf(i)?.url ?? scriptOf(i)?.route) ?? normalizedRoute(stepOf(i)?.uiContext?.route);
  // Captions usually repeat the narration; quote each distinct line once.
  const spoken = (i) => { const st = scriptOf(i); return st ? [...new Set([st.narration, st.caption].map((t) => String(t ?? '').trim()).filter(Boolean))].join(' / ') : ''; };
  // The clicked element's own name; target.label is often its surrounding panel and would over-match.
  const clicked = (i) => { const t = scriptOf(i)?.target; return String(t?.name || t?.text || '').trim(); };
  const selected = new Set(slides.map((s) => s.index));
  const verifiedChanges = slides.flatMap(s => s.changes);
  const semantic = (index) => semanticRepairCheck(stepOf(index), scriptOf(index), verifiedChanges, name);
  // A healthy empty page may prove static labels, never record-dependent actions. The semantic
  // contract enforces all four recordsIndependent checks before executionReady can be true.
  const unhealthyCodes=index=>codesOf(stepOf(index)).filter(code=>UNHEALTHY.has(code)
    &&!(code==='empty_state'&&semantic(index)?.executionReady===true));
  const changes = slides.flatMap((s) => s.changes.map((c) => ({ ...c, slide: s.index, route: recordedRoute(s.index) })));
  const rewrites = new Map();
  // This is an additional pure gate, NOT authorization to trust supplied image/capture hashes.
  // The candidate caller must still re-read the actual assets through verifySemanticRepairAssets.
  const verifiedNarration = (checked) => checked?.executionReady === true && checked.narrationReady === true
    && checked.workflowEquivalent === true && checked.targetReady === true;
  const verifiedCurrentClick = (index) => {
    const st = stepOf(index), script = scriptOf(index), checked = semantic(index);
    if (!verifiedNarration(checked) || !['same', 'equivalent'].includes(checked.review.target.status)
      || codesOf(st).some(code => TARGET_CODES.has(code))||unhealthyCodes(index).length) return false;
    const cap = st.semanticRepair.binding.source.capture.step, raw = cap?.target;
    const label = checked.review.target.currentLabel;
    // Narration agreement alone says nothing about a click. Require the separately bound, successful
    // current capture's EXACT unique name match, not CSS, fuzzy labels or offline disambiguation.
    return script?.action === 'click' && cap?.index === index && cap.action === 'click'
      && cap.clicked === true && cap.performed === 'click' && !cap.error && !cap.prerequisiteUnverified
      && st.target?.status === 'resolved' && st.target.todayName === label
      && raw?.status === 'resolved' && ['role_name', 'name_any_role'].includes(raw.method)
      && st.target.method === raw.method && raw.resolved?.name === label
      && Array.isArray(raw.matches) && raw.matches.length === 1 && raw.matches[0]?.name === label;
  };

  // Checks every replaced slide must pass (selected slides and kept slides extended into the repair).
  const checkReplaced = (index, extra = {}) => {
    const st = stepOf(index), codes = codesOf(st), checked = semantic(index), script = scriptOf(index);
    if (!st?.evidence?.today) block('no_replacement_screenshot', index, 'no current screenshot to put in its place');
    const unhealthy = unhealthyCodes(index);
    if (unhealthy.length || st?.prerequisiteUnverified || ['loading', 'error', 'missing', 'unknown'].includes(st?.pageState)
      || (st?.guard && st.guard !== 'performed_on_fixture' && !(st.guard.status === 'performed_on_fixture' && st.guard.performed === true))) {
      block('replacement_capture_unverified', index, `replacement capture has an unresolved page/prerequisite/fixture check (${unhealthy.join(', ') || st?.guard?.status || st?.guard || st?.pageState || 'prerequisite_unverified'})`);
    }
    const flow = flowEquivalenceCheck(st, script, name);
    const target = codes.filter((c) => TARGET_CODES.has(c) && !(c === 'flow_changed' && flow));
    if (flow && codes.includes('flow_changed')) notes.push({ code: 'flow_equivalence_verified', index,
      detail: 'only the exact saved mode-switch route-alias diagnostic is resolved by input-bound source proof', bindingDigest: flow.bindingDigest });
    if (target.length) block('click_target_changed', index, `recorded click on ${quote(clicked(index) || 'the page')} no longer matches today (${target.join(', ')})`);
    if (codes.includes('viewport_changed')) block('viewport_changed', index, 'current screenshot size differs from the recording');
    if (codes.includes('page_redesigned')) {
      if (checked?.workflowEquivalent) notes.push({ code: 'semantic_repair_verified', index, detail: 'large visual change independently verified as the same supported task and workflow' });
      else block('large_redesign', index, 'the page crosses the redesign threshold; no input-bound semantic-equivalence proof is available');
    }
    const narration = codes.filter((c) => NARRATION_CODES.has(c));
    const positive = verifiedNarration(checked);
    if (positive && script?.action === 'click') {
      const cap = st.semanticRepair.binding.source.capture.step;
      if (cap?.index !== index || cap.action !== 'click' || cap.clicked !== true || cap.performed !== 'click') {
        block('click_target_changed', index, 'independent narration review cannot replace a successful current capture of the recorded click');
      }
    }
    let narrationChange = null;
    if (positive && checked.review.narration.status === 'rewrite') {
      const oldText = script.narration, newText = checked.review.narration.suggestedNarration;
      // The review supplies ONE replacement line. It cannot authorize deleting or overwriting a
      // distinct caption (including a whitespace-different one); renderer caption fallback is exact.
      if (script.caption != null && script.caption !== '' && script.caption !== oldText) {
        block('unsupported_caption_rewrite', index, `distinct original caption needs its own bound replacement: ${quote(script.caption)}`);
      } else if (typeof oldText !== 'string' || !oldText.trim() || newText === oldText) {
        block('unsupported_narration_change', index, 'single-line rewrite requires existing, nonempty narration and a real replacement, not an audio addition/removal or no-op');
      } else {
        narrationChange = { oldText, newText,
          caption: { present: Object.hasOwn(script, 'caption'), oldText: script.caption ?? null, newText },
          bindingDigest: st.semanticRepair.binding.digest, reviewDigest: digest(checked.review) };
        rewrites.set(index, narrationChange);
        notes.push({ code: 'narration_rewrite_verified', index,
          detail: 'independent current-image verification confirms the exact replacement preserves the original instructional intent',
          bindingDigest: narrationChange.bindingDigest, reviewDigest: narrationChange.reviewDigest });
      }
    }
    const accurate = positive && checked.review.narration.status === 'accurate';
    if (narration.length) {
      if (!accurate && !narrationChange) block('narration_flagged', index, `narration check reported ${narration.join(', ')} for ${quote(spoken(index))}`);
      else if (accurate) {
        notes.push({ code: 'narration_accurate_verified', index,
          detail: 'fresh independent current-image proof confirms the exact original narration despite the retained older diagnostic',
          bindingDigest: st.semanticRepair.binding.digest });
      }
    }
    // Every replaced slide still needs a positive check; skipped/failed is never a pass.
    else if (codes.includes('narration_unchecked') && spoken(index) && !accurate && !narrationChange) block('narration_unchecked', index, `narration was not checked against today's screen: ${quote(spoken(index))}`);
    if (codes.includes('route_changed')) notes.push({ code: 'route_changed', index, detail: 'page address changed; the viewer does not see it' });
    if (codes.includes('persistent_chrome_changed')) notes.push({ code: 'frame_differs', index, detail: 'sidebar/header will differ from kept slides; unused frame changes do not mislead (accepted rule)' });
    actions.push({ index, action: codes.includes('target_moved') ? 'replace_screenshot_and_move_highlight' : 'replace_screenshot', ...extra,
      ...(narrationChange ? { newNarration: narrationChange.newText, narrationChange } : {}) });
  };
  for (const s of slides) checkReplaced(s.index);
  const extended = new Map(); // kept slide index -> the change it shows

  for (const st of steps) {
    const i = st.index;
    if (selected.has(i)) continue;
    // A kept slide must be shown not to display any selected change in its old form.
    for (const c of changes) {
      const linked = isFrame(c)
        ? [c.before, c.after].some((l) => l && (mentionsLabel(spoken(i), l) || containsPhrase(clicked(i), l)))
        : recordedRoute(i) == null || recordedRoute(i) === c.route;
      if (!linked || PROVEN_KEPT.has(st.verdict)) continue;
      const checked = semantic(i);
      if (checked?.linkedInterfaceKnown && checked.review.linkedInterface.status === 'not_affected') continue;
      if (checked?.linkedInterfaceKnown && checked.review.linkedInterface.status === 'affected'
        && st.evidence?.today && !unhealthyCodes(i).length) {
        if (!extended.has(i)) extended.set(i, c);
        continue;
      }
      const today = st.uiContext?.visibleText;
      if (c.kind === 'renamed' && today && c.after && onScreen(today, c.after)) {
        // Same verified change on this slide: replace it too, if today's capture of it is healthy.
        const bad = unhealthyCodes(i);
        if (st.evidence?.today && !bad.length) { if (!extended.has(i)) extended.set(i, c); }
        else block('kept_slide_shows_changed_element', i, `same page today shows ${quote(c.after)}, which slide ${c.slide + 1}'s update renames from ${quote(c.before)}; this slide would keep the old name and cannot be replaced (${bad.map((code) => WHY_UNVERIFIED[code] ?? code).join('; ') || 'no current screenshot'})`);
        continue;
      }
      // Neither name on this slide's screen today: the renamed element is not part of this slide.
      if (c.kind === 'renamed' && today && c.after && !containsPhrase(today, c.after) && !containsPhrase(today, c.before)) continue;
      const why = [...new Set(codesOf(st).map((code) => WHY_UNVERIFIED[code] ?? code))].join('; ') || st.verdict;
      block('linked_slide_unproven', i, `same page as slide ${c.slide + 1} (${c.kind} ${quote(c.before ?? c.after)}); cannot confirm it no longer shows the old interface: ${why}`);
    }
  }
  for (const [i, c] of extended) {
    checkReplaced(i, { extendedFrom: c.slide, change: { kind: c.kind, before: c.before, after: c.after } });
    notes.push({ code: 'kept_slide_replaced', index: i, detail: `shows the same verified change as slide ${c.slide + 1} (${quote(c.before)} → ${quote(c.after)}); replaced with today's screenshot` });
  }
  // Evaluate stale spoken/caption text only after extension is final: a proposed rewrite on a
  // non-replaced slide must never waive what the unchanged video will still say. Accurate review
  // may resolve an older narration finding, but is not a generic changed-label string exemption.
  for (const st of steps) {
    const i = st.index, replaced = selected.has(i) || extended.has(i);
    if (!replaced && PROVEN_KEPT.has(st.verdict)) continue;
    for (const c of changes) {
      const stale = staleLabel(c);
      if (stale && mentionsLabel(spoken(i), stale) && !rewrites.has(i)) block('narration_mentions_changed_label', i, `says ${quote(stale)} (now ${c.after ? quote(c.after) : 'removed'}): ${quote(spoken(i))}`);
      if (stale && containsPhrase(clicked(i), stale)) {
        if (replaced && verifiedCurrentClick(i)) {
          notes.push({ code: 'click_target_label_verified', index: i,
            detail: 'independent same-intent review agrees with a successful exact unique current-label click in the bound capture',
            bindingDigest: st.semanticRepair.binding.digest });
        } else block('click_target_uses_changed_label', i, `recorded click is on ${quote(clicked(i))}; ${quote(stale)} is now ${c.after ? quote(c.after) : 'removed'}`);
      }
    }
  }
  const unlinked = steps.filter((s) => !selected.has(s.index) && !extended.has(s.index) && s.verdict === 'unverified' && ![...blockers.values()].flat().some((b) => b.index === s.index));
  if (unlinked.length) notes.push({ code: 'other_unverified_slides', slides: unlinked.map((s) => s.index), detail: 'not linked to the selected changes; they stay as they are (coverage gap, not made worse by the repair)' });
  const list = [...blockers].map(([code, items]) => {
    const seen = new Set(), unique = items.filter((x) => { const k = `${x.index}|${x.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { code, slides: [...new Set(unique.map((x) => x.index))].sort((a, b) => a - b), items: unique };
  });
  return { policy: REPAIR_POLICY, decision: list.length ? 'manual' : 'auto', blockers: list, notes, actions, extended: [...extended.keys()].sort((a, b) => a - b) };
}

export const BLOCKER_TEXT = {
  no_replacement_screenshot: 'A selected slide has no current screenshot to replace it with.',
  replacement_capture_unverified: 'A replacement capture still has an unresolved page, prerequisite or fixture check.',
  click_target_changed: 'The current equivalent of a selected click has not been verified; repair remains blocked.',
  viewport_changed: 'The current screenshot size differs from the recording.',
  large_redesign: 'A replaced slide has a large visual change without independently verified semantic-equivalence evidence.',
  narration_flagged: 'The original narration is flagged and has neither fresh positive accuracy proof nor an independently verified intent-preserving replacement.',
  narration_unchecked: 'The narration of a replaced slide was not checked against today’s screen, so keeping it is not shown to be safe.',
  unsupported_caption_rewrite: 'The original caption differs from the narration; the single-line rewrite contract cannot prove its replacement.',
  unsupported_narration_change: 'The proposed narration is an unsupported addition, removal or no-op rather than a narrow replacement.',
  narration_mentions_changed_label: 'The narration or caption still names a renamed or removed element without a supported independently verified replacement.',
  click_target_uses_changed_label: 'A recorded click names a changed element without both same-intent proof and a successful exact unique current-label capture.',
  kept_slide_shows_changed_element: 'Another slide of the same page shows the changed element but cannot be replaced too (its current capture is not usable), so the video would mix old and new interface.',
  linked_slide_unproven: 'Other slides of the same page could not be verified, so a partial update cannot be shown to leave the video consistent.',
};
