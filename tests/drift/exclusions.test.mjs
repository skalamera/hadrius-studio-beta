// Temporary exclusions (tools/drift/exclusions.json + exclusions.mjs): rule matching (module, case-insensitive; route-
// inferred module for scripts without one, via the bridge's shared modules.mjs; optional topicModule = the walkthrough's
// routes/inferred area), and every
// drift path: weekly runner name selection (allowlist + explicit names), PR early checks, weekly submit, executor.
// Synthetic scripts and fakes only (plus read-only counts over the real allowlist when present).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { loadExclusions, parseExclusions, exclusionFor, partitionNames, moduleOf, topicModulesOf, EXCLUSIONS_PATH, repoScriptReader } from '../../tools/drift/exclusions.mjs';
import { resolveModuleSync, explicitModule, EXTRA_RENDER_MODULES } from '../../tools/drift/modules.mjs';
import { runWeekly, parseNames } from '../../tools/drift/weekly.mjs';
import { createWeeklyRunner, createEarlyCheckQueue, makeExcluder } from '../../tools/drift/weekly-runner.mjs';
import { prepareSubmissions, humanSummary } from '../../tools/drift/weekly-submit.mjs';
import { executeJob, pollOnce } from '../../tools/drift/executor.mjs';
import { confirmedRelease } from './release-fixture.mjs';
import { selectWeeklyJobs } from '../../tools/drift/ui-selection.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const RULE = 'module:Employee Training+topic:Marketing';
const EX = parseExclusions({ rules: [{ module: 'Employee Training', topicModule: 'Marketing', reason: 'Marketing-Review Employee Training videos handled by someone else (temporary)' }], addedAt: '2026-10-30', addedBy: 't' });
const LEGACY = parseExclusions({ modules: ['Marketing'], reason: 'legacy' });
const sc = (name, { module, url = 'https://app.hadrius.com/testing-program/x?company_id=1048' } = {}) => ({ name, title: name, ...(module !== undefined ? { module } : {}), recording: { id: `rec-${name}` }, environment: { startUrl: url },
  steps: [{ index: 0, action: 'navigate', url, media: { pre: 's0.png' }, narration: 'n' }] });
const MKT = 'https://app.hadrius.com/marketing/projects?company_id=1048';

test('exclusions.json: the shipped config excludes only Marketing-Review Employee Training videos (Marketing is included)', () => {
  const e = loadExclusions(EXCLUSIONS_PATH);
  assert.deepEqual(e.rules.map((r) => ({ module: r.module, topicModule: r.topicModule, id: r.id })), [{ module: 'Employee Training', topicModule: 'Marketing', id: RULE }]);
  assert.match(e.rules[0].reason, /someone else/i); assert.ok(e.addedAt && e.addedBy);
  assert.equal(exclusionFor(sc('m', { module: 'Marketing', url: MKT }), e), null, 'Marketing Review videos are included again');
  assert.deepEqual(loadExclusions(join(tmpdir(), 'no-such-exclusions.json')).rules, [], 'missing file = nothing excluded');
  assert.throws(() => parseExclusions('{"modules":"Marketing"}'), /modules_invalid/); assert.throws(() => parseExclusions('{"rules":[{"topicModule":"Marketing"}]}'), /rules_invalid/); assert.throws(() => parseExclusions('nope'));
});

