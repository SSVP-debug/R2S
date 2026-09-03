// =============================================================================
// Experiment runner (Sep 2)
// =============================================================================
// Orchestrates existing components — it duplicates no business logic of
// its own. Per seed:
//
//   buildInitialWorld (cohort.ts, unmodified generator/ground-truth calls)
//     -> materializeWorldInto TWO independent SqliteRepository(":memory:")
//        instances (one for baseline, one for R2S — genuinely separate
//        objects; mutating one cannot affect the other)
//     -> runBaselineStrategy (thin adapter around the unmodified Aug 29 loop)
//     -> runR2sStrategy (multi-cycle driver around the unmodified Sep 1
//        orchestrator)
//     -> summarize + computeStrategyMetrics (strategyMetrics.ts)
//     -> compareStrategies (comparison.ts)
//
// Across seeds: computeAggregateStats (aggregate.ts) over the per-seed
// metrics. No seed is silently skipped — a failure on any seed throws
// rather than dropping it from the aggregate.
// =============================================================================

import { SqliteRepository } from "../db/repository.js";
import { MockAIProvider } from "../ai/mockProvider.js";
import { DEFAULT_MERCHANT_POLICY } from "../policy/types.js";
import type { MerchantPolicy } from "../ai/types.js";
import type { GeneratorOptions } from "../simulation/generator.js";
import { DEFAULT_GENERATOR_OPTIONS } from "../simulation/generator.js";
import {
  EVALUATION_VERSION,
  GENERATOR_VERSION,
  DATASET_VERSION,
  ASSESSMENT_ENGINE_VERSION,
} from "../meta/versioning.js";
import { buildInitialWorld, materializeWorldInto } from "./cohort.js";
import { runBaselineStrategy } from "./strategies/baselineStrategy.js";
import { runR2sStrategy } from "./strategies/r2sStrategy.js";
import {
  summarizeBaselinePayments,
  summarizeR2sPayments,
  computeStrategyMetrics,
  type StrategyEvaluationMetrics,
} from "./strategyMetrics.js";
import { compareStrategies, type SeedComparison } from "./comparison.js";
import { computeAggregateStats, type AggregateStats } from "./aggregate.js";

/**
 * Sep 2 audit correction, Issue 2: the DEFAULT generator options (5
 * merchants) yield only ~60-75 eligible failed payments per seed, well
 * short of the spec's ~1,000-per-seed target. Per the audit's explicit
 * instruction, the fix is to scale the EXISTING, already-exposed
 * GeneratorOptions.merchantCount (the same unmodified generator, run at a
 * larger size) rather than touch generator semantics or hardcode a target
 * count. merchantCount=70 is an empirically-chosen scale factor (~14x the
 * default's 5) that lands each seed's naturally-emerging failed-payment
 * count in the neighborhood of 1,000 — the exact figure still varies
 * seed-to-seed and is never padded or truncated to hit a round number.
 * Every other GeneratorOptions field is left at its existing default.
 */
export const EVALUATION_SCALE_GENERATOR_OPTIONS: GeneratorOptions = {
  ...DEFAULT_GENERATOR_OPTIONS,
  merchantCount: 70,
};

export interface EvaluationConfig {
  seeds: string[];
  /** Existing, already-exposed GeneratorOptions. Scaling merchantCount
   * here uses the same unmodified generator semantics at a different
   * size — see cohort.ts's header comment. Defaults to
   * EVALUATION_SCALE_GENERATOR_OPTIONS (~1,000 eligible failed payments
   * per seed — see that constant's doc comment), not the generator's own
   * small default, since that is the scale the Sep 2 spec calls for. */
  generatorOptions?: GeneratorOptions;
  /** Optional deterministic prefix cap on the eligible failed population,
   * applied AFTER generation (Sep 2 correction, item 2). Never used to
   * pad up to a target. */
  maxCohortSize?: number;
  /** Defaults to DEFAULT_MERCHANT_POLICY (policy/types.ts), which has the
   * SAME maxRetries (3) and recoveryWindowDays (7) as
   * BASELINE_RETRY_POLICY — required for a fair "same recovery window"
   * comparison per Sep 2 spec item 3. Overriding this to a policy with a
   * different window/retry-limit is possible but breaks that fairness
   * guarantee, so it is not exposed via the CLI. */
  merchantPolicy?: MerchantPolicy;
}

