// Owner session for drift captures: replay a walkthrough with the SAME data the original recording showed by
// borrowing the Hadrius sign-in of the operator's everyday Chrome (a Hadrius staff account that sees every record
// in Sandbox 1048 and Academy 1150), instead of the narrowly scoped automation accounts.
//
// How (and why this way):
//  - Chrome must have remote debugging switched on (chrome://inspect/#remote-debugging), which writes
//    ~/Library/Application Support/Google/Chrome/DevToolsActivePort. We connect over CDP, open ONE background tab
//    in a new window, guard it with the same request guard as every capture (no app writes leave it), load
//    app.hadrius.com so the app itself refreshes its tokens if needed, and read ONLY the short-lived Cognito
//    access/id tokens (+ LastAuthUser, clockDrift, signInDetails). The tab is closed and we disconnect; the operator's
//    Chrome, tabs and browsing are otherwise untouched.
//  - The refresh token and device keys are NEVER copied. Hadrius uses Cognito refresh-token rotation: a second
//    browser refreshing with a copied refresh token would sign the operator's Chrome out. Without it the borrowed
//    session simply ends when the access token expires; we borrow afresh for every video and require
//    MIN_REMAINING_MS of validity first.
//  - The replay runs in a separate, NON-persistent headless Chromium context: the tokens live only in memory and
//    in that context's localStorage, never on disk. lastCompanyId is pinned to the run's tenant on every document
//    load, and capture.mjs re-checks it on every step.
//  - Nothing here prints, logs or returns token values. borrowOwnerSession() returns an opaque object whose
//    `initScriptArg` is handed straight to context.addInitScript.
//
// Preferred source (DRIFT_OWNER_SOURCE=profile): a dedicated Studio browser profile, <repo>/.browser-profile-owner,
// that the operator signs into ONCE with their own Hadrius account (tools/drift/owner-profile.mjs --sign-in). It is
// its own sign-in session (its own refresh token, refreshed by the app inside that profile), so it never touches the
// everyday Chrome, never raises Chrome's per-connection "Allow remote debugging?" prompt, and works unattended.
// It is borrowed exactly like Chrome: opened headless and guarded only to load the app, its short-lived tokens copied
// into a throwaway capture browser. Captures never run inside it (a walkthrough's "Use as employee" step once left
// it signed out when they did). The Chrome borrow remains the fallback (DRIFT_OWNER_SOURCE=chrome).
//
// Import-safe: importing this module connects to nothing and reads nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { classifyRequest } from './capture.mjs';
import { companiesFromUserPayload } from './academy-login.mjs';
import { getTenant } from './tenants.mjs';

export const APP_ORIGIN = 'https://app.hadrius.com';
export const MIN_REMAINING_MS = 17 * 60 * 1000; // one video's capture is bounded at 15 min by weekly.mjs (timeout - 1 min)
export const MAX_WAIT_FOR_REFRESH_MS = 20 * 60 * 1000;
export const DEVTOOLS_ACTIVE_PORT = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
// Only these localStorage keys are copied. Everything else (refreshToken, deviceKey, deviceGroupKey,
// randomPasswordKey, the user's own settings) stays in the operator's Chrome.
export const BORROW_KEY_RE = /^CognitoIdentityServiceProvider\.[A-Za-z0-9]+\.(LastAuthUser|[^.]+\.(idToken|accessToken|clockDrift|signInDetails))$/;
const NEVER_COPY_RE = /(refreshToken|deviceKey|deviceGroupKey|randomPasswordKey)$/;
// In-memory only (this process): the last borrowed entries, reused while they still have MIN_REMAINING_MS of
// validity so a weekly run touches the operator's Chrome about once an hour, not once per video.
let cache = null;
export function clearOwnerSessionCache() { cache = null; conn = null; lastFailure = null; }

