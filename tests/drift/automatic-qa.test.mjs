// In-memory renderer-report assertions only; no media/model/browser/network execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tools/drift/contracts.mjs';
import { repairReviewBinding } from '../../tools/drift/semantic-repair.mjs';
import { semanticStepDigest } from '../../tools/drift/semantic-repair-proof.mjs';
import { automaticQa, assessAutomaticQa, certifyAutomaticRepair } from '../../tools/drift/automatic-qa.mjs';
const H = c => c.repeat(64);
function example() {
  const base = { id: 'script', name: 'Arbitrary-Video', recording: { id: 'recording' }, fx: true, voice: 'saved-voice',
    steps: [0, 1, 2].map(index => ({ index, id: `s${index}`, action: 'navigate', capture: true, media: { pre: `old${index}.png` }, narration: 'Open Directory.', caption: 'Open Directory.' })) };
  const steps = base.steps.map((s, index) => ({ index, verdict: index ? 'unchanged' : 'full_rerecord', reasons: index ? [] : [{ code: 'page_redesigned' }],
    evidence: { recorded: `/capture/old${index}.png`, today: `/capture/new${index}.png` } }));
  const selection = [{ index: 0, changes: [{ kind: 'moved', before: 'Directory', after: 'Directory' }] }];
  const binding = repairReviewBinding({ videoName: base.name, stepIndex: 0, scriptStep: base.steps[0], selectedVerifiedChanges: selection.flatMap(s => s.changes),
    source: { job: { stepDigest: semanticStepDigest(steps[0]), recordedPath: steps[0].evidence.recorded, currentPath: steps[0].evidence.today },
      capture: { path: '/capture/run.json', sha256: H('c') } }, imageSha256s: { recorded: H('a'), current: H('b') },
    captureContext: { pageState: 'loaded', taskContext: 'verified', recordSpecificAction: false } });
  const claim = { reason: 'Directory action still has the same outcome.', evidence: 'Directory is visible above the same list.', recordsIndependent: true };
  const review = { schema: 'semantic-repair-review-v1', bindingDigest: binding.digest,
    workflow: { ...claim, status: 'equivalent' }, narration: { ...claim, status: 'accurate', suggestedNarration: null, preservesIntent: true, intentEvidence: 'The original directory task is preserved.' },
    target: { ...claim, status: 'not_applicable', currentLabel: null }, linkedInterface: { ...claim, status: 'affected' } };
  const verified = { verified: true, reason: 'Independently checked Directory.', evidence: 'Current Directory supports the same task.' };
  steps[0].semanticRepair = { binding, review, metadata: { provider: 'test', model: 'test', reviewId: 'author' }, verification: {
    bindingDigest: binding.digest, reviewDigest: digest(review), currentImageSha256: H('b'), verifier: { kind: 'model', id: 'second', provider: 'test', model: 'test', reviewId: 'verifier' },
    workflow: { ...verified }, narration: { ...verified, text: base.steps[0].narration, preservesIntent: true, intentEvidence: 'Same original directory instruction.' },
    target: { ...verified, currentLabel: null }, linkedInterface: { ...verified } } };
  const semanticPlan = { name: base.name, steps, scriptSteps: base.steps, slides: selection,
    repair: { decision: 'auto', blockers: [], extended: [], actions: [{ index: 0, action: 'replace_screenshot' }] },
    prerequisites: { baseline: true, input: true, identity: true, provider: true } };
  const candidate = structuredClone(base); candidate.recording.id = 'drift-candidate';
  candidate.steps[0].media.pre = `step_${H('b')}.png`; candidate.steps[0].captureId = H('b');
  const assembly = { fx: true, duration: 40 / 30, content_offset: 0,
    slides: base.steps.map((s, i) => ({ slide: i + 1, step: i, src: s.media.pre, narration: s.narration, caption: s.caption, _cap_text: s.caption,
      target: null, audio: `/takes/${i}.mp3`, audio_filter: '', adur: 0.2, sdur: 0.3333333333333333, start: i / 3, _cam: [1], _fx: { off: 0 }, _cap_edges: [false, false], _cap_top: false })) };
  const next = structuredClone(assembly); next.slides[0].src = candidate.steps[0].media.pre;
  const cells = [['lead-card', 0, 5, 'card:lead'], ['hold-01', 5, 15, 'slide-01'], ['hold-02', 15, 25, 'slide-02'],
    ['hold-03', 25, 35, 'slide-03'], ['tail-card', 35, 40, 'card:tail']].map(([id, startFrame, endFrame, dep]) => ({ id, startFrame, endFrame, dependsOn: [dep], sha256: H('e') }));
  const bm = { frameCount: 40, final: { file: 'baseline.mp4', sha256: H('d') }, assembly: { file: 'baseline-assembly.json', sha256: H('1') },
    audio: { packets: 60, pcm_sha256: H('2') }, cells };
  const cm = { baselineManifestHash: H('3'), changes: [{ stepId: 's0', screenshot: { path: '/capture/new0.png', sha256: H('b') } }] };
  const mapped = cells.map(c => ({ id: c.id, kind: c.id.includes('card') ? 'bookend' : 'hold', dependsOn: c.dependsOn,
    base: [c.startFrame, c.endFrame], new: [c.startFrame, c.endFrame], action: c.id === 'hold-01' ? 'render' : 'reuse' }));
  const reused = mapped.filter(c => c.action === 'reuse'), rendered = mapped.filter(c => c.action === 'render');
  const source = { '/source.script.json': { sha256: H('0'), size: 100, mtime_ns: 100 }, '/baseline/baseline-assembly.json': { sha256: H('1'), size: 100, mtime_ns: 100 },
    '/render/inputs/change-manifest.json': { sha256: H('4'), size: 100, mtime_ns: 100 } };
  const v = { ok: true, candidate: '/render/candidate.mp4', candidate_sha256: H('5'), baseline_sha256: H('d'), candidate_script: '/render/candidate-final.script.json',
    candidate_assembly: '/render/candidate-assembly.json', source_unchanged: true, source_snapshot: { files: 3, before: source, after: structuredClone(source) },
    candidate_capture_manifest: { candidateHash: digest(candidate), identifiedBaseHash: digest(base), recordingId: candidate.recording.id, changedStepIds: ['s0'] },
    takes: {}, elevenlabs_characters: 0, audio: null,
    plan: { changed_steps: { s0: 'slide-01' }, dirty_slides: ['slide-01'], frames: { base: 40, new: 40 }, shift_frames: 0,
      sdurs: { base: assembly.slides.map(s => s.sdur), new: assembly.slides.map(s => s.sdur) }, starts: { base: assembly.slides.map(s => s.start), new: assembly.slides.map(s => s.start) },
      replan_golden: { equal: true, slides: 3 }, planner_fingerprint: H('f'), cell_map: mapped,
      rendered_cells: rendered.map(c => c.id), reused_cells: reused.map(c => c.id), protected_views: { ok: true, mismatch_count: 0, frames_checked: 20 } },
    golden: { replan: { equal: true, slides: 3 }, chain: { mode: 'video_only', decoded_frames_equal: true, frames: 40, equal_frames: 40,
      offsets_equal: true, offsets: { lead: 0, support: 0.7, outro: 1.2 }, stored_offsets: { lead: 0, support: 0.7, outro: 1.2 }, stage_frames: { content: 20, lead: 25, support: 35, outro: 40 } }, control_cells_byte_identical_to_rebaseline: { 'hold-01': true } },
    checks: { frames_total: 40, expected_frames: 40, decodable: true, timestamps_contiguous: true, keyframes_at_cell_starts: true, cells_accounted: true,
      chain_offsets: { lead: 0, support: 0.7, outro: 1.2 }, chain_stage_frames: { content: 20, lead: 25, support: 35, outro: 40 },
      reused_cells_byte_identical: true, reused_frames_equal_at_shifted_positions: true,
      reused_cells: Object.fromEntries(reused.map(c => [c.id, { base: c.base, new: c.new, byte_identical: true, shift_frames: 0, sha256: H('e') }])),
      rendered_cells: { 'hold-01': { base: [5, 15], new: [5, 15], sha256: H('6') } },
      preservation: { protected_frames_equal: true, protected_frame_count: 30, complete_audio_equal: true, audio_packets_and_timing_equal: true, audio_packet_count: 60,
        baseline_sha256: H('d'), candidate_sha256: H('5'), artifact: '/render/candidate.mp4', reused_cells: reused.map(c => c.id), dirty_frames: [[5, 15]] },
      dirty_frames: [[5, 15]], changed_frames_inside_dirty: true, frames_changed: 10,
      captions: { other_captions_unchanged: true, slides: {}, changed_caption_pngs_match_new_text: true, changed_caption_bands_differ: true } } };
  const ctrl = { ok: true, candidate: '/control/candidate.mp4', candidate_sha256: H('d'), baseline_sha256: H('d'), source_unchanged: true };
  const objects = { '/baseline/verification.json': { ok: true, source_unchanged: true, manifest_sha256: H('3'), final_sha256: H('d') },
    '/baseline/baseline-manifest.json': bm, '/source.script.json': base, '/render/candidate-final.script.json': candidate,
    '/baseline/baseline-assembly.json': assembly, '/render/candidate-assembly.json': next, '/render/inputs/change-manifest.json': cm };
  const hashes = { '/baseline/baseline-manifest.json': H('3'), '/baseline/baseline-assembly.json': H('1'), '/render/inputs/change-manifest.json': H('4'),
    '/source.script.json': H('0'), '/render/candidate.mp4': H('5'), '/control/candidate.mp4': H('d'), '/baseline/baseline.mp4': H('d'),
    '/capture/old0.png': H('a'), '/capture/new0.png': H('b'), '/capture/run.json': H('c'), '/render/verification.json': H('7') };
  const calls = [];
  const deps = { readJson: path => { if (!(path in objects)) throw new Error('missing:' + path); return objects[path]; },
    hashFile: path => { if (!(path in hashes)) throw new Error('missing_hash:' + path); return hashes[path]; },
    checkVerification: path => { calls.push(path); const report = path === '/render' ? v : ctrl; return { v: report, file: path + '/verification.json', candidate: report.candidate, sha256: report.candidate_sha256 }; } };
  const args = { outputDir: '/render', controlDir: '/control', baselineDir: '/baseline', originalScriptPath: '/source.script.json', semanticPlan };
  return { args, deps, v, ctrl, bm, cm, base, candidate, assembly, next, semanticPlan, objects, hashes, calls };
}
const run = f => automaticQa(f.args, f.deps);

