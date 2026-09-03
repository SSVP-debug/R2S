import { describe, it, expect } from "vitest";
import {
  computeStrategyMetrics,
  computeBestAvailableAction,
  type StrategyPaymentOutcome,
} from "../src/evaluation/strategyMetrics.js";
import { ACTION_EFFECTIVENESS } from "../src/outcome/simulateOutcome.js";
import type { GroundTruth } from "../src/domain/types.js";

function outcome(partial: Partial<StrategyPaymentOutcome>): StrategyPaymentOutcome {
  return {
    paymentId: "pay_x",
    amount: 0,
    finalStatus: "failed",
    executedAttempts: 0,
    policyBlocks: 0,
    escalations: 0,
    actionCounts: {},
    groundTruthLabelAgreement: null,
    bestAvailableActionAgreement: null,
    ...partial,
  };
}

function groundTruth(partial: Partial<GroundTruth>): GroundTruth {
  return {
    id: "gt_x",
    paymentId: "pay_x",
    recoverable: true,
    recoveryProbability: 0.5,
    bestAction: "retry_delayed",
    recoveredAmount: 1000,
    simulationRunId: "sim_x",
    ...partial,
  };
}

describe("evaluation: computeStrategyMetrics formulas", () => {
  it("computes recovery rate, revenue, attempts, efficiency, and averageAttemptsPerRecoveredPayment on a known small set", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", amount: 1000, finalStatus: "recovered", executedAttempts: 2 }),
      outcome({ paymentId: "p2", amount: 2000, finalStatus: "recovered", executedAttempts: 1 }),
      outcome({ paymentId: "p3", amount: 500, finalStatus: "failed_final", executedAttempts: 3 }),
      outcome({ paymentId: "p4", amount: 700, finalStatus: "stopped", executedAttempts: 1 }),
    ];

    const metrics = computeStrategyMetrics(outcomes);

    expect(metrics.eligibleFailedPayments).toBe(4);
    expect(metrics.recoveredPayments).toBe(2);
    expect(metrics.recoveryRate).toBeCloseTo(0.5);
    expect(metrics.recoveredRevenue).toBe(3000);
    expect(metrics.executedRecoveryAttempts).toBe(7);
    expect(metrics.recoveryEfficiency).toBeCloseTo(3000 / 7);
    expect(metrics.averageAttemptsPerRecoveredPayment).toBeCloseTo(7 / 2);
  });

  it("sums policyBlocks and escalations across payments", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", policyBlocks: 2, escalations: 0 }),
      outcome({ paymentId: "p2", policyBlocks: 1, escalations: 3 }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.policyBlocks).toBe(3);
    expect(metrics.escalations).toBe(3);
  });

  it("aggregates actionDistribution across payments", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", actionCounts: { RETRY_NOW: 2, STOP: 1 } }),
      outcome({ paymentId: "p2", actionCounts: { RETRY_NOW: 1, ESCALATE: 1 } }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.actionDistribution).toEqual({ RETRY_NOW: 3, STOP: 1, ESCALATE: 1 });
  });

  it("does not count BLOCK/STOP/ESCALATE/skipped as executed recovery attempts", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({
        paymentId: "p1",
        executedAttempts: 1,
        policyBlocks: 5,
        escalations: 5,
        actionCounts: { STOP: 5, ESCALATE: 5, BLOCK: 5 } as any,
      }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.executedRecoveryAttempts).toBe(1);
  });

  it("handles zero eligible payments safely (0/0 -> 0, not NaN)", () => {
    const metrics = computeStrategyMetrics([]);
    expect(metrics.eligibleFailedPayments).toBe(0);
    expect(metrics.recoveryRate).toBe(0);
    expect(metrics.recoveryEfficiency).toBe(0);
    expect(metrics.averageAttemptsPerRecoveredPayment).toBe(0);
    expect(Number.isNaN(metrics.recoveryRate)).toBe(false);
  });

  it("handles zero executed attempts safely (recoveryEfficiency -> 0, not Infinity/NaN)", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", finalStatus: "recovered", amount: 500, executedAttempts: 0 }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.recoveryEfficiency).toBe(0);
    expect(Number.isFinite(metrics.recoveryEfficiency)).toBe(true);
  });

  it("handles zero recovered payments safely (averageAttemptsPerRecoveredPayment -> 0)", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", finalStatus: "failed_final", executedAttempts: 3 }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.averageAttemptsPerRecoveredPayment).toBe(0);
  });

  it("groundTruthLabelAgreementRate is null when no payment has an applicable value (e.g. baseline)", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", groundTruthLabelAgreement: null }),
      outcome({ paymentId: "p2", groundTruthLabelAgreement: null }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.groundTruthLabelAgreementRate).toBeNull();
  });

  it("groundTruthLabelAgreementRate averages only over applicable (non-null) values", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", groundTruthLabelAgreement: true }),
      outcome({ paymentId: "p2", groundTruthLabelAgreement: false }),
      outcome({ paymentId: "p3", groundTruthLabelAgreement: true }),
      outcome({ paymentId: "p4", groundTruthLabelAgreement: null }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.groundTruthLabelAgreementRate).toBeCloseTo(2 / 3);
  });

  it("bestAvailableActionAgreementRate is independently null/computed from groundTruthLabelAgreementRate", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", groundTruthLabelAgreement: true, bestAvailableActionAgreement: false }),
      outcome({ paymentId: "p2", groundTruthLabelAgreement: false, bestAvailableActionAgreement: true }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.groundTruthLabelAgreementRate).toBeCloseTo(0.5);
    expect(metrics.bestAvailableActionAgreementRate).toBeCloseTo(0.5);
    // Same average here by coincidence of the fixture, but driven by two
    // entirely separate fields — not derived from one another.
  });

  it("bestAvailableActionAgreementRate is null when no payment has an applicable value", () => {
    const outcomes: StrategyPaymentOutcome[] = [
      outcome({ paymentId: "p1", bestAvailableActionAgreement: null }),
      outcome({ paymentId: "p2", bestAvailableActionAgreement: null }),
    ];
    const metrics = computeStrategyMetrics(outcomes);
    expect(metrics.bestAvailableActionAgreementRate).toBeNull();
  });
});

