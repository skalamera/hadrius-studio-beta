// Opt-in semantic evidence collection only. Never selects, repairs, renders, publishes, or writes fixtures.
// Default budget is ZERO. --max-model-calls is a pessimistic requested-call cap (cache hits count).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCodexReview, runClaudeWithCodexFallback } from './codex-review.mjs';
import { repairReviewBinding, buildSemanticRepairPrompt, parseSemanticRepairReview, validateSemanticRepairReview } from './semantic-repair.mjs';
import { semanticStepDigest } from './semantic-repair-proof.mjs';
import { digest } from './contracts.mjs';
import { normalizedRoute } from './ui-selection.mjs';
import { emptyStateOf, errorStateOf } from './classify.mjs';
import { revalidateFlowEquivalenceProof } from './flow-equivalence-assets.mjs';
import { loadRoleSwitchSource, revalidateRoleSwitchSource } from './role-switch-source.mjs';
import { verifySemanticRepairAssets } from './semantic-repair-assets.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shaBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = path => shaBytes(readFileSync(path));
function snapshot(path) {
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString('utf8')), path, sha256: shaBytes(bytes) };
}
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const common = { reason: { type: 'string' }, evidence: { type: 'string' }, recordsIndependent: { type: 'boolean' } };
// Same strict response contract as semantic-repair.mjs; no model-authored metadata or verification.
export const SEMANTIC_REPAIR_REVIEW_SCHEMA = object({
  schema: { const: 'semantic-repair-review-v1' }, bindingDigest: { type: 'string' },
  workflow: object({ status: { enum: ['equivalent', 'changed', 'unknown'] }, ...common }),
  narration: object({ status: { enum: ['accurate', 'rewrite', 'unknown'] }, suggestedNarration: { type: ['string', 'null'] }, preservesIntent: { type: 'boolean' }, intentEvidence: { type: 'string' }, ...common }),
  target: object({ status: { enum: ['same', 'equivalent', 'not_applicable', 'unknown'] }, currentLabel: { type: ['string', 'null'] }, bbox: { anyOf: [{ type: 'null' }, object({ x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } })] }, ...common }),
  linkedInterface: object({ status: { enum: ['affected', 'not_affected', 'unknown'] }, ...common }),
});
const indexOK = index => Number.isSafeInteger(index) && index >= 0;
const nameOK = name => typeof name === 'string' && !!name && !['.', '..'].includes(name) && !/[\\/\0]/.test(name);
const pending = reason => ({ valid: false, status: 'pending', executionReady: false, reasons: [reason] });
function atomicJson(path, value) {
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
function indexed(steps, label) {
  if (!Array.isArray(steps)) throw new Error(`${label}_missing_steps`);
  const result = new Map();
  steps.forEach((step, at) => {
    const index = step.index ?? at;
    if (!indexOK(index) || result.has(index)) throw new Error(`${label}_invalid_index`);
    result.set(index, step);
  });
  return result;
}
function selectedPairs(review) {
  if (!Array.isArray(review.flagged) || !review.flagged.length) throw new Error('approved_review_missing_flagged');
  const names = new Set(), pairs = [];
  for (const video of review.flagged) {
    if (!nameOK(video.name) || names.has(video.name)) throw new Error('approved_review_invalid_name');
    names.add(video.name);
    if (!Array.isArray(video.slides) || !video.slides.length) throw new Error('approved_review_missing_slides');
    const indices = new Set();
    for (const slide of video.slides) {
      if (!indexOK(slide.index) || indices.has(slide.index)) throw new Error('approved_review_invalid_index');
      indices.add(slide.index);
      if (!Array.isArray(slide.changes) || !slide.changes.length || slide.changes.some(c => !c || typeof c !== 'object' || Array.isArray(c) || !Object.keys(c).length)) throw new Error('approved_review_missing_verified_changes');
      pairs.push(`${video.name}#${slide.index}`);
    }
  }
  return pairs.sort();
}
function blockerIndices(...repairs) {
  const indices = new Set();
  for (const repair of repairs) for (const blocker of repair?.blockers ?? []) {
    for (const index of [...(blocker.slides ?? []), ...(blocker.items ?? []).map(item => item.index)]) {
      if (!indexOK(index)) throw new Error('blocker_invalid_index');
      indices.add(index);
    }
  }
  return indices;
}

/** Read-only task inventory. The approved review is trusted caller input, never recomputed from model claims.
 * Unknown routes are included conservatively. Missing steps/images remain inventory rows, not filtered away.
 */
export function collectRepairReviewTasks({ sourceDir, reviewPath, repo = REPO }) {
  const source = resolve(sourceDir), approvedPath = resolve(reviewPath), approvedSnapshot = snapshot(approvedPath), review = approvedSnapshot.value;
  const approvedPairs = selectedPairs(review), tasks = [], inputHashes = [{ path: approvedPath, sha256: approvedSnapshot.sha256 }];
  const parityPath = join(source, 'selection-parity.json');
  const paritySnapshot = existsSync(parityPath) ? snapshot(parityPath) : null, parity = paritySnapshot?.value;
  if (paritySnapshot) inputHashes.push({ path: parityPath, sha256: paritySnapshot.sha256 });
  if (parity && (!Array.isArray(parity.acceptedPairs) || digest(parity.acceptedPairs.slice().sort()) !== digest(approvedPairs))) throw new Error('approved_selection_changed');
  const summaryPath = join(source, 'summary.json');
  const summarySnapshot = existsSync(summaryPath) ? snapshot(summaryPath) : null, summary = summarySnapshot?.value;
  if (summarySnapshot) inputHashes.push({ path: summaryPath, sha256: summarySnapshot.sha256 });
  if (summary && (!Array.isArray(summary.names) || new Set(summary.names).size !== summary.names.length || review.flagged.some(v => !summary.names.includes(v.name)))) throw new Error('approved_name_outside_batch');
  for (const video of review.flagged) {
    const jobPath = join(source, video.name, 'job.json');
    let job, script, scriptPath, steps, scriptSteps, jobSnapshot, scriptSnapshot;
    try {
      jobSnapshot = snapshot(jobPath); job = jobSnapshot.value;
      if (job.name !== video.name) throw new Error('source_job_name_mismatch');
      steps = indexed(job.steps, 'job');
      scriptPath = job.scriptPath ? resolve(dirname(jobPath), job.scriptPath) : join(resolve(repo), 'scripts', video.name + '.script.json');
      scriptSnapshot = snapshot(scriptPath); script = scriptSnapshot.value;
      if (script.name && script.name !== video.name) throw new Error('source_script_name_mismatch');
      scriptSteps = indexed(script.steps, 'script');
      if (job.scriptHash && job.scriptHash !== digest(script)) throw new Error('source_script_hash_mismatch');
    } catch (error) {
      // Include explicitly linked rows even when the job/script cannot be loaded.
      const indices = new Set([...video.slides.map(s => s.index), ...blockerIndices(video.repair, job?.uiSelection?.repair, parity?.repair?.[video.name])]);
      for (const index of indices) tasks.push({ name: video.name, index, selected: video.slides.some(s => s.index === index), links: ['source_unavailable'], error: error.message });
      continue;
    }
    const selected = new Set(video.slides.map(s => s.index));
    const explicit = blockerIndices(video.repair, job.uiSelection?.repair, parity?.repair?.[video.name]);
    const route = index => {
      const step = scriptSteps.get(index);
      return normalizedRoute(step?.url ?? step?.route) ?? normalizedRoute(steps.get(index)?.uiContext?.route);
    };
    const selectedRoutes = [...selected].map(route);
    const all = new Set([...scriptSteps.keys(), ...steps.keys(), ...selected, ...explicit]);
    for (const index of [...all].sort((a, b) => a - b)) {
      const links = [];
      if (selected.has(index)) links.push('selected');
      if (explicit.has(index)) links.push('blocker');
      const page = route(index);
      if (selectedRoutes.some(other => page === null || other === null || page === other)) links.push('same_page');
      if (!links.length) continue;
      tasks.push({ name: video.name, index, selected: selected.has(index), links,
        jobPath, jobSha256: jobSnapshot.sha256, scriptPath, scriptSha256: scriptSnapshot.sha256,
        step: scriptSteps.get(index) ?? null, raw: steps.get(index) ?? null,
        changes: video.slides.flatMap(s => s.changes) });
    }
  }
  return { sourceDir: source, reviewPath: approvedPath, reviewSha256: approvedSnapshot.sha256, approvedPairs, inputHashes, tasks };
}

function captureContext(step, cap, run) {
  const codes = new Set((step.reasons ?? []).map(r => r.code));
  const has = (...values) => values.some(value => codes.has(value));
  let pageState = 'unknown';
  if (cap.error || step.errorState || errorStateOf(cap.visibleText) || has('page_error')) pageState = 'error';
  else if (cap.pageState === 'loading' || step.pageState === 'loading' || has('page_not_loaded')) pageState = 'loading';
  else if (cap.pageState && !['loaded', 'empty'].includes(cap.pageState)) pageState = ['missing', 'unknown'].includes(cap.pageState) ? cap.pageState : 'unknown';
  else if (step.emptyState || emptyStateOf(cap.visibleText) || cap.pageState === 'empty' || has('empty_state')) pageState = 'empty';
  else if (typeof cap.visibleText === 'string' && cap.visibleText.trim() && (cap.todayUrl || cap.url)) pageState = 'loaded';
  const guard = cap.mutationGuard ?? step.guard;
  const guarded = guard && (typeof guard !== 'object' || guard.status || guard.performed === false);
  const recordGap = has('record_not_visible', 'data_missing') || step.judge?.data_missing || cap.recordMissing;
  const recordSpecificAction = !!(cap.target?.resolved?.recordHint || cap.target?.recordHint || step.target?.recordHint
    || (cap.mutation?.fixture?.records ?? cap.mutation?.static?.fixture?.records ?? []).some(r => r.kind !== 'company_id'));
  let taskContext = 'unknown';
  if (run.signedIn === false || run.tenantVerified === false || cap.wrongScreen) taskContext = 'wrong_screen';
  else if (cap.prerequisiteUnverified || step.prerequisiteUnverified || guarded || recordGap || has('needs_fixture', 'not_captured')) taskContext = 'missing_prerequisite';
  else if (['loaded', 'empty'].includes(pageState) && run.signedIn === true && run.tenantVerified === true) taskContext = 'verified';
  return { pageState, recordSpecificAction, taskContext };
}
function prepareInput(task) {
  if (task.error) throw new Error(task.error);
  if (!task.step) throw new Error('script_step_missing');
  if (!task.raw) throw new Error('source_step_missing');
  const recorded = task.raw.evidence?.recorded, current = task.raw.evidence?.today;
  if (typeof recorded !== 'string' || !existsSync(recorded)) throw new Error('recorded_image_missing');
  if (typeof current !== 'string' || !existsSync(current)) throw new Error('current_image_missing');
  if (!isAbsolute(recorded) || !isAbsolute(current) || !/\.png$/i.test(recorded) || !/\.png$/i.test(current)) throw new Error('absolute_png_evidence_required');
  // This is the capture record consumed by semantic-repair-assets.mjs, NOT a stale copied run.json.
  const capturePath = join(dirname(current), 'run.json'), captureSnapshot = snapshot(capturePath), run = captureSnapshot.value;
  const captures = indexed(run.steps, 'capture'), cap = captures.get(task.index);
  if (!cap) throw new Error('capture_step_missing');
  if (!cap.screenshot || resolve(dirname(capturePath), cap.screenshot) !== current) throw new Error('capture_image_path_mismatch');
  const context = captureContext(task.raw, cap, run);
  const flow = task.raw.flowEquivalence
    ? revalidateFlowEquivalenceProof(task.raw.flowEquivalence, { step: task.raw, scriptStep: task.step, name: task.name }) : null;
  const roleEligibility = flow ? loadRoleSwitchSource({captureCommit:flow.binding.source.captureCommit??flow.binding.source.commit}) : null;
  const binding = repairReviewBinding({ videoName: task.name, stepIndex: task.index, scriptStep: task.step,
    selectedVerifiedChanges: task.changes,
    source: { job: { stepDigest: semanticStepDigest(task.raw), recordedPath: recorded, currentPath: current,
      path: task.jobPath, sha256: task.jobSha256, scriptPath: task.scriptPath, scriptSha256: task.scriptSha256,
      reasons: task.raw.reasons ?? [], target: task.raw.target ?? null,
      ...(flow ? { flowEquivalenceDigest: flow.bindingDigest, verifiedFlowEquivalence: flow.binding, roleEligibility } : {}) },
    capture: { path: capturePath, sha256: captureSnapshot.sha256, step: cap } },
    imageSha256s: { recorded: sha(recorded), current: sha(current) }, captureContext: context });
  const hashes = [{ path: task.jobPath, sha256: task.jobSha256 }, { path: task.scriptPath, sha256: task.scriptSha256 },
    { path: capturePath, sha256: binding.source.capture.sha256 }, { path: recorded, sha256: binding.imageSha256s.recorded }, { path: current, sha256: binding.imageSha256s.current }];
  const images = [recorded, current];
  let prompt = buildSemanticRepairPrompt({ binding, currentText: cap.visibleText ?? '' });
  if (flow) {
    for (const file of Object.values(flow.binding.files)) hashes.push({ path: file.path, sha256: file.sha256 });
    images.push(flow.binding.files.postScreenshot.path);
    prompt += '\nROLE-SWITCH AVAILABILITY SOURCE: source.job.roleEligibility contains two complete hash-pinned frontend files at the SAME verified capture commit. The visible switch is gated by useCanSwitchRole, including employee-compliance availability, linked employee in the selected company, and hasAdminViewInSelectedCompany. Independently read these full files when checking the original narration claim that this switch is available only to specified firm users. These are UI/navigation availability conditions, not a grant of module permissions or evidence of any other action.';
    prompt += '\nSOURCE-VERIFIED SAVED FLOW: The exact original control was clicked successfully. Six immutable frontend source blobs establish only the /account -> /settings/account alias and the Use as admin action. The adjacent saved capture proves the ADMIN postcondition via Use as employee. The third attached image is that CURRENT POST-ACTION capture, not the pre-click screen. This resolves only that route-alias finding; do not waive other tasks, missing controls, changed workflows, or narration. Review the original instruction against the second (current pre-click) image, with the third image only as outcome evidence.';
  }
  return { binding, hashes, prompt, images };
}
function assertHashes(hashes) {
  for (const entry of hashes) if (sha(entry.path) !== entry.sha256) throw new Error('review_source_changed:' + entry.path);
}
function answerMetadata(answer, model, effort) {
  // Values come from the adapter, never the model's JSON. Retain the actual effort and cache provenance.
  const metadata = { provider: answer?.provider ?? null, model: answer?.model ?? null,
    effort: answer?.effort ?? null, reviewId: answer?.key ?? null, cached: answer?.cached ?? null };
  if (typeof metadata.provider !== 'string' || !metadata.provider.trim() || typeof metadata.reviewId !== 'string' || !metadata.reviewId.trim()) throw new Error('review_answer_metadata_missing');
  const claudeModel = process.env.KBS_DECISION_MODEL || 'claude-sonnet-5';
  const modelMatch = metadata.model === model || (metadata.provider === 'claude-cli' && metadata.model === claudeModel);
  if (!modelMatch || metadata.effort !== effort) throw new Error('review_answer_settings_mismatch');
  return metadata;
}
function verificationFor(binding, review, second, metadata, secondCheck) {
  const positive = secondCheck.status === 'proposed';
  const narration = review.narration.status === 'rewrite' ? review.narration.suggestedNarration : binding.scriptStep.narration;
  const sameNarration = second.narration.status === review.narration.status
    && (review.narration.status !== 'rewrite' || second.narration.suggestedNarration === narration);
  return { bindingDigest: binding.digest, reviewDigest: digest(review), currentImageSha256: binding.imageSha256s.current,
    verifier: { kind: 'model', id: metadata.reviewId, provider: metadata.provider, model: metadata.model, reviewId: metadata.reviewId },
    workflow: { verified: (positive && second.workflow.status === 'equivalent')
      || (review.workflow.status==='changed'&&second.workflow.status==='changed'&&second.bindingDigest===binding.digest
        &&second.workflow.recordsIndependent===true&&review.workflow.recordsIndependent===true), reason: second.workflow.reason, evidence: second.workflow.evidence },
    narration: { verified: positive && sameNarration, reason: second.narration.reason, evidence: second.narration.evidence,
      text: narration, preservesIntent: second.narration.preservesIntent, intentEvidence: second.narration.intentEvidence },
    target: { verified: positive && second.target.status === review.target.status && second.target.currentLabel === review.target.currentLabel,
      reason: second.target.reason, evidence: second.target.evidence, currentLabel: second.target.currentLabel },
    linkedInterface: { verified: positive && second.linkedInterface.status === review.linkedInterface.status,
      reason: second.linkedInterface.reason, evidence: second.linkedInterface.evidence } };
}

/** Import-safe API. runReview is an injectable runCodexReview-compatible adapter; tests never need a model.
 * NEW outDir is mandatory. The requested-call cap also bounds live calls for the real adapter, including
 * failed attempts. Cache hits count pessimistically; no token, dollar, or falsely precise live-call claim.
 */
export async function reviewRepairs({ sourceDir, reviewPath, outDir, repo = REPO,
  binary = process.env.KBS_CODEX_BIN, model = 'gpt-6.1-sol', effort = 'medium', maxModelCalls = 0,
  timeoutMs = 300_000, names = null, signal, cacheDir = null, priorReports = [], priorityNames = [], budget = null,
  runReview = process.env.KBS_DRIFT_REVIEW_PROVIDER === 'claude' ? runClaudeWithCodexFallback : runCodexReview } = {}) {
  if (!sourceDir || !reviewPath || !outDir) throw new Error('source_review_out_required');
  if (maxModelCalls !== null && (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0)) throw new Error('invalid_max_model_calls');
  if (typeof model !== 'string' || !model.trim() || !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('invalid_model_settings');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  if ((maxModelCalls === null || maxModelCalls > 0) && (typeof binary !== 'string' || !binary.trim())) throw new Error('codex_bin_required');
  const out = resolve(outDir);
  if (existsSync(out)) throw new Error('output_exists');
  const inventory = collectRepairReviewTasks({ sourceDir, reviewPath, repo });
  const reviewerVersion=digest({schema:SEMANTIC_REPAIR_REVIEW_SCHEMA,source:[prepareInput,captureContext,buildSemanticRepairPrompt,parseSemanticRepairReview,verificationFor].map(fn=>String(fn))});
  if(!Array.isArray(priorityNames)||new Set(priorityNames).size!==priorityNames.length
    ||priorityNames.some(name=>!inventory.tasks.some(t=>t.name===name)))throw new Error('invalid_review_priority');
  if(priorityNames.length){const rank=new Map(priorityNames.map((name,i)=>[name,i]));inventory.tasks.sort((a,b)=>(rank.get(a.name)??rank.size)-(rank.get(b.name)??rank.size));}
  const priorRows = priorReports.flatMap(path => {
    try { const saved = snapshot(path);if(saved.value.settings?.reviewerVersion!==reviewerVersion)return [];return (saved.value.rows ?? []).map(row => ({row, path: saved.path, sha256: saved.sha256})); }
    catch { return []; } // An absent/incomplete checkpoint never supplies a decision.
  });
  if (names && (!Array.isArray(names) || !names.length || names.some(n => !inventory.tasks.some(t => t.name === n)))) throw new Error('review_name_outside_approved_scope');
  // Do not write a report into its own source tree.
  if (out === inventory.sourceDir || out.startsWith(inventory.sourceDir + '/')) throw new Error('output_inside_source');
  mkdirSync(out, { mode: 0o700 });
  mkdirSync(join(out, 'checkpoints'), { mode: 0o700 });
  const report = { schema: 1, kind: 'semantic-repair-review', sourceDir: inventory.sourceDir, reviewPath: inventory.reviewPath,
    outDir: out, approvedPairs: inventory.approvedPairs, approvedScopeUnchanged: true,
    startedAt: new Date().toISOString(), finishedAt: null, settings: { model, effort, binary: binary ?? null, timeoutMs,reviewerVersion },
    budget: { mode: 'requested-call-cap', maxModelCalls, requestedCalls: 0, completedAnswers: 0, cachedAnswers: 0,
      reusedReviews: 0, explanation: 'Every adapter request, including cache hits and failed attempts, consumes one requested slot. Null is an explicitly uncapped API run. The shared weekly budget separately bounds actual uncached calls; no billing estimate is made.' },
    counts: {}, rows: [] };
  const checkpoint = () => {
    const rows = report.rows;
    report.counts = { total: inventory.tasks.length, done: rows.length, ready: rows.filter(r => r.check.executionReady).length,
      pending: rows.filter(r => !r.check.executionReady).length, errors: rows.filter(r => r.error).length,
      omitted: rows.filter(r => r.omitted).length };
    atomicJson(join(out, 'progress.json'), report);
  };
  checkpoint();
  const request = async (input, role, row) => {
    if (signal?.aborted) throw new Error('cancelled');
    if (maxModelCalls !== null && report.budget.requestedCalls >= maxModelCalls) throw new Error('model_call_limit');
    report.budget.requestedCalls++;
    checkpoint();
    const answer = await runReview({ ...input, schema: structuredClone(SEMANTIC_REPAIR_REVIEW_SCHEMA),
      outputDir: cacheDir ?? join(out, 'cache'), binary, model, effort, timeoutMs, signal,
      beforeRun: () => { if (budget && !budget.take('semantic_repair')) throw new Error('review_budget_exhausted'); },
      validateAnswer: raw => { const parsed = parseSemanticRepairReview(raw); if (parsed.bindingDigest !== input.binding.digest) throw new Error('review_binding_mismatch'); } });
    report.budget.completedAnswers++;
    if (answer?.cached === true) report.budget.cachedAnswers++;
    if (answer?.cached === true) budget?.hit('semantic_repair');
    // Persist even malformed answers and provider metadata before parsing anything.
    atomicJson(join(out, 'checkpoints', `${row.ordinal}-${role}.json`), { key: row.key, role, bindingDigest: row.proof.binding.digest, answer });
    return answer;
  };
  for (const [ordinal, task] of inventory.tasks.entries()) {
    const row = { name: task.name, index: task.index, key: `${task.name}#${task.index}`, ordinal,
      selected: task.selected, links: task.links, status: 'pending', omitted: false,
      check: pending('not_reviewed'), proof: { binding: null, review: null, metadata: null, verification: null },
      independentReview: null, independentMetadata: null };
    report.rows.push(row);
    if (names && !names.includes(task.name)) {
      row.omitted = true; row.check = pending('not_requested'); checkpoint(); continue;
    }
    try {
      const input = prepareInput(task);
      if(input.binding.source.job.roleEligibility)revalidateRoleSwitchSource(input.binding.source.job.roleEligibility);
      row.proof.binding = input.binding;
      assertHashes([...inventory.inputHashes, ...input.hashes]);
      atomicJson(join(out, 'checkpoints', `${ordinal}-input.json`), { key: row.key, binding: input.binding, prompt: input.prompt, images: input.images });
      // Reuse only an exact, still-byte-bound independent review. Do not rebind or synthesize model answers.
      const saved = priorRows.find(saved => {
        const prior = saved.row;
        const claudeModel = process.env.KBS_DECISION_MODEL || 'claude-sonnet-5';
        const modelMatch = prior.proof?.metadata?.model === model || (prior.proof?.metadata?.provider === 'claude-cli' && prior.proof?.metadata?.model === claudeModel);
        if (prior.name !== task.name || prior.index !== task.index || prior.proof?.binding?.digest !== input.binding.digest
          || !modelMatch || prior.proof?.metadata?.effort !== effort) return false;
        try { return validateSemanticRepairReview(prior.proof.review, prior.proof).executionReady
          && verifySemanticRepairAssets({...task.raw, semanticRepair: prior.proof}) === true; } catch { return false; }
      });
      if (saved) {
        row.proof = structuredClone(saved.row.proof); row.independentReview = structuredClone(saved.row.independentReview);
        row.independentMetadata = structuredClone(saved.row.independentMetadata);
        row.check = validateSemanticRepairReview(row.proof.review, row.proof); row.status = 'ready';
        row.reusedFrom = {path: saved.path, sha256: saved.sha256}; report.budget.reusedReviews++;
        checkpoint(); continue;
      }
      const context = input.binding.captureContext;
      if (context.taskContext !== 'verified' || !['loaded', 'empty'].includes(context.pageState)
        || (context.pageState === 'empty' && context.recordSpecificAction)) {
        row.omitted = true;
        row.check = pending(`capture_not_verified:${context.pageState}:${context.taskContext}`);
      } else {
        const author = await request(input, 'author', row);
        row.proof.metadata = answerMetadata(author, model, effort);
        row.proof.review = parseSemanticRepairReview(author.raw);
        assertHashes([...inventory.inputHashes, ...input.hashes]);
        row.check = validateSemanticRepairReview(row.proof.review, { binding: input.binding, metadata: row.proof.metadata });
        if (row.check.status === 'proposed'||row.proof.review.workflow.status==='changed') {
          const prompt = input.prompt + '\nINDEPENDENT VERIFICATION: A separate, fresh review, not the earlier author. Independently inspect BOTH attached images and the exact ORIGINAL script step. Do not defer to an earlier conclusion. Check this proposed narration verbatim for preserved task, action, object, setting, and outcome: '
            + JSON.stringify(row.proof.review.narration.suggestedNarration ?? input.binding.scriptStep.narration ?? '')
            + '. A missing task or prerequisite must remain unknown, never rewritten into a generic screen overview. Return your own full review with specific current-image evidence. If you agree with a rewrite, return that exact text; if not, return unknown. Independent review identity nonce: ' + JSON.stringify(author.key);
          const verifier = await request({ ...input, prompt }, 'verifier', row);
          row.independentMetadata = answerMetadata(verifier, model, effort);
          row.independentReview = parseSemanticRepairReview(verifier.raw);
          const secondCheck = validateSemanticRepairReview(row.independentReview, { binding: input.binding, metadata: row.independentMetadata });
          row.proof.verification = verificationFor(input.binding, row.proof.review, row.independentReview, row.independentMetadata, secondCheck);
          row.check = validateSemanticRepairReview(row.proof.review, row.proof);
        }
        assertHashes([...inventory.inputHashes, ...input.hashes]);
        row.status = row.check.executionReady ? 'ready' : 'pending';
        if(input.binding.source.job.roleEligibility)revalidateRoleSwitchSource(input.binding.source.job.roleEligibility);
      }
    } catch (error) {
      const reason = error.code ?? error.message;
      row.check = pending(reason);
      row.omitted = !row.proof.review;
      // Expected absent artifacts/budget exhaustion are pending, not claimed model or I/O failures.
      if (!['model_call_limit', 'review_budget_exhausted', 'cancelled', 'recorded_image_missing', 'current_image_missing', 'source_step_missing', 'script_step_missing', 'capture_step_missing'].includes(reason)) row.error = error.message;
    }
    checkpoint();
  }
  // A later runner must not be able to invalidate earlier ready rows by changing shared source assets.
  for (const row of report.rows) if (row.proof.binding&&row.proof.review) {
    try {
      const binding = row.proof.binding;
      if(binding.source.job.roleEligibility)revalidateRoleSwitchSource(binding.source.job.roleEligibility);
      assertHashes([...inventory.inputHashes, { path: binding.source.job.path, sha256: binding.source.job.sha256 },
        { path: binding.source.job.scriptPath, sha256: binding.source.job.scriptSha256 },
        { path: binding.source.capture.path, sha256: binding.source.capture.sha256 },
        { path: binding.source.job.recordedPath, sha256: binding.imageSha256s.recorded },
        { path: binding.source.job.currentPath, sha256: binding.imageSha256s.current }]);
    } catch (error) { row.status = 'pending'; row.check = pending('review_source_changed'); row.proof.verification=null; row.error = error.message; }
  }
  report.approvedScopeUnchanged = inventory.inputHashes.every(entry => { try { return sha(entry.path) === entry.sha256; } catch { return false; } });
  report.finishedAt = new Date().toISOString();
  checkpoint();
  atomicJson(join(out, 'report.json'), report);
  return report;
}

export function parseReviewRepairsArgs(args, env = process.env) {
  const names = new Map([['--source', 'sourceDir'], ['--review', 'reviewPath'], ['--out', 'outDir'],
    ['--codex-bin', 'binary'], ['--model', 'model'], ['--effort', 'effort'], ['--max-model-calls', 'maxModelCalls'], ['--timeout-ms', 'timeoutMs'], ['--names', 'names']]);
  const result = { binary: env.KBS_CODEX_BIN, maxModelCalls: 0 }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = names.get(args[i]);
    if (!key || seen.has(key)) throw new Error('unknown_or_duplicate_argument:' + args[i]);
    seen.add(key);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('argument_value_required:' + args[i - 1]);
    if (['maxModelCalls', 'timeoutMs'].includes(key) && !/^\d+$/.test(value)) throw new Error('invalid_numeric_argument:' + key);
    result[key] = ['maxModelCalls', 'timeoutMs'].includes(key) ? Number(value) : key === 'names' ? value.split(',') : value;
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) console.log('Usage: node tools/drift/review-repairs.mjs --source FULL_BATCH --review APPROVED_REVIEW.json --out NEW_DIR [--codex-bin PATH | KBS_CODEX_BIN] [--model gpt-6.1-sol] [--effort medium] [--max-model-calls 0] [--timeout-ms 300000]\nDefault is inventory-only (zero calls). Cap counts author and verifier separately, including cache hits. No rendering, source mutation, publishing, or billing estimate.');
  else reviewRepairs(parseReviewRepairsArgs(process.argv.slice(2))).then(report => console.log(JSON.stringify({ report: join(report.outDir, 'report.json'), ...report.counts, budget: report.budget }, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
