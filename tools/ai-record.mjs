// AI-driven workflow recording: given a coverage candidate (title/description/start_route/trigger),
// an agent loop drives a real, isolated browser session — reading the live page, deciding one action
// at a time via `claude -p`, executing it with Playwright, and recording each action into a
// script.json step in the exact shape the extension's recorder produces (see extension/content.js
// `fingerprint()`), so the result renders through the normal renderer/replay.mjs pipeline unchanged.
//
// Always targets the fixed staging origin below — never the operator's current tab — since this
// runs unattended with no human present to catch a wrong click on a live tenant.
//
// Browser sessions: each parallel job runs in its OWN persistent profile (.browser-profile-ai-<slot>)
// with its own Hadrius sign-in, done once by hand in the visible window. We deliberately do not clone
// the renderer's .browser-profile: Hadrius uses Cognito with refresh-token rotation, so two profiles
// sharing one login invalidate each other the first time either refreshes.
//
// Usage from CLI (for testing): node tools/ai-record.mjs '{"title":"How to add an employee","start_route":"/people-oversight/people-directory","description":"..."}'
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, extractJson, decisionModel, planModel, codebaseReachable } from './coverage-scan.mjs';
import { STUDIO_TENANT_COMPANY_ID } from './stage-lib.mjs';
import { attachFile } from './upload-fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE_DIR = process.env.KBS_PROFILE_DIR || path.join(REPO_ROOT, '.browser-profile');
export const STAGING_BASE = (process.env.KBS_STAGING_BASE || 'https://staging.hadrius.com').replace(/\/$/, '');
const MAX_STEPS = 45; // a 6-step wizard with a couple of detours needs ~30; leave headroom so the model doesn't bail early
const VIEWPORT = { width: 1600, height: 900 };
const LOGIN_WAIT_MS = 10 * 60 * 1000; // how long to hold a window open for a manual Hadrius sign-in

/** Persistent profile for one parallel AI slot (1-based). Created on first use; keeps its own sign-in. */
export function slotProfileDir(slot) { return path.join(REPO_ROOT, `.browser-profile-ai-${slot}`); }
// Replaces the CLI's default coding-assistant system prompt for the per-turn decision call: the
// model has no tools here and must answer in JSON, not try to "look" at anything itself.
const DECISION_SYSTEM_PROMPT = 'You drive a real web browser by choosing exactly ONE action per turn from a list of visible elements the user message gives you. You have no tools and cannot inspect anything yourself — decide only from the message. Reply with exactly one JSON object as specified in the message and nothing else: no prose, no markdown fence.';

