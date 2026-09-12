// Hadrius Studio — shared plumbing for Phase 1 hand-written recipes (arrange -> check -> act ->
// assert -> teardown contracts, per the "Staged Studio" design doc). Extracted from
// tools/recipe-approve-run.mjs once a second recipe (resolve-finding) needed the same CDP driving,
// tenant gate, and report boilerplate — a recipe file should now contain only its own
// arrange/checkPreconditions/act/assertOutcome/teardown steps.
//
// Recipes drive the real UI over CDP against the already-logged-in KB Studio test browser (same
// technique as tools/perform-create-test.mjs), not the raw backend API — see the comment this file
// used to carry in recipe-approve-run.mjs for why (the client resolves its API base via a fetcher
// wrapper with no literal baseURL in the bundles, so UI-driving is the reliable path today).
import fs from 'node:fs';
import path from 'node:path';

export const STUDIO_TENANT_COMPANY_ID = '1013';
export const STUDIO_ENTITY_ID = '571'; // "Stephen Investments" entity within company 1013

export function classified(phase, message) { const e = new Error(message); e.phase = phase; return e; }
export const uniqueSuffix = () => `kbs-${Date.now().toString(36)}`;

// Slide capture (opt-in — for renderer/from-recipe.mjs, see the bottom of this file). Off by
// default: plain `node tools/recipe-X.mjs` runs exactly as it always has, with zero overhead and
// zero risk to any already-verified recipe. Set KBS_CAPTURE_DIR (or pass { captureDir } to
// connect()) to have every real click/navigate write a numbered slide PNG plus a bbox/viewport
// record, in the same shape renderer/from-recording.mjs and renderer/replay.mjs already produce —
// so renderer/assemble.py needs no changes to turn a recipe's own walkthrough into a video.
// A pulsing, glowing mouse-style pointer that is hollow in the middle with red borders — so viewers
// can see exactly what is being pointed at and underlying button/link text is never covered by a solid dot.
const CALLOUT_ON = (finder) => `(()=>{const el=(${finder})(); if(!el) return false; document.getElementById('kbs-dot')?.remove(); el.classList.add('kbs-outline'); if(!document.getElementById('kbs-style')){const s=document.createElement('style'); s.id='kbs-style'; s.textContent='@keyframes kbs-outline-pulse{0%,100%{box-shadow:0 0 8px rgba(239,68,68,.7)!important}50%{box-shadow:0 0 16px rgba(239,68,68,1)!important}}@keyframes kbs-pointer-pulse{0%,100%{filter:drop-shadow(0 0 4px rgba(239,68,68,.85)) drop-shadow(0 0 10px rgba(239,68,68,.55));transform:translate(-3px,-2px) scale(1)}50%{filter:drop-shadow(0 0 8px rgba(239,68,68,1)) drop-shadow(0 0 18px rgba(239,68,68,.9));transform:translate(-3px,-2px) scale(1.08)}}.kbs-outline{outline:3px solid #ef4444!important;outline-offset:3px!important;box-shadow:0 0 12px rgba(239,68,68,.8)!important;border-radius:6px!important;animation:kbs-outline-pulse 1.4s ease-in-out infinite!important}#kbs-dot{position:fixed;z-index:2147483647;pointer-events:none;transform-origin:3px 2px;animation:kbs-pointer-pulse 1.4s ease-in-out infinite}'; document.head.appendChild(s);} const r=el.getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2; const d=document.createElement('div'); d.id='kbs-dot'; d.style.left=cx+'px'; d.style.top=cy+'px'; d.innerHTML='<svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 18.5 L7.2 14.6 L9.8 20.8 L12.7 19.5 L10.1 13.4 L16 13.4 Z" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/><path d="M3 2 L3 18.5 L7.2 14.6 L9.8 20.8 L12.7 19.5 L10.1 13.4 L16 13.4 Z" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>'; document.body.appendChild(d); return true;})()`;
const CALLOUT_OFF = `(()=>{document.getElementById('kbs-dot')?.remove(); document.querySelectorAll('.kbs-outline').forEach(n=>n.classList.remove('kbs-outline'));})()`;

