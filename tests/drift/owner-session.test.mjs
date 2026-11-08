import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectBorrowedEntries, inspectBorrowed, jwtExpiryMs, chromeEndpoint, borrowOwnerSession, accountLabel, ownerInitScript, MIN_REMAINING_MS, clearOwnerSessionCache } from '../../tools/drift/owner-session.mjs';
import { captureRun } from '../../tools/drift/capture.mjs';
import { weeklyArgs } from '../../tools/drift/weekly-runner.mjs';

const APP = 'https://app.hadrius.com';
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.sig`;
const PFX = 'CognitoIdentityServiceProvider.abc123client';
const entriesFor = (exp, user = 'user-uuid') => ({
  [`${PFX}.LastAuthUser`]: user,
  [`${PFX}.${user}.idToken`]: jwt(exp), [`${PFX}.${user}.accessToken`]: jwt(exp),
  [`${PFX}.${user}.clockDrift`]: '0', [`${PFX}.${user}.signInDetails`]: '{}',
  [`${PFX}.${user}.refreshToken`]: 'LONG-LIVED-REFRESH', [`${PFX}.${user}.deviceKey`]: 'DEVICE', [`${PFX}.${user}.deviceGroupKey`]: 'G', [`${PFX}.${user}.randomPasswordKey`]: 'R',
});

test('only short-lived keys are borrowed: refresh token and device keys never leave the operator\'s Chrome', () => {
  const picked = selectBorrowedEntries(entriesFor(Date.now() + 3600e3));
  assert.deepEqual(Object.keys(picked).map((k) => k.split('.').at(-1)).sort(), ['LastAuthUser', 'accessToken', 'clockDrift', 'idToken', 'signInDetails']);
  assert.ok(!JSON.stringify(picked).includes('LONG-LIVED-REFRESH'));
  assert.ok(!JSON.stringify(picked).includes('DEVICE'));
});

test('expiry: tokens with less than the minimum validity are refused; unreadable tokens are refused', () => {
  const now = Date.now();
  assert.equal(inspectBorrowed(selectBorrowedEntries(entriesFor(now + MIN_REMAINING_MS + 60e3)), { now }).ok, true);
  assert.equal(inspectBorrowed(selectBorrowedEntries(entriesFor(now + 60e3)), { now }).problem, 'owner_token_expiring');
  assert.equal(inspectBorrowed({}, { now }).problem, 'owner_not_signed_in');
  const bad = selectBorrowedEntries(entriesFor(now + 3600e3)); bad[`${PFX}.user-uuid.accessToken`] = 'garbage';
  assert.equal(inspectBorrowed(bad, { now }).problem, 'owner_token_unreadable');
  assert.equal(jwtExpiryMs('x.y.z'), null);
});

test('Chrome endpoint: DevToolsActivePort when readable; the default debug port when macOS blocks the read; garbage refused', () => {
  const eperm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.equal(chromeEndpoint({ read: eperm, env: {} }), 'ws://127.0.0.1:9222/devtools/browser');
  assert.equal(chromeEndpoint({ read: eperm, env: { DRIFT_CHROME_DEBUG_PORT: '9333' } }), 'ws://127.0.0.1:9333/devtools/browser');
  assert.equal(chromeEndpoint({ read: () => '9222\n/devtools/browser/abc-123\n' }), 'ws://127.0.0.1:9222/devtools/browser/abc-123');
  assert.throws(() => chromeEndpoint({ read: () => 'nonsense' }), (e) => e.code === 'owner_chrome_unreachable');
});

test('borrowOwnerSession: nothing listening = owner_chrome_unreachable (fail closed)', async () => {
  clearOwnerSessionCache();
  await assert.rejects(borrowOwnerSession({ tenant: 'sandbox', chromium: { connectOverCDP: async () => { throw new Error('ECONNREFUSED'); } }, endpoint: 'ws://127.0.0.1:1/devtools/browser', waitMs: 0 }), (e) => e.code === 'owner_chrome_unreachable');
});

function fakeOwnerChrome({ entries, companies = [1048, 1150], aborts = [] }) {
  const events = [];
  let respHandler = null, routeHandler = null;
  const page = {
    route: async (_p, h) => { routeHandler = h; },
    on: (ev, h) => { if (ev === 'response') respHandler = h; },
    goto: async (u) => {
      events.push(['goto', u]);
      for (const a of aborts) { let r = null; await routeHandler({ request: () => ({ method: () => a.method, url: () => a.url, postData: () => null, headers: () => ({}) }), continue: async () => { r = 'continue'; }, abort: async () => { r = 'abort'; } }); events.push(['net', a.url, r]); }
      await respHandler({ url: () => 'https://api.hadrius.com/api/users/?uuid=u', request: () => ({ method: () => 'GET' }), ok: () => true,
        json: async () => ({ id: 1, company: { id: companies[0], children: companies.slice(1).map((id) => ({ id })) } }) });
    },
    waitForTimeout: async () => {}, evaluate: async () => entries, close: async () => { events.push(['close_tab']); },
  };
  const ctx = { waitForEvent: async () => page };
  const browser = { contexts: () => [ctx], newBrowserCDPSession: async () => ({ send: async (m, p) => events.push(['cdp', m, p]) }), close: async () => events.push(['disconnect']) };
  return { events, chromium: { connectOverCDP: async (ws) => { events.push(['connect', ws]); return browser; } } };
}

test('borrowOwnerSession: background tab, guarded, closed and disconnected; session object never serialises tokens', async () => {
  clearOwnerSessionCache();
  const fc = fakeOwnerChrome({ entries: entriesFor(Date.now() + 3600e3), aborts: [{ method: 'POST', url: 'https://api.hadrius.com/api/company/1048/comms-review/messages/v3/search/' }, { method: 'PATCH', url: 'https://api.hadrius.com/api/x/1/' }] });
  const s = await borrowOwnerSession({ tenant: 'sandbox', chromium: fc.chromium, endpoint: 'ws://127.0.0.1:9/devtools/browser/x', waitMs: 0 });
  assert.equal(s.status, 'owner_session'); assert.equal(s.account, accountLabel('user-uuid')); assert.deepEqual(s.companyIds, [1048]);
  assert.equal(s.borrowTabAbortedRequests, 2);
  assert.deepEqual(fc.events.filter((e) => e[0] === 'net').map((e) => e[2]), ['abort', 'abort'], 'app writes/unproven reads never leave the borrow tab');
  assert.deepEqual(fc.events.find((e) => e[0] === 'cdp')[2], { url: 'about:blank', background: true, newWindow: true });
  assert.ok(fc.events.some((e) => e[0] === 'close_tab') && fc.events.at(-1)[0] === 'disconnect');
  assert.equal(fc.events.find((e) => e[0] === 'goto')[1], `${APP}/home`, 'no company_id: the operator\'s selected company is not changed');
  const json = JSON.stringify(s);
  assert.ok(!/eyJ|h\.[A-Za-z0-9_-]+\.sig|LONG-LIVED/.test(json), 'no token in the serialised session');
  assert.ok(s.initScriptArg && Object.keys(s.initScriptArg.entries).every((k) => !/refreshToken|deviceKey/.test(k)));
});

test('borrowOwnerSession: an account that cannot open the tenant company is refused', async () => {
  clearOwnerSessionCache();
  const fc = fakeOwnerChrome({ entries: entriesFor(Date.now() + 3600e3), companies: [1150] });
  await assert.rejects(borrowOwnerSession({ tenant: 'sandbox', chromium: fc.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0 }), (e) => e.code === 'owner_tenant_not_accessible');
});

test('ownerInitScript only writes on the app origin and pins the tenant company', () => {
  const store = {};
  globalThis.location = { origin: 'https://evil.example' };
  globalThis.localStorage = { setItem: (k, v) => { store[k] = v; } };
  try {
    ownerInitScript({ entries: { a: '1' }, companyId: 1048, origin: APP });
    assert.deepEqual(store, {});
    globalThis.location = { origin: APP };
    ownerInitScript({ entries: { a: '1' }, companyId: 1048, origin: APP });
    assert.deepEqual(store, { a: '1', lastCompanyId: '1048' });
  } finally { delete globalThis.location; delete globalThis.localStorage; }
});

// ---- captureRun in owner mode (fake browser)
function fakeLaunchChromium({ lastCompanyIdFor = () => '1048' } = {}) {
  const actions = [];
  const mkPage = () => { let url = 'about:blank'; return {
    url: () => url, goto: async (u) => { actions.push(['goto', u]); url = u; }, waitForURL: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {}, setViewportSize: async () => {}, on: () => {},
    title: async () => 'T', screenshot: async ({ path }) => { writeFileSync(path, 'png'); actions.push(['shot', url]); }, keyboard: { press: async () => {} },
    evaluate: async (expr) => { const e = String(expr); if (e.includes('aria-busy')) return false;
      if (e.includes('hasPassword')) return { url, hasPassword: false, hasAppNav: true, academy: false, tenantNameVisible: true, title: 'T', lastCompanyId: lastCompanyIdFor(url) };
      return []; },
  }; };
  return { actions, launchPersistentContext: async () => { throw new Error('owner runs must not open an automation profile'); },
    launch: async () => ({ close: async () => actions.push(['browser_close']), newContext: async () => { const p = mkPage(); return {
      addInitScript: async (fn, arg) => actions.push(['init', typeof fn, arg ? Object.keys(arg) : null]), route: async () => {}, routeWebSocket: async () => {}, pages: () => [p], newPage: async () => p, on: () => {}, close: async () => actions.push(['ctx_close']) }; } }) };
}
const SB = `${APP}/marketing/projects?company_id=1048`;
const sbScript = { name: 'sb', environment: { startUrl: SB }, recording: { id: 'r' }, steps: [
  { index: 0, action: 'navigate', url: SB, value: SB, route: '/marketing/projects?company_id=1048', media: { pre: 'a.png' } },
  { index: 1, action: 'navigate', url: `${APP}/marketing/archive`, value: `${APP}/marketing/archive`, route: '/marketing/archive', media: { pre: 'b.png' } }] };
const fakeBorrow = async ({ tenant }) => { const s = { status: 'owner_session', account: 'owner:abc', companyIds: [tenant === 'sandbox' ? 1048 : 1150] };
  Object.defineProperty(s, 'initScriptArg', { value: { entries: { [`${PFX}.u.accessToken`]: 'SECRET-TOKEN' }, companyId: 1048, origin: APP }, enumerable: false }); return s; };
const LIM = { stepMs: 5000, totalMs: 30000, settleMs: 0, idleMs: 0, manualLoginMs: 0, loadingWaitMs: 0 };
async function withBridgeIdle(fn) { const f = globalThis.fetch; globalThis.fetch = async () => ({ json: async () => ({ running: false }) }); try { return await fn(); } finally { globalThis.fetch = f; } }

test('captureRun owner mode: borrowed session, no automation profile, tenant pinned on every step, no token in run.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-owner-')); const sp = join(dir, 's.json'); writeFileSync(sp, JSON.stringify(sbScript));
  const fc = fakeLaunchChromium();
  const run = await withBridgeIdle(() => captureRun({ scriptPath: sp, outDir: join(dir, 'run'), log: () => {}, chromium: fc, session: 'owner', borrowSession: fakeBorrow, limits: LIM }));
  assert.equal(run.status, 'captured', JSON.stringify(run.findings)); assert.equal(run.tenantVerified, true);
  assert.equal(run.profile, 'owner-chrome'); assert.equal(run.sessionMode, 'owner'); assert.equal(run.session.status, 'owner_session');
  assert.ok(!readFileSync(join(dir, 'run', 'run.json'), 'utf8').includes('SECRET-TOKEN'));
  assert.ok(fc.actions.some((a) => a[0] === 'init' && a[2]?.includes('entries')), 'borrowed session injected via init script');
  assert.ok(fc.actions.filter((a) => a[0] === 'init' && a[2] === null).length >= 1, 'announcement suppression applied');
});

test('captureRun owner mode: a step where the app switched company fails the video (tenant_mismatch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-owner-')); const sp = join(dir, 's.json'); writeFileSync(sp, JSON.stringify(sbScript));
  const fc = fakeLaunchChromium({ lastCompanyIdFor: (u) => (u.includes('/archive') ? '1150' : '1048') });
  const run = await withBridgeIdle(() => captureRun({ scriptPath: sp, outDir: join(dir, 'run'), log: () => {}, chromium: fc, session: 'owner', borrowSession: fakeBorrow, limits: LIM }));
  assert.notEqual(run.status, 'captured'); assert.equal(run.steps[1].error, 'tenant_mismatch'); assert.deepEqual(run.steps[1].tenantSeen, { lastCompanyId: '1150', urlCompanyId: null });
});

test('captureRun owner mode: Chrome unreachable fails closed as session_failed; fixtures are never run as the operator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-owner-')); const sp = join(dir, 's.json'); writeFileSync(sp, JSON.stringify(sbScript));
  const err = Object.assign(new Error('owner_chrome_unreachable'), { code: 'owner_chrome_unreachable', detail: 'off' });
  const r1 = await withBridgeIdle(() => captureRun({ scriptPath: sp, outDir: join(dir, 'r1'), log: () => {}, chromium: fakeLaunchChromium(), session: 'owner', borrowSession: async () => { throw err; }, limits: LIM }));
  assert.equal(r1.status, 'session_failed'); assert.equal(r1.session.status, 'owner_chrome_unreachable');
  const r2 = await withBridgeIdle(() => captureRun({ scriptPath: sp, outDir: join(dir, 'r2'), log: () => {}, chromium: fakeLaunchChromium(), session: 'owner', borrowSession: fakeBorrow, fixture: { tenant: 'sandbox', allow: () => false, runId: 'x', label: 'x', journal: { file: 'j' } }, limits: LIM }));
  assert.equal(r2.status, 'session_failed'); assert.equal(r2.findings[0].status, 'fixtures_require_automation_account');
  await assert.rejects(captureRun({ scriptPath: sp, outDir: join(dir, 'r3'), session: 'bogus' }), /unknown_session_mode/);
});

test('weekly runner passes the capture session to weekly.mjs and rejects unknown ones', () => {
  const a = weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'], session: 'owner' });
  assert.deepEqual(a.slice(-2), ['--session', 'owner']);
  assert.ok(!weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'] }).includes('--session'));
  assert.throws(() => weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'], session: 'root' }), /invalid_session/);
});

test('borrowOwnerSession: a still-valid borrow is reused without touching Chrome; tenant access is still checked', async () => {
  clearOwnerSessionCache();
  const fc = fakeOwnerChrome({ entries: entriesFor(Date.now() + 3600e3), companies: [1150] });
  const a = await borrowOwnerSession({ tenant: 'academy', chromium: fc.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0 });
  const connects = fc.events.filter((e) => e[0] === 'connect').length;
  const b = await borrowOwnerSession({ tenant: 'academy', chromium: fc.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0 });
  assert.equal(a.reusedBorrow, false); assert.equal(b.reusedBorrow, true);
  assert.equal(fc.events.filter((e) => e[0] === 'connect').length, connects, 'no second Chrome connection');
  await assert.rejects(borrowOwnerSession({ tenant: 'sandbox', chromium: fc.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0 }), (e) => e.code === 'owner_tenant_not_accessible');
  clearOwnerSessionCache();
});

test('borrowOwnerSession: short-lived tokens are refused without waiting, or awaited until the app refreshes them', async () => {
  clearOwnerSessionCache();
  let clock = 1_000_000_000_000; const now = () => clock;
  const soon = entriesFor(clock + 5 * 60e3), later = entriesFor(clock + 70 * 60e3);
  const fc = fakeOwnerChrome({ entries: soon });
  await assert.rejects(borrowOwnerSession({ tenant: 'sandbox', chromium: fc.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0, now, useCache: false }), (e) => e.code === 'owner_token_expiring');
  // With a wait budget: the borrow tab waits past expiry, reloads, and the app has refreshed the tokens.
  const fc2 = fakeOwnerChrome({ entries: soon }); let reads = 0;
  const browser = await fc2.chromium.connectOverCDP('x'); const page = await browser.contexts()[0].waitForEvent('page');
  page.evaluate = async () => (++reads === 1 ? soon : later);
  page.waitForTimeout = async (ms) => { clock += ms; };
  const s = await borrowOwnerSession({ tenant: 'sandbox', chromium: fc2.chromium, endpoint: 'ws://x/devtools/browser/y', waitMs: 0, now, useCache: false, maxWaitMs: 20 * 60e3 });
  assert.equal(s.status, 'owner_session'); assert.equal(reads, 2); assert.ok(s.minutesLeft >= 60);
});
