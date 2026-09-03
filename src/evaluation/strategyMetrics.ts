// =============================================================================
// Strategy evaluation metrics (Sep 2)
// =============================================================================
// Extends src/evaluation/metrics.ts (Sep 1) — does not replace or modify
// it. computeRecoveryMetrics()/RecoveryMetrics stay exactly as they were
// (they model a single-decision-cycle-per-payment run); this module adds a
// richer, multi-cycle-aware metrics computation for the Sep 2 baseline-vs-
// R2S comparison, where R2S may make several decision cycles per payment
// and has a policy layer/action vocabulary the Sep 1 model didn't need to
// represent.
//
// Both `summarizeBaselinePayments` and `summarizeR2sPayments` reduce their
// respective strategy's raw result (see strategies/baselineStrategy.ts and
// strategies/r2sStrategy.ts) into the SAME `StrategyPaymentOutcome` shape,
// so `computeStrategyMetrics` itself has no strategy-specific branching at
// all — it is one set of formulas applied identically to both sides,
// which is what makes the resulting numbers comparable.
//
// GROUND-TRUTH BOUNDARY: `summarizeR2sPayments` is the only function in
// this file that reads GroundTruth, and it does so strictly AFTER the R2S
// strategy has already finished making every decision for that payment —
// solely to compute the evaluation-only best-action-agreement metric. It
// is never read before or during decision-making, and is never passed to
// anything AI-facing.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import type { PaymentStatus } from "../domain/types.js";
import type { RecoveryAction } from "../ai/types.js";
import { CANDIDATE_ACTION_MAP } from "../ai/candidateTranslation.js";
import { ACTION_EFFECTIVENESS } from "../outcome/simulateOutcome.js";
import { safeDivide } from "./metrics.js";
import type { InitialWorld } from "./cohort.js";
import type { BaselineStrategyResult } from "./strategies/baselineStrategy.js";
import type { R2sStrategyResult } from "./strategies/r2sStrategy.js";
import type { GroundTruth } from "../domain/types.js";

// =============================================================================
// Decision-quality metric semantics (Sep 2 audit correction, Issues 3 & final)
// =============================================================================
// GroundTruth.bestAction (see simulation/groundTruth.ts) is a
// CATEGORY-LEVEL SYNTHETIC LABEL — a static lookup keyed only by
// failureCategory (e.g. insufficient_funds -> retry_delayed). It was never
// derived from, and is not guaranteed to align with, the action-conditioned
// outcome model's actual per-action success-probability multipliers
// (ACTION_EFFECTIVENESS, in outcome/simulateOutcome.ts). TWO
// clearly-distinguished, separately-named metrics are computed:
//
//   - groundTruthLabelAgreement(Rate): agreement with the synthetic
//     category-level GroundTruth.bestAction label. A dataset-authoring
//     convention, not a claim about empirical optimality.
//   - bestAvailableActionAgreement(Rate): agreement with the
//     highest-performing action AMONG THE ACTIONS THE AGENT WAS ACTUALLY
//     OFFERED for that specific payment (its translated candidate set —
//     see r2sStrategy.ts's firstCycleAvailableActions), not the globally
//     best action across the entire RecoveryAction vocabulary.
//
// FINAL CORRECTION (this revision): an earlier version of
// bestAvailableActionAgreement compared against the single globally-best
// RecoveryAction across ALL of ACTION_EFFECTIVENESS, regardless of
// whether that action was ever a candidate for the payment in question.
// Since OFFER_INCENTIVE and SEND_REMINDER are never reachable through
// src/assessment/candidateActions.ts -> ai/candidateTranslation.ts's
// existing translation (see that file's own header comment), that
// comparison was structurally guaranteed to read ~0% regardless of how
// well R2S was actually choosing among its real options — an unfair,
// misleading measurement. This revision restricts the comparison to only
// the RecoveryAction values that were genuinely offered to the agent for
// that specific payment (captured live, during the actual decision, by
// r2sStrategy.ts), using the existing translateCandidateActions() bridge
// and the existing, unmodified ACTION_EFFECTIVENESS table — nothing about
// the outcome model, candidate generation, or the AI was changed to
// produce this correction.
//
// Both metrics are evaluation-only, computed strictly after decisions are
// made, and are NOT real-world recovery-accuracy claims.
// =============================================================================

