// =============================================================================
// Baseline vs. R2S comparison (Sep 2)
// =============================================================================
// Pure functions over two StrategyEvaluationMetrics — no repository access,
// no ground truth, no assumption about which side wins. Per spec item 12:
// absolute delta (R2S - Baseline), percentage delta where mathematically
// valid (division by zero -> null, not NaN/Infinity), and incremental
// recovered revenue. No ROI/profit calculation — no cost model exists.
// =============================================================================

import type { StrategyEvaluationMetrics } from "./strategyMetrics.js";

export interface MetricComparison {
  baseline: number;
  r2s: number;
  /** r2s - baseline. */
  absoluteDelta: number;
  /** (r2s - baseline) / baseline * 100, or null if baseline is 0 (division
   * by zero is not mathematically valid — never reported as 0/NaN/Infinity). */
  percentageDelta: number | null;
}

export interface SeedComparison {
  recoveryRate: MetricComparison;
  recoveredRevenue: MetricComparison;
  executedRecoveryAttempts: MetricComparison;
  recoveryEfficiency: MetricComparison;
  policyBlocks: MetricComparison;
  escalations: MetricComparison;
  averageAttemptsPerRecoveredPayment: MetricComparison;
  /** R2S recovered revenue - Baseline recovered revenue, minor units. Same
   * number as recoveredRevenue.absoluteDelta — surfaced under its spec
   * name (item 12) for clarity in the result artifact/CLI report. */
  incrementalRecoveredRevenue: number;
}

function compare(baseline: number, r2s: number): MetricComparison {
  const absoluteDelta = r2s - baseline;
  const percentageDelta = baseline === 0 ? null : (absoluteDelta / baseline) * 100;
  return { baseline, r2s, absoluteDelta, percentageDelta };
}

export function compareStrategies(
  baseline: StrategyEvaluationMetrics,
  r2s: StrategyEvaluationMetrics,
): SeedComparison {
  return {
    recoveryRate: compare(baseline.recoveryRate, r2s.recoveryRate),
    recoveredRevenue: compare(baseline.recoveredRevenue, r2s.recoveredRevenue),
    executedRecoveryAttempts: compare(baseline.executedRecoveryAttempts, r2s.executedRecoveryAttempts),
    recoveryEfficiency: compare(baseline.recoveryEfficiency, r2s.recoveryEfficiency),
    policyBlocks: compare(baseline.policyBlocks, r2s.policyBlocks),
    escalations: compare(baseline.escalations, r2s.escalations),
    averageAttemptsPerRecoveredPayment: compare(
      baseline.averageAttemptsPerRecoveredPayment,
      r2s.averageAttemptsPerRecoveredPayment,
    ),
    incrementalRecoveredRevenue: r2s.recoveredRevenue - baseline.recoveredRevenue,
  };
}
