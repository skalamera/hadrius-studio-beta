// Review cache + budget (W2): synthetic answers and temp files only; no model, network or real cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachedJudge, createReviewStore, createReviewBudget, reviewerVersion, BUDGET_EXHAUSTED } from '../../tools/drift/review-cache.mjs';
import { parseRedesignJudge, reviewRedesign, redesignCacheInputs, redesignReusable } from '../../tools/drift/redesign-judge.mjs';
import { encodePng } from '../../tools/drift/compare.mjs';
import { releaseGate } from '../../tools/drift/release-evidence.mjs';
import { reviewedJudges } from '../../tools/drift/weekly.mjs';
import { weeklyArgs } from '../../tools/drift/weekly-runner.mjs';
import { main as weeklyMain } from '../../tools/drift/weekly.mjs';
import * as cls from '../../tools/drift/classify.mjs';
import * as rj from '../../tools/drift/redesign-judge.mjs';
import { candidateRelease } from './release-fixture.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'review-cache-'));
const answer = (extra = {}) => ({ redesigned: true, reason: 'renamed', changes: [{ element: 'b', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: 'c'.repeat(12) }], data_differences: [], costUsd: 0.2, ...extra });
const K = (n) => String(n).repeat(64).slice(0, 64);

test('validated cache: identical inputs make no model call; version, corrupt files, errors and nulls never hit', async () => {
  const store = createReviewStore({ root: tmp() }), budget = createReviewBudget();
  let calls = 0;
  const model = async (i) => { calls++; if (i.fail) throw new Error('cli down'); return i.none ? null : answer(); };
  const j = (version = 'v1') => cachedJudge({ kind: 'redesign', judge: model, store, budget, version, keyOf: (i) => i.k, validate: parseRedesignJudge, onExhausted: () => ({ pending: BUDGET_EXHAUSTED }) });
  assert.equal((await j()({ k: K(1) })).cached, undefined);
  const hit = await j()({ k: K(1) });
  assert.equal(calls, 1); assert.equal(hit.cached, true); assert.equal(hit.changes[0].after, 'New rule');
  await j('v2')({ k: K(1) }); assert.equal(calls, 2, 'a changed reviewer version invalidates');
  await assert.rejects(j()({ k: K(2), fail: true })); await assert.rejects(j()({ k: K(2), fail: true })); assert.equal(calls, 4, 'errors are not cached');
  await j()({ k: K(3), none: true }); await j()({ k: K(3), none: true }); assert.equal(calls, 6, 'a null answer is not cached');
  await j()({ k: null }); await j()({ k: null }); assert.equal(calls, 8, 'no key: never cached');
  // Corrupt or tampered records are misses, not answers.
  const dir = join(store.root, 'redesign'), files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) writeFileSync(join(dir, f), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), answer: { redesigned: 'yes' } }));
  await j()({ k: K(1) }); assert.equal(calls, 9, 'an answer that no longer parses is re-asked');
  assert.deepEqual([budget.usage.calls, budget.usage.cacheHits, budget.usage.errors], [9, 1, 2]);
  assert.equal(budget.usage.costUsd, 1, 'five answered calls at $0.20');
});

test('budget: overflow makes no call and stays pending (redesign) or unchecked (narration), never unchanged', async () => {
  const budget = createReviewBudget({ maxCalls: 1 });
  let calls = 0;
  const j = cachedJudge({ kind: 'redesign', judge: async () => { calls++; return answer(); }, budget, version: 'v', keyOf: () => null, onExhausted: () => ({ pending: BUDGET_EXHAUSTED }) });
  await j({}); assert.deepEqual(await j({}), { pending: BUDGET_EXHAUSTED }); assert.equal(calls, 1);
  assert.deepEqual([budget.usage.calls, budget.usage.budgetSkipped], [1, 1]);
  assert.throws(() => createReviewBudget({ maxCalls: -1 }), /invalid_max_model_calls/);
  // The slide is reported as pending review, not reviewed and not unchanged.
  const ev = candidateRelease();
  const out = await reviewRedesign({ redesignJudge: j, releaseEvidence: { excerpt: () => '' }, evidence: ev, script: { name: 'V', steps: [{}] }, step: { index: 0 }, paths: {}, todayText: '' });
  assert.equal(out.reviewPending, BUDGET_EXHAUSTED); assert.equal(out.redesign, undefined);
  const gate = releaseGate(out); assert.equal(gate.ok, false); assert.equal(gate.code, 'review_pending'); assert.ok(!gate.needsRedesignJudge);
  // Narration: the classifier records a judge error -> narration_unchecked.
  const nj = reviewedJudges({ narrationJudge: async () => { throw new Error('should not run'); }, redesignJudge: null, model: 'm', store: null, budget: createReviewBudget({ maxCalls: 0 }), cls, rj }).judge;
  await assert.rejects(nj({ narration: 'x', todayPath: null }), new RegExp(BUDGET_EXHAUSTED));
});

