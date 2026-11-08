import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createGroundedReviewers, GROUNDED_REVIEW_SCHEMAS } from '../../tools/drift/grounded-review-provider.mjs';
import { runCodexReview } from '../../tools/drift/codex-review.mjs';
import { buildJudgePrompt, parseJudge } from '../../tools/drift/classify.mjs';
import { buildRedesignPrompt, parseRedesignJudge, reviewRedesign } from '../../tools/drift/redesign-judge.mjs';

const MODEL = 'gpt-6.1-sol';
const narrationRaw = { accurate: true, claim_missing: false, data_missing: false,
  reason: 'The narrated Settings control is visible.', evidence: 'Settings', suggested_rewrite: null };
const redesignRaw = { redesigned: true, changes: [{ element: 'Section label', kind: 'renamed',
  before: 'Old settings', after: 'Settings', commit: 'abcdef123456' }], data_differences: [], reason: 'The section label changed.' };
function fixture(t) {
  const scratch = process.env.TMPDIR || join(homedir(), '.hermes/cache/scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'grounded-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recordedPath = join(root, 'recorded original.png'), todayPath = join(root, 'today original.png');
  writeFileSync(recordedPath, 'recorded test bytes'); writeFileSync(todayPath, 'today test bytes');
  const cacheDir = join(root, 'durable-cache');
  const judgeInput = { title: 'Settings walkthrough', stepNumber: 1, stepCount: 2, action: 'click',
    targetName: 'Settings', narration: 'Click Settings.', todayPath, todayText: 'Settings', todayTitle: 'Settings', todayUrl: 'https://example.invalid/settings' };
  const redesignInput = { title: judgeInput.title, stepNumber: 1, stepCount: 2, recordedPath, todayPath,
    todayText: 'Settings', commits: [{ sha: 'abcdef1234567890', files: ['settings.tsx'], subject: 'Rename section', excerpt: '-"Old settings"\n+"Settings"' }] };
  return { root, cacheDir, recordedPath, todayPath, judgeInput, redesignInput };
}
function processAdapter(calls, rawOf = kind => kind === 'narration' ? narrationRaw : redesignRaw) {
  return async (binary, args, options) => {
    const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
    const kind = schema.properties.accurate ? 'narration' : 'redesign';
    calls.push({ binary, args, options, schema, kind });
    writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(rawOf(kind)));
    return { stdout: '', stderr: `model: ${args[args.indexOf('--model') + 1]}\n` };
  };
}
const injected = (run, inspect = () => {}) => async options => { inspect(options); return runCodexReview({ ...options, run }); };

