import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewRepairs, collectRepairReviewTasks, parseReviewRepairsArgs, SEMANTIC_REPAIR_REVIEW_SCHEMA } from '../../tools/drift/review-repairs.mjs';
import { digest } from '../../tools/drift/contracts.mjs';
import { semanticStepDigest, semanticRepairCheck } from '../../tools/drift/semantic-repair-proof.mjs';
import { verifySemanticRepairAssets } from '../../tools/drift/semantic-repair-assets.mjs';

const scratch = join(homedir(), '.hermes/cache/scratch');
mkdirSync(scratch, { recursive: true });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
function fixture(t, count = 1) {
  const root = mkdtempSync(join(scratch, 'review-repairs-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source'), name = 'Approved-video', reviewPath = join(root, 'review.json');
  const scriptPath = join(root, 'script.json'), captureDir = join(root, 'evidence');
  const script = { name, steps: Array.from({ length: count }, (_, index) => ({ index, action: 'click',
    url: 'https://app.hadrius.com/example?company_id=1150', capture: true, captureId: `capture-${index}`,
    target: { name: 'Rules', role: 'button', bbox: { x: 1, y: 2, w: 3, h: 4 } },
    narration: 'Open the Rules tab to configure the rule.', caption: 'Open the Rules tab to configure the rule.',
    customPreserved: { exact: ['x', 0, false] } })) };
  const changes = [{ kind: 'renamed', element: 'tab', before: 'Old rules', after: 'Rules', sha: 'verified-commit', pr: 1 }];
  mkdirSync(captureDir, { recursive: true });
  const steps = script.steps.map((step, index) => {
    const recorded = join(root, `recorded-${index}.png`), today = join(captureDir, `current-${index}.png`);
    // Valid tiny PNG; its bytes, not its filename, form the binding. No vision process is used in tests.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    writeFileSync(recorded, png); writeFileSync(today, png);
    return { index, action: step.action, verdict: 'narration_review', reasons: [{ code: 'narration_unchecked', verdict: 'narration_review' }],
      target: { status: 'resolved', recordedName: 'Old rules', todayName: 'Rules' }, guard: null,
      uiContext: { route: step.url, visibleText: 'Rules\nConfigure a rule' }, evidence: { recorded, today } };
  });
  const job = { name, status: 'ok', scriptPath, scriptHash: digest(script), steps,
    uiSelection: { slides: [{ index: 0, changes }], repair: { blockers: [] } } };
  const run = { signedIn: true, tenantVerified: true, steps: steps.map(step => ({ index: step.index, action: 'click',
    screenshot: `current-${step.index}.png`, todayUrl: script.steps[step.index].url, visibleText: 'Rules\nConfigure a rule',
    target: { status: 'resolved', resolved: { name: 'Rules', role: 'button', recordHint: null } } })) };
  const review = { flagged: [{ name, slides: [{ index: 0, changes }] }] };
  const jobPath = join(sourceDir, name, 'job.json'), runPath = join(captureDir, 'run.json');
  const save = () => { write(scriptPath, script); job.scriptHash = digest(script); write(jobPath, job); write(runPath, run); write(reviewPath, review); };
  save();
  write(join(sourceDir, 'summary.json'), { names: [name] });
  write(join(sourceDir, 'selection-parity.json'), { acceptedPairs: [`${name}#0`] });
  return { root, sourceDir, name, reviewPath, scriptPath, script, jobPath, job, runPath, run, changes, review, save,
    options: { sourceDir, reviewPath, outDir: join(root, 'out'), binary: '/explicit/fake-codex', maxModelCalls: 10 } };
}
function bindingOf(input) {
  return JSON.parse(input.prompt.split('BINDING_JSON_BEGIN\n')[1].split('\nBINDING_JSON_END')[0]);
}
function positive(input) {
  const binding = bindingOf(input);
  const common = { reason: 'The current Rules tab opens the same rule configuration task.', evidence: 'Rules and Configure a rule are visible in the current image.', recordsIndependent: true };
  return { schema: 'semantic-repair-review-v1', bindingDigest: binding.digest,
    workflow: { status: 'equivalent', ...common },
    narration: { status: 'accurate', suggestedNarration: null, preservesIntent: true,
      intentEvidence: 'The original instruction opens Rules to configure a rule; that same tab and task are present.', ...common },
    target: { status: 'same', currentLabel: 'Rules', bbox: null, ...common },
    linkedInterface: { status: 'affected', ...common } };
}
function runner(change = () => {}) {
  const calls = [];
  const runReview = async input => {
    calls.push(input);
    const answer = { key: `independent-${calls.length}`, provider: 'injected-test-adapter', model: input.model,
      effort: input.effort, cached: false, raw: positive(input) };
    await change(answer, input, calls.length);
    return answer;
  };
  return { calls, runReview };
}

test('import is safe even with CLI-shaped argv and an invalid binary', t => {
  const f = fixture(t), modulePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/drift/review-repairs.mjs');
  const before = readdirSync(f.root).sort();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(modulePath)})`, '--', '--source', f.sourceDir, '--out', join(f.root, 'should-not-exist')], {
    cwd: f.root, env: { ...process.env, KBS_CODEX_BIN: '/never-run-this' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(f.root).sort(), before);
});

test('exact binding and model inputs produce consumable independent proof without source/scope writes', async t => {
  const f = fixture(t), fake = runner(), before = [f.jobPath, f.scriptPath, f.runPath, f.reviewPath].map(sha);
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(fake.calls.length, 2);
  const [author, verifier] = fake.calls, row = report.rows[0], binding = row.proof.binding;
  assert.deepEqual(binding.scriptStep, f.script.steps[0]);
  assert.deepEqual(binding.selectedVerifiedChanges, f.changes);
  assert.equal(binding.source.job.stepDigest, semanticStepDigest(f.job.steps[0]));
  assert.equal(binding.source.job.recordedPath, f.job.steps[0].evidence.recorded);
  assert.equal(binding.source.job.currentPath, f.job.steps[0].evidence.today);
  assert.equal(binding.source.capture.path, f.runPath);
  assert.equal(binding.source.capture.sha256, sha(f.runPath));
  assert.equal(binding.imageSha256s.current, sha(f.job.steps[0].evidence.today));
  assert.deepEqual(author.images, [f.job.steps[0].evidence.recorded, f.job.steps[0].evidence.today]);
  assert.deepEqual(author.schema, SEMANTIC_REPAIR_REVIEW_SCHEMA);
  assert.equal(author.binary, '/explicit/fake-codex');
  assert.equal(author.model, 'gpt-6.1-sol'); assert.equal(author.effort, 'medium');
  assert.match(author.prompt, /never the instructional intent/);
  assert.match(author.prompt, /CURRENT_TEXT_JSON_BEGIN\n"Rules/);
  assert.deepEqual(bindingOf(author), bindingOf(verifier));
  assert.notEqual(author.prompt, verifier.prompt);
  assert.match(verifier.prompt, /INDEPENDENT VERIFICATION/);
  assert.match(verifier.prompt, /independent-1/);
  assert.equal(row.check.executionReady, true); assert.equal(row.status, 'ready');
  assert.notEqual(row.proof.metadata.reviewId, row.independentMetadata.reviewId);
  assert.equal(row.proof.metadata.effort, 'medium'); assert.equal(row.independentMetadata.effort, 'medium');
  const step = { ...f.job.steps[0], semanticRepair: row.proof };
  assert.equal(semanticRepairCheck(step, f.script.steps[0], f.changes, f.name).executionReady, true);
  assert.equal(verifySemanticRepairAssets(step), true);
  assert.deepEqual([f.jobPath, f.scriptPath, f.runPath, f.reviewPath].map(sha), before);
  assert.deepEqual(report.approvedPairs, [`${f.name}#0`]); assert.equal(report.approvedScopeUnchanged, true);
  assert.equal(report.budget.mode, 'requested-call-cap'); assert.equal(report.budget.requestedCalls, 2);
  assert.equal('costUsd' in report, false);
  assert.deepEqual(read(join(f.options.outDir, 'report.json')), report);
  assert.equal(readdirSync(join(f.options.outDir, 'checkpoints')).length, 3);
});

