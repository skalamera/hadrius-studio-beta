// Synthetic, local-only tests for tools/drift/academy-login.mjs. No real Hadrius, no Keychain:
// the password source is injected and every page is served from a local http server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAcademySession, KeychainMissingError, ACCOUNT, EXIT_CODES, classifyAuthOrigin,
  companiesFromUserPayload, maskEmail, redact,
} from '../../tools/drift/academy-login.mjs';

const FAKE_PW = 'Fake-Pw-ZZ9!synthetic-only-7731';
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'academy-login-test-'));

const state = { mode: 'onepage', submits: 0, typed: 0, lastPasswordOk: null, extraCompany: false };
function reset(mode, extra = {}) { Object.assign(state, { mode, submits: 0, typed: 0, lastPasswordOk: null, extraCompany: false }, extra); }

const appPage = () => `<!doctype html><title>app</title><body><div id="root">loading</div><script>
if (!document.cookie.includes('sess=ok')) {
  ${'MODE' /* replaced */}
} else {
  document.getElementById('root').innerHTML = '<nav><a href="/overview">Overview</a><a href="/settings">Settings</a></nav><h1>Marketing projects</h1><div>Hadrius Academy 1150</div>';
  fetch('/api/users/?uuid=u1').then(r => r.json());
}
</script></body>`;

const typedProbe = `document.addEventListener('input', () => fetch('/__typed', {method:'POST'}));`;
const loginForm = ({ twoStep = false } = {}) => `<!doctype html><title>Sign in</title><body>
<h1>Sign in</h1>
<form id="f" method="post">
  <label>Work email <input type="email" autocomplete="username" name="email" id="email"></label>
  <div id="pwrow" ${twoStep ? 'hidden' : ''}><label>Password <input type="password" autocomplete="current-password" name="password" id="pw"></label></div>
  <p id="err" class="text-destructive"></p>
  <button type="submit" id="btn">${twoStep ? 'Next' : 'Sign in'}</button>
</form>
<script>
let step = ${twoStep ? "'email'" : "'password'"};
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (step === 'email') {
    step = 'password';
    document.getElementById('email').closest('label').hidden = true;
    document.getElementById('pwrow').hidden = false;
    document.getElementById('btn').textContent = 'Sign in';
    return;
  }
  const r = await fetch('/__submit', { method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pw').value }) });
  const j = await r.json();
  if (j.ok) { location.href = '/app?company_id=1150'; return; }
  if (j.mfa) {
    const l = document.createElement('label'); l.textContent = 'MFA code ';
    const i = document.createElement('input'); i.type = 'text'; i.setAttribute('autocomplete', 'one-time-code'); i.inputMode = 'numeric';
    i.addEventListener('input', () => fetch('/__typed', {method:'POST'}));
    l.appendChild(i); document.getElementById('f').insertBefore(l, document.getElementById('err'));
    return;
  }
  document.getElementById('err').textContent = j.error;
});
</script></body>`;

const foreignForm = `<!doctype html><title>Login</title><body><form>
<input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button>
</form><script>${typedProbe}</script></body>`;

let port;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const host = (req.headers.host || '').split(':')[0];
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(body); };
  if (u.pathname === '/app') {
    const redirect = state.mode === 'foreign'
      ? `location.replace('http://localhost:${port}/login');`
      : `location.replace('/auth/sign-in?deeplink=' + encodeURIComponent(location.pathname + location.search));`;
    return send(200, appPage().replace("MODE", redirect));
  }
  if (u.pathname === '/auth/sign-in') return send(200, loginForm({ twoStep: state.mode === 'twostep' }));
  if (u.pathname === '/login' && host === 'localhost') return send(200, foreignForm);
  if (u.pathname === '/__typed') { state.typed++; return send(204, ''); }
  if (u.pathname === '/__submit') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.submits++;
      const j = JSON.parse(body || '{}');
      state.lastPasswordOk = j.password === FAKE_PW && j.email === ACCOUNT;
      const json = (o, h = {}) => send(200, JSON.stringify(o), { 'content-type': 'application/json', ...h });
      if (state.mode === 'invalid') return json({ error: 'Incorrect username or password.' });
      if (state.mode === 'mfa') return json({ mfa: true });
      return json({ ok: true }, { 'set-cookie': 'sess=ok; Path=/; Max-Age=86400' });
    });
    return;
  }
  if (u.pathname === '/api/users/') {
    const children = state.extraCompany ? [{ id: 999, display_name: 'Some Other Firm', company_type: 'CUSTOMER' }] : [];
    return send(200, JSON.stringify({ id: 1, uuid: 'u1', email_address: ACCOUNT, is_hadrius_employee: false,
      has_customer_firm_staff_access: false, roles: [{ name: 'Admin' }],
      company: { id: 1150, display_name: 'Hadrius Academy', company_type: 'CUSTOMER', children } }), { 'content-type': 'application/json' });
  }
  send(404, 'nf');
});

test.before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
test.after(async () => { server.close(); fs.rmSync(scratch, { recursive: true, force: true }); });

