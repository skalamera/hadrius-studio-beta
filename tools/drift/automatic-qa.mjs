// Deterministic certification of VISUAL-ONLY repairs. No rendering, models, playback or writes.
// Complete native-frame/packet/PCM assertions come from renderer.drift_update + preservation,
// NOT contact-sheet sampling, transcription, a claimed visual review, or verification.ok alone.
import { join, dirname } from 'node:path';
import { digest, applyVisualPatch } from './contracts.mjs';
import { checkVerification, readPyJson } from './executor.mjs';
import { sha256File } from './publish.mjs';
import { routeAutomation } from './automation-policy.mjs';
import { selectWeeklyJobs } from './ui-selection.mjs';

export const AUTOMATIC_QA_POLICY = 'automatic-visual-qa-v1';
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const pos = v => Number.isSafeInteger(v) && v > 0;
const same = (a, b) => { try { return digest(a) === digest(b); } catch { return false; } };
const setEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length
  && new Set(b).size === b.length && same([...a].sort(), [...b].sort());
const omit = (v, ks) => Object.fromEntries(Object.entries(v).filter(([k]) => !ks.includes(k)));
const slideId = s => `slide-${String(s.slide).padStart(2, '0')}`;
const merged = ranges => ranges.reduce((a, [start, end]) => {
  const last = a.at(-1); if (last && last[1] === start) last[1] = end; else a.push([start, end]); return a;
}, []);

/** Pure evaluator. readback is produced by automaticQa's injected trusted I/O, never a model.
 * Use automaticQa for real output: it invokes executor.checkVerification and independently hashes
 * the candidate, control, baseline, immutable inputs and semantic image assets before this evaluator.
 */
