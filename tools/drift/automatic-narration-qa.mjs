// Read-only certification of renderer.drift_update narration/combined output. No media execution.
// Reports are local evidence, not authenticated attestations. Missing/unsupported proof is a QA hold.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { digest, applyVisualPatch } from './contracts.mjs';
import { checkVerification, readPyJson } from './executor.mjs';
import { sha256File } from './publish.mjs';
import { selectWeeklyJobs } from './ui-selection.mjs';
import { assessRepair } from './repairability.mjs';
import { semanticRepairCheck } from './semantic-repair-proof.mjs';
import { verifySemanticRepairAssets } from './semantic-repair-assets.mjs';

export const AUTOMATIC_NARRATION_QA_POLICY = 'automatic-narration-qa-v1';
// JS ports below are valid ONLY for these complete source bytes. Changes require explicit review.
const PINS = { 'tts.py': '4e9874f7f9c77637ad460be825ffd820e5b612e9f5794fb9b2279ce6354cabc7',
  'assemble.py': '53c47b764204a3de78101efc320c14140159b71a042a99d302ab5da5bd945c6e' };
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a, b) => { try { return digest(a) === digest(b); } catch { return false; } };
const set = (a, b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length
  && new Set(b).size === b.length && same([...a].sort(), [...b].sort());
const omit = (v, ks) => Object.fromEntries(Object.entries(v).filter(([k]) => !ks.includes(k)));
const sid = s => `slide-${String(s.slide).padStart(2, '0')}`;
const round = (n, d = 3) => Number(n.toFixed(d));
const frame = n => Math.ceil(round(n) * 30 - 1e-6);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const pos = n => Number.isSafeInteger(n) && n > 0;
const tokens = s => String(s).toLowerCase().replaceAll("'", '').match(/[a-z0-9]+/g) ?? [];
function normalize(text) {
  return text.replace(/\s*—\s*/gu, ', ').replace(/\s+[–-]\s+/gu, ', ')
    .replace(/,\s*([,.;:!?])/gu, '$1').replace(/^\s*,\s*|,\s*$/gu, '')
    .replace(/\bHadrius\b/g, 'Heydrius').replace(/(\b[\p{L}\p{N}_]+\s+)(lives\b)/giu, (all, prefix, word) =>
      /\b(their|our|your|my|his|her|its|personal|private|daily|saving|save|saved|lost|human|nine)\s*$/i.test(prefix)
        ? all : prefix + (word[0] === 'L' ? 'Livs' : 'livs'))
    .replace(/^lives\b/i, word => word[0] === 'L' ? 'Livs' : 'livs');
}
function cacheName(text, voice, model) {
  return `el-${createHash('sha256').update(`el\0${voice.slice(3)}|${model}\0${normalize(text.trim())}`).digest('hex').slice(0, 32)}.mp3`;
}
// fx_scope.timeline's integer cell boundaries; no frame samples are substituted for full checks.
function timeline(a, total) {
  const ss = a.slides, c0 = frame(a.content_offset), fs = ss.map(s => frame(s.start));
  const end = ss.map((s, i) => fs[i] + Math.round(s.sdur * 30));
  const duration = ss.reduce((n, s) => n + s.sdur, 0) - 0.8 * (ss.length - 1);
  const ce = c0 + Math.max(frame(duration), end.at(-1)), lead = a.content_offset > 0;
  const windows = [];
  if (lead) windows.push(['lead-dissolve', ['card:lead', sid(ss[0])], c0 - 1, c0 + 21]);
  for (let i = 1; i < ss.length; i++) windows.push([`dissolve-${String(ss[i - 1].slide).padStart(2, '0')}-${String(ss[i].slide).padStart(2, '0')}`,
    [sid(ss[i - 1]), sid(ss[i])], c0 + fs[i] - 1, c0 + Math.max(fs[i] + 24, end[i - 1]) + 1]);
  const xf = a.support_card ? 20 : a.outro ? 24 : null;
  if (xf !== null) windows.push(['tail-dissolve', [sid(ss.at(-1)), 'card:tail'], ce - xf - 1, ce + 1]);
  const cells = [], add = (id, kind, dependsOn, startFrame, endFrame) => cells.push({ id, kind, dependsOn, startFrame, endFrame });
  let cursor = 0;
  if (lead) { add('lead-card', 'bookend', ['card:lead'], 0, windows[0][2]); cursor = windows[0][2]; }
  const holds = lead ? windows : [null, ...windows];
  for (let i = 0; i < ss.length; i++) {
    const w = holds[i]; if (w) { add(w[0], 'dissolve', w[1], w[2], w[3]); cursor = w[3]; }
    const stop = holds[i + 1]?.[2] ?? (xf !== null ? ce + 1 : ce);
    add(`hold-${String(ss[i].slide).padStart(2, '0')}`, 'hold', [sid(ss[i])], cursor, stop); cursor = stop;
  }
  if (xf !== null) { const w = windows.at(-1); add(w[0], 'dissolve', w[1], w[2], w[3]); add('tail-card', 'bookend', ['card:tail'], w[3], total); }
  return cells;
}
function report(checks = {}, reasons = [], artifacts = {}) {
  return { schema: 1, kind: 'automatic-narration-output-qa', policy: AUTOMATIC_NARRATION_QA_POLICY,
    ok: reasons.length === 0, status: reasons.length ? 'qa_blocked' : 'automatically_verified', qaHold: reasons.length > 0,
    checks, reasons, artifacts, pictureAndAudioInspection: reasons.length ? 'blocked' : 'not_required', humanInspectionPending: false,
    performed: { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false },
    evidenceBasis: { semantic: 'Exact input-bound independent intent-preserving review, replayed repairability policy',
      video: 'Complete renderer mapped-cell/native-frame assertions and actual retained file hashes; not sampled visual inspection',
      audio: 'Baseline audio/chain golden, actual take bytes, correlation/offset/sync assertions; candidate AAC may differ',
      asr: 'Existing candidate-bound renderer report only; this certifier does not transcribe or listen' },
    baselineReencodeDisclosed: true, soundtrackRemixDisclosed: true, publishingAuthorized: false };
}

/** Low-level read-only adapter, also useful for replaying historical renderer evidence.
 * semanticPlan must contain the original (pre identity migration) scriptSteps and finalized slides.
 * ASR is accepted ONLY from the renderer real_pilot end-to-end.json shape (or the same shape
 * saved explicitly by a renderer caller). No synthesized transcript or user assertion is a substitute.
 * deps: readJson, hashFile, checkVerification, verifySemanticRepairAssets (trusted test I/O).
 */
export function automaticNarrationQa({ outputDir, controlDir, baselineDir, originalScriptPath, semanticPlan, repo,
  transcriptReportPath = join(dirname(outputDir ?? ''), 'end-to-end.json') } = {}, deps = {}) {
  const read = deps.readJson ?? readPyJson;
  const sha = deps.hashFile ?? (p => { if (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink()) throw new Error('regular_evidence_file_required'); return sha256File(p); });
  const checks = {}, reasons = [], artifacts = {};
  const gate = (key, yes) => { checks[key] = yes === true; if (!checks[key]) reasons.push(key); return checks[key]; };
  const need = (key, yes) => { if (!gate(key, yes)) throw new Error(key); };
  try {
    const checked = (deps.checkVerification ?? checkVerification)(outputDir), v = checked.v;
    const ctrl = (deps.checkVerification ?? checkVerification)(controlDir);
    artifacts.candidate = checked.candidate; artifacts.sha256 = checked.sha256; artifacts.verification = checked.file;
    artifacts.verificationSha256 = sha(checked.file); artifacts.controlSha256 = sha(ctrl.candidate);
    need('completed_hash_bound_render', v.ok === true && !v.dry_run && !v.noop && v.source_unchanged === true
      && checked.file === join(outputDir, 'verification.json') && checked.candidate === v.candidate
      && hash(v.candidate_sha256) && checked.sha256 === v.candidate_sha256 && sha(v.candidate) === checked.sha256);
    const mp = join(baselineDir, 'baseline-manifest.json'), bm = read(mp), bv = read(join(baselineDir, 'verification.json'));
    const ap = join(baselineDir, bm.assembly.file), assembly = read(ap), base = read(originalScriptPath);
    const next = read(v.candidate_assembly), candidate = read(v.candidate_script), cmp = join(outputDir, 'inputs/change-manifest.json'), cm = read(cmp);
    artifacts.baselineSha256 = bm.final.sha256; artifacts.baselineManifestSha256 = sha(mp);
    need('verified_baseline_and_original_image_control', bv.ok === true && bv.source_unchanged === true && bv.manifest_sha256 === sha(mp)
      && bv.final_sha256 === bm.final.sha256 && v.baseline_sha256 === bm.final.sha256 && sha(join(baselineDir, bm.final.file)) === bm.final.sha256
      && sha(ap) === bm.assembly.sha256 && ctrl.v.ok === true && !ctrl.v.noop && !ctrl.v.dry_run && ctrl.v.source_unchanged === true
      && ctrl.v.baseline_sha256 === bm.final.sha256 && ctrl.sha256 === bm.final.sha256 && artifacts.controlSha256 === bm.final.sha256);
    const before = v.source_snapshot?.before;
    need('complete_immutable_source_readback', obj(before) && same(before, v.source_snapshot.after) && v.source_snapshot.files === Object.keys(before).length
      && Object.keys(before).length > 0 && Object.entries(before).every(([p, x]) => hash(x.sha256) && finite(x.mtime_ns)
        && Number.isSafeInteger(x.size) && x.size >= 0 && !/(^|\/)\.env(?:\.|$)|credentials|secrets?\.(json|ya?ml)$/i.test(p) && sha(p) === x.sha256)
      && before[originalScriptPath]?.sha256 === sha(originalScriptPath) && before[ap]?.sha256 === sha(ap)
      && before[mp]?.sha256 === sha(mp) && Object.keys(before).some(p => p !== cmp && same(readableManifest(p), cm)));
    function readableManifest(p) { if (!/change[s-].*\.json$|change-manifest\.json$/.test(basename(p))) return null; try { return read(p); } catch { return null; } }
    need('supported_source_and_donor', Object.entries(PINS).every(([f, h]) => sha(join(repo, 'renderer', f)) === h && before[join(repo, 'renderer', f)]?.sha256 === h)
      && v.donor?.assemble_sha256 === PINS['assemble.py'] && hash(v.donor.drawer_fingerprint) && hash(v.plan?.planner_fingerprint)
      && ['basic', 'raqm'].includes(v.donor.font_layout) && v.plan.report_fields?.no_captions !== true);
    // Identity migration may add IDs, never change the reviewed original content.
    const semanticSteps = structuredClone(base.steps);
    semanticSteps.forEach((s, i) => { if (!Object.hasOwn(semanticPlan?.scriptSteps?.[i] ?? {}, 'id')) delete s.id; });
    need('original_semantic_script_bound', same(semanticSteps, semanticPlan?.scriptSteps)
      && base.steps.every((s, i) => s.index === i && typeof s.id === 'string' && s.id.length > 0)
      && new Set(base.steps.map(s => s.id)).size === base.steps.length);
    need('all_baseline_media_inputs_snapshotted', before[join(baselineDir, bm.final.file)]?.sha256 === bm.final.sha256
      && before[join(repo, bm.original.file)]?.sha256 === bm.original.sha256
      && bm.cells.every(cell => before[join(baselineDir, cell.file)]?.sha256 === cell.sha256)
      && base.steps.filter(s => s.capture !== false && s.media?.pre).every(s => Object.keys(before).some(p =>
        p.endsWith(`/_recordings/${base.recording.id}/${s.media.pre}`)))
      && cm.changes.filter(ch => ch.screenshot).every(ch => before[ch.screenshot.path]?.sha256 === ch.screenshot.sha256));
    const scope = semanticPlan?.repair?.actions?.map(a => a.index), ids = scope?.map(i => base.steps.find(s => s.index === i)?.id);
    const repair = assessRepair(semanticPlan ?? {});
    need('positive_replayed_repairability_v4', repair.policy === 'repairability-v4' && repair.decision === 'auto'
      && same(repair, semanticPlan?.repair) && set(scope, [...new Set(scope ?? [])]) && scope.length > 0 && set(ids, cm.changes.map(c => c.stepId))
      && cm.baselineManifestHash === sha(mp) && base.steps.length === candidate.steps.length);
    const rewrites = new Map();
    for (const index of scope) {
      const st = semanticPlan.steps.find(s => s.index === index), old = semanticPlan.scriptSteps.find(s => s.index === index);
      const proof = semanticRepairCheck(st, old, semanticPlan.slides.flatMap(s => s.changes), semanticPlan.name);
      need(`independent_semantic_step_${index}`, proof?.executionReady === true && proof.narrationReady === true && proof.workflowEquivalent === true
        && proof.targetReady === true && (deps.verifySemanticRepairAssets ?? verifySemanticRepairAssets)(st) === true);
      if (proof.review.narration.status === 'rewrite') rewrites.set(base.steps.find(s => s.index === index).id, proof.review.narration.suggestedNarration);
      else need(`retained_narration_accurate_${index}`, proof.review.narration.status === 'accurate');
    }
    need('nonempty_exact_rewrite_scope', rewrites.size > 0 && set(cm.changes.filter(c => Object.hasOwn(c, 'narration')).map(c => c.stepId), [...rewrites.keys()]));
    let expected = structuredClone(base);
    const visual = cm.changes.filter(c => c.screenshot || Object.hasOwn(c, 'target') || Object.hasOwn(c, 'dpr'));
    need('supported_manifest_fields', Object.keys(cm).every(k => ['baselineManifestHash', 'changes'].includes(k)) && cm.changes.every(c =>
      Object.keys(c).every(k => ['stepId', 'screenshot', 'target', 'dpr', 'narration'].includes(k))));
    if (visual.length) {
      // Automatic jobs replace real captured images. Target-only/geometry-only changes are unsupported here.
      need('semantically_bound_visual_assets', visual.every(c => {
        const st = semanticPlan.steps.find(s => base.steps.find(b => b.index === s.index)?.id === c.stepId);
        return obj(c.screenshot) && c.screenshot.path === st?.evidence.today && c.screenshot.sha256 === st?.semanticRepair.binding.imageSha256s.current
          && sha(c.screenshot.path) === c.screenshot.sha256;
      }));
      expected = applyVisualPatch(base, { baseHash: digest(base), structuralChanges: [], changes: visual.map(c => ({ stepId: c.stepId,
        beforeHash: digest(base.steps.find(s => s.id === c.stepId)) })) }, visual.map(c => ({ stepId: c.stepId, fields: {
        media: { ...base.steps.find(s => s.id === c.stepId).media, pre: `step_${c.screenshot.sha256}.png` }, captureId: c.screenshot.sha256,
        ...(Object.hasOwn(c, 'target') ? { target: c.target } : {}), ...(Object.hasOwn(c, 'dpr') ? { dpr: c.dpr } : {}) } })));
      expected.recording = { ...expected.recording, id: candidate.recording?.id };
      need('visual_candidate_manifest_bound', v.candidate_capture_manifest?.candidateHash === digest(expected)
        && v.candidate_capture_manifest.identifiedBaseHash === digest(base) && set(v.candidate_capture_manifest.changedStepIds, visual.map(c => c.stepId))
        && v.candidate_capture_manifest.recordingId === candidate.recording.id);
    } else need('narration_only_capture_unchanged', v.candidate_capture_manifest == null);
    for (const c of cm.changes.filter(c => c.narration)) {
      const old = base.steps.find(s => s.id === c.stepId), n = c.narration, text = rewrites.get(c.stepId);
      need(`exact_reviewed_rewrite_${old.index}`, obj(n) && Object.keys(n).every(k => ['oldText', 'newText', 'newCaption'].includes(k))
        && n.oldText === old.narration && n.newText === text && text !== old.narration && typeof text === 'string' && text.trim().length > 0
        && (old.caption == null || old.caption === '' || old.caption === old.narration) && (!Object.hasOwn(n, 'newCaption') || n.newCaption === text));
      const st = expected.steps.find(s => s.id === c.stepId); st.narration = text; st.caption = text;
    }
    need('exact_candidate_script', same(expected, candidate));
    const slides = assembly.slides, newer = next.slides, p = v.plan, c = v.checks, a = v.audio;
    need('complete_combined_renderer_shape', assembly.fx === true && assembly.intro === true && assembly.title_card === true
      && assembly.support_card === true && assembly.outro === true && Array.isArray(slides) && slides.length > 0
      && slides.every(s => typeof s.audio === 'string' && s.audio.length > 0) && newer?.length === slides.length
      && obj(p) && obj(c) && obj(a) && obj(v.takes) && obj(p.quantize));
    const captured = base.steps.filter(s => s.capture !== false && s.media?.pre), changed = {};
    need('exact_assembly_script_mapping', captured.length === slides.length && slides.every((s, i) => s.slide === i + 1 && s.step === captured[i].index
      && s.src === captured[i].media.pre && s.narration === captured[i].narration && s.caption === (captured[i].caption || captured[i].narration)
      && newer[i].step === s.step && newer[i].src === candidate.steps.find(st => st.id === captured[i].id)?.media.pre));
    const narrSlides = slides.filter((s, i) => rewrites.has(captured[i].id)).map(sid);
    need('exact_changed_steps_and_takes', set(Object.keys(v.takes), narrSlides) && set(Object.keys(p.quantize), narrSlides)
      && same(p.changed_steps, Object.fromEntries(slides.filter((s, i) => ids.includes(captured[i].id)).map(s => [captured[slides.indexOf(s)].id, sid(s)]))));
    const voice = base.voice, model = 'eleven_multilingual_v2', vc = v.voice_check;
    need('baseline_exact_elevenlabs_voice_model', /^el:[A-Za-z0-9]{20}$/.test(voice ?? '') && vc?.ok === true && vc.voice === voice
      && set(vc.models, [model]) && set(vc.slides?.map(x => x.slide), slides.filter(s => s.audio).map(s => s.slide))
      && vc.slides.every(x => x.model === model && x.take === basename(slides[x.slide - 1].audio)
        && x.take === cacheName(slides[x.slide - 1].narration, voice, model)));
    need('real_production_takes_no_fallback', narrSlides.every(id => {
      const t = v.takes[id], s = slides.find(s => sid(s) === id), text = rewrites.get(captured[slides.indexOf(s)].id);
      const provider = join(repo, 'out/_cache/tts', cacheName(text, voice, model));
      return t.provider === 'el' && t.voice === voice && t.voice_id === voice.slice(3) && t.model === model && t.text === text
        && t.normalized_text === normalize(text.trim()) && t.provider_path === provider && t.env?.NARRATION_VOICE === voice
        && t.command?.[1] === join(repo, 'renderer/tts.py') && t.command[2] === '<line>' && t.source === 'ElevenLabs via renderer/tts.py subprocess (production TTS path)'
        && typeof t.cached === 'boolean' && t.characters === (t.cached ? 0 : [...t.normalized_text].length) && hash(t.sha256)
        && sha(provider) === t.sha256 && sha(t.path) === t.sha256 && t.codec_name === 'mp3' && String(t.sample_rate) === '44100' && t.channels === 1
        && finite(t.adur) && t.adur > 0 && t.adur === t.duration && t.audio_filter === (s.audio_filter ?? '');
    }) && v.elevenlabs_characters === Object.values(v.takes).reduce((n, t) => n + t.characters, 0));
    let shift = 0, timingOk = true;
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i], n = newer[i], id = sid(s), q = p.quantize[id], t = v.takes[id];
      if (t) {
        const assemble = round(Math.max(1.9, t.adur + 1.9)), k = Math.ceil((assemble - s.sdur) * 30 - 1e-9);
        const pad = q.card_phase_padding_frames ?? 0;
        timingOk &&= Number.isSafeInteger(pad) && pad >= 0 && pad <= 5 && (id === narrSlides.at(-1) || pad === 0)
          && q.assemble_sdur === assemble && q.shift_frames === k + pad && q.sdur === round(s.sdur + (k + pad) / 30)
          && Math.abs(q.extra_pause_s - round(q.sdur - assemble, 6)) < 1e-6 && n.sdur === q.sdur;
        shift += q.shift_frames;
      } else timingOk &&= n.sdur === s.sdur;
      changed[id] = ids.includes(captured[i].id);
    }
    function starts(ss) { let time = 0; return ss.map(s => { const out = round(time); time += s.sdur - 0.8; return out; }); }
    gate('documented_quantized_timing_only', timingOk && same(p.sdurs, { base: slides.map(s => s.sdur), new: newer.map(s => s.sdur) })
      && same(p.starts, { base: starts(slides), new: starts(newer) }) && same(slides.map(s => s.start), starts(slides)) && same(newer.map(s => s.start), starts(newer))
      && p.shift_frames === shift && p.frames.base === bm.frameCount && p.frames.new === bm.frameCount + shift && pos(p.frames.new)
      && p.card_phase?.ok === true && p.card_phase.shift === shift && set(p.card_phase.boundaries?.map(x => x.boundary), ['content_end', 'support_start', 'outro_start'])
      && p.card_phase.boundaries.every(x => x.delta === shift) && next.duration === round(p.frames.new / 30, 2));
    const plannerFields = ['_cam', '_fx', '_cap_edges', '_cap_text', '_cap_top'];
    const dirty = slides.filter((s, i) => changed[sid(s)] || !same(omit(s, ['src', 'target', 'start', 'audio', 'adur', 'audio_filter']),
      omit(newer[i], ['src', 'target', 'start', 'audio', 'adur', 'audio_filter']))).map(sid);
    gate('exact_documented_dirty_scope', set(p.dirty_slides, dirty) && set(Object.keys(p.reasons ?? {}), dirty));
    gate('assembly_scope_and_untouched_text_audio', same(omit(assembly, ['slides', 'duration']), omit(next, ['slides', 'duration'])) && slides.every((s, i) => {
      const n = newer[i], st = candidate.steps.find(st => st.id === captured[i].id), t = v.takes[sid(s)];
      return n.narration === st.narration && n.caption === (st.caption || st.narration) && n._cap_text === n.caption.trim()
        && same(omit(s, [...plannerFields, 'start', 'sdur', ...(changed[sid(s)] ? ['src', 'target'] : []), ...(t ? ['audio', 'adur', 'audio_filter', 'narration', 'caption'] : [])]),
          omit(n, [...plannerFields, 'start', 'sdur', ...(changed[sid(s)] ? ['src', 'target'] : []), ...(t ? ['audio', 'adur', 'audio_filter', 'narration', 'caption'] : [])]))
        && (t ? n.audio === t.path && n.adur === t.adur && n.audio_filter === t.audio_filter : ['audio', 'adur', 'caption', 'narration', '_cap_text'].every(k => Object.hasOwn(s, k) && same(s[k], n[k]))
          && Object.hasOwn(s, 'audio_filter') === Object.hasOwn(n, 'audio_filter') && (s.audio_filter === n.audio_filter));
    }));
    const bt = timeline(assembly, bm.frameCount), nt = timeline(next, p.frames.new), cells = p.cell_map;
    let cursor = 0;
    need('complete_exact_cell_partition_and_mapping', Array.isArray(cells) && cells.length === bm.cells.length && cells.length === nt.length && bt.length === nt.length
      && set(cells.map(x => x.id), bm.cells.map(x => x.id)) && cells.every((x, i) => {
        const b = bm.cells[i], ns = nt[i];
        const yes = same(omit(b, ['file', 'sha256', 'size']), bt[i]) && x.id === b.id && x.kind === b.kind && same(x.dependsOn, b.dependsOn)
          && ns.id === b.id && same(ns.dependsOn, b.dependsOn) && same(x.base, [b.startFrame, b.endFrame]) && same(x.new, [ns.startFrame, ns.endFrame])
          && x.new[0] === cursor && pos(x.new[1]) && x.new[1] > cursor && x.action === (x.dependsOn.some(d => dirty.includes(d)) ? 'render' : 'reuse');
        cursor = x.new[1]; return yes;
      }) && cursor === p.frames.new);
    const rendered = cells.filter(x => x.action === 'render'), reused = cells.filter(x => x.action === 'reuse');
    gate('complete_native_frame_and_cell_assertions', c.frames_total === p.frames.new && c.expected_frames === p.frames.new && c.decodable === true
      && c.timestamps_contiguous === true && c.keyframes_at_cell_starts === true && c.cells_accounted === true
      && set(p.rendered_cells, rendered.map(x => x.id)) && set(p.reused_cells, reused.map(x => x.id))
      && set(Object.keys(c.reused_cells ?? {}), reused.map(x => x.id)) && set(Object.keys(c.rendered_cells ?? {}), rendered.map(x => x.id))
      && c.reused_cells_byte_identical === true && c.reused_frames_equal_at_shifted_positions === true
      && cells.every((x, i) => {
        const e = x.action === 'reuse' ? c.reused_cells[x.id] : c.rendered_cells[x.id];
        return same(e.base, x.base) && same(e.new, x.new) && hash(e.sha256)
          && sha(join(outputDir, x.action === 'reuse' ? 'spliced' : 'cells', `cell-${x.id}.mp4`)) === e.sha256
          && (x.action !== 'reuse' || e.byte_identical === true && e.sha256 === bm.cells[i].sha256
            && sha(join(baselineDir, bm.cells[i].file)) === e.sha256 && e.shift_frames === x.new[0] - x.base[0] && x.new[1] - x.new[0] === x.base[1] - x.base[0]);
      }));
    const c0 = frame(assembly.content_offset);
    const viewCount = reused.reduce((count, x) => count + x.dependsOn.reduce((n, id) => {
      const s = newer.find(s => sid(s) === id); if (!s) return n;
      return n + Math.max(0, Math.min(x.new[1], c0 + frame(s.start) + Math.round(s.sdur * 30)) - Math.max(x.new[0], c0 + frame(s.start)));
    }, 0), 0);
    gate('every_protected_camera_frame', p.protected_views?.ok === true && p.protected_views.mismatch_count === 0 && p.protected_views.frames_checked === viewCount);
    const chain = v.golden?.chain, ga = v.golden?.audio;
    gate('planner_and_audio_chain_golden', p.replan_golden?.equal === true && p.replan_golden.slides === slides.length && same(v.golden?.replan, p.replan_golden)
      && chain?.mode === 'with_audio' && chain.frames === bm.frameCount && chain.equal_frames === bm.frameCount && chain.decoded_frames_equal === true
      && chain.original_final === join(repo, bm.original.file) && sha(chain.original_final) === bm.original.sha256
      && chain.audio_packets_equal_original === true && chain.content_audio_packets_equal_real_content === true && chain.offsets_equal === true
      && same(chain.offsets, chain.stored_offsets) && set(Object.keys(chain.stage_frames ?? {}), ['content', 'lead', 'support', 'outro'])
      && Object.values(chain.stage_frames).every(pos) && chain.stage_frames.outro === bm.frameCount
      && same(c.chain_stage_frames, Object.fromEntries(Object.entries(chain.stage_frames).map(([k, n]) => [k, n + shift])))
      && set(Object.keys(c.chain_offsets ?? {}), ['lead', 'support', 'outro']) && Object.entries(chain.offsets).every(([k, n]) =>
        finite(n) && Math.abs(c.chain_offsets[k] - n - (k === 'lead' ? 0 : shift / 30)) <= 0.0011)
      && ga?.packets_equal === true && ga.schedule_starts_equal_assembly === true && ga.pcm?.identical === true
      && ga.pcm.samples_a === bm.audio.decoded_samples_per_channel && ga.pcm.samples_b === ga.pcm.samples_a
      && ga.pcm.max_abs_diff === 0 && ga.pcm.best_lag_samples === 0 && same(a.golden, ga));
    gate('all_original_image_control_cells', set(Object.keys(v.golden.control_cells_byte_identical_to_rebaseline ?? {}), rendered.map(x => x.id))
      && Object.values(v.golden.control_cells_byte_identical_to_rebaseline).every(x => x === true));
    gate('actual_donor_segments_hash_bound', set(Object.keys(v.donor.segments ?? {}), dirty.map(id => slides.find(s => sid(s) === id).file))
      && dirty.every(id => { const s = slides.find(s => sid(s) === id); return sha(join(outputDir, 'work/out/_build', `seg${String(s.slide).padStart(2, '0')}.mp4`)) === v.donor.segments[s.file]; }));
    const caps = c.captions;
    gate('exact_caption_png_and_band_assertions', caps?.other_captions_unchanged === true && caps.changed_caption_pngs_match_new_text === true
      && caps.changed_caption_bands_differ === true && set(Object.keys(caps.slides ?? {}), narrSlides) && narrSlides.every(id => {
        const s = newer.find(s => sid(s) === id), e = caps.slides[id];
        return e.caption === s.caption && e.png_matches_new_text === true && finite(e.caption_band_mean_diff_vs_baseline) && e.caption_band_mean_diff_vs_baseline > 2
          && sha(join(outputDir, 'caption-ref', `cap${String(s.slide).padStart(2, '0')}-ref.png`)) === sha(join(outputDir, 'work/out/_build', `cap${String(s.slide).padStart(2, '0')}.png`));
      }));
    need('complete_remixed_audio_evidence', a.ok === true && a.candidate_audio_stream_copied === true && a.chain_audio_equals_soundtrack === true
      && a.unchanged_takes_reused_byte_for_byte === true && a.takes_at_expected_offsets === true && a.av_sync_preserved === true
      && set(Object.keys(a.input_take_sha256 ?? {}), slides.map(sid)) && set(a.takes?.map(x => x.slide), slides.filter(s => s.audio).map(s => s.slide))
      && a.baseline.pcm_sha256 === bm.audio.pcm_sha256 && a.baseline.packet_count === bm.audio.packets
      && hash(a.candidate.pcm_sha256) && hash(a.candidate.packets_sha256) && pos(a.candidate.packet_count) && a.candidate.sample_rate === 48000);
    // voice_schedule uses the unrounded running time for integer-ms adelay, not the
    // displayed (rounded) slide start. Check every slot against ONE content origin.
    let audioTime = 0;
    const delays = newer.map((s, i) => { const d = Math.trunc((audioTime + (i ? 0.8 : 0.15)) * 1000); audioTime += s.sdur - 0.8; return d; });
    const origin = a.takes[0].expected_sample - delays[a.takes[0].slide - 1] * 48;
    const lags = a.takes.map(x => x.baseline_lag_samples).sort((x, y) => x - y), calibration = lags[Math.floor(lags.length / 2)];
    gate('every_take_actual_bytes_offsets_correlation_sync', Number.isSafeInteger(origin) && origin >= 0 && a.takes.every(x => {
      const s = slides[x.slide - 1], n = newer[x.slide - 1], id = sid(s), t = v.takes[id];
      const sourceHash = sha(s.audio), copy = join(outputDir, 'inputs/baseline-takes', `${id}-${basename(s.audio)}`);
      const lag = t ? x.calibration_lag_samples : x.baseline_lag_samples;
      return before[s.audio]?.sha256 === sourceHash && sha(copy) === sourceHash && sha(x.take) === x.take_sha256
        && x.take_sha256 === a.input_take_sha256[id] && x.take_sha256 === (t ? t.sha256 : sourceHash) && x.take === (t ? t.path : copy)
        && x.lag_ok === true && Number.isSafeInteger(x.baseline_lag_samples) && x.calibration_lag_samples === calibration
        && x.expected_sample === origin + delays[x.slide - 1] * 48
        && Number.isSafeInteger(x.lag_samples) && Number.isSafeInteger(lag) && Math.abs(x.lag_samples - lag) <= 2
        && finite(x.peak) && x.peak > 0.6 && x.peak <= 1 && finite(x.position_s) && finite(x.expected_s)
        && Number.isSafeInteger(x.expected_sample) && Number.isSafeInteger(x.position_sample) && x.position_sample - x.expected_sample === x.lag_samples
        && Math.abs(x.position_s - x.position_sample / 48000) < 0.000002 && Math.abs(x.expected_s - x.expected_sample / 48000) < 0.000002
        && Math.abs(x.video_slide_start_s - (c0 + frame(n.start)) / 30) < 0.000002
        && Math.abs(x.audio_minus_video_s - (x.position_s - x.video_slide_start_s)) < 0.000003
        && (t || finite(x.sync_delta_ms) && Math.abs(x.sync_delta_ms) <= 1.5
          && Math.abs(x.sync_delta_ms - (x.audio_minus_video_s - x.baseline_audio_minus_video_s) * 1000) <= 0.002);
    }));
    const tr = read(transcriptReportPath), transcript = tr.transcript;
    artifacts.transcriptReport = transcriptReportPath; artifacts.transcriptReportSha256 = sha(transcriptReportPath);
    gate('renderer_report_asr_on_exact_final_candidate', tr.ok === true && tr.candidate === v.candidate && tr.candidate_sha256 === v.candidate_sha256
      && tr.verification === checked.file && transcript?.ok === true && typeof transcript.model === 'string' && transcript.model.includes('whisper')
      && set(Object.keys(transcript.lines ?? {}), a.takes.map(x => `slide-${String(x.slide).padStart(2, '0')}`))
      && a.takes.every(x => { const id = sid(newer[x.slide - 1]), line = transcript.lines[id], s = newer[x.slide - 1];
        const window = [round(x.position_s - 0.3), round(x.position_s + s.adur + 0.6)];
        const got = tokens(line.heard), expected = tokens(s.narration), pool = [...got]; let hits = 0;
        for (const word of expected) { const i = pool.indexOf(word); if (i >= 0) { hits++; pool.splice(i, 1); } }
        return line.expected === s.narration && same(line.window_s, window) && finite(line.recall) && line.recall >= 0.8
          && line.recall === round(hits / Math.max(1, expected.length));
      }) && set(Object.keys(transcript.replaced_lines ?? {}), narrSlides.map(id => `OLD ${id}`)) && narrSlides.every(id => {
        const old = slides.find(s => sid(s) === id), e = transcript.replaced_lines[`OLD ${id}`];
        const current = new Set(newer.flatMap(s => tokens(s.narration))), distinguishing = [...new Set(tokens(old.narration))].filter(w => !current.has(w)).sort();
        return e.old === old.narration && same(e.distinguishing_words, distinguishing) && Array.isArray(e.distinguishing_words_heard)
          && e.distinguishing_words_heard.length === 0 && !distinguishing.some(w => tokens(transcript.text).includes(w));
      }));
  } catch (e) { if (!reasons.includes(e.code || e.message)) reasons.push(e.code || e.message || 'unsupported_or_absent_narration_evidence'); }
  return report(checks, reasons, artifacts);
}

