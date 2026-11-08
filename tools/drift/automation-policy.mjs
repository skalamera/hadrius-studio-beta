// Pure weekly routing. A hold is not evidence that a person must re-record a video.
import { digest } from './contracts.mjs';
import { validateSemanticRepairReview } from './semantic-repair.mjs';
import { semanticRepairCheck, semanticStepDigest } from './semantic-repair-proof.mjs';

export const AUTOMATION_POLICY = 'weekly-automation-v1';
// renderer.drift_update supports these dimensions, including multi-step/edge repairs.
// This is capability, not automatic OUTPUT certification (automatic-qa is visual-only).
export const RENDERER_CLASSES = Object.freeze(['screenshot', 'target_geometry', 'narration', 'timing']);
export const AUTOMATION_ROUTES = Object.freeze(['no_change', 'automatic_repair', 'evidence_pending', 'setup_required', 'human_required']);
const text = x => typeof x === 'string' && x.trim().length > 0;
const known = x => text(x) && !/^(?:unknown|unverified|none|null|n\/?a|not (?:available|checked|verified)|insufficient evidence|no evidence)[.!]?$/i.test(x.trim());
const same = (a, b) => { try { return digest(a) === digest(b); } catch { return false; } };
const setupCodes = new Set(['baseline_missing', 'baseline_unverified', 'input_missing', 'missing_build_dir', 'missing_recordings_dir',
  'missing_identified_script', 'script_needs_stable_step_ids', 'identity_missing', 'identity_conflict', 'provider_unavailable', 'provider_auth_required',
  'tenant_unknown', 'tenant_conflict', 'tenant_unregistered', 'tenant_mismatch', 'blocked_account_visibility']);
const evidenceCodes = new Set(['needs_fixture', 'not_captured', 'no_replacement_screenshot', 'empty_state', 'page_not_loaded', 'page_error',
  'record_not_visible', 'data_missing', 'target_unverified', 'target_missing', 'target_ambiguous', 'target_renamed', 'review_pending',
  'model_unavailable', 'model_review_missing', 'budget_exhausted', 'narration_unchecked', 'linked_slide_unproven', 'kept_slide_shows_changed_element']);

function boundProof(step, scriptStep, changes, name) {
  const p = step?.semanticRepair, b = p?.binding;
  try {
    if (!b || b.videoName !== name || b.stepIndex !== step.index || !same(b.scriptStep, scriptStep)
      || b.source.job.stepDigest !== semanticStepDigest(step) || !same(b.selectedVerifiedChanges, changes)
      || b.source.job.recordedPath !== step.evidence?.recorded || b.source.job.currentPath !== step.evidence?.today) return null;
    return p;
  } catch { return null; }
}
// The current semantic validator returns blocked/workflow_changed BEFORE checking verification.
// Therefore blocked is NOT independently confirmed complexity: check that independent attestation here.
function independentlyChanged(p) {
  const c = validateSemanticRepairReview(p.review, p), context = p.binding.captureContext;
  if(context.taskContext!=='verified'||context.pageState!=='loaded'||p.review?.workflow?.recordsIndependent!==true)return false;
  const changed = c.valid && c.status === 'blocked' && c.reasons.length === 1 && c.reasons[0] === 'workflow_changed';
  // The validator deliberately rejects intent-changing rewrites before it reaches the independent
  // checker. That rejection alone proves nothing. A positively corroborated CHANGED workflow plus
  // explicit independent non-preservation can establish an unsupported instructional change.
  const unsupportedInstruction = c.status === 'rejected' && c.reasons.length === 1 && c.reasons[0] === 'narration_intent_not_preserved'
    && p.review.workflow.status === 'changed' && context.taskContext === 'verified'
    && ['loaded', 'empty'].includes(context.pageState)
    && (context.pageState !== 'empty' || (!context.recordSpecificAction
      && ['workflow', 'narration', 'target', 'linkedInterface'].every(k => p.review[k].recordsIndependent)))
    && p.verification?.narration?.verified === true && p.verification.narration.preservesIntent === false
    && known(p.verification.narration.reason) && known(p.verification.narration.evidence) && known(p.verification.narration.intentEvidence);
  if (!changed && !unsupportedInstruction) return false;
  const v = p.verification, r = v?.verifier, w = v?.workflow;
  return v?.bindingDigest === p.binding.digest && v.reviewDigest === digest(p.review)
    && v.currentImageSha256 === p.binding.imageSha256s.current
    && ['model', 'human', 'deterministic'].includes(r?.kind) && known(r.id)
    && (r.kind !== 'model' || (known(r.provider) && known(r.model) && known(r.reviewId) && r.reviewId !== p.metadata?.reviewId))
    && w?.verified === true && known(w.reason) && known(w.evidence);
}

