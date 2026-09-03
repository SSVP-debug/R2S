// =============================================================================
// Evaluation cohort construction (Sep 2)
// =============================================================================
// Builds the initial synthetic world for one evaluation seed EXACTLY ONCE,
// using only already-exported, unmodified functions from the Aug 29
// generator/ground-truth modules — this file adds no new generation logic,
// no new probability model, and no new failure-rate behavior. It then
// freezes an explicit "cohort" of the payments that were initially eligible
// failed payments, BEFORE either strategy (baseline or R2S) is allowed to
// run against it.
//
// FAIRNESS: `materializeWorldInto()` is called once per strategy, against
// two SEPARATE, fully independent `R2SRepository` instances (typically two
// `:memory:` SqliteRepository instances — see experimentRunner.ts). Nothing
// here shares object references between the two materializations beyond
// plain immutable data (ids/strings/numbers/Dates), so mutating one
// strategy's repository cannot affect the other's.
//
// COHORT SIZING (per Sep 2 corrections): failure counts emerge
// probabilistically from GeneratorOptions — this module never adjusts
// failure rates or generator logic to hit a target count. Two orthogonal,
// non-generator-touching knobs are offered instead:
//   1. `options` — the EXISTING, already-exposed GeneratorOptions (e.g.
//      merchantCount) may be scaled up by a caller to produce a larger
//      population using the SAME unmodified generator semantics.
//   2. `maxCohortSize` — an optional deterministic PREFIX subset taken
//      AFTER generation (first N eligible failed payments in generation
//      order), for callers who want a smaller/faster cohort without
//      touching generator options at all. Never based on final outcome.
// Whatever the resulting cohort size is (947, 1000, 1083, ...), it is
// recorded as-is — never padded or truncated to a round number.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import { createRng } from "../simulation/rng.js";
import { IdSequence } from "../simulation/ids.js";
import {
  generateDataset,
  DEFAULT_GENERATOR_OPTIONS,
  type GeneratorOptions,
} from "../simulation/generator.js";
import { computeGroundTruth } from "../simulation/groundTruth.js";
import { BASELINE_RETRY_POLICY, recoveryWindowEndsAt } from "../strategy/baselineRetry.js";
import { buildSimulationRun } from "../meta/versioning.js";
import type {
  Customer,
  FailureCategory,
  GroundTruth,
  Merchant,
  Payment,
  RecoveryCase,
  SimulationRun,
} from "../domain/types.js";

/** One frozen, eligible failed payment. Recorded BEFORE either strategy
 * mutates anything — eligibility is never determined from final payment
 * status (Sep 2 correction, item 9). */
export interface CohortEntry {
  paymentId: string;
  amount: number;
  failureCategory: FailureCategory;
  merchantId: string;
  customerId: string;
  /** Always "failed" — the initial state every cohort payment starts in. */
  initialStatus: "failed";
  /** Always "open" — the initial RecoveryCase state every cohort entry
   * starts in. */
  initialRecoveryCaseStatus: "open";
  caseOpenedAt: Date;
  recoveryWindowEndsAt: Date;
  /** Internal-only: the paymentId's GroundTruth id, for evaluation-layer
   * (post-decision) decision-quality lookups. The ground-truth VALUE
   * itself is never read from this cohort record by any strategy —
   * strategies only ever read GroundTruth through the repository's
   * existing internal-only accessor, exactly as the unmodified pipeline
   * already does for outcome simulation. */
  groundTruthId: string;
}

export interface InitialWorld {
  seed: string;
  simulationRunId: string;
  simulationRun: SimulationRun;
  merchants: Merchant[];
  customers: Customer[];
  /** ALL generated payments, including non-failed ("created") ones — the
   * full synthetic payment population, per the Sep 2 fairness rule
   * ("same payments", not just the cohort subset). */
  payments: Payment[];
  /** Ground truth for every failed payment (cohort or not — see
   * `droppedByMaxCohortSize` below; a payment excluded from the frozen
   * cohort by `maxCohortSize` still gets no GroundTruth row materialized,
   * since it's simply never inserted into either strategy's repository). */
  groundTruths: GroundTruth[];
  /** The frozen, eligible failed-payment cohort. This — not `payments` —
   * is what both strategies actually execute against. */
  cohort: CohortEntry[];
  /** The exact GeneratorOptions used to build this world. */
  generatorOptions: GeneratorOptions;
  /** Present only when `maxCohortSize` truncated the eligible failed
   * population; records how many were dropped, for transparency in the
   * result artifact (never hidden). */
  droppedByMaxCohortSize: number;
}

