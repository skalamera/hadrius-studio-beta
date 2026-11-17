// A confirmation toast is gone in 4-7 seconds, often before the recorder's model has answered: the recorder watches
// for toasts and keeps a frame of each, so a take can close on the confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installToastWatcher } from '../tools/ai-record.mjs';

test('every toast the app shows is reported once, on every page; other elements are not', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const seen = [];
  await installToastWatcher(ctx, () => seen.push(Date.now()));
  const page = await ctx.newPage();
  const html = `<body><script>
    const add = (attrs, ms) => setTimeout(() => { const d = document.createElement('div'); for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v); d.textContent = 'x'; document.body.appendChild(d); }, ms);
    add({ 'data-toast-id': '0' }, 100);
    add({ role: 'status' }, 150);
    add({ 'data-toast-id': '1' }, 250);
    setTimeout(() => { const el = document.querySelector('[data-toast-id="0"]'); el.textContent = 'changed'; }, 300);
  </script></body>`;
  await page.goto('data:text/html,' + encodeURIComponent(html));
  await page.waitForTimeout(700);
  assert.equal(seen.length, 2, 'two toasts, each once; a spinner\'s role=status is not a toast');
  await page.goto('data:text/html,' + encodeURIComponent('<body><script>setTimeout(() => { const o = document.createElement("ol"); o.setAttribute("data-radix-toast-viewport", ""); const li = document.createElement("li"); o.appendChild(li); document.body.appendChild(o); }, 100);</script></body>'));
  await page.waitForTimeout(500);
  assert.equal(seen.length, 3, 'the watcher is installed on the next page too (Radix toast)');
});