test('rule module+topic: Employee Training (case-insensitive) AND about Marketing Review; other Employee Training videos stay', () => {
  const hit = exclusionFor(sc('a', { module: 'Employee Training', url: MKT }), EX);
  assert.equal(hit.rule, RULE); assert.equal(hit.topicModule, 'Marketing'); assert.match(hit.reason, /Marketing-Review/);
  assert.equal(exclusionFor(sc('b', { module: 'employee training', url: MKT }), EX).rule, RULE);
  // one step under /marketing is enough (start URL elsewhere)
  const mixed = sc('c', { module: 'Employee Training', url: 'https://app.hadrius.com/people-oversight/x' }); mixed.steps.push({ index: 1, action: 'navigate', url: 'https://app.hadrius.com/marketing/projects', value: 'https://app.hadrius.com/marketing/projects' });
  assert.equal(exclusionFor(mixed, EX).rule, RULE); assert.ok(topicModulesOf(mixed).includes('Marketing'));
  assert.equal(exclusionFor(sc('d', { module: 'Employee Training', url: 'https://app.hadrius.com/people-oversight/x' }), EX), null, 'Employee Training about another area stays');
  assert.equal(exclusionFor(sc('e', { module: 'Marketing', url: MKT }), EX), null, 'Marketing Review itself is included');
  assert.equal(exclusionFor(sc('f', { url: MKT }), EX), null, 'no module -> inferred Marketing, not Employee Training');
  assert.equal(exclusionFor(sc('g', { module: 'Testing program', url: MKT }), EX), null);
  assert.equal(exclusionFor(sc('h', { module: 'Employee Training', url: MKT }), { rules: [] }), null, 'no rules = nothing excluded');
  assert.equal(exclusionFor(null, EX), null);
  assert.deepEqual(moduleOf(sc('i', { url: MKT })), { module: 'Marketing', source: 'inferred' });
});
test('legacy module-only rules still work (route inference for scripts without a module)', () => {
  assert.equal(exclusionFor(sc('a', { module: 'marketing' }), LEGACY).rule, 'module:Marketing');
  const inf = exclusionFor(sc('b', { url: MKT }), LEGACY); assert.equal(inf.rule, 'module:Marketing'); assert.equal(inf.moduleSource, 'inferred');
  assert.equal(exclusionFor(sc('c', { module: '', url: MKT }), LEGACY).moduleSource, 'inferred', 'empty module = no module');
  assert.equal(exclusionFor(sc('d', { module: 'Testing program', url: MKT }), LEGACY), null, 'an explicit other module is not re-inferred');
  assert.equal(exclusionFor(sc('e', { module: 'Marketing' }), { modules: ['Marketing'] }).rule, 'module:Marketing', 'unparsed legacy object accepted');
});

