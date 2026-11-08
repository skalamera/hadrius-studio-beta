import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {BaselineHold, getOrEnrollBaseline, defaultEnrollBaseline, defaultVerifyBaseline, currentRenderIdentity, RENDER_IDENTITY_FILES} from '../../tools/drift/baseline-registry.mjs';

// Synthetic unit-test bytes ONLY, isolated under Hermes scratch. No real registry, media runner,
// credentials, fixture spec, script, source render, publisher, or external service is touched.
const scratch = join(os.homedir(), '.hermes/cache/scratch');
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = p => hash(fs.readFileSync(p));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
function setup(t, name = 'Synthetic-existing-identities') {
  fs.mkdirSync(scratch, {recursive: true});
  const root = fs.mkdtempSync(join(scratch, 'baseline-registry-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = join(root, 'repo'), stateRoot = join(repo, 'out/drift-baselines'), runRoot = join(root, 'runs');
  fs.mkdirSync(join(repo, 'scripts'), {recursive: true}); fs.mkdirSync(join(repo, 'out', name), {recursive: true});
  const scriptPath = join(repo, 'scripts', `${name}.script.json`), assemblyPath = join(repo, 'out', name, 'assembly.json'), originalPath = join(repo, 'out', name, `${name}.mp4`);
  const script = {name, id: 'existing-script-id', recording: {id: 'existing-recording-id'}, fx: true,
    steps: [{index: 0, id: 'existing-step-alpha', capture: true, media: {pre: 'existing-alpha.png'}, narration: 'Keep original narration', caption: 'Keep original caption'},
      {index: 9, id: 'existing-step-zeta', capture: true, media: {pre: 'existing-zeta.png'}, narration: 'Keep last narration', caption: 'Keep last caption'}]};
  const assembly = {fx: true, slides: script.steps.map((s, i) => ({slide: i + 1, step: s.index, src: s.media.pre, narration: s.narration, caption: s.caption}))};
  write(scriptPath, script); write(assemblyPath, assembly); fs.writeFileSync(originalPath, 'synthetic-original-video-and-audio');
  let enrollments = 0, loaders = 0, renderer = hash('current-renderer');
  const outputs = [];
  const makeBaseline = output => {
    assert.equal(fs.existsSync(output), false, 'enrollment always receives a NEW output directory');
    fs.mkdirSync(output);
    fs.copyFileSync(assemblyPath, join(output, 'baseline-assembly.json'));
    fs.writeFileSync(join(output, 'baseline-rebuilt.mp4'), 'synthetic-reencoded-video-original-audio');
    const cells = ['real-cell-alpha', 'real-cell-zeta'].map((id, i) => {
      const file = `cell-${id}.mp4`; fs.writeFileSync(join(output, file), `synthetic-cell-${i}`);
      return {id, file, sha256: sha(join(output, file)), dependsOn: [`slide-${i + 1}`], startFrame: i * 30, endFrame: (i + 1) * 30};
    });
    const manifest = {schema: 1, profile: 'legacy-fx-rebaseline-h264-1080p30-v1', profileHash: hash('profile'),
      original: {name, file: `out/${name}/${name}.mp4`, sha256: sha(originalPath), size: fs.statSync(originalPath).size},
      assembly: {file: 'baseline-assembly.json', sha256: sha(assemblyPath), source_sha256: sha(assemblyPath)},
      final: {file: 'baseline-rebuilt.mp4', sha256: sha(join(output, 'baseline-rebuilt.mp4'))}, audio: {mode: 'original stream copy'}, frameCount: 60, cells};
    write(join(output, 'baseline-manifest.json'), manifest);
    const snapshot = Object.fromEntries([assemblyPath, originalPath].map(p => [p, {sha256: sha(p), size: fs.statSync(p).size, mtime_ns: 123}]));
    write(join(output, 'verification.json'), {ok: true, source_unchanged: true, name, manifest_sha256: sha(join(output, 'baseline-manifest.json')),
      original_sha256: manifest.original.sha256, final_sha256: manifest.final.sha256, source_snapshot: {before: snapshot, after: structuredClone(snapshot)}});
    return output;
  };
  const options = {name, repo, stateRoot, runRoot, pollMs: 2, lockTimeoutMs: 2000,
    ensureBaseline: async ({output}) => { enrollments++; outputs.push(output); makeBaseline(output); },
    verifyBaseline: async () => { loaders++; return true; }, getRenderIdentity: () => renderer};
  return {root, repo, stateRoot, runRoot, name, scriptPath, assemblyPath, originalPath, script, assembly, options, makeBaseline,
    get enrollments() { return enrollments; }, get loaders() { return loaders; }, outputs, setRenderer: value => { renderer = value; }};
}
function addRenderSources(f) {
  Object.assign(f.assembly, {intro: true, title_card: true, support_card: true, outro: true}); write(f.assemblyPath, f.assembly);
  const build = join(f.repo, 'out', f.name, '_build'), recording = join(f.repo, 'out/_recordings', f.script.recording.id);
  fs.mkdirSync(build, {recursive: true}); fs.mkdirSync(recording, {recursive: true});
  const buildFiles = ['content.mp4', 'seg01.mp4', 'seg02.mp4', 'cap01.png', 'cap02.png', 'hl01.png', 'spot01.png',
    'intro_title_crossfaded.mp4', 'title_card.mp4', 'support_card.mp4', 'logo_card.mp4', 'body_crossfaded.mp4', 'body_with_support.mp4'];
  for (const file of buildFiles) fs.writeFileSync(join(build, file), `synthetic saved original ${file}`);
  const reportPath = join(f.repo, 'out', f.name, 'report.json'); write(reportPath, {source: 'recording', original: true});
  for (const step of f.script.steps) fs.writeFileSync(join(recording, step.media.pre), `synthetic original screenshot ${step.id}`);
  return {build, recording, reportPath, buildFiles};
}
const expectHold = (fn, code) => assert.rejects(fn, e => {
  assert(e instanceof BaselineHold); assert.equal(e.status, 'operational_hold'); assert.equal(e.humanRequired, false);
  if (code) assert.equal(e.code, code); return true;
});

// Run: node --test tests/drift/baseline-registry.test.mjs

test('enrolls once, persists every hash-bound file, preserves existing IDs and source bytes, then discovers automatically', async t => {
  const f = setup(t), sources = [f.scriptPath, f.assemblyPath, f.originalPath].map(sha);
  const first = await getOrEnrollBaseline(f.options);
  assert.equal(first.status, 'baseline_ready'); assert.equal(first.enrolled, true); assert.equal(first.resumed, false);
  assert.equal(first.directory, join(f.stateRoot, f.name, first.manifestSha256));
  const manifest = read(join(first.directory, 'baseline-manifest.json')), enrollment = read(join(first.directory, 'enrollment.json'));
  assert.equal(enrollment.identity.scriptSha256, sha(f.scriptPath));
  for (const entry of [manifest.assembly, manifest.final, ...manifest.cells]) assert.equal(sha(join(first.directory, entry.file)), entry.sha256);
  for (const [file, expected] of Object.entries(enrollment.files)) assert.equal(sha(join(first.directory, file)), expected);
  assert.deepEqual(read(join(first.directory, 'baseline-script.json')), f.script);
  assert.deepEqual([f.scriptPath, f.assemblyPath, f.originalPath].map(sha), sources);
  // Scratch can disappear entirely: all baseline files must now be durable and self-contained.
  fs.rmSync(f.runRoot, {recursive: true});
  const second = await getOrEnrollBaseline({...f.options, ensureBaseline: false});
  assert.equal(second.rebaselineDir, first.directory); assert.equal(second.reused, true); assert.equal(f.enrollments, 1);
  assert(f.loaders >= 2); assert.equal(read(join(f.stateRoot, 'index.json')).baselines.length, 1);
});

test('frozen build retains the exact original MP4 beside it for renderer source authentication',async t=>{
  const f=setup(t);addRenderSources(f);const result=await getOrEnrollBaseline(f.options);
  const original=join(dirname(result.buildDir),f.name+'.mp4');
  assert.ok(fs.existsSync(original),'renderer derives this original path from buildDir');
  assert.equal(sha(original),sha(f.originalPath));
  fs.writeFileSync(original,'corrupt frozen original');
  await expectHold(()=>getOrEnrollBaseline({...f.options,ensureBaseline:false}),'baseline_original_snapshot_mismatch');
});

test('actual runner and loader are import-safe until called, use explicit repo and a new local output', async () => {
  const calls = [], run = async (...args) => { calls.push(args); return {code: 0, stdout: '{"ok": true}', stderr: ''}; };
  await defaultEnrollBaseline({name: 'Existing', repo: '/isolated-repo', output: '/scratch/new-parent/new-output', run});
  await defaultVerifyBaseline({repo: '/isolated-repo', directory: '/durable/baseline', run});
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '/isolated-repo/.venv/bin/python');
  assert.deepEqual(calls[0][1], ['-B', '-m', 'renderer.rebaseline', '--repo', '/isolated-repo', '--name', 'Existing', '--output', '/scratch/new-parent/new-output']);
  assert.equal(calls[0][2].cwd, '/isolated-repo'); assert.equal(calls[0][2].env.TMPDIR, '/scratch/new-parent');
  assert.match(calls[1][1][2], /from renderer\.drift_render import load_rebaseline/);
  assert.doesNotMatch(calls[1][1][2], /assemble|tts|publish/);
  await expectHold(() => defaultVerifyBaseline({repo: '/r', directory: '/b', run: async () => ({code: 1, stderr: 'corrupt'})}), 'baseline_loader_failed');
  await expectHold(() => defaultEnrollBaseline({name: 'X', repo: '/r', output: '/b', run: async () => ({code: 1, timedOut: true})}), 'baseline_enrollment_timeout');
});

test('renderer identity hashes actual sources and changes when any enrolled renderer source changes', t => {
  const f = setup(t);
  for (const file of RENDER_IDENTITY_FILES) { fs.mkdirSync(dirname(join(f.repo, file)), {recursive: true}); fs.writeFileSync(join(f.repo, file), `synthetic source ${file}`); }
  const first = currentRenderIdentity({repo: f.repo});
  fs.appendFileSync(join(f.repo, RENDER_IDENTITY_FILES[0]), '\nchanged');
  assert.notEqual(currentRenderIdentity({repo: f.repo}), first);
});

test('migrates real schema-1 shape without trusting historical flags or discarding unrelated legacy rows/caption layout', async t => {
  const f = setup(t); fs.mkdirSync(f.runRoot);
  const legacy = f.makeBaseline(join(f.runRoot, 'legacy'));
  const old = join(f.stateRoot, f.name, '20261102-existing-version'); fs.mkdirSync(dirname(old), {recursive: true}); fs.cpSync(legacy, old, {recursive: true});
  const other = {name: 'Unrelated-legacy', directory: join(f.stateRoot, 'Unrelated-legacy', 'old-version'), manifestSha256: hash('other'), captionLayout: 'raqm'};
  const legacyRow = {name: f.name, directory: old, manifestSha256: sha(join(old, 'baseline-manifest.json')), captionLayout: 'basic', actualRendererLoaderPassed: true};
  write(join(f.stateRoot, 'index.json'), {schema: 1, disclosure: 'Keep original disclosure', baselines: [legacyRow, other]});
  const result = await getOrEnrollBaseline({...f.options, ensureBaseline: false});
  assert.equal(f.enrollments, 0); assert(f.loaders > 0); assert.equal(result.captionLayout, 'basic'); assert.notEqual(result.directory, old);
  const index = read(join(f.stateRoot, 'index.json'));
  assert.equal(index.schema, 2); assert.equal(index.disclosure, 'Keep original disclosure'); assert.deepEqual(index.baselines.find(r => r.name === other.name), other);
  assert.equal(index.baselines.find(r => r.name === f.name).identity.originalSha256, sha(f.originalPath));
  await getOrEnrollBaseline({...f.options, ensureBaseline: false}); // Mixed migrated/unmigrated rows remain readable.
});

test('an existing legacy claimed-loader flag cannot bypass the actual loader', async t => {
  const f = setup(t); fs.mkdirSync(f.runRoot);
  const old = f.makeBaseline(join(f.runRoot, 'legacy')), directory = join(f.stateRoot, f.name, 'old');
  fs.mkdirSync(dirname(directory), {recursive: true}); fs.cpSync(old, directory, {recursive: true});
  write(join(f.stateRoot, 'index.json'), {schema: 1, baselines: [{name: f.name, directory, manifestSha256: sha(join(directory, 'baseline-manifest.json')), actualRendererLoaderPassed: true}]});
  await expectHold(() => getOrEnrollBaseline({...f.options, verifyBaseline: async () => false}), 'baseline_loader_failed');
  assert.equal(f.enrollments, 0); assert.equal(read(join(f.stateRoot, 'index.json')).schema, 1);
});

test('old enrollment can never authorize different current video, assembly, script, or renderer identities', async t => {
  for (const kind of ['video', 'assembly', 'script', 'renderer']) await t.test(kind, async t => {
    const f = setup(t); await getOrEnrollBaseline(f.options);
    const indexBefore = fs.readFileSync(join(f.stateRoot, 'index.json'));
    if (kind === 'video') fs.appendFileSync(f.originalPath, 'changed source');
    if (kind === 'assembly') write(f.assemblyPath, {...f.assembly, duration: 123});
    if (kind === 'script') write(f.scriptPath, {...f.script, recording: {id: 'different-existing-recording'}});
    if (kind === 'renderer') f.setRenderer(hash('new renderer'));
    await expectHold(() => getOrEnrollBaseline(f.options), {video: 'baseline_original_mismatch', assembly: 'baseline_assembly_mismatch', script: 'baseline_script_mismatch', renderer: 'baseline_renderer_mismatch'}[kind]);
    assert.equal(f.enrollments, 1); assert.deepEqual(fs.readFileSync(join(f.stateRoot, 'index.json')), indexBefore);
  });
});

test('missing sources, mismatched assembly/script and unsupported non-FX are operational holds, not re-record verdicts', async t => {
  for (const kind of ['missing', 'narration', 'mapping', 'non-fx']) await t.test(kind, async t => {
    const f = setup(t);
    if (kind === 'missing') fs.unlinkSync(f.originalPath);
    if (kind === 'narration') { const s = structuredClone(f.script); s.steps[0].narration = 'different'; write(f.scriptPath, s); }
    if (kind === 'mapping') { const a = structuredClone(f.assembly); a.slides[0].step = 3; write(f.assemblyPath, a); }
    if (kind === 'non-fx') write(f.assemblyPath, {...f.assembly, fx: false});
    await expectHold(() => getOrEnrollBaseline(f.options), kind === 'missing' ? 'baseline_source_missing' : kind === 'non-fx' ? 'baseline_enrollment_unsupported_non_fx' : 'baseline_script_mismatch');
    assert.equal(f.enrollments, 0); assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
  });
});

test('corrupt/missing durable manifest, verification, assembly, final, every cell or metadata is held without auto re-enrolling', async t => {
  for (const file of ['baseline-manifest.json', 'verification.json', 'baseline-assembly.json', 'baseline-rebuilt.mp4', 'cell-real-cell-alpha.mp4', 'cell-real-cell-zeta.mp4', 'baseline-script.json', 'enrollment.json']) await t.test(file, async t => {
    const f = setup(t), result = await getOrEnrollBaseline(f.options);
    fs.appendFileSync(join(result.directory, file), 'corruption');
    await expectHold(() => getOrEnrollBaseline(f.options)); assert.equal(f.enrollments, 1);
  });
  await t.test('missing indexed directory', async t => {
    const f = setup(t), result = await getOrEnrollBaseline(f.options); fs.rmSync(result.directory, {recursive: true});
    await expectHold(() => getOrEnrollBaseline(f.options)); assert.equal(f.enrollments, 1);
  });
});

test('actual successful enrollment verification plus source snapshot and every cell hash are mandatory', async t => {
  for (const kind of ['ok', 'unchanged', 'snapshot', 'manifest', 'final', 'cell', 'unsafe-cell', 'audio']) await t.test(kind, async t => {
    const f = setup(t);
    await expectHold(() => getOrEnrollBaseline({...f.options, ensureBaseline: async ({output}) => {
      f.makeBaseline(output);
      const vp = join(output, 'verification.json'), mp = join(output, 'baseline-manifest.json'), v = read(vp), m = read(mp);
      if (kind === 'ok') v.ok = false;
      if (kind === 'unchanged') v.source_unchanged = false;
      if (kind === 'snapshot') v.source_snapshot.after[f.originalPath].sha256 = hash('different');
      if (kind === 'manifest') v.manifest_sha256 = hash('wrong');
      if (kind === 'final') fs.appendFileSync(join(output, m.final.file), 'wrong');
      if (kind === 'cell') fs.unlinkSync(join(output, m.cells.at(-1).file));
      if (kind === 'unsafe-cell') m.cells[0].file = '../escape.mp4';
      if (kind === 'audio') m.audio.mode = 'new tts';
      if (['unsafe-cell', 'audio'].includes(kind)) { write(mp, m); v.manifest_sha256 = sha(mp); }
      write(vp, v);
    }}));
    assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
  });
});

test('a completed interrupted scratch enrollment resumes, and incomplete enrollment restarts in a NEW directory', async t => {
  for (const complete of [true, false]) await t.test(complete ? 'completed' : 'partial', async t => {
    const f = setup(t); let firstOutput;
    await expectHold(() => getOrEnrollBaseline({...f.options, ensureBaseline: async ({output}) => {
      firstOutput = output;
      if (complete) f.makeBaseline(output); else { fs.mkdirSync(output); fs.writeFileSync(join(output, 'partial-cell.mp4'), 'partial'); }
      throw new Error('simulated process interruption');
    }}));
    const result = await getOrEnrollBaseline(f.options);
    assert.equal(result.resumed, complete); assert.equal(f.enrollments, complete ? 0 : 1);
    if (!complete) assert.notEqual(f.outputs[0], firstOutput);
    assert.equal(fs.readdirSync(join(f.stateRoot, '.pending')).length, 0);
  });
});

test('interrupted durable index commit recovers an orphaned fully verified version without re-enrollment', async t => {
  const f = setup(t); let failed = false;
  const io = {...fs, renameSync: (a, b) => {
    if (b === join(f.stateRoot, 'index.json') && !failed) { failed = true; throw new Error('simulated index rename failure'); }
    fs.renameSync(a, b);
  }};
  await expectHold(() => getOrEnrollBaseline({...f.options, io})); assert.equal(f.enrollments, 1);
  assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
  const result = await getOrEnrollBaseline(f.options);
  assert.equal(result.reused, true); assert.equal(f.enrollments, 1); assert.equal(read(join(f.stateRoot, 'index.json')).baselines.length, 1);
});

test('copy interruptions never bless partial durable outputs; completed scratch safely resumes', async t => {
  const f = setup(t); let copied = 0;
  const io = {...fs, copyFileSync: (...args) => { copied++; if (copied === 3) throw new Error('simulated interrupted copy'); fs.copyFileSync(...args); }};
  await expectHold(() => getOrEnrollBaseline({...f.options, io}));
  assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
  const result = await getOrEnrollBaseline(f.options); assert.equal(result.resumed, true); assert.equal(f.enrollments, 1);
  assert.equal(fs.readdirSync(join(f.stateRoot, f.name)).filter(n => n.startsWith('.partial')).length, 0);
});

test('same-name concurrent calls enroll once and different names never lose shared index updates', async t => {
  const f = setup(t), enroll = f.options.ensureBaseline;
  const options = {...f.options, ensureBaseline: async args => { await sleep(20); return enroll(args); }};
  const results = await Promise.all([getOrEnrollBaseline(options), getOrEnrollBaseline(options), getOrEnrollBaseline(options)]);
  assert.equal(f.enrollments, 1); assert.equal(new Set(results.map(r => r.directory)).size, 1);
  assert.equal(results.filter(r => r.enrolled).length, 1);
  const secondName = 'Synthetic-another-existing-video';
  const script2 = {...f.script, name: secondName};
  fs.mkdirSync(join(f.repo, 'out', secondName)); write(join(f.repo, 'scripts', `${secondName}.script.json`), script2);
  fs.copyFileSync(f.assemblyPath, join(f.repo, 'out', secondName, 'assembly.json')); fs.copyFileSync(f.originalPath, join(f.repo, 'out', secondName, `${secondName}.mp4`));
  const enrollSecond = async ({output}) => {
    f.makeBaseline(output);
    const mp = join(output, 'baseline-manifest.json'), m = read(mp); m.original.name = secondName; m.original.file = `out/${secondName}/${secondName}.mp4`; write(mp, m);
    const vp = join(output, 'verification.json'), v = read(vp); v.name = secondName; v.manifest_sha256 = sha(mp);
    for (const phase of ['before', 'after']) v.source_snapshot[phase] = Object.fromEntries(Object.entries(v.source_snapshot[phase]).map(([p, value]) => [p.replaceAll(f.name, secondName), value]));
    write(vp, v);
  };
  await Promise.all([getOrEnrollBaseline(f.options), getOrEnrollBaseline({...f.options, name: secondName, ensureBaseline: enrollSecond})]);
  assert.deepEqual(read(join(f.stateRoot, 'index.json')).baselines.map(r => r.name).sort(), [f.name, secondName].sort());
});

test('dead local locks resume, live/foreign/malformed locks hold and are never age-expired', async t => {
  for (const kind of ['dead', 'live', 'foreign', 'malformed']) await t.test(kind, async t => {
    const f = setup(t), lock = join(f.stateRoot, '.registry.lock'); fs.mkdirSync(lock, {recursive: true});
    if (kind !== 'malformed') write(join(lock, 'owner.json'), {pid: kind === 'dead' ? 314159 : process.pid, host: kind === 'foreign' ? 'another-host' : os.hostname(), token: 'existing-owner', at: '1970-01-01'});
    const options = {...f.options, lockTimeoutMs: 15, isAlive: pid => pid !== 314159};
    if (kind === 'dead') { await getOrEnrollBaseline(options); assert.equal(f.enrollments, 1); }
    else { await expectHold(() => getOrEnrollBaseline(options), 'baseline_registry_busy'); assert.equal(f.enrollments, 0); assert.equal(fs.existsSync(lock), true); }
  });
});

test('source or script mutation during enrollment/loader is detected before durable authorization', async t => {
  for (const phase of ['enrollment', 'loader']) await t.test(phase, async t => {
    const f = setup(t), base = f.options.ensureBaseline;
    const options = {...f.options};
    if (phase === 'enrollment') options.ensureBaseline = async args => { await base(args); fs.appendFileSync(f.originalPath, 'concurrent mutation'); };
    else options.verifyBaseline = async () => { fs.appendFileSync(f.scriptPath, ' '); return true; };
    await expectHold(() => getOrEnrollBaseline(options)); assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
  });
});

test('unsafe names, unsafe index paths, unsupported schema, and symlinked source never invoke enrollment', async t => {
  for (const kind of ['name', 'path', 'schema', 'symlink']) await t.test(kind, async t => {
    const f = setup(t), options = {...f.options};
    if (kind === 'name') options.name = '../other';
    if (kind === 'path' || kind === 'schema') {
      fs.mkdirSync(f.stateRoot, {recursive: true}); write(join(f.stateRoot, 'index.json'), {schema: kind === 'schema' ? 999 : 1,
        baselines: [{name: f.name, directory: join(f.root, 'untrusted'), manifestSha256: hash('x')}]});
    }
    if (kind === 'symlink') { const other = join(f.root, 'other.mp4'); fs.renameSync(f.originalPath, other); fs.symlinkSync(other, f.originalPath); }
    await expectHold(() => getOrEnrollBaseline(options)); assert.equal(f.enrollments, 0);
  });
});

test('durable render snapshot preserves every build/card/caption/segment, report and original PNG under existing recording ID', async t => {
  const f = setup(t), assets = addRenderSources(f);
  const result = await getOrEnrollBaseline(f.options);
  assert.equal(result.snapshotComplete, true); assert.deepEqual(result.snapshotMissing, []);
  assert.equal(result.fullOriginalImageControlRequired, true);
  assert.equal(result.scriptPath, join(result.directory, 'baseline-script.json'));
  assert.equal(result.buildDir, join(result.directory, 'source/_build'));
  assert.equal(basename(result.recordingsDir), f.script.recording.id);
  const snapshot = read(result.sourceSnapshot.manifestPath);
  assert.deepEqual(snapshot.identity, result.identity);
  for (const entry of snapshot.files) assert.equal(sha(join(result.directory, entry.file)), entry.sha256);
  for (const file of assets.buildFiles) assert.equal(sha(join(result.buildDir, file)), sha(join(assets.build, file)));
  assert.equal(sha(result.reportPath), sha(assets.reportPath));
  for (const step of f.script.steps) assert.equal(sha(join(result.recordingsDir, step.media.pre)), sha(join(assets.recording, step.media.pre)));
  // A normal rebuild/prune can delete live auxiliary artifacts, without losing the enrolled originals.
  fs.rmSync(assets.build, {recursive: true}); fs.rmSync(assets.recording, {recursive: true}); fs.unlinkSync(assets.reportPath);
  const reused = await getOrEnrollBaseline({...f.options, ensureBaseline: false});
  assert.equal(reused.snapshotComplete, true); assert.deepEqual(reused.sourceSnapshot, result.sourceSnapshot); assert.equal(f.enrollments, 1);
});

test('missing render snapshots are explicit operational prerequisites, never an implied ready-to-render or re-record verdict', async t => {
  const f = setup(t), result = await getOrEnrollBaseline(f.options);
  assert.equal(result.snapshotComplete, false); assert.equal(result.buildDir, null); assert.equal(result.recordingsDir, null); assert.equal(result.reportPath, null);
  for (const missing of ['source/_build/content.mp4', 'source/_build/seg01.mp4', 'source/_build/cap01.png', 'source/report.json',
    `source/_recordings/${f.script.recording.id}/${f.script.steps[0].media.pre}`]) assert(result.snapshotMissing.includes(missing));
});

test('snapshot manifest, captions, original cards/segments/report/PNGs are all integrity checked on every registry lookup', async t => {
  for (const file of ['source-snapshot.json', 'source/_build/cap01.png', 'source/_build/seg02.mp4', 'source/_build/logo_card.mp4',
    'source/report.json', 'source/_recordings/existing-recording-id/existing-alpha.png']) await t.test(file, async t => {
    const f = setup(t); addRenderSources(f); const result = await getOrEnrollBaseline(f.options);
    fs.appendFileSync(join(result.directory, file), 'corruption');
    await expectHold(() => getOrEnrollBaseline(f.options)); assert.equal(f.enrollments, 1);
  });
});

test('snapshot changes during actual-loader validation and silent copy corruption never get committed', async t => {
  for (const kind of ['loader', 'copy']) await t.test(kind, async t => {
    const f = setup(t); addRenderSources(f);
    if (kind === 'loader') {
      const result = await getOrEnrollBaseline(f.options), index = fs.readFileSync(join(f.stateRoot, 'index.json'));
      await expectHold(() => getOrEnrollBaseline({...f.options, verifyBaseline: async () => {
        fs.appendFileSync(join(result.buildDir, 'cap01.png'), 'concurrent mutation'); return true;
      }}), 'baseline_snapshot_hash_mismatch');
      assert.deepEqual(fs.readFileSync(join(f.stateRoot, 'index.json')), index);
    } else {
      const io = {...fs, copyFileSync: (a, b, flags) => {
        fs.copyFileSync(a, b, flags); if (a.endsWith('/cap01.png')) fs.appendFileSync(b, 'silent copy corruption');
      }};
      await expectHold(() => getOrEnrollBaseline({...f.options, io}), 'baseline_snapshot_hash_mismatch');
      assert.equal(fs.existsSync(join(f.stateRoot, 'index.json')), false);
    }
  });
});

test('already-full-hash legacy directories migrate metadata atomically without replacing baseline media', async t => {
  const f = setup(t); addRenderSources(f); fs.mkdirSync(f.runRoot);
  const old = f.makeBaseline(join(f.runRoot, 'legacy')), manifestSha256 = sha(join(old, 'baseline-manifest.json'));
  const directory = join(f.stateRoot, f.name, manifestSha256); fs.mkdirSync(dirname(directory), {recursive: true}); fs.cpSync(old, directory, {recursive: true});
  const mediaBefore = sha(join(directory, 'baseline-rebuilt.mp4'));
  write(join(f.stateRoot, 'index.json'), {schema: 1, baselines: [{name: f.name, directory, manifestSha256}]});
  const result = await getOrEnrollBaseline({...f.options, ensureBaseline: false});
  assert.equal(result.directory, directory); assert.equal(result.snapshotComplete, true); assert.equal(f.enrollments, 0);
  assert.equal(sha(join(directory, 'baseline-rebuilt.mp4')), mediaBefore);
  await getOrEnrollBaseline({...f.options, ensureBaseline: false});
});

test('Python Infinity verification data is copied byte-for-byte while still enforcing successful verification', async t => {
  const f = setup(t);
  const result = await getOrEnrollBaseline({...f.options, ensureBaseline: async ({output}) => {
    f.makeBaseline(output); const p = join(output, 'verification.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"ok": true', '"ok": true, "psnr_mean": Infinity'));
  }});
  assert.match(fs.readFileSync(join(result.directory, 'verification.json'), 'utf8'), /Infinity/);
  await getOrEnrollBaseline({...f.options, ensureBaseline: false});
});

