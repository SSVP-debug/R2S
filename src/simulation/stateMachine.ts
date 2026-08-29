// =============================================================================
// Payment / recovery-case lifecycle state machine
// =============================================================================
// Enforces valid state transitions for both Payment.status and
// RecoveryCase.status. Invalid transitions throw — they never silently
// no-op or clamp to the nearest valid state.
// =============================================================================

import type { PaymentStatus, RecoveryCaseStatus } from "../domain/types.js";

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// ---- Payment status transitions --------------------------------------------
// "created" doubles as the terminal "succeeded" state when a payment never
// fails at all (see generator.ts). Once a payment fails, it enters the
// recovery pipeline (retrying -> one of the terminal recovery outcomes).
const PAYMENT_TRANSITIONS: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  created: new Set(["failed"]),
  failed: new Set(["retrying", "escalated", "failed_final", "stopped"]),
  retrying: new Set(["recovered", "failed_final", "escalated", "stopped", "retrying"]),
  recovered: new Set([]),
  failed_final: new Set([]),
  escalated: new Set(["recovered", "failed_final", "stopped"]),
  stopped: new Set([]),
};

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return PAYMENT_TRANSITIONS[from].has(to);
}

export function transitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentStatus {
  if (!canTransitionPayment(from, to)) {
    throw new InvalidTransitionError("Payment", from, to);
  }
  return to;
}

// ---- Recovery case status transitions --------------------------------------
const RECOVERY_CASE_TRANSITIONS: Record<
  RecoveryCaseStatus,
  ReadonlySet<RecoveryCaseStatus>
> = {
  open: new Set(["in_progress", "stopped"]),
  in_progress: new Set(["in_progress", "recovered", "failed", "escalated", "stopped"]),
  recovered: new Set([]),
  failed: new Set([]),
  escalated: new Set(["recovered", "failed", "stopped"]),
  stopped: new Set([]),
};

export function canTransitionRecoveryCase(
  from: RecoveryCaseStatus,
  to: RecoveryCaseStatus,
): boolean {
  return RECOVERY_CASE_TRANSITIONS[from].has(to);
}

export function transitionRecoveryCase(
  from: RecoveryCaseStatus,
  to: RecoveryCaseStatus,
): RecoveryCaseStatus {
  if (!canTransitionRecoveryCase(from, to)) {
    throw new InvalidTransitionError("RecoveryCase", from, to);
  }
  return to;
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[status].size === 0;
}

export function isTerminalRecoveryCaseStatus(status: RecoveryCaseStatus): boolean {
  return RECOVERY_CASE_TRANSITIONS[status].size === 0;
}
