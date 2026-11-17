// Tenant fence of the AI recorder: which requests count as "another company".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { otherCompanyOf, installTenantFence, companySwitcherReason } from '../tools/ai-record.mjs';

test('requests inside the recording company are not a breach', () => {
  for (const url of [
    'https://api.hadrius.com/api/company/1150/announcements/',
    'https://api.hadrius.com/api/company/1150/firm-oversight/policies/88/',
    'https://api.hadrius.com/api/users/',
    'https://api.hadrius.com/api/users/analytics/4431/track-event/',
    'https://app.hadrius.com/overview?company_id=1150',
    'https://app.hadrius.com/marketing/project/1150',
    'https://hadriusapi.com/api/company/1150/library/audience/compute/',
  ]) assert.equal(otherCompanyOf(url, '1150'), null, url);
  assert.equal(otherCompanyOf('https://api.hadrius.com/api/company/1150/x/', 1150), null, 'a numeric company id compares equal');
});

test('a request naming another company is a breach, in the path or the query', () => {
  assert.equal(otherCompanyOf('https://api.hadrius.com/api/company/1048/announcements/', '1150'), '1048');
  assert.equal(otherCompanyOf('https://api.hadrius.com/api/company/5', '1150'), '5');
  assert.equal(otherCompanyOf('https://hadriusapi.com/api/companies/77/users/', '1150'), '77');
  assert.equal(otherCompanyOf('https://app.hadrius.com/overview?company_id=1048', '1150'), '1048');
  assert.equal(otherCompanyOf('https://api.hadrius.com/api/company/1150/x/?company_id=9', '1150'), '9', 'a second company in the query still counts');
  assert.equal(otherCompanyOf('https://api.hadrius.com/api/company/11500/x/', '1150'), '11500', 'a longer id is another company, not a prefix match');
});

test('other hosts and unparseable URLs are ignored', () => {
  assert.equal(otherCompanyOf('https://us.i.posthog.com/flags/?company_id=7', '1150'), null);
  assert.equal(otherCompanyOf('https://nothadrius.com/api/company/7/', '1150'), null);
  assert.equal(otherCompanyOf('https://evilhadrius.com/api/company/7/', '1150'), null);
  assert.equal(otherCompanyOf('data:text/plain,company/7/', '1150'), null);
  assert.equal(otherCompanyOf('not a url', '1150'), null);
  assert.equal(otherCompanyOf('https://app.hadrius.com/overview?company_id=abc', '1150'), null, 'a non-numeric company_id names no company');
});

test('the company switcher is refused before the click: its button, and everything while its list is open', () => {
  const page = [{ id: 1, tag: 'button', role: 'button', name: 'Hadrius Academy 1150' }, { id: 2, tag: 'a', role: 'link', name: 'Policies' }, { id: 3, tag: 'button', role: 'button', name: 'Ask Hadrius' },
    { id: 4, tag: 'tr', role: 'row', name: 'Hadrius Academy Hadrius Academy BD' }, { id: 5, tag: 'button', role: 'button', name: 'Row 1150' }];
  assert.match(companySwitcherReason(page, page[0], '1150'), /^refused — "Hadrius Academy 1150" is the company switcher\. The company switcher is off limits: this recording must stay in company 1150\./);
  assert.match(companySwitcherReason(page, page[0], 1150, 'hover'), /is the company switcher/, 'a numeric company id works too');
  for (const el of [page[1], page[2], page[3]]) assert.equal(companySwitcherReason(page, el, '1150'), null, el.name);
  assert.equal(companySwitcherReason(page, { tag: 'button', role: 'button', name: '1150' }, '1150'), null, 'a bare number is not a company button');
  assert.equal(companySwitcherReason(page, { tag: 'td', role: 'cell', name: 'Hadrius Academy 1150' }, '1150'), null, 'only a button or a dropdown');
  assert.equal(companySwitcherReason(page, { tag: 'button', role: 'button', name: 'Hadrius Academy 11500' }, '1150'), null);
  assert.equal(companySwitcherReason(page, null, '1150', 'press', 'Enter'), null, 'keys are free while the list is closed');
  // Its list is open: a search field for companies is on the page. Nothing goes through but Escape.
  const open = [...page, { id: 6, tag: 'input', role: 'combobox', name: 'Search companies...' }, { id: 7, tag: 'div', role: 'option', name: 'Hadrius Sandbox 1048' }];
  for (const el of [open[5], open[6], open[1]]) assert.match(companySwitcherReason(open, el, '1150', el === open[5] ? 'type' : 'click'), /^refused — the company switcher's list is open\..* Press Escape to close it/, el.name);
  assert.match(companySwitcherReason(open, null, '1150', 'press', 'Enter'), /list is open/, 'Enter would pick the highlighted company');
  assert.match(companySwitcherReason(open, null, '1150', 'press', 'Tab'), /list is open/);
  assert.equal(companySwitcherReason(open, null, '1150', 'press', 'Escape'), null);
  assert.equal(companySwitcherReason([{ tag: 'input', placeholder: 'Search companies…', name: '' }], { name: 'x' }, '1150') === null, false, 'known by its placeholder as well');
  assert.equal(companySwitcherReason(null, null, '1150'), null);
});

test('a request naming another company is blocked before it leaves the browser, and reported once', async (t) => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(req.url === '/' ? '<!doctype html><title>stand-in</title>' : 'ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  let browser;
  // api.hadrius.com is pointed at the local stand-in, so nothing here reaches Hadrius.
  try { browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP api.hadrius.com 127.0.0.1'] }); }
  catch (e) { srv.close(); t.skip(`no browser to test with: ${String(e.message).split('\n')[0]}`); return; }
  try {
    const calls = async (fenced) => {
      seen.length = 0;
      const breaches = [];
      const ctx = await browser.newContext();
      if (fenced) await installTenantFence(ctx, '1150', (m) => breaches.push(m));
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      const results = await page.evaluate(async (p) => {
        const go = (path, init) => fetch(`http://api.hadrius.com:${p}${path}`, init).then((r) => `sent ${r.status}`, () => 'not sent');
        return [await go('/api/company/1150/announcements/'), await go('/api/company/5/items/', { method: 'POST', body: 'x' }), await go('/api/company/5/items/'), await go('/api/users/?company_id=7')];
      }, port);
      await ctx.close();
      return { results, breaches, server: seen.filter((l) => l !== 'GET /' && !l.includes('favicon')) };
    };
    const open = await calls(false);
    assert.deepEqual(open.results, ['sent 200', 'sent 200', 'sent 200', 'sent 200'], 'without the fence the stand-in gets every request');
    assert.equal(open.server.length, 4);
    const fenced = await calls(true);
    assert.deepEqual(fenced.results, ['sent 200', 'not sent', 'not sent', 'not sent']);
    assert.deepEqual(fenced.server, ['GET /api/company/1150/announcements/'], 'the other company never received anything, the write included');
    assert.equal(fenced.breaches.length, 1, 'reported once, for the first of them');
    assert.match(fenced.breaches[0], /^tenant fence: the browser requested company 5 \(POST \/api\/company\/5\/items\/\) while recording in company 1150; the run was stopped$/);
  } finally { await browser.close(); srv.close(); }
});