// 100x100 PNG, white, with optional filled squares [{x,y,s,v}].
function shot(dir, name, squares = []) {
  const w = 100, h = 100, data = new Uint8Array(w * h * 4).fill(255);
  for (const { x, y, s = 10, v = 0 } of squares) for (let yy = y; yy < y + s; yy++) for (let xx = x; xx < x + s; xx++) { const o = (yy * w + xx) * 4; data[o] = data[o + 1] = data[o + 2] = v; }
  const p = join(dir, name); writeFileSync(p, encodePng({ width: w, height: h, data })); return p;
}

test('a stored review is reused only while today looks the same: data-only changes reuse; interface changes re-ask', () => {
  const dir = tmp(), C = 'c'.repeat(40), data = [{ x: 0, y: 60, w: 100, h: 40 }];
  const base = shot(dir, 'base.png', [{ x: 10, y: 10 }]);
  const record = { todayImage: base, labelSequence: ['trading rules', 'new rule'], rects: { dynamicRects: [], dataRects: data }, citable: [C], answer: { changes: [{ commit: C.slice(0, 12) }, { commit: 'f00ba4' }] } };
  const cache = (todayPath, over = {}) => ({ todayPath, labelSequence: ['trading rules', 'new rule'], citable: [C], rects: { dynamicRects: [], dataRects: data }, ...over });
  assert.equal(redesignReusable(record, cache(shot(dir, 'same.png', [{ x: 10, y: 10 }]))), true, 'identical screen');
  assert.equal(redesignReusable(record, cache(shot(dir, 'rows.png', [{ x: 10, y: 10 }, { x: 40, y: 70 }]))), true, 'a different record in the data area');
  assert.equal(redesignReusable(record, cache(shot(dir, 'ui.png', [{ x: 10, y: 10 }, { x: 60, y: 20 }]))), false, 'a change outside data areas');
  assert.equal(redesignReusable(record, cache(base, { labelSequence: ['new rule', 'trading rules'] })), false, 'interface text moved');
  assert.equal(redesignReusable(record, cache(base, { citable: ['d'.repeat(40)] })), false, 'a release commit it was given left the list');
  assert.equal(redesignReusable(record, cache(base, { citable: [C, 'd'.repeat(40)] })), true, 'a new commit alone does not invalidate: the screen check covers its effect');
  assert.equal(redesignReusable({ ...record, citable: undefined }, cache(base)), false, 'records without the list are not reused');
  assert.equal(redesignReusable(record, cache(join(dir, 'missing.png'))), false);
  // The slot is the recorded slide; no recorded image or no capture: nothing to reuse.
  const rec = join(dir, 'rec.png'); writeFileSync(rec, 'recorded-bytes');
  const slot = (recorded, narration = 'Open rules', today = base) => redesignCacheInputs({ evidence: candidateRelease(), releaseEvidence: { uiStringsAt: () => new Set(['new rule', 'trading rules']) },
    script: { name: 'V', recording: { id: 'r1' } }, step: { index: 0, narration, media: { pre: 'r.png' } }, paths: { recorded, today }, todayText: 'Trading rules\nAcme Corp\nNew rule\n12 results' });
  assert.match(slot(rec).slot, /^[0-9a-f]{64}$/);
  assert.deepEqual(slot(rec).labelSequence, ['trading rules', 'new rule'], 'record names and counts are not interface text');
  assert.notEqual(slot(rec, 'Different narration').slot, slot(rec).slot);
  assert.equal(slot(join(dir, 'none.png')).slot, null); assert.equal(slot(rec, 'x', null).slot, null);
  assert.notEqual(reviewerVersion('m1', () => 1), reviewerVersion('m2', () => 1));
});

