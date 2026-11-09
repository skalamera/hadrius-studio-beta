// Test fixture: a fake Hadrius app for Studio-profile borrow tests. Never touches the live app.
// - HTTPS on 127.0.0.1 with a throwaway self-signed certificate (openssl), serving /seed (stores a fake Cognito
//   sign-in in localStorage), /home (signed in only if that storage is present, then GET /api/users/?uuid=...,
//   else redirect to /auth/sign-in) and /api/users/ (a user who can open 1150 and 1048).
// - wrapChromium(app): Playwright's chromium with app.hadrius.com mapped to the fake server and EVERY other hostname
//   unresolvable; logs each persistent launch/close with timestamps (to prove borrows did not overlap).
// CLI (child processes): node owner-profile-fixture.mjs --borrow <profileDir> <port> -> one JSON line
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.sig`;
const PFX = 'CognitoIdentityServiceProvider.fakeclient';

export async function startFakeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-app-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=app.hadrius.com'], { stdio: 'ignore' });
  const html = (body) => `<!doctype html><title>fake</title><body>${body}</body>`;
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    const u = new URL(req.url, 'https://app.hadrius.com');
    if (u.pathname === '/seed') {
      const exp = Date.now() + 3600e3;
      const entries = { [`${PFX}.LastAuthUser`]: 'user-uuid', [`${PFX}.user-uuid.idToken`]: jwt(exp), [`${PFX}.user-uuid.accessToken`]: jwt(exp), [`${PFX}.user-uuid.refreshToken`]: 'REFRESH' };
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html(`<script>for (const [k, v] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(k, v); document.title = 'seeded';</script>`));
    }
    if (u.pathname === '/home') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html(`<script>const u = localStorage.getItem(${JSON.stringify(`${PFX}.LastAuthUser`)}); if (!u) location.replace('/auth/sign-in'); else fetch('/api/users/?uuid=' + u);</script>`));
    }
    if (u.pathname === '/api/users/') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 1, company: { id: 1150, children: [{ id: 1048 }] } })); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('sign in'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, stop: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export function wrapChromium(port, log = () => {}) {
  const args = [`--host-resolver-rules=MAP app.hadrius.com 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`];
  return {
    launchPersistentContext: async (dir, opts = {}) => {
      const ctx = await chromium.launchPersistentContext(dir, { ...opts, ignoreHTTPSErrors: true, args: [...(opts.args || []), ...args] });
      log({ ev: 'launch', at: Date.now(), pid: process.pid });
      ctx.on('close', () => log({ ev: 'close', at: Date.now(), pid: process.pid }));
      return ctx;
    },
    launch: async (opts = {}) => chromium.launch({ ...opts, args: [...(opts.args || []), ...args] }),
    connectOverCDP: async () => { throw new Error('profile tests never connect to Chrome'); },
  };
}

/** Store the fake sign-in in a fresh profile (as the operator's one-time sign-in would). */
export async function seedProfile(dir, port) {
  const ctx = await wrapChromium(port).launchPersistentContext(dir, { headless: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://app.hadrius.com/seed'); await page.waitForFunction(() => document.title === 'seeded');
  await ctx.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--borrow') {
  const [, , , profileDir, port] = process.argv;
  const events = [];
  const { borrowOwnerSession } = await import('../../tools/drift/owner-session.mjs');
  try {
    const s = await borrowOwnerSession({ tenant: 'academy', source: 'profile', profileDir, chromium: wrapChromium(Number(port), (e) => events.push(e)), waitMs: 1500, useCache: false });
    console.log(JSON.stringify({ ok: true, source: s.source, events }));
  } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, message: String(e.message).slice(0, 200), events })); }
  process.exit(0);
}
