import { describe, it, expect } from "vitest";
import { compareStrategies } from "../src/evaluation/comparison.js";
import type { StrategyEvaluationMetrics } from "../src/evaluation/strategyMetrics.js";

function metrics(partial: Partial<StrategyEvaluationMetrics>): StrategyEvaluationMetrics {
  return {
    eligibleFailedPayments: 10,
    recoveredPayments: 5,
    recoveryRate: 0.5,
    recoveredRevenue: 5000,
    executedRecoveryAttempts: 10,
    recoveryEfficiency: 500,
    policyBlocks: 0,
    escalations: 0,
    actionDistribution: {},
    averageAttemptsPerRecoveredPayment: 2,
    groundTruthLabelAgreementRate: null,
    bestAvailableActionAgreementRate: null,
    ...partial,
  };
}

describe("evaluation: compareStrategies", () => {
  it("computes absolute delta as r2s - baseline", () => {
    const cmp = compareStrategies(
      metrics({ recoveryRate: 0.4, recoveredRevenue: 4000 }),
      metrics({ recoveryRate: 0.6, recoveredRevenue: 7000 }),
    );
    expect(cmp.recoveryRate.absoluteDelta).toBeCloseTo(0.2);
    expect(cmp.recoveredRevenue.absoluteDelta).toBe(3000);
  });

  it("computes percentage delta as (r2s - baseline) / baseline * 100", () => {
    const cmp = compareStrategies(metrics({ recoveryRate: 0.4 }), metrics({ recoveryRate: 0.6 }));
    expect(cmp.recoveryRate.percentageDelta).toBeCloseTo(50);
  });

  it("returns null percentageDelta when baseline is 0 (not NaN/Infinity)", () => {
    const cmp = compareStrategies(
      metrics({ recoveryEfficiency: 0 }),
      metrics({ recoveryEfficiency: 100 }),
    );
    expect(cmp.recoveryEfficiency.percentageDelta).toBeNull();
    expect(cmp.recoveryEfficiency.absoluteDelta).toBe(100);
  });

  it("computes incrementalRecoveredRevenue as r2s.recoveredRevenue - baseline.recoveredRevenue", () => {
    const cmp = compareStrategies(metrics({ recoveredRevenue: 4000 }), metrics({ recoveredRevenue: 4500 }));
    expect(cmp.incrementalRecoveredRevenue).toBe(500);
    expect(cmp.incrementalRecoveredRevenue).toBe(cmp.recoveredRevenue.absoluteDelta);
  });

  it("correctly reports a negative delta when R2S underperforms the baseline (evaluation must not assume R2S wins)", () => {
    const cmp = compareStrategies(
      metrics({ recoveryRate: 0.7, recoveredRevenue: 7000 }),
      metrics({ recoveryRate: 0.5, recoveredRevenue: 5000 }),
    );
    expect(cmp.recoveryRate.absoluteDelta).toBeLessThan(0);
    expect(cmp.incrementalRecoveredRevenue).toBeLessThan(0);
  });

  it("does not compute ROI or profit fields (no cost model)", () => {
    const cmp = compareStrategies(metrics({}), metrics({}));
    expect(cmp).not.toHaveProperty("roi");
    expect(cmp).not.toHaveProperty("profit");
  });
});
