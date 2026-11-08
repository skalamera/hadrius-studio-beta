// The short list for a person: videos whose old version would now mislead a viewer about the interface (not the data).
// Input: reclassify reports (later reports replace earlier ones for the same video, e.g. a retry run). A slide counts
// when a verified, release-attributed change (see redesign-judge.mjs) renamed, removed or moved something on it:
//   - a change verified identically on 3+ different pages is the app frame (sidebar, header, account menu), not the
//     page; it counts only when the slide's narration, caption or click target names that label;
//   - a control that was only ADDED doesn't make the old video wrong (the viewer just sees one more button).
// Both groups are still listed, as "not flagged", so nothing is hidden. Offline only: writes summary.md + index.html
// (the video slide next to today's capture, each change and the PR that made it). No Slack, Drive or Pylon.
//
// CLI: node tools/drift/flagged-review.mjs --reports A.json[,B.json] --out DIR
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sortVideos, normalizedRoute, slideText } from './ui-selection.mjs';
export { sortVideos, appFrameSignatures } from './ui-selection.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PR_URL = (n) => `https://github.com/1Quantbase/hadrius_frontend/pull/${n}`;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subjectOf = (s) => String(s || '').replace(/\s*\(#\d+\)\s*$/, '');

/** name -> video (+ runDir). A later report replaces an earlier entry unless the video was skipped in the later one. */
export function mergeReports(reports) {
  const out = new Map();
  for (const r of reports) for (const v of r.videos || []) {
    if (v.skipped && out.has(v.name)) continue;
    out.set(v.name, { ...v, runDir: r.runDir });
  }
  return out;
}


export function tally(merged) {
  const videos = { total: 0, checked: 0, notCaptured: 0 }, oldVerdicts = {}, slideCodes = {};
  for (const v of merged.values()) {
    videos.total++;
    if (v.skipped) { videos.notCaptured++; continue; }
    videos.checked++;
    oldVerdicts[v.before ?? 'unknown'] = (oldVerdicts[v.before ?? 'unknown'] || 0) + 1;
    for (const s of v.steps || []) for (const c of s.codes || []) slideCodes[c] = (slideCodes[c] || 0) + 1;
  }
  return { videos, oldVerdicts, slideCodes };
}