export interface SeedResult {
  seed: string;
  cohortSize: number;
  /** Present only when maxCohortSize truncated the eligible failed
   * population for this seed — recorded, never hidden. */
  droppedByMaxCohortSize: number;
  baselineRngSeed: string;
  r2sRngSeed: string;
  baselineMetrics: StrategyEvaluationMetrics;
  r2sMetrics: StrategyEvaluationMetrics;
  comparison: SeedComparison;
}

export interface AggregateMetricPair {
  baseline: AggregateStats;
  r2s: AggregateStats;
}

export interface AggregateMetrics {
  recoveryRate: AggregateMetricPair;
  recoveredRevenue: AggregateMetricPair;
  executedRecoveryAttempts: AggregateMetricPair;
  recoveryEfficiency: AggregateMetricPair;
  /** R2S-only: the baseline never produces an applicable value (see
   * strategyMetrics.ts), so there is nothing to aggregate on its side.
   * Seeds where R2S itself produced no applicable comparisons are
   * excluded from this aggregate rather than treated as 0. */
  groundTruthLabelAgreementRate: { r2s: AggregateStats };
  bestAvailableActionAgreementRate: { r2s: AggregateStats };
}

export interface EvaluationResult {
  evaluationVersion: string;
  generatorVersion: string;
  datasetVersion: string;
  assessmentEngineVersion: string;
  config: {
    seeds: string[];
    generatorOptions: GeneratorOptions;
    maxCohortSize?: number;
  };
  seedResults: SeedResult[];
  aggregate: AggregateMetrics;
  methodology: {
    fairness: string;
    temporalFairness: string;
    rngStrategy: string;
    groundTruthBoundary: string;
    decisionQualityCaveat: string;
  };
}

const METHODOLOGY = {
  fairness:
    "Each seed builds ONE initial synthetic world (merchants, customers, payments, ground truth, opened recovery cases) via buildInitialWorld(), then materializes byte-identical copies into two fully independent SqliteRepository(':memory:') instances — one per strategy. Only the decision strategy differs; mutating one repository cannot affect the other.",
  temporalFairness:
    "R2S calls the Sep 1 orchestrator repeatedly per payment, but EVERY cycle — including RETRY_LATER — consumes exactly one decision opportunity from a shared budget of BASELINE_RETRY_POLICY.maxRetries (3), guaranteeing R2S never receives more decision opportunities than the baseline for any payment. RETRY_LATER changes WHEN the next opportunity occurs (its own approved delayHours) but not HOW MANY opportunities exist. Immediate-executing actions and BLOCK use the gaps between BASELINE_RETRY_POLICY.retryIntervalHours' cumulative offsets ([1,24,72]h -> [1,23,48]h gaps), applied additively so time never repeats or goes backward. If the opportunity budget is exhausted without the payment reaching a terminal/escalated state on its own, it is explicitly transitioned to 'stopped' via the existing lifecycle composer, mirroring the baseline's own stop_max_retries_reached termination.",
  rngStrategy:
    "Baseline and R2S use independently seeded RNG streams (seed+':baseline', seed+':r2s') for outcome simulation, since the two strategies consume different numbers of random draws over different attempt histories. Both call the exact same simulateAttemptOutcome() model/parameters — only the random draws differ, which is unavoidable and correct for a fair comparison of different decision sequences.",
  groundTruthBoundary:
    "GroundTruth is read in exactly two places: (1) internally, by the unmodified simulateAttemptOutcome() during outcome simulation (as it already was pre-Sep-2), and (2) in the evaluation layer (strategyMetrics.ts's summarizeR2sPayments), strictly AFTER a payment's R2S decisions are all complete, solely to compute the evaluation-only decision-quality metrics. It is never placed in AgentPaymentContext, RecoveryAssessment, AgentDecisionRequest, or any AI-facing input.",
  decisionQualityCaveat:
    "TWO evaluation-only decision-quality metrics are reported, deliberately kept distinct: groundTruthLabelAgreementRate measures agreement with GroundTruth.bestAction, a SYNTHETIC, CATEGORY-LEVEL LABEL (e.g. insufficient_funds -> retry_delayed) that is NOT derived from and is not guaranteed to align with the outcome model's actual per-action probabilities. bestAvailableActionAgreementRate measures agreement with the highest-performing action AMONG ONLY the actions the agent was actually offered as candidates for that specific payment (its translated candidate set, captured live during the real decision) — never compared against the full RecoveryAction vocabulary or an action that wasn't a genuine option for that payment. Neither is a real-world recovery-accuracy claim.",
};