// ---- Hadrius sign-in handling ----
// The saved profile's Hadrius session can expire (or the SSO can bounce to another origin). Rather
// than failing, detect the sign-in page and let the operator sign in manually in a visible window.
const LOGIN_PATH_RE = /\/(login|log-in|signin|sign-in|auth|sso|oauth|callback|mfa|verify|password)(\/|$|\?)/i;
async function isSignedIn(page, stagingBase) {
  const url = page.url();
  if (!url.startsWith(stagingBase)) return false;
  if (LOGIN_PATH_RE.test(new URL(url).pathname)) return false;
  const hasPassword = await page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => true);
  return !hasPassword;
}
// The SPA paints the requested route FIRST and only then bounces to /auth/sign-in once its token
// check fails — so a "signed in" reading straight after load means nothing. Give that redirect
// time to happen before judging.
async function settleAuthRedirect(page) {
  await page.waitForURL((u) => LOGIN_PATH_RE.test(u.pathname), { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1000);
}
async function waitForSignIn(page, stagingBase, { signal, timeoutMs = LOGIN_WAIT_MS } = {}) {
  const start = Date.now();
  await settleAuthRedirect(page);
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('cancelled');
    // Require the signed-in state to hold for several consecutive checks: right after a sign-in the
    // app hops through /auth/… callbacks and re-renders before it is really settled.
    if (await isSignedIn(page, stagingBase)) { if (++stable >= 4) { await page.waitForTimeout(1500); return; } }
    else stable = 0;
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 60000)} min waiting for a Hadrius sign-in`);
}

/**
 * Pre-flight for a batch: make sure the SHARED profile (the one every job clones and the renderer
 * uses) is signed in to Hadrius. Probes headlessly; if the session is gone, opens a visible window on
 * the sign-in page and waits for the operator to sign in — the persistent profile saves the new
 * session on close, so every subsequent job and render.sh reuse it.
 */
export async function ensureHadriusLogin({ profileDir = DEFAULT_PROFILE_DIR, stagingBase = STAGING_BASE, onLog = () => {}, signal, timeoutMs = LOGIN_WAIT_MS } = {}) {
  if (!fs.existsSync(profileDir)) throw new Error(`No saved login found at ${profileDir}. Run: node tools/login.mjs`);
  const probeUrl = stagingBase + '/overview';
  let ctx = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: VIEWPORT });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settleAuthRedirect(page);
    if (await isSignedIn(page, stagingBase)) return { signedIn: true, prompted: false };
  } finally { await ctx.close().catch(() => {}); }

  onLog('Hadrius sign-in needed — a browser window is opening. Sign in there (2FA if asked); this waits up to 10 minutes and the login is saved for future runs.');
  ctx = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: VIEWPORT });
  const onAbort = () => { ctx.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForSignIn(page, stagingBase, { signal, timeoutMs });
    onLog('Signed in to Hadrius — saved to the shared browser profile.');
    return { signedIn: true, prompted: true };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await ctx.close().catch(() => {});
  }
}

// ---- in-page helpers (stringified and evaluated via Playwright) ----
// Kept in step with renderer/replay.mjs's RESOLVER `name()` so the strong role+name match lands.
const DOM_HELPERS_JS = `
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  function implicitRole(el) { const t = el.tagName.toLowerCase(); if (t === 'button') return 'button'; if (t === 'a' && el.href) return 'link'; if (t === 'tr' && el.closest('tbody')) return 'row';
    if (t === 'textarea') return 'textbox'; if (t === 'select') return 'combobox'; if (t === 'input') { const ty = (el.type || 'text').toLowerCase();
    if (['checkbox', 'radio'].includes(ty)) return ty; if (ty === 'submit' || ty === 'button') return 'button'; return 'textbox'; } return null; }
  function roleOf(el) { return el.getAttribute('role') || implicitRole(el); }
  function rowLabel(el) { let n = el; for (let d = 0; n && d < 4; d++) { n = n.parentElement; if (!n) break;
    const c = n.querySelectorAll('[role="radio"],[role="checkbox"],input,button'); const t = clean(n.innerText || n.textContent);
    if (t && t.length <= 160 && c.length <= 2) return t; } return ''; }
  function accessibleName(el) {
    const a = el.getAttribute('aria-label'); if (a) return clean(a);
    const role = roleOf(el);
    if (['radio', 'checkbox', 'switch'].includes(role) && !clean(el.textContent)) { const r = rowLabel(el); if (r) return r; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.textContent); }
    const w = el.closest('label'); if (w) return clean(w.textContent);
    if (el.placeholder) return clean(el.placeholder); if (el.title) return clean(el.title);
    const t = clean(el.innerText || el.textContent); return t.length <= 80 ? t : t.slice(0, 80);
  }
  function fieldLabel(el) { let node = el; for (let d = 0; node && d < 5; d++) { const prev = node.previousElementSibling;
    if (prev && /label|p|span|div/i.test(prev.tagName) && clean(prev.textContent).length < 60) return clean(prev.textContent); node = node.parentElement; } return null; }
  function cssPath(node) {
    if (node.id && !/^\\d|[:.]/.test(node.id)) return '#' + CSS.escape(node.id);
    const testid = node.getAttribute('data-testid'); if (testid) return '[data-testid="' + testid + '"]';
    const parts = []; let n = node;
    for (let d = 0; n && n.nodeType === 1 && d < 6; d++) { let sel = n.tagName.toLowerCase(); const parent = n.parentElement;
      if (parent) { const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName); if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(sel); n = parent; }
    return parts.join(' > ');
  }
  // Rendered and not hidden — but NOT limited to the viewport: wizard/form fields below the fold must
  // be in the model's list (Playwright scrolls to them on click). Elements the model can't see, it
  // can't use, and it concludes "nothing happened" when a section renders off-screen.
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 3 && r.height > 3 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; };
  // Calendar day cell → { today, day } so replay picks the date by meaning, not by its literal label (see content.js dateHint).
  // Trailing suffix allowed: react-day-picker and similar libs append ", Selected" to the selected
  // day's aria-label — without it the one cell that actually needs {today|day} resolution silently stopped matching.
  const DATE_LABEL_RE = /^(Today, )?(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (?:January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2})(?:st|nd|rd|th)?, \\d{4}(?:,? [Ss]elected)?$/;
  function dateHint(el) {
    if (!el.closest('table,[role="grid"]')) return null;
    const m = accessibleName(el).match(DATE_LABEL_RE);
    if (!(m || el.hasAttribute('data-day') || /day/i.test(el.className || ''))) return null;
    const day = m ? parseInt(m[2], 10) : parseInt(clean(el.textContent), 10);
    if (!day) return null;
    const today = !!(m && m[1]) || el.getAttribute('aria-current') === 'date' || el.hasAttribute('data-today') || /(^|\\s)(rdp-day_today|today)(\\s|$)/.test(el.className || '');
    return today ? { today: true, day } : { day };
  }
  function isDatePickerButton(el) {
    if (!el || (el.tagName.toLowerCase() !== 'button' && el.getAttribute('role') !== 'button')) return false;
    const text = clean(el.innerText || el.textContent);
    // NOTE: this whole block is a template string compiled with new Function(), so regex escapes
    // must be double-backslashed (\\s, \\d, \\b, \\/) — a single backslash is eaten by the template
    // and the regex fails to compile, which takes the entire module down at import.
    const isDateLike = /^(?:Pick|Select|Choose)\\s+a?\\s*date\\b|^(?:Today|\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/i.test(text);
    const hasCalIcon = !!el.querySelector('svg') && /calendar/i.test(el.innerHTML);
    const label = fieldLabel(el) || '';
    const isDateLabel = /\\b(date|due|deadline)\\b/i.test(label);
    return isDateLike || (isDateLabel && (hasCalIcon || el.getAttribute('aria-haspopup') === 'dialog'));
  }
`;

// Snapshot of visible interactive elements, each tagged with a temporary data-kb-ai-id so a later
// call can act on exactly the one the model picked. Also returns the page's url/title so the caller
// has pre-action values without extra round trips.
export const SNAPSHOT_FN = new Function(`
  ${DOM_HELPERS_JS}
  document.querySelectorAll('[data-kb-ai-id]').forEach((el) => el.removeAttribute('data-kb-ai-id'));
  // Clickable table rows count too: list pages open an item by clicking its row, and that row is
  // where a workflow's real trigger often lives. A row is "clickable" if it's styled as such.
  const clickableRow = (tr) => getComputedStyle(tr).cursor === 'pointer' || tr.hasAttribute('tabindex') || tr.hasAttribute('data-href') || typeof tr.onclick === 'function';
  const nodes = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],tbody tr'))
    .filter((el) => visible(el) && !el.closest('#__hadrius_hud__,#__hadrius_spotlight_overlay__') && (el.tagName !== 'TR' || el.getAttribute('role') || clickableRow(el)));
  const out = [];
  nodes.slice(0, 320).forEach((el, i) => {
    el.setAttribute('data-kb-ai-id', String(i));
    const dh = dateHint(el);
    let elName = accessibleName(el);
    if (!elName && dh) {
      elName = 'Calendar day ' + dh.day + (dh.today ? ' (Today)' : '');
    }
    out.push({
      id: i,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: (elName || '').slice(0, 90),
      datePicker: isDatePickerButton(el) || undefined,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      inDialog: !!el.closest('[role="dialog"],[role="alertdialog"]'),
    });
  });
  // Non-interactive page text: headings, labels, helper/validation notes, required markers. This is
  // how the page explains its own gates ("Select a representative to see firm information") — the
  // model can't infer that from buttons alone.
  // Scope to the main content (the app's sidebar isn't a <nav>), skip menu items, and skip text that
  // is already an element's name — it's in the element list, and the sidebar is nothing but that.
  const root = document.querySelector('main,[role="main"]') || document.body;
  const elementNames = new Set(out.map((e) => e.name.toLowerCase()));
  // Only elements that OWN text (a direct text node) — wrapper divs would otherwise repeat all their
  // children's text as one long line. Skip fixed-position widgets (chat bubbles, dev overlays)
  // unless they're a dialog.
  const ownsText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length >= 3);
  // A "widget" is a SMALL fixed box (chat bubble, dev overlay) — an app shell that is itself
  // position:fixed and full-size must not be excluded.
  const inFixedWidget = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { if (n.getAttribute && (n.getAttribute('role') === 'dialog' || n.getAttribute('role') === 'alertdialog')) return false; if (getComputedStyle(n).position === 'fixed') { const r = n.getBoundingClientRect(); return r.width < innerWidth * 0.6 && r.height < innerHeight * 0.6; } } return false; };
  const textNodes = Array.from(root.querySelectorAll('h1,h2,h3,h4,legend,label,[role="heading"],[role="alert"],[role="status"],p,li,small,span,div'))
    .filter((el) => ownsText(el) && visible(el) && !el.closest('nav,header,footer,aside,[role="navigation"],[role="menu"],[role="listbox"],[role="tablist"],button,a,select,textarea') && !(el.closest('li') && el.closest('li').querySelector('a')) && !inFixedWidget(el));
  const seen = new Set(); const text = [];
  for (const el of textNodes) {
    const t = clean(el.innerText || el.textContent); if (t.length < 3 || t.length > 180) continue;
    const key = t.toLowerCase().replace(/[^a-z0-9*]+/g, ' ').trim();
    if (seen.has(key) || elementNames.has(t.toLowerCase())) continue; seen.add(key);
    const tag = el.tagName.toLowerCase();
    text.push(/^h[1-4]$/.test(tag) || el.getAttribute('role') === 'heading' ? '# ' + t : tag === 'label' || tag === 'legend' ? 'label: ' + t : t);
    if (text.length >= 60) break;
  }
  return { url: location.href, title: document.title, elements: out, text };
`);

// Full fingerprint for one element (by the id assigned in SNAPSHOT_FN), matching the shape
// extension/content.js records so renderer/replay.mjs can resolve it the same way.
const FINGERPRINT_FN = new Function('id', `
  ${DOM_HELPERS_JS}
  const el = document.querySelector('[data-kb-ai-id="' + id + '"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: accessibleName(el),
    date: dateHint(el),
    text: clean(el.innerText || el.textContent).slice(0, 120),
    placeholder: el.placeholder || null,
    label: fieldLabel(el),
    testid: el.getAttribute('data-testid') || null,
    heading: null,
    cardText: null,
    css: cssPath(el),
    inDialog: !!el.closest('[role="dialog"],[role="alertdialog"]'),
    bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: innerWidth, h: innerHeight },
  };
