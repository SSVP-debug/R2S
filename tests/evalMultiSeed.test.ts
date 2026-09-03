import { describe, it, expect } from "vitest";
import { runEvaluation, DEFAULT_EVALUATION_SEEDS } from "../src/evaluation/experimentRunner.js";
import { computeAggregateStats } from "../src/evaluation/aggregate.js";

describe("evaluation: multi-seed methodology", () => {
  it("supports at least 5 deterministic seeds, and DEFAULT_EVALUATION_SEEDS provides exactly that", () => {
    expect(DEFAULT_EVALUATION_SEEDS.length).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_EVALUATION_SEEDS).toEqual([
      "evaluation-001",
      "evaluation-002",
      "evaluation-003",
      "evaluation-004",
      "evaluation-005",
    ]);
  });

  it("all configured seeds execute — none is silently skipped", async () => {
    const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS, maxCohortSize: 40 });
    expect(result.seedResults.length).toBe(DEFAULT_EVALUATION_SEEDS.length);
    expect(result.seedResults.map((s) => s.seed)).toEqual(DEFAULT_EVALUATION_SEEDS);
  });

  it("each seed gets the same cohort size between the two strategies (fairness holds per-seed)", async () => {
    const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS, maxCohortSize: 40 });
    for (const seedResult of result.seedResults) {
      expect(seedResult.baselineMetrics.eligibleFailedPayments).toBe(seedResult.cohortSize);
      expect(seedResult.r2sMetrics.eligibleFailedPayments).toBe(seedResult.cohortSize);
    }
  });

  it("aggregate statistics match an independent recomputation via computeAggregateStats", async () => {
    const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS, maxCohortSize: 40 });

    const expectedBaselineRecoveryRate = computeAggregateStats(
      result.seedResults.map((s) => s.baselineMetrics.recoveryRate),
    );
    expect(result.aggregate.recoveryRate.baseline).toEqual(expectedBaselineRecoveryRate);

    const expectedR2sRevenue = computeAggregateStats(result.seedResults.map((s) => s.r2sMetrics.recoveredRevenue));
    expect(result.aggregate.recoveredRevenue.r2s).toEqual(expectedR2sRevenue);
  });

  it("standard deviation in the aggregate is nonzero when seeds genuinely differ", async () => {
    const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS, maxCohortSize: 40 });
    // Different seeds produce different synthetic populations, so recovery
    // rate should not be perfectly identical across all 5 (this would only
    // be 0 by coincidence, which is not expected here).
    expect(result.aggregate.recoveryRate.baseline.standardDeviation).toBeGreaterThan(0);
  });

  it("both decision-quality aggregates are R2S-only and exclude non-applicable seeds rather than treating them as 0", async () => {
    const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS, maxCohortSize: 40 });

    const applicableLabelSeeds = result.seedResults.filter(
      (s) => s.r2sMetrics.groundTruthLabelAgreementRate !== null,
    );
    expect(result.aggregate.groundTruthLabelAgreementRate.r2s.sampleCount).toBe(applicableLabelSeeds.length);

    const applicableOptimalSeeds = result.seedResults.filter(
      (s) => s.r2sMetrics.bestAvailableActionAgreementRate !== null,
    );
    expect(result.aggregate.bestAvailableActionAgreementRate.r2s.sampleCount).toBe(
      applicableOptimalSeeds.length,
    );
  });

  it("throws rather than silently producing a partial aggregate when no seeds are configured", async () => {
    await expect(runEvaluation({ seeds: [] })).rejects.toThrow();
  });
});