// Chrome (144+, chrome://inspect/#remote-debugging) asks the operator to Allow EVERY new debugging connection, so a
// process opens ONE connection and reuses it for every borrow (a weekly run = one prompt), releasing it when done.
// After a refused/failed connection it does not retry for CONNECT_COOLDOWN_MS: an unanswered prompt must never turn
// into a prompt per video.
export const CONNECT_COOLDOWN_MS = 5 * 60 * 1000;
let conn = null;
let lastFailure = null;
const borrowPages = new WeakSet();
async function ownerConnection(chromium, endpoint, now) {
  if (conn?.browser && (typeof conn.browser.isConnected !== 'function' || conn.browser.isConnected())) return conn.browser;
  conn = null;
  if (lastFailure && now() - lastFailure.at < CONNECT_COOLDOWN_MS)
    throw new OwnerSessionError('owner_chrome_unreachable', `not retried for ${Math.round((CONNECT_COOLDOWN_MS - (now() - lastFailure.at)) / 1000)} s (avoids repeated Chrome prompts): ${lastFailure.detail}`);
  let browser;
  // noDefaults: the connection is held for the whole run, so Playwright must not re-route the operator's downloads
  // (acceptDownloads -> its temp dir, deleted on disconnect) or emulate focus/media in their everyday Chrome.
  try { browser = await chromium.connectOverCDP(endpoint ?? chromeEndpoint(), { timeout: 60000, noDefaults: true }); }
  catch (e) {
    const detail = `Chrome refused or did not answer the debugging connection (chrome://inspect/#remote-debugging; click Allow once per run): ${String(e?.message || e).split('\n')[0].slice(0, 160)}`;
    lastFailure = { at: now(), detail };
    throw new OwnerSessionError('owner_chrome_unreachable', detail);
  }
  lastFailure = null;
  // With no 'dialog' listener Playwright auto-answers every alert/confirm/prompt (and accepts beforeunload) in ALL
  // attached tabs, i.e. the operator's own. Listen so it does not; only drift's own borrow tab is answered.
  browser.contexts()[0]?.on?.('dialog', (d) => { if (borrowPages.has(d.page())) d.dismiss().catch(() => {}); });
  conn = { browser };
  if (typeof browser.on === 'function') browser.on('disconnected', () => { if (conn?.browser === browser) conn = null; });
  return browser;
}
/** Release the shared Chrome connection (end of a weekly run / CLI). Never closes the operator's Chrome. */
export async function releaseOwnerConnection() {
  const b = conn?.browser; conn = null;
  if (b) await b.close().catch(() => {}); // connectOverCDP: close() only disconnects
}

export class OwnerSessionError extends Error {
  constructor(code, detail = null) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}

/** ws:// endpoint of the operator's Chrome. Prefers DevToolsActivePort; processes macOS keeps out of Chrome's
 *  profile folder (the launchd bridge gets EPERM) use the default chrome://inspect port, whose bare
 *  /devtools/browser path Chrome accepts. Connecting proves nothing by itself: the borrow still requires a
 *  signed-in Hadrius account that can open the tenant's company. */
export const DEFAULT_DEBUG_PORT = 9222;
export function chromeEndpoint({ file = DEVTOOLS_ACTIVE_PORT, read = fs.readFileSync, env = process.env } = {}) {
  const fallbackPort = /^\d{2,5}$/.test(String(env.DRIFT_CHROME_DEBUG_PORT || '')) ? Number(env.DRIFT_CHROME_DEBUG_PORT) : DEFAULT_DEBUG_PORT;
  let text;
  try { text = String(read(file, 'utf8')); } catch { return `ws://127.0.0.1:${fallbackPort}/devtools/browser`; }
  const [port, wsPath] = text.trim().split('\n');
  if (!/^\d{2,5}$/.test(port ?? '') || !/^\/devtools\/browser\/[\w-]+$/.test(wsPath ?? '')) throw new OwnerSessionError('owner_chrome_unreachable', 'unreadable DevToolsActivePort');
  return `ws://127.0.0.1:${port}${wsPath}`;
}

/** exp (ms) of a JWT without verifying it; null when unreadable. Never returns or logs the token. */
export function jwtExpiryMs(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); return Number.isFinite(p.exp) ? p.exp * 1000 : null; } catch { return null; }
}
/** Stable, non-reversible account label for run.json (sha256 of the Cognito username, first 12 hex). */
export const accountLabel = (username) => (username ? `owner:${crypto.createHash('sha256').update(String(username)).digest('hex').slice(0, 12)}` : null);