test('inventory includes same-page, blocker-only and no-capture/absent source rows, not unrelated scope', async t => {
  const f = fixture(t, 5);
  f.script.steps[2].url = 'https://app.hadrius.com/unrelated';
  f.script.steps[3].url = 'https://app.hadrius.com/blocker-only';
  f.job.uiSelection.repair.blockers = [{ code: 'linked_slide_unproven', slides: [3, 8], items: [] }];
  f.job.steps[4].evidence.today = null;
  f.save();
  const inventory = collectRepairReviewTasks(f.options);
  assert.deepEqual(inventory.tasks.map(x => x.index), [0, 1, 3, 4, 8]);
  const fake = runner(), report = await reviewRepairs({ ...f.options, maxModelCalls: 0, runReview: fake.runReview });
  assert.equal(fake.calls.length, 0);
  assert.equal(report.rows.length, 5);
  assert.equal(report.rows.find(x => x.index === 4).check.reasons[0], 'current_image_missing');
  assert.equal(report.rows.find(x => x.index === 8).check.reasons[0], 'script_step_missing');
  assert.equal(report.rows.find(x => x.index === 3).selected, false);
  assert.deepEqual(report.approvedPairs, [`${f.name}#0`]);
  assert.equal(report.counts.pending, 5);
});

for (const image of ['recorded', 'today']) test(`missing ${image} screenshot stays pending with no model request`, async t => {
  const f = fixture(t), fake = runner();
  rmSync(f.job.steps[0].evidence[image]);
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(fake.calls.length, 0); assert.equal(report.counts.ready, 0); assert.equal(report.counts.pending, 1);
  assert.equal(report.counts.errors, 0); assert.equal(report.rows[0].omitted, true);
});

