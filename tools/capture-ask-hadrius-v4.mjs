// One-off capture v4: Overview filtered to Hadrius (no client names), zoom on the Ask Hadrius drawer,
// typewriter questions, and scroll through the saved answers from the approved cut.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('out/Ask-Hadrius-AI-Walkthrough');
const FR = path.join(OUT, '_frames');
fs.rmSync(FR, { recursive: true, force: true });
fs.mkdirSync(FR, { recursive: true });

const FULL = [0, 0, 1600, 900];
const ZW = 1000, ZH = 562.5; // 1.6x zoom
const Z_TOP = [1600 - ZW, 0, ZW, ZH];
const Z_BOT = [1600 - ZW, 900 - ZH, ZW, ZH];
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const QS = [
  ['What compliance items currently require immediate attention across the firm?', '06:41 PM'],
  ['Which employees have pending disclosures awaiting review, and what types of disclosures are they?', '06:42 PM'],
  ['Summarize our active and overdue compliance certification campaigns and what needs review.', '06:43 PM'],
];
const CLIENTS = JSON.parse(fs.readFileSync('/Users/stephenskalamera/.hermes/cache/scratch/probe_v4d/companies_all.json', 'utf8'))
  .filter((c) => !/hadrius/i.test(c));

const ctx = await chromium.launchPersistentContext('/tmp/chrome_test_root_frames', {
  headless: true, viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

let n = 0; const clips = []; let clip;
const scroller = 'aside .h-shell-scrollbars';
const park = () => page.mouse.move(560, 30);
async function snap() {
  const file = path.join(FR, `${String(n++).padStart(5, '0')}.jpg`);
  await page.evaluate(() => document.querySelectorAll('aside button').forEach((b) => {
    if (/^\s*latest\s*$/i.test(b.innerText)) b.style.visibility = 'hidden';
  }));
  await page.screenshot({ path: file, type: 'jpeg', quality: 92, animations: 'disabled' });
  return file;
}
const push = (file, crop, frames = 1) => clip.entries.push({ file, crop, frames });
const start = (name) => { clip = { name, entries: [] }; clips.push(clip); };
async function noClients(label) {
  const txt = await page.evaluate(() => document.body.innerText);
  const hits = CLIENTS.filter((c) => txt.includes(c));
  if (hits.length) throw new Error(`client names on screen at ${label}: ${hits.join(', ')}`);
  console.log(`[ok] no client names: ${label}`);
}

await page.goto('https://staging.hadrius.com/overview', { waitUntil: 'networkidle' });
const head = await page.evaluate(() => document.body.innerText.slice(0, 300));
if (!/Hadrius Sandbox/.test(head) || !/Stephen Skalamera/.test(head)) throw new Error(`wrong org/user: ${head}`);
await page.locator('input[placeholder="Search companies"]').fill('Hadrius');
await page.waitForFunction(() => {
  const t = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
  const names = []; t.forEach((l, k) => { if (/^\d+ total action items$/i.test(l)) names.push(t[k - 1]); });
  return names.length >= 2 && names.every((x) => /hadrius/i.test(x));
});
await page.waitForTimeout(1500);
await park();
await noClients('overview');
await page.screenshot({ path: path.join(OUT, 'slides', 'slide_01.png'), animations: 'disabled' });
const ask = await page.getByRole('button', { name: /ask hadrius/i }).first().boundingBox();

await page.getByRole('button', { name: /ask hadrius/i }).first().click();
await page.waitForTimeout(1200);
const sep = await page.locator('[role="separator"]').first().boundingBox();
await page.mouse.move(sep.x + sep.width / 2, 450); await page.mouse.down();
await page.mouse.move(sep.x + sep.width / 2 - 600, 450, { steps: 20 }); await page.mouse.up();
await park(); await page.waitForTimeout(600);
console.log('drawer width', (await page.locator('aside').first().boundingBox()).width);

async function newChat() {
  await page.locator('aside button[aria-label="New chat"]').click();
  await park();
  await page.waitForFunction((sel) => {
    const t = (document.querySelector(sel)?.innerText || '').trim();
    return t.startsWith('Ask Hadrius') && t.length < 120;
  }, scroller);
  await page.waitForTimeout(900);
}

async function typing(name, q, zoomIn) {
  start(name);
  await newChat();
  let f = await snap();
  if (zoomIn) { push(f, FULL, 24); for (let i = 1; i <= 36; i++) push(f, lerp(FULL, Z_BOT, ease(i / 36))); }
  else push(f, Z_BOT, 15);
  await page.locator('aside textarea').first().click(); await park();
  const total = Math.round(4.2 * 30); let prev = 0;
  for (let i = 0; i < q.length; i++) {
    await page.keyboard.type(q[i]);
    f = await snap();
    const end = Math.max(prev + 1, Math.round(((i + 1) * total) / q.length));
    push(f, Z_BOT, end - prev); prev = end;
  }
  push(f, Z_BOT, 18);
  const typed = await page.locator('aside textarea').first().inputValue();
  if (typed !== q) throw new Error(`typed text mismatch: ${typed}`);
  await page.locator('aside textarea').first().fill('');
  console.log(`${name}: typed ${q.length} chars`);
}

async function answer(name, q, time) {
  start(name);
  await page.locator('aside button[aria-label="Conversations"]').click();
  await page.waitForTimeout(1000);
  await page.locator('aside').getByText(`Sep 28, 2026 · ${time}`, { exact: true }).first().click();
  await park();
  await page.waitForFunction(([sel, qq]) => {
    const t = document.querySelector(sel)?.innerText || '';
    return t.includes(qq) && /Key Observations/.test(t);
  }, [scroller, q]);
  await page.waitForTimeout(1200);
  const max = await page.evaluate((sel) => {
    const el = document.querySelector(sel); el.style.scrollBehavior = 'auto'; el.scrollTop = 0;
    return el.scrollHeight - el.clientHeight;
  }, scroller);
  await page.waitForTimeout(300);
  await noClients(name);
  let f = await snap();
  push(f, Z_TOP, 36);
  const N = Math.round(Math.min(7.5, Math.max(5, 4.5 + max / 600)) * 30);
  for (let i = 1; i <= N; i++) {
    const e = ease(i / N);
    await page.evaluate(([sel, top]) => { document.querySelector(sel).scrollTop = top; }, [scroller, e * max]);
    f = await snap();
    push(f, lerp(Z_TOP, Z_BOT, e));
  }
  push(f, Z_BOT, 15);
  console.log(`${name}: scrolled ${max}px over ${(N / 30).toFixed(1)}s`);
  return f;
}

let last;
for (let k = 0; k < 3; k++) {
  await typing(`slide_0${2 + 2 * k}`, QS[k][0], k === 0);
  last = await answer(`slide_0${3 + 2 * k}`, QS[k][0], QS[k][1]);
}
start('slide_08');
push(last, Z_BOT, 20);
for (let i = 1; i <= 45; i++) push(last, lerp(Z_BOT, FULL, ease(i / 45)));
push(last, FULL, 15);
await noClients('closing');

fs.writeFileSync(path.join(FR, 'manifest.json'), JSON.stringify({
  clips, slide1_target: { x: ask.x * 2, y: ask.y * 2, width: ask.width * 2, height: ask.height * 2 },
}, null, 1));
console.log(`captured ${n} frames across ${clips.length} clips`);
await ctx.close();