`);

// ---- Visual Feedback & Human Takeover Helpers (Step 6) ----
async function ensureVisualHud(page, { title = 'Walkthrough', stepNum = 1, totalSteps = 10, actionDesc = '' } = {}) {
  await page.evaluate(({ title, stepNum, totalSteps, actionDesc }) => {
    if (!window.__hadrius_hud_injected__) {
      window.__hadrius_hud_injected__ = true;
      window.__hadrius_takeover_paused__ = false;
      window.__hadrius_skip_step__ = false;

      // 1. Animated Spotlight Overlay & Simulated Cursor
      const overlay = document.createElement('div');
      overlay.id = '__hadrius_spotlight_overlay__';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;inset:0;overflow:hidden;';

      const box = document.createElement('div');
      box.id = '__hadrius_spotlight_box__';
      box.style.cssText = 'position:fixed;border-radius:8px;border:3px solid #8b5cf6;box-shadow:0 0 0 9999px rgba(15,23,42,0.38), 0 0 24px rgba(139,92,246,0.95);opacity:0;transition:all 0.35s cubic-bezier(0.16,1,0.3,1);pointer-events:none;';

      const label = document.createElement('span');
      label.id = '__hadrius_spotlight_label__';
      label.style.cssText = 'position:absolute;bottom:calc(100% + 6px);left:0;background:#4c3dab;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:5px;white-space:nowrap;font-family:-apple-system,system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.35);pointer-events:none;';
      box.appendChild(label);
      overlay.appendChild(box);

      const cursor = document.createElement('div');
      cursor.id = '__hadrius_sim_cursor__';
      cursor.style.cssText = 'position:fixed;width:24px;height:24px;pointer-events:none;transition:all 0.35s cubic-bezier(0.16,1,0.3,1);opacity:0;z-index:2147483647;';
      cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#8b5cf6" stroke="white" stroke-width="2"><polygon points="3 3 10 21 14 13 21 10 3 3"/></svg>';
      overlay.appendChild(cursor);

      document.body.appendChild(overlay);

      // 2. Floating HUD Widget
      const hud = document.createElement('div');
      hud.id = '__hadrius_hud__';
      hud.style.cssText = 'position:fixed;top:16px;right:20px;z-index:2147483647;width:330px;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:12px;box-shadow:0 16px 36px rgba(0,0,0,0.55);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:12px 14px;';
      hud.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:7px;">
            <span id="__hadrius_hud_dot__" style="width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 8px #ef4444;display:inline-block;"></span>
            <strong id="__hadrius_hud_status__" style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#cbd5e1;">AI Driving Live</strong>
          </div>
          <span id="__hadrius_hud_step__" style="font-size:11px;font-weight:700;color:#93c5fd;background:#1e293b;padding:2px 8px;border-radius:999px;">Step ${stepNum}</span>
        </div>
        <div id="__hadrius_hud_title__" style="font-size:11.5px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;">${title}</div>
        <div id="__hadrius_hud_action__" style="font-size:13px;font-weight:600;color:#f8fafc;line-height:1.35;margin-bottom:10px;">${actionDesc || 'Analyzing page…'}</div>
        <div style="display:flex;gap:6px;">
          <button id="__hadrius_hud_takeover_btn__" type="button" style="flex:1;background:#334155;color:#fff;border:none;border-radius:6px;padding:7px 8px;font-size:11.5px;font-weight:700;cursor:pointer;">⏸ Take Over</button>
          <button id="__hadrius_hud_skip_btn__" type="button" style="background:transparent;color:#94a3b8;border:1px solid #475569;border-radius:6px;padding:7px 8px;font-size:11px;font-weight:600;cursor:pointer;">⏭ Skip Step</button>
          <button id="__hadrius_hud_cancel_btn__" type="button" style="background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d;border-radius:6px;padding:7px 8px;font-size:11px;font-weight:700;cursor:pointer;">✕ Cancel</button>
        </div>
      `;
      document.body.appendChild(hud);

      const takeoverBtn = document.getElementById('__hadrius_hud_takeover_btn__');
      const dot = document.getElementById('__hadrius_hud_dot__');
      const statusText = document.getElementById('__hadrius_hud_status__');

      takeoverBtn.onclick = () => {
        window.__hadrius_takeover_paused__ = !window.__hadrius_takeover_paused__;
        if (window.__hadrius_takeover_paused__) {
          takeoverBtn.textContent = '▶ Resume AI';
          takeoverBtn.style.background = '#059669';
          dot.style.background = '#f59e0b';
          dot.style.boxShadow = '0 0 8px #f59e0b';
          statusText.textContent = 'Paused (You Have Control)';
          const b = document.getElementById('__hadrius_spotlight_box__'); if (b) b.style.opacity = '0';
          const c = document.getElementById('__hadrius_sim_cursor__'); if (c) c.style.opacity = '0';
        } else {
          takeoverBtn.textContent = '⏸ Take Over';
          takeoverBtn.style.background = '#334155';
          dot.style.background = '#ef4444';
          dot.style.boxShadow = '0 0 8px #ef4444';
          statusText.textContent = 'AI Driving Live';
        }
      };

      const skipBtn = document.getElementById('__hadrius_hud_skip_btn__');
      if (skipBtn) {
        skipBtn.onclick = (e) => {
          e.stopPropagation();
          window.__hadrius_skip_step__ = true;
          skipBtn.textContent = '⏭ Skipping…';
          skipBtn.style.color = '#38bdf8';
          setTimeout(() => {
            skipBtn.textContent = '⏭ Skip Step';
            skipBtn.style.color = '#94a3b8';
          }, 1500);
        };
      }

      const cancelBtn = document.getElementById('__hadrius_hud_cancel_btn__');
      if (cancelBtn) {
        cancelBtn.onclick = (e) => {
          e.stopPropagation();
          window.__hadrius_cancel_record__ = true;
          cancelBtn.textContent = 'Stopping…';
          cancelBtn.style.background = '#7f1d1d';
        };
      }

      // Drag HUD to move anywhere on screen
      let isDragging = false;
      let startX = 0, startY = 0, origX = 0, origY = 0;
      hud.style.cursor = 'grab';

      hud.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        hud.style.cursor = 'grabbing';
        startX = e.clientX;
        startY = e.clientY;
        const rect = hud.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        hud.style.right = 'auto';
        hud.style.left = `${origX}px`;
        hud.style.top = `${origY}px`;
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxLeft = Math.max(10, window.innerWidth - hud.offsetWidth - 10);
        const maxTop = Math.max(10, window.innerHeight - hud.offsetHeight - 10);
        hud.style.left = `${Math.max(10, Math.min(maxLeft, origX + dx))}px`;
        hud.style.top = `${Math.max(10, Math.min(maxTop, origY + dy))}px`;
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          hud.style.cursor = 'grab';
        }
      });
    }

    const stepEl = document.getElementById('__hadrius_hud_step__');
    if (stepEl) stepEl.textContent = `Step ${stepNum}${totalSteps ? ' of ' + totalSteps : ''}`;
    const actionEl = document.getElementById('__hadrius_hud_action__');
    if (actionEl && actionDesc) actionEl.textContent = actionDesc;
  }, { title, stepNum, totalSteps, actionDesc }).catch(() => {});
}

async function highlightTargetElement(page, elementId, label, actionType) {
  await page.evaluate(({ elementId, label, actionType }) => {
    const el = document.querySelector(`[data-kb-ai-id="${elementId}"]`);
    const box = document.getElementById('__hadrius_spotlight_box__');
    const badge = document.getElementById('__hadrius_spotlight_label__');
    const cursor = document.getElementById('__hadrius_sim_cursor__');
    const actionEl = document.getElementById('__hadrius_hud_action__');

    if (actionEl) actionEl.textContent = `${actionType === 'type' ? 'Enter' : 'Select'} "${label}"`;

    if (!el || !box || !cursor) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 50 || rect.bottom > window.innerHeight - 50 || rect.left < 20 || rect.right > window.innerWidth - 20) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    setTimeout(() => {
      const r = el.getBoundingClientRect();
      box.style.top = `${Math.max(0, r.top - 4)}px`;
      box.style.left = `${Math.max(0, r.left - 4)}px`;
      box.style.width = `${r.width + 8}px`;
      box.style.height = `${r.height + 8}px`;
      box.style.opacity = '1';

      if (badge) badge.textContent = `${actionType === 'type' ? 'Enter' : 'Select'} "${label}"`;

      cursor.style.top = `${r.top + r.height / 2}px`;
      cursor.style.left = `${r.left + r.width / 2}px`;
      cursor.style.opacity = '1';
    }, 60);
  }, { elementId, label, actionType }).catch(() => {});

  await page.waitForTimeout(450);
}

async function clearSpotlight(page) {
  await page.evaluate(() => {
    const box = document.getElementById('__hadrius_spotlight_box__');
    if (box) box.style.opacity = '0';
    const cursor = document.getElementById('__hadrius_sim_cursor__');
    if (cursor) cursor.style.opacity = '0';
  }).catch(() => {});
}

