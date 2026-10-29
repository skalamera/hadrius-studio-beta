// Runs tools/drift/weekly.mjs as a child process for the bridge (concurrency 1, lock file, overall timeout,
// log file) and holds the PR-triggered early-check queue (debounced, capped per day).
// Import-safe: nothing runs until createWeeklyRunner().start() / queue methods are called.
// The child gets a scrubbed environment: secrets the bridge loaded from .env never reach it (weekly.mjs
// doesn't need them: Academy sign-in reads the Keychain, the narration judge uses the claude CLI login).
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { parseNames, stamp } from './weekly.mjs';

export const LOCK_NAME = 'drift-weekly.lock';
export const PER_VIDEO_MIN = 15;
export const MAX_TOTAL_MS = 12 * 3600_000;
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_KEY|_KEY$|^KEY$|REFRESH|COOKIE|SESSION)/i;
const SECRET_PREFIX_RE = /^(STUDIO_|GOOGLE_|PYLON_|SLACK_|ELEVENLABS_|GEMINI_|OPENAI_|ANTHROPIC_|AWS_|DATABASE_|NEON_|PG)/;

/** Environment for the weekly child: everything except credentials and the bridge's service config. */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_KEY_RE.test(k) && !SECRET_PREFIX_RE.test(k)) out[k] = v;
  return out;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Names from an allowlist file (same parser weekly.mjs uses). */
export function readAllowlist(file) { return parseNames({ allowlistText: fs.readFileSync(file, 'utf8') }); }

export function weeklyArgs({ weeklyPath, outDir, names = null, allowlistPath = null, captureDryRun = false, perVideoMin = PER_VIDEO_MIN, noJudge = false }) {
  const a = [weeklyPath, '--once'];
  if (allowlistPath) a.push('--allowlist', allowlistPath); else a.push('--names', names.join(','));
  a.push('--out', outDir, '--timeout-min', String(perVideoMin));
  if (captureDryRun) a.push('--dry-run');
  if (noJudge) a.push('--no-judge');
  return a;
}

/**
 * @param {object} o
 * @param {string} o.repo            repository root (cwd of the child)
 * @param {string} o.scratch         where run dirs and the lock live (outside the repo)
 * @param {string} o.logPath         child stdout/stderr (appended)
 * @param {(run)=>Promise<any>} [o.onFinished]  called after the child exits (the bridge submits here)
 */