test('weekly reviewer wiring: second identical capture reuses with no call; an interface change re-asks and replaces', async () => {
  const dir = tmp(), store = createReviewStore({ root: join(dir, 'cache') }), budget = createReviewBudget();
  let calls = 0;
  const { redesignJudge } = reviewedJudges({ narrationJudge: null, redesignJudge: async () => { calls++; return parseRedesignJudge(answer()); }, model: 'm', store, budget, cls, rj });
  const input = (today) => ({ cache: { slot: K(7), todayPath: today, labelSequence: ['new rule'], citable: ['c'.repeat(40)], rects: { dynamicRects: [], dataRects: [] } } });
  await redesignJudge(input(shot(dir, 'w1.png', [{ x: 5, y: 5 }])));
  assert.equal((await redesignJudge(input(shot(dir, 'w2.png', [{ x: 5, y: 5 }])))).cached, true); assert.equal(calls, 1);
  await redesignJudge(input(shot(dir, 'w3.png', [{ x: 50, y: 50 }]))); assert.equal(calls, 2, 'the screen changed');
  assert.equal((await redesignJudge(input(shot(dir, 'w4.png', [{ x: 50, y: 50 }])))).cached, true, 'the record now holds the newer screen');
  assert.deepEqual([budget.usage.calls, budget.usage.cacheHits], [2, 2]);
});

test('classify: weekly narration scope asks the narration judge on release-confirmed slides and their page only', async () => {
  // Slide 1: redesign-sized change with a release candidate. Slide 2: a small change no release explains.
  const run = async (slide2Url, narrationScope) => {
    const dir = mkdtempSync(join(tmpdir(), 'cls-scope-'));
    const url = (i) => (i ? slide2Url : 'https://app.hadrius.com/rules');
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ status: 'captured', steps: [0, 1].map((index) => ({ index, todayUrl: url(index), visibleText: 'Trading Rules\nNew rule' })) }));
    writeFileSync(join(dir, 'compare.json'), JSON.stringify({ steps: [0, 1].map((index) => ({ index, classification: 'screenshot_changed', todayScreenshot: `t${index}.png`, dimensions: { match: true },
      diffFractionNonDynamic: index ? 0.01 : 0.4, ssimMasked: index ? 0.97 : 0.5, regions: [] })) }));
    const script = { name: 'Vid', title: 'Vid', steps: [0, 1].map((index) => ({ index, action: 'navigate', narration: 'Open the rules page.', url: url(index), media: { pre: `r${index}.png` } })) };
    const helpers = { excerpt: () => '+ New rule', filesTouched: () => ['apps/hadrius-app/src/features/rules/view_rules.tsx'], diffLabels: () => ({ added: ['new rule'], removed: ['create rule'] }),
      uiStringsAt: (sha) => (sha === 'b'.repeat(40) ? new Set(['new rule']) : new Set(['create rule'])) };
    const releaseEvidence = { summary: { status: 'ok' }, byStep: { 0: candidateRelease(), 1: { ...candidateRelease(), status: 'no_release_touched_screen', commits: [] } }, ...helpers };
    const asked = [];
    const judge = async (i) => { asked.push(i.stepNumber); return { accurate: true, data_missing: false, claim_missing: false, reason: 'ok' }; };
    const report = await cls.classifyRun({ runDir: dir, script, recordingsDir: join(dir, 'rec'), releaseEvidence, redesignJudge: async () => parseRedesignJudge(answer()), judge, write: false, narrationScope });
    return { asked, report };
  };
  // Another page: out of the weekly scope.
  const other = await run('https://app.hadrius.com/reports', 'ui_confirmed');
  assert.deepEqual(other.asked, [1], 'only the release-confirmed slide');
  assert.equal(other.report.steps[1].verdict, 'narration_review');
  assert.match(other.report.steps[1].reasons.find((r) => r.code === 'narration_unchecked').detail, /outside the weekly scope/);
  // Same page as the confirmed change: judged in the second pass (it may be replaced along with slide 1).
  const same = await run('https://app.hadrius.com/rules', 'ui_confirmed');
  assert.deepEqual(same.asked, [1, 2]);
  assert.ok(!same.report.steps[1].reasons.some((r) => r.code === 'narration_unchecked'));
  // The full audit still asks about every changed slide.
  assert.deepEqual((await run('https://app.hadrius.com/reports', 'all')).asked, [1, 2]);
});

test('the cap reaches the weekly child process and rejects malformed values before any run', async () => {
  assert.deepEqual(weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'], maxModelCalls: 40 }).slice(-2), ['--max-model-calls', '40']);
  assert.equal(weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'], noRehearse: true }).at(-1), '--no-rehearse');
  assert.ok(!weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'] }).some((x) => /rehearse/.test(x)), 'rehearsal is the weekly default');
  assert.ok(!weeklyArgs({ weeklyPath: 'w.mjs', outDir: '/o', names: ['A'] }).includes('--max-model-calls'));
  await assert.rejects(weeklyMain(['--once', '--names', 'A', '--max-model-calls', 'lots']), /whole number/);
});
