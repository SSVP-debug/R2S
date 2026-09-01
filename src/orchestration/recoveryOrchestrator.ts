// =============================================================================
// Recovery Orchestrator (Sep 1)
// =============================================================================
// Coordinates the existing pipeline into one closed-loop run:
//
//   Failed Payment -> Assessment (Day 2, unmodified)
//                   -> Agent-safe Context (Day 1, unmodified)
//                   -> AI Recommendation (Day 3, unmodified, via decisionResolver)
//                   -> Policy Evaluation (Day 3, unmodified)
//                   -> ALLOW/MODIFY/BLOCK/ESCALATE
//                   -> Simulated Execution (this milestone, src/execution/)
//                   -> Outcome Simulator (Day 1's simulateAttemptOutcome, unmodified)
//                   -> State Transition (Day 1's stateMachine, unmodified, via lifecycle.ts)
//                   -> Audit (Day 1's event model + Day 3's audit builders, unmodified)
//
// This file does not reimplement any of the above — it calls the existing
// functions and wires their outputs together.
//
// GROUND-TRUTH ISOLATION: this file DOES call repo.getGroundTruthByPayment
// directly — that is expected and correct. The orchestrator is not "the
// AI" or "the executor" (neither of which import this file, and neither
// of which has repository access at all); it is the system-level
// coordinator, exactly analogous to how Aug 29's runSimulation.ts already
// legitimately reads ground truth to drive outcome simulation. Ground
// truth is read here ONLY to pass into the existing, ground-truth-aware
// simulateAttemptOutcome() — it is never placed in the AgentDecisionRequest,
// never passed to the executor, and never written into any audit event
// payload below.
//
// POLICY IS AUTHORITATIVE: the executor is called with an action ONLY
// when policyResult.decision is ALLOW (the AI's original action) or
// MODIFY (policyResult.modifiedDecision's action — never the AI's
// original). For BLOCK and ESCALATE, the executor is never called at all.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import type { AIProvider } from "../ai/provider.js";
import type { MerchantPolicy as AiMerchantPolicy } from "../ai/types.js";
import type { AgentDecision, RecoveryAction } from "../ai/types.js";
import { buildAssessmentContext } from "../assessment/contextBuilder.js";
import { assessFromContext } from "../assessment/assessment.js";
import { evaluatePolicy } from "../policy/policyEngine.js";
import type { PolicyResult } from "../policy/types.js";
import {
  buildAiDecisionAuditEvent,
  buildPolicyDecisionAuditEvent,
} from "../policy/auditIntegration.js";
import { RecoveryExecutor, type RecoveryExecutionResult } from "../execution/recoveryExecutor.js";
import { simulateAttemptOutcome, type AttemptOutcome } from "../outcome/simulateOutcome.js";
import { createEvent } from "../simulation/events.js";
import { isTerminalPaymentStatus } from "../simulation/stateMachine.js";
import { IdSequence } from "../simulation/ids.js";
import type { Rng } from "../simulation/rng.js";
import type { AuditEvent, RecoveryAttempt } from "../domain/types.js";
import { resolveDecision } from "./decisionResolver.js";
import { applyOrchestrationOutcome, type LifecycleState } from "./lifecycle.js";
import { transitionStage } from "./stageTransitions.js";
import type { OrchestrationStage, RecoveryRunResult } from "./types.js";

export interface RunRecoveryOrchestrationParams {
  repo: R2SRepository;
  provider: AIProvider;
  paymentId: string;
  merchantPolicy: AiMerchantPolicy;
  /** Seeded RNG used only for outcome simulation determinism (reused
   * unmodified from src/simulation/rng.ts). Caller controls seeding so a
   * batch of orchestrated runs can be made fully reproducible. */
  rng: Rng;
  now: Date;
  /** Optional shared executor instance. Pass the same instance across
   * multiple calls to exercise/rely on idempotency across a batch;
   * defaults to a fresh executor per call otherwise. */
  executor?: RecoveryExecutor;
  /** Optional shared id sequence. IMPORTANT: pass the SAME instance
   * across multiple calls against the same repo (e.g. processing a batch
   * of payments, or replaying the same payment) — otherwise each call's
   * default fresh IdSequence restarts its "evt"/"att" counters at 1,
   * which will collide on AuditEvent/RecoveryAttempt primary keys the
   * moment a second call's events are inserted into the same repo. This
   * mirrors exactly how Aug 29's runSimulation.ts already uses one
   * IdSequence for an entire dataset generation run rather than one per
   * entity. */
  ids?: IdSequence;
}

