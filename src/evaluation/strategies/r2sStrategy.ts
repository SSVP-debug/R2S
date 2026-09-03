// =============================================================================
// R2S strategy driver (Sep 2, corrected)
// =============================================================================
// THIN ORCHESTRATION-LOOP ADAPTER ONLY — this file contains no assessment,
// AI, policy, execution, or outcome logic of its own. It calls the exact,
// unmodified Sep 1 runRecoveryOrchestration() repeatedly for a single
// payment, advancing simulated time between cycles, until the payment
// reaches a terminal (or escalated) state, OR its decision-opportunity
// budget is exhausted.
//
// runRecoveryOrchestration() is a SINGLE decision cycle (one
// assessment -> AI -> policy -> execute -> outcome pass). Carrying a
// payment through its full lifecycle — the way the Aug 29 baseline's own
// loop already does — requires calling it more than once with an
// advancing `now`. This file owns exactly that loop-control logic, and
// nothing else.
//
// TEMPORAL FAIRNESS / DECISION-OPPORTUNITY PARITY (Sep 2 audit correction):
// EVERY cycle — regardless of which action it approved, including
// RETRY_LATER — consumes exactly one decision opportunity from a single
// shared budget of BASELINE_RETRY_POLICY.maxRetries (3). This guarantees,
// for every payment:
//
//     R2S decision opportunities <= baseline decision opportunities
//
// with equality only when R2S doesn't reach a terminal/escalated state
// earlier. RETRY_LATER still changes WHEN the next opportunity occurs
// (its own approved delayHours) — it does not create an ADDITIONAL
// opportunity beyond the shared budget. Immediate-executing actions
// (RETRY_NOW/SEND_PAYMENT_LINK/SEND_REMINDER/OFFER_INCENTIVE) and BLOCK
// use the baseline's own cadence — BASELINE_RETRY_POLICY.retryIntervalHours
// ([1, 24, 72] absolute hours from case-open), converted here into GAPS
// between successive decision points ([1, 23, 48]) so the same schedule
// can be applied additively from the current `now`, staying strictly
// monotonic even when interleaved with a RETRY_LATER excursion.
// BASELINE_RETRY_POLICY itself is never modified, and the baseline's own
// loop (baselineStrategy.ts) never reads any of this file's logic. No
// arbitrary fixed time step (e.g. 1 hour) is used anywhere in this model.
//
// TERMINAL-STATE CLEANUP (Sep 2 audit correction, Issue 4): if the
// decision-opportunity budget is exhausted while the payment is still in
// a non-terminal, non-escalated state, this module explicitly drives the
// payment/case to "stopped" using the EXISTING, unmodified lifecycle
// transition composer (applyOrchestrationOutcome from
// orchestration/lifecycle.ts — the exact function the orchestrator itself
// uses for a genuine STOP decision) rather than leaving the state
// ambiguous. This mirrors exactly how the Aug 29 baseline's own loop
// already terminates a case administratively (via a direct
// repo.updatePayment/updateRecoveryCase call driven by ITS OWN control
// flow, not a fabricated AI/policy decision) when its retry budget or
// window is exhausted — see runSimulation.ts's stop_max_retries_reached/
// stop_window_expired handling. No new PaymentStatus/RecoveryCaseStatus
// value is introduced, and no policy/AI/executor step is bypassed or
// simulated: this path never touches RecoveryAttempt, never emits
// "action_executed", and is clearly distinguished in the audit trail by
// event payload metadata.
//
// GROUND-TRUTH BOUNDARY: this file never reads GroundTruth and never
// passes anything into the AI/decision layer beyond what
// runRecoveryOrchestration() itself already builds via the unmodified
// assessment/context/request-builder chain.
// =============================================================================

import type { R2SRepository } from "../../db/repository.js";
import type { AIProvider } from "../../ai/provider.js";
import type { AgentDecision, MerchantPolicy, RecoveryAction } from "../../ai/types.js";
import type { PolicyDecision } from "../../policy/types.js";
import type { DecisionSource } from "../../orchestration/types.js";
import { runRecoveryOrchestration } from "../../orchestration/recoveryOrchestrator.js";
import { RecoveryExecutor } from "../../execution/recoveryExecutor.js";
import { isTerminalPaymentStatus } from "../../simulation/stateMachine.js";
import { applyOrchestrationOutcome } from "../../orchestration/lifecycle.js";
import { createEvent } from "../../simulation/events.js";
import { createRng } from "../../simulation/rng.js";
import { IdSequence } from "../../simulation/ids.js";
import { BASELINE_RETRY_POLICY } from "../../strategy/baselineRetry.js";
import { translateCandidateActions } from "../../ai/candidateTranslation.js";
import type { PaymentStatus } from "../../domain/types.js";
import type { InitialWorld } from "../cohort.js";

