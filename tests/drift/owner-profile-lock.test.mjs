// The Studio profile lock (lockOwnerProfile). Playwright's headless launches ignore Chromium's SingletonLock, so
// Studio serialises the profile itself (CRIT-21). Round 3 (council 20261109-b467b987, CRIT-25/26/27): the lock is a
// localhost port the OS releases when its holder dies, so there is no stale state and no reclaim step to race.
// Fake app only (owner-profile-fixture.mjs): every hostname except the mapped app is unresolvable. Lock-only worker
// processes: owner-lock-worker.mjs. The module is imported as a namespace so this file also loads against older
// versions (to show each new test fails there, or does not apply).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import * as S from '../../tools/drift/owner-session.mjs';
const { borrowOwnerSession, lockOwnerProfile, clearOwnerSessionCache } = S;
import { startFakeApp, wrapChromium, seedProfile } from './owner-profile-fixture.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-profile-fixture.mjs');
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-lock-worker.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('CRIT-21 (a): a borrow while another holder has the profile waits, then succeeds', { timeout: 180000 }, async () => {
  clearOwnerSessionCache();
  const app = await startFakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-profile-'));
  try {
    await seedProfile(dir, app.port);
    // Holder: what owner-profile.mjs --sign-in (or another Studio borrow) does: Studio lock, then the profile open.
    const unlock = await lockOwnerProfile(dir);
    const holder = await wrapChromium(app.port).launchPersistentContext(dir, { headless: true });
    let releasedAt = null;
    const release = sleep(8000).then(async () => { await holder.close(); releasedAt = Date.now(); unlock(); });
    const s = await borrowOwnerSession({ tenant: 'academy', source: 'profile', profileDir: dir, chromium: wrapChromium(app.port), waitMs: 1500, useCache: false });
    const doneAt = Date.now();
    await release;
    assert.equal(s.status, 'owner_session'); assert.equal(s.source, 'studio-profile');
    assert.ok(releasedAt && doneAt >= releasedAt, 'the borrow only read the profile after the holder released it');
    assert.equal(typeof await lockOwnerProfile(dir) === 'function' ? 'free' : 'held', 'free', 'borrow released its lock');
  } finally { app.stop(); clearOwnerSessionCache(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CRIT-21 (b): two Studio processes borrowing at once both succeed, one after the other', { timeout: 240000 }, async () => {
  const app = await startFakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-profile-'));
  try {
    await seedProfile(dir, app.port);
    const run = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [FIXTURE, '--borrow', dir, String(app.port)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; });
      c.on('exit', () => resolve(JSON.parse(out.trim().split('\n').pop())));
    });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
    const span = (r) => [r.events.find((e) => e.ev === 'launch').at, r.events.find((e) => e.ev === 'close').at];
    const [[a0, a1], [b0, b1]] = [span(a), span(b)];
    assert.ok(a1 <= b0 || b1 <= a0, `profile open windows overlapped: ${a0}-${a1} vs ${b0}-${b1}`);
  } finally { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- round 3 (council 20261109-b467b987): OS-released lock ----------
const LEGACY = /^studio-profile\.lock/; // round-1/2 lock file and its temp/aside files
const hold = (dir) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [WORKER, '--hold', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  c.stdout.once('data', (d) => (String(d).startsWith('HELD') ? resolve(c) : reject(new Error(String(d)))));
  c.once('exit', (code) => reject(new Error(`holder exited ${code}`)));
});
const kill9 = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGKILL'); });
const tempProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
const workers = (args, n) => Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  c.on('exit', (code) => { try { resolve(out ? JSON.parse(out.trim().split('\n').pop()) : { code }); } catch (e) { reject(new Error(`worker exited ${code}: ${out.slice(-300)}`)); } });
})));