export async function runRecoveryOrchestration(
  params: RunRecoveryOrchestrationParams,
): Promise<RecoveryRunResult> {
  const { repo, provider, paymentId, merchantPolicy, rng, now } = params;
  const executor = params.executor ?? new RecoveryExecutor();
  const ids = params.ids ?? new IdSequence();
  const events: AuditEvent[] = [];

  // Collision-resistant event id generator for THIS call. IdSequence
  // alone is not enough: a caller legitimately constructs a fresh
  // IdSequence for each call (e.g. after a process restart — Sep 1
  // correction, Issue 3's durable idempotency must survive exactly that),
  // which would otherwise reset "evt"'s counter back to 1 and collide
  // with events already persisted by an earlier call against the same
  // database. `process.hrtime.bigint()` is a monotonic, ever-increasing
  // clock (not Math.random() — no non-determinism is introduced into any
  // business/simulation logic, only into this opaque, content-free
  // primary-key string) combined with a per-call local counter, so ids
  // generated within one call are always distinct from any other call's,
  // past or future, in this process.
  let eventIdCounter = 0;
  const eventIdSalt = process.hrtime.bigint().toString(36);
  function nextEventId(label: string): string {
    eventIdCounter++;
    return `evt_${label}_${eventIdSalt}_${eventIdCounter}`;
  }

  const paymentRow = repo.getPayment(paymentId);
  if (!paymentRow) {
    throw new Error(`runRecoveryOrchestration(): Payment ${paymentId} not found`);
  }
  const simulationRunId = paymentRow.simulationRunId;

  let stage: OrchestrationStage = "recovery_pending";

  // ---- 1. Assessment (Day 2, unmodified) ----
  const context = buildAssessmentContext(repo, paymentId);
  const assessment = assessFromContext(context, now);

  const recoveryCaseId = context.recoveryCase?.id ?? paymentId;

  // ---- 2. AI decision (Day 3, unmodified, via decisionResolver) ----
  const { result: aiResult, source: decisionSource } = await resolveDecision({
    provider,
    context,
    assessment,
    merchantPolicy,
  });
  stage = transitionStage(stage, "decision_made");

  const aiEvent = buildAiDecisionAuditEvent(ids, {
    id: nextEventId("ai_decision"),
    paymentId,
    recoveryCaseId,
    simulationRunId,
    occurredAt: now,
    result: aiResult,
  });
  events.push(aiEvent);

  // ---- 3. Policy evaluation (Day 3, unmodified) — authoritative ----
  const policyResult: PolicyResult = evaluatePolicy({
    paymentAmount: context.amount,
    retryCount: assessment.features.attemptsMade,
    windowRemainingHours: assessment.features.windowRemainingHours,
    priorFailureCount: assessment.features.priorFailureCount,
    recommendation: aiResult.decision,
    merchantPolicy,
  });
  stage = transitionStage(stage, "policy_evaluated");

  const policyEvent = buildPolicyDecisionAuditEvent(ids, {
    id: nextEventId("policy_decision"),
    paymentId,
    recoveryCaseId,
    simulationRunId,
    occurredAt: now,
    policyResult,
  });
  events.push(policyEvent);

  let lifecycleState: LifecycleState = {
    paymentStatus: paymentRow.status,
    recoveryCaseStatus: context.recoveryCase?.status ?? null,
  };

  let execution: RecoveryExecutionResult | null = null;
  let outcome: AttemptOutcome | null = null;

  // ---- 4-8. Execution, gated strictly by policy authority ----
  if (policyResult.decision === "ALLOW" || policyResult.decision === "MODIFY") {
    // CRITICAL: use the MODIFIED decision's action/params when MODIFY —
    // never the AI's original recommendation.
    const approvedDecision: AgentDecision =
      policyResult.decision === "MODIFY" && policyResult.modifiedDecision
        ? policyResult.modifiedDecision
        : aiResult.decision;

    // Determine this attempt's number: reuse an existing PENDING attempt's
    // number if this case already has one reserved-but-unsettled (e.g. a
    // prior call crashed after reserving the attempt but before it
    // completed) — a retry must recognize and short-circuit against the
    // SAME logical attempt, not skip past it to a new number. Otherwise
    // this is a genuinely fresh attempt: the next sequential number.
    const pendingPriorAttempt = context.priorAttempts.find((a) => a.outcome === "pending");
    const attemptNumber = pendingPriorAttempt
      ? pendingPriorAttempt.attemptNumber
      : assessment.features.attemptsMade + 1;
    const idempotencyKey = `${paymentId}:${recoveryCaseId}:${attemptNumber}`;
    const reservedAttemptId = `att_${sanitizeForId(idempotencyKey)}`;

    // ---- Durable idempotency check (Sep 1 correction, Issue 3; refined
    // by the Sep 1 final idempotency correction below) ----
    // Authoritative, cross-process boundary: checked against PERSISTENT
    // storage (SQLite) before anything else — including before the
    // in-memory executor cache below, and before any reservation is made.
    // Catches BOTH a fully-settled prior attempt AND a still-"pending"
    // reservation left behind by an interrupted prior call — either way,
    // per Issue 3, we do not execute again. This is what makes idempotency
    // survive a brand-new RecoveryExecutor/orchestrator call constructed
    // against the same database (e.g. after a process restart), which an
    // in-memory-only cache cannot provide. The in-memory cache remains a
    // fast-path optimization for repeated calls within one process, but is
    // not the only idempotency boundary.
    const persistedAttempt = repo.getRecoveryAttemptByIdempotencyKey(idempotencyKey);
    if (persistedAttempt) {
      const { execution: durableExecution, outcome: preservedOutcome } =
        resolvePersistedAttemptResult(persistedAttempt, {
          idempotencyKey,
          paymentId,
          recoveryCaseId,
          attemptNumber,
          fallbackAction: aiResult.decision.action,
        });

      // FINAL IDEMPOTENCY CORRECTION: a persisted reservation that was
      // never settled (status "pending") must NOT advance the stage to
      // "action_executed" — no execution occurred during THIS call. It
      // goes straight from "policy_evaluated" to "completed", an
      // already-valid existing transition (see stageTransitions.ts), so
      // no new stage was added. A genuinely settled attempt DOES pass
      // through "action_executed" on its way to "completed", accurately
      // reflecting that (in a prior call) an execution really happened.
      if (durableExecution.status === "pending") {
        stage = transitionStage(stage, "completed");
      } else {
        stage = transitionStage(stage, "action_executed");
        stage = transitionStage(stage, "completed");
      }

      repo.insertAuditEvents(events);
      return {
        paymentId,
        assessment,
        decisionSource,
        aiDecision: aiResult.decision,
        policyResult,
        execution: durableExecution,
        outcome: preservedOutcome,
        finalState: lifecycleState,
        stage,
        events,
      };
    }

    // Only genuine recovery-tactic actions (never STOP/ESCALATE, which the
    // executor always marks "skipped" and which have no re-execution risk
    // to guard against) get a durable RESERVATION before the executor is
    // called. Reserving first — rather than only recording after
    // completion — is what lets the check above actually catch a crash
    // that happens between "decided to execute" and "finished executing":
    // without this, nothing would be durably visible yet for a retry to
    // find, and the DB check would be unable to ever fire in practice.
    const isGenuineRecoveryAction =
      approvedDecision.action !== "STOP" && approvedDecision.action !== "ESCALATE";
    if (isGenuineRecoveryAction && context.recoveryCase) {
      repo.insertRecoveryAttempt({
        id: reservedAttemptId,
        attemptNumber,
        strategy: "ai_orchestrated",
        action: approvedDecision.action,
        idempotencyKey,
        scheduledAt: now,
        executedAt: null,
        outcome: "pending",
        amountRecovered: null,
        recoveryCaseId: context.recoveryCase.id,
        simulationRunId,
      });
    }

    execution = executor.execute({
      idempotencyKey,
      paymentId,
      recoveryCaseId,
      attemptNumber,
      action: approvedDecision.action,
      delayHours: approvedDecision.delayHours,
      incentivePercent: approvedDecision.incentivePercent,
      requestedAt: now,
    });
    stage = transitionStage(stage, "action_executed");

    if (execution.idempotent) {
      // Item 4: a duplicate execution of an already-resolved idempotency
      // key must NOT execute the action twice, must NOT re-run outcome
      // simulation, must NOT insert a second RecoveryAttempt row, and
      // must NOT re-apply state transitions or emit a second round of
      // execution/outcome audit events — all of that already happened on
      // the original call. We return the existing execution result
      // (already carrying idempotent: true) and leave `outcome` as null:
      // this call did not (re)compute an outcome, and the original
      // outcome is durably recorded in the RecoveryAttempt/Payment rows
      // from the first call, not reconstructed here.
      stage = transitionStage(stage, "completed");
      repo.insertAuditEvents(events);
      return {
        paymentId,
        assessment,
        decisionSource,
        aiDecision: aiResult.decision,
        policyResult,
        execution,
        outcome: null,
        finalState: lifecycleState,
        stage,
        events,
      };
    }

    if (execution.status === "executed") {
      // Issue 2 correction: action_executed is emitted ONLY for a
      // genuinely executed action — never for "skipped" (STOP/ESCALATE)
      // or "rejected".
      events.push(
        createEvent(ids, {
          id: nextEventId("action_executed"),
          entityType: "RecoveryAttempt",
          entityId: execution.idempotencyKey,
          eventType: "action_executed",
          occurredAt: now,
          paymentId,
          simulationRunId,
          payload: {
            action: execution.action,
            status: execution.status,
            idempotent: execution.idempotent,
            attemptNumber: execution.attemptNumber,
          },
        }),
      );

      // ---- Outcome simulation (Day 1, unmodified aside from the Sep 1
      // action-conditioning correction). Ground truth is read HERE ONLY,
      // and never leaves this scope as anything but the ground-truth-free
      // AttemptOutcome. The APPROVED action (post-policy — never the AI's
      // original pre-MODIFY action) is passed through, per Issue 1. ----
      const groundTruth = repo.getGroundTruthByPayment(paymentId);
      if (!groundTruth) {
        throw new Error(
          `runRecoveryOrchestration(): no GroundTruth found for failed payment ${paymentId} — this indicates a data integrity issue upstream, not an orchestration decision.`,
        );
      }

      const simulatedOutcome = simulateAttemptOutcome(
        rng,
        groundTruth,
        execution.action,
        attemptNumber,
        context.amount,
      );
      if (!simulatedOutcome) {
        // Defensive: execution.status === "executed" already guarantees
        // execution.action is one of the 5 genuine recovery-tactic
        // actions (RecoveryExecutor never marks ESCALATE/STOP as
        // "executed" — see src/execution/recoveryExecutor.ts), so
        // simulateAttemptOutcome cannot return null here. Unreachable in
        // practice; handled defensively rather than asserted away.
        throw new Error(
          `runRecoveryOrchestration(): simulateAttemptOutcome unexpectedly returned null for executed action ${execution.action} on payment ${paymentId}`,
        );
      }
      outcome = simulatedOutcome;
      stage = transitionStage(stage, "outcome_evaluated");

      lifecycleState = applyOrchestrationOutcome(
        lifecycleState,
        outcome.success ? "attempt_success" : "attempt_failure",
      );

      events.push(
        createEvent(ids, {
          id: nextEventId(outcome.success ? "payment_recovered" : "recovery_failed"),
          entityType: "Payment",
          entityId: paymentId,
          eventType: outcome.success ? "payment_recovered" : "recovery_failed",
          occurredAt: now,
          paymentId,
          simulationRunId,
          payload: {
            amountRecovered: outcome.amountRecovered,
            attemptNumber,
          },
        }),
      );

      // Settle the RESERVED RecoveryAttempt row (Day 1's existing
      // table/type, with the Sep-1-additive `action`/`idempotencyKey`
      // fields populated) — updated in place rather than inserted fresh,
      // since it was already durably reserved above before the executor
      // was called.
      if (context.recoveryCase) {
        repo.updateRecoveryAttempt(reservedAttemptId, {
          executedAt: execution.executedAt,
          outcome: outcome.success ? "success" : "failure",
          amountRecovered: outcome.success ? outcome.amountRecovered : null,
        });
      }

      repo.updatePayment(paymentId, {
        status: lifecycleState.paymentStatus,
        attemptCount: attemptNumber,
        updatedAt: now,
      });
      if (context.recoveryCase && lifecycleState.recoveryCaseStatus) {
        repo.updateRecoveryCase(context.recoveryCase.id, {
          status: lifecycleState.recoveryCaseStatus,
          closedAt: outcome.success ? now : null,
        });
      }
      stage = transitionStage(stage, "completed");
    } else {
      // "skipped" (STOP/ESCALATE reached via ALLOW) or "rejected"
      // (shouldn't occur given upstream validation, but handled safely).
      // No "action_executed" event is emitted for either — see Issue 2.
      stage = transitionStage(stage, "completed");

      // Defensive cleanup: STOP/ESCALATE never reserve a row
      // (isGenuineRecoveryAction is false for them), so there is nothing
      // to settle in that case. A "rejected" result for what WAS
      // classified as a genuine recovery action, however, did reserve a
      // row above — mark it "blocked" rather than leaving it stuck at
      // "pending" forever.
      if (isGenuineRecoveryAction && execution.status === "rejected" && context.recoveryCase) {
        repo.updateRecoveryAttempt(reservedAttemptId, { outcome: "blocked" });
      }

      // ROBUSTNESS GUARD: if this payment/case has already reached a
      // terminal state (e.g. a prior orchestration cycle already
      // recovered/failed_final/stopped it — Day 2's assessment naturally
      // offers only a "no_action"/STOP-shaped candidate for closed cases,
      // so a re-entrant call for an already-closed case legitimately ends
      // up here), do not attempt to transition state again — that would
      // throw (there is no outgoing transition from a terminal state) for
      // no benefit, since there is nothing left to stop/escalate. This
      // uses the EXISTING isTerminalPaymentStatus() from
      // src/simulation/stateMachine.ts, unmodified.
      const alreadyTerminal = isTerminalPaymentStatus(lifecycleState.paymentStatus);

      if (!alreadyTerminal && execution.action === "STOP") {
        lifecycleState = applyOrchestrationOutcome(lifecycleState, "stopped");
        events.push(
          createEvent(ids, {
            id: nextEventId("stopped"),
            entityType: "RecoveryCase",
            entityId: recoveryCaseId,
            eventType: "stopped",
            occurredAt: now,
            paymentId,
            simulationRunId,
          }),
        );
      } else if (!alreadyTerminal && execution.action === "ESCALATE") {
        lifecycleState = applyOrchestrationOutcome(lifecycleState, "escalated");
        // Reached here only via ALLOW/MODIFY (the AI/baseline recommended
        // ESCALATE directly and policy raised no objection) — the
        // "escalation" event from buildPolicyDecisionAuditEvent above only
        // fires when POLICY ITSELF decides ESCALATE (the other branch,
        // below), so this path needs its own record.
        events.push(
          createEvent(ids, {
            id: nextEventId("escalation"),
            entityType: "RecoveryCase",
            entityId: recoveryCaseId,
            eventType: "escalation",
            occurredAt: now,
            paymentId,
            simulationRunId,
          }),
        );
      }

      if (!alreadyTerminal) {
        repo.updatePayment(paymentId, { status: lifecycleState.paymentStatus, updatedAt: now });
        if (context.recoveryCase && lifecycleState.recoveryCaseStatus) {
          repo.updateRecoveryCase(context.recoveryCase.id, {
            status: lifecycleState.recoveryCaseStatus,
          });
        }
      }
    }
  } else {
    // BLOCK or ESCALATE (policy-driven): the executor is NEVER called.
    stage = transitionStage(stage, "completed");

    if (policyResult.decision === "ESCALATE" && !isTerminalPaymentStatus(lifecycleState.paymentStatus)) {
      lifecycleState = applyOrchestrationOutcome(lifecycleState, "escalated");
      if (context.recoveryCase && lifecycleState.recoveryCaseStatus) {
        repo.updateRecoveryCase(context.recoveryCase.id, {
          status: lifecycleState.recoveryCaseStatus,
        });
      }
      repo.updatePayment(paymentId, { status: lifecycleState.paymentStatus, updatedAt: now });
    }
    // BLOCK: no state change (see lifecycle.ts's "blocked" branch) — the
    // policy audit event above is the full record of this cycle.
  }

  repo.insertAuditEvents(events);

  return {
    paymentId,
    assessment,
    decisionSource,
    aiDecision: aiResult.decision,
    policyResult,
    execution,
    outcome,
    finalState: lifecycleState,
    stage,
    events,
  };
}

