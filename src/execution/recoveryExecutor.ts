// =============================================================================
// Simulated Recovery Executor (Sep 1)
// =============================================================================
// Executes exactly one thing: "the simulated recovery action was
// attempted." This is NOT a real payment operation — no external API, no
// real money movement, no real messages sent. It has no repository access
// and no import of GroundTruth: it receives only primitive parameters
// (action, amounts/hours, ids) and returns a result describing what
// happened.
//
// EXECUTION ≠ RECOVERY. A successful "executed" result means the simulated
// action was attempted — whether the payment actually recovers is decided
// separately, afterward, by the existing outcome simulator
// (src/outcome/simulateOutcome.ts), which the orchestrator calls only
// after execution succeeds. This file never determines success/failure of
// the underlying payment.
//
// Of the 7 RecoveryAction values, only 5 represent a genuine attempt to
// recover money (RETRY_NOW, RETRY_LATER, SEND_PAYMENT_LINK, SEND_REMINDER,
// OFFER_INCENTIVE) and get a real "executed" outcome. ESCALATE and STOP
// are, by design, never executed as recovery attempts — see items 9/10 of
// the Sep 1 spec ("ESCALATE is simulated only... do not execute",
// "STOP must execute no recovery action"). They return status "skipped".
// Any action outside the RecoveryAction vocabulary is "rejected".
//
// SEP 1 FINAL IDEMPOTENCY CORRECTION: "pending" is a fourth
// ExecutionStatus value. It is NEVER produced by RecoveryExecutor.execute()
// itself — this class only ever returns "executed"/"skipped"/"rejected".
// "pending" is produced exclusively by
// src/orchestration/recoveryOrchestrator.ts when its durable idempotency
// check (src/db/repository.ts::getRecoveryAttemptByIdempotencyKey) finds a
// persisted RecoveryAttempt whose reservation was never settled (outcome
// === "pending" && executedAt === null — i.e. a prior process reserved
// this attempt and crashed before completing it). Reporting that as
// "executed" would be a false claim that the action ran; "pending"
// accurately reports "a reservation exists, but execution was never
// proven to complete."
// =============================================================================

import { RECOVERY_ACTIONS, type RecoveryAction } from "../ai/types.js";

export type ExecutionStatus = "executed" | "skipped" | "rejected" | "pending";

export interface RecoveryExecutionRequest {
  /** Deterministic key, e.g. `${paymentId}:${recoveryCaseId}:${attemptNumber}`. */
  idempotencyKey: string;
  paymentId: string;
  recoveryCaseId: string;
  attemptNumber: number;
  action: RecoveryAction;
  delayHours?: number;
  incentivePercent?: number;
  requestedAt: Date;
}

export interface RecoveryExecutionResult {
  idempotencyKey: string;
  status: ExecutionStatus;
  action: RecoveryAction;
  paymentId: string;
  recoveryCaseId: string;
  attemptNumber: number;
  requestedAt: Date;
  executedAt: Date | null;
  /** True if this result was returned from the idempotency cache rather
   * than freshly computed by this call. */
  idempotent: boolean;
  rejectionReason?: string;
}

const RECOVERY_TACTIC_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  "RETRY_NOW",
  "RETRY_LATER",
  "SEND_PAYMENT_LINK",
  "SEND_REMINDER",
  "OFFER_INCENTIVE",
]);

const NON_EXECUTING_ACTIONS: ReadonlySet<RecoveryAction> = new Set(["ESCALATE", "STOP"]);

export class RecoveryExecutor {
  private results = new Map<string, RecoveryExecutionResult>();

  /**
   * Executes (or, for a repeated key, returns the prior result for) a
   * simulated recovery action. Never throws — invalid actions are
   * reflected in the returned result's status, not as an exception, so
   * callers always get a well-formed result to record.
   */
  execute(request: RecoveryExecutionRequest): RecoveryExecutionResult {
    const existing = this.results.get(request.idempotencyKey);
    if (existing) {
      return { ...existing, idempotent: true };
    }

    const result = this.computeResult(request);
    this.results.set(request.idempotencyKey, result);
    return result;
  }

  private computeResult(request: RecoveryExecutionRequest): RecoveryExecutionResult {
    const base = {
      idempotencyKey: request.idempotencyKey,
      action: request.action,
      paymentId: request.paymentId,
      recoveryCaseId: request.recoveryCaseId,
      attemptNumber: request.attemptNumber,
      requestedAt: request.requestedAt,
      idempotent: false,
    };

    if (!RECOVERY_ACTIONS.includes(request.action)) {
      return {
        ...base,
        status: "rejected",
        executedAt: null,
        rejectionReason: `Unsupported action: ${String(request.action)}`,
      };
    }

    if (NON_EXECUTING_ACTIONS.has(request.action)) {
      return { ...base, status: "skipped", executedAt: null };
    }

    // RECOVERY_TACTIC_ACTIONS — genuine simulated attempt.
    return { ...base, status: "executed", executedAt: request.requestedAt };
  }

  /** Whether a given idempotency key has already been resolved (executed,
   * skipped, or rejected) — regardless of outcome. */
  hasResult(idempotencyKey: string): boolean {
    return this.results.has(idempotencyKey);
  }

  /** Count of distinct idempotency keys that reached a genuine "executed"
   * status. Used by safety-invariant tests (e.g. "BLOCK -> execution count
   * stays zero"). Repeated idempotent calls to the same key do not
   * increment this — each key counts once. */
  executedCount(): number {
    let count = 0;
    for (const result of this.results.values()) {
      if (result.status === "executed") count++;
    }
    return count;
  }
}
