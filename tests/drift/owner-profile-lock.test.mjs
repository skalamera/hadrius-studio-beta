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