/** Turns an idempotency key into a safe id-fragment (alphanumerics,
 * underscore, hyphen only). */
function sanitizeForId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// =============================================================================
// resolvePersistedAttemptResult (Sep 1 final idempotency correction)
// =============================================================================
// Pure function: maps a persisted RecoveryAttempt row (found by the
// durable idempotency check) to the RecoveryExecutionResult/AttemptOutcome
// pair that should be returned WITHOUT re-executing anything. Extracted
// out of runRecoveryOrchestration() specifically so both branches — the
// bug that was reported (a "pending" reservation must never be reported
// as "executed") and the correct pre-existing behavior (a genuinely
// settled attempt IS reported as "executed", with its outcome preserved)
// — can be tested directly and deterministically, independent of the
// live attempt-number computation in the orchestrator. (Reaching the
// "settled" branch via a live, sequential, single-process orchestrator
// call is not generally possible by construction: once ANY attempt for a
// case is persisted, the orchestrator's own next-attempt-number
// computation always advances past it — see the `attemptNumber`
// computation above. The "settled" branch exists as a defensive
// safeguard, e.g. for a genuinely concurrent duplicate request racing
// against an in-flight one, and this pure function makes that logic
// independently verifiable.)
//
// Semantic rule enforced here (this is the entire bug fix):
//   outcome === "pending" && executedAt === null
//     => status "pending" (a reservation exists; execution was never
//        proven to complete — NEVER reported as "executed")
//   anything else (outcome is "success"/"failure"/"blocked", and/or
//   executedAt is set)
//     => status "executed", with the known outcome preserved when the
//        persisted outcome was "success" or "failure"
// =============================================================================
export function resolvePersistedAttemptResult(
  persistedAttempt: RecoveryAttempt,
  params: {
    idempotencyKey: string;
    paymentId: string;
    recoveryCaseId: string;
    attemptNumber: number;
    /** Action to report if the persisted row's own `action` field is
     * somehow null (defensive fallback only — Sep-1-created rows always
     * set it). */
    fallbackAction: RecoveryAction;
  },
): { execution: RecoveryExecutionResult; outcome: AttemptOutcome | null } {
  const isUnsettledReservation =
    persistedAttempt.outcome === "pending" && persistedAttempt.executedAt === null;

  const action = (persistedAttempt.action as RecoveryAction | null) ?? params.fallbackAction;

  if (isUnsettledReservation) {
    return {
      execution: {
        idempotencyKey: params.idempotencyKey,
        status: "pending",
        action,
        paymentId: params.paymentId,
        recoveryCaseId: params.recoveryCaseId,
        attemptNumber: params.attemptNumber,
        requestedAt: persistedAttempt.scheduledAt,
        executedAt: null,
        idempotent: true,
      },
      outcome: null,
    };
  }

  const preservedOutcome: AttemptOutcome | null =
    persistedAttempt.outcome === "success" || persistedAttempt.outcome === "failure"
      ? {
          success: persistedAttempt.outcome === "success",
          amountRecovered: persistedAttempt.amountRecovered ?? 0,
        }
      : null;

  return {
    execution: {
      idempotencyKey: params.idempotencyKey,
      status: "executed",
      action,
      paymentId: params.paymentId,
      recoveryCaseId: params.recoveryCaseId,
      attemptNumber: params.attemptNumber,
      requestedAt: persistedAttempt.scheduledAt,
      executedAt: persistedAttempt.executedAt,
      idempotent: true,
    },
    outcome: preservedOutcome,
  };
}
