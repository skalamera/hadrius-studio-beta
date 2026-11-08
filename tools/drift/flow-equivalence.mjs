// Pure, fail-closed proof of ONE source-reviewed mode-switch action across a route alias.
// No filesystem, git, browser, network, model, or policy writes live here. The loader must read
// immutable bytes and supply { path, sha256, bytes } handles, never detached parsed claims.
// Re-run this check after reloading those handles before consuming a saved result. `verified`
// is not a blanket waiver of flow_changed, narration, visual, prerequisite, or row-action guards.
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { bytesDigest, digest } from './contracts.mjs';

const PIN = '89d33398615609bf29cd4612a2d775b8db246aba';
const OLD = 'https://app.hadrius.com/account';
const CURRENT = 'https://app.hadrius.com/settings/account';
const LABEL = 'Use as admin';
const OPPOSITE = 'Use as employee';
const SCHEMA = 'saved-flow-equivalence-v1';

// Reviewed directly in the bare mirror at PIN, not inferred from screenshots or an alias map.
// next.config: redirects() /account -> /settings/account, permanent:false (lines 153-157).
// route mounts AccountSettingsContainer(initialTab="account"); its exact button calls
// switchRole(isEmployeeView ? "ADMIN" : "EMPLOYEE") and displays the opposite action.
// get_role derives isEmployeeView from userRole === "EMPLOYEE"; provider updates role/storage
// after clearing the view cache; use_switch_role refuses failures and reports their toast.
// Full-file SHA256 AND Git blob IDs intentionally pin the interpretation, not the deployment.
// A different capture commit is supported ONLY with these same six complete blobs at that
// exact commit. Changed source requires a fresh review; `confirmed:true` is not evidence.
const SOURCE_FILES = [
  ['apps/hadrius-app/next.config.js', '610d55580fc6b7627ca61e323770163723e61845c67b2435d6d306205d694234', '83679248b3a3e9f8806fda8c6602cb97cd712dc9'],
  ['apps/hadrius-app/pages/settings/account.tsx', 'c290abf5c41e815d782f6a4f4b5b9f1d28876479fc672f584e495740fc6e6c8f', '9fce20418eae4524fec3ea25e406a0c748148143'],
  ['apps/hadrius-app/src/features/account/component_account_settings_header.tsx', '3ffd2c25c0a058be474ce393ca5e3918203cfc3ae93480dcca1105a1cc07ddd9', '6d1e1e078ddc873f08a40394060e639f9eecd359'],
  ['apps/hadrius-app/src/app_shell/providers/use_switch_role.ts', '471b121752bbe6cb6bdd03ec37bbcf4bac9ac4c0a7a9f3f1296f347188a03833', 'a138c2d23f3da27e7192b3e554d15c5f125b3e46'],
  ['apps/hadrius-app/src/api/auth/get_role.tsx', 'a9cea31a99552b50aa0dab563080b83cd48c2520e1327653e2938715ca62a009', 'fbba9e64f03bd11b5db96af10a18dab938027236'],
  ['apps/hadrius-app/src/app_shell/providers/component_user_role_provider.tsx', 'fca366e2744196c07f9bd613f3d6ed66b8517e29faa47be7a2dc01dd9f3ac32c', 'f540776d49c53d1ec5cd2d6558d9b663de609b1e'],
].map(([path, sha256, blobSha]) => Object.freeze({ path, sha256, blobSha }));

export const FLOW_EQUIVALENCE_SOURCE = Object.freeze({
  commit: PIN, reviewedAtCommit: PIN, repository: '1Quantbase/hadrius_frontend',
  from: '/account', to: '/settings/account',
  action: LABEL, postcondition: OPPOSITE, resultingMode: 'ADMIN',
  files: Object.freeze(SOURCE_FILES),
});