/** Keep only the borrowable keys; refuse if anything long-lived slipped in. */
export function selectBorrowedEntries(all) {
  const out = {};
  for (const [k, v] of Object.entries(all || {})) {
    if (NEVER_COPY_RE.test(k)) continue;
    if (BORROW_KEY_RE.test(k) && typeof v === 'string') out[k] = v;
  }
  const keys = Object.keys(out);
  if (keys.some((k) => NEVER_COPY_RE.test(k))) throw new OwnerSessionError('owner_session_unsafe_key');
  return out;
}

/** -> {ok, problem?, expiresAt, username} for a borrowed entry set (no values returned). */
export function inspectBorrowed(entries, { now = Date.now(), minRemainingMs = MIN_REMAINING_MS } = {}) {
  const last = Object.entries(entries).find(([k]) => k.endsWith('.LastAuthUser'));
  if (!last) return { ok: false, problem: 'owner_not_signed_in' };
  const username = last[1];
  const token = (kind) => Object.entries(entries).find(([k]) => k.endsWith(`.${username}.${kind}`))?.[1];
  const access = token('accessToken'), id = token('idToken');
  if (!access || !id) return { ok: false, problem: 'owner_not_signed_in' };
  const expiresAt = Math.min(jwtExpiryMs(access) ?? 0, jwtExpiryMs(id) ?? 0);
  if (!expiresAt) return { ok: false, problem: 'owner_token_unreadable' };
  if (expiresAt - now < minRemainingMs) return { ok: false, problem: 'owner_token_expiring', expiresAt, username };
  return { ok: true, expiresAt, username };
}

/** Body for context.addInitScript(fn, arg): restores the borrowed keys and pins the tenant on app pages only.
 *  Announcement pop-ups are treated as dismissed (component_announcement_modal.tsx reads
 *  `hadrius:announcement-modal:<id>:dismissed` === "true"), as for any user who has already closed them. */
export function ownerInitScript({ entries, companyId, origin }) {
  if (location.origin !== origin) return;
  try {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    localStorage.setItem('lastCompanyId', String(companyId));
  } catch { /* storage unavailable: the probe then sees a signed-out page and fails closed */ }
}

/**
 * Borrow the operator's Hadrius session for `tenant` from their running Chrome.
 * deps: {chromium (playwright), endpoint?, now?, log?, waitMs?}
 * -> {status:'owner_session', account, expiresAt, companyCount, tenantAccessible:true, initScriptArg}
 * Throws OwnerSessionError(code) — codes: owner_chrome_unreachable, owner_not_signed_in, owner_token_expiring,
 * owner_token_unreadable, owner_tenant_not_accessible.
 */
