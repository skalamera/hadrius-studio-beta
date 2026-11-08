// Offline re-classification of an existing weekly run directory (no browser): re-runs classify.mjs on each video's
// saved capture/ (run.json, compare.json, today PNGs) with the CURRENT classifier, reusing the narration judge
// verdicts saved in the old classify.json (judge calls are model output; re-asking would change more than the
// classifier). Steps the old run never judged get no judge (narration_unchecked) unless --live-judge is given.
// --release adds production release attribution (bare frontend mirror + GitHub deployments, read-only);
// --redesign-judge asks Claude to review release candidates; --reuse REPORT.json replays earlier reviews first;
// --judge-keys labels.json limits NEW reviews to labelled slides ("Video#index").
// Writes <run>/reclassify-<stamp>.json (+ .md); never touches capture/ or job.json. Import-safe.
//
// --concurrency N reclassifies N videos at a time (the Claude reviews dominate the run time); report order is kept.
//
// CLI: node tools/drift/reclassify.mjs --run RUN_DIR [--names A,B] [--live-judge] [--release] [--redesign-judge] [--reuse REPORT.json] [--judge-keys labels.json] [--concurrency N]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './capture.mjs';
import { classifyRun, makeClaudeJudge } from './classify.mjs';
import { stamp } from './weekly.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const UI_CODES = new Set(['page_redesigned', 'persistent_chrome_changed', 'ui_changed']);

/** Judge that answers from a previous classify.json (by step index); null = never judged before. */
export function cachedJudge(oldClassify, { live = null, onMiss = () => {} } = {}) {
  const by = new Map((oldClassify?.steps || []).filter((s) => s.judge).map((s) => [s.index, s.judge]));
  return async (input) => {
    const j = by.get(input.stepNumber - 1);
    if (j) { if (j.error) throw new Error(j.error); return j; }
    onMiss(input.stepNumber - 1);
    return live ? live(input) : null;
  };
}

/** Redesign judge for one video: an earlier review of the same slide first, then the live judge for allowed keys.
 *  Returns null when neither applies (the slide then stays "redesign_unreviewed"). */
export function redesignJudgeFor(name, { reuse = null, live = null, keys = null } = {}) {
  const prior = new Map();
  for (const v of reuse?.videos || []) if (v.name === name) for (const s of v.steps || []) if (s.redesign?.raw) prior.set(s.index, s.redesign.raw);
  if (!prior.size && !live) return null;
  return async (input) => {
    const index = input.stepNumber - 1;
    if (prior.has(index)) return prior.get(index);
    if (!live || (keys && !keys.has(`${name}#${index}`))) return null;
    return live(input);
  };
}

export async function reclassifyVideo({ runDir, name, scriptsDir = join(REPO, 'scripts'), recordingsRoot = join(REPO, 'out', '_recordings'), liveJudge = null, release = null, redesignJudge = null }) {
  const cap = join(runDir, name, 'capture');
  const job = readJson(join(runDir, name, 'job.json'));
  const before = readJson(join(cap, 'classify.json'));
  const script = readJson(join(scriptsDir, `${name}.script.json`));
  if (!existsSync(join(cap, 'run.json')) || !existsSync(join(cap, 'compare.json')) || !script) return { name, status: job?.status ?? 'missing', skipped: 'no_capture_or_script', before: job?.verdict ?? null, after: null };
  let releaseEvidence = null, releaseError = null;
  if (release) { try { releaseEvidence = await release({ script, runDir: cap, capturedAt: job?.startedAt }); } catch (e) { releaseError = String(e?.message || e).slice(0, 300); } }
  const misses = [];
  const after = await classifyRun({ runDir: cap, script, recordingsDir: join(recordingsRoot, script.recording?.id ?? '_missing_'),
    judge: cachedJudge(before, { live: liveJudge, onMiss: (i) => misses.push(i) }), releaseEvidence, redesignJudge, write: false });
  const top = (r) => (r?.reasons || []).filter((x) => x.verdict === r.verdict).slice(0, 3).map((x) => `${x.step == null ? 'video' : `slide ${x.step + 1}`}: ${x.code}`);
  return {
    name, status: job?.status ?? null, before: before?.verdict ?? job?.verdict ?? null, after: after.verdict, changed: (before?.verdict ?? null) !== after.verdict,
    beforeReasons: top(before), afterReasons: top(after), judgeMisses: misses,
    release: releaseEvidence?.summary ?? (releaseError ? { status: 'error', reason: releaseError } : null),
    steps: after.steps.map((s) => ({ index: s.index, verdict: s.verdict, codes: s.reasons.map((r) => `${r.verdict}:${r.code}`),
      // Keep the actual checks with the report. Replaying only codes used to resurrect stale narration/target data
      // from job.json and discard a later successful check, so repairability could remain blocked forever.
      reasons: s.reasons, judge: s.judge ?? null, target: s.target ?? null,
      guard: s.guard ?? null, pageState: s.pageState ?? null, emptyState: s.emptyState ?? null,
      errorState: s.errorState ?? null, prerequisiteUnverified: !!s.prerequisiteUnverified,
      redesignConfirmed: s.reasons.some((r) => UI_CODES.has(r.code)), release: s.uiReleaseEvidence?.status ?? null,
      commits: (s.uiReleaseEvidence?.commits || []).map((c) => ({ sha: c.sha, pr: c.pr, subject: c.subject, files: c.files })),
      redesign: s.uiReleaseEvidence?.redesign ?? null,
      disambiguation: s.target?.disambiguation ? { status: s.target.disambiguation.status, method: s.target.disambiguation.method, reason: s.target.disambiguation.reason, chosen: s.target.disambiguation.chosen, preexisting: s.target.disambiguation.preexisting, extraAreData: s.target.disambiguation.extraAreData, candidates: s.target.disambiguation.candidates.map((c) => ({ bbox: c.bbox, distancePx: c.distancePx, visualMad: c.visualMad, recordLabel: c.recordLabel, presentInRecording: c.presentInRecording })) } : null })),
    summary: after.summary, contactSheet: after.contactSheet,
  };
}