const requireProof = (condition, code) => { if (!condition) throw new Error(code); };
const same = (a, b) => digest(a) === digest(b);
const fileBytes = value => {
  requireProof(typeof value === 'string' || value instanceof Uint8Array, 'file_bytes_required');
  return Buffer.from(value);
};
function file(handle, kind) {
  requireProof(handle && typeof handle.path === 'string' && isAbsolute(handle.path), `${kind}_file_required`);
  requireProof(/^[a-f0-9]{64}$/.test(handle.sha256), `${kind}_hash_required`);
  const bytes = fileBytes(handle.bytes);
  requireProof(bytes.length > 0 && bytesDigest(bytes) === handle.sha256, `${kind}_hash_mismatch`);
  return { bytes, handle: { path: handle.path, sha256: handle.sha256, size: bytes.length } };
}
function jsonFile(handle, kind) {
  const loaded = file(handle, kind);
  try { return { ...loaded, value: JSON.parse(loaded.bytes.toString('utf8')) }; }
  catch { throw new Error(`${kind}_invalid_json`); }
}
function uniqueStep(steps, index, kind) {
  requireProof(Array.isArray(steps), `${kind}_steps_required`);
  const matches = steps.filter(s => s?.index === index);
  requireProof(matches.length === 1, `${kind}_step_not_unique`);
  return matches[0];
}
const exactLines = (text, label) => typeof text === 'string' && text.split(/\r?\n/).filter(line => line === label).length === 1;
function cleanStep(step) {
  return !step.error && !step.errors?.length && !step.skipped && !step.guard && !step.mutationGuard
    && !step.prerequisiteUnverified && !step.errorState && !step.emptyState
    && !['error', 'failed', 'skipped', 'uncaptured', 'needs_fixture'].includes(step.status);
}
function screenshot(handle, step, runPath, viewport, kind) {
  const loaded = file(handle, kind);
  requireProof(typeof step.screenshot === 'string' && basename(step.screenshot) === step.screenshot
    && loaded.handle.path === join(dirname(runPath), step.screenshot), `${kind}_path_mismatch`);
  // Captures are PNG. This checks the file/dimensions, not OCR: the independently saved visibleText
  // is the postcondition witness; both it and the image bytes are bound to the exact run below.
  const b = loaded.bytes;
  requireProof(b.length > 33 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && b.toString('ascii', 12, 16) === 'IHDR' && Number.isInteger(viewport?.width)
    && Number.isInteger(viewport?.height) && viewport.width > 0 && viewport.height > 0
    && b.readUInt32BE(16) === viewport.width && b.readUInt32BE(20) === viewport.height,
  `${kind}_not_capture_png`);
  return loaded.handle;
}

/**
 * Verify source snapshots without executing frontend JS. Input:
 * { commit: actualCaptureCommit, files: [{ path: repoRelativePath, sha256, blobSha, bytes }] }.
 * The caller loads via `git show <exact capture commit>:<path>` (never HEAD or a worktree).
 * Output .commit/.captureCommit bind that deployment; .reviewedAtCommit pins interpretation.
 * Exact pinned file bytes, not caller descriptions/regexes, authorize this one alias.
 */
export function verifyPinnedFlowSource(source) {
  try {
    requireProof(typeof source?.commit === 'string' && source.commit.length === 40
      && /^[a-f0-9]{40}$/.test(source.commit), 'source_capture_commit_required');
    const captureCommit = source.commit;
    requireProof((source.captureCommit === undefined || source.captureCommit === captureCommit)
      && (source.reviewedAtCommit === undefined || source.reviewedAtCommit === PIN), 'source_commit_binding_mismatch');
    requireProof(Array.isArray(source.files) && source.files.length === SOURCE_FILES.length, 'source_files_required');
    const files = SOURCE_FILES.map(pin => {
      const matches = source.files.filter(f => f?.path === pin.path);
      requireProof(matches.length === 1, 'source_file_not_unique');
      const current = matches[0], bytes = fileBytes(current.bytes);
      const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      requireProof(current.sha256 === pin.sha256 && bytesDigest(bytes) === pin.sha256
        && current.blobSha === pin.blobSha && blobSha === pin.blobSha, 'source_hash_mismatch');
      return { ...pin, size: bytes.length, gitObject: `${captureCommit}:${pin.path}` };
    });
    return { verified: true, repository: FLOW_EQUIVALENCE_SOURCE.repository,
      commit: captureCommit, reviewedAtCommit: PIN, captureCommit, files };
  } catch (e) { return { verified: false, reasons: [e.message] }; }
}

/**
 * Pure checker; all inputs are caller-read bytes, never file paths to be opened here:
 * { stepIndex, scriptFile, runFile, jobFile, preScreenshot, postScreenshot, source }.
 * JSON/image file handles are { path:absolutePath, sha256:expectedSHA256, bytes:Buffer|string }.
 * The JSON is parsed from those bytes here so a caller cannot detach successful click/target or
 * post-state claims from the hashed run. Missing/unknown evidence yields verified:false.
 * Output file handles + canonical step digests allow the loader to reject stale files before use.
 * Only this step's exact click_navigated_unexpectedly alias finding is resolved, not other steps,
 * other flow failures, screenshots/narration, previous missing targets, or an entire video.
 */