export async function borrowOwnerSession({ tenant, chromium, endpoint = null, now = () => Date.now(), log = () => {}, waitMs = 8000, minRemainingMs = MIN_REMAINING_MS, maxWaitMs = 0, useCache = true, source = ownerSource(), profileDir = OWNER_PROFILE_DIR } = {}) {
  const T = getTenant(tenant);
  const who = source === 'profile' ? "the Studio profile's account" : 'the Chrome account';
  if (useCache && cache && cache.source === source && cache.expiresAt - now() >= minRemainingMs) {
    if (!cache.companies.some((c) => c.id === T.companyId)) throw new OwnerSessionError('owner_tenant_not_accessible', `${who} cannot open company ${T.companyId}`);
    return sessionFrom(cache, T, now, { reused: true });
  }
  // The source page is only ever used to let the app load (and, when its tokens have expired, refresh them with its
  // own refresh token, inside that source). Captures never run in it: they get a throwaway browser carrying only the
  // short-lived tokens, so nothing a walkthrough does (switching to employee view, a sign-out, a failed refresh) can
  // reach the source's stored sign-in.
  const src = source === 'profile' ? await openProfilePage(chromium, profileDir) : await openChromeTab(chromium, endpoint, now);
  let r;
  try { r = await readSessionFromPage(src.page, { now, log, waitMs, minRemainingMs, maxWaitMs }); }
  catch (e) { src.failed?.(); throw e; }
  finally { await src.close(); }
  const { entries, user, landed, aborted } = r;
  const signIn = source === 'profile' ? ': run node tools/drift/owner-profile.mjs --sign-in' : '';
  const st = inspectBorrowed(entries || {}, { now: now(), minRemainingMs });
  if (!st.ok) throw new OwnerSessionError(st.problem, `${source === 'profile' ? 'Studio profile' : 'borrow tab'} ended on ${landed ?? 'unknown page'}; ${Object.keys(entries || {}).length} sign-in keys${st.problem === 'owner_not_signed_in' ? signIn : ''}`);
  const companies = user?.companies ?? null;
  if (!companies) throw new OwnerSessionError('owner_not_signed_in', `the app did not load the signed-in user (${source === 'profile' ? 'Studio profile' : 'borrow tab'} ended on ${landed ?? 'unknown page'}; ${Object.keys(entries || {}).length} sign-in keys)${signIn}`);
  if (!companies.some((c) => c.id === T.companyId)) throw new OwnerSessionError('owner_tenant_not_accessible', `${who} cannot open company ${T.companyId}`);
  log(`[owner-session] borrowed ${accountLabel(st.username)} from ${source === 'profile' ? 'the Studio profile' : 'Chrome'} for ${T.key} (${companies.length} companies visible, ${Math.round((st.expiresAt - now()) / 60000)} min left)`);
  const fresh = { source, entries: Object.freeze({ ...entries }), expiresAt: st.expiresAt, username: st.username, companies, aborted: aborted.length };
  if (useCache) cache = fresh;
  return sessionFrom(fresh, T, now, { reused: false });
}

/** A background tab in its own window of the operator's Chrome (one shared connection per process). */
async function openChromeTab(chromium, endpoint, now) {
  const browser = await ownerConnection(chromium, endpoint, now);
  const dropIfBroken = () => { if (!(typeof browser.isConnected !== 'function' || browser.isConnected())) conn = null; };
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new OwnerSessionError('owner_chrome_unreachable', 'no default browser context');
    const cdp = await browser.newBrowserCDPSession();
    const opened = ctx.waitForEvent('page', { timeout: 15000 });
    await cdp.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true });
    const page = await opened;
    borrowPages.add(page);
    return { page, close: () => page.close().catch(() => {}), failed: dropIfBroken };
  } catch (e) { dropIfBroken(); throw e; }
}