async function handleTakeOverPause(page, onLog) {
  let logged = false;
  while (true) {
    const status = await page.evaluate(() => ({
      paused: !!window.__hadrius_takeover_paused__,
      skip: !!window.__hadrius_skip_step__,
      cancel: !!window.__hadrius_cancel_record__
    })).catch(() => ({ paused: false, skip: false, cancel: false }));

    if (status.cancel) {
      onLog('✕ Recording cancelled by user via on-screen HUD.');
      throw new Error('cancelled by user');
    }

    if (status.skip) {
      await page.evaluate(() => { window.__hadrius_skip_step__ = false; }).catch(() => {});
      onLog('⏭ Skip step clicked — proceeding immediately.');
      return 'skip';
    }

    if (!status.paused) {
      if (logged) onLog('▶ Human takeover concluded — AI automation resumed.');
      break;
    }
    if (!logged) {
      onLog('⏸ Automation paused by user — you now have full control in the browser window.');
      logged = true;
    }
    await page.waitForTimeout(300);
  }
  return 'ok';
}

function buildTurnPrompt(item, snap, history, turnsLeft, guidance = null) {
  const elLines = snap.elements
    .map((e) => `${e.id}: <${e.tag}${e.role ? ' role=' + e.role : ''}${e.disabled ? ' disabled' : ''}${e.inDialog ? ' in-dialog' : ''}> "${e.name}"`)
    .join('\n');
  const histLines = history.length
    ? history.slice(-10).map((h, i) => `${i + 1}. ${h.action}${h.name ? ` "${h.name}"` : ''}${h.text ? ` = "${h.text}"` : ''}${h.error ? ` — FAILED: ${h.error}` : ` — ok${h.outcome ? ` → ${h.outcome}` : ''}`}`).join('\n')
    : '(none yet)';

  return `You are operating a real web browser to perform ONE user workflow in the Hadrius compliance app, on its staging environment. Every action you choose is executed for real and recorded as a demo walkthrough — perform the workflow the way a real user would, including any final Save/Submit/Send step that completes it.

WORKFLOW TO PERFORM
Title: ${item.title}
Description: ${item.description || '(none given)'}
Starting trigger (if known): ${item.trigger || '(not specified — find the natural entry point)'}
${guidance ? `
UI PATH FROM THE APP'S SOURCE CODE (exact labels are reliable; verify each against the page before clicking):
${renderPlan(guidance)}
` : ''}
ACTIONS SO FAR (most recent last)
${histLines}

CURRENT PAGE: ${snap.title} — ${snap.url}
PAGE TEXT (headings, labels, hints — read this to understand what the page expects; "*" marks a required field):
${(snap.text || []).join('\n') || '(none)'}

VISIBLE INTERACTIVE ELEMENTS (id: <tag role> "name"):
${elLines || '(none found — page may still be loading)'}

Turns remaining before you must finish: ${turnsLeft}

Reply with ONLY one JSON object (no prose, no markdown fence) describing the SINGLE next action:
- {"action":"click","elementId":<id>,"reason":"why"}
- {"action":"type","elementId":<id>,"text":"...","reason":"why"} — clicks the field, clears it, and types text
- {"action":"press","key":"Enter"|"Escape"|"Tab","reason":"why"}
- {"action":"upload","elementId":<id>,"file":"pdf"|"docx"|"csv","reason":"why"} — attaches a sample file. Target the VISIBLE control a person would click ("Choose document", "Upload", a drop zone) — never a hidden file input, which won't be in the list. Pick the format the page asks for.
- {"action":"hover","elementId":<id>,"reason":"why"} — reveals a tooltip WITHOUT clicking. Use this on a DISABLED control: the tooltip usually states the exact reason (missing permission, wrong status), which tells you whether to fix something or to fail.
- {"action":"wait","ms":<number 200-3000>,"reason":"why"} — page is still settling/loading
- {"action":"consult","question":"a specific question for the app's source code","reason":"why"} — the page doesn't match the plan, a label you expected isn't here, or a gate is unclear. Ask BEFORE giving up (max 2 per run; the answer appears in the plan block next turn).
- {"action":"done","reason":"why the workflow is now complete"}
- {"action":"fail","reason":"why you cannot proceed (e.g. no matching element, workflow does not match this page)"}

Rules:
- elementId must be a NUMBER copied from the list above (never invent one).
- Read the "→" outcome of your previous action before choosing. If a dropdown/menu/dialog opened (new option/menuitem elements appeared), your next action is to pick from it — NEVER click the same trigger twice in a row, that closes it again.
- Never repeat an action that just failed the same way.
- Finish an open dialog before anything else: fill its fields, then click ITS primary button ("Save", "Create", "Submit"…). Never navigate away, open a menu, or click outside while a dialog holds text you typed — that discards it and you will only have to redo the whole sequence.
- On list pages the real trigger is often INSIDE an item: if the button you expect isn't on the page, open the relevant row (role=row) or item first and look again. The "starting trigger" hint is a hint, not a guarantee of where it lives.
- Wizards and forms often GATE later sections behind a required choice at the top (a "Select …" / "Search for …" field, a field marked *, a disabled "Next"). Satisfy that first: type into the search field, wait for the options to appear, click one — only then move on. Clicking section/step tabs does nothing until the gate is satisfied. Use realistic sample data (e.g. pick the first real option offered) — this is a staging demo.
- Perform the workflow exactly ONCE. As soon as the final action has succeeded (a success message, a redirect, the new record visible in a list, or the form is gone), reply "done" — do not create a second record or start over.
- "done" means the workflow's FINAL action (e.g. "Save test", "Submit", "Send") has succeeded and you saw the completion signal described in the source-code path. Stopping partway — because of blocked clicks, few turns left, or uncertainty — is NOT done: reply "fail" with the reason instead, so nothing half-finished gets saved as a walkthrough.
- If you have looped 3+ times without progress, use "fail" rather than continuing.
- A control that stays DISABLED is telling you something. Hover it and read the tooltip before you decide it's a dead end — and if the tooltip names a prerequisite you cannot satisfy (a permission, a membership, a record status), "fail" with that exact reason rather than clicking it repeatedly.
- Some errors surface only as a browser alert, which is captured for you and shown as "→ alert: …". Treat that text as the page's response to what you just did; repeating the same action will only produce the same alert.`;
}

/**
 * Ask Claude — with the read-only hadrius-codebase MCP tools — to derive the exact UI path for a
 * workflow from the frontend source: where the trigger really lives, how to reach it from the start
 * route, exact labels, prerequisites/gates, and what "done" looks like. Plain text, ≤ ~12 lines.
 * `failure`: a previous attempt's give-up reason, so the second plan addresses it.
 */
