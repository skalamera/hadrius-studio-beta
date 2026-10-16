// "To Record" source of truth: the Hadrius Academy curriculum sheet. Each module has its own tab;
// a lesson is done once its link column holds a URL (Video Link, or Updated Link on Marketing
// Review). Read live through the bridge's Drive OAuth token and cached briefly.
import { googleSheetCsv, googleSheetsApi } from './gdrive.mjs';

export const ACADEMY_SHEET_ID = '1Ppm4aOi6lyo0tCwm2Ay1_QCb2xGFvIuJ1KDlgFWnyxU';
export const ACADEMY_SHEET_URL = `https://docs.google.com/spreadsheets/d/${ACADEMY_SHEET_ID}/edit`;

// tab -> app module name (the names ALLOWED_MODULES / the panel use), gid, and the done column.
// altLinkColumns: other columns that also count as "has a video" (Employee Training keeps
// re-recorded links in "Updated Link"); write-back always goes to linkColumn.
// Onboarding is a cross-module checklist: its titles live in "Video Name", it gets no auto-record
// plans (noPlans: its lessons span modules), and render write-back skips it (noWriteBack) so a
// video still lands on its module tab instead of turning "ambiguous".
export const ACADEMY_TABS = [
  { tab: 'Onboarding', module: 'Onboarding', gid: 1973820092, linkColumn: 'Google Drive Video Link', titleColumn: 'Video Name', noPlans: true, noWriteBack: true },
  { tab: 'Testing Program', module: 'Testing program', gid: 2104426564, linkColumn: 'Video Link' },
  { tab: 'People Oversight', module: 'People oversight', gid: 1441169249, linkColumn: 'Video Link' },
  { tab: 'Branches', module: 'Branches', gid: 1519759355, linkColumn: 'Video Link' },
  { tab: 'Communications', module: 'Communications', gid: 541970526, linkColumn: 'Video Link' },
  { tab: 'Marketing Review', module: 'Marketing', gid: 1427227117, linkColumn: 'Updated Link' },
  { tab: 'Account Surveillance', module: 'Account surveillance', gid: 569087505, linkColumn: 'Video Link' },
  { tab: 'Platform', module: 'Platform', gid: 1472628520, linkColumn: 'Video Link' },
  { tab: 'Employee Training', module: 'Employee Training', gid: 1658258787, linkColumn: 'Video Link', altLinkColumns: ['Updated Link'] },
];

/** RFC 4180 CSV -> rows (handles quoted commas, doubled quotes and newlines inside quotes). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Lessons of one tab: [{ title, level, link|null, note }] (note = non-URL text like "On Hold"). */
export function lessonsFromCsv(text, linkColumn, altLinkColumns = [], titleColumn = 'Lesson Title') {
  const rows = parseCsv(text);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const ti = header.indexOf(titleColumn.toLowerCase());
  const li = header.indexOf(linkColumn.toLowerCase());
  if (ti < 0 || li < 0) throw new Error(`missing "${titleColumn}" or "${linkColumn}" column`);
  const alt = altLinkColumns.map((c) => header.indexOf(c.toLowerCase())).filter((i) => i >= 0);
  const out = [];
  for (const r of rows.slice(1)) {
    const title = (r[ti] || '').trim();
    if (!title) continue; // section header rows (GETTING STARTED, …)
    if (/^(n\/?a|none|-)$/i.test(title)) continue; // placeholder rows ("N/A", note "no vid") aren't lessons
    const raw = (r[li] || '').trim();
    // A cell can hold a note plus the link ("done\n\nhttps://…"), so take the first URL anywhere in it.
    const urlIn = (v) => (String(v || '').match(/https?:\/\/\S+/i) || [null])[0];
    const altUrl = alt.map((i) => urlIn(r[i])).find(Boolean);
    const url = urlIn(raw);
    const note = !url && raw && !/^add link here$/i.test(raw) ? raw : '';
    // "done" with no link = handled outside video (the user's call): not a lesson to count either way.
    if (!url && !altUrl && /^done\b/i.test(note)) continue;
    out.push({ title, level: (r[0] || '').trim(), link: url || altUrl || null, note: url || altUrl ? '' : note });
  }
  return out;
}

