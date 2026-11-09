// Dedicated Studio browser profile for owner-session drift captures (see owner-session.mjs).
//
//   node tools/drift/owner-profile.mjs --sign-in   # opens a window on the Studio profile; YOU sign in to Hadrius
//   node tools/drift/owner-profile.mjs --check     # headless: is the profile signed in, which companies it sees
//
// The profile (<repo>/.browser-profile-owner, gitignored) is its own Hadrius sign-in session with your account: the
// app refreshes its tokens inside it, so it keeps working unattended and never touches your everyday Chrome (no
// "Allow remote debugging?" prompts). Credentials are typed by you in the window; this tool never types, reads or
// stores them. A marker file (studio-sign-in.json: when, account label, which test companies are visible; no
// tokens) records a verified sign-in and makes 'profile' the default owner source.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { OWNER_PROFILE_DIR, APP_ORIGIN, inspectOwnerProfile, accountLabel } from './owner-session.mjs';
import { companiesFromUserPayload } from './academy-login.mjs';
import { getTenant } from './tenants.mjs';

const MARKER = path.join(OWNER_PROFILE_DIR, 'studio-sign-in.json');
const NEED = ['academy', 'sandbox'].map((k) => getTenant(k));
const describe = (companies) => Object.fromEntries(NEED.map((t) => [`${t.key} (${t.companyId})`, companies.some((c) => c.id === t.companyId)]));

async function signIn({ timeoutMs = 15 * 60 * 1000 } = {}) {
  fs.mkdirSync(OWNER_PROFILE_DIR, { recursive: true, mode: 0o700 });
  const ctx = await chromium.launchPersistentContext(OWNER_PROFILE_DIR, { headless: false, viewport: null, args: ['--window-size=1400,900'] });
  let user = null, closed = false;
  ctx.on('close', () => { closed = true; });
  const watch = (page) => page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      if (res.request().method() === 'GET' && /\/users\/?$/.test(u.pathname) && u.searchParams.has('uuid') && res.ok()) user = companiesFromUserPayload(await res.json());
    } catch { /* passive */ }
  });
  ctx.on('page', watch);
  const page = ctx.pages()[0] || await ctx.newPage();
  watch(page);
  await page.goto(`${APP_ORIGIN}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('A browser window opened on the Studio profile. Sign in to Hadrius there with your own account (this tool never types anything).');
  const until = Date.now() + timeoutMs;
  while (!closed && Date.now() < until && !(user?.companies && NEED.every((t) => user.companies.some((c) => c.id === t.companyId)))) await new Promise((r) => setTimeout(r, 2000));
  if (closed) return { ok: false, reason: 'window_closed_before_sign_in' };
  if (!user?.companies) { await ctx.close().catch(() => {}); return { ok: false, reason: 'not_signed_in_within_15_min' }; }
  await new Promise((r) => setTimeout(r, 3000)); // let the app persist its session in the profile
  await ctx.close().catch(() => {});
  return { ok: true };
}

async function check() {
  try {
    const r = await inspectOwnerProfile({ chromium });
    const visible = describe(r.companies);
    const ok = Object.values(visible).every(Boolean);
    if (ok) fs.writeFileSync(MARKER, JSON.stringify({ schema: 1, verifiedAt: new Date().toISOString(), account: accountLabel(r.username), companiesVisible: r.companies.length, tenants: visible }, null, 2) + '\n', { mode: 0o600 });
    return { ok, account: accountLabel(r.username), companiesVisible: r.companies.length, tenants: visible, ...(ok ? {} : { reason: 'account_cannot_open_both_test_companies' }) };
  } catch (e) { return { ok: false, reason: e?.code || 'error', detail: String(e?.message || e).slice(0, 300) }; }
}

const args = process.argv.slice(2);
let out;
if (args.includes('--sign-in')) {
  const s = await signIn();
  out = s.ok ? { signIn: 'done', ...(await check()) } : s;
} else if (args.includes('--check')) out = await check();
else { console.error('usage: owner-profile.mjs --sign-in | --check'); process.exit(64); }
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 2);
