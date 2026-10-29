#!/usr/bin/env node
// Unattended Hadrius Academy sign-in for the weekly drift job.
//
// Import-safe: importing this module launches nothing and reads no secrets. The password is read
// from the macOS login Keychain only inside ensureAcademySession(), at the moment it is needed,
// passed straight to Playwright's locator.fill() and then dropped. It is never logged, written,
// screenshotted or traced. No screenshots, traces, video or HAR are taken anywhere in this module.
//
// CLI:  node tools/drift/academy-login.mjs --check    (status only, never types anything)
//       node tools/drift/academy-login.mjs --ensure   (sign in if needed, one attempt only)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const ACCOUNT = 'stephen+hstudio@hadrius.com';
export const SERVICE = 'hadrius-studio-academy';
export const EXPECTED_COMPANY_ID = 1150;
export const DEFAULT_START_URL = `https://app.hadrius.com/marketing/projects?company_id=${EXPECTED_COMPANY_ID}`;
export const DEFAULT_PROFILE_DIR = path.join(REPO, '.browser-profile-drift');
export const VIEWPORT = { width: 1600, height: 900 };
export const STAGE_TIMEOUT_MS = 60_000;
export const TOTAL_TIMEOUT_MS = 180_000;

// Hosted Cognito UI is the only auth origin allowed besides the app origin itself.
const COGNITO_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/i;
const SSO_HOST_RE = /(okta|onelogin|microsoftonline|login\.microsoft|accounts\.google|auth0|pingone|pingidentity|duosecurity|jumpcloud|adfs|saml)/i;
// Same semantics as tools/ai-record.mjs (re-implemented: that module has import-time side effects).
export const LOGIN_PATH_RE = /\/(login|log-in|signin|sign-in|auth|sso|oauth|callback|mfa|verify|password)(\/|$|\?)/i;
const MFA_SELECTOR = 'input[autocomplete="one-time-code"], input[name*="mfa" i], input[name*="otp" i], input[name*="code" i][inputmode="numeric"]';
const MFA_TEXT_RE = /\b(mfa code|verification code|authenticator|one[- ]time (pass)?code|two[- ]factor|2fa)\b/i;
const CAPTCHA_SELECTOR = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile';
const CAPTCHA_TEXT_RE = /\b(captcha|verify you are (a )?human|i'?m not a robot)\b/i;
const BAD_CREDS_RE = /(incorrect|invalid|wrong|not authori[sz]ed|doesn'?t match|user does not exist|not found|no account)/i;
const LOCKOUT_RE = /(attempts exceeded|too many|locked|temporarily)/i;
const EMAIL_SELECTOR = 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name="email"], input[name="username"]';
const PASSWORD_SELECTOR = 'input[type="password"]';

export const EXIT_CODES = Object.freeze({
  already_signed_in: 0, signed_in: 10, not_signed_in: 20,
  mfa_required: 30, invalid_credentials: 31, sso_redirect: 32, captcha: 33,
  keychain_missing: 34, tenant_mismatch: 35, unexpected: 36,
});

export function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return domain ? `${user.slice(0, 2)}***@${domain}` : '***';
}

/** Replace every occurrence of each secret (and the raw account) in text. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('[REDACTED]');
  return out.split(ACCOUNT).join(maskEmail(ACCOUNT));
}

export class KeychainMissingError extends Error {}

/** Default password source: macOS login Keychain, no shell, output never surfaced. */
export function keychainPassword({ account = ACCOUNT, service = SERVICE } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'],
      { timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
        // Never include stdout/stderr in the error: stdout is the secret.
        if (err) return reject(new KeychainMissingError(`keychain item not readable (exit ${err.code ?? 'n/a'})`));
        const pw = String(stdout).replace(/\r?\n$/, '');
        if (!pw) return reject(new KeychainMissingError('keychain item is empty'));
        resolve(pw);
      });
  });
}

function originOf(url) { try { return new URL(url).origin; } catch { return null; } }