export async function planFromCodebase(item, { signal, failure = null, previous = null } = {}) {
  // The CLI does not fail when its MCP server is down — it runs anyway with the server marked
  // failed, and the model then answers without ever reading the source. Refuse up front rather than
  // spend 3 x 300s producing something ungrounded.
  if (!(await codebaseReachable())) throw new Error('hadrius-codebase MCP unreachable — a plan generated now would not be grounded in source');
  const buildPrompt = (regexWarning) => `You are writing a precise, step-by-step plan for ONE user workflow in the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/). The plan is used two ways: (a) a browser-automation agent follows it, (b) it is shown as a checklist to a person recording the workflow by hand. Use ONLY the hadrius-codebase MCP tools (search_code, read_file, list_directory, file_tree) to read the real UI code and verify every label.
${regexWarning || ''}

WORKFLOW
Title: ${item.title}
Description: ${item.description || '(none)'}
Start route: ${item.start_route}
Trigger hint from an earlier scan: ${item.trigger || '(none)'}
Likely source file: ${item.source_file || '(unknown — search for the route and labels)'}
${failure ? `\nA PREVIOUS ATTEMPT FAILED with this reason — your plan must resolve it:\n${failure}\n${previous ? `\nThe plan it was following was:\n${typeof previous === 'string' ? previous : JSON.stringify(previous)}\n` : ''}` : ''}
Work out from the code:
1. Where the trigger actually lives and how to get there from the start route (e.g. the start route is an entity list — click an entity row, then the Tests tab).
2. The exact visible labels (button text, tab names, field labels, placeholders, menu items) in the order a user clicks/fills them.
3. Prerequisites and gates: required selections, disabled-until conditions, roles/feature flags, data that must exist.
4. What completion looks like (success toast text, redirect route, the new item's appearance).

Reply with ONLY a JSON object (no prose, no markdown fence):
{"exists":true,"summary":"one sentence of what the user accomplishes","prerequisites":["short line each: role, data or setting required"],"steps":[{"instruction":"clear, simple imperative sentence for a person, e.g. Click the row of the entity you want to add a test to","label":"the exact visible UI label the person clicks or fills, or empty if none","action":"click|type|select|navigate|check|other","route":"/path only if this step moves to a new route, else empty"}],"completion":"what success looks like, exact toast text if any","notes":"caveats: admin-only, feature flags, test data needed"}
Rules: 6–20 steps, one UI action each, in order; every "label" must be a real string from the code; describe sample values generically ("a descriptive test name"), never invent specific people or dates. If the code shows the workflow does not exist as described, set "exists": false and explain in "summary".
If a codebase search tool call errors (e.g. "Invalid regular expression"), that is a normal, recoverable mistake — do NOT give up or output the error as your answer. Search again with a DIFFERENT, simpler query, or search a different way. Always finish by outputting the JSON object above; if some detail couldn't be verified, say so briefly in "notes" rather than stopping.`;
  // A retry with the IDENTICAL prompt tends to reproduce the identical mistake (low-temperature model,
  // same context) — so on retry the prompt must actually change: forbid the exact construct it keeps
  // breaking (regex escape sequences in search queries) rather than just asking nicely again.
  const REGEX_WARNING = 'IMPORTANT — a previous attempt on this exact workflow failed because a codebase search used regex escape sequences (\\s, \\d, \\b, character classes, non-capturing groups) with the backslashes dropped, producing an invalid regex. To avoid that entirely: when searching the codebase, use ONLY plain literal words or short phrases as the search pattern — no backslashes, no regex metacharacters, no escape sequences of any kind. Plain substrings (e.g. "Select a", "due date", "button") are sufficient.';
  let out, lastErr, meta = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { out = await runClaude(buildPrompt(attempt > 1 ? REGEX_WARNING : null), { maxTurns: 25, timeout: 300000, model: planModel(), signal, onMeta: (m) => { meta = m; } }); lastErr = null; break; }
    catch (e) { if (signal?.aborted) throw e; lastErr = e; }
  }
  if (lastErr) throw lastErr;
  const text = String(out || '').trim();
  // A reply that isn't JSON is a FAILED generation, not a plan with no steps. Returning a stub here
  // used to hand the caller something it cached and logged as "plan ready" — and because queuePlans
  // skips any key already in the cache, that empty plan was then skipped forever. A connection blip
  // mid-generation is the usual cause, so this must throw and let the key be retried.
  let plan;
  try { plan = extractJson(text); } catch { throw new Error(`model did not return JSON (${text.slice(0, 120) || 'empty reply'})`); }
  if (!Array.isArray(plan.steps)) plan.steps = [];
  plan.steps = plan.steps.filter((s) => s && s.instruction).map((s) => ({ instruction: String(s.instruction).trim(), label: String(s.label || '').trim(), action: String(s.action || 'other').trim(), route: String(s.route || '').trim() }));
  if (!Array.isArray(plan.prerequisites)) plan.prerequisites = [];
  // exists:false is a legitimate answer — the workflow genuinely isn't in the product — but ONLY if
  // the model could actually look. If the MCP dropped mid-run it reports exists:false because it
  // could not verify, which would cache an outage as a finding about the product. So re-probe before
  // believing any empty plan.
  if (!plan.steps.length) {
    if (plan.exists !== false) throw new Error('model returned a plan with no steps');
    if (!(await codebaseReachable({ maxAgeMs: 0 }))) throw new Error('model reported the workflow does not exist, but the codebase MCP is unreachable — not trusting that');
  }
  plan.model = meta?.model || null;   // who actually wrote it
  plan.turns = meta?.turns ?? null;   // >1 means it really did read the codebase; see runClaude's onMeta
  return plan;
}

/**
 * "▶ AI" on one Workflow-guide step (Record-this path, the operator's own browser): given the step,
 * the plan, and a snapshot of the live page (from extension/content.js KB_SNAPSHOT), decide the single
 * action that performs THIS step. Fast, no tools — same decision model as the unattended recorder.
 * Returns { action: 'click'|'type'|'press'|'none', elementId, text, key, reason }.
 */
export async function decideSingleStep({ step, plan, snapshot, doneSteps = [] }, { signal } = {}) {
  const elLines = (snapshot.elements || [])
    .map((e) => `${e.id}: <${e.tag}${e.role ? ' role=' + e.role : ''}${e.disabled ? ' disabled' : ''}${e.inDialog ? ' in-dialog' : ''}> "${e.name}"`)
    .join('\n');
  const prompt = `A person is recording a product walkthrough in the Hadrius compliance app (staging) and asked you to perform ONE step of the plan for them, on the page as it is right now. Do exactly this step — nothing before it, nothing after it.

THE STEP TO PERFORM NOW
${step.instruction}${step.label ? `\nExpected control label: "${step.label}"` : ''}${step.action ? `\nExpected kind of action: ${step.action}` : ''}

WORKFLOW CONTEXT
${plan?.summary || ''}
${doneSteps.length ? `Steps already done: ${doneSteps.join(' → ')}` : 'No earlier steps done yet.'}

CURRENT PAGE: ${snapshot.title} — ${snapshot.url}
PAGE TEXT (headings, labels, hints; "*" marks a required field):
${(snapshot.text || []).join('\n') || '(none)'}

VISIBLE INTERACTIVE ELEMENTS (id: <tag role> "name"):
${elLines || '(none)'}

Reply with ONLY one JSON object (no prose, no markdown fence):
- {"action":"click","elementId":<id>,"reason":"why"}
- {"action":"type","elementId":<id>,"text":"...","reason":"why"} — clicks the field, replaces its content, types text
- {"action":"press","key":"Enter"|"Escape"|"Tab","reason":"why"}
- {"action":"none","reason":"why this step cannot be done on the page right now (e.g. a previous step hasn't happened, the menu isn't open, the control isn't here)"}
Rules: elementId must be a NUMBER from the list. Prefer the element whose name matches the expected label; if the label isn't present but the step is still clearly doable (a renamed button, the same control inside an open dialog), choose the best match and say so in "reason". For "type", use realistic but generic sample text (e.g. a descriptive title, "Quarterly review of …") — never real people or dates — except in a search box meant to find an existing record, where a short, likely prefix is best.`;
  const raw = await runClaude(prompt, { maxTurns: 2, timeout: 60000, noTools: true, systemPrompt: DECISION_SYSTEM_PROMPT, model: decisionModel(), signal });
  const d = extractJson(raw);
  return {
    action: ['click', 'type', 'press', 'none'].includes(d.action) ? d.action : 'none',
    elementId: d.elementId == null ? null : Number(d.elementId),
    text: d.text == null ? undefined : String(d.text),
    key: d.key || undefined,
    reason: String(d.reason || '').slice(0, 300),
  };
}

/** Render a structured plan as the text block the agent sees every turn. */
export function renderPlan(plan) {
  if (!plan) return '';
  if (typeof plan === 'string') return plan;
  const lines = [];
  if (plan.exists === false) lines.push(`WARNING — the source suggests this workflow does not exist as described: ${plan.summary}`);
  else if (plan.summary) lines.push(plan.summary);
  if (plan.prerequisites?.length) lines.push('Prerequisites: ' + plan.prerequisites.join('; '));
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((s, i) => {
      if (typeof s === 'string') {
        lines.push(`${i + 1}. ${s}`);
      } else if (s && typeof s === 'object') {
        lines.push(`${i + 1}. ${s.instruction || s.action || s.title || ''}${s.label ? ` — "${s.label}"` : ''}${s.route ? ` → ${s.route}` : ''}`);
      }
    });
  }
  if (plan.completion) lines.push('Done when: ' + plan.completion);
  if (plan.notes) lines.push('Notes: ' + plan.notes);
  if (plan.consults?.length) lines.push('Answers from the source code during this run:\n' + plan.consults.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join('\n'));
  return lines.join('\n');
}