// Connects to the test browser's Hadrius tab over CDP and returns the driving primitives every
// recipe's arrange/act steps are built from.
export async function connect(opts = {}) {
  const PORT = process.env.KBS_PORT || 9333;
  const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('hadrius'));
  if (!page) throw new Error('no Hadrius tab open in the test browser (KBS_PORT=' + PORT + ')');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.addEventListener('open', r));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'js error');
    return r.result?.result?.value;
  };
  const center = async (finder, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      const c = await ev(`(()=>{ const el=(${finder})(); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      if (c) return c; await sleep(250);
    }
    throw new Error('element not found: ' + finder);
  };

  const captureDir = opts.captureDir || process.env.KBS_CAPTURE_DIR || null;
  const slides = [];
  let slideNo = 0;
  let captureEnabled = true;
  let lastCaption = '';
  // Takes one slide right now: screenshot -> disk, plus viewport/route and (if `finder` resolves)
  // a device-pixel bbox for the Ken Burns/callout target — same fields from-recording.mjs uses.
  const captureSlide = async (finder) => {
    if (!captureDir || !captureEnabled) return null;
    if (finder) await ev(CALLOUT_ON(finder)).catch(() => {});
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (finder) await ev(CALLOUT_OFF).catch(() => {});
    if (!shot.result?.data) return null;
    slideNo++;
    const file = `slide_${String(slideNo).padStart(2, '0')}.png`;
    fs.mkdirSync(path.join(captureDir, 'slides'), { recursive: true });
    fs.writeFileSync(path.join(captureDir, 'slides', file), Buffer.from(shot.result.data, 'base64'));
    let target = null; let viewport = { width: 1600, height: 900 }; let route = null;
    try {
      const m = await ev(`(()=>({dpr: window.devicePixelRatio||1, vw: window.innerWidth, vh: window.innerHeight, route: location.pathname + location.search}))()`);
      viewport = { width: Math.round(m.vw * m.dpr), height: Math.round(m.vh * m.dpr) };
      route = m.route;
      if (finder) {
        const bbox = await ev(`(()=>{const el=(${finder})(); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
        if (bbox) target = { x: Math.round(bbox.x * m.dpr), y: Math.round(bbox.y * m.dpr), width: Math.round(bbox.w * m.dpr), height: Math.round(bbox.h * m.dpr) };
      }
    } catch (_) { /* best-effort — a missing viewport/bbox still leaves a usable slide */ }
    const rec = { slide: slideNo, file, narration: lastCaption, caption: lastCaption, target, viewport, route };
    slides.push(rec);
    return rec;
  };

  const click = async (finder) => {
    const { x, y } = await center(finder);
    await captureSlide(finder);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(500);
  };
  // Click an element found by an in-page JS expression, without the getBoundingClientRect retry
  // loop — for actions inside a menu/popover where a real mouse-event click via `click()` fights
  // the popover's own open/close race. Returns whether an element was found and clicked.
  const clickNow = async (finder) => { await captureSlide(finder); return ev(`(()=>{const el=(${finder})(); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true;})()`); };
  const type = async (text) => { for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(20); } await sleep(200); };
  const byText = (sel, text, exact = true) => `()=>Array.from(document.querySelectorAll('${sel}')).find(e=>{const t=(e.innerText||e.textContent).replace(/\\s+/g,' ').trim(); return ${exact ? 't===' : 't.includes('}${JSON.stringify(text)}${exact ? '' : ')'};})`;
  const textContains = async (needle) => (await ev(`document.body.innerText.includes(${JSON.stringify(needle)})`)) === true;
  const waitForText = async (needle, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) { if (await textContains(needle)) return true; await sleep(300); }
    return false;
  };
  // Poll an in-page JS expression until it returns a truthy value, or time out. Use for gates that
  // appear/enable asynchronously after an action (a button that re-enables once a required side
  // effect lands, a control that renders late).
  const waitForEval = async (expr, timeoutMs = 6000, intervalMs = 400) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) { const v = await ev(expr); if (v) return v; await sleep(intervalMs); }
    return null;
  };
  const currentUrl = async () => ev('location.href');
  const navigate = async (url, settleMs = 3000) => { await send('Page.navigate', { url }); await sleep(settleMs); await captureSlide(null); };
  const close = () => ws.close();
  const driver = {
    send, ev, click, clickNow, type, byText, textContains, waitForText, waitForEval, currentUrl, navigate, sleep, close,
    captureSlide, getSlides: () => slides, getCaptureDir: () => captureDir,
    _setCaption: (msg) => { lastCaption = msg; },
    _setCaptureEnabled: (on) => { captureEnabled = on; },
  };
  activeDriver = driver;
  return driver;
}

