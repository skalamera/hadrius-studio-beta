// Lock-only worker processes for owner-profile-lock.test.mjs (no browser, no app). Works against any version of
// lockOwnerProfile (sync or async): every call is awaited.
//   --hold <dir>                          acquire (waiting), print HELD, hold until killed
//   --stress <dir> <iterations>           acquire/hold/release repeatedly; print hold intervals
//   --race <dir> <rounds> <syncDir> <role>  per round: wait go-<i>, try ONCE, report res-<i>-<pid>, wait end-<i>, release
//     On even rounds the roles force the 3-process interleaving of a reclaim-based lock (council round 3): role 0 pauses
//     30 ms before renaming a lock aside and 30 ms before putting one back; role 2 starts its attempt 45 ms late, i.e.
//     inside that window. The pauses wrap fs.renameSync/fs.linkSync only, which an OS-released lock never calls.
import fs from 'node:fs';
import path from 'node:path';
import { lockOwnerProfile } from '../../tools/drift/owner-session.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, dir, a, b] = process.argv.slice(2);
const wallNow = () => performance.timeOrigin + performance.now(); // sub-ms wall clock, comparable across processes
const spin = (ms) => { const end = wallNow() + ms; while (wallNow() < end); };
const tick = () => new Promise((r) => setTimeout(r, 1));
const acquire = async () => { let u = null; while (!(u = await lockOwnerProfile(dir))) await tick(); return u; };

if (mode === '--hold') {
  await acquire();
  process.stdout.write(`HELD ${process.pid}\n`);
  setInterval(() => {}, 1 << 30);
} else if (mode === '--stress') {
  const holds = [];
  for (let i = 0; i < Number(a); i++) {
    const unlock = await acquire();
    const start = wallNow(); spin(2); const end = wallNow();
    await unlock(); holds.push([start, end]);
  }
  console.log(JSON.stringify({ pid: process.pid, holds }));
  process.exit(0);
} else if (mode === '--race') {
  const sync = b; const role = Number(process.argv[6] ?? 1);
  let forced = false;
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  if (role === 0) for (const fn of ['renameSync', 'linkSync']) {
    const orig = fs[fn];
    fs[fn] = (from, to) => { if (forced && /studio-profile\.lock/.test(String(from) + String(to)) && (fn === 'renameSync' || /\.stale\./.test(String(from)))) pause(30); return orig(from, to); };
  }
  const waitFor = async (f) => { while (!fs.existsSync(path.join(sync, f))) await tick(); };
  for (let i = 0; i < Number(a); i++) {
    await waitFor(`go-${i}`);
    forced = i % 2 === 0;
    if (forced && role === 2) await delay(45);
    let res, unlock = null;
    try { unlock = await lockOwnerProfile(dir); res = unlock ? 'won' : 'busy'; } catch (e) { res = `error:${e.code || e.message}`; }
    fs.writeFileSync(path.join(sync, `res-${i}-${process.pid}`), res);
    await waitFor(`end-${i}`);
    if (unlock) await unlock();
    fs.writeFileSync(path.join(sync, `done-${i}-${process.pid}`), '');
  }
  process.exit(0);
}
