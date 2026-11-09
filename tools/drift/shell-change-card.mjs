// One Slack card for an app-wide UI change that the per-video weekly check cannot attribute to a code release
// (company-level flag rollouts such as the new Inbox sidebar). Read-only on the app; posts one message + thread.
//   node --env-file=.env tools/drift/shell-change-card.mjs --list <sidebar-by-video.json> [--image <png>] [--post]
// Without --post it prints the message (dry run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlackClient } from './slack.mjs';
import { DRIFT_CHANNEL } from './jobs.mjs';
import { readRetired } from './tenants.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const per = JSON.parse(fs.readFileSync(get('--list'), 'utf8'));
const retired = new Map(readRetired().map((r) => [r.name, r]));
const script = (n) => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', `${n}.script.json`), 'utf8')); } catch { return null; } };
const norm = (m) => (m ? m.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/People Oversight/i, 'People oversight').replace(/Testing Program/i, 'Testing program') : 'Unlabeled');

const groups = { academyOld: [], academyCheck: [], academyNew: [], sandboxOld: [] };
for (const [name, v] of Object.entries(per)) {
  if (retired.has(name)) continue;
  const s = script(name); const row = { name, title: s?.title || name, module: norm(s?.module), pylon: s?.pylonArticleUrl || null };
  if (v.tenant === 'sandbox') groups.sandboxOld.push(row); // every Sandbox recording predates Sandbox's new sidebar
  else if (v.sidebar === 'classic') groups.academyOld.push(row);
  else if (v.sidebar === 'new') groups.academyNew.push(row);
  else groups.academyCheck.push(row);
}
const byModule = (rows) => {
  const m = new Map(); for (const r of rows.sort((x, y) => x.module.localeCompare(y.module) || x.title.localeCompare(y.title))) { if (!m.has(r.module)) m.set(r.module, []); m.get(r.module).push(r); }
  return m;
};
const summarize = (rows) => [...byModule(rows)].map(([m, rs]) => `${m} ${rs.length}`).join(' · ');
const old = groups.academyOld.length + groups.sandboxOld.length;
const ret = [...retired.values()];

const text = `🧭 App-wide UI change: the new Inbox sidebar. ${old} KB videos still show the old sidebar.`;
const blocks = [
  { type: 'header', text: { type: 'plain_text', text: '🧭 App-wide change: new Inbox sidebar', emoji: true } },
  { type: 'section', text: { type: 'mrkdwn', text: '*What changed:* the left sidebar now starts with *Ask Hadrius → Inbox*, groups the modules under *PROGRAM*, and moves Overview, People directory, Vendors, Documents and Templates into a *SYSTEM* group at the bottom. It is now on in both *Hadrius Academy (1150)* and *Hadrius Sandbox (1048)*.\n*Why one card:* the weekly check posts per-video cards only for changes it can tie to a code release. The sidebar is switched on per company, so every video shows it but none of them could be flagged individually. This card covers all of them.' } },
  { type: 'section', text: { type: 'mrkdwn', text: `*${old} videos show the old sidebar and need re-recording*\n• *Academy: ${groups.academyOld.length}* (${summarize(groups.academyOld)})\n• *Sandbox: ${groups.sandboxOld.length}* (every Sandbox video; all were recorded before Sandbox got the new sidebar)\n*${groups.academyCheck.length} Academy videos to check:* the sidebar is scrolled or collapsed in the recording, so it could not be read.\n*${groups.academyNew.length} Academy videos already show the new sidebar* (incl. ${groups.academyNew.filter((r) => /Marketing/i.test(r.module)).length} of the Marketing videos re-recorded Nov 6).${ret.length ? `\n*Retired (not re-recorded):* ${ret.map((r) => `\`${r.name}\`${r.replacedBy ? ` → duplicate of \`${r.replacedBy}\`` : ''}`).join(', ')}` : ''}` } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Full lists by module are in the thread 🧵. Read from each recording’s own frames (sidebar text), not from recording dates. Nothing changes automatically; no approval needed on this card.' }] },
];
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRows = [['status', 'tenant', 'module', 'title', 'video', 'pylon_article']];
for (const [status, tenant, rows] of [['old sidebar: re-record', 'Academy', groups.academyOld], ['old sidebar: re-record', 'Sandbox', groups.sandboxOld],
  ['to check: sidebar not visible in recording', 'Academy', groups.academyCheck], ['already new sidebar', 'Academy', groups.academyNew]])
  for (const r of [...rows].sort((x, y) => x.module.localeCompare(y.module) || x.title.localeCompare(y.title))) csvRows.push([status, tenant, r.module, r.title, r.name, r.pylon || '']);
for (const r of ret) csvRows.push(['retired (duplicate)', '', '', r.name, r.name, r.replacedBy ? `replaced by ${r.replacedBy}` : '']);
const csv = csvRows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const lists = [`*Full list attached as CSV* (${csvRows.length - 1} rows: status, tenant, module, title, Pylon link).\n\n*Academy: to check (${groups.academyCheck.length})*, sidebar scrolled or collapsed in the recording:\n`
  + groups.academyCheck.map((r) => `• ${r.pylon ? `<${r.pylon}|${r.title}>` : r.title} (${r.module})`).join('\n')];

if (!a.includes('--post')) {
  console.log(JSON.stringify({ text, counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), retired: ret.map((r) => r.name), threadMessages: lists.length }, null, 1));
  console.log(blocks.map((b) => b.text?.text || b.elements?.[0]?.text).join('\n---\n'));
  console.log('--- thread message ---\n' + lists[0]); console.log('--- csv head ---\n' + csv.split('\n').slice(0, 4).join('\n') + `\n(${csvRows.length - 1} rows)`);
  process.exit(0);
}
const token = process.env.SLACK_STUDIO_BOT_TOKEN;
if (!token) { console.log(JSON.stringify({ ok: false, error: 'SLACK_STUDIO_BOT_TOKEN missing' })); process.exit(2); }
const slack = createSlackClient({ getToken: () => token });
const top = await slack.call('chat.postMessage', { channel: DRIFT_CHANNEL, text, blocks, unfurl_links: false, unfurl_media: false });
const ts = top.ts;
const image = get('--image');
let uploaded = null;
if (image) {
  try {
    uploaded = await slack.uploadFiles({ channel: DRIFT_CHANNEL, threadTs: ts, initialComment: '*Before / now:* the same Academy page as recorded (Oct 6) and on Nov 8.', files: [{ bytes: fs.readFileSync(image), filename: 'sidebar-before-now.png', title: 'Sidebar: before / now' }] });
  } catch (e) { uploaded = { error: String(e?.message || e) }; }
}
let csvUpload = null;
try { csvUpload = await slack.uploadFiles({ channel: DRIFT_CHANNEL, threadTs: ts, initialComment: null, files: [{ bytes: Buffer.from(csv, 'utf8'), filename: 'new-sidebar-video-list.csv', title: 'New sidebar: every KB video and its status' }] }); }
catch (e) { csvUpload = { error: String(e?.message || e) }; }
for (const t of lists) await slack.call('chat.postMessage', { channel: DRIFT_CHANNEL, thread_ts: ts, text: t, unfurl_links: false, unfurl_media: false });
console.log(JSON.stringify({ ok: true, channel: DRIFT_CHANNEL, ts, threadMessages: lists.length, image: uploaded ? (uploaded.error ? uploaded : 'uploaded') : 'none', csv: csvUpload?.error ? csvUpload : 'uploaded', csvRows: csvRows.length - 1 }));
