// =============================================================================
// Multi-seed aggregation (Sep 2)
// =============================================================================
// Pure statistics over an array of per-seed numeric values. Population
// standard deviation is used (not sample stddev) since a fixed set of N
// evaluation seeds is treated as the entire population being summarized,
// not a sample drawn from a larger one.
// =============================================================================

export interface AggregateStats {
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  standardDeviation: number;
  sampleCount: number;
}

export function computeAggregateStats(values: number[]): AggregateStats {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, median: 0, minimum: 0, maximum: 0, standardDeviation: 0, sampleCount: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;

  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const standardDeviation = Math.sqrt(variance);

  return {
    mean,
    median,
    minimum: sorted[0]!,
    maximum: sorted[n - 1]!,
    standardDeviation,
    sampleCount: n,
  };
}
