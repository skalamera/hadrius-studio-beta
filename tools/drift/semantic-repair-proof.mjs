// Bind a semantic review to the *current* repair-assessment inputs before it can waive a diagnostic.
import { digest } from './contracts.mjs';
import { validateSemanticRepairReview } from './semantic-repair.mjs';

export function semanticStepDigest(step) {
  const { semanticRepair: _review, flowEquivalence: _flow, ...source } = step ?? {};
  return digest(JSON.parse(JSON.stringify(source)));
}

export function semanticRepairCheck(step, scriptStep, changes, name) {
  const proof = step?.semanticRepair;
  if (!proof) return null;
  const { binding, review, metadata, verification } = proof;
  try {
    if (binding.videoName !== name || binding.stepIndex !== step.index
      || digest(binding.scriptStep) !== digest(scriptStep)
      || binding.source.job.stepDigest !== semanticStepDigest(step)
      || digest(binding.selectedVerifiedChanges) !== digest(changes)) return null;
    // Image bytes are checked by the filesystem-backed loader before attach; their exact references/hashes
    // remain bound here. This pure check never invents current hashes or trusts the model to provide them.
    if (binding.source.job.recordedPath !== step.evidence?.recorded || binding.source.job.currentPath !== step.evidence?.today) return null;
    const checked = validateSemanticRepairReview(review, { binding, metadata, verification });
    return checked.executionReady ? { ...checked, review } : null;
  } catch { return null; }
}