/**
 * Among ONLY the RecoveryActions actually available to the agent for this
 * specific payment (`availableActions` — the agent's real candidate set,
 * never the full RecoveryAction vocabulary), determines which one is
 * empirically best under the existing, unmodified action-conditioned
 * outcome model:
 *
 *   - If the payment is ground-truth recoverable and at least one
 *     available action is a genuine recovery tactic (RETRY_NOW,
 *     RETRY_LATER, SEND_PAYMENT_LINK, SEND_REMINDER, OFFER_INCENTIVE),
 *     the best available action is whichever of those AVAILABLE tactic
 *     actions has the highest ACTION_EFFECTIVENESS multiplier — a
 *     non-available tactic action (however high its multiplier) is never
 *     considered, per this correction's requirement.
 *   - Otherwise (payment is not ground-truth recoverable, so no tactic
 *     action can succeed regardless of its multiplier — see
 *     outcome/simulateOutcome.ts; or no tactic action was available at
 *     all), the best available action is STOP if it was offered (it
 *     almost always is — assessment/candidateActions.ts's own
 *     `no_action` fallback is present for essentially every payment),
 *     else ESCALATE if that was offered, else the first available action
 *     (deterministic, by the agent's own priority ordering) as a final
 *     defensive fallback.
 *
 * Never hard-codes a specific action name; never invents a candidate that
 * wasn't actually offered; never reads or alters ACTION_EFFECTIVENESS.
 */
export function computeBestAvailableAction(
  availableActions: RecoveryAction[],
  groundTruth: GroundTruth,
): RecoveryAction {
  if (availableActions.length === 0) {
    throw new Error("computeBestAvailableAction(): availableActions must not be empty");
  }

  // A "tactic" action is exactly one that has an ACTION_EFFECTIVENESS
  // entry — ESCALATE/STOP deliberately have none (see
  // outcome/simulateOutcome.ts: they never execute a recovery attempt at
  // all), so membership in that existing, unmodified table IS the
  // existing definition of "genuine recovery tactic". No new
  // classification is introduced here.
  const isTacticAction = (a: RecoveryAction): a is keyof typeof ACTION_EFFECTIVENESS =>
    Object.prototype.hasOwnProperty.call(ACTION_EFFECTIVENESS, a);
  const availableTactics = availableActions.filter(isTacticAction);

  if (groundTruth.recoverable && availableTactics.length > 0) {
    return availableTactics.reduce((best, action) =>
      ACTION_EFFECTIVENESS[action] > ACTION_EFFECTIVENESS[best] ? action : best,
    );
  }

  // Not recoverable, or no tactic action was ever offered for this
  // payment: no available action raises recovery probability above 0, so
  // prefer whichever non-executing action was actually offered.
  if (availableActions.includes("STOP")) return "STOP";
  if (availableActions.includes("ESCALATE")) return "ESCALATE";
  return availableActions[0]!;
}

/** Common per-payment outcome shape both strategies are reduced into.
 * `computeStrategyMetrics` operates only on this — it has no knowledge of
 * which strategy produced it. */
export interface StrategyPaymentOutcome {
  paymentId: string;
  amount: number;
  finalStatus: PaymentStatus;
  /** Count of RecoveryAttempt rows genuinely executed (outcome
   * "success"|"failure") for this payment — excludes "blocked" and
   * "pending", and excludes STOP/ESCALATE (which never create an attempt
   * row at all in either strategy). */
  executedAttempts: number;
  /** Count of policy BLOCK decisions across every decision cycle for this
   * payment. Always 0 for the baseline (it has no policy layer). */
  policyBlocks: number;
  /** Count of approved ESCALATE outcomes for this payment (AI-recommended
   * and policy-approved, or policy-driven). Always 0 for the baseline. */
  escalations: number;
  /** Action tally contributed by this payment — R2S: every cycle's
   * approved action (including BLOCK/ESCALATE/STOP, which never execute
   * but are still meaningful decisions to count); baseline: RETRY_NOW once
   * per executed attempt, plus one STOP if the case terminated by
   * exhausting retries or the recovery window, for comparability with
   * R2S's action vocabulary. This mapping is an evaluation-layer
   * comparability convention only — it changes nothing about how either
   * strategy actually behaves. */
  actionCounts: Partial<Record<RecoveryAction, number>>;
  /** Evaluation-only decision-quality metric: does the strategy's FIRST
   * decision-cycle action match the SYNTHETIC, CATEGORY-LEVEL
   * GroundTruth.bestAction label (translated into RecoveryAction
   * vocabulary via CANDIDATE_ACTION_MAP)? This is a dataset-authoring
   * convention, NOT a claim that the label is empirically optimal under
   * the outcome model — see bestAvailableActionAgreement for that.
   * `null` when not applicable — currently: always null for the baseline
   * (it has no "AI selected action" concept). Computed strictly AFTER the
   * strategy already made its decision. */
  groundTruthLabelAgreement: boolean | null;
  /** Evaluation-only decision-quality metric: does the strategy's FIRST
   * decision-cycle action match the highest-performing action AMONG ONLY
   * the actions the agent was actually offered as candidates for this
   * specific payment (see computeBestAvailableAction) — never compared
   * against the full RecoveryAction vocabulary, and never against an
   * action that wasn't a genuine candidate for this payment. `null` when
   * not applicable (baseline, or a payment that produced zero decision
   * cycles). Computed strictly after the decision is made; never used to
   * tune the outcome model, candidate generation, or the AI. */
  bestAvailableActionAgreement: boolean | null;
}