/** The dedicated Studio profile, headless. Waits (bounded) while another Studio process has it open. */
async function openProfilePage(chromium, profileDir, { busyWaitMs = 120000, pollMs = 3000 } = {}) {
  if (!fs.existsSync(profileDir)) throw new OwnerSessionError('owner_profile_missing', `no Studio profile at ${profileDir}: run node tools/drift/owner-profile.mjs --sign-in`);
  const until = Date.now() + busyWaitMs;
  for (;;) {
    // Playwright's headless:true (chromium-headless-shell) neither takes nor honours Chromium's SingletonLock: on a
    // profile another process holds it launches anyway and reads EMPTY storage (owner_not_signed_in). Lock first.
    const unlock = await lockOwnerProfile(profileDir); // owner_profile_lock_port_conflict propagates at once
    if (!unlock) {
      if (Date.now() < until) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
      throw new OwnerSessionError('owner_profile_busy', 'the Studio profile stayed open in another window or Studio process (close the sign-in window)');
    }
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' });
      const page = ctx.pages()[0] || await ctx.newPage();
      return { page, close: () => ctx.close().catch(() => {}).finally(unlock) };
    } catch (e) {
      await unlock();
      const m = String(e?.message || e);
      const busy = /ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(m);
      if (busy && Date.now() < until) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
      if (busy) throw new OwnerSessionError('owner_profile_busy', 'the Studio profile stayed open in another window (close the sign-in window)');
      throw new OwnerSessionError('owner_profile_unavailable', m.split('\n')[0].slice(0, 200));
    }
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------------------------------------------------------------- profile lock (OS-released)
// Council round 3 (20261109-b467b987, CRIT-25/26/27): every file lock whose stale-reclaim is a separate step from
// acquiring raced (rounds 1-2). The lock is now a localhost TCP port derived from the profile path: bind() is atomic and
// the OS releases the port when the holder dies, so there is no stale state and no reclaim step at all. Release is
// server.close() on our own socket and cannot affect anyone else's lock.
const LOCK_BANNER = 'studio-profile-lock';
const LOCK_PORT_BASE = 49152, LOCK_PORT_SPAN = 16000;
/** Deterministic lock port for a profile directory (49152 + sha256(realpath) mod 16000). */
export function profileLockPort(profileDir) {
  const real = fs.realpathSync(profileDir);
  return LOCK_PORT_BASE + (parseInt(crypto.createHash('sha256').update(real).digest('hex').slice(0, 8), 16) % LOCK_PORT_SPAN);
}
/** Who is on the port: {kind:'none'} (nothing listening) | {kind:'studio', pid, dir} | {kind:'other', detail}
 *  | {kind:'flux'} (connection reset: a Studio holder closing its lock while we connected). */
function identifyOnce(port, timeoutMs) {
  return new Promise((resolve) => {
    let data = '', done = false;
    const finish = (r) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(timeoutMs, () => finish({ kind: 'other', detail: `no answer within ${timeoutMs} ms` }));
    sock.on('data', (d) => { data += d; if (data.length > 4096) finish({ kind: 'other', detail: 'unexpected answer' }); });
    sock.on('end', () => {
      const m = /^studio-profile-lock (\d+) (.+)\n?$/.exec(data);
      finish(m ? { kind: 'studio', pid: Number(m[1]), dir: m[2] } : { kind: 'other', detail: data ? `answered ${JSON.stringify(data.slice(0, 60))}` : 'closed without answering' });
    });
    sock.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? { kind: 'none' }
      : ['ECONNRESET', 'EPIPE'].includes(e.code) ? { kind: 'flux', detail: e.code } : { kind: 'other', detail: e.code || String(e.message) }));
  });
}
/** identifyOnce, re-asked while the port is in flux. A reset only happens when a listener closes with connections
 *  still queued, i.e. a holder letting go: if it persists the profile is reported busy (the caller retries), never a
 *  port conflict (under contention a releasing Studio holder resets every queued probe). */
async function identifyLockPort(port, timeoutMs = 2000) {
  for (let i = 0; ; i++) {
    const who = await identifyOnce(port, timeoutMs);
    if (who.kind !== 'flux' || i >= 5) return who;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const portConflict = (port, detail) => new OwnerSessionError('owner_profile_lock_port_conflict',
  `another program is using 127.0.0.1:${port}, the Studio profile's lock port (${detail}); stop it or move the Studio profile`);
const LEGACY_LOCK_RE = /^studio-profile\.lock(\..*)?$/; // round-1/2 lock file and its temp/aside files
/**
 * Lock the Studio profile for this caller, plus a live Chromium SingletonLock check (only a headed window, e.g. one
 * not opened by Studio, creates it). -> async release fn (idempotent), or null when the profile is busy (another
 * Studio holder, including one in THIS process). Throws owner_profile_lock_port_conflict, without waiting, when a
 * non-Studio program owns the port.
 */
export async function lockOwnerProfile(profileDir) {
  try { const pid = Number(String(fs.readlinkSync(path.join(profileDir, 'SingletonLock'))).split('-').pop()); if (pid && pid !== process.pid && pidAlive(pid)) return null; } catch { /* none */ }
  const real = fs.realpathSync(profileDir);
  const port = profileLockPort(real);
  const holder = (who) => {
    if ((who.kind === 'studio' && who.dir === real) || who.kind === 'flux') return null; // busy
    if (who.kind === 'studio') throw portConflict(port, `Studio lock for another profile, ${who.dir}`);
    throw portConflict(port, who.detail);
  };
  // macOS lets a 127.0.0.1 bind succeed over another program's wildcard (0.0.0.0 / ::) listener on the same port (BSD
  // SO_REUSEADDR, always set by Node), which would silently shadow it: ask who is there first. Correctness between
  // Studio processes rests on the bind below, not on this probe.
  const before = await identifyLockPort(port);
  if (before.kind !== 'none') return holder(before);
  const server = net.createServer((c) => { c.on('error', () => {}); c.unref(); c.end(`${LOCK_BANNER} ${process.pid} ${real}\n`); });
  for (let attempt = 0; ; attempt++) {
    const err = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.off('error', resolve); resolve(null); });
    });
    if (!err) break;
    if (err.code !== 'EADDRINUSE') throw new OwnerSessionError('owner_profile_unavailable', `lock port 127.0.0.1:${port}: ${err.code || err.message}`);
    const who = await identifyLockPort(port);
    if (who.kind !== 'none') return holder(who);
    if (attempt >= 2) return null; // the holder is closing right now: busy, the caller retries
    await new Promise((r) => setTimeout(r, 50));
  }
  server.unref(); // a held lock never keeps Node alive (CRIT-17 class of hang)
  for (const n of (() => { try { return fs.readdirSync(profileDir); } catch { return []; } })()) // older versions' lock files
    if (LEGACY_LOCK_RE.test(n)) { try { fs.unlinkSync(path.join(profileDir, n)); } catch { /* best effort */ } }
  let closing = null;
  return () => (closing ??= new Promise((r) => server.close(() => r())));
}

