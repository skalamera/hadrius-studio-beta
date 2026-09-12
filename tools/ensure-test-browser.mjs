// Hadrius Studio — make sure a CDP-debuggable, signed-in Hadrius test browser is running on
// KBS_PORT before a recipe or replay render tries to attach to it (renderer/from-recipe.mjs,
// renderer/replay.mjs, tools/stage-lib.mjs's connect() — all three chromium.connectOverCDP or
// raw-CDP against http://localhost:${KBS_PORT}).
//
// Before this existed, "no browser running" surfaced as a raw crash from deep inside the render —
// "the recipe never wrote recipe-report.json" or a bare "retrieving websocket url" failure — with
// no indication that the fix was as simple as opening a Chrome window. This script IS that fix: it
// checks for the browser, and if it's missing, launches one and waits for you to sign in, instead
// of making render.sh fail immediately.
//
// Deliberately a SEPARATE, dedicated Chrome profile (.test-browser-profile/, gitignored) rather
// than your everyday Chrome — so running a render never means quitting your own browser windows to
// relaunch Chrome with debug flags by hand.
//
// What this does NOT solve (see README.md's Render section for the full reasoning): staying signed
// in is still on you, roughly daily. Cognito's refresh token is fixed at ~1 day regardless of
// activity, and staging's database is rebuilt from a production snapshot every night — randomizing
// every user's UUID — so no saved session, in this profile or any other, survives that reliably.
// This removes the "remember and retype the exact launch incantation" friction; it doesn't remove
// the human sign-in step, which nothing short of a real Hadrius-side M2M credential bridge can.
//
// Usage: node tools/ensure-test-browser.mjs [targetUrl]
// render.sh passes the specific script's own environment.startUrl — app.hadrius.com for recipes and
// hand-recorded scripts, staging.hadrius.com for AI-recorder-originated ones (tools/ai-record.mjs's
// STAGING_BASE). These are DIFFERENT origins with unrelated cookie jars: being signed in on one says
// nothing about the other, so this must check/open a tab for the SPECIFIC origin a render needs, not
// just "some Hadrius tab" — an app.hadrius.com tab being signed in does not help a script whose
// recorded startUrl is staging.hadrius.com, and replay.mjs will correctly (if confusingly) report
// "LOGIN REQUIRED" for that mismatch since it navigates to the script's real startUrl itself.
// With no argument, defaults to app.hadrius.com (the recipe/render convention).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_TENANT_COMPANY_ID } from './stage-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.KBS_PORT || 9333;
const PROFILE_DIR = path.join(REPO_ROOT, '.test-browser-profile');
const TARGET_ARG = process.argv[2] || '';
let TARGET_ORIGIN;
try { TARGET_ORIGIN = new URL(TARGET_ARG).origin; } catch { TARGET_ORIGIN = 'https://app.hadrius.com'; }
const START_URL = TARGET_ARG || `${TARGET_ORIGIN}/overview?company_id=${STUDIO_TENANT_COMPANY_ID}`;
const SIGNIN_WAIT_MS = 10 * 60 * 1000; // matches ai-record.mjs's own LOGIN_WAIT_MS convention
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  try { return await (await fetch(`http://localhost:${PORT}/json`, { signal: AbortSignal.timeout(2000) })).json(); }
  catch { return null; }
}
// Matches a tab on the SPECIFIC origin this render needs, never just "any Hadrius tab" — see the
// header comment on why that distinction is the whole point of taking a target argument at all.
async function targetTab() {
  const targets = await cdpTargets();
  return targets?.find((t) => t.type === 'page' && t.url.startsWith(TARGET_ORIGIN)) || null;
}

/** One CDP command against a page target over its own short-lived WebSocket connection — the same
 * minimal client stage-lib.mjs's connect() uses, kept self-contained here since this only ever
 * needs one-off calls (a fresh connection per call, not a kept-open session). */
async function cdpSend(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 4000);
      ws.addEventListener('message', (m) => { clearTimeout(timer); resolve(JSON.parse(m.data)); }, { once: true });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    return result.result;
  } finally { ws.close(); }
}
const evalInTab = (target, expression) =>
  cdpSend(target, 'Runtime.evaluate', { expression, returnByValue: true }).then((r) => r?.result?.value);