test('modules.mjs = the bridge resolution order (explicit -> coverage -> inferred -> raw)', () => {
  assert.deepEqual(EXTRA_RENDER_MODULES, ['Platform', 'Employee Training', 'Other']);
  assert.equal(explicitModule('testing PROGRAM'), 'Testing program'); assert.equal(explicitModule('platform'), 'Platform'); assert.equal(explicitModule('Nope'), null);
  assert.deepEqual(resolveModuleSync(sc('a', { module: 'Platform', url: MKT })), { module: 'Platform', inferred: false, source: 'script' });
  assert.deepEqual(resolveModuleSync(sc('b', { url: MKT }), 'Branches'), { module: 'Branches', inferred: false, source: 'coverage' });
  assert.deepEqual(resolveModuleSync(sc('c', { url: MKT })), { module: 'Marketing', inferred: true, source: 'inferred' });
  assert.deepEqual(resolveModuleSync({ module: 'Weird', steps: [] }), { module: 'Weird', inferred: false, source: 'raw' });
  // The bridge imports these instead of keeping its own copies (no forked logic).
  const bridge = readFileSync(join(REPO, 'tools', 'ai-bridge.mjs'), 'utf8');
  assert.match(bridge, /import \{ EXTRA_RENDER_MODULES, explicitModule, resolveModuleSync \} from '\.\/drift\/modules\.mjs'/);
  assert.doesNotMatch(bridge, /const EXTRA_RENDER_MODULES =/); assert.doesNotMatch(bridge, /function explicitModule\(/);
});

test('partitionNames: kept vs excluded with per-rule counts; unreadable scripts are kept (reported later as missing)', () => {
  const scripts = { A: sc('A', { module: 'Marketing', url: MKT }), B: sc('B', { url: MKT }), C: sc('C', { module: 'Employee Training' }), D: sc('D', { module: 'Employee Training', url: MKT }) };
  const p = partitionNames(['A', 'B', 'C', 'D', 'Missing'], { readScript: (n) => scripts[n] ?? null, exclusions: EX });
  assert.deepEqual(p.kept, ['A', 'B', 'C', 'Missing']); assert.deepEqual(p.excluded.map((x) => x.name), ['D']);
  assert.deepEqual(p.counts, { [RULE]: 1 });
  assert.deepEqual(partitionNames(['A', 'B', 'D'], { readScript: (n) => scripts[n] ?? null, exclusions: LEGACY }).counts, { 'module:Marketing': 2 });
});

// ---------- weekly runner (weekly.mjs) ----------
function fx() {
  const root = mkdtempSync(join(tmpdir(), 'drift-excl-')); const scripts = { Keep: sc('Keep'), Mkt: sc('Mkt', { module: 'Employee Training', url: MKT }), MktInferred: sc('MktInferred', { module: 'employee training', url: MKT }), Emp: sc('Emp', { module: 'Employee Training' }), MR: sc('MR', { module: 'Marketing', url: MKT }) };
  const calls = [];
  const deps = { recordingsRoot: join(root, 'rec'), judge: null, bridgeStatus: async () => ({ running: false }), exclusions: EX,
    readScript: (n) => (scripts[n] ? { path: join(root, `${n}.script.json`), script: scripts[n] } : null),
    capture: async ({ scriptPath, outDir }) => { calls.push(scriptPath.split('/').pop()); mkdirSync(outDir); return { status: 'session_failed', steps: [] }; },
    compare: async () => ({}), classify: async () => ({ verdict: 'unchanged', steps: [] }), candidate: async () => ({}) };
  return { root, scripts, calls, deps };
}
test('runWeekly: allowlist and explicit names matching a rule are skipped with reason "excluded", never captured; counts per rule', async () => {
  const f = fx();
  const s = await runWeekly({ names: ['Keep', 'Mkt', 'MktInferred', 'Emp', 'MR'], outDir: join(f.root, 'out'), deps: f.deps, log: () => {} });
  assert.deepEqual(f.calls, ['Keep.script.json', 'Emp.script.json', 'MR.script.json'], 'other Employee Training + Marketing Review videos run');
  const by = Object.fromEntries(s.videos.map((v) => [v.name, v]));
  for (const n of ['Mkt', 'MktInferred']) { assert.equal(by[n].status, 'excluded'); const j = JSON.parse(readFileSync(join(f.root, 'out', n, 'job.json'), 'utf8')); assert.equal(j.reason, 'excluded'); assert.equal(j.exclusion.rule, RULE); }
  assert.equal(by.Mkt.exclusion.topicModule, 'Marketing');
  assert.deepEqual(s.excluded.byRule, { [RULE]: 2 }); assert.equal(s.excluded.count, 2);
  assert.deepEqual(s.exclusions.rules.map((r) => r.id), [RULE]);
  // the exclusion is config: with an empty list the same names run
  const f2 = fx(); f2.deps.exclusions = { rules: [] };
  await runWeekly({ names: ['Keep', 'Mkt'], outDir: join(f2.root, 'out'), deps: f2.deps, log: () => {} });
  assert.deepEqual(f2.calls, ['Keep.script.json', 'Mkt.script.json']);
});
test('runWeekly --resume: finished videos are kept, an unfinished one is moved aside and re-run', async () => {
  const f = fx(); const out = join(f.root, 'out');
  await runWeekly({ names: ['Keep', 'Mkt'], outDir: out, deps: f.deps, log: () => {} });
  // simulate a crash mid-video: a new name whose job is still "running"
  f.scripts.Keep2 = sc('Keep2'); mkdirSync(join(out, 'Keep2')); writeFileSync(join(out, 'Keep2', 'job.json'), JSON.stringify({ name: 'Keep2', status: 'running' }));
  f.calls.length = 0;
  await assert.rejects(runWeekly({ names: ['Keep'], outDir: out, deps: f.deps, log: () => {} }), /output_exists/);
  const s = await runWeekly({ names: ['Keep', 'Mkt', 'Keep2'], outDir: out, deps: f.deps, resume: true, log: () => {} });
  assert.deepEqual(f.calls, ['Keep2.script.json'], 'only the unfinished video runs again');
  assert.ok(existsSync(join(out, 'Keep2.interrupted-1', 'job.json')));
  assert.equal(s.videos.length, 3); assert.equal(s.resumes.length, 1); assert.equal(s.resumes[0].alreadyDone, 2);
});

test('runWeekly: a sign-in that needs a human (invalid_credentials) stops further sign-ins for that tenant only, also across --resume', async () => {
  const f = fx(); const ACA = 'https://app.hadrius.com/testing-program/x?company_id=1150';
  f.scripts.A1 = sc('A1', { url: ACA }); f.scripts.A2 = sc('A2', { url: ACA }); f.scripts.A3 = sc('A3', { url: ACA });
  f.deps.capture = async ({ scriptPath, outDir }) => { const n = scriptPath.split('/').pop().replace('.script.json', ''); f.calls.push(n); mkdirSync(outDir);
    return n === 'A1' ? { status: 'session_failed', session: { status: 'invalid_credentials' }, steps: [] } : { status: 'session_failed', session: { status: 'unexpected' }, steps: [] }; };
  const out = join(f.root, 'out');
  const s = await runWeekly({ names: ['A1', 'Keep', 'A2'], outDir: out, deps: f.deps, log: () => {} });
  assert.deepEqual(f.calls, ['A1', 'Keep'], 'A2 never tries to sign in');
  assert.deepEqual(s.tenantBlocked.academy.status, 'invalid_credentials');
  const a2 = JSON.parse(readFileSync(join(out, 'A2', 'job.json'), 'utf8')); assert.equal(a2.captureStatus, 'session_blocked'); assert.match(a2.errors[0].error, /tenant_session_blocked:invalid_credentials/);
  f.calls.length = 0;
  const r = await runWeekly({ names: ['A1', 'Keep', 'A2', 'A3'], outDir: out, deps: f.deps, resume: true, log: () => {} });
  assert.deepEqual(f.calls, [], 'resume keeps the block (A3 not attempted either)'); assert.equal(r.videos.find((v) => v.name === 'A3').status, 'capture_failed');
  // a per-video tenant check failure (no password submitted) does not block the tenant
  const g = fx(); g.scripts.B1 = sc('B1'); g.scripts.B2 = sc('B2');
  g.deps.capture = async ({ scriptPath, outDir }) => { const n = scriptPath.split('/').pop().replace('.script.json', ''); g.calls.push(n); mkdirSync(outDir); return { status: 'session_failed', session: { status: 'tenant_mismatch' }, steps: [] }; };
  const s2 = await runWeekly({ names: ['B1', 'B2'], outDir: join(g.root, 'out'), deps: g.deps, log: () => {} });
  assert.deepEqual(g.calls, ['B1', 'B2']); assert.deepEqual(s2.tenantBlocked, {});
});

// ---------- bridge runner + PR early checks ----------
const fakeSpawn = (calls) => (cmd, args, opts) => { const c = new EventEmitter(); c.pid = 4243; c.kill = () => {}; calls.push({ cmd, args, opts, child: c }); return c; };
test('runner: excluded names shape the timeout/status; a run with only excluded names is not started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-excl-run-')); const calls = [];
  const scripts = { Keep: sc('Keep'), Mkt: sc('Mkt', { module: 'Employee Training', url: MKT }) };
  const r = createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn(calls), env: { PATH: '/bin' }, exclusionsLoader: () => EX, readScript: (n) => scripts[n] ?? null });
  const none = r.start({ names: ['Mkt'] }); assert.equal(none.started, false); assert.equal(none.error, 'all_excluded'); assert.deepEqual(none.excluded, [{ name: 'Mkt', rule: RULE, reason: 'excluded' }]);
  assert.equal(calls.length, 0);
  const a = r.start({ names: ['Keep', 'Mkt'] }); assert.equal(a.started, true);
  assert.deepEqual(a.run.excluded.map((x) => x.name), ['Mkt']); assert.equal(a.run.timeoutMs, 1 * 16 * 60_000 + 5 * 60_000, 'timeout counts only the videos that will run');
  assert.match(readFileSync(join(dir, 'w.log'), 'utf8'), /1 excluded/);
  const bad = createWeeklyRunner({ repo: '/repo', scratch: mkdtempSync(join(tmpdir(), 'drift-excl-run-')), logPath: join(dir, 'w2.log'), spawnImpl: fakeSpawn([]), exclusionsLoader: () => { throw new Error('broken'); } });
  assert.match(bad.start({ names: ['Keep'] }).error, /^exclusions_unreadable/, 'fail closed');
});
test('PR early checks: excluded videos are recorded as "excluded" and never queued; queued ones dropped at take()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-excl-q-')); let t = new Date('2026-10-30T10:00:00Z');
  const q = createEarlyCheckQueue({ statePath: join(dir, 'q.json'), debounceMs: 60_000, maxPerDay: 6, now: () => t });
  const scripts = { Keep: sc('Keep'), Mkt: sc('Mkt', { module: 'Employee Training', url: MKT }), Later: sc('Later', { module: 'Branches' }) };
  let ex = EX; const exclude = makeExcluder({ repo: '/repo', exclusionsLoader: () => ex, readScript: (n) => scripts[n] ?? null });
  const r = q.enqueue([{ name: 'Keep', pr: { number: 1 } }, { name: 'Mkt', pr: { number: 1 } }, { name: 'Later' }], { allowed: new Set(['Keep', 'Mkt', 'Later']), exclude });
  assert.deepEqual(r.added, ['Keep', 'Later']); assert.deepEqual(r.excluded, ['Mkt']);
  assert.ok(q.state().skipped.some((s) => s.name === 'Mkt' && s.reason === 'excluded' && s.rule === RULE));
  ex = { modules: ['Branches'] }; t = new Date('2026-10-30T10:05:00Z');
  const b = q.take({ exclude }); assert.deepEqual(b.names, ['Keep'], 'Later became excluded after it was queued');
  assert.ok(q.state().skipped.some((s) => s.name === 'Later' && s.reason === 'excluded'));
});