async function isSignedIn(page, appOrigin) {
  const url = page.url();
  if (originOf(url) !== appOrigin) return false;
  if (LOGIN_PATH_RE.test(new URL(url).pathname)) return false;
  const looksLikeLogin = await page.evaluate(() => !!document.querySelector('input[type="password"]')
    && !document.querySelector('a[href*="/overview"], a[href*="/settings"], nav a[href*="/people"]')).catch(() => true);
  return !looksLikeLogin;
}

async function settleAuthRedirect(page, ms = 6000) {
  const start = originOf(page.url());
  await page.waitForURL((u) => LOGIN_PATH_RE.test(u.pathname) || originOf(u.href) !== start, { timeout: ms }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function stableSignedIn(page, appOrigin, { checks = 3, timeoutMs = 15_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < end) {
    if (await isSignedIn(page, appOrigin)) { if (++stable >= checks) return true; } else stable = 0;
    await page.waitForTimeout(700);
  }
  return false;
}

async function firstVisible(page, selector) {
  const loc = page.locator(selector);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible().catch(() => false)) return el; }
  return null;
}

async function pageText(page) {
  return (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 20_000);
}

async function hasCaptcha(page) {
  if (await firstVisible(page, CAPTCHA_SELECTOR)) return true;
  return CAPTCHA_TEXT_RE.test(await pageText(page));
}

async function hasMfa(page) {
  if (await firstVisible(page, MFA_SELECTOR)) return true;
  const text = await pageText(page);
  return MFA_TEXT_RE.test(text) && !(await firstVisible(page, PASSWORD_SELECTOR));
}

async function errorText(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('[role="alert"], .text-destructive, .error, .error-message, [aria-live="assertive"], [data-testid*="error"]')]
      // Next.js's route announcer is an aria-live="assertive" region that just reads out the new
      // page title (e.g. "Hadrius") on every client navigation — it is not an error.
      .filter((e) => !e.closest('next-route-announcer') && e.id !== '__next-route-announcer__');
    return els.map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | ');
  }).catch(() => '');
}

async function submitButton(page) {
  const byType = await firstVisible(page, 'button[type="submit"], input[type="submit"]');
  if (byType) return byType;
  const byRole = page.getByRole('button', { name: /^(sign in|log in|login|next|continue|submit)$/i });
  return (await byRole.count().catch(() => 0)) ? byRole.first() : null;
}

/** Classify an auth-page origin before anything is typed into it. */
export function classifyAuthOrigin(url, appOrigin, extraAllowed = []) {
  const origin = originOf(url);
  if (!origin) return { ok: false, status: 'unexpected', origin };
  if (origin === appOrigin || COGNITO_ORIGIN_RE.test(origin) || extraAllowed.includes(origin)) {
    // The app's own SSO hand-off page is an SSO flow, not a password form.
    if (origin === appOrigin && /\/auth\/sso(\/|$)/i.test(new URL(url).pathname)) return { ok: false, status: 'sso_redirect', origin };
    return { ok: true, origin };
  }
  return { ok: false, status: SSO_HOST_RE.test(new URL(url).hostname) ? 'sso_redirect' : 'unexpected', origin };
}

/** Flatten the company tree carried on the users/?uuid= payload (user.company + children). */
export function companiesFromUserPayload(body) {
  const user = Array.isArray(body) ? body[0] : (body?.data && !body.company ? body.data : body);
  if (!user || typeof user !== 'object' || !user.company) return null;
  const out = []; const seen = new Set();
  const walk = (c) => {
    if (!c || typeof c !== 'object' || c.id == null || seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ id: Number(c.id), name: c.display_name ?? c.name ?? null, company_type: c.company_type ?? null });
    for (const ch of c.children || []) walk(ch);
  };
  walk(user.company);
  const roles = (Array.isArray(user.roles) ? user.roles : []).map((r) => (typeof r === 'string' ? r
    : (r?.name ?? r?.role ?? r?.title ?? r?.type ?? null))).filter(Boolean);
  return {
    companies: out, roles,
    is_hadrius_employee: user.is_hadrius_employee ?? null,
    has_customer_firm_staff_access: user.has_customer_firm_staff_access ?? null,
  };
}

// The app at app.hadrius.com talks to its API on a separate registrable domain (observed live:
// GET https://hadriusapi.com/api/users/?uuid=...). Accept the app's own host family plus that API host.
const API_HOSTS = ['hadriusapi.com'];
const hostIn = (h, suffix) => h === suffix || h.endsWith('.' + suffix);