// The whole render pipeline assumes a 1600x900 viewport (renderer/assemble.py stretches every
// captured slide straight to 1920x1080 with no aspect-ratio correction, on the assumption that
// 1600x900 -> 1920x1080 is an exact, distortion-free 16:9 scale — see its own comment). A
// launched-but-unsized Chrome window has no reason to open at that shape (this machine's default
// turned out to be ~1200x1245, nearly square), so every slide came out visibly squashed: wide
// relative to how tall it should be. Emulation.setDeviceMetricsOverride pins the PAGE's own
// rendered viewport to exactly 1600x900 regardless of the actual OS window size — the same
// technique headless screenshot tools use — so captures are correct independent of window chrome,
// display scaling, or whatever size Chrome happened to default to.
async function forceViewport(target) {
  await cdpSend(target, 'Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
}

// forceViewport only fakes the CSS/layout viewport for the page's own DOM and JS (confirmed live via
// Page.getLayoutMetrics reporting a correct 1600x900) — it does NOT make page.screenshot() reliable
// if the real native Chrome window isn't actually visible and composited at that size. A window left
// minimized, or dragged off-screen (e.g. a negative left/top left over from a previous session),
// still reports the emulated layout correctly, but the actual screenshot capture falls back to
// whatever the window's last real on-screen framebuffer size was — this is exactly how slides kept
// coming out at non-16:9 sizes (846x1281, ~1200x1245) even after the layout override "succeeded".
// Fix: force the REAL window out of minimized/maximized state and onto a fixed, on-screen, big-enough
// position/size before applying the layout override above.
async function forceWindowVisible(target) {
  const { windowId, bounds } = await cdpSend(target, 'Browser.getWindowForTarget', { targetId: target.id });
  if (bounds?.windowState && bounds.windowState !== 'normal') {
    // Chrome refuses to accept explicit left/top/width/height in the same call that also changes
    // windowState away from minimized/maximized — clear the state first, then position it separately.
    await cdpSend(target, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }
  await cdpSend(target, 'Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 60, width: 1680, height: 1000 } });
}

// Same signal ai-record.mjs's isSignedIn/settleAuthRedirect use, and for the same reason: the SPA
// paints the requested route FIRST and only bounces to its real sign-in page once its own token
// check fails asynchronously — so checking immediately after a tab appears reads "signed in" on a
// page that hasn't redirected yet. Checking the URL (available the instant the tab exists) catches
// that redirect the moment it happens; the password-field DOM check is a fallback for sign-in flows
// that don't change the path at all.
const LOGIN_PATH_RE = /\/(login|log-in|signin|sign-in|auth|sso|oauth|callback|mfa|verify|password)(\/|$|\?)/i;
async function needsSignIn(target) {
  try { if (LOGIN_PATH_RE.test(new URL(target.url).pathname)) return true; } catch { /* fall through to the DOM check */ }
  return evalInTab(target, `!!document.querySelector('input[type="password"]')`).catch(() => true); // unreadable = assume not signed in yet
}

async function main() {
  if (!(await targetTab())) {
    if (await cdpTargets()) {
      console.log(`Chrome is already running on :${PORT} but has no tab on ${TARGET_ORIGIN} open — opening one…`);
      await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(START_URL)}`, { method: 'PUT' }).catch(() => {});
    } else {
      const bin = CHROME_PATHS.find((p) => fs.existsSync(p));
      if (!bin) throw new Error(`No Chrome-family browser found at any of: ${CHROME_PATHS.join(', ')} — install one, or start your own with --remote-debugging-port=${PORT} and a tab open on ${TARGET_ORIGIN}`);
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      console.log(`No test browser running on :${PORT} — launching a dedicated Chrome (separate from your regular one; profile kept at .test-browser-profile/)…`);
      const child = spawn(bin, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        START_URL,
      ], { detached: true, stdio: 'ignore' });
      child.unref(); // keep running after this script exits — render.sh, and every render after it, reuse the same window
    }
  }

  // Give the tab a moment to actually appear (near-instant once Chrome starts / the new-tab call lands).
  let tab = null;
  for (let i = 0; i < 40 && !tab; i++) { await sleep(500); tab = await targetTab(); }
  if (!tab) throw new Error(`Chrome is running but no tab on ${TARGET_ORIGIN} appeared on :${PORT} within 20s — check that ${START_URL} loads there`);

  // Restore/position the real window, THEN pin the emulated layout viewport on top of it — cheap,
  // idempotent, and every capture from here on (including this run's own sign-in-detection
  // screenshots, for what little that matters) should be at the size the render pipeline expects.
  await forceWindowVisible(tab).catch((e) => console.error(`(could not restore/position the test browser window — slides may render distorted: ${e.message})`));
  await forceViewport(tab).catch((e) => console.error(`(could not pin viewport to 1600x900 — slides may render distorted: ${e.message})`));

  // Settle first: give the SPA's own async token check time to bounce to its real sign-in page
  // before judging anything — checking immediately reads "signed in" on a page that just hasn't
  // redirected yet (the exact bug ai-record.mjs's settleAuthRedirect exists to avoid).
  await sleep(1500);
  tab = (await targetTab()) || tab;
  if (!(await needsSignIn(tab))) { console.log('test browser ready and signed in, viewport 1600x900'); return; }

  console.log(`Sign-in needed — a Chrome window is open at ${START_URL}. Log in there (2FA if asked); this continues automatically once you're signed in (waiting up to ${Math.round(SIGNIN_WAIT_MS / 60000)} min)…`);
  const deadline = Date.now() + SIGNIN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    const t = await targetTab();
    if (t && !(await needsSignIn(t))) { console.log('signed in — continuing'); return; }
  }
  throw new Error(`timed out after ${Math.round(SIGNIN_WAIT_MS / 60000)} min waiting for sign-in`);
}

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