test('unknown author blocks without a verifier', async t => {
  const f = fixture(t), fake = runner(answer => { answer.raw.workflow.status = 'unknown'; });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(fake.calls.length, 1); assert.equal(report.rows[0].status, 'pending');
  assert.deepEqual(report.rows[0].check.reasons, ['workflow_unknown']);
});

test('names filter limits model requests only after preserving the entire approved inventory', async t => {
  const f = fixture(t), fake = runner(), other = 'Other-approved-video';
  const script = {...structuredClone(f.script),name:other}, scriptPath=join(f.root,'other-script.json');
  const job={...structuredClone(f.job),name:other,scriptPath,scriptHash:digest(script)};
  write(scriptPath,script);write(join(f.sourceDir,other,'job.json'),job);
  f.review.flagged.push({name:other,slides:[{index:0,changes:f.changes}]});write(f.reviewPath,f.review);
  write(join(f.sourceDir,'summary.json'),{names:[f.name,other]});
  write(join(f.sourceDir,'selection-parity.json'),{acceptedPairs:[`${f.name}#0`,`${other}#0`]});
  const report=await reviewRepairs({...f.options,names:[f.name],runReview:fake.runReview});
  assert.equal(fake.calls.length,2);assert.equal(report.approvedPairs.length,2);assert.equal(report.rows.length,2);
  assert.equal(report.rows.find(r=>r.name===other).check.reasons[0],'not_requested');
  await assert.rejects(()=>reviewRepairs({...f.options,outDir:join(f.root,'invalid'),names:['unapproved']}),/outside_approved_scope/);
});

test('detached flow success cannot be presented to either reviewer as verified evidence', async t => {
  const f=fixture(t),fake=runner();f.job.steps[0].flowEquivalence={verified:true};f.save();
  const report=await reviewRepairs({...f.options,runReview:fake.runReview});
  assert.equal(fake.calls.length,0);assert.equal(report.counts.ready,0);
  assert.match(report.rows[0].error,/flow_equivalence_binding_invalid/);
});

for (const failure of ['malformed', 'runner-error']) test(`${failure} is checkpointed as pending, never silently dropped`, async t => {
  const f = fixture(t), fake = runner(answer => {
    if (failure === 'runner-error') throw new Error('codex_output_limit');
    answer.raw = '{not json';
  });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(report.counts.pending, 1); assert.equal(report.counts.errors, 1); assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].status, 'pending');
  assert.match(report.rows[0].error, /review_invalid_json|codex_output_limit/);
  assert.equal(report.budget.requestedCalls, 1);
  if (failure === 'malformed') assert.equal(read(join(f.options.outDir, 'checkpoints/0-author.json')).answer.raw, '{not json');
});

