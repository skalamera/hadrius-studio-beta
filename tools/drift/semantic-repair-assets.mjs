// Filesystem half of semantic review validation. Must run before candidate generation, not in the pure policy.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { revalidateFlowEquivalenceProof } from './flow-equivalence-assets.mjs';
import { revalidateRoleSwitchSource } from './role-switch-source.mjs';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function verifySemanticRepairAssets(step) {
  const binding = step?.semanticRepair?.binding;
  if (!binding) throw new Error('semantic_review_missing_binding');
  const old = step.evidence?.recorded, current = step.evidence?.today;
  if (!old || !current || binding.source.job.recordedPath !== old || binding.source.job.currentPath !== current) throw new Error('semantic_review_path_conflict');
  if (!/\.png$/i.test(old) || !/\.png$/i.test(current)) throw new Error('semantic_review_image_required');
  if (sha(old) !== binding.imageSha256s.recorded || sha(current) !== binding.imageSha256s.current) throw new Error('semantic_review_image_conflict');
  const capture = binding.source.capture;
  const capturePath = join(dirname(current), 'run.json');
  if ((capture.path && capture.path !== capturePath) || sha(capturePath) !== capture.sha256) throw new Error('semantic_review_capture_conflict');
  if (binding.source.job.flowEquivalenceDigest) {
    if (step.flowEquivalence?.bindingDigest !== binding.source.job.flowEquivalenceDigest) throw new Error('semantic_review_flow_conflict');
    revalidateFlowEquivalenceProof(step.flowEquivalence, { step, scriptStep: binding.scriptStep, name: binding.videoName });
    if(binding.source.job.roleEligibility)revalidateRoleSwitchSource(binding.source.job.roleEligibility,
      {captureCommit:step.flowEquivalence.binding.source.captureCommit??step.flowEquivalence.binding.source.commit});
  }
  return true;
}
