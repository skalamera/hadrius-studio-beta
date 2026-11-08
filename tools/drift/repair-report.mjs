// Human-readable justification of each flagged video's repair decision (repairability.mjs), with optional local
// OCR corroboration of what the RECORDED slides show. Offline: reads a selection-replay output directory only.
// CLI: node tools/drift/repair-report.mjs --parity RUN/selection-parity.json --out NEW_DIR [--ocr]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BLOCKER_TEXT } from './repairability.mjs';
import { containsPhrase } from './ui-strings.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const KEPT_CODES = new Set(['linked_slide_unproven', 'kept_slide_shows_changed_element']);

/** Which old labels does a recorded slide visibly show? OCR presence is evidence; absence proves nothing. */
export function corroborate(lines, labels) {
  return labels.filter((l) => l && lines.some((line) => containsPhrase(line, l)));
}

export function buildRepairReport({ parity, runDir, ocr = null }) {
  const videos = [];
  for (const [name, repair] of Object.entries(parity.repair)) {
    const script = readJson(join(REPO, 'scripts', `${name}.script.json`));
    const job = readJson(join(runDir, name, 'job.json'));
    const rec = (i) => { const m = script.steps.find((s, n) => (s.index ?? n) === i)?.media?.pre; return m ? join(REPO, 'out', '_recordings', script.recording.id, m) : null; };
    const today = (i) => job.steps.find((s) => s.index === i)?.evidence?.today ?? null;
    const selected = (job.uiSelection?.slides || []).map((s) => ({ index: s.index, changes: s.changes.map(({ kind, before, after, element, pr }) => ({ kind, before, after, element, pr })) }));
    const stale = [...new Set(selected.flatMap((s) => s.changes.map((c) => c.before)).filter(Boolean))];
    const blockers = repair.blockers.map((b) => ({ code: b.code, meaning: BLOCKER_TEXT[b.code] ?? b.code, slides: b.slides.map((i) => i + 1),
      items: b.items.map((x) => {
        const shows = KEPT_CODES.has(b.code) && ocr?.[rec(x.index)] ? corroborate(ocr[rec(x.index)], stale) : null;
        return { slide: x.index + 1, detail: x.detail, recorded: rec(x.index), today: today(x.index), ...(shows ? { recordedShowsOldLabels: shows } : {}) };
      }) }));
    const evidence = selected.map((s) => ({ slide: s.index + 1, recorded: rec(s.index), today: today(s.index), changes: s.changes,
      ...(ocr?.[rec(s.index)] ? { recordedShows: corroborate(ocr[rec(s.index)], s.changes.map((c) => c.before)) } : {}),
      ...(ocr?.[today(s.index)] ? { todayShows: corroborate(ocr[today(s.index)], s.changes.map((c) => c.after)) } : {}) }));
    videos.push({ name, decision: repair.decision, slideCount: script.steps.length, selected: evidence, blockers, notes: repair.notes });
  }
  return { schema: 1, policy: Object.values(parity.repair)[0]?.policy ?? null, generatedAt: new Date().toISOString(), ocr: !!ocr, videos };
}

export function markdown(report) {
  const out = [`# Repair decisions for the flagged videos`, '',
    `Policy \`${report.policy}\`. Automatic repair (replace only the selected slides) needs positive evidence on every check; any failed or unprovable check sends the video to a person. ${report.ocr ? 'OCR lines are a local, offline reading of the RECORDED slide image (macOS Vision) and corroborate the decision; they are not policy inputs.' : ''}`, '',
    `| Video | Decision | Why (blocker → slides) |`, `|---|---|---|`,
    ...report.videos.map((v) => `| ${v.name} | ${v.decision} | ${v.blockers.map((b) => `${b.code} → ${b.slides.join(', ')}`).join('; ') || '—'} |`), ''];
  for (const v of report.videos) {
    out.push(`## ${v.name} — ${v.decision === 'auto' ? 'automatic selective repair' : 'needs a person'}`, '');
    for (const s of v.selected) out.push(`- Selected slide ${s.slide}: ${s.changes.map((c) => `${c.kind} “${c.before ?? ''}” → “${c.after ?? ''}” (${c.element}${c.pr ? `, PR #${c.pr}` : ''})`).join('; ')}`
      + `${s.recordedShows ? ` · OCR recorded shows: ${s.recordedShows.map((l) => `“${l}”`).join(', ') || 'none found'}` : ''}${s.todayShows ? ` · OCR today shows: ${s.todayShows.map((l) => `“${l}”`).join(', ') || 'none found'}` : ''}`);
    out.push('');
    for (const b of v.blockers) {
      out.push(`**${b.code}** — ${b.meaning}`);
      const seen = new Set();
      for (const x of b.items) { const k = `${x.slide}|${x.detail}`; if (seen.has(k)) continue; seen.add(k);
        out.push(`- Slide ${x.slide}: ${x.detail}${x.recordedShowsOldLabels ? ` · OCR of the recorded slide: ${x.recordedShowsOldLabels.length ? `shows ${x.recordedShowsOldLabels.map((l) => `“${l}”`).join(', ')} (confirms the old interface would remain)` : 'no old label found (OCR absence is not proof)'}` : ''}`); }
      out.push('');
    }
    const other = v.notes.filter((n) => n.code === 'other_unverified_slides').flatMap((n) => n.slides.map((i) => i + 1));
    if (other.length) out.push(`Other unverified slides (not linked to these changes; unchanged by a repair): ${other.join(', ')}.`, '');
  }
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), arg = (k) => args[args.indexOf(k) + 1];
  const parityPath = resolve(arg('--parity')), out = resolve(arg('--out'));
  if (existsSync(out)) throw new Error('output_exists');
  const parity = readJson(parityPath), runDir = dirname(parityPath);
  let ocr = null;
  if (args.includes('--ocr')) {
    const draft = buildRepairReport({ parity, runDir });
    const images = [...new Set(draft.videos.flatMap((v) => [...v.selected.flatMap((s) => [s.recorded, s.today]),
      ...v.blockers.filter((b) => KEPT_CODES.has(b.code)).flatMap((b) => b.items.map((x) => x.recorded))]).filter((p) => p && existsSync(p)))];
    ocr = JSON.parse(execFileSync('swift', [join(REPO, 'tools', 'drift', 'ocr-text.swift'), ...images], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }).toString());
  }
  const report = buildRepairReport({ parity, runDir, ocr });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'repair-decisions.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'repair-decisions.md'), markdown(report) + '\n');
  console.log(JSON.stringify({ videos: report.videos.length, auto: report.videos.filter((v) => v.decision === 'auto').length, ocr: report.ocr, out }, null, 2));
}