test('zero is the default; a one-request cap cannot authorize an unchecked proposal', async t => {
  const f = fixture(t), fake = runner();
  const zero = await reviewRepairs({ ...f.options, maxModelCalls: undefined, runReview: fake.runReview });
  assert.equal(fake.calls.length, 0); assert.deepEqual(zero.rows[0].check.reasons, ['model_call_limit']);
  const one = await reviewRepairs({ ...f.options, outDir: join(f.root, 'one'), maxModelCalls: 1, runReview: fake.runReview });
  assert.equal(fake.calls.length, 1); assert.equal(one.counts.errors, 0);
  assert.equal(one.rows[0].proof.review.workflow.status, 'equivalent');
  assert.equal(one.rows[0].proof.verification, null); assert.equal(one.rows[0].check.executionReady, false);
  assert.deepEqual(one.rows[0].check.reasons, ['model_call_limit']);
});

test('cache hits consume the explicitly pessimistic cap', async t => {
  const f = fixture(t), fake = runner(answer => { answer.cached = true; });
  const report = await reviewRepairs({ ...f.options, maxModelCalls: 1, runReview: fake.runReview });
  assert.equal(report.budget.cachedAnswers, 1); assert.equal(report.budget.requestedCalls, 1);
  assert.equal(report.rows[0].check.executionReady, false);
});

test('the request cap is shared across slides, not reset per author or video', async t => {
  const f = fixture(t, 3), fake = runner();
  const report = await reviewRepairs({ ...f.options, maxModelCalls: 3, runReview: fake.runReview });
  assert.equal(fake.calls.length, 3); assert.equal(report.budget.requestedCalls, 3);
  assert.equal(report.counts.ready, 1); assert.equal(report.counts.pending, 2);
  assert.equal(report.rows[1].proof.verification, null); assert.equal(report.rows[2].proof.review, null);
});

test('a wrong author binding is not independently verified or attached', async t => {
  const f = fixture(t), fake = runner(answer => { answer.raw.bindingDigest = 'b'.repeat(64); });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(fake.calls.length, 1); assert.equal(report.counts.ready, 0);
  assert.deepEqual(report.rows[0].check.reasons, ['review_binding_mismatch']);
});

test('a failed checker retains its author proof and a pending error row', async t => {
  const f = fixture(t), fake = runner((answer, input, n) => { if (n === 2) throw new Error('codex_review_timeout'); });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(report.rows[0].proof.metadata.reviewId, 'independent-1');
  assert.equal(report.rows[0].proof.review.workflow.status, 'equivalent');
  assert.equal(report.rows[0].proof.verification, null); assert.equal(report.counts.errors, 1);
  assert.equal(report.rows[0].check.executionReady, false);
});

for (const kind of ['same-id', 'unknown', 'wrong-binding', 'wrong-target', 'wrong-linked', 'intent-false', 'bad-effort', 'malformed']) {
  test(`independent verifier ${kind} cannot confer readiness`, async t => {
    const f = fixture(t), fake = runner((answer, input, n) => {
      if (n !== 2) return;
      if (kind === 'same-id') answer.key = 'independent-1';
      if (kind === 'unknown') answer.raw.workflow.status = 'unknown';
      if (kind === 'wrong-binding') answer.raw.bindingDigest = 'a'.repeat(64);
      if (kind === 'wrong-target') answer.raw.target.currentLabel = 'Other';
      if (kind === 'wrong-linked') answer.raw.linkedInterface.status = 'not_affected';
      if (kind === 'intent-false') answer.raw.narration.preservesIntent = false;
      if (kind === 'bad-effort') answer.effort = 'high';
      if (kind === 'malformed') answer.raw.narration.untrustedExtra = true;
    });
    const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
    assert.equal(fake.calls.length, 2); assert.equal(report.counts.ready, 0); assert.equal(report.counts.pending, 1);
    if (kind === 'same-id') assert.deepEqual(report.rows[0].check.reasons, ['verification_not_independent']);
  });
}