async function runSingleSeed(seed: string, config: EvaluationConfig): Promise<SeedResult> {
  const generatorOptions = config.generatorOptions ?? EVALUATION_SCALE_GENERATOR_OPTIONS;
  const merchantPolicy = config.merchantPolicy ?? DEFAULT_MERCHANT_POLICY;

  const world = buildInitialWorld({
    seed,
    options: generatorOptions,
    maxCohortSize: config.maxCohortSize,
  });

  const baselineRepo = new SqliteRepository(":memory:");
  const r2sRepo = new SqliteRepository(":memory:");
  materializeWorldInto(world, baselineRepo);
  materializeWorldInto(world, r2sRepo);

  const baselineRngSeed = `${seed}:baseline`;
  const r2sRngSeed = `${seed}:r2s`;

  const baselineResult = runBaselineStrategy({
    world,
    repo: baselineRepo,
    rngSeed: baselineRngSeed,
  });

  const r2sResult = await runR2sStrategy({
    world,
    repo: r2sRepo,
    provider: new MockAIProvider(),
    merchantPolicy,
    rngSeed: r2sRngSeed,
  });

  const baselineOutcomes = summarizeBaselinePayments(world, baselineResult, baselineRepo);
  const r2sOutcomes = summarizeR2sPayments(world, r2sResult, r2sRepo);

  const baselineMetrics = computeStrategyMetrics(baselineOutcomes);
  const r2sMetrics = computeStrategyMetrics(r2sOutcomes);

  return {
    seed,
    cohortSize: world.cohort.length,
    droppedByMaxCohortSize: world.droppedByMaxCohortSize,
    baselineRngSeed,
    r2sRngSeed,
    baselineMetrics,
    r2sMetrics,
    comparison: compareStrategies(baselineMetrics, r2sMetrics),
  };
}

function aggregatePair(
  seedResults: SeedResult[],
  pick: (m: StrategyEvaluationMetrics) => number,
): AggregateMetricPair {
  return {
    baseline: computeAggregateStats(seedResults.map((s) => pick(s.baselineMetrics))),
    r2s: computeAggregateStats(seedResults.map((s) => pick(s.r2sMetrics))),
  };
}

/**
 * Runs the full baseline-vs-R2S evaluation across every configured seed.
 * No seed is skipped: if any seed's strategies throw, this function
 * throws (a partial/silently-dropped-seed aggregate would misrepresent
 * the result).
 */
export async function runEvaluation(config: EvaluationConfig): Promise<EvaluationResult> {
  if (config.seeds.length === 0) {
    throw new Error("runEvaluation(): at least one seed is required");
  }

  const seedResults: SeedResult[] = [];
  for (const seed of config.seeds) {
    // Sequential (not Promise.all) so a failure on seed N is unambiguous
    // and no seed's execution can interleave with another's RNG/console
    // side effects.
    seedResults.push(await runSingleSeed(seed, config));
  }

  const groundTruthLabelAgreementValues = seedResults
    .map((s) => s.r2sMetrics.groundTruthLabelAgreementRate)
    .filter((v): v is number => v !== null);
  const bestAvailableAgreementValues = seedResults
    .map((s) => s.r2sMetrics.bestAvailableActionAgreementRate)
    .filter((v): v is number => v !== null);

  const aggregate: AggregateMetrics = {
    recoveryRate: aggregatePair(seedResults, (m) => m.recoveryRate),
    recoveredRevenue: aggregatePair(seedResults, (m) => m.recoveredRevenue),
    executedRecoveryAttempts: aggregatePair(seedResults, (m) => m.executedRecoveryAttempts),
    recoveryEfficiency: aggregatePair(seedResults, (m) => m.recoveryEfficiency),
    groundTruthLabelAgreementRate: { r2s: computeAggregateStats(groundTruthLabelAgreementValues) },
    bestAvailableActionAgreementRate: { r2s: computeAggregateStats(bestAvailableAgreementValues) },
  };

  return {
    evaluationVersion: EVALUATION_VERSION,
    generatorVersion: GENERATOR_VERSION,
    datasetVersion: DATASET_VERSION,
    assessmentEngineVersion: ASSESSMENT_ENGINE_VERSION,
    config: {
      seeds: config.seeds,
      generatorOptions: config.generatorOptions ?? EVALUATION_SCALE_GENERATOR_OPTIONS,
      maxCohortSize: config.maxCohortSize,
    },
    seedResults,
    aggregate,
    methodology: METHODOLOGY,
  };
}

export const DEFAULT_EVALUATION_SEEDS = [
  "evaluation-001",
  "evaluation-002",
  "evaluation-003",
  "evaluation-004",
  "evaluation-005",
];