function evaluateAutomaticQa({ checked, controlChecked, baselineManifest: bm, originalScript: base,
  candidateScript: candidate, originalAssembly: assembly, candidateAssembly: next, changeManifest: cm,
  semanticPlan, readback } = {}) {
  const checks = {}, reasons = [];
  const gate = (name, yes) => { checks[name] = yes === true; if (!checks[name]) reasons.push(name); return checks[name]; };
  const v = checked?.v, ctrl = controlChecked?.v;
  const report = () => ({ schema: 1, kind: 'automatic-output-qa', policy: AUTOMATIC_QA_POLICY,
    ok: !reasons.length, status: reasons.length ? 'qa_blocked' : 'automatically_verified', checks, reasons,
    pictureAndAudioInspection: reasons.length ? 'blocked' : 'not_required', humanInspectionPending: false,
    // These are explicit non-claims. Bit identity is not listening/transcription or an image judgment.
    performed: { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false },
    evidenceBasis: 'Independent input-bound semantic plan and complete renderer equality assertions',
    artifacts: { candidate: checked?.candidate ?? null, sha256: checked?.sha256 ?? null,
      verification: checked?.file ?? null, verificationSha256: readback?.verificationSha256 ?? null,
      controlVerification: controlChecked?.file ?? null, controlSha256: controlChecked?.sha256 ?? null,
      baselineSha256: bm?.final?.sha256 ?? null, semanticPlanDigest: (() => { try { return digest(semanticPlan); } catch { return null; } })() },
    baselineReencodeDisclosed: true, publishingAuthorized: false });
  if (!gate('verification_shape', obj(v) && obj(ctrl) && obj(bm) && obj(base) && obj(candidate) && obj(assembly) && obj(next) && obj(cm))) return report();
  gate('completed_render', v.ok === true && !v.dry_run && !v.noop && ctrl.ok === true && !ctrl.dry_run && !ctrl.noop);
  gate('candidate_hash_validated', hash(v.candidate_sha256) && checked.sha256 === v.candidate_sha256
    && checked.candidate === v.candidate && readback?.candidateSha256 === checked.sha256 && hash(readback?.verificationSha256));
  gate('baseline_and_control_hash_validated', hash(bm.final?.sha256) && v.baseline_sha256 === bm.final.sha256
    && ctrl.baseline_sha256 === bm.final.sha256 && ctrl.candidate_sha256 === bm.final.sha256
    && controlChecked.sha256 === bm.final.sha256 && controlChecked.candidate === ctrl.candidate
    && readback?.controlSha256 === bm.final.sha256 && readback?.baselineSha256 === bm.final.sha256);
  let routed;
  try { routed = routeAutomation(semanticPlan); } catch { /* malformed proof is a hold */ }
  gate('positive_semantic_plan', routed?.status === 'automatic_repair' && readback?.semanticAssetsVerified === true);
  const ids = routed?.scope.stepIds ?? [], selected = new Set(routed?.scope.indices ?? []);
  gate('semantic_original_narration_accurate', ids.length > 0 && [...selected].every(i => {
    const p = semanticPlan?.steps?.find(s => s.index === i)?.semanticRepair;
    return p?.review?.narration?.status === 'accurate' && p.review.narration.suggestedNarration === null;
  }));
  const semanticIdentitySteps = semanticPlan?.identifiedScript?.steps ?? semanticPlan?.scriptSteps;
  gate('original_script_bound', Array.isArray(base.steps) && same(base.steps, semanticIdentitySteps)
    && hash(readback?.originalScriptSha256));
  gate('baseline_verified', readback?.baselineVerified === true);
  gate('manifest_bound', hash(readback?.baselineManifestSha256) && cm.baselineManifestHash === readback.baselineManifestSha256
    && Array.isArray(cm.changes) && setEqual(cm.changes.map(c => c?.stepId), ids) && ids.length > 0);
  const snapshot = v.source_snapshot, before = snapshot?.before, after = snapshot?.after;
  gate('source_unchanged', v.source_unchanged === true && obj(before) && Object.keys(before).length > 0 && same(before, after)
    && snapshot.files === Object.keys(before).length && Object.values(before).every(s => hash(s?.sha256)
      && Number.isSafeInteger(s.size) && s.size >= 0 && Number.isFinite(s.mtime_ns)) && readback?.sourceSnapshotUnchanged === true);
  gate('original_inputs_snapshotted', obj(before) && hash(readback?.originalScriptSha256)
    &&Object.values(before).some(s=>s.sha256===readback.originalScriptSha256)
    && before[readback?.originalAssemblyPath]?.sha256 === readback?.originalAssemblySha256
    && bm.assembly?.sha256 === readback?.originalAssemblySha256
    // drift_update snapshots the caller's original manifest, then byte-copies it into output/inputs.
    // The copied path need not be an original input; its exact bytes must be in the immutable snapshot.
    && hash(readback?.changeManifestSha256)&&Object.values(before).some(s=>s.sha256===readback.changeManifestSha256));
  const visualOnly = Array.isArray(cm.changes) && cm.changes.length > 0 && cm.changes.every(c => obj(c)
    && Object.keys(c).every(k => ['stepId', 'screenshot', 'target', 'dpr'].includes(k))
    && obj(c.screenshot) && hash(c.screenshot.sha256) && typeof c.screenshot.path === 'string');
  gate('visual_only_manifest', visualOnly);
  gate('replacement_images_semantically_bound', visualOnly && cm.changes.every(ch => {
    const st = base.steps?.find(s => s.id === ch.stepId);
    const evidence = semanticPlan?.steps?.find(s => s.index === st?.index);
    return evidence?.evidence?.today === ch.screenshot.path
      && evidence?.semanticRepair?.binding?.imageSha256s?.current === ch.screenshot.sha256;
  }));
  gate('no_new_audio', obj(v.takes) && Object.keys(v.takes).length === 0 && v.elevenlabs_characters === 0 && v.audio === null
    && Array.isArray(semanticPlan?.repair?.actions) && semanticPlan.repair.actions.every(a => a.newNarration == null && a.narrationChange == null));
  if (visualOnly && Array.isArray(base.steps)) {
    try {
      const patch = { baseHash: digest(base), structuralChanges: [], changes: cm.changes.map(c => ({ stepId: c.stepId,
        beforeHash: digest(base.steps.find(s => s.id === c.stepId)) })) };
      const expected = applyVisualPatch(base, patch, cm.changes.map(c => {
        const old = base.steps.find(s => s.id === c.stepId);
        return { stepId: c.stepId, fields: { media: { ...old.media, pre: `step_${c.screenshot.sha256}.png` }, captureId: c.screenshot.sha256,
          ...(Object.hasOwn(c, 'target') ? { target: c.target } : {}), ...(Object.hasOwn(c, 'dpr') ? { dpr: c.dpr } : {}) } };
      }));
      expected.recording = { ...expected.recording, id: candidate.recording?.id };
      gate('script_exact_visual_patch', same(expected, candidate));
    } catch { gate('script_exact_visual_patch', false); }
  } else gate('script_exact_visual_patch', false);
  const meta = v.candidate_capture_manifest;
  gate('candidate_script_hash', obj(meta) && meta.candidateHash === digest(candidate) && meta.identifiedBaseHash === digest(base)
    && meta.recordingId === candidate.recording?.id && setEqual(meta.changedStepIds, ids));
  const slides = assembly.slides, newer = next.slides, plan = v.plan, c = v.checks;
  if (!gate('complete_plan', Array.isArray(slides) && slides.length > 0 && Array.isArray(newer) && newer.length === slides.length
    && obj(plan) && obj(c) && Array.isArray(plan.cell_map) && plan.cell_map.length > 0)) return report();
  gate('assembly_metadata_unchanged', same(omit(assembly, ['slides']), omit(next, ['slides'])));
  const captured = base.steps.filter(s => s.capture !== false && s.media?.pre);
  gate('assembly_script_mapping', captured.length === slides.length && new Set(slides.map(s => s.step)).size === slides.length
    && slides.every((s, i) => s.step === captured[i].index && s.src === captured[i].media.pre
      && newer[i].step === s.step && newer[i].src === candidate.steps.find(st => st.id === captured[i].id)?.media?.pre));
  const slideIds = slides.map(slideId), changedSteps = Object.fromEntries(slides.filter(s => selected.has(s.step)).map(s => [base.steps?.find(st => st.index === s.step)?.id, slideId(s)]));
  gate('changed_steps_exact_scope', setEqual(Object.keys(changedSteps), ids) && same(plan.changed_steps, changedSteps));
  // Any camera-plan expansion must be a real plan difference, never an arbitrary extra dirty slide.
  const allowedPlan = ['_cam', '_fx', '_cap_edges', '_cap_top'];
  const dirty = slides.filter((s, i) => selected.has(s.step) || !same(omit(s, ['src', 'target']), omit(newer[i], ['src', 'target']))).map(slideId);
  gate('dirty_scope_exact', setEqual(plan.dirty_slides, dirty) && dirty.every(id => slideIds.includes(id)));
  const stableFields = ['narration', 'caption', 'audio', 'adur', 'sdur', 'start'];
  const optionalStableFields=['_cap_text','audio_filter'];
  gate('narration_captions_takes_timing_unchanged', slides.every((s, i) => stableFields.every(k => Object.hasOwn(s, k)
    && Object.hasOwn(newer[i], k) && same(s[k], newer[i][k]))&&optionalStableFields.every(k=>
      Object.hasOwn(s,k)===Object.hasOwn(newer[i],k)&&(!Object.hasOwn(s,k)||same(s[k],newer[i][k])))));
  gate('assembly_visual_scope_only', slides.every((s, i) => {
    const visual = dirty.includes(slideId(s)) ? allowedPlan : [];
    const selectedFields = selected.has(s.step) ? ['src', 'target'] : [];
    return same(omit(s, [...visual, ...selectedFields]), omit(newer[i], [...visual, ...selectedFields]));
  }));
  const durations = slides.map(s => s.sdur), starts = slides.map(s => s.start);
  gate('timing_unchanged', pos(bm.frameCount) && plan.frames?.base === bm.frameCount && plan.frames?.new === bm.frameCount
    && plan.shift_frames === 0 && same(plan.sdurs?.base, durations) && same(plan.sdurs?.new, durations)
    && same(plan.starts?.base, starts) && same(plan.starts?.new, starts));
  gate('golden_planner', plan.replan_golden?.equal === true && plan.replan_golden.slides === slides.length
    && v.golden?.replan?.equal === true && v.golden.replan.slides === slides.length && hash(plan.planner_fingerprint));
  const chain = v.golden?.chain;
  gate('golden_chain', chain?.mode === 'video_only' && chain.decoded_frames_equal === true && chain.frames === bm.frameCount
    && chain.equal_frames === bm.frameCount && chain.offsets_equal === true && obj(chain.offsets)
    && setEqual(Object.keys(chain.offsets), ['lead', 'support', 'outro']) && Object.values(chain.offsets).every(x => Number.isFinite(x) && x >= 0)
    && obj(chain.stage_frames) && setEqual(Object.keys(chain.stage_frames), ['content', 'lead', 'support', 'outro'])
    && Object.values(chain.stage_frames).every(pos) && chain.stage_frames.outro === bm.frameCount
    && same(chain.offsets, chain.stored_offsets) && same(c.chain_offsets, chain.offsets) && same(c.chain_stage_frames, chain.stage_frames));
  const cells = plan.cell_map, bmCells = bm.cells;
  const renders = cells.filter(x => x.action === 'render'), reuses = cells.filter(x => x.action === 'reuse');
  let cursor = 0;
  gate('complete_cell_partition', Array.isArray(bmCells) && bmCells.length === cells.length && new Set(cells.map(x => x.id)).size === cells.length
    && cells.every((x, i) => {
      const b = bmCells[i], end = x.new?.[1];
      const valid = b && x.id === b.id && same(x.dependsOn, b.dependsOn) && Array.isArray(x.new) && x.new.length === 2
        && same(x.base, [b.startFrame, b.endFrame]) && same(x.new, x.base) && x.new[0] === cursor && pos(end) && end > cursor
        && ['reuse', 'render'].includes(x.action) && x.action === (x.dependsOn.some(d => dirty.includes(d)) ? 'render' : 'reuse');
      cursor = end; return valid;
    }) && cursor === bm.frameCount && setEqual(plan.rendered_cells, renders.map(x => x.id)) && setEqual(plan.reused_cells, reuses.map(x => x.id)));
  gate('complete_decoded_frames_and_timestamps', c.frames_total === bm.frameCount && c.expected_frames === bm.frameCount
    && c.decodable === true && c.timestamps_contiguous === true && c.keyframes_at_cell_starts === true && c.cells_accounted === true);
  const controlCells = v.golden?.control_cells_byte_identical_to_rebaseline;
  gate('unchanged_image_control', obj(controlCells) && setEqual(Object.keys(controlCells), renders.map(x => x.id))
    && Object.values(controlCells).every(x => x === true) && ctrl.source_unchanged === true);
  gate('protected_views', plan.protected_views?.ok === true && plan.protected_views.mismatch_count === 0
    && Number.isSafeInteger(plan.protected_views.frames_checked) && plan.protected_views.frames_checked >= 0);
  gate('protected_cells_byte_and_frame_equal', obj(c.reused_cells) && setEqual(Object.keys(c.reused_cells), reuses.map(x => x.id))
    && c.reused_cells_byte_identical === true && c.reused_frames_equal_at_shifted_positions === true
    && reuses.every(x => { const e = c.reused_cells[x.id], b = bmCells?.find(y => y.id === x.id);
      return e?.byte_identical === true && hash(e.sha256) && e.sha256 === b?.sha256 && e.shift_frames === 0 && same(e.base, x.base) && same(e.new, x.new); }));
  gate('rendered_cells_accounted', obj(c.rendered_cells) && setEqual(Object.keys(c.rendered_cells), renders.map(x => x.id))
    && renders.every(x => { const e = c.rendered_cells[x.id]; return hash(e?.sha256) && same(e.base, x.base) && same(e.new, x.new); }));
  const pres = c.preservation, ranges = renders.map(x => x.new), reusedCount = reuses.reduce((n, x) => n + x.new[1] - x.new[0], 0);
  gate('protected_native_frames_equal', pres?.protected_frames_equal === true && pres.protected_frame_count === reusedCount
    && pres.baseline_sha256 === bm.final.sha256 && pres.candidate_sha256 === v.candidate_sha256
    && pres.artifact === v.candidate && setEqual(pres.reused_cells, reuses.map(x => x.id)) && same(pres.dirty_frames, ranges)
    && same(c.dirty_frames, merged(ranges)) && c.changed_frames_inside_dirty === true
    && Number.isSafeInteger(c.frames_changed) && c.frames_changed > 0 && c.frames_changed <= bm.frameCount - reusedCount);
  // preservation.complete_audio_equal represents full decoded PCM identity, not an SNR threshold.
  gate('full_audio_packets_pcm_and_timing_identical', pres?.complete_audio_equal === true && pres.audio_packets_and_timing_equal === true
    && pos(pres.audio_packet_count) && pres.audio_packet_count === bm.audio?.packets && hash(bm.audio?.pcm_sha256));
  gate('caption_assertions_complete', c.captions?.other_captions_unchanged === true && obj(c.captions.slides)
    && Object.keys(c.captions.slides).length === 0 && c.captions.changed_caption_pngs_match_new_text === true
    && c.captions.changed_caption_bands_differ === true);
  return report();
}