test('proven visual-only output is automatically certified with artifact metadata, no human pending or fake listening', () => {
  const f = example(), before = digest({ v: f.v, base: f.base, semantic: f.semanticPlan }), r = run(f);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.status, 'automatically_verified');
  assert.equal(r.humanInspectionPending, false); assert.equal(r.pictureAndAudioInspection, 'not_required');
  assert.deepEqual(r.performed, { nativeListening: false, transcription: false, visionReview: false, contactSheetReview: false });
  assert.equal(r.artifacts.sha256, H('5')); assert.equal(r.artifacts.verificationSha256, H('7'));
  assert.equal(r.publishingAuthorized, false); assert.deepEqual(f.calls, ['/render', '/control']);
  assert.equal(digest({ v: f.v, base: f.base, semantic: f.semanticPlan }), before);
});
test('recertification accepts only a byte-identical identified script at a new preparation path',()=>{
  const f=example();f.args.originalScriptPath='/new-preparation/identified-base.script.json';
  f.objects[f.args.originalScriptPath]=structuredClone(f.base);f.hashes[f.args.originalScriptPath]=H('0');
  assert.equal(run(f).ok,true);
  f.hashes[f.args.originalScriptPath]=H('9');assert.equal(run(f).ok,false);
});
test('the renderer snapshots the original change manifest, not its identical copied inputs file',()=>{
  const f=example();
  for(const state of ['before','after']){
    const snapshot=f.v.source_snapshot[state];snapshot['/source/repair.changes.json']=snapshot['/render/inputs/change-manifest.json'];delete snapshot['/render/inputs/change-manifest.json'];
  }
  f.hashes['/source/repair.changes.json']=H('4');
  assert.equal(run(f).ok,true,JSON.stringify(run(f)));
});
test('optional audio-filter/caption-cache fields may be absent on both unchanged assemblies, never on one side only',()=>{
  const f=example();delete f.assembly.slides[1].audio_filter;delete f.next.slides[1].audio_filter;
  delete f.assembly.slides[1]._cap_text;delete f.next.slides[1]._cap_text;
  assert.equal(run(f).ok,true,JSON.stringify(run(f)));
  f.next.slides[1].audio_filter='';assert.equal(run(f).ok,false);
});
for (const [label, mutate] of [
  ['mere ok true', f => { f.v = { ok: true }; f.deps.checkVerification = () => ({ v: f.v }); }],
  ['source assertion absent', f => { delete f.v.source_unchanged; }],
  ['source changed', f => { f.v.source_unchanged = false; }],
  ['source snapshot absent', f => { delete f.v.source_snapshot; }],
  ['snapshot incomplete', f => { f.v.source_snapshot.files++; }],
  ['snapshot differs', f => { f.v.source_snapshot.after['/source.script.json'].size++; }],
  ['fresh source hash changed', f => { f.hashes['/source.script.json'] = H('9'); }],
  ['verification hash missing', f => { delete f.hashes['/render/verification.json']; }],
  ['candidate hash differs', f => { f.hashes['/render/candidate.mp4'] = H('9'); }],
  ['baseline hash differs', f => { f.hashes['/baseline/baseline.mp4'] = H('9'); }],
  ['control hash differs', f => { f.hashes['/control/candidate.mp4'] = H('9'); }],
  ['dry run', f => { f.v.dry_run = true; }], ['noop', f => { f.v.noop = true; }],
  ['semantic proof missing', f => { delete f.semanticPlan.steps[0].semanticRepair; }],
  ['semantic verifier missing', f => { f.semanticPlan.steps[0].semanticRepair.verification = null; }],
  ['current image changed', f => { f.hashes['/capture/new0.png'] = H('9'); }],
  ['recorded image changed', f => { f.hashes['/capture/old0.png'] = H('9'); }],
  ['capture run changed', f => { f.hashes['/capture/run.json'] = H('9'); }],
  ['unreviewed screenshot', f => { f.cm.changes[0].screenshot.sha256 = H('9'); f.hashes['/capture/new0.png'] = H('9'); }],
  ['out of scope manifest', f => { f.cm.changes.push({ ...f.cm.changes[0], stepId: 's1' }); }],
  ['manifest omits change', f => { f.cm.changes = []; }],
  ['manifest duplicate', f => { f.cm.changes.push(f.cm.changes[0]); }],
  ['structural step insertion', f => { f.candidate.steps.push({ id: 'added' }); }],
  ['unapproved target semantics', f => { f.cm.changes[0].target = { name: 'Delete' }; }],
  ['narration manifest', f => { f.cm.changes[0].narration = { oldText: 'a', newText: 'b' }; }],
  ['narration script', f => { f.candidate.steps[0].narration = 'Changed task.'; }],
  ['caption script', f => { f.candidate.steps[0].caption = 'Changed caption.'; }],
  ['voice script', f => { f.candidate.voice = 'other'; }],
  ['audio take created', f => { f.v.takes = { 'slide-01': { path: 'new.mp3' } }; }],
  ['TTS charged', f => { f.v.elevenlabs_characters = 1; }],
  ['rebuilt audio', f => { f.v.audio = { ok: true }; }],
  ['candidate script manifest hash', f => { f.v.candidate_capture_manifest.candidateHash = H('9'); }],
  ['out of scope dirty slide', f => { f.v.plan.dirty_slides.push('slide-02'); }],
  ['extra changed step', f => { f.v.plan.changed_steps.s1 = 'slide-02'; }],
  ['assembly source image unbound', f => { f.next.slides[0].src = 'another.png'; }],
  ['assembly narration changed', f => { f.next.slides[0].narration = 'Other.'; }],
  ['assembly caption changed', f => { f.next.slides[0]._cap_text = 'Other.'; }],
  ['assembly take changed', f => { f.next.slides[0].audio = 'other.mp3'; }],
  ['assembly take missing', f => { delete f.next.slides[0].audio; }],
  ['assembly duration changed', f => { f.next.slides[0].sdur++; }],
  ['assembly start changed', f => { f.next.slides[0].start++; }],
  ['assembly audio filter changed', f => { f.next.slides[0].audio_filter = 'volume=0'; }],
  ['frame count changed', f => { f.v.plan.frames.new++; }],
  ['start plan changed', f => { f.v.plan.starts.new[0]++; }],
  ['timing shift', f => { f.v.plan.shift_frames = 1; }],
  ['golden planner missing', f => { delete f.v.golden.replan.equal; }],
  ['golden planner mismatched', f => { f.v.plan.replan_golden.equal = false; }],
  ['golden chain not decoded', f => { f.v.golden.chain.decoded_frames_equal = false; }],
  ['golden chain partial', f => { f.v.golden.chain.equal_frames--; }],
  ['chain offsets', f => { f.v.checks.chain_offsets.lead++; }],
  ['control cell wrong', f => { f.v.golden.control_cells_byte_identical_to_rebaseline['hold-01'] = false; }],
  ['control cell missing', f => { f.v.golden.control_cells_byte_identical_to_rebaseline = {}; }],
  ['control byte assertion absent', f => { delete f.ctrl.source_unchanged; }],
  ['truncated cell map', f => { f.v.plan.cell_map.pop(); }],
  ['duplicate cells', f => { f.v.plan.cell_map[1].id = f.v.plan.cell_map[0].id; }],
  ['cell gap', f => { f.v.plan.cell_map[1].new[0]++; }],
  ['unknown cell action', f => { f.v.plan.cell_map[0].action = 'skip'; }],
  ['partial decoded frames', f => { f.v.checks.frames_total--; }],
  ['timestamp gap', f => { f.v.checks.timestamps_contiguous = false; }],
  ['keyframe assertion absent', f => { delete f.v.checks.keyframes_at_cell_starts; }],
  ['protected camera assertion absent', f => { delete f.v.plan.protected_views; }],
  ['protected camera mismatch', f => { f.v.plan.protected_views.mismatch_count = 1; }],
  ['protected cell missing', f => { delete f.v.checks.reused_cells['hold-02']; }],
  ['protected cell different bytes', f => { f.v.checks.reused_cells['hold-02'].sha256 = H('9'); }],
  ['protected frame assertion false', f => { f.v.checks.reused_frames_equal_at_shifted_positions = false; }],
  ['protected frames count partial', f => { f.v.checks.preservation.protected_frame_count--; }],
  ['native protected equality missing', f => { delete f.v.checks.preservation.protected_frames_equal; }],
  ['preservation candidate binding stale', f => { f.v.checks.preservation.candidate_sha256 = H('9'); }],
  ['rendered cells not accounted', f => { f.v.checks.rendered_cells = {}; }],
  ['rendered cell lacks hash', f => { delete f.v.checks.rendered_cells['hold-01'].sha256; }],
  ['changed frames outside dirty', f => { f.v.checks.changed_frames_inside_dirty = false; }],
  ['dirty ranges untrusted', f => { f.v.checks.dirty_frames = [[0, 40]]; }],
  ['audio equality false', f => { f.v.checks.preservation.complete_audio_equal = false; }],
  ['audio equality absent', f => { delete f.v.checks.preservation.complete_audio_equal; }],
  ['packet timing mismatch', f => { f.v.checks.preservation.audio_packets_and_timing_equal = false; }],
  ['partial packet check', f => { f.v.checks.preservation.audio_packet_count--; }],
  ['PCM baseline hash missing', f => { delete f.bm.audio.pcm_sha256; }],
  ['caption assertion missing', f => { delete f.v.checks.captions.other_captions_unchanged; }],
  ['malformed dependencies', f => { f.v.plan.cell_map[0].dependsOn = null; }],
]) test(`blocks ${label} rather than requiring routine human inspection`, () => {
  const f = example(); mutate(f); const r = run(f); assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.status, 'qa_blocked'); assert.notEqual(r.pictureAndAudioInspection, 'pending');
});
test('executor checkVerification is required, not replaced by v.ok or cached candidate metadata', () => {
  const f = example(); f.deps.checkVerification = () => { throw Object.assign(new Error('candidate_hash_mismatch'), { code: 'candidate_hash_mismatch' }); };
  assert.deepEqual(run(f).reasons, ['candidate_hash_mismatch']);
});
test('missing or malformed top-level evidence fails closed in the pure evaluator', () => {
  for (const input of [undefined, {}, { checked: { v: { ok: true } } }, { checked: { v: true } }, { checked: null }]) {
    assert.equal(assessAutomaticQa(input).ok, false);
  }
});
test('no contact sheet is required or read for fully proven output', () => {
  const f = example(); f.v.contact_sheet = '/never-read.jpg'; assert.equal(run(f).ok, true);
});
test('a positive intent-preserving rewrite proposal cannot certify output that kept the old inaccurate narration', () => {
  const f = example(), p = f.semanticPlan.steps[0].semanticRepair;
  p.review.narration.status = 'rewrite'; p.review.narration.suggestedNarration = 'Open Directory now.';
  p.verification.narration.text = p.review.narration.suggestedNarration; p.verification.reviewDigest = digest(p.review);
  const r = run(f); assert.equal(r.ok, false); assert.ok(r.reasons.includes('semantic_original_narration_accurate'));
});
test('baseline verification is required and hash-bound, not inferred from candidate success', () => {
  for (const mutate of [f => { delete f.objects['/baseline/verification.json']; }, f => { f.objects['/baseline/verification.json'].source_unchanged = false; },
    f => { f.objects['/baseline/verification.json'].manifest_sha256 = H('9'); }]) {
    const f = example(); mutate(f); assert.equal(run(f).ok, false);
  }
});
function certificationInput() {
  const f = example(), name = f.base.name;
  const selection = { name, status: 'selected', slides: f.semanticPlan.slides, repair: f.semanticPlan.repair };
  const names = [name, 'Other-Video'], selected = { policy: 'selection-policy', inputHash: 'batch-hash', names, byName: new Map([[name, selection]]) };
  f.objects['/prep/summary.json'] = { names, uiSelection: { policy: selected.policy, inputHash: selected.inputHash, names, status: 'finalized' } };
  f.objects[`/prep/${name}/job.json`] = { name, steps: f.semanticPlan.steps, candidateInputs: { identifiedScript: '/source.script.json' } };
  f.objects['/prep/Other-Video/job.json'] = { name: 'Other-Video', steps: [] };
  f.objects[`/repo/scripts/${name}.script.json`] = f.base;
  f.objects['/repo/scripts/Other-Video.script.json'] = { name: 'Other-Video', steps: [] };
  let seen;
  f.deps.selectWeeklyJobs = jobs => { seen = jobs.map(j => j.name); return selected; };
  const result = { rendered: true, name, candidate: f.v.candidate, sha256: f.v.candidate_sha256, verification: '/render/verification.json', controlSha256: H('d'), changedIndices: [0] };
  const args = { result, repo: '/repo', preparationDir: '/prep', baselineDir: '/baseline' };
  return { f, args, selected, seen: () => seen };
}
test('parent certification accepts only identity migration, without rebinding the original semantic script', () => {
  const { f, args } = certificationInput();
  const original = structuredClone(f.base); delete original.id; original.steps.forEach(s => { delete s.id; });
  f.objects[`/repo/scripts/${f.base.name}.script.json`] = original;
  const p = f.semanticPlan.steps[0].semanticRepair, { schema, digest: old, ...input } = p.binding;
  input.scriptStep = original.steps[0]; p.binding = repairReviewBinding(input); p.review.bindingDigest = p.binding.digest;
  p.verification.bindingDigest = p.binding.digest; p.verification.reviewDigest = digest(p.review);
  const r = certifyAutomaticRepair(args, f.deps); assert.equal(r.ok, true, JSON.stringify(r));
});
test('parent certification adapter recomputes the full batch and certifies the exact result without writes', () => {
  const { f, args, seen } = certificationInput(), r = certifyAutomaticRepair(args, f.deps);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.pictureAndAudioInspection, 'not_required');
  assert.deepEqual(seen(), [f.base.name, 'Other-Video']); assert.equal(r.artifacts.sha256, args.result.sha256);
});
for (const [label, mutate] of [
  ['result hash conflict', (f, a) => { a.result.sha256 = H('9'); }],
  ['result candidate conflict', (f, a) => { a.result.candidate = '/other.mp4'; }],
  ['result scope conflict', (f, a) => { a.result.changedIndices = [0, 1]; }],
  ['result control conflict', (f, a) => { a.result.controlSha256 = H('9'); }],
  ['missing finalized marker', f => { delete f.objects['/prep/summary.json'].uiSelection; }],
  ['changed full batch', f => { f.objects['/prep/summary.json'].uiSelection.inputHash = 'stale'; }],
  ['changed original source', f => { f.objects[`/repo/scripts/${f.base.name}.script.json`] = { ...f.base, voice: 'different' }; }],
  ['unrendered preflight', (f, a) => { a.result.rendered = false; }],
]) test(`parent certification refuses ${label}`, () => {
  const { f, args } = certificationInput(); mutate(f, args); assert.equal(certifyAutomaticRepair(args, f.deps).ok, false);
});