test('boolean ensureBaseline=true uses the real default command through the injected subprocess seam', async t => {
  const f = setup(t), calls = [];
  const result = await getOrEnrollBaseline({...f.options, ensureBaseline: true, run: async (cmd, args) => {
    calls.push({cmd, args}); f.makeBaseline(args.at(-1)); return {code: 0, stdout: '', stderr: ''};
  }});
  assert.equal(result.enrolled, true); assert.equal(calls.length, 1); assert.equal(calls[0].args[2], 'renderer.rebaseline');
});

test('no-captions reports and hidden Finder metadata do not falsely mark complete snapshots unsupported', async t => {
  const f = setup(t), assets = addRenderSources(f);
  fs.writeFileSync(join(assets.build, '.DS_Store'), 'not a render input');
  fs.unlinkSync(join(assets.build, 'cap01.png')); fs.unlinkSync(join(assets.build, 'cap02.png'));
  write(assets.reportPath, {source: 'recording', no_captions: true});
  const result = await getOrEnrollBaseline(f.options);
  assert.equal(result.snapshotComplete, true); assert.deepEqual(result.snapshotMissing, []);
  assert(!read(result.sourceSnapshot.manifestPath).files.some(f => f.file.endsWith('.DS_Store')));
});

test('index identity hash and valid-JSON enrollment metadata corruption fail closed', async t => {
  for (const kind of ['identity', 'metadata']) await t.test(kind, async t => {
    const f = setup(t), result = await getOrEnrollBaseline(f.options);
    if (kind === 'identity') {
      const p = join(f.stateRoot, 'index.json'), index = read(p); index.baselines[0].identitySha256 = hash('forged identity'); write(p, index);
    } else {
      const p = join(result.directory, 'enrollment.json'); write(p, {...read(p), unexpected: 'tampering'});
    }
    await expectHold(() => getOrEnrollBaseline(f.options), kind === 'identity' ? 'baseline_index_corrupt' : 'baseline_enrollment_mismatch');
    assert.equal(f.enrollments, 1);
  });
});

test('lookup-only missing baseline does not create scratch or enroll', async t => {
  const f = setup(t);
  await expectHold(() => getOrEnrollBaseline({...f.options, ensureBaseline: false}), 'baseline_enrollment_required');
  assert.equal(f.enrollments, 0); assert.equal(fs.existsSync(f.runRoot), false);
});