/** Malformed/missing assertions are data failures, never uncaught success paths. */
export function assessAutomaticQa(input) {
  try { return evaluateAutomaticQa(input); }
  catch (e) { return { schema: 1, kind: 'automatic-output-qa', policy: AUTOMATIC_QA_POLICY, ok: false,
    status: 'qa_blocked', reasons: ['malformed_qa_evidence', e.code || e.message], checks: { evidence_well_formed: false },
    pictureAndAudioInspection: 'blocked', humanInspectionPending: false, publishingAuthorized: false,
    performed: { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false } }; }
}

/** Read-only adapter. Inject readJson/hashFile/checkVerification for unit tests; defaults read actual
 * renderer output via readPyJson (Python Infinity compatible) and executor candidate hash validation.
 * No media program/model/browser/service is invoked. Caller may persist the returned report artifact.
 */
/** Parent pipeline adapter. Recompute FULL-batch selection, then certify this result against that
 * exact scope and its original script. Returns report data for the pipeline to persist; never writes
 * over renderer output or clears a failed gate. `deps` is optional trusted read-only test plumbing.
 */
export function certifyAutomaticRepair({ result, repo, preparationDir, baselineDir } = {}, deps = {}) {
  const read = deps.readJson ?? readPyJson;
  try {
    if (!result || result.rendered !== true || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result.name ?? '')) throw new Error('completed_named_local_render_required');
    const summary = read(join(preparationDir, 'summary.json'));
    if (!Array.isArray(summary.names) || new Set(summary.names).size !== summary.names.length || !summary.names.includes(result.name)) throw new Error('complete_batch_names_required');
    const jobs = summary.names.map(name => read(join(preparationDir, name, 'job.json')));
    const scripts = new Map(summary.names.map(name => [name, read(join(repo, 'scripts', name + '.script.json'))]));
    const selected = (deps.selectWeeklyJobs ?? selectWeeklyJobs)(jobs, { readScript: name => scripts.get(name) });
    const selection = selected.byName.get(result.name), job = jobs.find(j => j.name === result.name), script = scripts.get(result.name);
    if (!selection || selection.status !== 'selected' || !job || selection.repair?.decision !== 'auto') throw new Error('finalized_automatic_scope_required');
    if (summary.uiSelection?.inputHash !== selected.inputHash || summary.uiSelection?.status !== 'finalized'
      || summary.uiSelection?.policy !== selected.policy || !same(summary.uiSelection?.names, selected.names)) throw new Error('finalized_batch_marker_conflict');
    const originalScriptPath = job.candidateInputs?.identifiedScript
      ?? (job.candidatePath ? join(dirname(job.candidatePath), 'identified-base.script.json') : null);
    if (!originalScriptPath) throw new Error('identified_script_input_required');
    const identified = read(originalScriptPath), stripped = structuredClone(identified);
    if (!Object.hasOwn(script, 'id')) delete stripped.id;
    stripped.steps.forEach((s, i) => { if (!Object.hasOwn(script.steps[i] ?? {}, 'id')) delete s.id; });
    if (!same(stripped, script)) throw new Error('identified_script_conflict');
    const semanticPlan = { name: job.name, steps: job.steps, scriptSteps: script.steps, identifiedScript: identified, slides: selection.slides,
      repair: selection.repair, prerequisites: { baseline: true, input: true, identity: true, provider: true } };
    const expected = routeAutomation(semanticPlan).scope.indices;
    if (!setEqual(result.changedIndices, expected)) throw new Error('local_result_scope_conflict');
    if (typeof result.verification !== 'string') throw new Error('verification_path_required');
    const outputDir = dirname(result.verification), controlDir = join(dirname(outputDir), 'control');
    const report = automaticQa({ outputDir, controlDir, baselineDir, originalScriptPath, semanticPlan }, deps);
    if (report.ok && (report.artifacts.candidate !== result.candidate || report.artifacts.sha256 !== result.sha256
      || report.artifacts.controlSha256 !== result.controlSha256)) throw new Error('local_result_artifact_conflict');
    return { ...report, name: result.name, preparationDir, baselineDir,
      ...(report.ok ? { pictureAndAudioInspection: 'not_required', humanInspectionPending: false } : {}) };
  } catch (e) {
    return { schema: 1, kind: 'automatic-output-qa', policy: AUTOMATIC_QA_POLICY, ok: false, status: 'qa_blocked', name: result?.name ?? null,
      reasons: [e.code || e.message], checks: { finalized_source_and_scope: false }, pictureAndAudioInspection: 'blocked', humanInspectionPending: false,
      performed: { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false }, publishingAuthorized: false };
  }
}

