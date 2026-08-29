import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/rng.js";
import { simulateAttemptOutcome } from "../src/outcome/simulateOutcome.js";
import type { GroundTruth } from "../src/domain/types.js";

function makeGroundTruth(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    id: "gt_1",
    paymentId: "pay_1",
    recoverable: true,
    recoveryProbability: 0.7,
    bestAction: "retry_immediate",
    recoveredAmount: 100000,
    simulationRunId: "run_test",
    ...overrides,
  };
}

describe("outcome simulation", () => {
  it("always fails when ground truth says not recoverable", () => {
    const gt = makeGroundTruth({ recoverable: false, recoveryProbability: 0.9 });
    const rng = createRng("outcome-1");
    for (let i = 1; i <= 5; i++) {
      const result = simulateAttemptOutcome(rng, gt, i, 100000);
      expect(result.success).toBe(false);
      expect(result.amountRecovered).toBe(0);
    }
  });

  it("is deterministic given the same seeded rng sequence", () => {
    const gt = makeGroundTruth();
    const a = simulateAttemptOutcome(createRng("outcome-det"), gt, 1, 100000);
    const b = simulateAttemptOutcome(createRng("outcome-det"), gt, 1, 100000);
    expect(a).toEqual(b);
  });

  it("never recovers more than the ground-truth recoveredAmount or the payment amount", () => {
    const gt = makeGroundTruth({ recoveredAmount: 50000, recoverable: true, recoveryProbability: 0.99 });
    const rng = createRng("outcome-cap");
    for (let i = 1; i <= 30; i++) {
      const result = simulateAttemptOutcome(rng, gt, i, 40000);
      expect(result.amountRecovered).toBeLessThanOrEqual(50000);
      expect(result.amountRecovered).toBeLessThanOrEqual(40000);
    }
  });

  it("does not leak ground-truth fields onto the returned outcome object", () => {
    const gt = makeGroundTruth();
    const result = simulateAttemptOutcome(createRng("outcome-leak"), gt, 1, 100000);
    const keys = Object.keys(result);
    expect(keys).toEqual(expect.arrayContaining(["success", "amountRecovered"]));
    expect(keys).not.toContain("recoveryProbability");
    expect(keys).not.toContain("bestAction");
    expect(keys).not.toContain("recoverable");
  });

  it("success rate over many trials approximates the ground-truth recovery probability", () => {
    const gt = makeGroundTruth({ recoveryProbability: 0.6, recoverable: true });
    const rng = createRng("outcome-statistical");
    const trials = 4000;
    let successes = 0;
    for (let i = 0; i < trials; i++) {
      // attemptNumber fixed at 1 so there's no decay applied, to test the
      // raw probability alignment cleanly.
      const result = simulateAttemptOutcome(rng, gt, 1, 100000);
      if (result.success) successes++;
    }
    const observedRate = successes / trials;
    expect(observedRate).toBeGreaterThan(0.55);
    expect(observedRate).toBeLessThan(0.65);
  });

  it("applies diminishing returns: later attempts have lower effective success rate than attempt 1", () => {
    const gt = makeGroundTruth({ recoveryProbability: 0.8, recoverable: true });
    const trials = 3000;

    const successRateAtAttempt = (attemptNumber: number, seed: string) => {
      const rng = createRng(seed);
      let successes = 0;
      for (let i = 0; i < trials; i++) {
        if (simulateAttemptOutcome(rng, gt, attemptNumber, 100000).success) successes++;
      }
      return successes / trials;
    };

    const rate1 = successRateAtAttempt(1, "decay-1");
    const rate3 = successRateAtAttempt(3, "decay-3");
    expect(rate3).toBeLessThan(rate1);
  });
});
