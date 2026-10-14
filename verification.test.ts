import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryVerifier } from "./verification.js";
import { runShadowComparison, type ShadowComparison } from "./detectors.js";
import { RECOVERY_SHADOW_CORPUS } from "./recovery-shadow-corpus.js";
import type { FinalMessageClassifier } from "./recovery-contract.js";

const classifier = (id: string): FinalMessageClassifier => ({
  id,
  async classify(text) {
    const classification = RECOVERY_SHADOW_CORPUS.find(item => item.finalAssistantMessage === text)!.expected;
    return { classification, model: "unit-fixture-only", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, cost: null }, confidence: null, probabilities: null, questions: null };
  },
});
async function comparison(): Promise<ShadowComparison> {
  return runShadowComparison({ detectors: [classifier("chosen")] });
}

test("comparison validation requires an approved selection and complete backend comparison", async () => {
  let evidence: ShadowComparison | null = null;
  const verifier = createRecoveryVerifier({ readShadowComparison: async () => evidence, selectedDetectorId: async () => "chosen" });
  await assert.rejects(verifier.validateDetectorComparison("other"), /Approve this exact detector/);
  await assert.rejects(verifier.validateDetectorComparison("chosen"), /synthetic Jev validation/);
  evidence = await comparison();
  const result = await verifier.validateDetectorComparison("chosen");
  assert.equal(result.evaluations.length, RECOVERY_SHADOW_CORPUS.length);
  assert.equal(result.automaticRecoveryEnabled, false);
});

test("duplicate corpus rows or incomplete selected evidence cannot approve the detector comparison", async () => {
  const evidence = await comparison();
  const selectedRows = evidence.evaluations.filter(row => row.detectorId === "chosen");
  const second = evidence.evaluations.indexOf(selectedRows[1]!);
  evidence.evaluations[second] = { ...selectedRows[0]! };
  const verifier = createRecoveryVerifier({ readShadowComparison: async () => evidence, selectedDetectorId: async () => "chosen" });
  await assert.rejects(verifier.validateDetectorComparison("chosen"), /complete, failure-free comparison/);
});

test("cancelled comparison validation reads no evidence", async () => {
  let reads = 0;
  const verifier = createRecoveryVerifier({ readShadowComparison: async () => { reads++; return null; }, selectedDetectorId: async () => { reads++; return "chosen"; } });
  const controller = new AbortController(); controller.abort(new Error("Operator cancelled"));
  await assert.rejects(verifier.validateDetectorComparison("chosen", { signal: controller.signal }), /Operator cancelled/);
  assert.equal(reads, 0);
});

test("selection changes during comparison validation discard evidence and results are isolated copies", async () => {
  const evidence = await comparison();
  let selected = "chosen";
  const verifier = createRecoveryVerifier({ readShadowComparison: async () => { selected = "other"; return evidence; }, selectedDetectorId: async () => selected });
  await assert.rejects(verifier.validateDetectorComparison("chosen"), /Selected detector changed/);
  const stable = createRecoveryVerifier({ readShadowComparison: async () => evidence, selectedDetectorId: async () => "chosen" });
  const result = await stable.validateDetectorComparison("chosen");
  result.evaluations.length = 0;
  assert.equal(evidence.evaluations.length, RECOVERY_SHADOW_CORPUS.length);
});