test('intent-preserving rewrite requires the checker to return the exact proposed text', async t => {
  const f = fixture(t), text = 'Open Rules to configure the rule.';
  const fake = runner(answer => { answer.raw.narration.status = 'rewrite'; answer.raw.narration.suggestedNarration = text; });
  const ready = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(ready.counts.ready, 1); assert.equal(ready.rows[0].proof.verification.narration.text, text);
  const different = runner((answer, input, n) => { answer.raw.narration.status = 'rewrite'; answer.raw.narration.suggestedNarration = n === 1 ? text : 'Look at Rules.'; });
  const blocked = await reviewRepairs({ ...f.options, outDir: join(f.root, 'different'), runReview: different.runReview });
  assert.equal(blocked.counts.ready, 0);
  assert.deepEqual(blocked.rows[0].check.reasons, ['verification_narration_not_verified']);
});

for (const kind of ['prerequisite', 'guarded', 'direct-navigation-gap', 'loading', 'record-gap', 'signed-out', 'empty-record-specific', 'unknown-page']) {
  test(`capture ${kind} is not assumed to be a verified task`, async t => {
    const f = fixture(t), cap = f.run.steps[0];
    if (kind === 'prerequisite') cap.prerequisiteUnverified = true;
    if (kind === 'guarded') cap.mutationGuard = { status: 'needs_fixture', performed: false };
    if (kind === 'direct-navigation-gap') cap.mutationGuard = { status: 'captured_by_direct_navigation', performed: false };
    if (kind === 'loading') cap.pageState = 'loading';
    if (kind === 'record-gap') f.job.steps[0].reasons.push({ code: 'record_not_visible' });
    if (kind === 'signed-out') f.run.signedIn = false;
    if (kind === 'empty-record-specific') { cap.visibleText = 'No results.'; cap.target.resolved.recordHint = { id: '5' }; }
    if (kind === 'unknown-page') cap.visibleText = '';
    f.save();
    const fake = runner(), report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
    assert.equal(fake.calls.length, 0); assert.equal(report.counts.pending, 1); assert.equal(report.counts.errors, 0);
    assert.equal(report.rows[0].omitted, true);
    assert.match(report.rows[0].check.reasons[0], /capture_not_verified/);
    if (kind === 'record-gap') assert.equal(report.rows[0].proof.binding.captureContext.taskContext, 'missing_prerequisite');
  });
}

test('an absent job still creates selected pending rows', async t => {
  const f = fixture(t), fake = runner(); rmSync(f.jobPath);
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].name, f.name);
  assert.equal(report.counts.pending, 1); assert.equal(fake.calls.length, 0);
});

test('source image changed during an answer invalidates its binding', async t => {
  const f = fixture(t), fake = runner(() => writeFileSync(f.job.steps[0].evidence.today, 'changed'));
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(fake.calls.length, 1); assert.equal(report.counts.ready, 0);
  assert.match(report.rows[0].error, /review_source_changed/);
});

test('a later review cannot leave earlier proofs ready after mutating shared capture evidence', async t => {
  const f = fixture(t, 2), fake = runner((answer, input, n) => {
    if (n === 3) writeFileSync(f.job.steps[0].evidence.today, 'changed after first proof');
  });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(report.rows[0].check.executionReady, false);
  assert.deepEqual(report.rows[0].check.reasons, ['review_source_changed']);
});

test('changing approved scope is rejected before output creation', async t => {
  const f = fixture(t), fake = runner();
  write(join(f.sourceDir, 'selection-parity.json'), { acceptedPairs: [`${f.name}#1`] });
  await assert.rejects(reviewRepairs({ ...f.options, runReview: fake.runReview }), /approved_selection_changed/);
  assert.equal(existsSync(f.options.outDir), false); assert.equal(fake.calls.length, 0);
});