test('lock 1 (mutual exclusion stress): 8 processes x 40 acquire/hold/release never overlap', { timeout: 240000 }, async () => {
  const dir = tempProfile();
  try {
    const results = await workers(['--stress', dir, '40'], 8);
    const holds = results.flatMap((w) => w.holds.map(([a, b]) => ({ a, b, pid: w.pid }))).sort((x, y) => x.a - y.a);
    assert.equal(holds.length, 8 * 40);
    for (let k = 1; k < holds.length; k++)
      assert.ok(holds[k].a >= holds[k - 1].b, `two holders at once: pid ${holds[k - 1].pid} [${holds[k - 1].a}, ${holds[k - 1].b}] and pid ${holds[k].pid} from ${holds[k].a}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock 2 (holder killed): nothing is left to reclaim and the next acquire succeeds at once', { timeout: 60000 }, async () => {
  const dir = tempProfile();
  try {
    const h = await hold(dir);
    await kill9(h);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => LEGACY.test(n)), [], 'a killed holder left lock state on disk (stale state that must be reclaimed)');
    const t0 = Date.now();
    const unlock = await lockOwnerProfile(dir);
    assert.equal(typeof unlock, 'function', 'acquired after the holder died');
    assert.ok(Date.now() - t0 < 1000, `acquire took ${Date.now() - t0} ms`);
    await unlock();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock 3 (killed holder + 3 concurrent acquirers, x100): exactly one wins, the others are busy', { timeout: 600000 }, async () => {
  const dir = tempProfile();
  const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-sync-'));
  const ROUNDS = 100;
  // Even rounds force the reclaim interleaving reported by the council (see owner-lock-worker.mjs); odd rounds race freely.
  const racers = Promise.all([0, 1, 2].map((role) => workers(['--race', dir, String(ROUNDS), sync, String(role)], 1)));
  const waitN = async (prefix, n) => { while (fs.readdirSync(sync).filter((f) => f.startsWith(prefix)).length < n) await sleep(1); };
  try {
    for (let i = 0; i < ROUNDS; i++) {
      await kill9(await hold(dir));
      fs.writeFileSync(path.join(sync, `go-${i}`), '');
      await waitN(`res-${i}-`, 3);
      const res = fs.readdirSync(sync).filter((f) => f.startsWith(`res-${i}-`)).map((f) => fs.readFileSync(path.join(sync, f), 'utf8'));
      fs.writeFileSync(path.join(sync, `end-${i}`), '');
      await waitN(`done-${i}-`, 3);
      assert.deepEqual(res.slice().sort(), ['busy', 'busy', 'won'], `round ${i}: ${res.join(', ')}`);
    }
  } finally {
    for (let i = 0; i < ROUNDS; i++) for (const f of [`go-${i}`, `end-${i}`]) fs.writeFileSync(path.join(sync, f), ''); // let racers finish
    await racers.catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(sync, { recursive: true, force: true });
  }
});

test("lock 4 (release can't touch others): A releases twice while B holds; B keeps the lock", { timeout: 60000 }, async () => {
  const dir = tempProfile();
  let b = null;
  try {
    const a = await lockOwnerProfile(dir);
    assert.equal(typeof a, 'function');
    await a();
    b = await hold(dir);
    await a(); await a(); // stale/duplicate releases by A
    assert.equal(await lockOwnerProfile(dir), null, 'B still holds the profile');
    await kill9(b); b = null;
    const c = await lockOwnerProfile(dir); assert.equal(typeof c, 'function'); await c();
  } finally { if (b) await kill9(b); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock 5 (port conflict): another program on the derived port fails fast with owner_profile_lock_port_conflict', { timeout: 60000 }, async (t) => {
  if (typeof S.profileLockPort !== 'function') return t.skip('not applicable: this version has no port lock');
  const dir = tempProfile();
  const port = S.profileLockPort(dir);
  const conflict = (e) => e.code === 'owner_profile_lock_port_conflict' && e.message.includes(String(port));
  try {
    // (a) loopback listener that answers something else, (b) one that never answers,
    // (c) a wildcard listener: macOS lets a 127.0.0.1 bind shadow it, so this needs the pre-bind probe.
    for (const [label, host, onConn] of [['answers', '127.0.0.1', (c) => c.end('HTTP/1.1 400 Bad Request\r\n\r\n')],
      ['silent', '127.0.0.1', () => {}], ['wildcard', '0.0.0.0', (c) => c.end('hello\n')]]) {
      const other = net.createServer(onConn);
      await new Promise((r) => other.listen(port, host, r));
      try {
        const t0 = Date.now();
        await assert.rejects(lockOwnerProfile(dir), conflict, label);
        assert.ok(Date.now() - t0 < 5000, `${label}: took ${Date.now() - t0} ms`);
        // a borrow fails just as fast (no 2-minute busy-wait) and never launches a browser
        const t1 = Date.now();
        await assert.rejects(borrowOwnerSession({ tenant: 'academy', source: 'profile', profileDir: dir, useCache: false, waitMs: 0,
          chromium: { launchPersistentContext: async () => { throw new Error('must not launch'); } } }), conflict, `${label} (borrow)`);
        assert.ok(Date.now() - t1 < 5000, `${label} borrow: took ${Date.now() - t1} ms`);
      } finally { other.closeAllConnections?.(); await new Promise((r) => other.close(r)); }
    }
    const u = await lockOwnerProfile(dir); assert.equal(typeof u, 'function', 'free again once the other program is gone'); await u();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock 6 (in-process serialisation): two borrows in one process; the second waits for the first, then succeeds', { timeout: 240000 }, async () => {
  clearOwnerSessionCache();
  const app = await startFakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-profile-'));
  try {
    await seedProfile(dir, app.port);
    const events = [];
    const chromium = wrapChromium(app.port, (e) => events.push(e));
    const borrow = () => borrowOwnerSession({ tenant: 'academy', source: 'profile', profileDir: dir, chromium, waitMs: 1500, useCache: false });
    const [a, b] = await Promise.all([borrow(), borrow()]);
    assert.equal(a.status, 'owner_session'); assert.equal(b.status, 'owner_session');
    assert.deepEqual(events.map((e) => e.ev), ['launch', 'close', 'launch', 'close'], 'the profile was never open twice at once');
  } finally { app.stop(); clearOwnerSessionCache(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock: leftover lock files from older versions are ignored, then removed once the new lock is held', async (t) => {
  if (typeof S.profileLockPort !== 'function') return t.skip('not applicable: this version has no port lock');
  const dir = tempProfile();
  try {
    for (const n of ['studio-profile.lock', 'studio-profile.lock.tmp.1.x', 'studio-profile.lock.stale.2.y', 'studio-profile.lock.reclaim.3.z']) fs.writeFileSync(path.join(dir, n), '1'); // pid 1 is alive
    const u = await lockOwnerProfile(dir);
    assert.equal(typeof u, 'function', 'a live-looking old lock file does not block the new lock');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => LEGACY.test(n)), []);
    await u();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock: a held lock never keeps Node alive (a process that forgets to release still exits)', { timeout: 30000 }, async () => {
  const dir = tempProfile();
  try {
    const mod = path.join(path.dirname(FIXTURE), '..', '..', 'tools', 'drift', 'owner-session.mjs');
    const c = spawn(process.execPath, ['--input-type=module', '-e', `const { lockOwnerProfile } = await import(${JSON.stringify(mod)}); const u = await lockOwnerProfile(${JSON.stringify(dir)}); console.log(typeof u);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const exited = await new Promise((r) => { const tm = setTimeout(() => r(false), 10000); c.on('exit', () => { clearTimeout(tm); r(true); }); });
    if (!exited) c.kill('SIGKILL');
    assert.equal(out.trim(), 'function'); assert.equal(exited, true, 'process kept alive by the held lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