/** Guarded (writes aborted, only counted), load /home, read the signed-in user and the short-lived tokens. */
async function readSessionFromPage(page, { now, log, waitMs, minRemainingMs, maxWaitMs }) {
  let entries = null, user = null, landed = null; const aborted = [];
  await page.route('**/*', (route) => {
    const r = route.request();
    const c = classifyRequest({ method: r.method(), url: r.url(), postData: r.postData(), headers: r.headers() });
    if (c.decision === 'allow' || c.decision === 'allow_logged') return route.continue();
    // Aborted requests never leave the browser (the home page fires read-only searches the guard can't
    // prove are reads); they are only counted. The borrow needs the page's sign-in, not its content.
    if (aborted.length < 50) aborted.push(`${r.method()} ${(() => { try { const u = new URL(r.url()); return u.hostname + u.pathname; } catch { return '?'; } })()} (${c.reason})`);
    return route.abort('blockedbyclient');
  });
  page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      if (res.request().method() !== 'GET' || !/\/users\/?$/.test(u.pathname) || !u.searchParams.has('uuid') || !res.ok()) return;
      user = companiesFromUserPayload(await res.json());
    } catch { /* passive */ }
  });
  // /home names no company: the source's own selected company is not changed. The app refreshes its tokens (with
  // the source's own refresh token, inside the source) only once they have expired; when they are valid but too
  // short-lived for a capture, wait for expiry (up to maxWaitMs) and reload, never touching the refresh token.
  const deadline = now() + maxWaitMs;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.goto(`${APP_ORIGIN}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(waitMs);
      const all = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('CognitoIdentityServiceProvider.')).map((k) => [k, localStorage.getItem(k)])));
      entries = selectBorrowedEntries(all);
      const st = inspectBorrowed(entries, { now: now(), minRemainingMs });
      if (st.ok || st.problem !== 'owner_token_expiring') break;
      const until = st.expiresAt + 15000 - now();
      if (now() + until > deadline) break;
      log(`[owner-session] tokens expire in ${Math.round((st.expiresAt - now()) / 60000)} min; waiting for the app to refresh them in its own session`);
      await page.waitForTimeout(Math.max(1000, until));
    }
  } finally { try { landed = new URL(page.url()).pathname; } catch { /* closed */ } }
  return { entries, user, landed, aborted };
}

function sessionFrom(c, T, now, { reused }) {
  const session = {
    status: 'owner_session', source: c.source === 'profile' ? 'studio-profile' : 'chrome', account: accountLabel(c.username), expiresAt: new Date(c.expiresAt).toISOString(),
    minutesLeft: Math.round((c.expiresAt - now()) / 60000), reusedBorrow: reused,
    companyCount: c.companies.length, companyIds: [T.companyId], tenantAccessible: true, borrowTabAbortedRequests: c.aborted,
  };
  // Non-enumerable: JSON.stringify(session) (run.json) can never include the tokens.
  Object.defineProperty(session, 'initScriptArg', { value: Object.freeze({ entries: c.entries, companyId: T.companyId, origin: APP_ORIGIN }), enumerable: false });
  return session;
}

/** Non-persistent, guarded-by-caller headless context carrying a borrowed session. Caller closes `browser`. */
export async function launchOwnerContext({ chromium, session, ctxOpts, headless = true }) {
  if (!session?.initScriptArg) throw new OwnerSessionError('owner_not_signed_in', 'no borrowed session');
  const browser = await chromium.launch({ headless });
  try {
    const ctx = await browser.newContext({ ...ctxOpts });
    await ctx.addInitScript(ownerInitScript, session.initScriptArg);
    ctx.on('close', () => { browser.close().catch(() => {}); });
    return ctx;
  } catch (e) { await browser.close().catch(() => {}); throw e; }
}


// ---------------------------------------------------------------- dedicated Studio profile
export const OWNER_PROFILE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.browser-profile-owner');
/** 'profile' (dedicated Studio profile) or 'chrome' (borrow from the everyday Chrome). */
export function ownerSource(env = process.env) {
  const v = String(env.DRIFT_OWNER_SOURCE || '').trim().toLowerCase();
  return v === 'chrome' ? 'chrome' : v === 'profile' ? 'profile' : (fs.existsSync(path.join(OWNER_PROFILE_DIR, 'studio-sign-in.json')) ? 'profile' : 'chrome');
}

/**
 * Open the dedicated profile headless, guarded (no app writes leave it), load /home and read who is signed in.
 * -> {companies, username} ; throws owner_profile_missing | owner_profile_busy | owner_not_signed_in.
 */
export async function inspectOwnerProfile({ chromium, profileDir = OWNER_PROFILE_DIR, waitMs = 8000, headless = true }) {
  if (!fs.existsSync(profileDir)) throw new OwnerSessionError('owner_profile_missing', `no Studio profile at ${profileDir}: run node tools/drift/owner-profile.mjs --sign-in`);
  const unlock = await lockOwnerProfile(profileDir);
  if (!unlock) throw new OwnerSessionError('owner_profile_busy', 'the Studio profile is open in another window or Studio process (close the sign-in window)');
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profileDir, { headless, viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' }); }
  catch (e) {
    await unlock();
    const m = String(e?.message || e);
    if (/ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(m)) throw new OwnerSessionError('owner_profile_busy', 'the Studio profile is open in another window (close the sign-in window)');
    throw new OwnerSessionError('owner_profile_unavailable', m.split('\n')[0].slice(0, 200));
  }
  let user = null, landed = null;
  try {
    await ctx.route('**/*', (route) => {
      const r = route.request();
      const c = classifyRequest({ method: r.method(), url: r.url(), postData: r.postData(), headers: r.headers() });
      return (c.decision === 'allow' || c.decision === 'allow_logged') ? route.continue() : route.abort('blockedbyclient');
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('response', async (res) => {
      try {
        const u = new URL(res.url());
        if (res.request().method() !== 'GET' || !/\/users\/?$/.test(u.pathname) || !u.searchParams.has('uuid') || !res.ok()) return;
        user = companiesFromUserPayload(await res.json());
      } catch { /* passive */ }
    });
    await page.goto(`${APP_ORIGIN}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < Math.max(1, Math.round(waitMs / 1000)) && !user; i++) await page.waitForTimeout(1000);
    try { landed = new URL(page.url()).pathname; } catch { /* closed */ }
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /\.LastAuthUser$/.test(k)).map((k) => localStorage.getItem(k))).catch(() => []);
    if (!user?.companies) throw new OwnerSessionError('owner_not_signed_in', `the Studio profile is not signed in to Hadrius (page: ${landed ?? 'unknown'}): run node tools/drift/owner-profile.mjs --sign-in`);
    return { companies: user.companies, username: keys[0] || null };
  } finally { await ctx.close().catch(() => {}); await unlock(); }
}
