import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/rng.js";
import {
  simulateAttemptOutcome,
  computeEffectiveProbability,
  ACTION_EFFECTIVENESS,
} from "../src/outcome/simulateOutcome.js";
import { RECOVERY_ACTIONS } from "../src/ai/types.js";
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

describe("action-conditioned outcome model: the model exists and covers every RecoveryAction", () => {
  it("every RecoveryAction is handled by simulateAttemptOutcome without throwing", () => {
    const gt = makeGroundTruth();
    const rng = createRng("action-coverage");
    for (const action of RECOVERY_ACTIONS) {
      expect(() => simulateAttemptOutcome(rng, gt, action, 1, 100000)).not.toThrow();
    }
  });

  it("ACTION_EFFECTIVENESS defines a multiplier for every genuine recovery action", () => {
    const genuineActions = RECOVERY_ACTIONS.filter((a) => a !== "ESCALATE" && a !== "STOP");
    for (const action of genuineActions) {
      expect(typeof ACTION_EFFECTIVENESS[action as keyof typeof ACTION_EFFECTIVENESS]).toBe(
        "number",
      );
    }
  });

  it("RETRY_NOW's multiplier is exactly 1.0 (neutral — preserves Aug 29 baseline numerics)", () => {
    expect(ACTION_EFFECTIVENESS.RETRY_NOW).toBe(1.0);
  });
});

describe("action-conditioned outcome model: STOP/ESCALATE produce no recovery attempt outcome", () => {
  it("simulateAttemptOutcome returns null for STOP", () => {
    const gt = makeGroundTruth();
    const rng = createRng("stop-outcome");
    expect(simulateAttemptOutcome(rng, gt, "STOP", 1, 100000)).toBeNull();
  });

  it("simulateAttemptOutcome returns null for ESCALATE", () => {
    const gt = makeGroundTruth();
    const rng = createRng("escalate-outcome");
    expect(simulateAttemptOutcome(rng, gt, "ESCALATE", 1, 100000)).toBeNull();
  });

  it("computeEffectiveProbability returns null for STOP and ESCALATE", () => {
    const gt = makeGroundTruth();
    expect(computeEffectiveProbability(gt, "STOP", 1)).toBeNull();
    expect(computeEffectiveProbability(gt, "ESCALATE", 1)).toBeNull();
  });

  it("STOP/ESCALATE do not consume an RNG draw (no attempt is simulated at all)", () => {
    // If STOP/ESCALATE drew from the rng, the rng's internal state would
    // advance; verify it doesn't by comparing a subsequent real draw
    // against a fresh rng with the same seed that never made the
    // STOP/ESCALATE calls.
    const gt = makeGroundTruth();
    const rngA = createRng("no-draw-check");
    simulateAttemptOutcome(rngA, gt, "STOP", 1, 100000);
    simulateAttemptOutcome(rngA, gt, "ESCALATE", 1, 100000);
    const nextFromA = rngA.next();

    const rngB = createRng("no-draw-check");
    const nextFromB = rngB.next();

    expect(nextFromA).toBe(nextFromB);
  });
});