// =============================================================================
// computeBestAvailableAction — final correction: restricted to the actions
// actually available (offered as candidates) to the agent for that
// specific payment, never the full RecoveryAction vocabulary.
// =============================================================================
describe("evaluation: computeBestAvailableAction (final correction)", () => {
  it("unavailable actions are excluded: OFFER_INCENTIVE (globally the highest multiplier) is never picked when it was not offered as a candidate", () => {
    const gt = groundTruth({ recoverable: true });
    // OFFER_INCENTIVE deliberately NOT included — mirrors reality, since
    // ai/candidateTranslation.ts's existing translation can never produce it.
    const available = ["RETRY_NOW", "RETRY_LATER", "STOP"] as const;
    const best = computeBestAvailableAction([...available], gt);
    expect(best).not.toBe("OFFER_INCENTIVE");
    expect(available).toContain(best);
  });

  it("the best AVAILABLE action is selected correctly: among a restricted set, picks the one with the highest ACTION_EFFECTIVENESS multiplier", () => {
    const gt = groundTruth({ recoverable: true });
    // Restrict to RETRY_LATER (0.9) and SEND_PAYMENT_LINK (1.05) — highest
    // among just these two is SEND_PAYMENT_LINK, even though
    // OFFER_INCENTIVE (1.15) would win if it were available.
    const best = computeBestAvailableAction(["RETRY_LATER", "SEND_PAYMENT_LINK", "STOP"], gt);
    expect(best).toBe("SEND_PAYMENT_LINK");
  });

  it("with only RETRY_NOW and RETRY_LATER available, RETRY_NOW (1.0 > 0.9) wins", () => {
    const gt = groundTruth({ recoverable: true });
    const best = computeBestAvailableAction(["RETRY_NOW", "RETRY_LATER"], gt);
    expect(best).toBe("RETRY_NOW");
  });

  it("a single available tactic action is trivially the best available action", () => {
    const gt = groundTruth({ recoverable: true });
    const best = computeBestAvailableAction(["RETRY_LATER", "STOP"], gt);
    expect(best).toBe("RETRY_LATER");
  });

  it("STOP/ESCALATE handling: when the payment is not recoverable, the best available action is STOP if STOP is offered", () => {
    const gt = groundTruth({ recoverable: false });
    const best = computeBestAvailableAction(["RETRY_NOW", "RETRY_LATER", "STOP"], gt);
    expect(best).toBe("STOP");
  });

  it("STOP/ESCALATE handling: when not recoverable and STOP is not offered but ESCALATE is, ESCALATE is the best available action", () => {
    const gt = groundTruth({ recoverable: false });
    const best = computeBestAvailableAction(["RETRY_NOW", "ESCALATE"], gt);
    expect(best).toBe("ESCALATE");
  });

  it("STOP/ESCALATE handling: when the ONLY available action is STOP (e.g. window expired / case closed candidate set), STOP is the best available action regardless of recoverability", () => {
    const gtRecoverable = groundTruth({ recoverable: true });
    const gtNotRecoverable = groundTruth({ recoverable: false });
    expect(computeBestAvailableAction(["STOP"], gtRecoverable)).toBe("STOP");
    expect(computeBestAvailableAction(["STOP"], gtNotRecoverable)).toBe("STOP");
  });

  it("STOP/ESCALATE handling: when only ESCALATE is available (e.g. repeated_failure's sole candidate), ESCALATE is the best available action", () => {
    const gt = groundTruth({ recoverable: true });
    expect(computeBestAvailableAction(["ESCALATE"], gt)).toBe("ESCALATE");
  });

  it("recoverable payments prefer a tactic action over STOP/ESCALATE when any tactic action is available", () => {
    const gt = groundTruth({ recoverable: true });
    const best = computeBestAvailableAction(["STOP", "RETRY_LATER"], gt);
    expect(best).toBe("RETRY_LATER");
  });

  it("throws on an empty available-actions list (defensive — should never occur, since candidate generation always yields at least one)", () => {
    const gt = groundTruth({ recoverable: true });
    expect(() => computeBestAvailableAction([], gt)).toThrow();
  });

  it("never returns an action outside the provided available set", () => {
    for (const recoverable of [true, false]) {
      const gt = groundTruth({ recoverable });
      const available = ["RETRY_LATER", "SEND_REMINDER", "ESCALATE"] as const;
      const best = computeBestAvailableAction([...available], gt);
      expect(available).toContain(best);
    }
  });

  it("demonstrates the correction directly: restricting availability to a low-multiplier-only set never falls back to a globally-better unavailable action", () => {
    const gt = groundTruth({ recoverable: true });
    // SEND_REMINDER (0.85) is the weakest tactic in ACTION_EFFECTIVENESS —
    // with it as the only available tactic, it must still be chosen over
    // any unavailable, globally-stronger action.
    const best = computeBestAvailableAction(["SEND_REMINDER", "STOP"], gt);
    expect(best).toBe("SEND_REMINDER");
    expect(ACTION_EFFECTIVENESS.SEND_REMINDER).toBeLessThan(ACTION_EFFECTIVENESS.OFFER_INCENTIVE);
  });
});