export async function reclassifyRun({ runDir, names = null, liveJudge = false, write = true, release = null, liveRedesign = null, reuse = null, judgeKeys = null, concurrency = 1, onVideo = () => {} }) {
  const dir = resolve(runDir);
  const summary = readJson(join(dir, 'summary.json'));
  const list = names ?? (summary?.videos?.map((v) => v.name) ?? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'job.json'))));
  const live = liveJudge ? makeClaudeJudge() : null;
  const videos = new Array(list.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      videos[i] = await reclassifyVideo({ runDir: dir, name: list[i], liveJudge: live, release, redesignJudge: redesignJudgeFor(list[i], { reuse, live: liveRedesign, keys: judgeKeys }) });
      onVideo(videos[i], ++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, list.length)) }, worker));
  const report = { schema: 1, runDir: dir, generatedAt: new Date().toISOString(), judge: liveJudge ? 'cached+live' : 'cached-only', release: !!release,
    redesignReview: liveRedesign ? (judgeKeys ? 'live (labelled slides only)' : 'live') : (reuse ? 'reused only' : 'none'), videos };
  if (write) {
    const base = join(dir, `reclassify-${stamp()}`);
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    const L = [`# Offline re-classification: ${dir}`, '',
      `Judge: ${report.judge} (old verdicts reused; never-judged steps = narration_unchecked). Release attribution: ${report.release ? 'on' : 'off'}. Redesign review: ${report.redesignReview}.`, '',
      '| Video | Before | After | Confirmed redesign slides | Top reasons after |', '|---|---|---|---|---|'];
    for (const v of videos) L.push(`| ${v.name} | ${v.before ?? v.status} | ${v.after ?? v.skipped ?? '—'} | ${(v.steps || []).filter((s) => s.redesignConfirmed).map((s) => s.index + 1).join(', ') || '—'} | ${(v.afterReasons || []).join('; ')} |`);
    writeFileSync(`${base}.md`, L.join('\n') + '\n', { flag: 'wx' });
    report.paths = { json: `${base}.json`, md: `${base}.md` };
  }
  return report;
}

function arg(a, n) { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; }
export async function main(args = process.argv.slice(2)) {
  const run = arg(args, '--run');
  if (!run) throw new Error('usage: reclassify.mjs --run RUN_DIR [--names A,B] [--live-judge] [--release] [--redesign-judge] [--reuse REPORT.json] [--judge-keys labels.json]');
  const release = args.includes('--release') ? (await import('./release-provider.mjs')).createReleaseProvider({ log: (m) => console.error(`[release] ${m}`) }) : null;
  const liveRedesign = args.includes('--redesign-judge') ? (await import('./redesign-judge.mjs')).makeRedesignJudge() : null;
  const reuse = arg(args, '--reuse') ? readJson(resolve(arg(args, '--reuse'))) : null;
  const keysPath = arg(args, '--judge-keys');
  const judgeKeys = keysPath ? new Set((readJson(resolve(keysPath))?.items || []).map((i) => i.key)) : null;
  const r = await reclassifyRun({ runDir: run, names: arg(args, '--names')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null, liveJudge: args.includes('--live-judge'), release, liveRedesign, reuse, judgeKeys,
    concurrency: Number(arg(args, '--concurrency') ?? 1),
    onVideo: (v, n, total) => console.error(`[reclassify] ${n}/${total} ${v.name}: ${v.after ?? v.skipped ?? v.status}${v.release?.status ? ` (release ${v.release.status})` : ''}; confirmed slides: ${(v.steps || []).filter((s) => s.redesignConfirmed).map((s) => s.index + 1).join(', ') || 'none'}`) });
  console.log(JSON.stringify({ paths: r.paths, videos: r.videos.map((v) => ({ name: v.name, before: v.before, after: v.after, release: v.release?.status ?? null,
    confirmed: (v.steps || []).filter((s) => s.redesignConfirmed).map((s) => s.index + 1), reasons: v.afterReasons, judgeMisses: v.judgeMisses })) }, null, 2));
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
