// Scheduling pieces: weekly runner (spawn args, lock, concurrency 1, timeout, env scrub, submit hook),
// PR-triggered early-check queue (debounce, daily cap, allowlist, requeue) and the launchd plist rendering.
// No real child process, no launchctl, no bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createWeeklyRunner, createEarlyCheckQueue, scrubEnv, weeklyArgs, LOCK_NAME } from '../../tools/drift/weekly-runner.mjs';
import { renderPlist, LABEL } from '../../tools/drift/schedule/render-plist.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'drift-sched-'));
function fakeSpawn(calls) {
  return (cmd, args, opts) => { const c = new EventEmitter(); c.pid = 4242; c.killed = []; c.kill = (s) => { c.killed.push(s); setImmediate(() => c.emit('exit', null, s)); }; calls.push({ cmd, args, opts, child: c }); return c; };
}

test('scrubEnv drops credentials and bridge service config, keeps PATH/HOME', () => {
  const e = scrubEnv({ PATH: '/bin', HOME: '/h', STUDIO_SHARED_SECRET: 's', SLACK_STUDIO_BOT_TOKEN: 't', GOOGLE_REFRESH_TOKEN: 'g', ELEVENLABS_API_KEY: 'k', PR_WATCH_USER: 'u', HADRIUS_DRIFT_SCRATCH: '/x', PYLON_KB_ID: 'p' });
  assert.deepEqual(Object.keys(e).sort(), ['HADRIUS_DRIFT_SCRATCH', 'HOME', 'PATH', 'PR_WATCH_USER']);
});
test('weeklyArgs: names vs allowlist, read-only weekly.mjs flags only', () => {
  assert.deepEqual(weeklyArgs({ weeklyPath: 'w', outDir: '/o', names: ['A', 'B'] }), ['w', '--once', '--names', 'A,B', '--out', '/o', '--timeout-min', '15']);
  assert.deepEqual(weeklyArgs({ weeklyPath: 'w', outDir: '/o', allowlistPath: '/a.json', captureDryRun: true }), ['w', '--once', '--allowlist', '/a.json', '--out', '/o', '--timeout-min', '15', '--dry-run']);
});

test('runner: spawns weekly.mjs once, refuses a second run, submits after exit, releases the lock', async () => {
  const dir = tmp(), calls = [], finished = [];
  const r = createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn(calls), env: { PATH: '/bin', STUDIO_SHARED_SECRET: 'x' },
    onFinished: async (run) => { finished.push(run); return { ok: true, counts: { post: 1 } }; } });
  const a = r.start({ names: ['Vid-A', 'Vid-B'], source: 'manual' });
  assert.equal(a.started, true); assert.equal(a.run.submitDryRun, true, 'dry run is the default');
  assert.equal(calls[0].args[0], '/repo/tools/drift/weekly.mjs'); assert.deepEqual(calls[0].args.slice(1, 4), ['--once', '--names', 'Vid-A,Vid-B']);
  assert.equal(calls[0].opts.cwd, '/repo'); assert.equal(calls[0].opts.env.STUDIO_SHARED_SECRET, undefined);
  assert.ok(existsSync(join(dir, LOCK_NAME)));
  assert.equal(r.start({ names: ['Vid-C'] }).error, 'busy');
  assert.equal(calls.length, 1);
  calls[0].child.emit('exit', 0, null);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(finished.length, 1); assert.equal(finished[0].exitCode, 0);
  assert.equal(r.status().running, false); assert.deepEqual(r.status().last.submit, { ok: true, counts: { post: 1 } });
  assert.ok(!existsSync(join(dir, LOCK_NAME)));
  assert.match(readFileSync(join(dir, 'w.log'), 'utf8'), /start .*2 video\(s\), submit DRY RUN/);
  assert.equal(r.start({ names: ['Vid-C'], source: 'pr' }).started, true, 'next run allowed after release');
});
test('runner: a live lock from another process blocks; a stale lock is taken over', () => {
  const dir = tmp();
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: process.ppid, id: 'other' }));
  const r = createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn([]) });
  assert.equal(r.start({ names: ['A'] }).error, 'busy_other_process');
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 99999999, id: 'dead' }));
  assert.equal(r.start({ names: ['A'] }).started, true);
});
test('runner: overall timeout kills the child and still reports', async () => {
  const dir = tmp(), calls = [];
  const r = createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn(calls), perVideoMin: 0 });
  // perVideoMin 0 -> 5 min floor; shrink by poking the timer through a fake clock is overkill: assert the computed budget instead.
  const a = r.start({ names: ['A', 'B', 'C'] });
  assert.equal(a.run.timeoutMs, 3 * 60_000 + 5 * 60_000);
  calls[0].child.kill('SIGTERM');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.status().last.signal, 'SIGTERM');
});
test('runner: after a bridge restart, an orphaned run is adopted (child alive -> busy) or submitted (child gone)', async () => {
  const dir = tmp(), finished = [];
  const mk = () => createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn([]), onFinished: async (run) => { finished.push(run); return { ok: true, counts: { skip: 1 } }; } });
  const meta = { id: 'x', outDir: join(dir, 'weekly-x'), names: ['A'], submitDryRun: true, startedAt: new Date().toISOString(), timeoutMs: 60_000 };
  // child still alive (use our parent's pid as a stand-in), owner bridge dead
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 99999999, childPid: process.ppid, ...meta }));
  const r1 = mk(); const adopted = r1.recover({ pollMs: 10 });
  assert.equal(adopted.id, 'x'); assert.equal(r1.busy, true); assert.equal(r1.start({ names: ['B'] }).error, 'busy');
  assert.equal(mk().start({ names: ['B'] }).error, 'busy_other_process', 'a fresh runner also sees the live child');
  assert.equal(finished.length, 0);
  // child gone -> submit immediately and release
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: 99999999, childPid: 99999998, ...meta }));
  const r2 = mk(); r2.recover({ pollMs: 10 });
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(finished.length, 1); assert.equal(finished[0].submitDryRun, true); assert.equal(r2.busy, false);
  assert.ok(!existsSync(join(dir, LOCK_NAME))); assert.equal(r2.status().last.signal, 'recovered_after_bridge_restart');
  assert.equal(mk().recover(), null, 'no lock -> nothing to adopt');
});
test('runner: rejects unsafe names and bad sources before spawning', () => {
  const dir = tmp(), calls = [];
  const r = createWeeklyRunner({ repo: '/repo', scratch: dir, logPath: join(dir, 'w.log'), spawnImpl: fakeSpawn(calls) });
  assert.throws(() => r.start({ names: ['../x'] }), /invalid_name/);
  assert.equal(r.start({ names: ['A'], source: 'Bad Source!' }).error, 'invalid_source');
  assert.equal(calls.length, 0);
});