export function verifySavedFlowEquivalence(input = {}) {
  try {
    const source = verifyPinnedFlowSource(input.source);
    requireProof(source.verified, source.reasons?.[0] || 'source_unverified');
    const scriptFile = jsonFile(input.scriptFile, 'script');
    const runFile = jsonFile(input.runFile, 'run');
    const jobFile = jsonFile(input.jobFile, 'job');
    const script = scriptFile.value, run = runFile.value, job = jobFile.value;
    // The deployment comes from the hashed capture/job, not a reviewed-commit fallback.
    // Older runs store it only in job step release evidence; check any extra current-SHA
    // witnesses when present too, rather than silently accepting contradictory metadata.
    for (const record of [run, job, ...(run.steps || []), ...(job.steps || [])]) {
      for (const witness of [record, record?.releaseEvidence, record?.uiReleaseEvidence, record?.release]) {
        for (const key of ['currentSha', 'currentSHA']) {
          requireProof(!witness || !Object.hasOwn(witness, key) || witness[key] === source.captureCommit, 'release_source_mismatch');
        }
      }
    }
    const index = input.stepIndex;
    requireProof(Number.isSafeInteger(index) && index >= 0, 'step_index_required');
    requireProof(script.name && script.name === run.script && script.name === job.name
      && script.recording?.id && script.recording.id === run.recordingId && script.recording.id === job.recordingId
      && run.scriptPath === scriptFile.handle.path && job.scriptPath === scriptFile.handle.path
      && job.scriptHash === digest(script), 'identity_mismatch');
    requireProof(run.status === 'captured' && !run.aborted && !run.mutationStop && !job.mutationStop
      && run.signedIn === true && run.tenantVerified === true && job.captureStatus === 'captured'
      && Array.isArray(job.errors) && job.errors.length === 0
      && job.evidence?.runDir === dirname(runFile.handle.path), 'capture_not_successful');
    const recorded = uniqueStep(script.steps, index, 'script');
    const recordedPost = uniqueStep(script.steps, index + 1, 'script');
    const pre = uniqueStep(run.steps, index, 'run'), post = uniqueStep(run.steps, index + 1, 'run');
    const jobPre = uniqueStep(job.steps, index, 'job'), jobPost = uniqueStep(job.steps, index + 1, 'job');
    requireProof(run.steps.indexOf(post) === run.steps.indexOf(pre) + 1
      && script.steps.indexOf(recordedPost) === script.steps.indexOf(recorded) + 1
      && job.steps.indexOf(jobPost) === job.steps.indexOf(jobPre) + 1, 'post_not_next_capture');
    requireProof(recorded.action === 'click' && recorded.capture === true && recorded.target?.name === LABEL
      && recorded.target.role === 'button' && (!recorded.target.text || recorded.target.text === LABEL)
      && recorded.url === OLD && recorded.route === '/account'
      && recordedPost.action === 'navigate' && recordedPost.capture === true && !recordedPost.target
      && recordedPost.url === OLD && recordedPost.value === OLD && recordedPost.route === '/account', 'unsupported_action_or_workflow');
    requireProof(pre.action === 'click' && post.action === 'navigate' && pre.url === OLD && post.url === OLD
      && pre.route === '/account' && post.route === '/account'
      && pre.recordedMedia === recorded.media?.pre && post.recordedMedia === recordedPost.media?.pre
      && !post.target && !post.clicked && !post.performed && !post.afterClickUrl
      && cleanStep(pre) && cleanStep(post) && cleanStep(jobPre) && cleanStep(jobPost)
      && pre.mutation?.mutating === false && post.mutation?.mutating === false,
    'action_or_prerequisite_unverified');
    requireProof(pre.clicked === true && pre.performed === 'click' && pre.afterClickUrl === CURRENT
      && pre.todayUrl === CURRENT && post.todayUrl === CURRENT, 'click_or_destination_unverified');
    const target = pre.target;
    requireProof(target?.status === 'resolved' && ['role_name', 'name_any_role'].includes(target.method)
      && target.recordedName === LABEL && Array.isArray(target.matches) && target.matches.length === 1
      && target.resolved && same(target.resolved, target.matches[0]), 'target_not_unique_exact');
    const resolved = target.resolved;
    requireProof(resolved.name === LABEL && resolved.role === 'button' && resolved.tag === 'button'
      && resolved.visible === true && Number.isSafeInteger(resolved.i) && resolved.i >= 0
      && !resolved.disabled && !resolved.recordHint && !resolved.inForm
      && !resolved.submits && !resolved.inDialog && !resolved.fileInput && !resolved.href
      && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(resolved.bbox?.[k]))
      && resolved.bbox.w > 0 && resolved.bbox.h > 0 && resolved.bbox.x >= 0 && resolved.bbox.y >= 0
      && resolved.bbox.x + resolved.bbox.w <= run.viewport?.width
      && resolved.bbox.y + resolved.bbox.h <= run.viewport?.height
      && same(resolved.bbox, target.rect), 'wrong_or_row_target');
    requireProof(jobPre.action === 'click' && jobPost.action === 'navigate'
      && jobPre.target?.status === 'resolved' && jobPre.target.method === target.method
      && jobPre.target.recordedName === LABEL && jobPre.target.todayName === LABEL, 'job_target_mismatch');
    requireProof(Array.isArray(jobPre.reasons) && jobPre.reasons.filter(r => r?.code === 'flow_changed').length === 1
      && !(jobPost.reasons || []).some(r => r?.code === 'flow_changed'), 'ambiguous_flow_diagnostic');
    for (const step of [jobPre, jobPost]) {
      requireProof(step.uiReleaseEvidence?.currentSha === source.captureCommit && step.uiReleaseEvidence.routePath === '/settings/account'
        && step.uiReleaseEvidence.routeEntryFile === SOURCE_FILES[1].path
        && step.uiReleaseEvidence.capturedAt === job.startedAt, 'release_source_mismatch');
    }
    requireProof(Array.isArray(run.findings), 'findings_required');
    const findings = run.findings.filter(f => f?.step === index || f?.step === index + 1);
    requireProof(findings.length === 1 && findings[0].step === index
      && findings[0].kind === 'click_navigated_unexpectedly' && findings[0].expected === OLD
      && findings[0].actual === CURRENT, 'not_only_confirmed_alias_finding');
    requireProof(exactLines(pre.visibleText, LABEL) && !pre.visibleText.split(/\r?\n/).includes(OPPOSITE)
      && exactLines(post.visibleText, OPPOSITE) && !post.visibleText.split(/\r?\n/).includes(LABEL)
      && !/Unable to switch view|Please try switching views again\./.test(post.visibleText), 'mode_postcondition_unverified');
    const preImage = screenshot(input.preScreenshot, pre, runFile.handle.path, run.viewport, 'pre_screenshot');
    const postImage = screenshot(input.postScreenshot, post, runFile.handle.path, run.viewport, 'post_screenshot');
    requireProof(preImage.path !== postImage.path && preImage.sha256 !== postImage.sha256
      && jobPre.evidence?.today === preImage.path && jobPost.evidence?.today === postImage.path, 'capture_binding_mismatch');
    const binding = {
      schema: SCHEMA, videoName: script.name, recordingId: run.recordingId, stepIndex: index, nextStepIndex: index + 1,
      scriptStepDigest: digest(recorded), nextScriptStepDigest: digest(recordedPost),
      runStepDigest: digest(pre), nextRunStepDigest: digest(post), jobStepDigest: digest(jobPre), nextJobStepDigest: digest(jobPost),
      files: { script: scriptFile.handle, run: runFile.handle, job: jobFile.handle, preScreenshot: preImage, postScreenshot: postImage },
      // Alias interpretation was reviewed at PIN; source.gitObject handles bind actual bytes.
      source, routeAlias: { from: OLD, to: CURRENT, sourceCommit: PIN, sourceFile: SOURCE_FILES[0].path },
      target: { label: LABEL, method: target.method, currentRole: resolved.role, bbox: resolved.bbox },
      execution: { clicked: true, performed: 'click', afterClickUrl: pre.afterClickUrl },
      postcondition: { resultingMode: 'ADMIN', visibleOppositeControl: OPPOSITE, evidence: 'next_saved_capture_visible_text',
        visibleTextSha256: bytesDigest(post.visibleText), screenshot: postImage },
      resolvedFinding: { ...findings[0] },
    };
    return { schema: SCHEMA, verified: true, reasons: [], scope: 'single_mode_switch_route_alias_only',
      binding, bindingDigest: digest(binding),
      limitations: ['No narration or visual-repair approval.', 'No prior-step or whole-video equivalence.',
        'Reload and hash-check every bound file before consumption; do not trust a saved verified flag.'] };
  } catch (e) {
    return { schema: SCHEMA, verified: false, reasons: [e.message], binding: null, bindingDigest: null };
  }
}