test('existing output, invalid limits, and missing explicit binary fail closed', async t => {
  const f = fixture(t), fake = runner();
  for (const maxModelCalls of [-1, NaN, 1.5]) await assert.rejects(reviewRepairs({ ...f.options, maxModelCalls, runReview: fake.runReview }), /invalid_max_model_calls/);
  await assert.rejects(reviewRepairs({ ...f.options, binary: '', runReview: fake.runReview }), /codex_bin_required/);
  mkdirSync(f.options.outDir);
  await assert.rejects(reviewRepairs({ ...f.options, runReview: fake.runReview }), /output_exists/);
  assert.equal(fake.calls.length, 0);
});

test('duplicate approved indices and changed script hashes fail closed without a call', async t => {
  const f = fixture(t), fake = runner();
  f.review.flagged[0].slides.push(f.review.flagged[0].slides[0]); f.save();
  await assert.rejects(reviewRepairs({ ...f.options, runReview: fake.runReview }), /approved_review_invalid_index/);
  assert.equal(existsSync(f.options.outDir), false);
  f.review.flagged[0].slides.pop(); f.save();
  write(f.scriptPath, { ...f.script, extra: 'different source' });
  const report = await reviewRepairs({ ...f.options, runReview: fake.runReview });
  assert.equal(report.counts.ready, 0); assert.equal(fake.calls.length, 0);
  assert.match(report.rows[0].error, /source_script_hash_mismatch/);
});

test('CLI parses explicit binary or env without enabling calls implicitly', () => {
  const args = ['--source', '/source', '--review', '/review.json', '--out', '/new'];
  assert.deepEqual(parseReviewRepairsArgs(args, { KBS_CODEX_BIN: '/env/codex' }), { sourceDir: '/source', reviewPath: '/review.json', outDir: '/new', binary: '/env/codex', maxModelCalls: 0 });
  assert.equal(parseReviewRepairsArgs([...args, '--codex-bin', '/explicit', '--max-model-calls', '4'], {}).binary, '/explicit');
  assert.equal(parseReviewRepairsArgs([...args, '--max-model-calls', '4'], {}).maxModelCalls, 4);
  assert.throws(() => parseReviewRepairsArgs([...args, '--max-model-calls', 'Infinity']), /invalid_numeric_argument/);
  assert.throws(() => parseReviewRepairsArgs([...args, '--out', '/another']), /duplicate/);
  assert.throws(() => parseReviewRepairsArgs([...args, '--max-model-calls', '1', '--max-model-calls', '20']), /duplicate/);
  assert.throws(() => parseReviewRepairsArgs([...args, '--publish']), /unknown/);
});

test('a completed exact independent review survives resume without spending another model slot', async t => {
  const f=fixture(t),fake=runner();
  const first=await reviewRepairs({...f.options,runReview:fake.runReview});
  const resumed=await reviewRepairs({...f.options,outDir:join(f.root,'resumed'),maxModelCalls:0,
    priorReports:[join(f.options.outDir,'report.json')],runReview:async()=>{throw new Error('must not call model');}});
  assert.equal(first.counts.ready,1);assert.equal(resumed.counts.ready,1);
  assert.equal(resumed.budget.requestedCalls,0);assert.equal(resumed.budget.reusedReviews,1);
  assert.deepEqual(resumed.rows[0].proof,first.rows[0].proof);
  writeFileSync(f.job.steps[0].evidence.today,'different image');
  const stale=await reviewRepairs({...f.options,outDir:join(f.root,'stale'),maxModelCalls:0,
    priorReports:[join(f.options.outDir,'report.json')],runReview:fake.runReview});
  assert.equal(stale.counts.ready,0);assert.equal(stale.budget.reusedReviews,0);
});

test('weekly uncapped API requests still respect the shared actual-call budget', async t => {
  const f=fixture(t);let calls=0;
  const budget={take:()=>++calls<=1,hit:()=>{}};
  const fake=runner(async (_answer,input)=>{await input.beforeRun();});
  const report=await reviewRepairs({...f.options,maxModelCalls:null,budget,runReview:fake.runReview});
  assert.equal(report.rows[0].check.executionReady,false);
  assert.deepEqual(report.rows[0].check.reasons,['review_budget_exhausted']);
  assert.equal(report.counts.errors,0);assert.equal(report.budget.completedAnswers,1);
});
