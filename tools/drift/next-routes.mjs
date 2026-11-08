// Next.js pages-router resolution for hadrius-app: which apps/hadrius-app/pages file renders a URL path. Pure.
export const APP_DIR = 'apps/hadrius-app/';
export const APP_SHELL_ENTRY = `${APP_DIR}pages/_app.tsx`;
const PAGE_RE = /^apps\/hadrius-app\/pages\/(.+)\.(tsx|ts|jsx|js)$/;
const NOT_A_PAGE = /(^|\/)(api|__test__|__tests__)\/|(^|\/)_(app|document|error)$|(^|\/)(404|500)$|\.(test|spec|stories)$/;

export function isPageFile(path) {
  const m = PAGE_RE.exec(String(path || ''));
  return !!m && !NOT_A_PAGE.test(m[1]);
}

function patternOf(path) {
  const m = PAGE_RE.exec(path);
  if (!m || NOT_A_PAGE.test(m[1])) return null;
  const segs = m[1].split('/');
  if (segs[segs.length - 1] === 'index') segs.pop();
  return segs;
}

// Specificity per segment: static 3 > [param] 2 > [...catchAll] 1 > [[...optional]] 0. A pattern that has already
// ended scores 0.5, so /a/index beats /a/[[...rest]] for "/a".
function match(segs, url) {
  const score = []; let i = 0;
  for (const g of segs) {
    if (/^\[\[\.\.\..+\]\]$/.test(g)) { score.push(0); return { score, consumed: url.length }; }
    if (/^\[\.\.\..+\]$/.test(g)) { if (i >= url.length) return null; score.push(1); return { score, consumed: url.length }; }
    if (i >= url.length) return null;
    if (/^\[.+\]$/.test(g)) { score.push(2); i++; continue; }
    if (g !== url[i]) return null;
    score.push(3); i++;
  }
  return { score, consumed: i };
}
const compare = (a, b) => {
  for (let k = 0; k < Math.max(a.length, b.length); k++) { const x = a[k] ?? 0.5, y = b[k] ?? 0.5; if (x !== y) return x - y; }
  return 0;
};

/** The page file for a URL or route (host, query, hash and trailing slash ignored), or null. */
export function pageFileForRoute(paths, route) {
  let pathname = String(route || '');
  try { if (/^https?:/i.test(pathname)) pathname = new URL(pathname).pathname; } catch { return null; }
  pathname = pathname.split(/[?#]/)[0];
  let url;
  try { url = pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  let best = null;
  for (const p of paths) {
    const segs = patternOf(p);
    if (!segs) continue;
    const m = match(segs, url);
    if (!m || m.consumed !== url.length) continue;
    if (!best || compare(m.score, best.score) > 0) best = { file: p, score: m.score };
  }
  return best?.file ?? null;
}