const changeText = (c) => (c.kind === 'renamed' ? `renamed "${c.before}" → "${c.after}"` : c.kind === 'removed' ? `removed "${c.before}"` : `${c.kind} "${c.after ?? c.before}"`);
const prText = (c) => (c.pr ? `PR #${c.pr}${c.subject ? `, ${subjectOf(c.subject)}` : ''}: ${PR_URL(c.pr)}` : `commit ${String(c.sha || '').slice(0, 12)}`);
const shortList = (videos) => videos.map((v) => {
  const seen = new Set();
  for (const s of v.slides) for (const c of s.changes) seen.add(`${changeText(c)} (${c.pr ? `PR #${c.pr}` : String(c.sha || '').slice(0, 12)})`);
  return `- ${v.name}: ${[...seen].join('; ')}`;
});

export function renderMarkdown(r, t) {
  const L = ['# Videos whose old version would mislead a viewer about the interface', '',
    `Checked ${t.videos.checked} captured videos (${t.videos.notCaptured} not captured). Flagged: ${r.flagged.length}.`,
    'Flagged = a production frontend release since the recording renamed, removed or moved something on the slide, and',
    'the checker verified it against the code (the label is on today\'s screen or gone from it, and that commit\'s diff',
    'adds or removes it). Data, empty lists, styling and capture problems are never flagged.', ''];
  for (const v of r.flagged) {
    L.push(`## ${v.name}`, '', `${v.slides.length} of ${v.stepCount} slides`, '');
    for (const s of v.slides) for (const c of s.changes) L.push(`- slide ${s.index + 1}: ${changeText(c)} (${prText(c)})`);
    L.push('');
  }
  L.push(`## Not flagged: only new controls were added (${r.newControlsOnly.length} videos)`, '',
    'The old video is still right; the page just has an extra control it doesn\'t use.', '', ...shortList(r.newControlsOnly), '');
  L.push(`## Not flagged: sidebar/header changes the slide doesn't use (${r.frameOnly.length} videos)`, '',
    'The same change was verified on 3+ different pages, so it is the app frame, not the page in the video.', '', ...shortList(r.frameOnly), '');
  L.push('## Old checker verdicts for the checked videos', '', ...Object.entries(t.oldVerdicts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`), '');
  L.push('## Slide counts by reason', '', ...Object.entries(t.slideCodes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`), '');
  return L.join('\n');
}

export function renderHtml(r, t, { imagesFor }) {
  const img = (p, alt) => (p ? `<img src="${esc(pathToFileURL(p).href)}" alt="${esc(alt)}">` : `<div class="missing">${esc(alt)}: image not found</div>`);
  const change = (c) => `<li>${esc(c.kind)} ${c.kind === 'renamed' ? `“${esc(c.before)}” → “${esc(c.after)}”` : `“${esc(c.after ?? c.before)}”`} ${c.pr ? `<a href="${esc(PR_URL(c.pr))}">PR #${c.pr}</a> ${esc(subjectOf(c.subject))}` : esc(String(c.sha || '').slice(0, 12))}</li>`;
  const cards = r.flagged.map((v) => `<section><h2>${esc(v.name)}</h2><p class="meta">${v.slides.length} of ${v.stepCount} slides</p>${v.slides.map((s) => {
    const im = imagesFor(v, s.index);
    return `<div class="slide"><h3>Slide ${s.index + 1}</h3><div class="pair"><figure>${img(im.recorded, 'In the video')}<figcaption>In the video</figcaption></figure><figure>${img(im.today, 'Live on 10/30')}<figcaption>Live on 10/30</figcaption></figure></div><ul>${s.changes.map(change).join('')}</ul></div>`;
  }).join('')}</section>`).join('\n');
  const others = (title, note, list) => `<details><summary>${esc(title)} (${list.length})</summary><p class="meta">${esc(note)}</p><ul>${list.map((v) => `<li><b>${esc(v.name)}</b>: ${[...new Set(v.slides.flatMap((s) => s.changes.map((c) => `${c.kind} “${c.after ?? c.before}”${c.pr ? ` (PR #${c.pr})` : ''}`)))].map(esc).join('; ')}</li>`).join('')}</ul></details>`;
  return `<!doctype html><meta charset="utf-8"><title>Walkthrough videos that would mislead</title>
<style>body{font:15px/1.45 system-ui;margin:24px;background:#161519;color:#eee}section,details{background:#1f1e24;border-radius:10px;padding:16px;margin:0 0 20px}
h2{margin:0 0 4px}.meta{color:#aaa;margin:0 0 12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;border:1px solid #333;border-radius:6px}
figcaption{color:#aaa;font-size:13px}a{color:#e0a44a}.missing{padding:40px;border:1px dashed #555;color:#aaa}summary{cursor:pointer;font-weight:600}</style>
<h1>Videos whose old version would mislead a viewer about the interface</h1>
<p>Checked ${t.videos.checked} captured videos; ${r.flagged.length} flagged. Each change below was made by a production frontend release since the recording and verified against the code. Data, empty lists, styling and capture problems are never flagged.</p>
${cards || '<p>No videos flagged.</p>'}
${others('Not flagged: only new controls were added', "The old video is still right; the page just has an extra control it doesn't use.", r.newControlsOnly)}
${others("Not flagged: sidebar/header changes the slide doesn't use", 'The same change was verified on 3+ different pages, so it is the app frame, not the page in the video.', r.frameOnly)}`;
}

/** Page path of a slide as captured (numeric IDs collapsed), for counting how many pages a change appears on. */
export function routeFrom(v, index) {
  const cmp = readJson(join(v.runDir, v.name, 'capture', 'compare.json'));
  const url = cmp?.steps?.find((s) => s.index === index)?.todayUrl;
  return normalizedRoute(url);
}

const scriptOf = (scriptsDir, name) => readJson(join(scriptsDir, `${name}.script.json`));

/** Narration, caption and click target of a slide (what the video tells the viewer to use). */
export function slideTextFrom({ scriptsDir = join(REPO, 'scripts') } = {}) {
  return (v, index) => {
    const st = scriptOf(scriptsDir, v.name)?.steps?.find((s, i) => (s.index ?? i) === index);
    return slideText(st);
  };
}

/** Recorded slide (out/_recordings/<recording id>/<media.pre>) and today's capture for one slide. */
export function imagesFrom({ scriptsDir = join(REPO, 'scripts'), recordingsRoot = join(REPO, 'out', '_recordings') } = {}) {
  return (v, index) => {
    const script = scriptOf(scriptsDir, v.name);
    const pre = script?.steps?.find((s, i) => (s.index ?? i) === index)?.media?.pre;
    const recorded = pre && script?.recording?.id ? join(recordingsRoot, script.recording.id, pre) : null;
    const cmp = readJson(join(v.runDir, v.name, 'capture', 'compare.json'));
    const shot = cmp?.steps?.find((s) => s.index === index)?.todayScreenshot;
    const today = shot ? join(v.runDir, v.name, 'capture', shot) : null;
    return { recorded: recorded && existsSync(recorded) ? recorded : null, today: today && existsSync(today) ? today : null };
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const reports = (arg('--reports') || '').split(',').filter(Boolean).map((p) => readJson(resolve(p)));
  const out = arg('--out');
  if (!reports.length || reports.some((r) => !r) || !out) throw new Error('usage: flagged-review.mjs --reports A.json[,B.json] --out DIR');
  const merged = mergeReports(reports);
  const r = sortVideos(merged, { routeOf: routeFrom, slideTextOf: slideTextFrom() }), t = tally(merged);
  mkdirSync(resolve(out), { recursive: true });
  writeFileSync(join(resolve(out), 'summary.md'), renderMarkdown(r, t));
  writeFileSync(join(resolve(out), 'index.html'), renderHtml(r, t, { imagesFor: imagesFrom() }));
  writeFileSync(join(resolve(out), 'review.json'), JSON.stringify({ tally: t, ...r }, null, 2) + '\n');
  console.log(JSON.stringify({ ...t.videos, flagged: r.flagged.map((v) => v.name), newControlsOnly: r.newControlsOnly.length, frameOnly: r.frameOnly.length,
    frameChanges: r.frameChanges, html: join(resolve(out), 'index.html'), md: join(resolve(out), 'summary.md') }, null, 2));
}