function attachUserObserver(page, appHostSuffix) {
  const state = { payload: null };
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() !== 'GET' || state.payload) return;
      const u = new URL(res.url());
      if (!/\/users\/?$/.test(u.pathname) || !u.searchParams.has('uuid')) return;
      if (!(hostIn(u.hostname, appHostSuffix) || API_HOSTS.some((h) => hostIn(u.hostname, h)) || u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return;
      if (!res.ok()) return;
      const parsed = companiesFromUserPayload(await res.json());
      if (parsed) state.payload = parsed;
    } catch { /* passive only */ }
  });
  return state;
}

async function verifyTenant(page, observer, { startUrl, expectedCompanyId, deadline, log }) {
  const end = Math.min(Date.now() + 20_000, deadline);
  while (!observer.payload && Date.now() < end) await page.waitForTimeout(500);
  const finalUrl = new URL(page.url());
  const urlCompanyId = finalUrl.searchParams.get('company_id');
  const text = await pageText(page);
  const tenant = {
    expectedCompanyId,
    urlCompanyId: urlCompanyId == null ? null : Number(urlCompanyId),
    academyNameVisible: /Hadrius Academy/i.test(text),
    finalPath: finalUrl.pathname,
  };
  if (!observer.payload) {
    log('tenant check: user payload (users/?uuid=) was not observed — failing closed');
    return { ok: false, reason: 'user_payload_not_observed', tenant };
  }
  const { companies, roles, is_hadrius_employee, has_customer_firm_staff_access } = observer.payload;
  Object.assign(tenant, { companies, roles, is_hadrius_employee, has_customer_firm_staff_access });
  const others = companies.filter((c) => c.id !== expectedCompanyId);
  const reasons = [];
  if (!companies.some((c) => c.id === expectedCompanyId)) reasons.push(`company ${expectedCompanyId} not accessible`);
  if (others.length) reasons.push(`other companies accessible: ${others.map((c) => `${c.id} ${c.name ?? ''}`.trim()).join(', ')}`);
  if (has_customer_firm_staff_access === true) reasons.push('account has customer-firm staff access');
  if (new URL(startUrl).searchParams.has('company_id') && tenant.urlCompanyId !== null && tenant.urlCompanyId !== expectedCompanyId) reasons.push(`app switched to company ${tenant.urlCompanyId}`);
  log(`tenant check: companies=[${companies.map((c) => c.id).join(',')}] roles=[${roles.join(',')}] url company_id=${tenant.urlCompanyId}`);
  return reasons.length ? { ok: false, reason: reasons.join('; '), tenant } : { ok: true, tenant };
}

/**
 * Make sure the dedicated drift profile is signed in to Hadrius Academy.
 * @returns {Promise<{status: string, origin: string|null, companyIds?: number[], tenant?: object, detail?: string, steps: string[]}>}
 */