// Every model-shaped invocation below is injected. No live CLI, browser, capture, media or publisher runs.
test('import and construction are inert; provider settings fail before any adapter/discovery', () => {
  const path = new URL('../../tools/drift/grounded-review-provider.mjs', import.meta.url).href;
  const source = `import {createRequire, syncBuiltinESMExports} from 'node:module';
    const require=createRequire(import.meta.url);
    const fail=()=>{throw Error('unexpected side effect')};
    const child=require('node:child_process'); child.spawn=fail; child.spawnSync=fail;
    const fs=require('node:fs'); fs.mkdirSync=fail; fs.writeFileSync=fail;
    syncBuiltinESMExports(); const m=await import(${JSON.stringify(path)});
    const r=m.createGroundedReviewers(); if(r.hold!==null||r.status().state!=='ready') throw Error('bad status');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let called = 0;
  const options = { runReview: () => { called++; }, resolveBinary: () => { called++; } };
  for (const bad of [{ provider: 'claude' }, { provider: 'codex-cli' }, { model: 'claude-sonnet-5' },
    { model: ' gpt-6.1-sol' }, { model: 'gpt-6.1-sol --dangerously-bypass-approvals' }, { effort: 'max' },
    { binary: '' }, { cacheDir: '' }, { timeoutMs: 0 }, { runReview: null }]) {
    assert.throws(() => createGroundedReviewers({ ...options, ...bad }), /grounded_review_/);
  }
  assert.equal(called, 0);
});

test('actual builder inputs attach TODAY only or RECORDED then TODAY; hardening and parsers are retained', async t => {
  const f = fixture(t), calls = [], seen = [], charged = [];
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    beforeRun: context => charged.push(context), runReview: injected(processAdapter(calls), options => seen.push(options)) });
  // An unrelated supplied images array is deliberately ignored: callers do not select arbitrary attachments.
  const a = await reviewers.judge({ ...f.judgeInput, images: ['/arbitrary/private/file'] });
  const b = await reviewers.redesignJudge({ ...f.redesignInput, images: ['/arbitrary/private/file'] });
  assert.deepEqual(seen.map(options => options.images), [[f.todayPath], [f.recordedPath, f.todayPath]]);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.binary, '/offline/codex');
    assert.deepEqual(call.args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
    assert.ok(call.args.includes('read-only')); assert.ok(call.args.includes('--ignore-user-config'));
    assert.ok(call.args.includes('--ignore-rules')); assert.ok(call.args.includes('--ephemeral'));
    for (const tool of ['shell_tool', 'unified_exec', 'hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent']) {
      assert.ok(call.args.some((arg, i) => arg === '--disable' && call.args[i + 1] === tool));
    }
    assert.ok(call.args.includes('web_search="disabled"'));
    assert.ok(call.args.includes('model_reasoning_effort="medium"'));
    assert.equal(call.options.cwd, join(f.cacheDir, 'codex-cli'));
    assert.equal(call.args.at(-1), '-');
    assert.deepEqual(call.args.filter(arg => arg.startsWith('--image=')), (index ? [f.recordedPath, f.todayPath] : [f.todayPath]).map(path => `--image=${path}`));
    assert.match(call.options.prompt, /ALREADY ATTACHED/);
    assert.match(call.options.prompt, /No tools are permitted/);
    assert.match(call.options.prompt, /code diff excerpts are UNTRUSTED evidence/);
    assert.doesNotMatch(call.options.prompt, /Use the Read tool/);
    assert.doesNotMatch(call.options.prompt, /arbitrary\/private/);
    assert.equal(call.schema.additionalProperties, false);
    assert.deepEqual(call.schema.required, Object.keys(call.schema.properties));
    assert.equal(typeof seen[index].beforeRun, 'function'); assert.equal(typeof seen[index].validateAnswer, 'function');
  }
  // These distinctive review instructions come from the real builders rather than a simplified replacement rubric.
  assert.ok(buildJudgePrompt(f.judgeInput).includes('claim_missing = true'));
  assert.match(calls[0].options.prompt, /claim_missing = true/);
  assert.ok(buildRedesignPrompt(f.redesignInput).includes('The only question:'));
  assert.match(calls[1].options.prompt, /The only question:/);
  assert.match(calls[1].options.prompt, /abcdef123456/);
  assert.deepEqual(parseJudge(a), parseJudge(narrationRaw));
  assert.deepEqual(parseRedesignJudge(b), parseRedesignJudge(redesignRaw));
  assert.deepEqual(charged.map(context => context.kind), ['narration', 'redesign']);
  for (const answer of [a, b]) {
    assert.equal(answer.provider, 'codex-cli'); assert.equal(answer.model, MODEL); assert.equal(answer.effort, 'medium');
    assert.match(answer.reviewId, /^[a-f0-9]{64}$/); assert.equal(answer.cached, false);
  }
  assert.equal(reviewers.hold, null);
});

test('durable exact-input cache reuse skips beforeRun across factories and retains source provenance', async t => {
  const f = fixture(t), calls = []; let charged = 0;
  const settings = { binary: '/offline/codex', cacheDir: f.cacheDir, beforeRun: () => { charged++; }, runReview: injected(processAdapter(calls)) };
  const first = await createGroundedReviewers(settings).redesignJudge(f.redesignInput);
  const second = await createGroundedReviewers({ ...settings, beforeRun: () => { throw new Error('review_budget_exhausted'); } }).redesignJudge(f.redesignInput);
  assert.equal(second.cached, true); assert.equal(second.reviewId, first.reviewId);
  assert.equal(second.createdAt, first.createdAt); assert.equal(second.cacheSource, 'codex-review-checkpoint');
  assert.equal(second.provider, first.provider); assert.equal(second.model, first.model); assert.equal(second.effort, first.effort);
  assert.equal(charged, 1); assert.equal(calls.length, 1);
  const changedPrompt = await createGroundedReviewers(settings).redesignJudge({ ...f.redesignInput, todayText: 'Settings\nNew label' });
  assert.notEqual(changedPrompt.reviewId, first.reviewId);
  writeFileSync(f.todayPath, 'changed today bytes');
  const changedImage = await createGroundedReviewers(settings).redesignJudge(f.redesignInput);
  assert.notEqual(changedImage.reviewId, first.reviewId);
  const changedEffort = await createGroundedReviewers({ ...settings, effort: 'high' }).redesignJudge(f.redesignInput);
  const changedModel = await createGroundedReviewers({ ...settings, model: 'gpt-6.1' }).redesignJudge(f.redesignInput);
  assert.notEqual(changedEffort.reviewId, changedImage.reviewId); assert.notEqual(changedModel.reviewId, changedImage.reviewId);
  const changedOrder = await createGroundedReviewers(settings).redesignJudge({ ...f.redesignInput, recordedPath: f.todayPath, todayPath: f.recordedPath });
  assert.notEqual(changedOrder.reviewId, changedImage.reviewId); assert.equal(calls.length, 6);
  const schemas = calls.map(call => call.schema);
  assert.deepEqual(schemas[0], GROUNDED_REVIEW_SCHEMAS.redesign);
});

test('caller beforeRun controls real spend; a local budget hold remains pending without tripping the provider circuit', async t => {
  const f = fixture(t), calls = []; let allow = false, callbacks = 0;
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    beforeRun: () => { callbacks++; if (!allow) throw new Error('review_budget_exhausted'); }, runReview: injected(processAdapter(calls)) });
  const pending = await reviewers.judge(f.judgeInput);
  assert.equal(pending.pending, 'review_budget_exhausted'); assert.equal(pending.error, 'review_budget_exhausted');
  assert.equal(calls.length, 0); assert.equal(reviewers.hold, null); assert.equal(callbacks, 1);
  allow = true;
  const answer = await reviewers.judge(f.judgeInput);
  assert.equal(answer.accurate, true); assert.equal(calls.length, 1); assert.equal(callbacks, 2);
  const cached = await reviewers.judge(f.judgeInput);
  assert.equal(cached.cached, true); assert.equal(callbacks, 2);
  assert.equal(reviewers.status().liveCalls, 1);
});

test('wrong provider, model or effort metadata from an injected adapter is rejected, never relabeled', async t => {
  const f = fixture(t);
  for (const patch of [{ provider: 'claude' }, { provider: undefined }, { model: 'claude-sonnet-5' },
    { model: 'gpt-other' }, { effort: 'high' }, { effort: undefined }]) {
    const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
      runReview: async options => {
        await options.beforeRun(); options.validateAnswer(narrationRaw);
        return { provider: 'codex-cli', model: MODEL, effort: 'medium', key: 'a'.repeat(64), raw: narrationRaw, cached: false, ...patch };
      } });
    const answer = await reviewers.judge(f.judgeInput);
    assert.equal(answer.pending, 'review_metadata_invalid'); assert.equal(answer.accurate, undefined);
    assert.equal(answer.reviewId, undefined); assert.equal(reviewers.hold, null);
  }
});

test('cached metadata is checked, including provider not checked by the underlying checkpoint reader', async t => {
  for (const patch of [{ provider: 'claude' }, { model: 'gpt-other' }, { effort: 'high' }]) {
    const f = fixture(t), calls = [];
    const settings = { binary: '/offline/codex', cacheDir: f.cacheDir, runReview: injected(processAdapter(calls)) };
    await createGroundedReviewers(settings).judge(f.judgeInput);
    const directory = join(f.cacheDir, 'codex-cli');
    const checkpoint = join(directory, readdirSync(directory).find(name => name.endsWith('.review.json')));
    writeFileSync(checkpoint, JSON.stringify({ ...JSON.parse(readFileSync(checkpoint, 'utf8')), ...patch }));
    const answer = await createGroundedReviewers(settings).judge(f.judgeInput);
    assert.equal(answer.pending, 'review_metadata_invalid'); assert.equal(calls.length, 1);
  }
});

test('one authentication failure stops subsequent and concurrently queued narration/redesign requests', async t => {
  const f = fixture(t); let invocations = 0, callbacks = 0;
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    beforeRun: () => { callbacks++; }, runReview: async options => {
      invocations++; await options.beforeRun(); await new Promise(resolve => setImmediate(resolve));
      throw new Error('codex_review_failed: 401 Unauthorized: Not logged in');
    } });
  const answers = await Promise.all([reviewers.judge(f.judgeInput), reviewers.redesignJudge(f.redesignInput), reviewers.judge({ ...f.judgeInput, narration: 'Next screen.' })]);
  assert.equal(invocations, 1); assert.equal(callbacks, 1);
  for (const answer of answers) {
    assert.equal(answer.pending, 'review_provider_auth_unavailable'); assert.equal(answer.accurate, undefined); assert.equal(answer.redesigned, undefined);
  }
  assert.equal(reviewers.status().state, 'held'); assert.equal(reviewers.hold.reason, 'review_provider_auth_unavailable');
  assert.equal(reviewers.status().liveCalls, 1); assert.equal(reviewers.status().pending, 3);
});

test('quota, unavailable model, spawn ENOENT and offline discovery failure have typed shared circuit reasons', async t => {
  const f = fixture(t);
  const cases = [
    [new Error("codex_review_failed: You've hit your usage limit"), 'review_provider_quota_exhausted'],
    [Object.assign(new Error('Request rejected'), { code: 'insufficient_quota' }), 'review_provider_quota_exhausted'],
    [new Error('The model gpt-6.1-sol is not supported for this account'), 'review_provider_model_unavailable'],
    [Object.assign(new Error('spawn /missing/codex ENOENT'), { code: 'ENOENT', syscall: 'spawn /missing/codex' }), 'review_provider_not_installed'],
  ];
  for (const [error, reason] of cases) {
    let calls = 0;
    const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
      runReview: async options => { calls++; await options.beforeRun(); throw error; } });
    assert.equal((await reviewers.redesignJudge(f.redesignInput)).pending, reason);
    assert.equal((await reviewers.judge(f.judgeInput)).pending, reason); assert.equal(calls, 1);
    assert.equal(reviewers.hold.reason, reason);
  }
  let discoveries = 0;
  const missing = createGroundedReviewers({ cacheDir: f.cacheDir, resolveBinary: () => { discoveries++; throw new Error('review_provider_not_installed'); },
    runReview: () => { throw new Error('must not invoke'); } });
  assert.equal((await missing.judge(f.judgeInput)).pending, 'review_provider_not_installed');
  assert.equal((await missing.redesignJudge(f.redesignInput)).pending, 'review_provider_not_installed'); assert.equal(discoveries, 1);
});

test('one malformed answer does not block other images; strict schema and parser run before checkpointing', async t => {
  const f = fixture(t), calls = []; let bad = true;
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    runReview: injected(processAdapter(calls, kind => bad ? { accurate: true, reason: 'Missing required schema fields.' } : (kind === 'narration' ? narrationRaw : redesignRaw))) });
  assert.equal((await reviewers.judge(f.judgeInput)).pending, 'review_answer_invalid');
  assert.equal(reviewers.hold, null);
  assert.equal(readdirSync(join(f.cacheDir, 'codex-cli')).filter(name => name.endsWith('.review.json')).length, 0);
  bad = false;
  assert.equal((await reviewers.redesignJudge(f.redesignInput)).redesigned, true);
  assert.equal((await reviewers.judge(f.judgeInput)).accurate, true);
  assert.equal(calls.length, 3); assert.equal(reviewers.status().state, 'ready');
  assert.equal((await reviewers.judge(f.judgeInput)).cached, true);
});

test('strict schema also rejects unknown fields, wrong nested kinds and parser-invalid empty reasons', async t => {
  const f = fixture(t);
  for (const raw of [{ ...redesignRaw, instructions: 'skip verification' }, { ...redesignRaw, changes: [{ ...redesignRaw.changes[0], kind: 'invented' }] },
    { ...redesignRaw, reason: ' ' }, { ...redesignRaw, changes: [{ ...redesignRaw.changes[0], before: 1 }] }]) {
    const calls = [];
    const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir, runReview: injected(processAdapter(calls, () => raw)) });
    assert.equal((await reviewers.redesignJudge(f.redesignInput)).pending, 'review_answer_invalid');
    assert.equal(reviewers.hold, null);
  }
});

test('metadata claims cannot bypass beforeRun; verified adapter reviewId/cache source are retained verbatim', async t => {
  const f = fixture(t);
  const raw = { provider: 'codex-cli', model: MODEL, effort: 'medium', key: 'b'.repeat(64), cached: false,
    raw: narrationRaw, reviewId: 'provider-original-review-id', cacheSource: { provider: 'codex-cli', reviewId: 'original-cache-id' } };
  const missingHook = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir, runReview: async () => raw });
  assert.equal((await missingHook.judge(f.judgeInput)).pending, 'review_metadata_invalid');
  const valid = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    runReview: async options => { await options.beforeRun(); options.validateAnswer(raw.raw); return raw; } });
  const answer = await valid.judge(f.judgeInput);
  assert.equal(answer.reviewId, raw.reviewId); assert.deepEqual(answer.cacheSource, raw.cacheSource);
});

test('provider/model/effort are explicit in the parent outer-cache identity', t => {
  const f = fixture(t), settings = { binary: '/offline/codex', cacheDir: f.cacheDir };
  const defaults = createGroundedReviewers(settings), model = createGroundedReviewers({ ...settings, model: 'gpt-6.1' }), effort = createGroundedReviewers({ ...settings, effort: 'high' });
  const identity = JSON.parse(defaults.cacheIdentity);
  assert.deepEqual(identity, { provider: 'codex-cli', model: MODEL, effort: 'medium', version: defaults.version });
  assert.notEqual(model.version, defaults.version); assert.notEqual(effort.version, defaults.version);
  assert.equal(createGroundedReviewers(settings).version, defaults.version);
});

test('default deterministic release verification still rejects an unrelated model claim', async t => {
  const f = fixture(t), calls = [];
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir, runReview: injected(processAdapter(calls)) });
  const evidence = { commits: f.redesignInput.commits, currentSha: 'current', baselineSha: 'baseline', screenFiles: ['settings.tsx'], routeEntryFile: 'settings.tsx' };
  const releaseEvidence = {
    excerpt: () => '+"Unrelated label"', filesTouched: () => ['settings.tsx'],
    uiStringsAt: sha => new Set(sha === 'current' ? ['settings'] : ['old settings']),
    diffLabels: () => ({ added: ['Unrelated label'], removed: [] }),
  };
  const result = await reviewRedesign({ redesignJudge: reviewers.redesignJudge, releaseEvidence, evidence,
    script: { name: 'settings', steps: [{ index: 0 }], title: 'Settings' },
    step: { index: 0, action: 'navigate', narration: 'Settings' }, paths: { recorded: f.recordedPath, today: f.todayPath }, todayText: 'Settings' });
  assert.equal(calls.length, 1); assert.equal(result.redesign.confirmed, false);
  assert.ok(result.redesign.rejected[0].why.includes('not_in_commit_diff'));
  assert.equal(result.redesign.raw.provider, 'codex-cli'); assert.equal(result.redesign.raw.model, MODEL);
  const confirmed = await reviewRedesign({ redesignJudge: reviewers.redesignJudge,
    releaseEvidence: { ...releaseEvidence, diffLabels: () => ({ added: ['Settings'], removed: ['Old settings'] }) }, evidence,
    script: { name: 'settings', steps: [{ index: 0 }], title: 'Settings' },
    step: { index: 0, action: 'navigate', narration: 'Settings' }, paths: { recorded: f.recordedPath, today: f.todayPath }, todayText: 'Settings' });
  assert.equal(confirmed.redesign.confirmed, true);
  assert.equal(confirmed.redesign.raw.cached, true); assert.equal(calls.length, 1);
});

test('a missing image remains pending without poisoning the shared provider circuit', async t => {
  const f = fixture(t), calls = [];
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir, runReview: injected(processAdapter(calls)) });
  const answer = await reviewers.judge({ ...f.judgeInput, todayPath: join(f.root, 'unauthorized missing image.png') });
  assert.equal(answer.reviewStatus, 'pending'); assert.equal(calls.length, 0); assert.equal(reviewers.hold, null);
  assert.equal((await reviewers.judge(f.judgeInput)).accurate, true); assert.equal(calls.length, 1);
});

test('genuine adapter auth failure before its budget callback still stops retries', async t => {
  const f = fixture(t); let calls = 0;
  const reviewers = createGroundedReviewers({ binary: '/offline/codex', cacheDir: f.cacheDir,
    runReview: async () => { calls++; throw Object.assign(new Error('provider refused authentication'), { code: 'AUTHENTICATION_ERROR' }); } });
  assert.equal((await reviewers.judge(f.judgeInput)).pending, 'review_provider_auth_unavailable');
  assert.equal((await reviewers.redesignJudge(f.redesignInput)).pending, 'review_provider_auth_unavailable');
  assert.equal(calls, 1);
});
