// CRIT-20 regression: the run-long CDP connection must not divert the operator's downloads.
// A stand-in "operator" Chromium (throwaway profile, mock keychain) against a local server only: every hostname except
// 127.0.0.1 is unresolvable inside it, so the borrow attempt can never reach the live app. Downloads are started the
// way the operator would (a new tab via Chrome's own /json/new endpoint), not through Playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { borrowOwnerSession, releaseOwnerConnection, clearOwnerSessionCache } from '../../tools/drift/owner-session.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; }

async function startOperatorChrome() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/confirm')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end("<title>pending</title><script>setTimeout(() => { document.title = 'answered:' + confirm('Leave?'); }, 300)</script>"); }
    const n = new URL(req.url, 'http://x').searchParams.get('n') || 'x';
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${n}.txt"` });
    res.end(`file ${n}\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-chrome-'));
  const profile = path.join(root, 'profile'); const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads } }));
  const proc = spawn(chromium.executablePath(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain',
    '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  assert.ok(await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n')), 'operator Chromium started');
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const download = async (n) => {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/f?n=${n}`)}`, { method: 'PUT' });
    assert.ok(r.ok, `operator tab opened for ${n}`);
    return waitFor(() => fs.existsSync(path.join(downloads, `${n}.txt`)));
  };
  const openConfirm = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/confirm`)}`, { method: 'PUT' });
    return (await r.json()).id;
  };
  const titleOf = async (id) => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.id === id)?.title;
  const stop = async () => { proc.kill('SIGKILL'); server.close(); await sleep(300); fs.rmSync(root, { recursive: true, force: true }); };
  return { endpoint: `ws://127.0.0.1:${port}${wsPath}`, port, wsPath, download, openConfirm, titleOf, stop };
}

test('CRIT-20: operator downloads still land in their Downloads folder while (and after) drift holds the CDP connection', { timeout: 120000 }, async () => {
  clearOwnerSessionCache();
  const op = await startOperatorChrome();
  try {
    assert.equal(await op.download('before'), true, 'control: download before any connection');
    // The borrow itself fails here (the app host is unresolvable inside the stand-in); the connection stays held,
    // exactly as during a run between borrows.
    await assert.rejects(borrowOwnerSession({ tenant: 'academy', chromium, source: 'chrome', endpoint: op.endpoint, waitMs: 0, useCache: false }));
    assert.equal(await op.download('during'), true, 'download while the connection is held reaches the operator folder');
    await releaseOwnerConnection();
    assert.equal(await op.download('after'), true, 'download after release reaches the operator folder');
  } finally { await releaseOwnerConnection(); clearOwnerSessionCache(); await op.stop(); }
});

test('CRIT-20: a dialog in an operator tab is left for the operator while drift holds the CDP connection', { timeout: 120000 }, async () => {
  clearOwnerSessionCache();
  const op = await startOperatorChrome();
  try {
    await assert.rejects(borrowOwnerSession({ tenant: 'academy', chromium, source: 'chrome', endpoint: op.endpoint, waitMs: 0, useCache: false }));
    const id = await op.openConfirm();
    await sleep(3000);
    assert.equal(await op.titleOf(id), 'pending', 'confirm() still open: not auto-answered by Playwright');
  } finally { await releaseOwnerConnection(); clearOwnerSessionCache(); await op.stop(); }
});

// CRIT-17: `--resume` of an owner run without `--session` gets owner mode from summary.json inside runWeekly; the
// CLI must still release the shared connection, or the open socket keeps Node alive forever.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
test('CRIT-17: a resumed owner run (no --session) releases the CDP connection and the process exits', { timeout: 180000 }, async () => {
  const op = await startOperatorChrome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-home-'));
  const run = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-resume-')), 'run');
  let child;
  try {
    // The subprocess finds "Chrome" through a DevToolsActivePort under a throwaway HOME: the stand-in, never the real one.
    const portDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    fs.mkdirSync(portDir, { recursive: true }); fs.writeFileSync(path.join(portDir, 'DevToolsActivePort'), `${op.port}\n${op.wsPath}\n`);
    const name = 'How-to-archive-a-policy';
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ schema: 1, startedAt: new Date().toISOString(), outDir: run, dryRun: false, names: [name], captureSession: 'owner', videos: [] }));
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), DRIFT_OWNER_SOURCE: 'chrome',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') };
    child = spawn(process.execPath, [path.join(REPO, 'tools/drift/weekly.mjs'), '--once', '--names', name, '--resume', run, '--no-judge', '--no-auto-repair', '--timeout-min', '3'],
      { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const exited = await new Promise((r) => { const t = setTimeout(() => r(false), 120000); child.on('exit', () => { clearTimeout(t); r(true); }); });
    assert.equal(exited, true, `weekly.mjs did not exit (held CDP socket?)\n${err.slice(-1500)}`);
    const summary = JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'));
    assert.equal(summary.captureSession, 'owner', 'resume kept owner mode from summary.json');
    assert.match(err, /owner session warm-up/, 'the run did open the Chrome connection (warm-up borrow attempted)');
  } finally { if (child && child.exitCode === null) child.kill('SIGKILL'); await op.stop(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(run), { recursive: true, force: true }); }
});