const HOUR_MS = 60 * 60 * 1000;

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

/** Converts BASELINE_RETRY_POLICY's cumulative from-case-open offsets
 * ([1, 24, 72]) into successive GAPS ([1, 23, 48]) between decision
 * points, so the same cadence can be applied additively to a `now` that
 * may already have been pushed forward by an R2S-specific RETRY_LATER
 * excursion, without ever going backward in time. Pure function of the
 * (unmodified) BASELINE_RETRY_POLICY constant. */
export function retryIntervalGapsHours(): number[] {
  const gaps: number[] = [];
  let prev = 0;
  for (const offset of BASELINE_RETRY_POLICY.retryIntervalHours) {
    gaps.push(offset - prev);
    prev = offset;
  }
  return gaps;
}

/** Exported (additive) so temporal-fairness tests can assert against the
 * exact schedule this module derives from BASELINE_RETRY_POLICY, without
 * hard-coding [1, 23, 48] independently in the test file. */
export const GAPS_HOURS = retryIntervalGapsHours();

/** The shared decision-opportunity budget — every cycle consumes exactly
 * one of these, regardless of which action it approved. Equal to
 * BASELINE_RETRY_POLICY.maxRetries, which is also GAPS_HOURS.length (both
 * describe "how many times the baseline gets to retry"), asserted at
 * module load so a future change to BASELINE_RETRY_POLICY can't silently
 * desync the two. */
export const MAX_DECISION_OPPORTUNITIES = BASELINE_RETRY_POLICY.maxRetries;
if (MAX_DECISION_OPPORTUNITIES !== GAPS_HOURS.length) {
  throw new Error(
    `BASELINE_RETRY_POLICY.maxRetries (${MAX_DECISION_OPPORTUNITIES}) must equal retryIntervalHours.length (${GAPS_HOURS.length}) for the R2S temporal-fairness model's opportunity budget to line up with its cadence schedule.`,
  );
}

/** Mirrors runRecoveryOrchestration's own internal `approvedDecision`
 * resolution (recoveryOrchestrator.ts: MODIFY's modifiedDecision wins over
 * the AI's original recommendation) — duplicated here only because
 * RecoveryRunResult doesn't expose the resolved AgentDecision directly, and
 * this evaluation loop needs its `delayHours` to schedule the next cycle
 * for an executed RETRY_LATER. Not a reimplementation of policy logic —
 * just re-reading the same two already-computed fields the orchestrator
 * itself used moments earlier. */
function resolveApprovedDecision(
  policyDecision: PolicyDecision,
  modifiedDecision: AgentDecision | undefined,
  aiDecision: AgentDecision,
): AgentDecision {
  if (policyDecision === "MODIFY" && modifiedDecision) return modifiedDecision;
  return aiDecision;
}

export interface R2sCycleRecord {
  cycleIndex: number;
  now: Date;
  decisionSource: DecisionSource;
  aiAction: RecoveryAction;
  policyDecision: PolicyDecision;
  /** The action actually approved to reach the executor (AI's original,
   * or policy's MODIFY substitute). Null when BLOCK/ESCALATE meant the
   * executor was never reached. */
  approvedAction: RecoveryAction | null;
  executionStatus: "executed" | "skipped" | "rejected" | "pending" | null;
  outcomeSuccess: boolean | null;
  /** The resolved approved decision's delayHours (AI's original, or
   * policy's MODIFY substitute), for transparency/testability of the
   * temporal fairness model. Null when not applicable (BLOCK/ESCALATE/
   * STOP, or an approved action with no delayHours). */
  approvedDelayHours: number | null;
}

export interface R2sStrategyPaymentResult {
  paymentId: string;
  cycles: R2sCycleRecord[];
  finalPaymentStatus: PaymentStatus;
  /** First cycle's AI-selected action — used (evaluation-layer only, after
   * the fact) for the decision-quality metrics. Null only if the payment
   * somehow produced zero cycles. */
  firstCycleAiAction: RecoveryAction | null;
  /** The concrete RecoveryAction set actually offered to the agent for
   * its first decision cycle — i.e. assessment.candidateActions (from the
   * SAME runRecoveryOrchestration call that produced firstCycleAiAction),
   * translated via the existing, unmodified translateCandidateActions().
   * Captured DURING the real decision (not recomputed later against a
   * since-mutated repository), so it faithfully reflects exactly what the
   * agent could actually choose from. Used exclusively by the
   * evaluation-layer best-available-action decision-quality metric —
   * never fed back into any AI-facing path. Empty only if the payment
   * produced zero cycles. */
  firstCycleAvailableActions: RecoveryAction[];
  /** True when this payment used every decision opportunity in
   * MAX_DECISION_OPPORTUNITIES without reaching a terminal/escalated
   * state on its own — in which case this module explicitly stopped it
   * (see terminateExhaustedPayment), exactly mirroring the baseline's own
   * stop_max_retries_reached termination. */
  opportunityBudgetExhausted: boolean;
}

