// Durable, LOCAL-ONLY baseline enrollment. Importing this module does not run Python or touch files.
// No fixtures, source renders, publishers, network clients, TTS, or stable-ID generators are called.
import fs from 'node:fs';
import os from 'node:os';
import {join, resolve, dirname, relative, isAbsolute, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {runProcess, readPyJson} from './executor.mjs';
import {sha256File} from './publish.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const PROFILE = 'legacy-fx-rebaseline-h264-1080p30-v1';
export const RENDER_IDENTITY_FILES = Object.freeze([
  'renderer/rebaseline.py', 'renderer/preservation.py', 'renderer/fx_scope.py',
  'renderer/drift_render.py', 'renderer/drift_update.py', 'renderer/fx_draw.py', 'renderer/assemble.py',
]);

/** Every failure is an operational hold, NEVER a human re-record verdict. */
export class BaselineHold extends Error {
  constructor(code, detail = null, cause = undefined) {
    super(`${code}${detail ? `: ${detail}` : ''}`, {cause});
    this.name = 'BaselineHold'; this.code = code; this.detail = detail;
    this.status = 'operational_hold'; this.humanRequired = false; this.retryable = true;
  }
}
const hold = (code, detail) => { throw new BaselineHold(code, detail); };
const check = (value, code, detail) => { if (!value) hold(code, detail); };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const within = (root, path) => { const r = relative(root, resolve(path)); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const exists = (io, p) => { try { io.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const hashFile = (io, p) => io === fs ? sha256File(p) : createHash('sha256').update(io.readFileSync(p)).digest('hex');
function regular(io, p) {
  check(io.lstatSync(p).isFile() && io.realpathSync(p) === resolve(p), 'unsafe_baseline_file', p);
}
function readJson(io, p) {
  regular(io, p);
  // Verification reports can contain Python's Infinity/NaN (PSNR), never re-serialize those reports.
  return io === fs ? readPyJson(p) : JSON.parse(io.readFileSync(p, 'utf8').replace(/([:\[,]\s*)-?(?:Infinity|NaN)\b/g, '$1null'));
}
function syncDir(io, p) {
  const fd = io.openSync(p, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function atomicJson(io, path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    io.renameSync(temp, path); syncDir(io, dirname(path));
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (exists(io, temp)) io.unlinkSync(temp);
  }
}
function pinnedFile(io, root, entry) {
  check(entry && typeof entry.file === 'string' && NAME.test(entry.file) && HASH.test(entry.sha256), 'invalid_baseline_file');
  const p = join(root, entry.file); regular(io, p);
  check(hashFile(io, p) === entry.sha256, 'baseline_hash_mismatch', p);
  if (entry.size !== undefined) check(io.statSync(p).size === entry.size, 'baseline_size_mismatch', p);
  return p;
}

function snapshotFile(io, root, entry) {
  check(entry && typeof entry.file === 'string' && entry.file.startsWith('source/') &&
    entry.file.split('/').every(s => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s) && !['.', '..'].includes(s)) && HASH.test(entry.sha256),
  'baseline_snapshot_unsafe_file');
  const path = join(root, entry.file); regular(io, path);
  check(hashFile(io, path) === entry.sha256 && io.statSync(path).size === entry.size, 'baseline_snapshot_hash_mismatch', path);
}
function snapshotInputs(directory, snapshot) {
  const files = new Set((snapshot?.files || []).map(e => e.file));
  return {complete: snapshot?.complete === true, missing: snapshot?.missing || ['source_snapshot_not_enrolled'],
    manifestPath: snapshot ? join(directory, 'source-snapshot.json') : null,
    scriptPath: join(directory, 'baseline-script.json'),
    buildDir: [...files].some(f => f.startsWith('source/_build/')) ? join(directory, 'source/_build') : null,
    reportPath: files.has('source/report.json') ? join(directory, 'source/report.json') : null,
    recordingsDir: snapshot?.recordingId && [...files].some(f => f.startsWith('source/_recordings/')) ? join(directory, 'source/_recordings', snapshot.recordingId) : null};
}

// Freeze render-critical originals in the SAME version as the baseline. Missing old build/capture
// artifacts are reported explicitly; copying what exists must never be mistaken for complete support.
function persistSourceSnapshot({directory, expected, repo, io}) {
  const script = readJson(io, expected.paths.script), assembly = readJson(io, expected.paths.assembly);
  const sourceRoot = join(repo, 'out', expected.identity.name), missing = [], sources = new Map();
  const add = (source, file) => {
    if (!exists(io, source)) { missing.push(file); return; }
    regular(io, source); sources.set(file, source);
  };
  const build = join(sourceRoot, '_build');
  if (exists(io, build)) {
    check(io.lstatSync(build).isDirectory() && io.realpathSync(build) === build, 'baseline_snapshot_unsafe_source');
    // All regular build artifacts include the cards, saved cap/hl masks and original segments.
    // Do not follow symlinks or silently omit nested/unknown build artifacts.
    const walk = (path, prefix) => {
      for (const entry of io.readdirSync(path, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue; // Finder metadata / interrupted temporary copies are not render inputs.
        check(!entry.isSymbolicLink(), 'baseline_snapshot_unsafe_source');
        if (entry.isDirectory()) walk(join(path, entry.name), `${prefix}/${entry.name}`);
        else add(join(path, entry.name), `${prefix}/${entry.name}`);
      }
    };
    walk(build, 'source/_build');
  }
  const required = new Set(['content.mp4', ...assembly.slides.map(s => `seg${String(s.slide).padStart(2, '0')}.mp4`)]);
  if (assembly.intro && assembly.title_card) required.add('intro_title_crossfaded.mp4');
  else if (assembly.title_card) required.add('title_card.mp4'); else if (assembly.intro) required.add('logo_card.mp4');
  if (assembly.intro || assembly.title_card) required.add('body_crossfaded.mp4');
  if (assembly.support_card) required.add('support_card.mp4');
  if (assembly.outro) required.add('logo_card.mp4');
  if (assembly.support_card && assembly.outro) required.add('body_with_support.mp4');
  const reportPath = join(sourceRoot, 'report.json');
  add(reportPath, 'source/report.json');
  const report = exists(io, reportPath) ? readJson(io, reportPath) : {};
  if (!report.no_captions) for (const slide of assembly.slides)
    if (slide._cap_text || slide.caption) required.add(`cap${String(slide.slide).padStart(2, '0')}.png`);
  for (const file of required) if (!sources.has(`source/_build/${file}`)) missing.push(`source/_build/${file}`);
  const recordingId = script.recording?.id;
  if (typeof recordingId !== 'string' || !NAME.test(recordingId)) missing.push('original_recording_identity_missing');
  else {
    const recordingRoot = join(repo, 'out/_recordings', recordingId);
    const media = new Set(script.steps.flatMap(s => Object.values(s.media || {}).filter(v => typeof v === 'string')));
    for (const file of media) {
      check(NAME.test(file), 'baseline_snapshot_unsafe_source');
      add(join(recordingRoot, file), `source/_recordings/${recordingId}/${file}`);
    }
    if (!media.size) missing.push('original_recording_media_missing');
  }
  const files = [];
  for (const [file, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = {file, sha256: hashFile(io, source), size: io.statSync(source).size};
    // Validate relative names BEFORE writing; hashes bind both copies and the still-live source.
    check(file.startsWith('source/') && file.split('/').every(s => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s) && !['.', '..'].includes(s)), 'baseline_snapshot_unsafe_file');
    const target = join(directory, file); io.mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    check(io.realpathSync(dirname(target)) === dirname(target), 'baseline_snapshot_unsafe_source');
    if (exists(io, target)) snapshotFile(io, directory, entry);
    else {
      const temp = join(dirname(target), `.copy-${randomUUID()}.tmp`);
      try {
        io.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
        check(hashFile(io, temp) === entry.sha256, 'baseline_snapshot_hash_mismatch', target);
        const fd = io.openSync(temp, 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
        io.renameSync(temp, target); syncDir(io, dirname(target));
      } finally { if (exists(io, temp)) io.unlinkSync(temp); }
    }
    snapshotFile(io, directory, entry);
    check(hashFile(io, source) === entry.sha256, 'baseline_snapshot_source_changed', source);
    files.push(entry);
  }
  const snapshot = {schema: 1, identity: expected.identity, recordingId: typeof recordingId === 'string' && NAME.test(recordingId) ? recordingId : null,
    complete: missing.length === 0, missing: [...new Set(missing)].sort(), files};
  atomicJson(io, join(directory, 'source-snapshot.json'), snapshot);
  return hashFile(io, join(directory, 'source-snapshot.json'));
}

// drift_update authenticates buildDir against its adjacent ORIGINAL MP4. Pin those bytes too,
// independently of the lossy rebaseline final. The manifest already binds this original SHA.
function pinOriginalRender({directory,expected,io}){
  const target=join(directory,'source',expected.identity.name+'.mp4');
  io.mkdirSync(dirname(target),{recursive:true,mode:0o700});
  check(io.realpathSync(dirname(target))===dirname(target),'baseline_snapshot_unsafe_source');
  if(!exists(io,target)){
    const temp=join(dirname(target),`.original-${randomUUID()}.tmp`);
    try{
      io.copyFileSync(expected.paths.original,temp,fs.constants.COPYFILE_EXCL);
      check(hashFile(io,temp)===expected.identity.originalSha256,'baseline_original_snapshot_mismatch');
      const fd=io.openSync(temp,'r');try{io.fsyncSync(fd);}finally{io.closeSync(fd);}
      io.renameSync(temp,target);syncDir(io,dirname(target));
    }finally{if(exists(io,temp))io.unlinkSync(temp);}
  }
  regular(io,target);check(hashFile(io,target)===expected.identity.originalSha256,'baseline_original_snapshot_mismatch');
  check(hashFile(io,expected.paths.original)===expected.identity.originalSha256,'baseline_original_mismatch');
  return target;
}

/** Hash actual local renderer sources, not a caller's assertion or index's historical loader flag. */
export function currentRenderIdentity({repo, io = fs}) {
  return digest(RENDER_IDENTITY_FILES.map(file => {
    const path = join(repo, file); regular(io, path); return [file, hashFile(io, path)];
  }));
}

// Mirror the existing renderer's baseline/script binding without assigning or inventing stable IDs.
// Missing support (including non-FX legacy videos) is an operational enrollment hold, not re-record advice.
function validateScriptAssembly(name, script, assembly) {
  check(script?.name === name && Array.isArray(script.steps), 'baseline_script_mismatch');
  check(assembly?.fx === true, 'baseline_enrollment_unsupported_non_fx');
  const captures = script.steps.filter(s => s.capture !== false && s.media?.pre);
  check(captures.length > 0 && captures.length === assembly.slides?.length, 'baseline_script_mismatch');
  const indices = new Set();
  for (const [i, step] of captures.entries()) {
    const slide = assembly.slides[i];
    check(Number.isInteger(step.index) && !indices.has(step.index), 'baseline_script_mismatch'); indices.add(step.index);
    const caption = (script.captionsFromNarration ? step.narration : step.caption) || step.narration || '';
    check(slide.step === step.index && slide.src === step.media.pre &&
      (slide.narration || '') === (step.narration || '') && (slide.caption || '') === caption,
    'baseline_script_mismatch');
  }
}
async function sourceIdentity({name, repo, io, getRenderIdentity}) {
  const paths = {script: join(repo, 'scripts', `${name}.script.json`), assembly: join(repo, 'out', name, 'assembly.json'),
    original: join(repo, 'out', name, `${name}.mp4`)};
  for (const path of Object.values(paths)) {
    check(exists(io, path), 'baseline_source_missing', path); regular(io, path);
  }
  // Parse and hash the SAME bytes, so a concurrent edit cannot bind a hash to a different parsed script.
  const scriptBytes = io.readFileSync(paths.script), assemblyBytes = io.readFileSync(paths.assembly);
  const script = JSON.parse(scriptBytes.toString('utf8')), assembly = JSON.parse(assemblyBytes.toString('utf8'));
  validateScriptAssembly(name, script, assembly);
  const identity = {name, originalSha256: hashFile(io, paths.original),
    assemblySha256: createHash('sha256').update(assemblyBytes).digest('hex'),
    scriptSha256: createHash('sha256').update(scriptBytes).digest('hex'), renderSha256: await getRenderIdentity({repo, io})};
  check(HASH.test(identity.renderSha256), 'invalid_render_identity');
  return {identity, paths};
}
function sameIdentity(actual, expected) {
  check(actual?.name === expected.name, 'baseline_identity_mismatch');
  check(actual.originalSha256 === expected.originalSha256, 'baseline_original_mismatch');
  check(actual.assemblySha256 === expected.assemblySha256, 'baseline_assembly_mismatch');
  check(actual.scriptSha256 === expected.scriptSha256, 'baseline_script_mismatch');
  check(actual.renderSha256 === expected.renderSha256, 'baseline_renderer_mismatch');
}

/** Actual existing Python loader; imports only import-safe renderer modules, never assemble.py/tts.py. */
export async function defaultVerifyBaseline({directory, repo, run = runProcess, log = () => {}, timeoutMs = 120_000}) {
  const code = 'import json,sys\nfrom renderer.drift_render import load_rebaseline\nload_rebaseline(sys.argv[1])\nprint(json.dumps({"ok": True}))\n';
  const result = await run(join(repo, '.venv/bin/python'), ['-B', '-c', code, directory], {
    cwd: repo, timeoutMs, log, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
  });
  check(result.code === 0 && !result.timedOut && result.stdout?.trim() === '{"ok": true}',
    'baseline_loader_failed', (result.stderr || result.stdout || '').slice(-2000));
  return true;
}

/** Real rebaseline runner. output must NOT exist; the existing Python implementation creates it exclusively. */
export async function defaultEnrollBaseline({name, repo, output, run = runProcess, log = () => {}, timeoutMs = 30 * 60_000}) {
  const result = await run(join(repo, '.venv/bin/python'), ['-B', '-m', 'renderer.rebaseline', '--repo', repo, '--name', name, '--output', output], {
    cwd: repo, timeoutMs, log, env: {...process.env, TMPDIR: dirname(output), PYTHONDONTWRITEBYTECODE: '1'},
  });
  check(result.code === 0 && !result.timedOut, result.timedOut ? 'baseline_enrollment_timeout' : 'baseline_enrollment_failed',
    (result.stderr || result.stdout || '').slice(-2000));
  return output;
}

function readIndex(io, root) {
  const path = join(root, 'index.json');
  if (!exists(io, path)) return {schema: 2, scope: 'verified_local_legacy_render_enrollment_only', baselines: []};
  const index = readJson(io, path);
  check([1, 2].includes(index?.schema) && Array.isArray(index.baselines), 'baseline_index_schema_unsupported');
  for (const row of index.baselines) {
    check(row && NAME.test(row.name || '') && typeof row.directory === 'string' && HASH.test(row.manifestSha256), 'baseline_index_corrupt');
    check(isAbsolute(row.directory) && within(join(root, row.name), row.directory) && resolve(row.directory) !== join(root, row.name), 'baseline_index_unsafe_directory');
    // Schema 2 may retain untouched schema-1 rows until those names are actually validated/migrated.
    if (row.enrollmentSha256 !== undefined || row.identity !== undefined || row.registrationSchema === 1)
      check(HASH.test(row.enrollmentSha256) && row.identity, 'baseline_index_corrupt');
    if (row.identitySha256 !== undefined)
      check(HASH.test(row.identitySha256) && row.identitySha256 === digest(row.identity), 'baseline_index_corrupt');
  }
  return index;
}

// One registry-wide lock also protects read/modify/rename of the shared index (no lost updates for different names).
// Never expire an alive PID by age: an enrollment can legitimately take a long time.
function ownerDead(owner, host, isAlive) {
  return owner && owner.host === host && Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid);
}
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function acquireLock({root, io, lockTimeoutMs, pollMs, isAlive}) {
  const path = join(root, '.registry.lock'), reaper = join(root, '.registry.reaper');
  const owner = {pid: process.pid, host: os.hostname(), token: randomUUID()}, start = Date.now();
  for (;;) {
    try {
      io.mkdirSync(path, {mode: 0o700});
      try { atomicJson(io, join(path, 'owner.json'), owner); } catch (e) { io.rmSync(path, {recursive: true, force: true}); throw e; }
      return () => {
        const current = readJson(io, join(path, 'owner.json'));
        check(current.token === owner.token, 'baseline_lock_ownership_lost');
        io.rmSync(path, {recursive: true}); syncDir(io, root);
      };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // An incomplete/foreign lock is not evidence that its owner is dead. Leave it alone and hold.
    let current;
    try { current = readJson(io, join(path, 'owner.json')); } catch { current = null; }
    if (ownerDead(current, owner.host, isAlive)) {
      // Serialize stale-lock reclamation and re-read while holding the reaper, avoiding stale-reader races.
      let reaping = false;
      try {
        io.mkdirSync(reaper, {mode: 0o700}); reaping = true;
        const again = readJson(io, join(path, 'owner.json'));
        if (again.token === current.token && ownerDead(again, owner.host, isAlive)) io.rmSync(path, {recursive: true});
      } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
      finally { if (reaping) io.rmSync(reaper, {recursive: true}); }
      if (!exists(io, path)) continue;
    }
    check(Date.now() - start < lockTimeoutMs, 'baseline_registry_busy');
    await sleep(pollMs);
  }
}

async function validateDirectory({directory, expected, io, repo, verifyBaseline, run, log, row = null}) {
  check(io.lstatSync(directory).isDirectory() && io.realpathSync(directory) === resolve(directory), 'unsafe_baseline_directory');
  const manifestPath = join(directory, 'baseline-manifest.json'), verificationPath = join(directory, 'verification.json');
  const manifest = readJson(io, manifestPath), verification = readJson(io, verificationPath);
  const manifestSha256 = hashFile(io, manifestPath);
  check(!row || row.manifestSha256 === manifestSha256, 'baseline_manifest_mismatch');
  check(manifest.schema === 1 && manifest.profile === PROFILE && HASH.test(manifest.profileHash), 'baseline_profile_unsupported');
  check(verification.ok === true && verification.source_unchanged === true, 'baseline_verification_required');
  check(verification.name === expected.identity.name && manifest.original?.name === expected.identity.name, 'baseline_identity_mismatch');
  check(verification.manifest_sha256 === manifestSha256, 'baseline_manifest_mismatch');
  check(manifest.original?.sha256 === expected.identity.originalSha256 && verification.original_sha256 === manifest.original.sha256,
    'baseline_original_mismatch');
  check(manifest.original.file === `out/${expected.identity.name}/${expected.identity.name}.mp4`, 'baseline_original_mismatch');
  check(manifest.assembly?.sha256 === expected.identity.assemblySha256 && manifest.assembly.source_sha256 === expected.identity.assemblySha256,
    'baseline_assembly_mismatch');
  check(manifest.audio?.mode === 'original stream copy', 'baseline_original_audio_required');
  check(manifest.final?.sha256 === verification.final_sha256, 'baseline_final_mismatch');
  for (const phase of ['before', 'after']) {
    const snapshot = verification.source_snapshot?.[phase];
    for (const [path, hash] of [[expected.paths.original, expected.identity.originalSha256], [expected.paths.assembly, expected.identity.assemblySha256]]) {
      check(snapshot?.[path]?.sha256 === hash, 'baseline_source_snapshot_mismatch');
    }
  }
  check(JSON.stringify(verification.source_snapshot.before) === JSON.stringify(verification.source_snapshot.after), 'baseline_source_snapshot_mismatch');
  const entries = [manifest.assembly, manifest.final, ...(manifest.cells || [])];
  check(Array.isArray(manifest.cells) && manifest.cells.length > 0, 'baseline_cells_missing');
  check(new Set(entries.map(e => e.file)).size === entries.length &&
    !entries.some(e => ['baseline-manifest.json', 'verification.json', 'enrollment.json', 'baseline-script.json'].includes(e.file)), 'baseline_duplicate_file');
  check(new Set(manifest.cells.map(c => c.id)).size === manifest.cells.length, 'baseline_duplicate_cell');
  const files = {'baseline-manifest.json': manifestSha256, 'verification.json': hashFile(io, verificationPath)};
  for (const entry of entries) { pinnedFile(io, directory, entry); files[entry.file] = entry.sha256; }
  let enrollment = null, snapshot = null, enrollmentSha256 = null;
  const metadata = join(directory, 'enrollment.json');
  if (exists(io, metadata)) {
    enrollment = readJson(io, metadata); enrollmentSha256 = hashFile(io, metadata);
    check(enrollment.schema === 1 && enrollment.manifestSha256 === manifestSha256, 'baseline_enrollment_corrupt');
    sameIdentity(enrollment.identity, expected.identity);
    check(!row?.enrollmentSha256 || row.enrollmentSha256 === enrollmentSha256, 'baseline_enrollment_mismatch');
    pinnedFile(io, directory, {file: 'baseline-script.json', sha256: expected.identity.scriptSha256});
    files['baseline-script.json'] = expected.identity.scriptSha256;
    if (enrollment.files?.['source-snapshot.json']) {
      files['source-snapshot.json'] = enrollment.files['source-snapshot.json'];
      pinnedFile(io, directory, {file: 'source-snapshot.json', sha256: files['source-snapshot.json']});
      snapshot = readJson(io, join(directory, 'source-snapshot.json'));
      check(snapshot.schema === 1 && Array.isArray(snapshot.files) && Array.isArray(snapshot.missing) &&
        typeof snapshot.complete === 'boolean' && snapshot.complete === (snapshot.missing.length === 0), 'baseline_snapshot_corrupt');
      sameIdentity(snapshot.identity, expected.identity);
      const script = readJson(io, join(directory, 'baseline-script.json'));
      check(snapshot.recordingId === (NAME.test(script.recording?.id || '') ? script.recording.id : null), 'baseline_snapshot_identity_mismatch');
      check(new Set(snapshot.files.map(e => e.file)).size === snapshot.files.length, 'baseline_snapshot_duplicate_file');
      for (const entry of snapshot.files) snapshotFile(io, directory, entry);
    }
    check(digest(Object.entries(enrollment.files || {}).sort()) === digest(Object.entries(files).sort()), 'baseline_enrollment_files_mismatch');
  } else check(!row?.enrollmentSha256, 'baseline_enrollment_missing');
  const loaded = await verifyBaseline({directory, repo, io, run, log, identity: expected.identity});
  check(loaded === true || loaded?.ok === true, 'baseline_loader_failed');
  // A seam or another process must not be able to change artifacts during validation.
  for (const [file, sha256] of Object.entries(files)) pinnedFile(io, directory, {file, sha256});
  for (const entry of snapshot?.files || []) snapshotFile(io, directory, entry);
  if (enrollmentSha256) check(hashFile(io, metadata) === enrollmentSha256, 'baseline_enrollment_mismatch');
  return {manifest, manifestSha256, files, enrollment, snapshot};
}

/**
 * getOrEnrollBaseline({name, repo?, stateRoot?, runRoot?, ensureBaseline?, verifyBaseline?, io?, ...})
 *
 * stateRoot: durable registry root, default <repo>/out/drift-baselines (contains index.json).
 * runRoot: scratch parent OUTSIDE repo, default ~/.hermes/cache/scratch. Python receives a NEW output path.
 * ensureBaseline: injected enrollment function ({name,repo,output,...}); true/default uses Python, false is lookup-only.
 * verifyBaseline: injected actual-loader seam; must explicitly return true/{ok:true}.
 * io: fs-compatible synchronous IO seam; getRenderIdentity/run are also injectable for isolated fast tests.
 *
 * Returns {status:'baseline_ready', directory, rebaselineDir, manifestSha256, identity, enrolled,
 *          reused, resumed, captionLayout?, sourceSnapshot, scriptPath, buildDir, reportPath, recordingsDir,
 *          snapshotComplete, snapshotMissing, fullOriginalImageControlRequired:true}.
 * Source snapshots preserve _build (cards/captions/segments), report, original script and referenced recording
 * media, each hash-bound to enrollment. Missing old artifacts are explicit snapshotMissing operational
 * prerequisites, NEVER evidence requiring a human re-record. Hash-valid snapshots do NOT replace the
 * weekly renderer's full original-image control. Live original video/assembly/script are still identity-checked.
 * Throws BaselineHold for operational prerequisites/corruption.
 * The registry never updates source media/scripts, fixtures, delivery systems, or approval verdicts.
 */
export async function getOrEnrollBaseline({name, repo = REPO, stateRoot, runRoot,
  ensureBaseline = defaultEnrollBaseline, verifyBaseline = defaultVerifyBaseline, io = fs,
  getRenderIdentity = currentRenderIdentity, run = runProcess, log = () => {},
  lockTimeoutMs = 30_000, pollMs = 50, isAlive = processAlive} = {}) {
  let release;
  try {
    check(typeof name === 'string' && NAME.test(name) && !['.', '..'].includes(name), 'invalid_script_name');
    if (ensureBaseline === true) ensureBaseline = defaultEnrollBaseline;
    check(typeof ensureBaseline === 'function' || ensureBaseline === false, 'invalid_baseline_enroller');
    repo = io.realpathSync(resolve(repo));
    const root = resolve(stateRoot || join(repo, 'out/drift-baselines'));
    io.mkdirSync(root, {recursive: true, mode: 0o700});
    check(io.realpathSync(root) === root, 'unsafe_baseline_registry');
    release = await acquireLock({root, io, lockTimeoutMs, pollMs, isAlive});
    const index = readIndex(io, root), expected = await sourceIdentity({name, repo, io, getRenderIdentity});
    const identitySha256 = digest(expected.identity), nameRoot = join(root, name);
    const rows = index.baselines.filter(r => r.name === name), candidates = new Map(rows.map(r => [resolve(r.directory), r]));
    if (exists(io, nameRoot)) {
      check(io.realpathSync(nameRoot) === nameRoot, 'unsafe_baseline_directory');
      for (const entry of io.readdirSync(nameRoot, {withFileTypes: true})) {
        const directory = join(nameRoot, entry.name);
        if (!entry.name.startsWith('.') && entry.isDirectory() && exists(io, join(directory, 'baseline-manifest.json')) && exists(io, join(directory, 'verification.json')) && !candidates.has(directory)) candidates.set(directory, null);
      }
    }
    let chosen = null, lastMismatch = null;
    for (const [directory, row] of candidates) {
      try {
        if (row?.identity) sameIdentity(row.identity, expected.identity);
        const validated = await validateDirectory({directory, expected, io, repo, verifyBaseline, run, log, row});
        chosen = {directory, row, ...validated}; break;
      } catch (e) {
        if (e instanceof BaselineHold && ['baseline_original_mismatch', 'baseline_assembly_mismatch', 'baseline_script_mismatch', 'baseline_renderer_mismatch'].includes(e.code)) lastMismatch = e;
        else throw e; // Missing indexed artifacts, corruption, or loader failure must not trigger a fresh enrollment.
      }
    }
    if (!chosen && lastMismatch) throw lastMismatch;
    const pendingRoot = join(root, '.pending'), pendingPath = join(pendingRoot, `${name}-${identitySha256}.json`);
    if (exists(io, pendingRoot)) check(io.lstatSync(pendingRoot).isDirectory() && io.realpathSync(pendingRoot) === pendingRoot, 'baseline_pending_unsafe');
    let resumed = false, enrolled = false;
    if (!chosen) {
      check(ensureBaseline !== false, 'baseline_enrollment_required');
      const scratch = resolve(runRoot || join(os.homedir(), '.hermes/cache/scratch'));
      io.mkdirSync(scratch, {recursive: true, mode: 0o700});
      const scratchRoot = io.realpathSync(scratch);
      check(!within(repo, scratchRoot), 'baseline_scratch_inside_repo');
      let output;
      if (exists(io, pendingPath)) {
        const pending = readJson(io, pendingPath);
        sameIdentity(pending.identity, expected.identity);
        check(pending.schema === 1 && typeof pending.output === 'string' && within(scratchRoot, pending.output) && !within(repo, pending.output), 'baseline_pending_unsafe');
        // A completed but uncommitted attempt can be resumed; a partial attempt NEVER gets a verification blessing.
        if (exists(io, join(pending.output, 'verification.json'))) { output = pending.output; resumed = true; }
      }
      if (!output) {
        const work = io.mkdtempSync(join(scratchRoot, `baseline-${name}-`)); output = join(work, 'rebaseline');
        io.mkdirSync(pendingRoot, {recursive: true, mode: 0o700});
        atomicJson(io, pendingPath, {schema: 1, identity: expected.identity, output});
        log(`[baseline-registry] ${name}: enrolling original media locally`);
        await ensureBaseline({name, repo, output, stateRoot: root, runRoot: scratchRoot, identity: expected.identity, io, run, log});
      }
      chosen = {directory: output, ...(await validateDirectory({directory: output, expected, io, repo, verifyBaseline, run, log}))};
      enrolled = true;
    }
    // Re-hash live sources and renderer after enrollment/loader, before committing any authorization.
    sameIdentity((await sourceIdentity({name, repo, io, getRenderIdentity})).identity, expected.identity);
    let directory = chosen.directory, validated = chosen;
    const destination = join(nameRoot, chosen.manifestSha256);
    if (!chosen.enrollment || directory !== destination) {
      io.mkdirSync(nameRoot, {recursive: true, mode: 0o700});
      check(io.realpathSync(nameRoot) === nameRoot, 'unsafe_baseline_directory');
      if (exists(io, destination)) {
        validated = await validateDirectory({directory: destination, expected, io, repo, verifyBaseline, run, log});
        if (!validated.enrollment) {
          // A legacy registry may already use the full manifest hash as its directory name.
          // Add ONLY atomic enrollment metadata/a script pin; never overwrite its validated media.
          const scriptPin = join(destination, 'baseline-script.json');
          if (exists(io, scriptPin)) pinnedFile(io, destination, {file: 'baseline-script.json', sha256: expected.identity.scriptSha256});
          else {
            const temp = join(destination, `.script-pin-${randomUUID()}.tmp`);
            try {
              io.copyFileSync(expected.paths.script, temp, fs.constants.COPYFILE_EXCL);
              regular(io, temp); check(hashFile(io, temp) === expected.identity.scriptSha256, 'baseline_script_mismatch');
              const fd = io.openSync(temp, 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
              io.renameSync(temp, scriptPin); syncDir(io, destination);
            } finally { if (exists(io, temp)) io.unlinkSync(temp); }
          }
          const files = {...validated.files, 'baseline-script.json': expected.identity.scriptSha256};
          files['source-snapshot.json'] = persistSourceSnapshot({directory: destination, expected, repo, io});
          atomicJson(io, join(destination, 'enrollment.json'), {schema: 1, identity: expected.identity,
            manifestSha256: validated.manifestSha256, files});
        }
      } else {
        const staging = io.mkdtempSync(join(nameRoot, '.partial-'));
        try {
          const files = {...chosen.files};
          for (const [file, sha256] of Object.entries(files)) {
            io.copyFileSync(join(chosen.directory, file), join(staging, file), fs.constants.COPYFILE_EXCL);
            pinnedFile(io, staging, {file, sha256});
            const fd = io.openSync(join(staging, file), 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
          }
          if (!files['baseline-script.json']) {
            io.copyFileSync(expected.paths.script, join(staging, 'baseline-script.json'), fs.constants.COPYFILE_EXCL);
            pinnedFile(io, staging, {file: 'baseline-script.json', sha256: expected.identity.scriptSha256});
            files['baseline-script.json'] = expected.identity.scriptSha256;
            const fd = io.openSync(join(staging, 'baseline-script.json'), 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
          }
          if (chosen.snapshot) {
            for (const entry of chosen.snapshot.files) {
              const target = join(staging, entry.file); io.mkdirSync(dirname(target), {recursive: true, mode: 0o700});
              io.copyFileSync(join(chosen.directory, entry.file), target, fs.constants.COPYFILE_EXCL);
              snapshotFile(io, staging, entry);
              const fd = io.openSync(target, 'r'); try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
              syncDir(io, dirname(target));
            }
          } else files['source-snapshot.json'] = persistSourceSnapshot({directory: staging, expected, repo, io});
          atomicJson(io, join(staging, 'enrollment.json'), {schema: 1, identity: expected.identity, manifestSha256: chosen.manifestSha256, files});
          validated = await validateDirectory({directory: staging, expected, io, repo, verifyBaseline, run, log});
          io.renameSync(staging, destination); syncDir(io, nameRoot);
        } finally { if (exists(io, staging)) io.rmSync(staging, {recursive: true, force: true}); }
      }
      directory = destination;
    }
    // Validate the exact durable target, not merely the scratch/staging copy.
    validated = await validateDirectory({directory, expected, io, repo, verifyBaseline, run, log});
    sameIdentity((await sourceIdentity({name, repo, io, getRenderIdentity})).identity, expected.identity);
    const originalVideoPath=pinOriginalRender({directory,expected,io});
    const row = {...(chosen.row || {}), registrationSchema: 1, name, directory, manifestSha256: validated.manifestSha256,
      identity: expected.identity, identitySha256, enrollmentSha256: hashFile(io, join(directory, 'enrollment.json')),
      sourceUnchangedVerified: true, copiedCellAndMediaHashesVerified: true, actualRendererLoaderPassed: true};
    // Migrate schema 1 defensively: preserve unrelated legacy rows, mark per-row enrollment rather than inventing identities.
    const next = {...index, schema: 2, baselines: index.baselines.filter(r => !(r.name === name && r.manifestSha256 === row.manifestSha256)).concat(row)};
    if (JSON.stringify(next) !== JSON.stringify(index)) atomicJson(io, join(root, 'index.json'), next);
    const committed = readIndex(io, root).baselines.find(r => r.name === name && r.directory === directory);
    check(committed?.manifestSha256 === row.manifestSha256 && committed.enrollmentSha256 === row.enrollmentSha256, 'baseline_index_commit_failed');
    if (exists(io, pendingPath)) { io.unlinkSync(pendingPath); syncDir(io, pendingRoot); }
    const sourceSnapshot = {...snapshotInputs(directory, validated.snapshot),originalVideoPath,originalVideoSha256:expected.identity.originalSha256};
    return {status: 'baseline_ready', name, directory, rebaselineDir: directory, manifestSha256: row.manifestSha256,
      identity: expected.identity, identitySha256, enrolled, reused: !enrolled, resumed, sourceSnapshot,
      scriptPath: sourceSnapshot.scriptPath, buildDir: sourceSnapshot.buildDir, reportPath: sourceSnapshot.reportPath,
      recordingsDir: sourceSnapshot.recordingsDir, snapshotComplete: sourceSnapshot.complete, snapshotMissing: sourceSnapshot.missing,
      fullOriginalImageControlRequired: true,
      ...(row.captionLayout ? {captionLayout: row.captionLayout} : {})};
  } catch (e) {
    if (e instanceof BaselineHold) throw e;
    throw new BaselineHold('baseline_operational_error', e.message, e);
  } finally {
    if (release) {
      try { release(); }
      catch (e) { throw e instanceof BaselineHold ? e : new BaselineHold('baseline_lock_release_failed', e.message, e); }
    }
  }
}