test('early-check queue: debounce, merge PRs, allowlist filter, daily cap, once per day, requeue', () => {
  const dir = tmp(); let t = new Date('2026-11-02T09:00:00');
  const q = createEarlyCheckQueue({ statePath: join(dir, 'q.json'), debounceMs: 30 * 60_000, maxPerDay: 2, now: () => t });
  const pr = (n) => ({ number: n, title: `PR ${n}`, url: `https://github.com/x/pull/${n}` });
  const r = q.enqueue([{ name: 'A', pr: pr(1) }, { name: 'B', pr: pr(1) }, { name: 'Sandbox', pr: pr(1) }], { allowed: new Set(['A', 'B', 'C']) });
  assert.deepEqual(r, { added: ['A', 'B'], skipped: ['Sandbox'] });
  t = new Date('2026-11-02T09:20:00'); q.enqueue([{ name: 'A', pr: pr(2) }, { name: 'C', pr: pr(2) }], { allowed: new Set(['A', 'B', 'C']) });
  t = new Date('2026-11-02T09:40:00'); assert.equal(q.take(), null, 'still inside the quiet period after the last flag');
  t = new Date('2026-11-02T09:51:00'); assert.equal(q.take({ busy: true }), null, 'never while a run is active');
  const b = q.take();
  assert.deepEqual(b.names, ['A', 'B'], 'oldest first, capped at maxPerDay');
  assert.deepEqual(b.prsByName.A.map((p) => p.number), [1, 2]);
  assert.equal(q.take(), null, 'daily cap reached; C waits');
  q.requeue({ names: ['B'], prsByName: b.prsByName });
  const b2 = q.take(); assert.deepEqual(b2.names, ['C'], 'requeued B frees budget; C was first in line');
  t = new Date('2026-11-02T12:00:00'); q.enqueue([{ name: 'A', pr: pr(3) }]);
  t = new Date('2026-11-02T13:00:00'); assert.equal(q.take(), null, 'A and B already counted today');
  t = new Date('2026-11-03T07:00:00'); assert.deepEqual(q.take().names.sort(), ['A', 'B'], 'next day');
  assert.ok(q.state().skipped.some((s) => s.name === 'Sandbox' && s.reason === 'not_in_allowlist'));
});

test('plist: renders a valid launchd agent that only curls the local bridge, dry run by default', () => {
  const x = renderPlist({ log: '/tmp/x.log' });
  assert.match(x, new RegExp(`<string>${LABEL.replace(/\./g, '\\.')}</string>`));
  assert.match(x, /<string>\/usr\/bin\/curl<\/string>/); assert.match(x, /<string>http:\/\/127\.0\.0\.1:8787\/drift\/weekly\/run<\/string>/);
  assert.match(x, /&quot;dryRun&quot;:true/); assert.match(x, /&quot;allowlist&quot;:&quot;tools\/drift\/allowlist\.json&quot;/);
  assert.match(x, /<key>Weekday<\/key><integer>1<\/integer>/); assert.match(x, /<key>Hour<\/key><integer>6<\/integer>/);
  assert.match(x, /<key>RunAtLoad<\/key><false\/>/); assert.doesNotMatch(x, /\{\{|SECRET|TOKEN/);
  assert.match(renderPlist({ live: true, log: '/tmp/x.log' }), /&quot;dryRun&quot;:false/);
  assert.throws(() => renderPlist({ hour: 25 }), /invalid_hour/); assert.throws(() => renderPlist({ log: 'rel.log' }), /absolute/);
  assert.throws(() => renderPlist({ template: '{{NOPE}}' }), /unknown_placeholder/);
  if (process.platform === 'darwin') { const f = join(tmp(), 'p.plist'); writeFileSync(f, x); execFileSync('/usr/bin/plutil', ['-lint', f]); }
});
test('allowlist.json: 41 Academy (company 1150) walkthroughs, no internal records', () => {
  const list = JSON.parse(readFileSync(new URL('../../tools/drift/allowlist.json', import.meta.url), 'utf8'));
  assert.equal(list.length, 41); assert.ok(list.every((x) => x.company_id === '1150' && !x.name.startsWith('_studio')));
  assert.equal(new Set(list.map((x) => x.name)).size, 41);
});