// ---------- weekly submit ----------
test('submit: excluded videos are never posted (excluded job, or an older run of a now-excluded video)', () => {
  const release = confirmedRelease();
  const okJob = (name) => ({ name, status: 'ok', verdict: 'full_rerecord', complete: true, reasons: [], steps: [{ index: 0, action: 'navigate', verdict: 'full_rerecord', reasons: [{ verdict: 'full_rerecord', code: 'page_redesigned', detail: 'x' }], uiReleaseEvidence: release, evidence: {} }] });
  const jobs = { Keep: okJob('Keep'), OldMkt: okJob('OldMkt'), Mkt: { name: 'Mkt', status: 'excluded', exclusion: { rule: 'module:Marketing' } } };
  const scripts = { Keep: sc('Keep'), OldMkt: sc('OldMkt', { module: 'Employee Training', url: MKT }), Mkt: sc('Mkt', { module: 'Employee Training', url: MKT }) };
  const io = { readJson: (p) => jobs[p.split('/').at(-2)] ?? null, readScript: (n) => scripts[n] ?? null, readAssembly: () => null };
  const exclude = (n) => exclusionFor(scripts[n], EX);
  const batch=selectWeeklyJobs(Object.values(jobs),{readScript:io.readScript});
  const rows = prepareSubmissions({ summary: { finishedAt: '2026-10-31T20:00:00Z',uiSelection:{policy:batch.policy,status:'finalized',inputHash:batch.inputHash,names:batch.names}, videos: [{ name: 'Keep' }, { name: 'OldMkt' }, { name: 'Mkt' }] }, runDir: '/r', io, exclude });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.Keep.decision, 'post'); assert.equal(by.OldMkt.decision, 'excluded'); assert.equal(by.Mkt.decision, 'excluded');
  assert.equal(by.OldMkt.payload, undefined, 'no payload is even built'); assert.match(by.OldMkt.reason, /module:Employee Training\+topic:Marketing/);
  assert.match(humanSummary(rows, { runDir: '/r', dryRun: true }), /Excluded: 2/);
  const noEx = prepareSubmissions({ summary: { finishedAt: '2026-10-31T20:00:00Z', videos: [{ name: 'Mkt' }] }, runDir: '/r', io });
  assert.equal(noEx[0].decision, 'excluded', 'an excluded job.json is excluded even without the live config');
});