export interface StrategyEvaluationMetrics {
  eligibleFailedPayments: number;
  recoveredPayments: number;
  /** recoveredPayments / eligibleFailedPayments. 0 if eligibleFailedPayments is 0. */
  recoveryRate: number;
  /** Sum of `amount` over recovered payments, minor units. */
  recoveredRevenue: number;
  /** Sum of executedAttempts across all payments. Excludes BLOCK/STOP/
   * ESCALATE/skipped, per Sep 2 spec item 11. */
  executedRecoveryAttempts: number;
  /** recoveredRevenue / executedRecoveryAttempts. 0 if 0 attempts. */
  recoveryEfficiency: number;
  policyBlocks: number;
  escalations: number;
  actionDistribution: Record<string, number>;
  /** executedRecoveryAttempts / recoveredPayments. 0 if 0 recovered. */
  averageAttemptsPerRecoveredPayment: number;
  /** Fraction of payments with a non-null groundTruthLabelAgreement that
   * agreed. `null` when no payment had an applicable (non-null) value —
   * e.g. the baseline, which never produces one. THIS IS A SYNTHETIC,
   * EVALUATION-ONLY METRIC measuring agreement with this dataset's own
   * category-level ground-truth LABEL — NOT a claim that the label is
   * empirically optimal under the outcome model, and NOT a real-world
   * recovery-accuracy claim. See bestAvailableActionAgreementRate for the
   * candidate-restricted, outcome-model-grounded alternative. */
  groundTruthLabelAgreementRate: number | null;
  /** Fraction of payments with a non-null bestAvailableActionAgreement
   * that agreed — agreement with the highest-performing action AMONG ONLY
   * the actions genuinely offered to the agent for each specific payment
   * (never the full RecoveryAction vocabulary — see
   * computeBestAvailableAction). `null` when not applicable (baseline).
   * "Percentage of decisions where the agent selected the
   * highest-performing action among the actions it was actually allowed
   * to choose for that payment." Also a synthetic, evaluation-only
   * metric, not a real-world claim. */
  bestAvailableActionAgreementRate: number | null;
}

function isGenuinelyExecutedOutcome(outcome: string): boolean {
  return outcome === "success" || outcome === "failure";
}

/**
 * Reduces a baseline strategy run into the common StrategyPaymentOutcome
 * shape. Reads final attempt counts from `repo` (populated by the
 * baseline's own runBaselineRecoveryLoop, unmodified) rather than
 * recomputing them — this function performs no baseline decision logic.
 */
export function summarizeBaselinePayments(
  world: InitialWorld,
  result: BaselineStrategyResult,
  repo: R2SRepository,
): StrategyPaymentOutcome[] {
  const amountByPaymentId = new Map(world.cohort.map((e) => [e.paymentId, e.amount]));

  return result.perPayment.map(({ paymentId, outcome }) => {
    const recoveryCaseId = `case_${paymentId}`;
    const attempts = repo.listRecoveryAttemptsByCase(recoveryCaseId);
    const executedAttempts = attempts.filter((a) => isGenuinelyExecutedOutcome(a.outcome)).length;

    // LoopOutcome values ("recovered"|"failed_final"|"stopped") are
    // exactly the PaymentStatus values runBaselineRecoveryLoop sets as
    // the payment's final status — see runSimulation.ts.
    const finalStatus = outcome as PaymentStatus;

    const actionCounts: Partial<Record<RecoveryAction, number>> = {};
    if (executedAttempts > 0) actionCounts.RETRY_NOW = executedAttempts;
    if (finalStatus === "failed_final" || finalStatus === "stopped") {
      actionCounts.STOP = (actionCounts.STOP ?? 0) + 1;
    }

    return {
      paymentId,
      amount: amountByPaymentId.get(paymentId) ?? 0,
      finalStatus,
      executedAttempts,
      policyBlocks: 0,
      escalations: 0,
      actionCounts,
      groundTruthLabelAgreement: null,
      bestAvailableActionAgreement: null,
    };
  });
}

/**
 * Reduces an R2S strategy run into the common StrategyPaymentOutcome
 * shape. Reads final attempt counts from `repo` (populated by
 * runRecoveryOrchestration, unmodified). Ground truth is read here ONLY
 * to compute the evaluation-only decision-quality metrics, strictly after
 * every decision cycle for the payment has already completed.
 */
