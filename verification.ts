import type { ShadowComparison } from "./detectors.js";
import { RECOVERY_SHADOW_CORPUS } from "./recovery-shadow-corpus.js";

export interface RecoveryVerifierOptions {
  readShadowComparison(): Promise<ShadowComparison | null>;
  selectedDetectorId(): Promise<string | null>;
}

export interface RecoveryVerifier {
  /** Validates real stored comparison evidence, without invoking a model or approving admission safety. */
  validateDetectorComparison(detectorId: string, options?: { signal?: AbortSignal }): Promise<ShadowComparison>;
}

export class RecoveryVerificationPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryVerificationPrerequisiteError";
  }
}

function requireComparison(comparison: ShadowComparison | null, detectorId: string): ShadowComparison {
  if (!comparison || comparison.mode !== "synthetic-shadow" || comparison.automaticRecoveryEnabled !== false || comparison.corpusVersion !== "2026-10-07" || !Number.isFinite(comparison.startedAt) || !Number.isFinite(comparison.completedAt) || comparison.startedAt <= 0 || comparison.completedAt < comparison.startedAt || comparison.completedAt > Date.now()) {
    throw new RecoveryVerificationPrerequisiteError("Run the backend-owned synthetic Jev validation before validating the selected detector. Comparison validation never calls a model and does not verify recovery safety.");
  }
  const detectorIds = new Set(comparison.summaries.map(summary => summary.detectorId));
  if (detectorIds.size !== comparison.summaries.length || !detectorIds.has(detectorId)) throw new RecoveryVerificationPrerequisiteError("The completed synthetic validation does not include the selected detector.");
  const selected = comparison.summaries.find(summary => summary.detectorId === detectorId)!;
  const rows = comparison.evaluations.filter(row => row.detectorId === detectorId);
  if (selected.evaluated !== RECOVERY_SHADOW_CORPUS.length || selected.failures !== 0 || rows.length !== RECOVERY_SHADOW_CORPUS.length || RECOVERY_SHADOW_CORPUS.some(item => rows.filter(row => row.caseId === item.id && row.expected === item.expected && row.expectedAction === item.policyAction && row.error === null && row.judgment !== null).length !== 1)) {
    throw new RecoveryVerificationPrerequisiteError("The selected detector lacks a complete, failure-free comparison against the bundled synthetic corpus.");
  }
  return comparison;
}

export function createRecoveryVerifier(options: RecoveryVerifierOptions): RecoveryVerifier {
  return {
    async validateDetectorComparison(detectorId, callOptions = {}) {
      callOptions.signal?.throwIfAborted();
      if (!detectorId || await options.selectedDetectorId() !== detectorId) throw new RecoveryVerificationPrerequisiteError("Approve this exact detector in backend Nudger settings before comparison validation.");
      const comparison = structuredClone(requireComparison(await options.readShadowComparison(), detectorId));
      callOptions.signal?.throwIfAborted();
      if (await options.selectedDetectorId() !== detectorId) throw new RecoveryVerificationPrerequisiteError("Selected detector changed during comparison validation");
      return comparison;
    },
  };
}
