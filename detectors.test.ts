import assert from "node:assert/strict";
import { test } from "node:test";
import { createJevDetector, jevBlockerFacts, jevCheckIn, routeJevAnswers, runShadowComparison } from "./detectors.js";
import { JEV_NO_CREDITS } from "./continuation-copy.js";
import type { FinalMessageClassifier, FinalMessageJudgment } from "./recovery-contract.js";
import { RECOVERY_SHADOW_CORPUS } from "./recovery-shadow-corpus.js";

function judgment(classification: FinalMessageJudgment["classification"]): FinalMessageJudgment {
  return { classification, model: "fixture", latencyMs: 1, usage: { inputTokens: null, outputTokens: null, cost: null }, confidence: null, probabilities: null, questions: null };
}

test("Jev missing permission outranks a continuation-looking ending and preserves reported usage only", async () => {
  const detector = createJevDetector({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          obstacle: { type: "choice", choice: "permission", confidence: 0.7, probabilities: { none: 0.1, blocker: 0.1, permission: 0.7, uncertainty: 0.1 } },
          boundary: { type: "choice", choice: "continue", confidence: 0.2, probabilities: { continue: 0.4, finished: 0.3, uncertainty: 0.3 } },
        },
        usage: { input_tokens: 200, output_tokens: 30 },
      }), { status: 200 });
    },
  });
  const finalMessage = "Implementation remains, but publishing needs your authorization.";
  const result = await detector.classify(finalMessage);
  assert.equal(result.classification, "permission");
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 30, cost: null });
  assert.equal(result.probabilities, null);
  assert.equal(result.questions?.boundary?.choice, "continue");
});

test("Jev does not nudge when absence of an obstacle is uncertain despite a confident continuation boundary", () => {
  const result = routeJevAnswers({
    obstacle: { type: "choice", choice: "none", confidence: 0.4, probabilities: { none: 0.55, blocker: 0.15, permission: 0.15, uncertainty: 0.15 } },
    boundary: { type: "choice", choice: "continue", confidence: 0.95, probabilities: { continue: 0.98, finished: 0.01, uncertainty: 0.01 } },
  });
  assert.equal(result.classification, "uncertainty");
  assert.equal(result.confidence, 0.4);
});

test("Jev requires the higher continuation threshold even when both judgments clear the general uncertainty floor", () => {
  const result = routeJevAnswers({
    obstacle: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.97, blocker: 0.01, permission: 0.01, uncertainty: 0.01 } },
    boundary: { type: "choice", choice: "continue", confidence: 0.8, probabilities: { continue: 0.9, finished: 0.05, uncertainty: 0.05 } },
  });
  assert.equal(result.classification, "uncertainty");
});

test("an ending reporting a state the operator chose is settled: not an obstacle, not work to nudge", () => {
  const obstacle = { type: "choice" as const, choice: "uncertainty" as const, confidence: 0.9, probabilities: { none: 0.05, blocker: 0.03, permission: 0.02, uncertainty: 0.9 } };
  const boundary = { type: "choice" as const, choice: "continue" as const, confidence: 0.95, probabilities: { continue: 0.95, finished: 0.03, uncertainty: 0.02 } };
  const ending = (choice: "request" | "operator_chosen" | "report", confidence: number) => ({ type: "choice" as const, choice, confidence, probabilities: { request: 0, operator_chosen: 0, report: 0, [choice]: confidence } });
  // "Understood: the Jev arcade is frozen. I won't restore or request the credential."
  assert.deepEqual(routeJevAnswers({ obstacle, boundary, ending: ending("operator_chosen", 0.8) }), { classification: "finished", confidence: 0.8 });
  assert.equal(routeJevAnswers({ obstacle: { ...obstacle, choice: "none", confidence: 0.95 }, boundary, ending: ending("operator_chosen", 0.8) }).classification, "finished");
  // Below the confidence floor, or a real request, the obstacle reading stands.
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: ending("operator_chosen", 0.5) }).classification, "uncertainty");
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: ending("request", 0.9) }).classification, "uncertainty");
});

test("a nudge now needs Jev to name the assistant itself as next, and never follows an ending that asks the operator", () => {
  const obstacle = { type: "choice" as const, choice: "none" as const, confidence: 1, probabilities: { none: 1, blocker: 0, permission: 0, uncertainty: 0 } };
  const boundary = { type: "choice" as const, choice: "continue" as const, confidence: 0.95, probabilities: { continue: 0.95, finished: 0.03, uncertainty: 0.02 } };
  const report = { type: "choice" as const, choice: "report" as const, confidence: 1, probabilities: { request: 0, operator_chosen: 0, report: 1 } };
  const waitsOn = (choice: "assistant" | "running" | "operator" | "nothing", confidence: number) => ({ type: "choice" as const, choice, confidence, probabilities: { assistant: 0, running: 0, operator: 0, nothing: 0, [choice]: confidence } });
  const nudge = routeJevAnswers({ obstacle, boundary, ending: report, waits_on: waitsOn("assistant", 0.7) });
  assert.deepEqual(nudge, { classification: "continue", confidence: 0.7 });
  assert.equal(jevCheckIn({ classification: nudge.classification, questions: { waits_on: waitsOn("assistant", 0.7) } }), false);
  // Without waits_on, or when Jev cannot tell who is next, the ending is reported rather than nudged.
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: report }).classification, "uncertainty");
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: report, waits_on: waitsOn("assistant", 0.5) }).classification, "uncertainty");
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: report, waits_on: waitsOn("operator", 0.9) }).classification, "uncertainty");
  // "Please send each bot one message, then fill in the form so I can pass your answers on."
  const request = { ...report, choice: "request" as const, probabilities: { request: 1, operator_chosen: 0, report: 0 } };
  assert.equal(routeJevAnswers({ obstacle, boundary, ending: request, waits_on: waitsOn("assistant", 0.97) }).classification, "uncertainty");
});