// Mutation gate: hard tenant allow-list, checked before any write step. Refuses to proceed unless
// the page's own UI shows the Studio tenant — never trust the URL alone (a stale query param would
// otherwise be enough to fool a URL-only check).
export async function assertTenantGate(driver, tenantId = STUDIO_TENANT_COMPANY_ID, tenantLabelPattern = /Stephen Investm[a-z]*\s+1013/) {
  const url = await driver.currentUrl();
  // A session that expired mid-run redirects to /auth/sign-in, still under app.hadrius.com, so it
  // would otherwise fall straight through to the generic tenant-gate message below — which reads
  // as "this precondition was already consumed" and sends whoever's debugging it chasing the wrong
  // cause entirely, instead of the real, simple fix (sign back in on the recipe's own browser tab).
  if (/\/auth\/sign-in/.test(url)) throw classified('auth-expired', `signed out — redirected to ${url}`);
  const onHadrius = url.includes('app.hadrius.com') || url.includes('staging.hadrius.com');
  if (!onHadrius) throw classified('precondition', `not on a Hadrius tab: ${url}`);
  const matches = await driver.ev(`(()=>{ return ${tenantLabelPattern.toString()}.test(document.body.innerText); })()`);
  if (!matches) {
    throw classified('precondition', `tenant gate failed — page does not show the Studio tenant (company ${tenantId}); refusing to run mutating steps`);
  }
}

// Set by connect() — the one driver a recipe process has open. Lets log() double as the caption
// source for slide capture without every recipe file having to pass `d` into every log() call.
let activeDriver = null;
const log = (phase, msg) => { console.log(`[${phase}] ${msg}`); activeDriver?._setCaption(msg); };

// Runs a recipe's full arrange -> check -> act -> assert -> teardown lifecycle, writes a JSON
// report to out/_recipes/, and exits 0/1. A recipe file calls this once with its five phase
// functions; everything else (connecting, the try/catch/finally, the report shape, process.exit)
// lives here so a new recipe is just its own workflow-specific steps.
export async function runRecipe({ name, tenant = STUDIO_TENANT_COMPANY_ID, entity = STUDIO_ENTITY_ID, arrange, checkPreconditions, act, assertOutcome, teardown }) {
  const driver = await connect();
  const report = { recipe: name, tenant, entity, startedAt: new Date().toISOString() };
  try {
    const bound = await arrange(driver);
    report.bound = bound;
    if (checkPreconditions) await checkPreconditions(driver, bound);
    await act(driver, bound);
    const assertResult = await assertOutcome(driver, bound);
    Object.assign(report, assertResult, { result: 'PASS' });
    // One closing slide showing the confirmed state, captioned with assertOutcome's own PASS
    // message — there's usually no click here to hang an automatic capture off of.
    await driver.captureSlide();
    // Teardown is Studio's own cleanup (revert/cancel/reopen), not part of the workflow being
    // demoed — don't let it add slides to the video.
    driver._setCaptureEnabled(false);
    if (teardown) report.teardown = await teardown(driver, bound);
  } catch (e) {
    report.result = 'FAIL';
    report.phase = e.phase || 'unknown';
    report.error = String(e.message || e);
    console.error(`\n[${report.phase}] FAILED: ${report.error}`);
  } finally {
    report.finishedAt = new Date().toISOString();
    const outPath = path.join(process.cwd(), 'out', '_recipes', `${name}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n${report.result === 'PASS' ? '✅ PASS' : '❌ FAIL'} — report: ${outPath}`);
    const captureDir = driver.getCaptureDir();
    if (captureDir) {
      // Handoff file for renderer/from-recipe.mjs: the exact same report content plus the slides
      // this run captured, written under a fixed name (not the timestamped out/_recipes/ one) so
      // the renderer never has to guess which of many report files in out/_recipes/ is "this run"'s.
      const finalUrl = await driver.currentUrl().catch(() => null);
      fs.writeFileSync(path.join(captureDir, 'recipe-report.json'), JSON.stringify({ ...report, finalUrl, slides: driver.getSlides() }, null, 2));
    }
    driver.close();
    process.exit(report.result === 'PASS' ? 0 : 1);
  }
}

export { log };