export function automaticQa({ outputDir, controlDir, baselineDir, originalScriptPath, semanticPlan } = {}, deps = {}) {
  const read = deps.readJson ?? readPyJson, sha = deps.hashFile ?? sha256File, check = deps.checkVerification ?? checkVerification;
  try {
    const checked = check(outputDir), controlChecked = check(controlDir), v = checked.v;
    const manifestPath = join(baselineDir, 'baseline-manifest.json'), bm = read(manifestPath), bv = read(join(baselineDir, 'verification.json'));
    const baselineVerified = bv.ok === true && bv.source_unchanged === true && bv.manifest_sha256 === sha(manifestPath) && bv.final_sha256 === bm.final?.sha256;
    const originalAssemblyPath = join(baselineDir, bm.assembly.file), changeManifestPath = join(outputDir, 'inputs/change-manifest.json');
    const before = v.source_snapshot?.before;
    const sourceSnapshotUnchanged = obj(before) && Object.keys(before).length > 0 && Object.entries(before).every(([p, s]) => sha(p) === s.sha256);
    const changes = read(changeManifestPath);
    const semanticAssetsVerified = (semanticPlan?.steps ?? []).filter(s => semanticPlan.slides?.some(x => x.index === s.index)
      || semanticPlan.repair?.extended?.includes(s.index)).every(s => s.semanticRepair
        && sha(s.evidence.recorded) === s.semanticRepair.binding.imageSha256s.recorded
        && sha(s.evidence.today) === s.semanticRepair.binding.imageSha256s.current
        && (!s.semanticRepair.binding.source.capture.path || s.semanticRepair.binding.source.capture.path === join(dirname(s.evidence.today), 'run.json'))
        && sha(join(dirname(s.evidence.today), 'run.json')) === s.semanticRepair.binding.source.capture.sha256)
      && changes.changes.every(c => sha(c.screenshot.path) === c.screenshot.sha256);
    return assessAutomaticQa({ checked, controlChecked, baselineManifest: bm, originalScript: read(originalScriptPath), candidateScript: read(v.candidate_script),
      originalAssembly: read(originalAssemblyPath), candidateAssembly: read(v.candidate_assembly), changeManifest: changes, semanticPlan,
      readback: { candidateSha256: sha(checked.candidate), controlSha256: sha(controlChecked.candidate), baselineSha256: sha(join(baselineDir, bm.final.file)),
        verificationSha256: sha(checked.file), baselineManifestSha256: sha(manifestPath), originalScriptPath, originalScriptSha256: sha(originalScriptPath),
        originalAssemblyPath, originalAssemblySha256: sha(originalAssemblyPath), changeManifestPath, changeManifestSha256: sha(changeManifestPath),
        sourceSnapshotUnchanged, semanticAssetsVerified, baselineVerified } });
  } catch (e) {
    return { schema: 1, kind: 'automatic-output-qa', policy: AUTOMATIC_QA_POLICY, ok: false, status: 'qa_blocked',
      reasons: [e.code || e.message || 'qa_input_missing'], checks: { read_and_hash_validation: false }, humanInspectionPending: false,
      pictureAndAudioInspection: 'blocked', performed: { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false },
      publishingAuthorized: false };
  }
}