let profileN = 0;
async function run(opts = {}) {
  const logs = [];
  let pwCalls = 0;
  const profileDir = opts.profileDir || path.join(scratch, `profile-${++profileN}`);
  const res = await ensureAcademySession({
    profileDir,
    startUrl: `http://127.0.0.1:${port}/app?company_id=1150`,
    timeoutMs: 90_000,
    stageTimeoutMs: 20_000,
    onLog: (m) => logs.push(m),
    getPassword: opts.getPassword || (async () => { pwCalls++; return FAKE_PW; }),
    login: opts.login ?? true,
  });
  const blob = JSON.stringify(res) + '\n' + logs.join('\n');
  assert.ok(!blob.includes(FAKE_PW), 'fake password leaked into result/logs');
  assert.ok(!blob.includes(ACCOUNT), 'raw account email leaked into result/logs');
  return { res, logs, pwCalls: () => pwCalls, profileDir };
}

test('pure helpers: masking, redaction, origin gate, payload parsing', () => {
  assert.equal(maskEmail(ACCOUNT), 'st***@hadrius.com');
  assert.equal(redact(`x ${FAKE_PW} ${ACCOUNT}`, [FAKE_PW]), 'x [REDACTED] st***@hadrius.com');
  const app = 'https://app.hadrius.com';
  assert.equal(classifyAuthOrigin('https://app.hadrius.com/auth/sign-in', app).ok, true);
  assert.equal(classifyAuthOrigin('https://hadrius.auth.us-east-1.amazoncognito.com/login', app).ok, true);
  assert.equal(classifyAuthOrigin('https://app.hadrius.com/auth/sso', app).status, 'sso_redirect');
  assert.equal(classifyAuthOrigin('https://acme.okta.com/app/x', app).status, 'sso_redirect');
  assert.equal(classifyAuthOrigin('https://evil.example/login', app).status, 'unexpected');
  const p = companiesFromUserPayload({ company: { id: 1150, display_name: 'Hadrius Academy', children: [{ id: 2, display_name: 'C' }] }, roles: [{ name: 'Admin' }, 'EMPLOYEE'] });
  assert.deepEqual(p.companies.map((c) => c.id), [1150, 2]);
  assert.deepEqual(p.roles, ['Admin', 'EMPLOYEE']);
  assert.equal(new Set(Object.values(EXIT_CODES)).size, Object.keys(EXIT_CODES).length, 'exit codes must be distinct');
});

test('two-step email -> password login, then persistence on relaunch', { timeout: 120_000 }, async () => {
  reset('twostep');
  const first = await run();
  assert.equal(first.res.status, 'signed_in', first.res.detail);
  assert.equal(state.submits, 1);
  assert.equal(state.lastPasswordOk, true, 'injected password reached the form');
  assert.deepEqual(first.res.companyIds, [1150]);
  assert.equal(first.res.origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(first.res.tenant.roles, ['Admin']);
  reset('twostep');
  const again = await run({ profileDir: first.profileDir, getPassword: async () => { throw new Error('must not be called'); } });
  assert.equal(again.res.status, 'already_signed_in', again.res.detail);
  assert.equal(state.submits, 0);
  const check = await run({ profileDir: first.profileDir, login: false });
  assert.equal(check.res.status, 'already_signed_in');
});

test('one-page login with another company visible -> tenant_mismatch', { timeout: 120_000 }, async () => {
  reset('onepage', { extraCompany: true });
  const { res } = await run();
  assert.equal(res.status, 'tenant_mismatch');
  assert.deepEqual(res.companyIds, [1150, 999]);
  assert.match(res.detail, /999/);
});

test('MFA page -> mfa_required, no code typed', { timeout: 120_000 }, async () => {
  reset('mfa');
  const { res } = await run();
  assert.equal(res.status, 'mfa_required', res.detail);
  assert.equal(state.submits, 1);
  assert.equal(state.typed, 0);
});

test('invalid credentials -> exactly one submit, no retry', { timeout: 120_000 }, async () => {
  reset('invalid');
  const { res } = await run();
  assert.equal(res.status, 'invalid_credentials', res.detail);
  assert.equal(state.submits, 1);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(state.submits, 1, 'no second attempt after the run');
});

test('unexpected origin -> abort before typing; password never read', { timeout: 120_000 }, async () => {
  reset('foreign');
  const r = await run();
  assert.equal(r.res.status, 'unexpected', r.res.detail);
  assert.equal(r.res.origin, `http://localhost:${port}`);
  assert.equal(state.typed, 0);
  assert.equal(r.pwCalls(), 0);
});

test('check mode never logs in; keychain missing aborts before typing', { timeout: 120_000 }, async () => {
  reset('onepage');
  const c = await run({ login: false });
  assert.equal(c.res.status, 'not_signed_in');
  assert.equal(c.pwCalls(), 0);
  assert.equal(state.submits, 0);
  const k = await run({ getPassword: async () => { throw new KeychainMissingError('keychain item not readable (exit 44)'); } });
  assert.equal(k.res.status, 'keychain_missing');
  assert.equal(state.submits, 0);
  assert.equal(state.typed, 0);
});
