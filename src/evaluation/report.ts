// =============================================================================
// CLI report formatting (Sep 2)
// =============================================================================
// Pure text formatting over an EvaluationResult — no computation happens
// here. Kept separate from experimentRunner.ts so the evaluation logic has
// no dependency on presentation.
// =============================================================================

import type { EvaluationResult } from "./experimentRunner.js";

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMoney(minorUnits: number): string {
  // Amounts are in minor currency units (paise) throughout R2S (see
  // domain/types.ts) — displayed here divided by 100 for readability only,
  // no currency conversion or rounding of the underlying figures.
  return `₹${(minorUnits / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatDelta(absolute: number, percentage: number | null, isPercentPoint = false): string {
  const sign = absolute >= 0 ? "+" : "";
  const absStr = isPercentPoint ? `${sign}${(absolute * 100).toFixed(1)}pp` : `${sign}${absolute.toFixed(2)}`;
  if (percentage === null) return absStr;
  const pctStr = `${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%`;
  return `${absStr} (${pctStr})`;
}

function pad(label: string, width: number): string {
  return label.padEnd(width);
}

function col(value: string, width: number): string {
  return value.padStart(width);
}

/** Renders a concise text report, matching the CLI format sketched in the
 * Sep 2 spec (item 16). */
export function renderReport(result: EvaluationResult): string {
  const lines: string[] = [];
  lines.push("R2S Evaluation v1");
  lines.push("");
  lines.push(
    `Cohort sizes: ${result.seedResults.map((s) => s.cohortSize).join(", ")} (per seed; sums to a modest local-run scale, not a fixed target)`,
  );
  lines.push(`Seeds: ${result.config.seeds.length} (${result.config.seeds.join(", ")})`);
  lines.push("");

  const LABEL_W = 20;
  const COL_W = 15;
  lines.push(pad("", LABEL_W) + col("Baseline", COL_W) + col("R2S", COL_W));

  const agg = result.aggregate;
  lines.push(
    pad("Recovery rate", LABEL_W) +
      col(formatPercent(agg.recoveryRate.baseline.mean), COL_W) +
      col(formatPercent(agg.recoveryRate.r2s.mean), COL_W),
  );
  lines.push(
    pad("Revenue recovered", LABEL_W) +
      col(formatMoney(agg.recoveredRevenue.baseline.mean), COL_W) +
      col(formatMoney(agg.recoveredRevenue.r2s.mean), COL_W),
  );
  lines.push(
    pad("Attempts", LABEL_W) +
      col(agg.executedRecoveryAttempts.baseline.mean.toFixed(1), COL_W) +
      col(agg.executedRecoveryAttempts.r2s.mean.toFixed(1), COL_W),
  );
  lines.push(
    pad("Revenue/attempt", LABEL_W) +
      col(formatMoney(agg.recoveryEfficiency.baseline.mean), COL_W) +
      col(formatMoney(agg.recoveryEfficiency.r2s.mean), COL_W),
  );

  const meanPolicyBlocks = mean(result.seedResults.map((s) => s.baselineMetrics.policyBlocks));
  const meanPolicyBlocksR2s = mean(result.seedResults.map((s) => s.r2sMetrics.policyBlocks));
  const meanEscBaseline = mean(result.seedResults.map((s) => s.baselineMetrics.escalations));
  const meanEscR2s = mean(result.seedResults.map((s) => s.r2sMetrics.escalations));
  lines.push(
    pad("Policy blocks", LABEL_W) + col(meanPolicyBlocks.toFixed(1), COL_W) + col(meanPolicyBlocksR2s.toFixed(1), COL_W),
  );
  lines.push(
    pad("Escalations", LABEL_W) + col(meanEscBaseline.toFixed(1), COL_W) + col(meanEscR2s.toFixed(1), COL_W),
  );

  lines.push("");
  const meanIncremental = mean(result.seedResults.map((s) => s.comparison.incrementalRecoveredRevenue));
  const incrementalSign = meanIncremental >= 0 ? "+" : "-";
  lines.push(`Incremental revenue (mean across seeds): ${incrementalSign}${formatMoney(Math.abs(meanIncremental))}`);
  lines.push(
    `Recovery rate delta (mean across seeds): ${formatDelta(agg.recoveryRate.r2s.mean - agg.recoveryRate.baseline.mean, null, true)}`,
  );

  if (agg.groundTruthLabelAgreementRate.r2s.sampleCount > 0) {
    lines.push("");
    lines.push(
      `R2S ground-truth LABEL agreement (evaluation-only, synthetic label — NOT empirically-optimal, NOT real-world accuracy): ${formatPercent(agg.groundTruthLabelAgreementRate.r2s.mean)} mean across seeds`,
    );
  }
  if (agg.bestAvailableActionAgreementRate.r2s.sampleCount > 0) {
    lines.push(
      `R2S best-available-action agreement (evaluation-only, vs. best action among the agent's OWN candidates for each payment): ${formatPercent(agg.bestAvailableActionAgreementRate.r2s.mean)} mean across seeds`,
    );
  }

  lines.push("");
  lines.push(`Per-seed cohort sizes: ${result.seedResults.map((s) => `${s.seed}=${s.cohortSize}`).join(", ")}`);
  lines.push(`Versions: evaluation=${result.evaluationVersion} generator=${result.generatorVersion} dataset=${result.datasetVersion} assessmentEngine=${result.assessmentEngineVersion}`);

  return lines.join("\n");
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}
