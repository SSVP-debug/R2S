// =============================================================================
// Baseline strategy adapter (Sep 2)
// =============================================================================
// THIN ADAPTER ONLY — this file contains no baseline decision logic of its
// own. It reuses the exact, unmodified Aug 29 decision loop
// (runBaselineRecoveryLoop, exported additively from
// src/simulation/runSimulation.ts for this purpose) against an independent
// repository already populated with the frozen evaluation cohort (see
// cohort.ts's materializeWorldInto()).
//
// The baseline never sees an AI, a policy engine, or an executor — it is
// the deterministic-retry control condition exactly as it existed on Aug 29
// (see src/strategy/baselineRetry.ts). Nothing about its timing, retry
// limit, or recovery-window behavior is altered here.
// =============================================================================

import type { R2SRepository } from "../../db/repository.js";
import { createRng } from "../../simulation/rng.js";
import { IdSequence } from "../../simulation/ids.js";
import { runBaselineRecoveryLoop, type LoopOutcome } from "../../simulation/runSimulation.js";
import type { InitialWorld } from "../cohort.js";
import type { GroundTruth } from "../../domain/types.js";

export interface BaselineStrategyParams {
  world: InitialWorld;
  repo: R2SRepository;
  /** Retained for the run's own record-keeping / result labeling (Sep 2
   * correction, item 4). NOT used to derive outcome-simulation randomness
   * as of the Sep 3 methodology fix — see the payment-local RNG note in
   * runBaselineStrategy() below, which instead uses `world.seed` (shared
   * with R2S) so the two strategies draw from matched per-payment
   * streams. */
  rngSeed: string;
}

export interface BaselineStrategyPaymentResult {
  paymentId: string;
  outcome: LoopOutcome;
}

export interface BaselineStrategyResult {
  rngSeed: string;
  perPayment: BaselineStrategyPaymentResult[];
}

/**
 * Runs the baseline deterministic-retry strategy against every cohort
 * entry in `world`, against `repo` (expected to already have the world
 * materialized into it via materializeWorldInto — this function does not
 * call that itself, so callers control exactly when/how the independent
 * repository is set up).
 */
export function runBaselineStrategy(params: BaselineStrategyParams): BaselineStrategyResult {
  const { world, repo, rngSeed } = params;
  const ids = new IdSequence();

  const groundTruthByPaymentId = new Map<string, GroundTruth>(
    world.groundTruths.map((gt) => [gt.paymentId, gt]),
  );

  const perPayment: BaselineStrategyPaymentResult[] = [];

  for (const entry of world.cohort) {
    const payment = repo.getPayment(entry.paymentId);
    if (!payment) {
      throw new Error(
        `runBaselineStrategy(): payment ${entry.paymentId} not found in repo — was the world materialized into it first?`,
      );
    }
    const groundTruth = groundTruthByPaymentId.get(entry.paymentId);
    if (!groundTruth) {
      throw new Error(
        `runBaselineStrategy(): no GroundTruth for cohort payment ${entry.paymentId}`,
      );
    }

    const recoveryCaseId = `case_${entry.paymentId}`;

    // Payment-local, STRATEGY-SHARED RNG (Sep 3 methodology fix): keyed by
    // world.seed (the base evaluation seed, identical for baseline and
    // R2S — NOT the strategy-suffixed `rngSeed` above) + this payment's
    // id. R2S derives the exact same key for the exact same payment (see
    // r2sStrategy.ts), so both strategies' first executed attempt for a
    // given payment draws the identical underlying random float — a
    // matched/paired design (common random numbers), not independent
    // sampling. Isolated per payment: a fresh Rng object per iteration
    // means one payment's draw count can never shift another payment's
    // stream, in either strategy.
    const paymentRng = createRng(`${world.seed}:${entry.paymentId}`);
    const outcome = runBaselineRecoveryLoop({
      repo,
      ids,
      rng: paymentRng,
      payment,
      groundTruth,
      recoveryCaseId,
      openedAt: entry.caseOpenedAt,
      simulationRunId: world.simulationRunId,
    });

    perPayment.push({ paymentId: entry.paymentId, outcome });
  }

  return { rngSeed, perPayment };
}