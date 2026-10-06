// "To Record" source of truth: the Hadrius Academy curriculum sheet. Each module has its own tab;
// a lesson is done once its link column holds a URL (Video Link, or Updated Link on Marketing
// Review). Read live through the bridge's Drive OAuth token and cached briefly.
import { googleSheetCsv, googleSheetsApi } from './gdrive.mjs';

export const ACADEMY_SHEET_ID = '1Ppm4aOi6lyo0tCwm2Ay1_QCb2xGFvIuJ1KDlgFWnyxU';
export const ACADEMY_SHEET_URL = `https://docs.google.com/spreadsheets/d/${ACADEMY_SHEET_ID}/edit`;

// tab -> app module name (the names ALLOWED_MODULES / the panel use), gid, and the done column.
export const ACADEMY_TABS = [
  { tab: 'Testing Program', module: 'Testing program', gid: 2104426564, linkColumn: 'Video Link' },
  { tab: 'People Oversight', module: 'People oversight', gid: 1441169249, linkColumn: 'Video Link' },
  { tab: 'Branches', module: 'Branches', gid: 1519759355, linkColumn: 'Video Link' },
  { tab: 'Communications', module: 'Communications', gid: 541970526, linkColumn: 'Video Link' },
  { tab: 'Marketing Review', module: 'Marketing', gid: 1427227117, linkColumn: 'Updated Link' },
  { tab: 'Account Surveillance', module: 'Account surveillance', gid: 569087505, linkColumn: 'Video Link' },
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
export function lessonsFromCsv(text, linkColumn) {
  const rows = parseCsv(text);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const ti = header.indexOf('lesson title');
  const li = header.indexOf(linkColumn.toLowerCase());
  if (ti < 0 || li < 0) throw new Error(`missing "Lesson Title" or "${linkColumn}" column`);
  const out = [];
  for (const r of rows.slice(1)) {
    const title = (r[ti] || '').trim();
    if (!title) continue; // section header rows (GETTING STARTED, …)
    const raw = (r[li] || '').trim();
    const isUrl = /^https?:\/\//i.test(raw);
    const note = !isUrl && raw && !/^add link here$/i.test(raw) ? raw : '';
    out.push({ title, level: (r[0] || '').trim(), link: isUrl ? raw : null, note });
  }
  return out;
}

let cache = { at: 0, data: null };
export async function getAcademyLessons({ fresh = false, maxAgeMs = 5 * 60000 } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < maxAgeMs) return cache.data;
  const modules = [];
  // Sequential on purpose: parallel exports of 6 tabs trip Google's 429 rate limit.
  for (const t of ACADEMY_TABS) {
    const lessons = lessonsFromCsv(await googleSheetCsv(ACADEMY_SHEET_ID, t.gid), t.linkColumn);
    const done = lessons.filter((l) => l.link).length;
    modules.push({ module: t.module, tab: t.tab, linkColumn: t.linkColumn, total: lessons.length, done, remaining: lessons.length - done, lessons });
  }
  const total = modules.reduce((n, m) => n + m.total, 0);
  const done = modules.reduce((n, m) => n + m.done, 0);
  cache = { at: Date.now(), data: { sheetUrl: ACADEMY_SHEET_URL, fetchedAt: new Date().toISOString(), total, done, remaining: total - done, modules } };
  return cache.data;
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
  const ordered = [...ACADEMY_TABS].sort((a, b) => (b.module.toLowerCase() === mod) - (a.module.toLowerCase() === mod));
  const hits = [];
  for (const [i, t] of ordered.entries()) {
    const range = encodeURIComponent(`'${t.tab}'!A1:Z400`);
    const { values = [] } = await googleSheetsApi(`${ACADEMY_SHEET_ID}/values/${range}`);
    const header = (values[0] || []).map((h) => String(h).trim().toLowerCase());
    const ti = header.indexOf('lesson title'), li = header.indexOf(t.linkColumn.toLowerCase());
    if (ti < 0 || li < 0) continue;
    values.forEach((row, r) => { if (r > 0 && normLesson(row[ti]) === key) hits.push({ t, row: r + 1, li, current: String(row[li] || '').trim(), lesson: row[ti] }); });
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