/**
 * Mid-run question to the source code: the agent hits something the plan didn't predict (a label
 * that isn't there, a gate it doesn't understand) and asks before giving up.
 */
export async function consultCodebase(item, plan, question, { signal } = {}) {
  const prompt = `A browser-automation agent is performing this workflow in the Hadrius web app (repo "hadrius_frontend", apps/hadrius-app/src/) and is stuck. Use ONLY the hadrius-codebase MCP tools (search_code, read_file, list_directory) to answer from the real UI code.

Workflow: ${item.title} — ${item.description || ''}
Start route: ${item.start_route}
Plan it is following:
${renderPlan(plan) || '(none)'}

THE AGENT'S QUESTION:
${question}

Answer in at most 6 short plain-text lines with exact UI labels in double quotes: what to click/fill next, or why the step cannot be done here (missing data, permissions, feature flag).`;
  try {
    const out = await runClaude(prompt, { maxTurns: 5, timeout: 25000, model: planModel(), signal });
    return String(out || '').trim().slice(0, 1200);
  } catch (err) {
    return `Source lookup unavailable (${err.message}). Proceed using visible elements on the page.`;
  }
}

// One line describing what the last action changed, so the model's history is grounded in the
// page's reaction rather than a bare "ok" (which is how it ends up toggling a menu shut).
function describeOutcome(before, after) {
  const parts = [];
  if (before.url !== after.url) parts.push(`URL changed to ${pathOf(after.url)}`);
  const key = (e) => `${e.role}|${e.name}`;
  const beforeSet = new Set(before.elements.map(key));
  const afterSet = new Set(after.elements.map(key));
  const added = after.elements.filter((e) => !beforeSet.has(key(e)));
  const removed = before.elements.filter((e) => !afterSet.has(key(e)));
  const menuish = added.filter((e) => /^(option|menuitem|menuitemcheckbox|menuitemradio|treeitem)$/.test(e.role || ''));
  const dialog = added.some((e) => e.inDialog) && !before.elements.some((e) => e.inDialog);
  if (dialog) parts.push('a dialog opened');
  if (menuish.length) parts.push(`a menu opened with ${menuish.length} option(s): ${menuish.slice(0, 5).map((e) => `"${e.name}"`).join(', ')}${menuish.length > 5 ? '…' : ''}`);
  else if (added.length) parts.push(`${added.length} new element(s) appeared, e.g. ${added.slice(0, 3).map((e) => `${e.role || e.tag} "${e.name}"`).join(', ')}`);
  if (!menuish.length && removed.length >= 3 && added.length === 0) parts.push(`${removed.length} element(s) disappeared (a menu/dialog closed?)`);
  if (!parts.length) parts.push('no visible change');
  return parts.join('; ');
}

/**
 * Drive one workflow and return `{ script }` in the same shape the side panel's toScript() saves.
 * `profileDir` is this job's own persistent browser profile (see slotProfileDir); it is created on
 * first use, in which case the operator is asked to sign in once in the visible window.
 * Throws Error('cancelled') if `signal` aborts at any point — including mid-action or mid-model-call.
 */
