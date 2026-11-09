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
    const unlock = lockOwnerProfile(profileDir);
    if (!unlock) {
      if (Date.now() < until) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
      throw new OwnerSessionError('owner_profile_busy', 'the Studio profile stayed open in another window or Studio process (close the sign-in window)');
    }
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' });
      const page = ctx.pages()[0] || await ctx.newPage();
      return { page, close: () => ctx.close().catch(() => {}).finally(unlock) };
    } catch (e) {
      unlock();
      const m = String(e?.message || e);
      const busy = /ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(m);
      if (busy && Date.now() < until) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
      if (busy) throw new OwnerSessionError('owner_profile_busy', 'the Studio profile stayed open in another window (close the sign-in window)');
      throw new OwnerSessionError('owner_profile_unavailable', m.split('\n')[0].slice(0, 200));
    }
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/**
 * Studio's own lock on the profile (`studio-profile.lock`, holds the pid), plus a live Chromium SingletonLock (only a
 * headed window, e.g. one not opened by Studio, creates it).
 * -> release fn (idempotent; removes the file only while it still holds our pid), or null when the profile is busy.
 *
 * Both directions are atomic (council round 2, 20261109-261d071f):
 *  - Publish: the pid is written to a unique temp file first and hard-linked into place, so the lock is never visible
 *    without its content (create-then-write let a second process read '' and reclaim a LIVE lock as stale).
 *  - Unreadable, empty or unparseable content is busy (retry later), never stale.
 *  - Reclaim only a parseable pid confirmed dead, by renaming the file aside and re-reading the renamed copy: if it is
 *    still the dead pid it is discarded; if it is anything else a successor got there first, so it is put back
 *    (link, EEXIST ignored) and the profile is busy. A plain read-check-unlink let one reclaimer delete the other's
 *    fresh lock. (Not proper-lockfile: its stale reclaim is the same stat-then-remove race.)
 */
export function lockOwnerProfile(profileDir) {
  try { const pid = Number(String(fs.readlinkSync(path.join(profileDir, 'SingletonLock'))).split('-').pop()); if (pid && pid !== process.pid && pidAlive(pid)) return null; } catch { /* none */ }
  const f = path.join(profileDir, 'studio-profile.lock');
  const me = String(process.pid);
  const unique = (tag) => `${f}.${tag}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = unique('tmp');
    let linked = false;
    fs.writeFileSync(tmp, me, { flag: 'wx', mode: 0o600 }); // unique name: complete before it can become the lock
    try { fs.linkSync(tmp, f); linked = true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    if (linked) {
      let held = true;
      return () => { if (!held) return; held = false; try { if (fs.readFileSync(f, 'utf8') === me) fs.unlinkSync(f); } catch { /* gone */ } };
    }
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; return null; } // released meanwhile: retry
    if (!/^\d+$/.test(text)) return null; // empty / in flight / unknown: busy, never stale
    const pid = Number(text);
    if (pidAlive(pid)) return null;
    // Dead holder: take the file aside, then make sure what we took is that dead holder's lock.
    const aside = unique('stale');
    try { fs.renameSync(f, aside); } catch (e) { if (e.code === 'ENOENT') continue; return null; } // another reclaimer won the rename
    let taken = null; try { taken = fs.readFileSync(aside, 'utf8'); } catch { /* unreadable */ }
    if (taken === text) { try { fs.unlinkSync(aside); } catch { /* gone */ } continue; } // discarded; acquire on the next pass
    try { fs.linkSync(aside, f); } catch { /* EEXIST: someone else holds it now */ }
    try { fs.unlinkSync(aside); } catch { /* gone */ }
    return null;
  }
  return null;
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
  const unlock = lockOwnerProfile(profileDir);
  if (!unlock) throw new OwnerSessionError('owner_profile_busy', 'the Studio profile is open in another window or Studio process (close the sign-in window)');
  let ctx;
  try { ctx = await chromium.launchPersistentContext(profileDir, { headless, viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' }); }
  catch (e) {
    unlock();
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
  } finally { await ctx.close().catch(() => {}); unlock(); }
}