export async function ensureAcademySession({
  profileDir = DEFAULT_PROFILE_DIR,
  startUrl = DEFAULT_START_URL,
  timeoutMs = TOTAL_TIMEOUT_MS,
  stageTimeoutMs = STAGE_TIMEOUT_MS,
  onLog = () => {},
  getPassword = keychainPassword,
  email = ACCOUNT,
  login = true,
  expectedCompanyId = EXPECTED_COMPANY_ID,
  extraAllowedAuthOrigins = [],
  headless = true,
  chromium: chromiumOverride,
} = {}) {
  const steps = [];
  const log = (msg) => { const m = redact(msg).split(email).join(maskEmail(email)); steps.push(m); try { onLog(m); } catch {} };
  const appOrigin = originOf(startUrl);
  const result = (status, extra = {}) => ({ status, origin: extra.origin ?? null, ...extra, steps });
  if (/\bpw:|\bpw:api|\*/.test(process.env.DEBUG || '') || process.env.PWDEBUG) {
    return result('unexpected', { detail: 'refusing to run with Playwright DEBUG/PWDEBUG enabled (would log fill values)' });
  }
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const { chromium } = chromiumOverride ? { chromium: chromiumOverride } : await import('playwright');
  const deadline = Date.now() + timeoutMs;
  const stage = () => Math.max(1000, Math.min(stageTimeoutMs, deadline - Date.now()));
  let ctx; let timer;
  const run = async () => {
    // No tracing, video, HAR or screenshots: the context is launched bare.
    ctx = await chromium.launchPersistentContext(profileDir, { headless, viewport: VIEWPORT });
    const page = ctx.pages()[0] || (await ctx.newPage());
    const observer = attachUserObserver(page, new URL(startUrl).hostname);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: stage() });
    await settleAuthRedirect(page);
    log(`loaded ${originOf(page.url())}${new URL(page.url()).pathname}`);

    const finishSignedIn = async (status) => {
      // Reload the start URL (read-only navigation) so the tenant check sees company_id applied.
      if (status === 'signed_in') {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: stage() }).catch(() => {});
        await settleAuthRedirect(page, 3000);
        if (!(await stableSignedIn(page, appOrigin, { timeoutMs: Math.min(15_000, stage()) }))) return result('unexpected', { origin: appOrigin, detail: 'signed-in state did not hold after reload' });
      }
      const v = await verifyTenant(page, observer, { startUrl, expectedCompanyId, deadline, log });
      const companyIds = v.tenant.companies?.map((c) => c.id);
      if (!v.ok) return result('tenant_mismatch', { origin: appOrigin, companyIds, tenant: v.tenant, detail: v.reason });
      return result(status, { origin: appOrigin, companyIds, tenant: v.tenant });
    };

    if (await stableSignedIn(page, appOrigin, { timeoutMs: 8000 })) { log('already signed in'); return finishSignedIn('already_signed_in'); }
    if (!login) return result('not_signed_in', { origin: originOf(page.url()), detail: 'check mode: no login attempted' });

    // ---- Login page: wait for a form, then gate on origin BEFORE typing anything ----
    const formStart = Date.now(); const formEnd = formStart + stage();
    let emailField = null; let pwField = null;
    while (Date.now() < formEnd) {
      emailField = await firstVisible(page, EMAIL_SELECTOR);
      pwField = await firstVisible(page, PASSWORD_SELECTOR);
      if (emailField || pwField) break;
      // Off-origin page without a form (IdP hand-off): don't sit out the whole stage.
      if (!classifyAuthOrigin(page.url(), appOrigin, extraAllowedAuthOrigins).ok && Date.now() - formStart > 8000) break;
      await page.waitForTimeout(500);
    }
    const gate = classifyAuthOrigin(page.url(), appOrigin, extraAllowedAuthOrigins);
    log(`auth origin ${gate.origin}${gate.ok ? ' (allowed)' : ` (${gate.status})`}`);
    if (!gate.ok) return result(gate.status, { origin: gate.origin, detail: 'auth page origin not allowed; nothing typed' });
    if (await hasCaptcha(page)) return result('captcha', { origin: gate.origin, detail: 'captcha on login page; nothing typed' });
    if (!emailField && !pwField) return result('unexpected', { origin: gate.origin, detail: 'no email/password field found' });

    let password;
    try { password = await getPassword(); } catch (e) {
      return result('keychain_missing', { origin: gate.origin, detail: e instanceof KeychainMissingError ? e.message : 'password source failed' });
    }
    if (typeof password !== 'string' || !password) return result('keychain_missing', { origin: gate.origin, detail: 'password source returned nothing' });
    const secrets = [password];
    try {
      if (emailField) { await emailField.fill(email, { timeout: stage() }); log(`filled email ${maskEmail(email)}`); }
      if (!pwField) {
        // Two-step flow: email, then Next/Continue, then password.
        const next = await submitButton(page);
        if (!next) return result('unexpected', { origin: gate.origin, detail: 'no next/continue button after email' });
        await next.click({ timeout: stage() });
        log('clicked next (email step)');
        const pwEnd = Date.now() + stage();
        while (Date.now() < pwEnd && !(pwField = await firstVisible(page, PASSWORD_SELECTOR))) {
          if (await hasMfa(page)) return result('mfa_required', { origin: originOf(page.url()), detail: 'MFA prompt before password; stopped' });
          if (await hasCaptcha(page)) return result('captcha', { origin: originOf(page.url()) });
          const e = await errorText(page);
          if (e && BAD_CREDS_RE.test(e)) return result('invalid_credentials', { origin: originOf(page.url()), detail: redact(e, secrets).slice(0, 200) });
          await page.waitForTimeout(400);
        }
        if (!pwField) return result('unexpected', { origin: originOf(page.url()), detail: 'password field never appeared' });
        const g2 = classifyAuthOrigin(page.url(), appOrigin, extraAllowedAuthOrigins);
        if (!g2.ok) return result(g2.status, { origin: g2.origin, detail: 'password page origin not allowed; password not typed' });
      }
      try { await pwField.fill(password, { timeout: stage() }); } catch { return result('unexpected', { origin: gate.origin, detail: 'could not fill password field' }); }
      log('filled password (from keychain)');
    } finally {
      password = undefined; // drop the only reference; `secrets` is cleared below
    }
    const submit = await submitButton(page);
    try {
      if (submit) await submit.click({ timeout: stage() }); else await pwField.press('Enter', { timeout: stage() });
    } catch { secrets.length = 0; return result('unexpected', { origin: gate.origin, detail: 'submit failed' }); }
    log('submitted once');
    // The field still holds the value until navigation; clear it client-side so nothing lingers.
    const outEnd = Date.now() + stage();
    try {
      let lastError = '';
      while (Date.now() < outEnd) {
        await page.waitForTimeout(700);
        const o = originOf(page.url());
        if (await isSignedIn(page, appOrigin) && await stableSignedIn(page, appOrigin, { timeoutMs: 6000 })) { log('signed in'); secrets.length = 0; return await finishSignedIn('signed_in'); }
        if (o !== appOrigin && !COGNITO_ORIGIN_RE.test(o || '') && !extraAllowedAuthOrigins.includes(o)) return result(SSO_HOST_RE.test(o || '') ? 'sso_redirect' : 'unexpected', { origin: o, detail: 'redirected off the auth origin after submit' });
        if (await hasMfa(page)) return result('mfa_required', { origin: o, detail: 'MFA code requested; stopped without entering a code' });
        if (await hasCaptcha(page)) return result('captcha', { origin: o });
        const e = await errorText(page);
        if (e) {
          const msg = redact(e, secrets).slice(0, 200);
          if (BAD_CREDS_RE.test(e) || LOCKOUT_RE.test(e)) return result('invalid_credentials', { origin: o, detail: msg });
          // Unrecognised alert text: keep waiting (sign-in may still be completing) and report it only on timeout.
          lastError = msg;
        }
      }
      return result('unexpected', { origin: originOf(page.url()), detail: lastError ? `no outcome within stage timeout; last alert: ${lastError}` : 'no outcome within stage timeout' });
    } finally {
      secrets.length = 0;
      await page.evaluate(() => document.querySelectorAll('input[type="password"]').forEach((i) => { i.value = ''; })).catch(() => {});
    }
  };
  try {
    return await Promise.race([
      run(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(result('unexpected', { detail: `total timeout ${Math.round(timeoutMs / 1000)}s` })), timeoutMs); }),
    ]);
  } catch (e) {
    return result('unexpected', { detail: redact(e?.message || String(e)).split('\n')[0].slice(0, 300) });
  } finally {
    clearTimeout(timer);
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function main(argv) {
  const mode = argv.includes('--ensure') ? 'ensure' : argv.includes('--check') ? 'check' : null;
  if (!mode) { process.stderr.write('usage: academy-login.mjs --check | --ensure [--profile DIR] [--start-url URL]\n'); return 64; }
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const res = await ensureAcademySession({
    profileDir: arg('--profile') || DEFAULT_PROFILE_DIR,
    startUrl: arg('--start-url') || DEFAULT_START_URL,
    login: mode === 'ensure',
    onLog: (m) => process.stderr.write(`[academy-login] ${m}\n`),
  });
  process.stdout.write(JSON.stringify({ mode, account: maskEmail(ACCOUNT), ...res }, null, 2) + '\n');
  return EXIT_CODES[res.status] ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => { process.stderr.write('[academy-login] crashed\n'); process.exit(1); });
}