export interface R2sStrategyResult {
  rngSeed: string;
  perPayment: R2sStrategyPaymentResult[];
}

export interface R2sStrategyParams {
  world: InitialWorld;
  repo: R2SRepository;
  provider: AIProvider;
  merchantPolicy: MerchantPolicy;
  /** Seeded independently from the baseline strategy's RNG (Sep 2
   * correction, item 4). */
  rngSeed: string;
}

/**
 * Explicitly drives an exhausted-budget payment/case to "stopped" using
 * the existing, unmodified lifecycle transition composer — the same one
 * runRecoveryOrchestration() itself uses for a genuine STOP decision.
 * Never touches RecoveryAttempt and never emits "action_executed": this
 * is administrative case-closure by the evaluation harness's own control
 * flow (exactly analogous to how the Aug 29 baseline's loop already
 * closes a case directly when ITS OWN budget/window is exhausted), not a
 * fabricated recovery decision.
 */
function terminateExhaustedPayment(params: {
  repo: R2SRepository;
  paymentId: string;
  recoveryCaseId: string;
  simulationRunId: string;
  now: Date;
  ids: IdSequence;
}): PaymentStatus {
  const { repo, paymentId, recoveryCaseId, simulationRunId, now, ids } = params;

  const payment = repo.getPayment(paymentId);
  if (!payment) {
    throw new Error(`terminateExhaustedPayment(): payment ${paymentId} not found`);
  }

  if (isTerminalPaymentStatus(payment.status) || payment.status === "escalated") {
    // Already settled by the final cycle itself — nothing to do. (This
    // guards the same re-entrancy case the orchestrator's own
    // `alreadyTerminal` check guards against.)
    return payment.status;
  }

  const recoveryCase = repo.getRecoveryCaseByPayment(paymentId);

  const nextState = applyOrchestrationOutcome(
    { paymentStatus: payment.status, recoveryCaseStatus: recoveryCase?.status ?? null },
    "stopped",
  );

  repo.updatePayment(paymentId, { status: nextState.paymentStatus, updatedAt: now });
  if (recoveryCase && nextState.recoveryCaseStatus) {
    repo.updateRecoveryCase(recoveryCaseId, { status: nextState.recoveryCaseStatus, closedAt: now });
  }

  // Deterministic id (paymentId is unique per repo) rather than a
  // wall-clock/hrtime-based one, so this event never affects
  // reproducibility comparisons.
  repo.insertAuditEvents([
    createEvent(ids, {
      id: `evt_eval_opportunity_budget_exhausted_${paymentId}`,
      entityType: "RecoveryCase",
      entityId: recoveryCaseId,
      eventType: "stopped",
      occurredAt: now,
      paymentId,
      simulationRunId,
      payload: {
        reason: "evaluation_decision_opportunity_budget_exhausted",
        maxDecisionOpportunities: MAX_DECISION_OPPORTUNITIES,
      },
    }),
  ]);

  return nextState.paymentStatus;
}