export function createWeeklyRunner({ repo, scratch, logPath, onFinished = async () => null, spawnImpl = nodeSpawn, nodePath = process.execPath, env = process.env, now = () => new Date(), log = () => {}, perVideoMin = PER_VIDEO_MIN }) {
  let current = null, last = null;
  const lockPath = path.join(scratch, LOCK_NAME);
  const pub = (r) => r && ({ id: r.id, source: r.source, outDir: r.outDir, names: r.names, allowlistPath: r.allowlistPath, submitDryRun: r.submitDryRun, captureDryRun: r.captureDryRun, prsByName: r.prsByName ?? {},
    startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, pid: r.pid ?? null, exitCode: r.exitCode ?? null, signal: r.signal ?? null, timedOut: !!r.timedOut, timeoutMs: r.timeoutMs, submit: r.submit ?? null, error: r.error ?? null });

  function acquireLock(meta) {
    try { const fd = fs.openSync(lockPath, 'wx', 0o600); fs.writeSync(fd, JSON.stringify(meta)); fs.closeSync(fd); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null; try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unreadable = stale */ }
      if (held?.pid && pidAlive(held.pid) && held.pid !== process.pid) return false;  // another process owns a live run
      if (held?.childPid && pidAlive(held.childPid)) return false;                      // its weekly.mjs child is still running
      if (held?.pid === process.pid && current) return false;
      fs.rmSync(lockPath, { force: true });
      return acquireLock(meta);
    }
  }

  function start({ names = null, allowlistPath = null, source = 'manual', submitDryRun = true, captureDryRun = false, prsByName = {}, noJudge = false } = {}) {
    if (current) return { started: false, error: 'busy', current: pub(current) };
    let list;
    if (allowlistPath) list = readAllowlist(allowlistPath);
    else list = parseNames({ names: Array.isArray(names) ? names.join(',') : names });
    if (!list.length) return { started: false, error: 'no_names' };
    if (!/^[a-z0-9-]{1,20}$/.test(source)) return { started: false, error: 'invalid_source' };
    const id = `${stamp(now())}-${source}`;
    const outDir = path.join(scratch, `weekly-${id}`);
    if (fs.existsSync(outDir)) return { started: false, error: 'output_exists', outDir };
    if (!acquireLock({ pid: process.pid, id, outDir, startedAt: now().toISOString() })) return { started: false, error: 'busy_other_process', lock: lockPath };
    const timeoutMs = Math.min(MAX_TOTAL_MS, list.length * (perVideoMin + 1) * 60_000 + 5 * 60_000);
    const run = current = { id, source, outDir, names: list, allowlistPath, submitDryRun: submitDryRun !== false, captureDryRun: !!captureDryRun, prsByName, startedAt: now().toISOString(), timeoutMs };
    let fd;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fd = fs.openSync(logPath, 'a');
      fs.writeSync(fd, `\n[drift-weekly] ${run.startedAt} start ${id}: ${list.length} video(s), submit ${run.submitDryRun ? 'DRY RUN' : 'LIVE'}${run.captureDryRun ? ', capture dry run' : ''} -> ${outDir}\n`);
      const child = spawnImpl(nodePath, weeklyArgs({ weeklyPath: path.join(repo, 'tools', 'drift', 'weekly.mjs'), outDir, names: allowlistPath ? null : list, allowlistPath, captureDryRun, perVideoMin, noJudge }),
        { cwd: repo, env: scrubEnv(env), stdio: ['ignore', fd, fd] });
      run.pid = child.pid;
      // Persist the run in the lock so a restarted bridge can adopt the orphaned child (recover()).
      try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, childPid: child.pid, ...lockMeta(run) }), { mode: 0o600 }); } catch {}
      let killTimer = null;
      const timer = setTimeout(() => { run.timedOut = true; log(`[drift-weekly] ${id} timed out after ${Math.round(timeoutMs / 60000)} min; stopping`); try { child.kill('SIGTERM'); } catch {} killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000); }, timeoutMs);
      timer.unref?.();
      const finish = async (code, signal, err = null) => {
        if (run.finishedAt) return;
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
        Object.assign(run, { finishedAt: now().toISOString(), exitCode: code, signal, ...(err ? { error: String(err?.message || err) } : {}) });
        try { fs.writeSync(fd, `[drift-weekly] ${run.finishedAt} child exit ${code ?? signal}${run.timedOut ? ' (timeout)' : ''}\n`); } catch {}
        try { run.submit = await onFinished(pub(run)); }
        catch (e) { run.submit = { ok: false, error: String(e?.message || e) }; }
        try { fs.writeSync(fd, `[drift-weekly] ${now().toISOString()} submit: ${JSON.stringify(run.submit?.counts ?? run.submit ?? null)}\n`); fs.closeSync(fd); } catch {}
        fs.rmSync(lockPath, { force: true });
        last = run; current = null;
      };
      child.on('error', (e) => finish(null, null, e));
      child.on('exit', (code, signal) => finish(code, signal));
    } catch (e) {
      try { if (fd != null) fs.closeSync(fd); } catch {}
      fs.rmSync(lockPath, { force: true }); current = null;
      return { started: false, error: String(e?.message || e) };
    }
    return { started: true, run: pub(run) };
  }
  const lockMeta = (r) => ({ id: r.id, source: r.source, outDir: r.outDir, names: r.names, allowlistPath: r.allowlistPath, submitDryRun: r.submitDryRun, captureDryRun: r.captureDryRun, prsByName: r.prsByName, startedAt: r.startedAt, timeoutMs: r.timeoutMs });

  /**
   * After a bridge restart: a lock whose owner is dead belongs to an orphaned run. If its weekly.mjs child is
   * still alive, wait for it (enforcing the original timeout), then submit; if it already exited, submit now.
   * Returns the adopted run or null.
   */
  function recover({ pollMs = 30_000 } = {}) {
    if (current) return null;
    let held = null; try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
    if (!held?.outDir || (held.pid && held.pid !== process.pid && pidAlive(held.pid))) return null;
    const run = current = { ...held, pid: held.childPid ?? null, recovered: true };
    const done = async (signal) => {
      clearInterval(iv);
      Object.assign(run, { finishedAt: now().toISOString(), exitCode: null, signal });
      try { run.submit = await onFinished(pub(run)); } catch (e) { run.submit = { ok: false, error: String(e?.message || e) }; }
      try { fs.appendFileSync(logPath, `[drift-weekly] ${now().toISOString()} adopted run ${run.id} finished; submit: ${JSON.stringify(run.submit?.counts ?? run.submit ?? null)}\n`); } catch {}
      fs.rmSync(lockPath, { force: true }); last = run; current = null;
    };
    const check = () => {
      if (!held.childPid || !pidAlive(held.childPid)) { if (!run.finishedAt && !run._finishing) { run._finishing = true; done('recovered_after_bridge_restart'); } return; }
      if (Date.parse(held.startedAt) + (held.timeoutMs || MAX_TOTAL_MS) < now().getTime() && !run.timedOut) { run.timedOut = true; try { process.kill(held.childPid, 'SIGTERM'); } catch {} }
    };
    const iv = setInterval(check, pollMs); iv.unref?.();
    log(`[drift-weekly] adopting run ${held.id} after a bridge restart (child ${held.childPid ?? '?'} ${held.childPid && pidAlive(held.childPid) ? 'still running' : 'already exited'})`);
    check();
    return pub(run);
  }
  return { start, recover, status: () => ({ running: !!current, current: pub(current), last: pub(last) }), get busy() { return !!current; } };
}