let cache = { at: 0, data: null };
export async function getAcademyLessons({ fresh = false, maxAgeMs = 5 * 60000 } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < maxAgeMs) return cache.data;
  const modules = [];
  // Sequential on purpose: parallel exports of 6 tabs trip Google's 429 rate limit. Even sequential
  // reads of 9 tabs can 429 after a few refreshes, so back off and retry before giving up.
  const csvWithRetry = async (gid) => {
    for (let attempt = 0; ; attempt++) {
      try { return await googleSheetCsv(ACADEMY_SHEET_ID, gid); }
      catch (e) { if (attempt >= 3 || !/429/.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); }
    }
  };
  for (const t of ACADEMY_TABS) {
    const lessons = lessonsFromCsv(await csvWithRetry(t.gid), t.linkColumn, t.altLinkColumns, t.titleColumn);
    const done = lessons.filter((l) => l.link).length;
    modules.push({ module: t.module, tab: t.tab, linkColumn: t.linkColumn, noPlans: !!t.noPlans, total: lessons.length, done, remaining: lessons.length - done, lessons });
  }
  // Headline numbers count unique lessons: the same lesson often sits on its module tab AND on
  // Onboarding / Employee Training, sometimes under a different title. Rows that link the same
  // video file, or share a normalized title, are one lesson (union-find over both keys). A lesson
  // is done if any of its rows has a link.
  const rows = modules.flatMap((m) => m.lessons);
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByKey = new Map();
  rows.forEach((l, i) => {
    for (const key of [l.link && fileIdOf(l.link), `t:${normLesson(l.title)}`].filter(Boolean)) {
      if (firstByKey.has(key)) parent[find(i)] = find(firstByKey.get(key)); else firstByKey.set(key, i);
    }
  });
  const groupDone = new Map();
  rows.forEach((l, i) => { const r = find(i); groupDone.set(r, (groupDone.get(r) || false) || !!l.link); });
  const total = groupDone.size;
  const done = [...groupDone.values()].filter(Boolean).length;
  const rowTotal = modules.reduce((n, m) => n + m.total, 0);
  const rowDone = modules.reduce((n, m) => n + m.done, 0);
  cache = { at: Date.now(), data: { sheetUrl: ACADEMY_SHEET_URL, fetchedAt: new Date().toISOString(), total, done, remaining: total - done, rowTotal, rowDone, modules } };
  return cache.data;
}

// A Drive/Pylon link's stable id (Drive file id or Pylon article uuid), so two rows linking the
// same video count as one lesson even when their share URLs differ (?usp=sharing vs drivesdk).
function fileIdOf(url) {
  const m = String(url).match(/\/d\/([-\w]{20,})/) || String(url).match(/[?&]id=([-\w]{20,})/) || String(url).match(/articles\/([0-9a-f-]{36})/);
  return m ? `f:${m[1]}` : `u:${String(url).split('?')[0]}`;
}

const normLesson = (s) => String(s || '').toLowerCase().replace(/^how[\s-]+to[\s-]+/, '').replace(/[^a-z0-9]+/g, '');
const colLetter = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/**
 * After a render's Drive upload: put the video's share link into the lesson's link column (Video
 * Link, or Updated Link on Marketing Review). Looks in the video's module tab first, then every
 * tab, and needs exactly one lesson whose title matches. Never overwrites a different link
 * already in the cell. Returns { status: 'written'|'already'|'conflict'|'no-match'|'ambiguous', ... }.
 */
export async function recordAcademyVideoLink({ title, module, url }) {
  const key = normLesson(title);
  if (!key || !url) return { status: 'no-match' };
  const mod = String(module || '').trim().toLowerCase();
  const ordered = ACADEMY_TABS.filter((t) => !t.noWriteBack).sort((a, b) => (b.module.toLowerCase() === mod) - (a.module.toLowerCase() === mod));
  const hits = [];
  for (const [i, t] of ordered.entries()) {
    const range = encodeURIComponent(`'${t.tab}'!A1:Z400`);
    const { values = [] } = await googleSheetsApi(`${ACADEMY_SHEET_ID}/values/${range}`);
    const header = (values[0] || []).map((h) => String(h).trim().toLowerCase());
    const ti = header.indexOf('lesson title'), li = header.indexOf(t.linkColumn.toLowerCase());
    if (ti < 0 || li < 0) continue;
    const alt = (t.altLinkColumns || []).map((c) => header.indexOf(c.toLowerCase())).filter((i) => i >= 0);
    values.forEach((row, r) => {
      if (r > 0 && normLesson(row[ti]) === key) {
        // A link already in an alternate column counts as the lesson's video.
        const altUrl = alt.map((i) => String(row[i] || '').trim()).find((v) => /^https?:\/\//i.test(v));
        hits.push({ t, row: r + 1, li, current: altUrl || String(row[li] || '').trim(), lesson: row[ti] });
      }
    });
    if (i === 0 && hits.length) break; // found in the video's own module tab
  }
  if (!hits.length) return { status: 'no-match' };
  if (hits.length > 1) return { status: 'ambiguous', where: hits.map((h) => `${h.t.tab} row ${h.row}`) };
  const h = hits[0];
  const cell = `'${h.t.tab}'!${colLetter(h.li)}${h.row}`;
  const sameFile = (a, b) => (a.match(/[-\w]{25,}/) || [a])[0] === (b.match(/[-\w]{25,}/) || [b])[0];
  if (/^https?:\/\//i.test(h.current)) {
    return sameFile(h.current, url) ? { status: 'already', cell } : { status: 'conflict', cell, current: h.current };
  }
  await googleSheetsApi(`${ACADEMY_SHEET_ID}/values/${encodeURIComponent(cell)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: [[url]] } });
  cache = { at: 0, data: null }; // next /academy-lessons read shows it as done
  return { status: 'written', cell, lesson: h.lesson };
}