describe("action-conditioned outcome model: probability/model behavior is tested directly (not via a single lucky draw)", () => {
  it("computeEffectiveProbability differs by action for the same ground truth/attempt (direct, non-random)", () => {
    const gt = makeGroundTruth({ recoveryProbability: 0.5 });
    const retryNow = computeEffectiveProbability(gt, "RETRY_NOW", 1);
    const retryLater = computeEffectiveProbability(gt, "RETRY_LATER", 1);
    const sendReminder = computeEffectiveProbability(gt, "SEND_REMINDER", 1);
    const offerIncentive = computeEffectiveProbability(gt, "OFFER_INCENTIVE", 1);
    const sendPaymentLink = computeEffectiveProbability(gt, "SEND_PAYMENT_LINK", 1);

    // All five differ from each other in a documented, deterministic way.
    expect(offerIncentive).toBeGreaterThan(retryNow!);
    expect(sendPaymentLink).toBeGreaterThan(retryNow!);
    expect(retryLater).toBeLessThan(retryNow!);
    expect(sendReminder).toBeLessThan(retryLater!);

    // Concretely: OFFER_INCENTIVE is the most effective, SEND_REMINDER the
    // least, matching the documented ACTION_EFFECTIVENESS ordering.
    const ordering = [sendReminder, retryLater, retryNow, sendPaymentLink, offerIncentive];
    for (let i = 1; i < ordering.length; i++) {
      expect(ordering[i]!).toBeGreaterThan(ordering[i - 1]!);
    }
  });

  it("computeEffectiveProbability is an exact, reproducible function of ground truth, action, and attempt number", () => {
    const gt = makeGroundTruth({ recoveryProbability: 0.6 });
    const expected = Math.min(0.98, Math.max(0.01, 0.6 * 1 * ACTION_EFFECTIVENESS.OFFER_INCENTIVE));
    expect(computeEffectiveProbability(gt, "OFFER_INCENTIVE", 1)).toBeCloseTo(expected, 10);
  });

  it("a non-recoverable payment has effective probability 0 regardless of action", () => {
    const gt = makeGroundTruth({ recoverable: false, recoveryProbability: 0.99 });
    for (const action of ["RETRY_NOW", "OFFER_INCENTIVE", "SEND_PAYMENT_LINK"] as const) {
      expect(computeEffectiveProbability(gt, action, 1)).toBe(0);
    }
  });

  it("deterministic seeded batch test: over many controlled samples, OFFER_INCENTIVE recovers strictly more often than SEND_REMINDER for identical inputs", () => {
    // A single random draw could go either way by chance; a large batch
    // with a fixed seed removes that risk while staying fully
    // deterministic and reproducible.
    const gt = makeGroundTruth({ recoveryProbability: 0.5, recoverable: true });
    const trials = 5000;

    function successRate(action: "OFFER_INCENTIVE" | "SEND_REMINDER", seed: string): number {
      const rng = createRng(seed);
      let successes = 0;
      for (let i = 0; i < trials; i++) {
        const result = simulateAttemptOutcome(rng, gt, action, 1, 100000);
        if (result?.success) successes++;
      }
      return successes / trials;
    }

    const incentiveRate = successRate("OFFER_INCENTIVE", "batch-incentive");
    const reminderRate = successRate("SEND_REMINDER", "batch-reminder");

    expect(incentiveRate).toBeGreaterThan(reminderRate);
    // Sanity: both rates land in a plausible neighborhood of their
    // theoretical effective probabilities (0.575 and 0.425 respectively).
    expect(incentiveRate).toBeGreaterThan(0.52);
    expect(incentiveRate).toBeLessThan(0.63);
    expect(reminderRate).toBeGreaterThan(0.37);
    expect(reminderRate).toBeLessThan(0.48);
  });

  it("changing ONLY the selected action (same payment/ground truth/seed) changes the outcome for at least one draw in a batch", () => {
    // Directly demonstrates that action selection matters: replaying the
    // exact same seeded rng sequence against two different actions
    // produces a different pattern of successes across the batch (not
    // just a different aggregate rate).
    const gt = makeGroundTruth({ recoveryProbability: 0.5, recoverable: true });
    const trials = 200;

    function outcomesFor(action: "OFFER_INCENTIVE" | "SEND_REMINDER"): boolean[] {
      const rng = createRng("same-seed-both-actions");
      const results: boolean[] = [];
      for (let i = 0; i < trials; i++) {
        results.push(simulateAttemptOutcome(rng, gt, action, 1, 100000)!.success);
      }
      return results;
    }

    const incentiveOutcomes = outcomesFor("OFFER_INCENTIVE");
    const reminderOutcomes = outcomesFor("SEND_REMINDER");

    expect(incentiveOutcomes).not.toEqual(reminderOutcomes);
  });
});

describe("action-conditioned outcome model: deterministic reproducibility per action", () => {
  it("same seed + same ground truth + same action = identical result", () => {
    const gt = makeGroundTruth();
    for (const action of ["RETRY_NOW", "RETRY_LATER", "SEND_PAYMENT_LINK", "SEND_REMINDER", "OFFER_INCENTIVE"] as const) {
      const a = simulateAttemptOutcome(createRng(`repro-${action}`), gt, action, 1, 100000);
      const b = simulateAttemptOutcome(createRng(`repro-${action}`), gt, action, 1, 100000);
      expect(a).toEqual(b);
    }
  });

  it("the SAME seed with a DIFFERENT action is not guaranteed to be identical (different effective probability)", () => {
    const gt = makeGroundTruth({ recoveryProbability: 0.5 });
    const a = simulateAttemptOutcome(createRng("cross-action-seed"), gt, "OFFER_INCENTIVE", 1, 100000);
    const b = simulateAttemptOutcome(createRng("cross-action-seed"), gt, "SEND_REMINDER", 1, 100000);
    // Same rng draw value compared against two different thresholds can
    // legitimately land on different sides for some seeds — the model is
    // still fully deterministic (each individual call is 100%
    // reproducible, as proven above); this test just documents that nudging
    // the threshold is exactly how action-conditioning is implemented.
    const drawValue = createRng("cross-action-seed").next();
    const probIncentive = computeEffectiveProbability(gt, "OFFER_INCENTIVE", 1)!;
    const probReminder = computeEffectiveProbability(gt, "SEND_REMINDER", 1)!;
    expect(a!.success).toBe(drawValue < probIncentive);
    expect(b!.success).toBe(drawValue < probReminder);
  });
});

describe("action-conditioned outcome model: does not leak ground truth or action-model internals", () => {
  it("the returned AttemptOutcome never contains recoveryProbability/bestAction/recoverable, for any action", () => {
    const gt = makeGroundTruth();
    const rng = createRng("no-leak-check");
    for (const action of ["RETRY_NOW", "RETRY_LATER", "SEND_PAYMENT_LINK", "SEND_REMINDER", "OFFER_INCENTIVE"] as const) {
      const result = simulateAttemptOutcome(rng, gt, action, 1, 100000);
      const keys = Object.keys(result ?? {});
      expect(keys).not.toContain("recoveryProbability");
      expect(keys).not.toContain("bestAction");
      expect(keys).not.toContain("recoverable");
      expect(keys).not.toContain("effectiveProbability");
      expect(keys).not.toContain("actionMultiplier");
    }
  });
});