/**
 * Caller supplies the FULL finalized selection (slides), original job/script steps and assessRepair result.
 * prerequisites.{baseline,input,identity,provider}: true only after actual setup checks; false/missing = setup.
 * prerequisites.{capture,fixture,target,model,budget}: false explicitly records a pending evidence dependency.
 * Semantic reviews must retain their real binding/review/metadata/independent verification objects.
 * Unknown blockers stay pending. Neither legacy severity nor manual/auto alone authorizes anything.
 * renderer.supportedClasses can RESTRICT the known renderer capabilities, not invent new ones.
 * Renderer structural/unsupported-instruction changes require independently verified workflow=changed;
 * an unsupported proposed patch by itself may simply be the wrong patch, not proven human work.
 */
function evaluateAutomation({ name = null, steps = [], scriptSteps = [], identifiedScript = null, slides = [], repair = null,
  prerequisites = {}, renderer = {}, structuralChanges = [] } = {}) {
  const reasons = [], scope = { indices: [], stepIds: [] };
  const finish = status => ({ schema: 1, policy: AUTOMATION_POLICY, status, route: status,
    humanRequired: status === 'human_required', reasons, scope, supportedClasses: [...RENDERER_CLASSES] });
  const add = (code, index = null, detail = null) => reasons.push({ code, index, ...(detail ? { detail } : {}) });
  if (![steps, scriptSteps, slides, structuralChanges].every(Array.isArray) || !prerequisites || !renderer) {
    add('invalid_automation_inputs'); return finish('setup_required');
  }
  if (!slides.length) {
    // A complete, positively unchanged assessment is needed; an empty selection is not proof of no drift.
    if (steps.length && steps.every(s => ['unchanged', 'unchanged_with_data_drift'].includes(s?.verdict)
      && !(s.reasons ?? []).some(r => evidenceCodes.has(r.code) || setupCodes.has(r.code))) && !structuralChanges.length
      && !['capture', 'fixture', 'target', 'model', 'budget'].some(k => prerequisites[k] === false)) return finish('no_change');
    add('selection_or_evidence_pending'); return finish('evidence_pending');
  }
  if (slides.some(s => !Number.isSafeInteger(s?.index) || s.index < 0 || !Array.isArray(s.changes) || !s.changes.length)
    || new Set(slides.map(s => s.index)).size !== slides.length || !Array.isArray(repair?.extended ?? [])) {
    add('invalid_selected_scope'); return finish('evidence_pending');
  }
  scope.indices = [...new Set([...slides.map(s => s.index), ...(repair?.extended ?? [])])].sort((a, b) => a - b);
  const source = i => scriptSteps.find((s, n) => (s.index ?? n) === i);
  if (scope.indices.some(i => !Number.isSafeInteger(i) || i < 0 || !source(i)) || new Set(steps.map(s => s.index)).size !== steps.length) {
    add('input_missing'); return finish('setup_required');
  }
  const identifiedSteps = identifiedScript?.steps ?? scriptSteps;
  const stripped = Array.isArray(identifiedSteps) ? structuredClone(identifiedSteps) : [];
  stripped.forEach((s, n) => { if (!Object.hasOwn(scriptSteps[n] ?? {}, 'id')) delete s.id; });
  if (!same(stripped, scriptSteps)) { add('identity_conflict'); return finish('setup_required'); }
  scope.stepIds = scope.indices.map(i => identifiedSteps.find((s, n) => (s.index ?? n) === i)?.id);
  if (!text(name) || scope.stepIds.some(id => !text(id)) || new Set(scope.stepIds).size !== scope.stepIds.length) {
    add('identity_missing'); return finish('setup_required');
  }
  const changes = slides.flatMap(s => s.changes);
  const scopedSteps = scope.indices.map(i => steps.find(s => s.index === i));
  const bound = scopedSteps.map((s, n) => boundProof(s, source(scope.indices[n]), changes, name));
  const complex = bound.findIndex((p,n) => p && independentlyChanged(p)
    &&!(scopedSteps[n]?.reasons??[]).some(r=>['target_missing','target_ambiguous','target_unverified','target_renamed','needs_fixture','not_captured','page_not_loaded','page_error','record_not_visible','data_missing','empty_state'].includes(r.code))
    &&!scopedSteps[n]?.prerequisiteUnverified);
  if (complex >= 0) {
    add(bound[complex].review.narration.preservesIntent === false ? 'independently_verified_unsupported_instruction_change'
      : 'independently_verified_workflow_change', scope.indices[complex]);
    return finish('human_required');
  }
  for (const key of ['baseline', 'input', 'identity', 'provider']) if (prerequisites[key] !== true) add(`${key}_setup_required`);
  for (const s of scopedSteps) for (const r of s?.reasons ?? []) if (setupCodes.has(r.code)) add(r.code, s.index);
  for (const b of repair?.blockers ?? []) if (setupCodes.has(b.code)) add(b.code);
  if (reasons.length) return finish('setup_required');
  for (const key of ['capture', 'fixture', 'target', 'model', 'budget']) if (prerequisites[key] === false) add(`${key}_pending`);
  if (structuralChanges.length) add('structural_change_not_independently_proven');
  const supported = new Set((Array.isArray(renderer.supportedClasses) ? renderer.supportedClasses : RENDERER_CLASSES).filter(c => RENDERER_CLASSES.includes(c)));
  for (let n = 0; n < scope.indices.length; n++) {
    const i = scope.indices[n], s = scopedSteps[n], st = source(i);
    if (!s?.evidence?.today) add('capture_pending', i);
    const p = bound[n], checked = p ? semanticRepairCheck(s, st, changes, name) : null;
    if (!checked) {
      const checkedStatus = p ? validateSemanticRepairReview(p.review, p) : null;
      add('semantic_evidence_pending', i, checkedStatus?.reasons?.join(', ') || 'Missing or stale independent semantic review');
    }
    if (st.capture === false || !st.media?.pre || /\.(mp4|mov|webm)$/i.test(st.media.pre)) add('unsupported_slide_input', i);
    if (!supported.has('screenshot')) add('renderer_screenshot_unavailable', i);
    if (checked?.review.narration.status === 'rewrite') {
      if (!supported.has('narration')) add('renderer_narration_unavailable', i);
      if (!supported.has('timing')) add('renderer_timing_unavailable', i);
    }
    if ((s?.reasons ?? []).some(r => r.code === 'target_moved') && !supported.has('target_geometry')) add('renderer_geometry_unavailable', i);
    for (const r of s?.reasons ?? []) if (evidenceCodes.has(r.code)
      && !(r.code === 'narration_unchecked' && checked?.narrationReady === true)
      && !(r.code==='empty_state'&&checked?.executionReady===true)) add(r.code, i);
  }
  if (!repair || !['auto', 'manual'].includes(repair.decision) || !Array.isArray(repair.blockers) || !Array.isArray(repair.actions)) add('repair_assessment_missing');
  else {
    for (const b of repair.blockers) add(b.code || 'unknown_repair_blocker', null);
    if (repair.decision !== 'auto' && !repair.blockers.length) add('legacy_manual_hold');
    const actionIndices = repair.actions.map(a => a.index);
    if (!same([...actionIndices].sort((a, b) => a - b), scope.indices) || new Set(actionIndices).size !== actionIndices.length) add('repair_scope_mismatch');
    for (const a of repair.actions) if (!['replace_screenshot', 'replace_screenshot_and_move_highlight'].includes(a.action)) add('unsupported_repair_action', a.index);
  }
  return finish(reasons.length ? 'evidence_pending' : 'automatic_repair');
}