async function runR2sForPayment(params: {
  paymentId: string;
  caseOpenedAt: Date;
  simulationRunId: string;
  repo: R2SRepository;
  provider: AIProvider;
  merchantPolicy: MerchantPolicy;
  rng: ReturnType<typeof createRng>;
  ids: IdSequence;
  executor: RecoveryExecutor;
}): Promise<R2sStrategyPaymentResult> {
  const { paymentId, caseOpenedAt, simulationRunId, repo, provider, merchantPolicy, rng, ids, executor } =
    params;

  const cycles: R2sCycleRecord[] = [];
  let firstCycleAiAction: RecoveryAction | null = null;
  let firstCycleAvailableActions: RecoveryAction[] = [];
  let opportunityBudgetExhausted = false;

  const firstGap = GAPS_HOURS[0];
  if (firstGap === undefined) {
    throw new Error("BASELINE_RETRY_POLICY.retryIntervalHours must not be empty");
  }
  let now = addHours(caseOpenedAt, firstGap);

  let finalPaymentStatus: PaymentStatus = "failed";

  // `opportunitiesUsed` is incremented after EVERY cycle, regardless of
  // which action it approved — this is the single shared budget that
  // makes RETRY_LATER unable to buy extra decision opportunities (Sep 2
  // audit correction, Issue 1). It doubles as the schedule index for
  // computing the next cadence-based gap when the cycle wasn't an
  // executed RETRY_LATER.
  let opportunitiesUsed = 0;

  while (opportunitiesUsed < MAX_DECISION_OPPORTUNITIES) {
    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId,
      merchantPolicy,
      rng,
      now,
      executor,
      ids,
    });

    if (opportunitiesUsed === 0) {
      firstCycleAiAction = result.aiDecision.action;
      // Captured from THIS decision's own assessment — the existing,
      // unmodified translateCandidateActions() bridge, applied to the
      // exact candidate set the agent was actually offered for this
      // payment at this decision point. Not recomputed later.
      firstCycleAvailableActions = translateCandidateActions(result.assessment.candidateActions).map(
        (c) => c.action,
      );
    }

    const approvedDecision = resolveApprovedDecision(
      result.policyResult.decision,
      result.policyResult.modifiedDecision,
      result.aiDecision,
    );
    const wasRetryLaterExecuted =
      result.execution?.status === "executed" && result.execution.action === "RETRY_LATER";

    cycles.push({
      cycleIndex: opportunitiesUsed,
      now,
      decisionSource: result.decisionSource,
      aiAction: result.aiDecision.action,
      policyDecision: result.policyResult.decision,
      approvedAction: result.execution?.action ?? null,
      executionStatus: result.execution?.status ?? null,
      outcomeSuccess: result.outcome?.success ?? null,
      approvedDelayHours: result.execution !== null ? approvedDecision.delayHours ?? null : null,
    });

    finalPaymentStatus = result.finalState.paymentStatus;
    opportunitiesUsed++;

    if (isTerminalPaymentStatus(finalPaymentStatus) || finalPaymentStatus === "escalated") {
      break;
    }

    if (opportunitiesUsed >= MAX_DECISION_OPPORTUNITIES) {
      // Budget exhausted without reaching a terminal/escalated state on
      // its own — explicitly stop the case (Issue 4) rather than leaving
      // it ambiguous. Same number of decision opportunities as the
      // baseline's maxRetries, never more.
      opportunityBudgetExhausted = true;
      finalPaymentStatus = terminateExhaustedPayment({
        repo,
        paymentId,
        recoveryCaseId: `case_${paymentId}`,
        simulationRunId,
        now,
        ids,
      });
      break;
    }

    // ---- Compute next cycle's `now` (temporal fairness model) ----
    // opportunitiesUsed now equals the index of the gap that would apply
    // if this next cycle uses the baseline cadence (i.e. GAPS_HOURS[1]
    // after opportunity 0, GAPS_HOURS[2] after opportunity 1, ...).
    if (wasRetryLaterExecuted && approvedDecision.delayHours && approvedDecision.delayHours > 0) {
      now = addHours(now, approvedDecision.delayHours);
      // RETRY_LATER substitutes its own explicit timing instead of the
      // baseline cadence — but opportunitiesUsed was still incremented
      // above, so it still consumed exactly one shared opportunity.
    } else {
      const gap = GAPS_HOURS[opportunitiesUsed];
      if (gap === undefined) {
        // Should not happen: opportunitiesUsed < MAX_DECISION_OPPORTUNITIES
        // (checked above) and GAPS_HOURS.length === MAX_DECISION_OPPORTUNITIES
        // (asserted at module load), so a valid gap always exists here.
        throw new Error("r2sStrategy: gap schedule index out of range unexpectedly");
      }
      now = addHours(now, gap);
    }
  }

  return {
    paymentId,
    cycles,
    finalPaymentStatus,
    firstCycleAiAction,
    firstCycleAvailableActions,
    opportunityBudgetExhausted,
  };
}

/**
 * Runs the full R2S pipeline (Assessment -> AI -> Policy -> Executor ->
 * Outcome -> Lifecycle -> Audit, via the unmodified Sep 1 orchestrator)
 * against every cohort entry in `world`, against `repo` (expected to
 * already have the world materialized into it via materializeWorldInto).
 * Every payment receives AT MOST MAX_DECISION_OPPORTUNITIES decision
 * cycles — the same number the baseline's own maxRetries allows.
 */
export async function runR2sStrategy(params: R2sStrategyParams): Promise<R2sStrategyResult> {
  const { world, repo, provider, merchantPolicy, rngSeed } = params;
  const rng = createRng(rngSeed);
  const ids = new IdSequence();
  const executor = new RecoveryExecutor();

  const perPayment: R2sStrategyPaymentResult[] = [];
  for (const entry of world.cohort) {
    const result = await runR2sForPayment({
      paymentId: entry.paymentId,
      caseOpenedAt: entry.caseOpenedAt,
      simulationRunId: world.simulationRunId,
      repo,
      provider,
      merchantPolicy,
      rng,
      ids,
      executor,
    });
    perPayment.push(result);
  }

  return { rngSeed, perPayment };
}
