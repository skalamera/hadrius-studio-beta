// File-backed, offline gate for the single source-pinned saved-flow proof. No capture or writes.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesDigest, digest } from './contracts.mjs';
import { FLOW_EQUIVALENCE_SOURCE, verifySavedFlowEquivalence } from './flow-equivalence.mjs';
import { flowStepDigest } from './repairability.mjs';

const DEFAULT_MIRROR = fileURLToPath(new URL('../../.drift-cache/frontend.git', import.meta.url));
const fail = code => { throw new Error(code); };
const read = path => {
  path = resolve(path);
  const bytes = readFileSync(path);
  return { path, bytes, sha256: bytesDigest(bytes) };
};
const json = file => JSON.parse(file.bytes.toString('utf8'));
const unique = (steps, index) => {
  const found = (steps || []).filter(s => s?.index === index);
  if (found.length !== 1) fail('flow_equivalence_step_not_unique');
  return found[0];
};
function pinnedSource(frontendGitDir, captureCommit) {
  // Never consult HEAD, a worktree, replace refs, caller snapshots, or the network. Inherited Git
  // object/config overrides must not redirect the requested mirror. The empty transport allowlist
  // also blocks promisor fetches on older Git, even if repository config explicitly allows one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  const git = args => execFileSync('git', ['--git-dir', resolve(frontendGitDir), '-c', 'protocol.allow=never', ...args],
    { env, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (git(['cat-file', '-t', captureCommit]).toString('utf8').trim() !== 'commit') fail('not_commit');
  } catch { fail('flow_equivalence_source_commit_unavailable'); }
  const files = FLOW_EQUIVALENCE_SOURCE.files.map(pin => {
    let bytes;
    try {
      bytes = git(['show', `${captureCommit}:${pin.path}`]);
    } catch { fail(`flow_equivalence_source_unavailable:${pin.path}`); }
    return { path: pin.path, bytes, sha256: bytesDigest(bytes),
      blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
  });
  return { commit: captureCommit, reviewedAtCommit: FLOW_EQUIVALENCE_SOURCE.commit, captureCommit, files };
}
function replay({ jobPath, scriptPath, runPath, stepIndex, captureCommit, frontendGitDir = DEFAULT_MIRROR }) {
  const jobFile = read(jobPath), job = json(jobFile);
  // Default to the actual hashed job witness, never to the commit where interpretation was
  // reviewed. Explicit values and resumed proofs must agree with this witness in the checker.
  if (captureCommit === undefined) captureCommit = unique(job.steps, stepIndex).uiReleaseEvidence?.currentSha;
  if (typeof captureCommit !== 'string' || captureCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(captureCommit)) fail('flow_equivalence_capture_commit_required');
  const scriptFile = read(scriptPath || job.scriptPath);
  const runFile = read(runPath || join(job.evidence?.runDir || fail('flow_equivalence_run_path_required'), 'run.json'));
  const run = json(runFile), pre = unique(run.steps, stepIndex), post = unique(run.steps, stepIndex + 1);
  if (typeof pre.screenshot !== 'string' || typeof post.screenshot !== 'string') fail('flow_equivalence_screenshot_required');
  const result = verifySavedFlowEquivalence({ stepIndex, scriptFile, runFile, jobFile,
    preScreenshot: read(join(dirname(runFile.path), pre.screenshot)),
    postScreenshot: read(join(dirname(runFile.path), post.screenshot)), source: pinnedSource(frontendGitDir, captureCommit) });
  return { result, job, script: json(scriptFile) };
}
function requireVerified(proof) {
  if (proof?.verified !== true || !proof.binding || proof.bindingDigest !== digest(proof.binding)) fail('flow_equivalence_binding_invalid');
}

/** Create a proof from ORIGINAL saved inputs. Returns the real checker's refusal unchanged;
 * filesystem/source availability errors throw. Nothing is written and no diagnostics are edited.
 * Optional captureCommit must be a literal 40-hex SHA agreeing with the saved job/run witnesses;
 * when omitted, use this step's saved uiReleaseEvidence.currentSha, never the reviewed PIN.
 * Persist the returned JSON in a new artifact; attach it as step.flowEquivalence only if verified.
 */
export function createFlowEquivalenceProof(options) {
  const { result } = replay(options);
  if (!result.verified) return result;
  // Freshly reread every input and git blob, and compare the complete resulting binding.
  return revalidateFlowEquivalenceProof(result, { frontendGitDir: options.frontendGitDir });
}

/** Reread all original files, both PNGs and six exact git-show blobs; never trust verified:true.
 * Optional assessment context is checked against the fresh caller inputs as well as saved inputs.
 * Throws on staleness/refusal. Returns the newly verified (not the saved) proof.
 */
export function revalidateFlowEquivalenceProof(proof, { step, scriptStep, name, frontendGitDir = DEFAULT_MIRROR } = {}) {
  requireVerified(proof);
  const files = proof.binding.files;
  if (!files?.job?.path || !files?.run?.path || !files?.script?.path) fail('flow_equivalence_paths_required');
  let { result, job, script } = replay({ jobPath: files.job.path, runPath: files.run.path,
    scriptPath: files.script.path, stepIndex: proof.binding.stepIndex,
    captureCommit: proof.binding.source?.captureCommit ?? proof.binding.source?.commit, frontendGitDir });
  if (!result.verified) fail(`flow_equivalence_recheck_failed:${result.reasons.join(',')}`);
  // Existing v1 artifacts predate the explicit reviewed/capture fields. Accept ONLY their
  // exact original PIN shape after the same fresh source/file replay, without migrating their
  // binding digest (which other saved review evidence may already reference).
  const oldSource = proof.binding.source;
  if (oldSource?.commit === FLOW_EQUIVALENCE_SOURCE.commit
    && !Object.hasOwn(oldSource, 'reviewedAtCommit') && !Object.hasOwn(oldSource, 'captureCommit')) {
    const binding = structuredClone(result.binding);
    delete binding.source.reviewedAtCommit; delete binding.source.captureCommit;
    result = { ...result, binding, bindingDigest: digest(binding) };
  }
  if (result.bindingDigest !== proof.bindingDigest || digest(result.binding) !== digest(proof.binding)
    || result.schema !== proof.schema || result.scope !== proof.scope) fail('flow_equivalence_stale_binding');
  const originalStep = unique(job.steps, result.binding.stepIndex);
  const originalScriptStep = unique(script.steps, result.binding.stepIndex);
  // Replay above already reran the full pure source/action/postcondition checker. Context
  // identity is an exact digest check, not a second policy gate tied to a deployment PIN.
  const matches = (st, ss, videoName) => st && ss && videoName === result.binding.videoName
    && st.index === result.binding.stepIndex && ss.index === result.binding.stepIndex
    && flowStepDigest(st) === result.binding.jobStepDigest && digest(ss) === result.binding.scriptStepDigest;
  if (!matches(originalStep, originalScriptStep, job.name)) fail('flow_equivalence_original_context_conflict');
  if (step !== undefined || scriptStep !== undefined || name !== undefined) {
    if (!matches(step, scriptStep, name)) fail('flow_equivalence_context_conflict');
  }
  return result;
}

/** Reload a JSON proof artifact and revalidate real bytes; accepts no detached success flag. */
export function loadFlowEquivalenceProof(proofPath, context = {}) {
  return revalidateFlowEquivalenceProof(json(read(proofPath)), context);
}

/** Candidate-finalization gate. Supply the ORIGINAL script step and video name. Like the semantic
 * asset gate this throws and returns true only on success; retire additional proof on failure,
 * preserving reasons. Run this before selection/candidate creation and again on resumed jobs.
 */
export function verifyFlowEquivalenceAssets(step, { scriptStep, name, frontendGitDir = DEFAULT_MIRROR } = {}) {
  if (!scriptStep || !name) fail('flow_equivalence_context_required');
  revalidateFlowEquivalenceProof(step?.flowEquivalence, { step, scriptStep, name, frontendGitDir });
  return true;
}