export function summarizeR2sPayments(
  world: InitialWorld,
  result: R2sStrategyResult,
  repo: R2SRepository,
): StrategyPaymentOutcome[] {
  const amountByPaymentId = new Map(world.cohort.map((e) => [e.paymentId, e.amount]));
  const groundTruthByPaymentId = new Map(world.groundTruths.map((gt) => [gt.paymentId, gt]));

  return result.perPayment.map(
    ({ paymentId, cycles, finalPaymentStatus, firstCycleAiAction, firstCycleAvailableActions }) => {
      const recoveryCaseId = `case_${paymentId}`;
      const attempts = repo.listRecoveryAttemptsByCase(recoveryCaseId);
      const executedAttempts = attempts.filter((a) => isGenuinelyExecutedOutcome(a.outcome)).length;

      const actionCounts: Partial<Record<RecoveryAction, number>> = {};
      let policyBlocks = 0;
      let escalations = 0;
      for (const cycle of cycles) {
        if (cycle.policyDecision === "BLOCK") policyBlocks++;
        if (cycle.approvedAction !== null) {
          actionCounts[cycle.approvedAction] = (actionCounts[cycle.approvedAction] ?? 0) + 1;
          if (cycle.approvedAction === "ESCALATE") escalations++;
        }
      }

      // Evaluation-only, computed strictly after all decisions are made.
      const groundTruth = groundTruthByPaymentId.get(paymentId);
      let groundTruthLabelAgreement: boolean | null = null;
      let bestAvailableActionAgreement: boolean | null = null;
      if (groundTruth && firstCycleAiAction) {
        const expectedLabelAction = CANDIDATE_ACTION_MAP[groundTruth.bestAction];
        groundTruthLabelAgreement = firstCycleAiAction === expectedLabelAction;

        if (firstCycleAvailableActions.length > 0) {
          const bestAvailable = computeBestAvailableAction(firstCycleAvailableActions, groundTruth);
          bestAvailableActionAgreement = firstCycleAiAction === bestAvailable;
        }
      }

      return {
        paymentId,
        amount: amountByPaymentId.get(paymentId) ?? 0,
        finalStatus: finalPaymentStatus,
        executedAttempts,
        policyBlocks,
        escalations,
        actionCounts,
        groundTruthLabelAgreement,
        bestAvailableActionAgreement,
      };
    },
  );
}

export function computeStrategyMetrics(outcomes: StrategyPaymentOutcome[]): StrategyEvaluationMetrics {
  const eligibleFailedPayments = outcomes.length;
  const recovered = outcomes.filter((o) => o.finalStatus === "recovered");
  const recoveredPayments = recovered.length;
  const recoveredRevenue = recovered.reduce((sum, o) => sum + o.amount, 0);

  const executedRecoveryAttempts = outcomes.reduce((sum, o) => sum + o.executedAttempts, 0);
  const policyBlocks = outcomes.reduce((sum, o) => sum + o.policyBlocks, 0);
  const escalations = outcomes.reduce((sum, o) => sum + o.escalations, 0);

  const actionDistribution: Record<string, number> = {};
  for (const o of outcomes) {
    for (const [action, count] of Object.entries(o.actionCounts)) {
      actionDistribution[action] = (actionDistribution[action] ?? 0) + (count ?? 0);
    }
  }

  const applicableLabelAgreements = outcomes
    .map((o) => o.groundTruthLabelAgreement)
    .filter((v): v is boolean => v !== null);
  const groundTruthLabelAgreementRate =
    applicableLabelAgreements.length === 0
      ? null
      : safeDivide(applicableLabelAgreements.filter(Boolean).length, applicableLabelAgreements.length);

  const applicableBestAvailableAgreements = outcomes
    .map((o) => o.bestAvailableActionAgreement)
    .filter((v): v is boolean => v !== null);
  const bestAvailableActionAgreementRate =
    applicableBestAvailableAgreements.length === 0
      ? null
      : safeDivide(
          applicableBestAvailableAgreements.filter(Boolean).length,
          applicableBestAvailableAgreements.length,
        );

  return {
    eligibleFailedPayments,
    recoveredPayments,
    recoveryRate: safeDivide(recoveredPayments, eligibleFailedPayments),
    recoveredRevenue,
    executedRecoveryAttempts,
    recoveryEfficiency: safeDivide(recoveredRevenue, executedRecoveryAttempts),
    policyBlocks,
    escalations,
    actionDistribution,
    averageAttemptsPerRecoveredPayment: safeDivide(executedRecoveryAttempts, recoveredPayments),
    groundTruthLabelAgreementRate,
    bestAvailableActionAgreementRate,
  };
}