// ---------------------------------------------------------------- PR-triggered early checks
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Persistent queue of videos flagged by tools/pr-watch.mjs. A batch is released only after `debounceMs` without
 * new flags (a burst of merges becomes one run), at most `maxPerDay` videos per local day, and each video at most
 * once per day (re-flags wait for tomorrow). Names outside `allowed` (the Academy allowlist) are recorded as skipped.
 */
export function createEarlyCheckQueue({ statePath, debounceMs = 30 * 60_000, maxPerDay = 6, now = () => new Date() }) {
  const load = () => { try { const s = JSON.parse(fs.readFileSync(statePath, 'utf8')); return { pending: s.pending || {}, days: s.days || {}, skipped: s.skipped || [] }; } catch { return { pending: {}, days: {}, skipped: [] }; } };
  const save = (s) => {
    const keep = new Set(Object.keys(s.days).sort().slice(-7));
    for (const k of Object.keys(s.days)) if (!keep.has(k)) delete s.days[k];
    s.skipped = s.skipped.slice(-50);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, statePath);
  };
  return {
    /** items: [{name, pr:{number,title,url}}]; allowed: Set of names or null (no filter). */
    enqueue(items, { allowed = null } = {}) {
      const s = load(); const t = now().toISOString(); const added = [], skipped = [];
      for (const it of items || []) {
        if (!it?.name) continue;
        if (allowed && !allowed.has(it.name)) { skipped.push(it.name); s.skipped.push({ name: it.name, at: t, reason: 'not_in_allowlist', pr: it.pr?.number ?? null }); continue; }
        const e = (s.pending[it.name] ||= { firstAt: t, lastAt: t, prs: [] });
        e.lastAt = t;
        if (it.pr && !e.prs.some((p) => p.number === it.pr.number)) e.prs.push({ number: it.pr.number ?? null, title: it.pr.title ?? null, url: it.pr.url ?? null });
        added.push(it.name);
      }
      save(s); return { added: [...new Set(added)], skipped };
    },
    /** Release a batch if the queue is quiet and today's budget allows. → {names, prsByName} | null */
    take({ busy = false } = {}) {
      if (busy) return null;
      const s = load(); const names = Object.keys(s.pending);
      if (!names.length) return null;
      const lastAt = Math.max(...names.map((n) => Date.parse(s.pending[n].lastAt)));
      if (now().getTime() - lastAt < debounceMs) return null;
      const today = dayKey(now()); const done = new Set(s.days[today] || []);
      const budget = maxPerDay - done.size;
      if (budget <= 0) return null;
      const pick = names.filter((n) => !done.has(n)).sort((a, b) => s.pending[a].firstAt.localeCompare(s.pending[b].firstAt)).slice(0, budget);
      if (!pick.length) return null;
      const prsByName = {};
      for (const n of pick) { prsByName[n] = s.pending[n].prs; delete s.pending[n]; }
      s.days[today] = [...done, ...pick];
      save(s); return { names: pick, prsByName };
    },
    /** Put a taken batch back (the run could not start); it no longer counts against today's budget. */
    requeue(batch) {
      if (!batch?.names?.length) return;
      const s = load(); const t = now().toISOString(); const today = dayKey(now());
      s.days[today] = (s.days[today] || []).filter((n) => !batch.names.includes(n));
      for (const n of batch.names) s.pending[n] = { firstAt: t, lastAt: new Date(now().getTime() - debounceMs).toISOString(), prs: batch.prsByName?.[n] || [] };
      save(s);
    },
    state: load,
  };
}