/** Parent adapter: reselect the COMPLETE finalized batch and bind the exact local render result. */
export function certifyAutomaticNarrationRepair({ result, repo, preparationDir, baselineDir } = {}, deps = {}) {
  const read = deps.readJson ?? readPyJson;
  try {
    if (result?.rendered !== true || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result.name ?? '')) throw new Error('completed_named_local_render_required');
    const summary = read(join(preparationDir, 'summary.json'));
    if (!Array.isArray(summary.names) || !set(summary.names, [...new Set(summary.names)]) || !summary.names.includes(result.name)
      || summary.names.some(n => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))) throw new Error('complete_batch_names_required');
    const jobs = summary.names.map(n => read(join(preparationDir, n, 'job.json')));
    const scripts = new Map(summary.names.map(n => [n, read(join(repo, 'scripts', `${n}.script.json`))]));
    const selected = (deps.selectWeeklyJobs ?? selectWeeklyJobs)(jobs, { readScript: n => scripts.get(n) });
    const selection = selected.byName.get(result.name), job = jobs.find(j => j.name === result.name), original = scripts.get(result.name);
    if (selection?.status !== 'selected' || selection.repair?.decision !== 'auto' || summary.uiSelection?.status !== 'finalized'
      || summary.uiSelection.inputHash !== selected.inputHash || summary.uiSelection.policy !== selected.policy
      || !same(summary.uiSelection.names, selected.names)) throw new Error('finalized_automatic_batch_scope_required');
    const path = job.candidateInputs?.identifiedScript ?? (job.candidatePath ? join(dirname(job.candidatePath), 'identified-base.script.json') : null);
    if (!path) throw new Error('identified_script_input_required');
    const identified = read(path), stripped = structuredClone(identified);
    if (!Object.hasOwn(original, 'id')) delete stripped.id;
    stripped.steps.forEach((s, i) => { if (!Object.hasOwn(original.steps[i] ?? {}, 'id')) delete s.id; });
    if (!same(stripped, original)) throw new Error('identified_script_conflict');
    if (!set(result.changedIndices, selection.repair.actions.map(a => a.index)) || typeof result.verification !== 'string') throw new Error('local_result_scope_conflict');
    const out = dirname(result.verification), r = automaticNarrationQa({ repo, outputDir: out, controlDir: join(dirname(out), 'control'), baselineDir,
      originalScriptPath: path, semanticPlan: { name: job.name, steps: job.steps, scriptSteps: original.steps, slides: selection.slides, repair: selection.repair },
      ...(result.transcriptReport ? { transcriptReportPath: result.transcriptReport } : {}) }, deps);
    if (r.artifacts.candidate !== result.candidate || r.artifacts.sha256 !== result.sha256 || r.artifacts.controlSha256 !== result.controlSha256)
      return { ...report({ ...r.checks, local_result_artifact_bound: false }, [...r.reasons, 'local_result_artifact_conflict'], r.artifacts), name: result.name };
    return { ...r, name: result.name, preparationDir, baselineDir };
  } catch (e) { return { ...report({ finalized_source_and_scope: false }, [e.code || e.message]), name: result?.name ?? null }; }
}