export function routeAutomation(input) {
  try { return evaluateAutomation(input); }
  catch { return { schema: 1, policy: AUTOMATION_POLICY, status: 'setup_required', route: 'setup_required', humanRequired: false,
    reasons: [{ code: 'invalid_automation_inputs', index: null }], scope: { indices: [], stepIds: [] }, supportedClasses: [...RENDERER_CLASSES] }; }
}
export const assessAutomation = routeAutomation;

/** Weekly integration adapter; pure, no file reads or model calls.
 * job.script / job.scriptSteps and job.identifiedScript may be supplied by the caller. If absent,
 * only exact source steps present in bound reviewRows can be recovered (never invented IDs).
 * Baseline enrollment may still be pending: baselineError expresses a FAILED prerequisite,
 * whereas null means the pipeline can attempt its normal local enrollment next.
 */
export function routeAutomationVideo({ job, selection, reviewRows = [], baselineError = null, renderError = null } = {}) {
  const finish = (status, reason, extra = {}) => ({ status, reason, ...extra });
  if (!job || !selection || !Array.isArray(reviewRows)) return finish('setup_required', 'job_and_finalized_selection_required');
  if (selection.name && selection.name !== job.name) return finish('setup_required', 'selection_identity_conflict');
  const rows = reviewRows.filter(r => r.name === job.name);
  const slides = selection.slides ?? [];
  if (!Array.isArray(slides)) return finish('evidence_pending', 'selected_scope_missing');
  if (!slides.length) {
    const codes = (job.steps ?? []).flatMap(s => (s.reasons ?? []).map(r => r.code));
    const pending = codes.some(c => setupCodes.has(c) || evidenceCodes.has(c));
    if (setupCodes.has(job.status) || codes.some(c => setupCodes.has(c))) return finish('setup_required', 'capture_identity_or_provider_setup_required');
    // Ignoring known irrelevant UI is not proof that separate uncaptured/failed steps are unchanged.
    if(pending||job.complete===false||(job.status&&job.status!=='ok'))return finish('evidence_pending','capture_or_selection_evidence_pending');
    if (['ui_additions_only', 'unused_app_frame_changes'].includes(selection.reason)) return finish('no_change', selection.reason);
    if (job.status === 'ok' && job.complete !== false && !pending && ['unchanged', 'unchanged_with_data_drift'].includes(job.verdict)) return finish('no_change', 'no_selected_interface_change');
    return finish('evidence_pending', 'capture_or_selection_evidence_pending');
  }
  if (baselineError) return finish('setup_required', 'baseline_setup_required', { reasons: [String(baselineError.code ?? baselineError.message ?? baselineError)] });
  if (renderError) {
    const reason = String(renderError.code ?? renderError.message ?? renderError);
    return finish(/missing|identity|provider|unsupported|font_layout|baseline|build_dir/.test(reason) ? 'setup_required' : 'evidence_pending', reason);
  }
  const steps = structuredClone(job.steps ?? []);
  for (const s of steps) {
    const matches = rows.filter(r => r.index === s.index && r.proof?.binding);
    if (matches.length === 1) s.semanticRepair = structuredClone(matches[0].proof);
    // Conflicting reviews cannot be silently resolved by array order.
    else if (matches.length > 1 && matches.every(r => same(r.proof, matches[0].proof))) s.semanticRepair = structuredClone(matches[0].proof);
    else if (matches.length > 1) delete s.semanticRepair;
  }
  const scriptSteps = job.script?.steps ?? job.scriptSteps ?? selection.scriptSteps
    ?? steps.filter(s => s.semanticRepair?.binding?.scriptStep).map(s => s.semanticRepair.binding.scriptStep);
  const repair = selection.repair;
  const scoped = new Set([...slides.map(s => s.index), ...(repair?.extended ?? [])]);
  const rewrite = steps.some(s => scoped.has(s.index) && s.semanticRepair?.review?.narration?.status === 'rewrite');
  const input = { name: job.name, steps, scriptSteps, identifiedScript: job.identifiedScript ?? null, slides, repair,
    prerequisites: { baseline: true, input: scriptSteps.length > 0, identity: true, provider: true, ...(job.automationPrerequisites ?? {}) },
    renderer: job.renderer ?? {}, structuralChanges: job.structuralChanges ?? [] };
  let routed;
  try { routed = routeAutomation(input); } catch { return finish('setup_required', 'invalid_automation_inputs'); }
  if (routed.status === 'human_required') return { ...routed, reason: routed.reasons[0]?.code };
  // A visual-only caller must opt into the separately certified replacement-take path.
  if (rewrite && job.renderer?.automaticNarration!==true && !routed.reasons.some(r => r.code === 'semantic_evidence_pending')) return finish('setup_required', 'visual_runner_narration_capability_required', { reasons: routed.reasons });
  return { ...routed, reason: routed.reasons[0]?.code ?? (routed.status === 'automatic_repair' ? 'independently_verified_supported_repair' : routed.status) };
}