test("work running in a delegated thread or task gets a late check-in; a named obstacle or an operator request still reports", () => {
  const none = { type: "choice" as const, choice: "none" as const, confidence: 0.8, probabilities: { none: 0.8, blocker: 0.1, permission: 0.05, uncertainty: 0.05 } };
  const boundary = { type: "choice" as const, choice: "continue" as const, confidence: 0.7, probabilities: { continue: 0.7, finished: 0.1, uncertainty: 0.2 } };
  const report = { type: "choice" as const, choice: "report" as const, confidence: 1, probabilities: { request: 0, operator_chosen: 0, report: 1 } };
  const running = { type: "choice" as const, choice: "running" as const, confidence: 0.9, probabilities: { assistant: 0.05, running: 0.9, operator: 0.05, nothing: 0 } };
  // "The change is with fixture-delegated-thread. I'll write once it's done."
  const checkIn = routeJevAnswers({ obstacle: none, boundary, ending: report, waits_on: running });
  assert.deepEqual(checkIn, { classification: "continue", confidence: 0.8 });
  assert.equal(jevCheckIn({ classification: checkIn.classification, questions: { waits_on: running } }), true);
  assert.equal(routeJevAnswers({ obstacle: none, boundary, ending: report, waits_on: { ...running, confidence: 0.5 } }).classification, "uncertainty");
  const blocker = { ...none, choice: "blocker" as const, confidence: 0.9 };
  assert.equal(routeJevAnswers({ obstacle: blocker, boundary, ending: report, waits_on: running }).classification, "blocker");
  const request = { ...report, choice: "request" as const, probabilities: { request: 1, operator_chosen: 0, report: 0 } };
  assert.equal(routeJevAnswers({ obstacle: none, boundary, ending: request, waits_on: running }).classification, "uncertainty");
});

test("the detector keeps ending and consequence answers, which become blocker facts; older judgments have none", async () => {
  const detector = createJevDetector({ apiKey: "test-key", fetch: async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: {
    obstacle: { type: "choice", choice: "permission", confidence: 0.9, probabilities: { none: 0.05, blocker: 0.03, permission: 0.9, uncertainty: 0.02 } },
    boundary: { type: "choice", choice: "continue", confidence: 0.6, probabilities: { continue: 0.6, finished: 0.2, uncertainty: 0.2 } },
    ending: { type: "choice", choice: "request", confidence: 0.9, probabilities: { request: 0.9, operator_chosen: 0.05, report: 0.05 } },
    consequence: { type: "choice", choice: "money", confidence: 0.8, probabilities: { money: 0.8, data: 0.05, production: 0.05, "priority-product": 0.04, irreversible: 0.03, none: 0.03 } },
  } })) });
  const result = await detector.classify("Provisioning needs a paid instance. Please authorize the charge.");
  assert.equal(result.classification, "permission");
  assert.deepEqual(jevBlockerFacts(result.questions), { consequence: "money", operatorRequest: true });
  assert.deepEqual(jevBlockerFacts(null), {});
  assert.deepEqual(jevBlockerFacts({ obstacle: { choice: "blocker", confidence: 1, probabilities: {} } }), {});
});

test("malformed Jev output does not become a default continuation", async () => {
  const detector = createJevDetector({ apiKey: "test-key", fetch: async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} })) });
  await assert.rejects(detector.classify("I will continue the remaining work."));
});

test("TypeSafe refusing for billing reads as out of credits, other HTTP failures stay generic", async () => {
  const billing = createJevDetector({ apiKey: "test-key", fetch: async () => new Response(JSON.stringify({ detail: { error_type: "billing_error" } }), { status: 402 }) });
  await assert.rejects(billing.classify("Done."), { message: JEV_NO_CREDITS });
  const outage = createJevDetector({ apiKey: "test-key", fetch: async () => new Response("", { status: 503 }) });
  await assert.rejects(outage.classify("Done."), { message: "Jev evaluation failed with HTTP 503" });
});

test("shadow comparison measures false nudges and blocker misses without feeding labels or Stop into detectors", async () => {
  const continueDetector: FinalMessageClassifier = { id: "always-continue", classify: async () => judgment("continue") };
  const finishedDetector: FinalMessageClassifier = { id: "always-finished", classify: async () => judgment("finished") };
  const result = await runShadowComparison({ detectors: [continueDetector, finishedDetector] });
  const summary = result.summaries.find((item) => item.detectorId === continueDetector.id)!;
  assert.equal(summary.falseNudges, RECOVERY_SHADOW_CORPUS.filter((item) => !item.stopped && item.policyAction !== "nudge").length);
  assert.equal(summary.blockerMisses, RECOVERY_SHADOW_CORPUS.filter((item) => item.policyAction === "report").length);
  assert.equal(summary.stoppedNudges, 0);
  assert.deepEqual(summary.usage, { inputTokens: null, outputTokens: null, cost: null });
  assert.equal(result.automaticRecoveryEnabled, false);
});