export async function runAiRecord(item, { onLog = () => {}, signal, profileDir = slotProfileDir(1), stagingBase = STAGING_BASE, plan = null, onPlan = null } = {}) {
  // Pin the tenant explicitly. Without ?company_id the agent lands on whatever company its own
  // staging session happens to default to — which is how a run ended up driving company 1
  // (Hadrius) and failing on a case it had no membership on. Staging is a nightly clone of real
  // production data for EVERY tenant, so an unpinned run can also record a stranger's real data.
  const startUrl = stagingBase.replace(/\/$/, '') + item.start_route
    + (item.start_route.includes('?') ? '&' : '?') + `company_id=${STUDIO_TENANT_COMPANY_ID}`;
  const throwIfCancelled = () => { if (signal?.aborted) throw new Error('cancelled'); };
  const firstUse = !fs.existsSync(profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  let ctx;
  const onAbort = () => { ctx?.close().catch(() => {}); };
  try {
    throwIfCancelled();
    onLog(`Launching browser (${path.basename(profileDir)})…`);
    ctx = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: VIEWPORT });
    // Closing the context makes every in-flight Playwright call reject immediately, so a cancel
    // lands mid-action instead of waiting for the next loop turn.
    signal?.addEventListener('abort', onAbort, { once: true });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.setViewportSize(VIEWPORT);

    // Native dialogs are auto-dismissed by the driver and leave no trace in the DOM, the
    // accessibility tree, or a screenshot — so a page that reports failure through window.alert()
    // looks to the agent exactly like a page that did nothing at all. (That is verbatim what
    // happened on "add an instant messaging provider": every submit was rejected, every rejection
    // went to an alert, and the agent looped ~10 turns seeing an unchanged page.) Capture the text
    // here and hand it to the model as the outcome of whatever it just did.
    const pendingDialogs = [];
    page.on('dialog', async (d) => {
      pendingDialogs.push(`${d.type()}: ${d.message().replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      await d.accept().catch(() => d.dismiss().catch(() => {}));
    });

    onLog(`Navigating to ${startUrl}`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settleAuthRedirect(page);
    if (!(await isSignedIn(page, stagingBase))) {
      // First use of this slot, or its session expired: the operator signs in right here in this
      // job's window. The profile is persistent, so it stays signed in for every later run.
      onLog(firstUse
        ? `First use of this AI browser — sign in to Hadrius in the window that just opened (2FA if asked). One time only; it stays signed in. Waiting up to 10 minutes…`
        : "Hadrius asked for a sign-in — sign in in this job's browser window (2FA if asked). Waiting up to 10 minutes…");
      await waitForSignIn(page, stagingBase, { signal });
      if (!page.url().startsWith(startUrl)) { await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1500); }
      onLog('Signed in — continuing.');
    }

    let steps = [], history = [], finished = false, failReason = null, lastUrl = page.url();
    let guidance = plan; // source-derived plan (pre-generated by the bridge, or built below), shown to the model every turn
    let consults = 0;

    const recordingId = crypto.randomUUID();
    const recordingDir = path.join(REPO_ROOT, 'out', '_recordings', recordingId);
    fs.mkdirSync(recordingDir, { recursive: true });

    const captureSlide = async (step) => {
      try {
        const captureId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const filename = `step_${captureId}.png`;
        const filePath = path.join(recordingDir, filename);

        // Hide HUD and cursor briefly while taking the clean screenshot of the page
        await page.evaluate(() => {
          const hud = document.getElementById('__hadrius_hud__');
          const overlay = document.getElementById('__hadrius_spotlight_overlay__');
          if (hud) hud.style.display = 'none';
          if (overlay) overlay.style.display = 'none';
        }).catch(() => {});

        await page.screenshot({ path: filePath, timeout: 5000 });

        // Restore HUD and cursor
        await page.evaluate(() => {
          const hud = document.getElementById('__hadrius_hud__');
          const overlay = document.getElementById('__hadrius_spotlight_overlay__');
          if (hud) hud.style.display = '';
          if (overlay) overlay.style.display = '';
        }).catch(() => {});

        step.captureId = captureId;
        step.media = { pre: filename };
      } catch (e) {
        onLog(`  (slide capture warning: ${e.message})`);
      }
    };

    const pushStep = async (snap, fields) => {
      const step = {
        index: steps.length,
        ...fields,
        url: snap.url,
        route: pathOf(snap.url),
        title: snap.title,
        ts: Date.now(),
        capture: true,
      };
      await captureSlide(step);
      steps.push(step);
      return step;
    };

    const noteNavigation = async () => {
      const now = page.url();
      if (now !== lastUrl) {
        lastUrl = now;
        const navStep = { index: steps.length, action: 'navigate', value: now, url: now, route: pathOf(now), title: '', ts: Date.now(), capture: true };
        await captureSlide(navStep);
        steps.push(navStep);
      }
    };

    // One attempt = a fresh run of the decision loop from the start page. Wrapped so a run the model
    // gives up on can be retried once with better guidance from the source code.
    const runAttempt = async () => {
    steps = []; history = []; finished = false; failReason = null; lastUrl = page.url(); consults = 0;
    let prevSnap = null;

    // Capture Step 0 initial navigate slide
    const initialStep = {
      index: 0,
      action: 'navigate',
      value: page.url(),
      url: page.url(),
      route: pathOf(page.url()),
      title: await page.title().catch(() => item.title),
      ts: Date.now(),
      capture: true
    };
    await captureSlide(initialStep);
    steps.push(initialStep);
    for (let turn = 0; turn < MAX_STEPS; turn++) {
      throwIfCancelled();
      const pauseStatus = await handleTakeOverPause(page, onLog);
      if (pauseStatus === 'skip') {
        onLog(`⏭ Turn ${turn + 1} skipped by user via HUD control.`);
        await clearSpotlight(page);
        continue;
      }
      const totalPlanSteps = (guidance?.steps?.length) || 10;
      const currentPlanStep = Math.min(turn + 1, totalPlanSteps);
      await ensureVisualHud(page, { title: item.title, stepNum: currentPlanStep, totalSteps: totalPlanSteps });
      const snap = await page.evaluate(SNAPSHOT_FN);
      // Ground the previous action's history entry in what actually changed on the page.
      const last = history[history.length - 1];
      if (prevSnap && last && !last.error && last.action !== 'wait' && !last.outcome) last.outcome = describeOutcome(prevSnap, snap);
      // An alert the page raised in response to the last action outranks any DOM diff — it is the
      // app answering in words, and without this the agent only sees "no visible change".
      if (pendingDialogs.length) {
        const said = pendingDialogs.splice(0).join(' | ');
        if (last && !last.error) last.outcome = `alert: ${said}${last.outcome ? ` (page otherwise: ${last.outcome})` : ''}`;
        onLog(`  ! page said: ${said.slice(0, 160)}`);
      }
      prevSnap = snap;
      let decision = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await runClaude(buildTurnPrompt(item, snap, history, MAX_STEPS - turn, guidance), { maxTurns: 2, timeout: 60000, noTools: true, systemPrompt: DECISION_SYSTEM_PROMPT, model: decisionModel(), signal });
          decision = extractJson(raw);
          if (decision?.action) break;
        } catch (e) {
          if (signal?.aborted) throw new Error('cancelled');
          if (attempt === 0) {
            onLog(`turn ${turn + 1}: model output invalid JSON (${e.message}), retrying turn…`);
            await page.waitForTimeout(600);
            continue;
          }
          onLog(`turn ${turn + 1}: model error — ${e.message}`);
          failReason = `model error: ${e.message}`;
          break;
        }
      }
      if (!decision) {
        if (failReason) break;
        continue;
      }
      throwIfCancelled();
      const elementId = decision.elementId == null ? null : Number(decision.elementId);
      const label = `${decision.action}${elementId != null ? ' #' + elementId : ''}${decision.text ? ` "${String(decision.text).slice(0, 40)}"` : ''}`;
      onLog(`turn ${turn + 1}: ${label} — ${decision.reason || ''}`);

      if (decision.action === 'done') { finished = true; break; }
      if (decision.action === 'fail') { failReason = decision.reason || 'model could not complete the workflow'; break; }

      if (decision.action === 'consult') {
        const q = String(decision.question || decision.reason || '').trim();
        if (!q || consults >= 2) { history.push({ action: 'consult', error: consults >= 2 ? 'consult limit reached — decide from the page, or fail' : 'no question given' }); continue; }
        consults++;
        onLog(`  asking the source code: ${q.slice(0, 140)}`);
        try {
          const answer = await consultCodebase(item, guidance, q, { signal });
          guidance = guidance && typeof guidance === 'object' ? guidance : { summary: String(guidance || ''), steps: [], prerequisites: [] };
          guidance.consults = [...(guidance.consults || []), { question: q, answer }];
          onPlan?.(guidance);
          history.push({ action: 'consult', name: q.slice(0, 60), outcome: answer.slice(0, 300) });
          onLog(`  answer: ${answer.split('\n')[0].slice(0, 160)}`);
        } catch (e) {
          if (signal?.aborted) throw new Error('cancelled');
          history.push({ action: 'consult', error: `source lookup failed: ${String(e.message || e).slice(0, 120)}` });
        }
        continue;
      }

      if (decision.action === 'wait') { await page.waitForTimeout(Math.max(200, Math.min(decision.ms || 800, 3000))); history.push({ action: 'wait' }); continue; }

      if (decision.action === 'press') {
        const key = decision.key || 'Enter';
        await pushStep(snap, { action: 'press', key, aiReason: decision.reason || undefined });
        try { await page.keyboard.press(key); } catch (e) { steps.pop(); history.push({ action: 'press', error: String(e.message || e) }); continue; }
        history.push({ action: 'press', name: key });
        await page.waitForTimeout(400);
        await noteNavigation();
        continue;
      }

      const el = Number.isInteger(elementId) ? snap.elements.find((e) => e.id === elementId) : null;
      if (!el) { history.push({ action: decision.action, error: `elementId ${decision.elementId} is not in the list` }); continue; }
      if (!['click', 'type', 'upload', 'hover'].includes(decision.action)) { history.push({ action: decision.action, error: 'unknown action' }); continue; }

      // Hover is pure observation — it reads a tooltip (usually the reason a control is disabled)
      // and is deliberately NOT recorded as a step: it isn't part of the walkthrough a viewer needs
      // to see, and replay.mjs would have nothing meaningful to do with it.
      if (decision.action === 'hover') {
        try {
          await page.locator(`[data-kb-ai-id="${elementId}"]`).hover({ timeout: 4000 });
          await page.waitForTimeout(450); // tooltips are usually delayed
          const tip = await page.evaluate(() => {
            const pick = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
            const live = document.querySelector('[role="tooltip"],[data-radix-popper-content-wrapper]');
            return (live ? pick(live) : '').slice(0, 300);
          }).catch(() => '');
          const title = el.title || '';
          const seen = tip || title;
          history.push({ action: 'hover', name: el.name, sig: `hover|${el.role}|${el.name}`, outcome: seen ? `tooltip: ${seen}` : 'no tooltip appeared' });
          onLog(`  hover "${el.name}" → ${seen ? seen.slice(0, 120) : 'no tooltip'}`);
        } catch (e) {
          history.push({ action: 'hover', name: el.name, error: String(e.message || e).split('\n')[0].slice(0, 160) });
        }
        continue;
      }

      // Hard loop guard (the prompt asks for this too, but asking isn't enough). Only CONSECUTIVE
      // repeats count: re-clicking the control that was just clicked and changed nothing, or a third
      // click in a row on the same control. A run-wide count would refuse the "Next" button that
      // every wizard step legitimately has.
      const sig = `${decision.action}|${el.role}|${el.name}`;
      const acted = history.filter((h) => !h.error && h.action !== 'wait');
      const prev = acted[acted.length - 1];
      let consecutive = 0; for (let i = acted.length - 1; i >= 0 && acted[i].sig === sig; i--) consecutive++;
      // Refuse a repeat at most ONCE per element: refusals never enter `acted`, so without this the
      // first "no visible change" made every later request for that element refused forever — a
      // dead loop that burned a whole run on one menu item. The second identical request goes
      // through, but activated differently (keyboard, below) since a plain click already did nothing.
      const refusedBefore = history[history.length - 1]?.error?.startsWith('refused') && history[history.length - 1]?.sig === sig;
      let activateWithKeyboard = false;
      if ((decision.action === 'click' || decision.action === 'hover') && ((prev?.sig === sig && /no visible change/.test(prev.outcome || '')) || consecutive >= 2)) {
        if (!refusedBefore) {
          history.push({ action: decision.action, name: el.name, sig, error: `refused — you clicked "${el.name}" ${consecutive} time(s) in a row${prev?.sig === sig && /no visible change/.test(prev.outcome || '') ? ' and nothing changed' : ''}. Something else must happen first (fill a required field, pick an option, wait for a load); choose a different element, or "fail" if the workflow cannot be completed here. If you are certain this is the right control, ask for it once more and it will be activated with the keyboard instead.` });
          onLog(`  ! refused repeat click on "${el.name}"`);
          continue;
        }
        activateWithKeyboard = true;
        onLog(`  retrying "${el.name}" via keyboard activation`);
      }

      // Bring the target into the viewport BEFORE measuring and capturing: the box is recorded in
      // viewport coordinates and the slide is a viewport screenshot, so a control below the fold
      // would otherwise get a box past the image's bottom edge and a slide that doesn't show it.
      // (The spotlight scrolls later too, but that's after the capture.) Instant, not smooth — the
      // measurement follows immediately.
      await page.evaluate((id) => {
        const t = document.querySelector('[data-kb-ai-id="' + id + '"]');
        if (!t) return;
        const r = t.getBoundingClientRect();
        if (r.top < 40 || r.bottom > innerHeight - 40 || r.left < 0 || r.right > innerWidth) t.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      }, elementId).catch(() => {});
      await page.waitForTimeout(150);

      // Fingerprint BEFORE acting: a click that navigates or closes a dialog unmounts the element.
      const fp = await page.evaluate(FINGERPRINT_FN, elementId).catch(() => null);
      if (!fp) { history.push({ action: decision.action, name: el.name, error: 'element disappeared before it could be recorded' }); continue; }
      const loc = page.locator(`[data-kb-ai-id="${elementId}"]`);
      const text = decision.action === 'type' ? String(decision.text ?? '')
        : decision.action === 'upload' ? String(decision.file || 'pdf')
        : undefined;
      // The agent's reasoning is NOT narration (it names sample users/dates); keep it for debugging
      // only. Real narration is written by the bridge after the run, with the codebase-grounded writer.
      await pushStep(snap, { action: decision.action, target: fp, ...(text !== undefined ? { value: text } : {}), aiReason: decision.reason || undefined });

      // Visual feedback & human takeover check (Step 6)
      const actionPauseStatus = await handleTakeOverPause(page, onLog);
      if (actionPauseStatus === 'skip') {
        steps.pop();
        onLog(`⏭ Action skipped by user via HUD control.`);
        await clearSpotlight(page);
        continue;
      }
      await ensureVisualHud(page, { title: item.title, stepNum: currentPlanStep, totalSteps: totalPlanSteps, actionDesc: label });
      await highlightTargetElement(page, elementId, el.name, decision.action);

      try {
        if (decision.action === 'click') {
          let clicked = false;
          if (activateWithKeyboard) {
            // Focus + Enter: menu items, options and buttons all activate on Enter, and it sidesteps
            // pointer-event quirks (e.g. a menu closing on pointerdown before the item's own handler).
            await loc.focus({ timeout: 2500 });
            await page.keyboard.press('Enter');
            clicked = true;
          }
          try {
            if (!clicked) { await loc.click({ timeout: 2500 }); clicked = true; }
          } catch (_) {}
          // A menu item that is still in the DOM after being clicked means the menu didn't act on the
          // click; give it the keyboard path right away rather than reporting "no visible change".
          if (clicked && !activateWithKeyboard && ['menuitem', 'option', 'menuitemradio', 'menuitemcheckbox'].includes(el.role)) {
            await page.waitForTimeout(300);
            const stillThere = await loc.count().catch(() => 0);
            if (stillThere) {
              try { await loc.focus({ timeout: 1000 }); await page.keyboard.press('Enter'); onLog(`  menu item "${el.name}" ignored the click — activated with Enter`); } catch (_) {}
            }
          }

          if (!clicked) {
            const b = await loc.boundingBox().catch(() => null);
            if (b && b.width > 0 && b.height > 0) {
              await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
              clicked = true;
            }
          }

          if (!clicked) {
            await page.evaluate((id) => {
              const target = document.querySelector(`[data-kb-ai-id="${id}"]`);
              if (target) {
                target.scrollIntoView({ block: 'nearest' });
                target.click();
                target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              }
            }, elementId).catch(() => {});
          }
        } else if (decision.action === 'upload') {
          const { how, file } = await attachFile(page, loc, text);
          onLog(`  attached ${path.basename(file)} (${how})`);
        } else {
          // Focus, don't click, to start typing: a pointer click on a field bubbles to whatever the
          // field sits inside — in a dialog rendered within a clickable table row, that click reached
          // the row's own handler and navigated away mid-rename. Focus has no such side effects.
          try { await loc.focus({ timeout: 2500 }); } catch (_) { try { await loc.click({ timeout: 2500 }); } catch (_) {} }
          try { await loc.fill(''); } catch (_) {}
          await loc.type(text, { delay: 15 });
        }
      } catch (e) {
        await clearSpotlight(page);
        if (signal?.aborted) throw new Error('cancelled');
        steps.pop(); // the action didn't happen — don't record it
        const msg = String(e.message || e).split('\n')[0].slice(0, 200);
        history.push({ action: decision.action, name: el.name, error: msg });
        onLog(`  ! action failed: ${msg}`);
        continue;
      }
      await clearSpotlight(page);
      history.push({ action: decision.action, name: el.name, text, sig });
      await page.waitForTimeout(600);
      await noteNavigation();
    }
    };

    // Before touching anything: read the app's source (via the hadrius-codebase MCP) for the exact
    // UI path — which route, which row/tab to open, exact button labels, prerequisites. The coverage
    // scan's start_route/trigger are hints from the same source, but often one level too shallow.
    if (guidance) {
      onLog(`Using the prepared plan (${guidance.steps?.length || 0} steps):\n${renderPlan(guidance)}`);
    } else {
      try {
        onLog("No prepared plan yet — reading the app's source code for the exact UI path…");
        guidance = await planFromCodebase(item, { signal });
        onPlan?.(guidance);
        onLog(`Plan from source:\n${renderPlan(guidance)}`);
      } catch (e) {
        if (signal?.aborted) throw new Error('cancelled');
        onLog(`  (source lookup unavailable — ${String(e.message || e).slice(0, 120)}; proceeding from the page alone)`);
      }
    }
    if (guidance?.exists === false) throw new Error(`the source code suggests this workflow does not exist as described: ${guidance.summary}`);

    for (let attempt = 1; attempt <= 2; attempt++) {
      await runAttempt();
      if (finished || attempt === 2 || !failReason || /^model error/.test(failReason)) break;
      // The model gave up with a reason: ask the source code again WITH that reason, then retry once.
      onLog(`Attempt ${attempt} gave up: ${failReason.slice(0, 160)}\nRe-checking the source with that in mind and retrying once…`);
      try { guidance = await planFromCodebase(item, { signal, failure: failReason, previous: guidance }); onPlan?.(guidance); onLog(`Revised plan:\n${renderPlan(guidance)}`); }
      catch (e) { if (signal?.aborted) throw new Error('cancelled'); break; }
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settleAuthRedirect(page);
    }

    throwIfCancelled();
    if (!finished) throw new Error(failReason || `stopped after ${MAX_STEPS} steps without finishing`);
    if (!steps.some((s) => s.action !== 'navigate')) throw new Error('the model finished without performing any recordable action');

    const now = new Date().toISOString();
    const script = {
      name: item.title,
      description: item.description || '',
      environment: { startUrl },
      recording: {
        id: recordingId,
        recordedAt: now,
      },
      steps,
      createdAt: now,
      updatedAt: now,
    };
    onLog(`Done — ${steps.length} step(s) recorded.`);
    return { script };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await ctx?.close(); } catch (_) {} // persistent profile: closing flushes the session to disk
  }
}

function pathOf(href) { try { const u = new URL(href); return u.pathname + u.search; } catch { return href; } }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const item = JSON.parse(process.argv[2] || '{}');
  if (!item.title || !item.start_route) { console.error('usage: node tools/ai-record.mjs \'{"title":"...","start_route":"/...","description":"..."}\''); process.exit(2); }
  runAiRecord(item, { onLog: (m) => console.error(m) })
    .then((r) => console.log(JSON.stringify(r.script, null, 2)))
    .catch((e) => { console.error('ai-record failed:', e.message); process.exit(1); });
}
