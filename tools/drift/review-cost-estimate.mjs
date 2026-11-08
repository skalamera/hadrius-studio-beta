// W2 measurement on saved sweeps (no model calls, no browser, no network, no writes outside a new output directory):
//  1. Replay: seeds a TEMPORARY answer cache from the sweep's saved redesign reviews, replays every review through the
//     weekly reviewer wiring with a model that throws if called, and checks deterministic verification reproduces them.
//  2. Back-test: for slides also captured by an EARLIER run (--earlier dirs), checks whether the earlier screen would
//     have let the later run reuse the stored review (redesignReusable). That is the reuse rate on real repeat captures.
//  3. Counts narration-judge calls under the weekly scope (release-confirmed slides only).
// CLI: node tools/drift/review-cost-estimate.mjs --reports A.json,B.json --allowlist FILE [--earlier DIR,DIR] --out NEW_DIR
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeReports } from './flagged-review.mjs';
import { parseNames } from './weekly.mjs';
import { createFrontendGit } from './frontend-git.mjs';
import { createReleaseProvider } from './release-provider.mjs';
import * as rj from './redesign-judge.mjs';
import * as cls from './classify.mjs';
import { createReviewStore, createReviewBudget, reviewerVersion } from './review-cache.mjs';
import { reviewedJudges } from './weekly.mjs';
import { digest } from './contracts.mjs';
import { decisionModel } from '../coverage-scan.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const UI_CONFIRMED = new Set(['page_redesigned', 'ui_changed', 'persistent_chrome_changed']);
const verifiedSet = (r) => (r?.changes || []).filter((c) => c.verified !== false).map((c) => `${c.kind}|${c.before}|${c.after}|${c.commit}`).sort();

