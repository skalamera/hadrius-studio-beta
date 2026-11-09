// CRIT-21 regression: Playwright's headless launches ignore Chromium's SingletonLock, so the Studio profile is
// serialised by Studio's own lock (lockOwnerProfile). A borrow that overlaps another holder must WAIT and then
// succeed, never read the profile's storage while it is locked by someone else (owner_not_signed_in).
// Fake app only (owner-profile-fixture.mjs): every hostname except the mapped app is unresolvable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { borrowOwnerSession, lockOwnerProfile, clearOwnerSessionCache } from '../../tools/drift/owner-session.mjs';
import { startFakeApp, wrapChromium, seedProfile } from './owner-profile-fixture.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-profile-fixture.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lockOwnerProfile: exclusive per live process, stale lock cleared, release only removes our own lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
  const f = path.join(dir, 'studio-profile.lock');
  const unlock = lockOwnerProfile(dir);
  assert.equal(typeof unlock, 'function');
  assert.equal(lockOwnerProfile(dir), null, 'held (by a live pid, here this process)');
  unlock(); assert.equal(fs.existsSync(f), false);
  fs.writeFileSync(f, '999999'); // dead holder
  const u2 = lockOwnerProfile(dir); assert.equal(typeof u2, 'function', 'stale lock cleared');
  fs.writeFileSync(f, String(process.ppid)); // someone else took it after us
  u2(); assert.equal(fs.readFileSync(f, 'utf8'), String(process.ppid), "release never removes another holder's lock");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRIT-21 (a): a borrow while another holder has the profile waits, then succeeds', { timeout: 180000 }, async () => {
  clearOwnerSessionCache();
  const app = await startFakeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-profile-'));
  try {
    await seedProfile(dir, app.port);
    // Holder: what owner-profile.mjs --sign-in (or another Studio borrow) does: Studio lock, then the profile open.
    const unlock = lockOwnerProfile(dir);
    const holder = await wrapChromium(app.port).launchPersistentContext(dir, { headless: true });
    let releasedAt = null;
    const release = sleep(8000).then(async () => { await holder.close(); releasedAt = Date.now(); unlock(); });
    const s = await borrowOwnerSession({ tenant: 'academy', source: 'profile', profileDir: dir, chromium: wrapChromium(app.port), waitMs: 1500, useCache: false });
    const doneAt = Date.now();
    await release;
    assert.equal(s.status, 'owner_session'); assert.equal(s.source, 'studio-profile');
    assert.ok(releasedAt && doneAt >= releasedAt, 'the borrow only read the profile after the holder released it');
    assert.equal(fs.existsSync(path.join(dir, 'studio-profile.lock')), false, 'borrow released its lock');
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

// ---------- round 2 (council 20261109-261d071f): both races in lockOwnerProfile ----------
const LOCK = (dir) => path.join(dir, 'studio-profile.lock');
const DEAD_PID = '999999';
const runWorkers = (args, n) => Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  c.on('exit', (code) => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error(`worker exited ${code}: ${out.slice(-300)}`)); } });
})));

test('lock race 1 (forced interleaving): an EMPTY lock file is a holder mid-publication: busy, never deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
  fs.writeFileSync(LOCK(dir), ''); // a holder between creating the file and writing its pid
  assert.equal(lockOwnerProfile(dir), null, 'busy, not stale');
  assert.equal(fs.existsSync(LOCK(dir)), true, 'the in-flight lock was not deleted');
  assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), '');
  fs.writeFileSync(LOCK(dir), 'not-a-pid');
  assert.equal(lockOwnerProfile(dir), null, 'unparseable content is busy too'); assert.equal(fs.existsSync(LOCK(dir)), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock race 2 (stale reclaim): two processes reclaiming the same dead holder never both win, and neither deletes the other\'s fresh lock', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
  const sync = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-sync-'));
  const ROUNDS = 150;
  try {
    const workers = runWorkers(['--lock-reclaim', dir, String(ROUNDS), sync], 2);
    for (let i = 0; i < ROUNDS; i++) {
      for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true }); // previous round's leftovers
      fs.writeFileSync(LOCK(dir), DEAD_PID); // holder died
      fs.writeFileSync(path.join(sync, `go-${i}`), '');
      while (fs.readdirSync(sync).filter((n) => n.startsWith(`done-${i}-`)).length < 2) await sleep(1);
    }
    const results = await workers;
    for (let i = 0; i < ROUNDS; i++) {
      const r = results.map((w) => w.rounds[i]);
      assert.ok(r.filter((x) => x.won).length <= 1, `round ${i}: both reclaimers acquired`);
      assert.ok(r.filter((x) => x.won).every((x) => x.kept), `round ${i}: a fresh lock was deleted or replaced while held`);
    }
    assert.ok(results.flatMap((w) => w.rounds).filter((x) => x.won).length >= ROUNDS * 0.9, 'the dead holder\'s lock was reclaimed in (almost) every round');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(sync, { recursive: true, force: true }); }
});

test('lock stress: 8 processes x 40 take/hold/release never overlap and never lose a held lock', { timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
  try {
    const results = await runWorkers(['--lock-stress', dir, '40'], 8);
    assert.equal(results.reduce((n, w) => n + w.lost, 0), 0, 'a held lock was deleted or replaced by another process');
    const holds = results.flatMap((w) => w.holds.map(([a, b]) => ({ a, b, pid: w.pid }))).sort((x, y) => x.a - y.a);
    assert.equal(holds.length, 8 * 40);
    for (let k = 1; k < holds.length; k++)
      assert.ok(holds[k].a >= holds[k - 1].b, `two holders at once: pid ${holds[k - 1].pid} [${holds[k - 1].a}, ${holds[k - 1].b}] and pid ${holds[k].pid} from ${holds[k].a}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