export interface BuildInitialWorldParams {
  seed: string;
  /** Existing, already-exposed GeneratorOptions — scaling merchantCount
   * etc. here uses the SAME unmodified generator logic at a different
   * size; it does not alter failure-rate behavior. Defaults to the
   * generator's own existing defaults. */
  options?: GeneratorOptions;
  /** Optional deterministic prefix cap applied to the eligible failed
   * population AFTER generation (Sep 2 correction, item 2). Never used to
   * pad up to a target — only to truncate down for a faster dev/CLI run.
   * Undefined/omitted = use the full generated failed population. */
  maxCohortSize?: number;
  runCreatedAt?: Date;
}

/**
 * Builds the initial synthetic world for one evaluation seed. Deterministic
 * given the same seed + options + maxCohortSize (same guarantee the
 * underlying generator/ground-truth functions already provide).
 */
export function buildInitialWorld(params: BuildInitialWorldParams): InitialWorld {
  const {
    seed,
    options = DEFAULT_GENERATOR_OPTIONS,
    maxCohortSize,
    runCreatedAt = new Date("2026-09-02T00:00:00.000Z"),
  } = params;

  const simulationRunId = `eval_${seed.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const rng = createRng(seed);
  const ids = new IdSequence();

  const simulationRun = buildSimulationRun(simulationRunId, seed, runCreatedAt);

  // ---- Generation (Aug 29's generator.ts, entirely unmodified) ----
  const dataset = generateDataset(rng, simulationRunId, options);
  const customersById = new Map<string, Customer>(dataset.customers.map((c) => [c.id, c]));

  // ---- Ground truth + cohort freezing, in payment generation order ----
  // (Mirrors the order runSimulation.ts already walks payments in — not a
  // new ordering invented for this module.)
  const groundTruths: GroundTruth[] = [];
  const cohort: CohortEntry[] = [];

  for (const payment of dataset.payments) {
    if (payment.status !== "failed") continue;

    if (maxCohortSize !== undefined && cohort.length >= maxCohortSize) {
      // Deterministic prefix cap: stop adding to the cohort, but keep
      // scanning is unnecessary — every subsequent failed payment is
      // simply excluded from both GroundTruth materialization and the
      // cohort. This never touches generation/failure-rate behavior; it
      // only decides which already-generated failed payments get used.
      continue;
    }

    const customer = customersById.get(payment.customerId);
    if (!customer) {
      throw new Error(
        `buildInitialWorld(): customer ${payment.customerId} not found for payment ${payment.id}`,
      );
    }

    const groundTruth = computeGroundTruth(rng, ids.next("gt"), payment, customer);
    groundTruths.push(groundTruth);

    const caseOpenedAt = payment.updatedAt;
    cohort.push({
      paymentId: payment.id,
      amount: payment.amount,
      failureCategory: payment.failureCategory as FailureCategory,
      merchantId: payment.merchantId,
      customerId: payment.customerId,
      initialStatus: "failed",
      initialRecoveryCaseStatus: "open",
      caseOpenedAt,
      recoveryWindowEndsAt: recoveryWindowEndsAt(caseOpenedAt, BASELINE_RETRY_POLICY),
      groundTruthId: groundTruth.id,
    });
  }

  const totalFailedInDataset = dataset.payments.filter((p) => p.status === "failed").length;
  const droppedByMaxCohortSize = totalFailedInDataset - cohort.length;

  return {
    seed,
    simulationRunId,
    simulationRun,
    merchants: dataset.merchants,
    customers: dataset.customers,
    payments: dataset.payments,
    groundTruths,
    cohort,
    generatorOptions: options,
    droppedByMaxCohortSize,
  };
}

/**
 * Materializes an InitialWorld into a repository: SimulationRun, the
 * baseline RecoveryPolicy row (informational, mirroring runSimulation.ts —
 * nothing reads it back), all merchants/customers/payments, GroundTruth for
 * every cohort entry, and an opened RecoveryCase per cohort entry. Call
 * this ONCE per strategy against a fresh, independent repository (see
 * experimentRunner.ts) — never against a repository the other strategy has
 * already touched.
 */
export function materializeWorldInto(world: InitialWorld, repo: R2SRepository): void {
  repo.insertSimulationRun(world.simulationRun);
  repo.insertRecoveryPolicy(BASELINE_RETRY_POLICY);
  repo.insertMerchants(world.merchants);
  repo.insertCustomers(world.customers);
  repo.insertPayments(world.payments);
  repo.insertGroundTruths(world.groundTruths);

  for (const entry of world.cohort) {
    const recoveryCase: RecoveryCase = {
      id: `case_${entry.paymentId}`,
      status: entry.initialRecoveryCaseStatus,
      openedAt: entry.caseOpenedAt,
      closedAt: null,
      recoveryWindowEndsAt: entry.recoveryWindowEndsAt,
      paymentId: entry.paymentId,
      simulationRunId: world.simulationRunId,
    };
    repo.insertRecoveryCase(recoveryCase);
  }
}