// ---------- executor ----------
function execDeps(stateRoot, { script }) {
  const calls = { progress: [], note: [], list: 0 };
  return { calls, deps: {
    stateRoot, whoami: 'tester', log: () => {}, exclusions: EX, readScriptForExclusion: () => script,
    jobs: { progress: async (a) => { calls.progress.push(a); return { job: {} }; }, note: async (a) => { calls.note.push(a); }, list: async () => { calls.list++; return { jobs: [] }; } },
    render: async () => { throw new Error('must not render'); }, rebaseline: async () => { throw new Error('must not rebaseline'); },
  } };
}
test('executor: an APPROVED job for an excluded video is not executed, stays approved, gets one note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-excl-exec-'));
  const job = { id: '11111111-2222-3333-4444-555555555555', kind: 'auto_update', status: 'approved', video_name: 'Mkt', version: 3, slack_ts: '1.2', details: {} };
  const { calls, deps } = execDeps(root, { script: sc('Mkt', { module: 'Employee Training', url: MKT }) });
  const r = await executeJob(job, deps);
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, `excluded:${RULE}`);
  assert.equal(calls.progress.length, 0, 'never claimed: stays approved');
  assert.equal(calls.note.length, 1); assert.match(calls.note[0].note, /temporarily excluded/);
  await executeJob(job, deps); assert.equal(calls.note.length, 1, 'the note is posted once per job');
  // not excluded -> goes on to the claim (here: fails later, that's fine for this test)
  const other = execDeps(root, { script: sc('Keep') });
  const r2 = await executeJob({ ...job, id: '11111111-2222-3333-4444-666666666666', video_name: 'Keep' }, other.deps).catch((e) => ({ status: 'threw', e }));
  assert.ok(other.calls.progress.length >= 1 || r2.status !== 'skipped', 'a non-excluded job is claimed');
  // unreadable exclusions: fail closed
  const broken = execDeps(root, { script: sc('Keep') }); broken.deps.exclusions = undefined; broken.deps.readScriptForExclusion = () => { throw new Error('io'); };
  const r3 = await executeJob({ ...job, id: '11111111-2222-3333-4444-777777777777' }, broken.deps);
  assert.match(r3.reason, /^exclusions_unreadable/); assert.equal(broken.calls.progress.length, 0);
});

// ---------- real allowlist (read-only; skipped when scripts are not on this machine) ----------
test('real scripts: the rule matches Reviewing-AI-Flags-on-a-Project-Submission; the Academy + Sandbox allowlist keeps everything else', { skip: !existsSync(join(REPO, 'scripts', 'Reviewing-AI-Flags-on-a-Project-Submission.script.json')) }, () => {
  const ex = loadExclusions(); const read = repoScriptReader(REPO);
  assert.equal(exclusionFor(read('Reviewing-AI-Flags-on-a-Project-Submission'), ex)?.rule, RULE);
  const names = parseNames({ allowlistText: readFileSync(join(REPO, 'tools', 'drift', 'allowlist.json'), 'utf8') });
  const p = partitionNames(names, { readScript: read, exclusions: ex });
  for (const x of p.excluded) assert.equal(x.rule, RULE);
  assert.equal(p.kept.length + p.excluded.length, names.length);
});
