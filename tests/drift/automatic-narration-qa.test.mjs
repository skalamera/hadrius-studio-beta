// Explicitly SYNTHETIC renderer assertions with REAL FILE-BACKED loading/hashing.
// The tiny media files are not decodable: these tests test evidence validation, never claim a render.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest } from '../../tools/drift/contracts.mjs';
import { sha256File } from '../../tools/drift/publish.mjs';
import { readPyJson, checkVerification } from '../../tools/drift/executor.mjs';
import { repairReviewBinding } from '../../tools/drift/semantic-repair.mjs';
import { semanticStepDigest } from '../../tools/drift/semantic-repair-proof.mjs';
import { assessRepair } from '../../tools/drift/repairability.mjs';
import { automaticNarrationQa, certifyAutomaticNarrationRepair } from '../../tools/drift/automatic-narration-qa.mjs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = join(os.homedir(), '.hermes/cache/scratch');
const H = c => c.repeat(64);
const sid = i => `slide-${String(i + 1).padStart(2, '0')}`;
const cache = text => `el-${createHash('sha256').update(`el\0ZoiZ8fuDWInAcwPXaVeq|eleven_multilingual_v2\0${text}`).digest('hex').slice(0, 32)}.mp3`;
function fixture(t, { narrationOnly = false, omitFilters = false } = {}) {
  const root = fs.mkdtempSync(join(scratch, 'automatic-narration-qa-fixture-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), out = join(root, 'run/repair'), control = join(root, 'run/control'), baseline = join(root, 'baseline'), prep = join(root, 'prep');
  const write = (p, value) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
  for (const file of ['tts.py', 'assemble.py']) { const p = join(repo, 'renderer', file); fs.mkdirSync(dirname(p), { recursive: true }); fs.copyFileSync(join(REPO, 'renderer', file), p); }
  const name = 'Synthetic-Narration', oldText = 'Open the old Details panel.', newText = 'Open the project Details panel.';
  const base = { id: 'script', name, voice: 'el:ZoiZ8fuDWInAcwPXaVeq', fx: true, recording: { id: 'recording' }, steps: [0, 1, 2].map(index => ({
    index, id: `step-${index}`, action: 'navigate', capture: true, media: { pre: `old-${index}.png` },
    narration: ['Show Projects.', oldText, 'Copy the project ID.'][index], caption: ['Show Projects.', oldText, 'Copy the project ID.'][index] })) };
  const source = join(root, 'source/identified-base.script.json'); write(source, base); write(join(repo, 'scripts', name + '.script.json'), base);
  const steps = base.steps.map((s, index) => ({ index, verdict: index === 1 ? 'full_rerecord' : 'unchanged', reasons: index === 1 ? [{ code: 'page_redesigned' }] : [],
    evidence: { recorded: join(root, 'captures', `old-${index}.png`), today: join(root, 'captures', `new-${index}.png`) } }));
  steps.forEach((s, i) => { write(s.evidence.recorded, `synthetic old image ${i}`); write(s.evidence.today, `synthetic new image ${i}`); });
  write(join(root, 'captures/run.json'), { synthetic: true, pageState: 'loaded' });
  const slidesSelected = [{ index: 1, changes: [{ kind: 'moved', before: 'Details', after: 'Details' }] }];
  const st = steps[1], binding = repairReviewBinding({ videoName: name, stepIndex: 1, scriptStep: base.steps[1], selectedVerifiedChanges: slidesSelected.flatMap(s => s.changes),
    source: { job: { stepDigest: semanticStepDigest(st), recordedPath: st.evidence.recorded, currentPath: st.evidence.today },
      capture: { path: join(root, 'captures/run.json'), sha256: sha256File(join(root, 'captures/run.json')) } },
    imageSha256s: { recorded: sha256File(st.evidence.recorded), current: sha256File(st.evidence.today) },
    captureContext: { pageState: 'loaded', taskContext: 'verified', recordSpecificAction: false } });
  const claim = { reason: 'The same project Details action remains supported.', evidence: 'The Details panel remains visible for this project.', recordsIndependent: true };
  const review = { schema: 'semantic-repair-review-v1', bindingDigest: binding.digest, workflow: { ...claim, status: 'equivalent' },
    narration: { ...claim, status: 'rewrite', suggestedNarration: newText, preservesIntent: true, intentEvidence: 'Opening the same project Details remains the original instructional outcome.' },
    target: { ...claim, status: 'not_applicable', currentLabel: null }, linkedInterface: { ...claim, status: 'affected' } };
  const yes = { verified: true, reason: 'Independently checked the current Details panel.', evidence: 'Current project Details supports the same original instruction.' };
  st.semanticRepair = { binding, review, metadata: { provider: 'synthetic-test', model: 'fixture', reviewId: 'author' }, verification: {
    bindingDigest: binding.digest, reviewDigest: digest(review), currentImageSha256: binding.imageSha256s.current,
    verifier: { kind: 'model', id: 'second', provider: 'synthetic-test', model: 'fixture', reviewId: 'independent' }, workflow: { ...yes },
    narration: { ...yes, text: newText, preservesIntent: true, intentEvidence: 'The exact replacement preserves opening this project Details panel.' }, target: { ...yes, currentLabel: null }, linkedInterface: { ...yes } } };
  const semanticPlan = { name, steps, scriptSteps: base.steps, slides: slidesSelected };
  semanticPlan.repair = assessRepair(semanticPlan); assert.equal(semanticPlan.repair.decision, 'auto', JSON.stringify(semanticPlan.repair));
  const image = { path: st.evidence.today, sha256: sha256File(st.evidence.today) };
  const cm = { baselineManifestHash: '', changes: [{ stepId: 'step-1', ...(narrationOnly ? {} : { screenshot: image }), narration: { oldText, newText } }] };
  const candidate = structuredClone(base), visual = structuredClone(base);
  if (!narrationOnly) {
    candidate.recording.id = visual.recording.id = 'candidate';
    for (const script of [candidate, visual]) { script.steps[1].media.pre = `step_${image.sha256}.png`; script.steps[1].captureId = image.sha256; }
  }
  candidate.steps[1].narration = candidate.steps[1].caption = newText;
  const assembly = { fx: true, duration: 14, intro: true, title_card: true, support_card: true, outro: true, content_offset: 1,
    slides: base.steps.map((s, i) => ({ slide: i + 1, step: i, src: s.media.pre, file: `slide_${String(i + 1).padStart(2, '0')}.png`,
      narration: s.narration, caption: s.caption, _cap_text: s.caption, audio: join(repo, 'out/_cache/tts', cache(s.narration)), audio_filter: '', adur: 2.1,
      sdur: 4, start: Number((i * 3.2).toFixed(3)), _cam: [[1], [1], [1920, 1080]], _fx: { first: true, off: 0 }, _cap_top: false, _cap_edges: [true, false], target: null })) };
  if (omitFilters) assembly.slides.forEach(s => { delete s.audio_filter; });
  assembly.slides.forEach((s, i) => write(s.audio, `synthetic original audio ${i}`));
  const takePath = join(out, 'inputs/takes', `slide-02-${cache(newText)}`), provider = join(repo, 'out/_cache/tts', cache(newText));
  write(takePath, 'synthetic new ElevenLabs take'); write(provider, 'synthetic new ElevenLabs take');
  const next = structuredClone(assembly); next.duration = 14.5; next.slides[1].sdur = 4.5; next.slides[2].start = 6.9;
  Object.assign(next.slides[1], { src: candidate.steps[1].media.pre, narration: newText, caption: newText, _cap_text: newText, audio: takePath, adur: 2.6, audio_filter: '' });
  function partition(a, total) {
    const ss = a.slides, f = ss.map(s => Math.ceil(s.start * 30 - 1e-6)), c0 = 30;
    const ce = c0 + Math.ceil((ss.reduce((n, s) => n + s.sdur, 0) - 1.6) * 30 - 1e-6);
    const windows = [['lead-dissolve', ['card:lead', sid(0)], 29, 51], ...[1, 2].map(i => [`dissolve-0${i}-0${i + 1}`, [sid(i - 1), sid(i)],
      c0 + f[i] - 1, c0 + Math.max(f[i] + 24, f[i - 1] + Math.round(ss[i - 1].sdur * 30)) + 1]), ['tail-dissolve', [sid(2), 'card:tail'], ce - 21, ce + 1]];
    const rows = [['lead-card', 'bookend', ['card:lead'], 0, 29]];
    ss.forEach((s, i) => { const w = windows[i]; rows.push([w[0], 'dissolve', w[1], w[2], w[3]], [`hold-0${i + 1}`, 'hold', [sid(i)], w[3], windows[i + 1][2]]); });
    const w = windows.at(-1); rows.push([w[0], 'dissolve', w[1], w[2], w[3]], ['tail-card', 'bookend', ['card:tail'], w[3], total]);
    return rows.map(([id, kind, dependsOn, startFrame, endFrame]) => ({ id, kind, dependsOn, startFrame, endFrame }));
  }
  const cells = partition(assembly, 420).map(c => ({ ...c, file: `cell-${c.id}.mp4`, sha256: sha256File(write(join(baseline, `cell-${c.id}.mp4`), 'synthetic baseline cell ' + c.id)) }));
  const bm = { frameCount: 420, original: { file: 'out/original.mp4', sha256: sha256File(write(join(repo, 'out/original.mp4'), 'synthetic original final')) },
    final: { file: 'baseline.mp4', sha256: sha256File(write(join(baseline, 'baseline.mp4'), 'synthetic rebuilt baseline')) },
    assembly: { file: 'baseline-assembly.json', sha256: sha256File(write(join(baseline, 'baseline-assembly.json'), assembly)) },
    audio: { pcm_sha256: H('a'), packets: 660, decoded_samples_per_channel: 672000 }, cells };
  const mp = write(join(baseline, 'baseline-manifest.json'), bm);
  cm.baselineManifestHash = sha256File(mp);
  const manifestPath = write(join(root, 'run/repair.changes.json'), cm); write(join(out, 'inputs/change-manifest.json'), cm);
  write(join(baseline, 'verification.json'), { ok: true, source_unchanged: true, manifest_sha256: sha256File(mp), final_sha256: bm.final.sha256 });
  const mapping = partition(next, 435).map((c, i) => ({ id: c.id, kind: c.kind, dependsOn: c.dependsOn, base: [cells[i].startFrame, cells[i].endFrame],
    new: [c.startFrame, c.endFrame], action: c.dependsOn.includes('slide-02') ? 'render' : 'reuse' }));
  const reused = mapping.filter(c => c.action === 'reuse'), rendered = mapping.filter(c => c.action === 'render');
  const reusedRows = Object.fromEntries(reused.map(c => { const b = cells.find(b => b.id === c.id); write(join(out, 'spliced', b.file), fs.readFileSync(join(baseline, b.file), 'utf8'));
    return [c.id, { base: c.base, new: c.new, shift_frames: c.new[0] - c.base[0], sha256: b.sha256, byte_identical: true }]; }));
  const renderedRows = Object.fromEntries(rendered.map(c => [c.id, { base: c.base, new: c.new, sha256: sha256File(write(join(out, 'cells', `cell-${c.id}.mp4`), 'synthetic rendered cell ' + c.id)) }]));
  const takes = assembly.slides.map((s, i) => {
    const id = sid(i), copy = join(out, 'inputs/baseline-takes', `${id}-${basename(s.audio)}`); write(copy, fs.readFileSync(s.audio, 'utf8'));
    const take = i === 1 ? takePath : copy, video = (30 + Math.ceil(next.slides[i].start * 30 - 1e-6)) / 30;
    const sample = Math.round((next.slides[i].start + (i ? 0.8 : 0.15)) * 1000) * 48 + 48000, position = sample - 785;
    return { slide: i + 1, take, take_sha256: sha256File(take), expected_sample: sample, expected_s: Number((sample / 48000).toFixed(6)),
      position_sample: position, position_s: Number((position / 48000).toFixed(6)), lag_samples: -785, baseline_lag_samples: -785, calibration_lag_samples: -785,
      lag_ok: true, peak: 0.96, video_slide_start_s: Number(video.toFixed(6)), audio_minus_video_s: Number((position / 48000 - video).toFixed(6)),
      baseline_audio_minus_video_s: Number((position / 48000 - video).toFixed(6)), ...(i === 1 ? {} : { sync_delta_ms: 0 }) };
  });
  const ga = { packets_equal: true, schedule_starts_equal_assembly: true, pcm: { identical: true, samples_a: 672000, samples_b: 672000, max_abs_diff: 0, best_lag_samples: 0 } };
  const snapshotPaths = [source, mp, join(baseline, bm.assembly.file), manifestPath, ...assembly.slides.map(s => s.audio), join(repo, 'renderer/assemble.py'), join(repo, 'renderer/tts.py')];
    const before = Object.fromEntries([...snapshotPaths, join(baseline, bm.final.file), join(repo, bm.original.file), ...cells.map(c => join(baseline, c.file)),
      ...base.steps.map(s => write(join(root, 'source/_recordings', base.recording.id, s.media.pre), `synthetic original capture ${s.index}`)),
      ...(narrationOnly ? [] : [image.path])].map(p => [p, { sha256: sha256File(p), size: fs.statSync(p).size, mtime_ns: fs.statSync(p).mtimeMs * 1e6 }]));
  const candidatePath = write(join(out, 'candidate.mp4'), 'synthetic rendered candidate with remixed AAC');
  const v = { ok: true, output: out, candidate: candidatePath, candidate_sha256: sha256File(candidatePath), baseline_sha256: bm.final.sha256,
    candidate_assembly: write(join(out, 'candidate-assembly.json'), next), candidate_script: write(join(out, 'candidate-final.script.json'), candidate),
    candidate_capture_manifest: narrationOnly ? null : { candidateHash: digest(visual), identifiedBaseHash: digest(base), recordingId: candidate.recording.id, changedStepIds: ['step-1'] },
    source_unchanged: true, source_snapshot: { files: Object.keys(before).length, before, after: structuredClone(before) },
    voice_check: { ok: true, voice: base.voice, models: ['eleven_multilingual_v2'], slides: assembly.slides.map(s => ({ slide: s.slide, take: basename(s.audio), model: 'eleven_multilingual_v2' })) },
    takes: { 'slide-02': { path: takePath, sha256: sha256File(takePath), provider: 'el', voice: base.voice, voice_id: base.voice.slice(3), model: 'eleven_multilingual_v2', text: newText,
      normalized_text: newText, provider_path: provider, env: { NARRATION_VOICE: base.voice }, command: ['python', join(repo, 'renderer/tts.py'), '<line>'],
      source: 'ElevenLabs via renderer/tts.py subprocess (production TTS path)', cached: true, characters: 0, codec_name: 'mp3', sample_rate: '44100', channels: 1, adur: 2.6, duration: 2.6, audio_filter: '' } },
    elevenlabs_characters: 0,
    plan: { changed_steps: { 'step-1': 'slide-02' }, dirty_slides: ['slide-02'], reasons: { 'slide-02': ['changed_step', 'narration'] }, report_fields: {}, planner_fingerprint: H('1'),
      quantize: { 'slide-02': { assemble_sdur: 4.5, sdur: 4.5, shift_frames: 15, extra_pause_s: 0, card_phase_padding_frames: 0 } }, shift_frames: 15,
      frames: { base: 420, new: 435 }, sdurs: { base: assembly.slides.map(s => s.sdur), new: next.slides.map(s => s.sdur) }, starts: { base: assembly.slides.map(s => s.start), new: next.slides.map(s => s.start) },
      card_phase: { ok: true, shift: 15, boundaries: ['content_end', 'support_start', 'outro_start'].map(boundary => ({ boundary, delta: 15 })) },
      replan_golden: { equal: true, slides: 3 }, cell_map: mapping, reused_cells: reused.map(c => c.id), rendered_cells: rendered.map(c => c.id),
      protected_views: { ok: true, mismatch_count: 0, frames_checked: reused.reduce((n, c) => n + c.dependsOn.reduce((n, id) => { const s = next.slides.find((s, i) => sid(i) === id); if (!s) return n;
        const start = 30 + Math.ceil(s.start * 30 - 1e-6); return n + Math.max(0, Math.min(c.new[1], start + Math.round(s.sdur * 30)) - Math.max(c.new[0], start)); }, 0), 0) } },
    golden: { replan: { equal: true, slides: 3 }, audio: ga, chain: { mode: 'with_audio', frames: 420, equal_frames: 420, decoded_frames_equal: true,
      original_final: join(repo, bm.original.file), audio_packets_equal_original: true, content_audio_packets_equal_real_content: true, offsets_equal: true,
      offsets: { lead: 1, support: 10, outro: 12 }, stored_offsets: { lead: 1, support: 10, outro: 12 }, stage_frames: { content: 312, lead: 350, support: 390, outro: 420 } },
      control_cells_byte_identical_to_rebaseline: Object.fromEntries(rendered.map(c => [c.id, true])) },
    donor: { assemble_sha256: sha256File(join(repo, 'renderer/assemble.py')), drawer_fingerprint: H('2'), font_layout: 'basic',
      segments: { 'slide_02.png': sha256File(write(join(out, 'work/out/_build/seg02.mp4'), 'synthetic donor segment')) } },
    checks: { frames_total: 435, expected_frames: 435, decodable: true, timestamps_contiguous: true, keyframes_at_cell_starts: true, cells_accounted: true,
      reused_cells_byte_identical: true, reused_frames_equal_at_shifted_positions: true, reused_cells: reusedRows, rendered_cells: renderedRows,
      chain_stage_frames: { content: 327, lead: 365, support: 405, outro: 435 }, chain_offsets: { lead: 1, support: 10.5, outro: 12.5 },
      captions: { other_captions_unchanged: true, changed_caption_pngs_match_new_text: true, changed_caption_bands_differ: true,
        slides: { 'slide-02': { caption: newText, png_matches_new_text: true, caption_band_mean_diff_vs_baseline: 7 } } } },
    audio: { ok: true, golden: ga, candidate_audio_stream_copied: true, chain_audio_equals_soundtrack: true, unchanged_takes_reused_byte_for_byte: true,
      takes_at_expected_offsets: true, av_sync_preserved: true, input_take_sha256: Object.fromEntries(takes.map((x, i) => [sid(i), x.take_sha256])), takes,
      baseline: { pcm_sha256: H('a'), packet_count: 660 }, candidate: { pcm_sha256: H('b'), packets_sha256: H('c'), packet_count: 685, sample_rate: 48000 } } };
  write(join(out, 'caption-ref/cap02-ref.png'), 'synthetic caption PNG'); write(join(out, 'work/out/_build/cap02.png'), 'synthetic caption PNG');
  const transcriptPath = join(root, 'run/end-to-end.json'), transcript = { ok: true, candidate: candidatePath, candidate_sha256: v.candidate_sha256, verification: join(out, 'verification.json'),
    transcript: { ok: true, model: 'faster-whisper synthetic fixture (NOT performed)', text: candidate.steps.map(s => s.narration).join(' '),
      lines: Object.fromEntries(takes.map((x, i) => [sid(i), { expected: next.slides[i].narration, heard: next.slides[i].narration.toLowerCase().replace(/[^a-z0-9 ]/g, ''), recall: 1,
        window_s: [Number((x.position_s - 0.3).toFixed(3)), Number((x.position_s + next.slides[i].adur + 0.6).toFixed(3))] }])),
      replaced_lines: { 'OLD slide-02': { old: oldText, distinguishing_words: ['old'], distinguishing_words_heard: [] } } } };
  const ctrlPath = write(join(control, 'candidate.mp4'), 'synthetic rebuilt baseline');
  const ctrl = { ok: true, candidate: ctrlPath, candidate_sha256: sha256File(ctrlPath), baseline_sha256: bm.final.sha256, source_unchanged: true };
  const selected = { policy: 'synthetic-selection', names: [name], inputHash: 'synthetic-batch', byName: new Map([[name, { status: 'selected', slides: slidesSelected, repair: semanticPlan.repair }]]) };
  const summary = { names: [name], uiSelection: { status: 'finalized', names: selected.names, policy: selected.policy, inputHash: selected.inputHash } };
  const job = { name, steps, candidateInputs: { identifiedScript: source } };
  const sync = () => { write(join(out, 'verification.json'), v); write(join(control, 'verification.json'), ctrl); write(transcriptPath, transcript);
    write(join(out, 'candidate-final.script.json'), candidate); write(join(out, 'candidate-assembly.json'), next); write(join(out, 'inputs/change-manifest.json'), cm);
    write(join(prep, 'summary.json'), summary); write(join(prep, name, 'job.json'), job); };
  sync();
  const args = { outputDir: out, controlDir: control, baselineDir: baseline, originalScriptPath: source, semanticPlan, repo };
  const result = { rendered: true, name, candidate: candidatePath, sha256: v.candidate_sha256, verification: join(out, 'verification.json'), controlSha256: bm.final.sha256, changedIndices: [1] };
  return { root, repo, out, baseline, prep, v, ctrl, bm, cm, candidate, next, semanticPlan, transcript, transcriptPath, summary, job, selected, result, sync, write,
    args, certArgs: { result, repo, preparationDir: prep, baselineDir: baseline }, deps: { selectWeeklyJobs: () => selected } };
}
const run = f => { f.sync(); return automaticNarrationQa(f.args); };
test('file-backed combined output accepts exact reviewed rewrite, not AAC identity or fake listening', t => {
  const f = fixture(t), r = run(f); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'automatically_verified'); assert.equal(r.qaHold, false); assert.equal(r.publishingAuthorized, false);
  assert.equal(r.performed.transcription, false); assert.equal(r.performed.nativeListening, false);
  assert.match(r.evidenceBasis.asr, /renderer report only/); assert.notEqual(f.v.audio.baseline.pcm_sha256, f.v.audio.candidate.pcm_sha256);
  assert.equal(r.artifacts.transcriptReportSha256, sha256File(f.transcriptPath));
});
test('file-backed narration-only output retains all original capture bytes and metadata', t => {
  const f = fixture(t, { narrationOnly: true }); assert.equal(run(f).ok, true);
});
test('optional baseline filter absence is preserved on untouched slides', t => {
  const f = fixture(t, { omitFilters: true }); assert.equal(run(f).ok, true);
  f.next.slides[0].audio_filter = ''; assert.equal(run(f).ok, false);
});
test('parent adapter uses complete batch selection and binds result to final candidate', t => {
  const f = fixture(t); const r = certifyAutomaticNarrationRepair(f.certArgs, f.deps); assert.equal(r.ok, true, JSON.stringify(r));
  f.result.sha256 = H('f'); assert.equal(certifyAutomaticNarrationRepair(f.certArgs, f.deps).ok, false);
});
for (const [label, change] of [
  ['review bound to a different original narration', f => { f.semanticPlan.scriptSteps = structuredClone(f.semanticPlan.scriptSteps); f.semanticPlan.scriptSteps[1].narration = 'Delete a project.'; }],
  ['original media omitted from snapshot', f => { const p = join(f.baseline, f.bm.cells[0].file); delete f.v.source_snapshot.before[p]; delete f.v.source_snapshot.after[p]; f.v.source_snapshot.files--; }],
  ['changed image omitted from snapshot', f => { const p = f.cm.changes[0].screenshot.path; delete f.v.source_snapshot.before[p]; delete f.v.source_snapshot.after[p]; f.v.source_snapshot.files--; }],
  ['out-of-scope narration rewrite', f => { f.candidate.steps[0].narration = 'Delete a project.'; }],
  ['out-of-scope caption', f => { f.next.slides[2].caption = 'Wrong'; }],
  ['missing independent review', f => { f.semanticPlan.steps[1].semanticRepair.verification = null; }],
  ['same-author verification', f => { f.semanticPlan.steps[1].semanticRepair.verification.verifier.reviewId = 'author'; }],
  ['intent not preserved', f => { f.semanticPlan.steps[1].semanticRepair.verification.narration.preservesIntent = false; }],
  ['wrong exact replacement', f => { f.semanticPlan.steps[1].semanticRepair.verification.narration.text = 'View the table.'; }],
  ['wrong new line', f => { f.cm.changes[0].narration.newText = 'Delete the project.'; }],
  ['wrong old line', f => { f.cm.changes[0].narration.oldText = 'Other old line.'; }],
  ['take manifest bypass', f => { f.cm.changes[0].narration.take = { path: '/fake', sha256: H('a') }; }],
  ['wrong voice', f => { f.v.takes['slide-02'].voice = 'el:12345678901234567890'; }],
  ['wrong baseline voice', f => { f.v.voice_check.voice = 'el:12345678901234567890'; }],
  ['wrong model', f => { f.v.takes['slide-02'].model = 'another-model'; }],
  ['fallback provider', f => { f.v.takes['slide-02'].provider = 'edge'; }],
  ['stand-in source', f => { f.v.takes['slide-02'].source = 'macOS say stand-in'; }],
  ['wrong cache key', f => { f.v.takes['slide-02'].provider_path = join(f.repo, 'out/_cache/tts/el-wrong.mp3'); }],
  ['new take bytes altered', f => { fs.appendFileSync(f.v.takes['slide-02'].path, 'tampered'); }],
  ['unchanged take bytes altered', f => { fs.appendFileSync(f.v.audio.takes[0].take, 'tampered'); }],
  ['original source bytes altered', f => { fs.appendFileSync(f.args.originalScriptPath, ' '); }],
  ['stale donor assemble', f => { f.v.donor.assemble_sha256 = H('f'); }],
  ['stale donor segment', f => { fs.appendFileSync(join(f.out, 'work/out/_build/seg02.mp4'), 'tampered'); }],
  ['stale source pin', f => { fs.appendFileSync(join(f.repo, 'renderer/tts.py'), '\n'); }],
  ['no baseline golden', f => { delete f.v.golden.audio; }],
  ['baseline golden failed', f => { f.v.golden.audio.packets_equal = false; }],
  ['chain audio not original', f => { f.v.golden.chain.audio_packets_equal_original = false; }],
  ['audio lacks take', f => { f.v.audio.takes.pop(); }],
  ['audio weak correlation', f => { f.v.audio.takes[0].peak = 0.59; }],
  ['audio lag assertion lies', f => { f.v.audio.takes[0].lag_samples += 3; }],
  ['audio AV sync deficient', f => { f.v.audio.takes[0].sync_delta_ms = 4; }],
  ['audio internally consistent but wrong scheduled slot', f => { const x = f.v.audio.takes[1]; x.expected_sample += 48000; x.position_sample += 48000; x.position_s += 1; x.expected_s += 1; x.audio_minus_video_s += 1; }],
  ['audio false calibration', f => { f.v.audio.takes[1].calibration_lag_samples = 0; }],
  ['audio false expected sample', f => { f.v.audio.takes[0].position_sample++; }],
  ['retime unquantized', f => { f.v.plan.quantize['slide-02'].shift_frames = 14.5; }],
  ['retime unrelated slide', f => { f.next.slides[0].sdur += 1; }],
  ['retime undocumented shift', f => { f.v.plan.shift_frames++; }],
  ['retime missing card phase', f => { delete f.v.plan.card_phase; }],
  ['protected view missing', f => { delete f.v.plan.protected_views; }],
  ['protected view partial frame coverage', f => { f.v.plan.protected_views.frames_checked--; }],
  ['protected view mismatch', f => { f.v.plan.protected_views.mismatch_count = 1; }],
  ['protected cells partial', f => { delete f.v.checks.reused_cells['tail-card']; }],
  ['protected cell changed bytes', f => { fs.appendFileSync(join(f.out, 'spliced/cell-tail-card.mp4'), 'tampered'); }],
  ['protected frames missing', f => { delete f.v.checks.reused_frames_equal_at_shifted_positions; }],
  ['cell mapping incomplete', f => { f.v.plan.cell_map.pop(); }],
  ['cell frame boundary forged', f => { f.v.plan.cell_map[1].new[1]++; }],
  ['decoded check partial', f => { f.v.checks.frames_total--; }],
  ['timestamp gaps', f => { f.v.checks.timestamps_contiguous = false; }],
  ['caption PNG assertion false', f => { f.v.checks.captions.slides['slide-02'].png_matches_new_text = false; }],
  ['caption PNG bytes differ', f => { fs.appendFileSync(join(f.out, 'work/out/_build/cap02.png'), 'wrong'); }],
  ['caption band deficiency', f => { f.v.checks.captions.slides['slide-02'].caption_band_mean_diff_vs_baseline = 1; }],
  ['caption unrelated changed', f => { f.v.checks.captions.other_captions_unchanged = false; }],
  ['ASR stale candidate', f => { f.transcript.candidate_sha256 = H('f'); }],
  ['ASR wrong line', f => { f.transcript.transcript.lines['slide-02'].expected = 'Delete the project.'; }],
  ['ASR insufficient recall', f => { f.transcript.transcript.lines['slide-02'].recall = 0.6; }],
  ['ASR fabricated recall', f => { f.transcript.transcript.lines['slide-02'].heard = 'wrong words'; }],
  ['ASR wrong time window', f => { f.transcript.transcript.lines['slide-02'].window_s[0] += 4; }],
  ['ASR old narration heard', f => { f.transcript.transcript.replaced_lines['OLD slide-02'].distinguishing_words_heard = ['old']; }],
  ['ASR missing replaced lines', f => { delete f.transcript.transcript.replaced_lines; }],
  ['unsupported older narration renderer', f => { delete f.v.plan; f.v.timing = {}; }],
]) test(`QA hold: ${label}`, t => { const f = fixture(t); change(f); const r = run(f); assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.qaHold, true); assert.equal(r.status, 'qa_blocked'); });
test('missing ASR report is a hold, never inferred from render ok', t => {
  const f = fixture(t); fs.rmSync(f.transcriptPath); assert.equal(automaticNarrationQa(f.args).ok, false);
});
test('missing finalized marker and out-of-scope local result cannot certify', t => {
  const f = fixture(t); f.summary.uiSelection.status = 'proposed'; f.sync(); assert.equal(certifyAutomaticNarrationRepair(f.certArgs, f.deps).ok, false);
  f.summary.uiSelection.status = 'finalized'; f.result.changedIndices = [0, 1]; f.sync(); assert.equal(certifyAutomaticNarrationRepair(f.certArgs, f.deps).ok, false);
});
test('certification performs no filesystem writes or media/service execution', t => {
  const f = fixture(t);
  function state(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name); return e.isDirectory() ? state(p) : [[p, sha256File(p), fs.statSync(p).mtimeMs]];
  }); }
  const before = state(f.root); assert.equal(automaticNarrationQa(f.args).ok, true); assert.deepEqual(state(f.root), before);
});
test('parent selection reloads every batch member, not just this result', t => {
  const f = fixture(t), other = 'Other-Synthetic'; f.summary.names.push(other);
  f.write(join(f.prep, other, 'job.json'), { name: other, steps: [] }); f.write(join(f.repo, 'scripts', other + '.script.json'), { name: other, steps: [] });
  f.sync(); let seen;
  const r = certifyAutomaticNarrationRepair(f.certArgs, { selectWeeklyJobs: (jobs, { readScript }) => {
    seen = jobs.map(j => j.name); assert.equal(readScript(other).name, other); return f.selected;
  } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(seen, ['Synthetic-Narration', other]);
});
test('malformed and missing renderer inputs always return holds', () => {
  for (const args of [undefined, {}, { outputDir: '/no-such-narration-qa-output' }]) {
    const r = automaticNarrationQa(args); assert.equal(r.ok, false); assert.equal(r.qaHold, true);
  }
  assert.equal(certifyAutomaticNarrationRepair().ok, false);
});
test('module is import-safe: no model, media, browser, service or writes on import', () => {
  const code = `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    for (const k of ['writeFileSync','appendFileSync','mkdirSync','rmSync','renameSync','copyFileSync']) fs[k] = () => { throw Error('unexpected_write'); };
    for (const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[k] = () => { throw Error('unexpected_process'); };
    syncBuiltinESMExports(); await import('./tools/drift/automatic-narration-qa.mjs');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
});
// Historical production combined renderer report is read-only. Its original baseline was pruned;
// it lacks a finalized semantic batch/control, so it MUST NOT be automatically certified.
const historical = join(scratch, 'du-pilot-real-b-20261029');
test('historical real combined ElevenLabs artifact: real read/hash + honest QA hold', { skip: !fs.existsSync(join(historical, 'update/verification.json')) }, () => {
  const verified = checkVerification(join(historical, 'update')), e2e = readPyJson(join(historical, 'end-to-end.json'));
  assert.equal(verified.v.voice_check.ok, true); assert.equal(verified.v.takes['slide-02'].provider, 'el');
  assert.equal(e2e.transcript.ok, true); assert.equal(e2e.candidate_sha256, sha256File(verified.candidate));
  const r = automaticNarrationQa({ outputDir: join(historical, 'update'), controlDir: join(historical, 'control'),
    baselineDir: dirname(Object.keys(verified.v.source_snapshot.before).find(p => p.endsWith('/baseline-manifest.json'))),
    originalScriptPath: join(historical, 'source/stable-base.script.json'), repo: REPO });
  assert.equal(r.ok, false); assert.equal(r.qaHold, true); assert.equal(r.performed.transcription, false);
});