export async function estimate({ reportPaths, allowlistPath, earlierDirs = [], log = console.error }) {
  const merged = mergeReports(reportPaths.map((p) => readJson(resolve(p))));
  const names = new Set(parseNames({ allowlistText: readFileSync(allowlistPath, 'utf8') }));
  const saved = new Map();
  for (const v of merged.values()) if (v.release?.baselineSha) {
    saved.set(`${v.release.baselineDeployedAt}|${v.release.baselineSha}`, { sha: v.release.baselineSha, successAt: v.release.baselineDeployedAt });
    saved.set(`${v.release.currentDeployedAt}|${v.release.currentSha}`, { sha: v.release.currentSha, successAt: v.release.currentDeployedAt });
  }
  const git = createFrontendGit(); git.fetchHeads = () => null;
  git.ensureCommit = (sha) => { if (!git.hasCommit(sha)) throw new Error(`offline_sha_missing:${sha}`); };
  const provider = createReleaseProvider({ git, loadDeployments: async () => [...saved.values()].sort((a, b) => Date.parse(a.successAt) - Date.parse(b.successAt)) });
  const model = decisionModel();
  const version = reviewerVersion(`${model};effort=${process.env.KBS_DECISION_EFFORT??'default'}`, rj.buildRedesignPrompt, rj.parseRedesignJudge, rj.redesignCacheInputs, rj.redesignReusable);
  const root = mkdtempSync(join(tmpdir(), 'review-cache-measure-')), store = createReviewStore({ root }), budget = createReviewBudget();
  let modelCalls = 0;
  const { redesignJudge } = reviewedJudges({ narrationJudge: null, redesignJudge: async () => { modelCalls++; throw new Error('model must not be called in this measurement'); }, model, store, budget, cls, rj });
  const out = { reviews: 0, savedCostUsd: 0, uncacheable: [], replay: { modelCalls: 0, reproduced: 0, mismatched: [] },
    backtest: { slides: 0, reusable: 0, notReusable: 0, videos: {}, earlierDirs }, narration: { savedCalls: 0, savedCostUsd: 0, weeklyScopeCalls: 0 } };
  const earlierCap = (name) => earlierDirs.map((d) => join(d, name, 'capture')).filter((c) => existsSync(join(c, 'compare.json'))).at(-1) ?? null;
  for (const v of merged.values()) {
    if (!names.has(v.name) || v.skipped) continue;
    const script = readJson(join(REPO, 'scripts', `${v.name}.script.json`)), cap = join(v.runDir, v.name, 'capture');
    const run = readJson(join(cap, 'run.json')), compare = readJson(join(cap, 'compare.json'));
    const classify = existsSync(join(cap, 'classify.json')) ? readJson(join(cap, 'classify.json')) : null;
    for (const s of classify?.steps || []) if (s.judge && !s.judge.error) { out.narration.savedCalls++; out.narration.savedCostUsd += s.judge.costUsd ?? 0; }
    for (const s of v.steps || []) {
      const st = script.steps.find((x, n) => (x.index ?? n) === s.index);
      if ((s.codes || []).some((c) => UI_CONFIRMED.has(c.split(':').at(-1))) && st?.narration?.trim()) out.narration.weeklyScopeCalls++;
    }
    const reviewed = (v.steps || []).filter((s) => s.release === 'candidates' && s.redesign?.raw);
    if (!reviewed.length) continue;
    const now = await provider({ script, runDir: cap, capturedAt: v.release.capturedAt });
    const eCap = earlierCap(v.name), eRun = eCap && readJson(join(eCap, 'run.json')), eCompare = eCap && readJson(join(eCap, 'compare.json'));
    for (const s of reviewed) {
      out.reviews++; out.savedCostUsd += s.redesign.raw.costUsd ?? 0;
      const st = script.steps.find((x, n) => (x.index ?? n) === s.index), r = run.steps.find((x) => x.index === s.index);
      const recorded = st?.media?.pre ? join(REPO, 'out', '_recordings', script.recording.id, st.media.pre) : null;
      const todayShot = compare.steps.find((x) => x.index === s.index)?.todayScreenshot;
      const paths = { recorded, today: todayShot ? join(cap, todayShot) : null }, todayText = r?.visibleText ?? '';
      const todayRects = { dynamicRects: r?.dynamicRects ?? [], dataRects: r?.dataRects ?? [] };
      const ev = now.byStep[s.index], cache = rj.redesignCacheInputs({ evidence: ev, releaseEvidence: now, script, step: st, paths, todayText, todayRects });
      if (!cache.slot) { out.uncacheable.push(`${v.name}#${s.index}`); continue; }
      const key = digest({ kind: 'redesign', version, inputKey: cache.slot });
      // Seed with the saved answer for the screen it was given for, then replay through the weekly wiring.
      store.put('redesign', key, { version, inputKey: cache.slot, answer: s.redesign.raw, ...rj.redesignCacheExtra(cache, key, store) });
      const replayed = await rj.reviewRedesign({ redesignJudge, releaseEvidence: now, evidence: ev, script, step: st, paths, todayText, todayRects });
      if (JSON.stringify(verifiedSet(replayed.redesign)) === JSON.stringify(verifiedSet(s.redesign)) && !!replayed.redesign?.confirmed === !!s.redesign.confirmed) out.replay.reproduced++;
      else out.replay.mismatched.push(`${v.name}#${s.index}`);
      // Back-test: would the EARLIER capture's stored review be reusable for this capture?
      const er = eRun?.steps.find((x) => x.index === s.index), eShot = eCompare?.steps.find((x) => x.index === s.index)?.todayScreenshot;
      if (!er || !eShot || !existsSync(join(eCap, eShot))) continue;
      const eCache = rj.redesignCacheInputs({ evidence: ev, releaseEvidence: now, script, step: st, paths: { recorded, today: join(eCap, eShot) }, todayText: er.visibleText ?? '',
        todayRects: { dynamicRects: er.dynamicRects ?? [], dataRects: er.dataRects ?? [] } });
      const ok = rj.redesignReusable({ answer: s.redesign.raw, todayImage: eCache.todayPath, labelSequence: eCache.labelSequence, rects: eCache.rects, citable: eCache.citable }, cache);
      out.backtest.slides++; ok ? out.backtest.reusable++ : out.backtest.notReusable++;
      (out.backtest.videos[v.name] ??= { earlier: eCap, reusable: [], notReusable: [] })[ok ? 'reusable' : 'notReusable'].push(s.index + 1);
    }
    log(`[estimate] ${v.name}: ${reviewed.length} review(s)`);
  }
  out.replay.modelCalls = modelCalls; out.replay.cacheHits = budget.usage.cacheHits;
  rmSync(root, { recursive: true, force: true });
  out.savedCostUsd = Math.round(out.savedCostUsd * 100) / 100; out.narration.savedCostUsd = Math.round(out.narration.savedCostUsd * 100) / 100;
  const perRedesign = out.savedCostUsd / out.reviews, perNarration = out.narration.savedCostUsd / out.narration.savedCalls;
  const usd = (n) => Math.round(n * 100) / 100;
  out.estimate = { perRedesignUsd: usd(perRedesign), perNarrationUsd: usd(perNarration), uncachedApiEquivalentUsd: usd(out.savedCostUsd + out.narration.savedCostUsd),
    weeklyScopeNarrationUsd: usd(out.narration.weeklyScopeCalls * perNarration),
    reuseRateOnRepeatCaptures: out.backtest.slides ? Math.round((out.backtest.reusable / out.backtest.slides) * 1000) / 1000 : null };
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), arg = (k) => args[args.indexOf(k) + 1];
  const outDir = resolve(arg('--out'));
  if (existsSync(outDir)) throw new Error('output_exists');
  estimate({ reportPaths: arg('--reports').split(','), allowlistPath: resolve(arg('--allowlist')), earlierDirs: args.includes('--earlier') ? arg('--earlier').split(',').map((d) => resolve(d)) : [] }).then((r) => {
    mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'review-cost-estimate.json'), JSON.stringify(r, null, 2) + '\n');
    console.log(JSON.stringify({ ...r, uncacheable: r.uncacheable.length, replay: { ...r.replay, mismatched: r.replay.mismatched.length } }, null, 2));
  }).catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}
