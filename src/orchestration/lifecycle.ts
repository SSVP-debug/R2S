// =============================================================================
// Lifecycle integration (Sep 1)
// =============================================================================
// Applies orchestration outcomes to Payment/RecoveryCase status using ONLY
// the existing state machine (src/simulation/stateMachine.ts,
// unmodified) — this file adds no new PaymentStatus or RecoveryCaseStatus
// values and performs no transition that isn't already defined there.
//
// GENUINE INTEGRATION GAP FOUND AND RESOLVED WITHOUT MODIFYING THE STATE
// MACHINE: RECOVERY_CASE_TRANSITIONS has no direct "open" -> "escalated"
// edge (a case must reach "in_progress" first), but PAYMENT_TRANSITIONS
// *does* allow "failed" -> "escalated" directly. This matters because a
// case can legitimately be escalated on the very first orchestrated
// decision, before any RecoveryAttempt exists (e.g. Day 2's
// escalate_to_human candidate winning immediately). Rather than adding a
// new edge to the state machine, this module composes the two EXISTING,
// individually-valid edges ("open" -> "in_progress", then
// "in_progress" -> "escalated") — both already legal moves. The same
// two-hop composition is used for "attempt succeeded on the very first
// try" (Payment: "failed" -> "retrying" -> "recovered"; RecoveryCase:
// "open" -> "in_progress" -> "recovered"), matching exactly how Aug 29's
// own src/simulation/runSimulation.ts already drives the case out of
// "open" before closing it.
// =============================================================================

import {
  transitionPayment,
  transitionRecoveryCase,
} from "../simulation/stateMachine.js";
import type { PaymentStatus, RecoveryCaseStatus } from "../domain/types.js";

export type OrchestrationOutcomeEvent =
  | "attempt_success"
  | "attempt_failure"
  | "blocked"
  | "escalated"
  | "stopped";

export interface LifecycleState {
  paymentStatus: PaymentStatus;
  recoveryCaseStatus: RecoveryCaseStatus | null;
}

export function applyOrchestrationOutcome(
  state: LifecycleState,
  event: OrchestrationOutcomeEvent,
): LifecycleState {
  switch (event) {
    case "blocked":
      // Policy blocked the action: nothing about the entity's state
      // changes — the case simply remains open/in_progress for a future
      // cycle (retry-limit/window exhaustion terminality is the
      // responsibility of the existing baseline/policy logic, not
      // duplicated here).
      return state;

    case "attempt_success": {
      const paymentStatus = advancePayment(state.paymentStatus, "recovered");
      const recoveryCaseStatus = advanceCase(state.recoveryCaseStatus, "recovered");
      return { paymentStatus, recoveryCaseStatus };
    }

    case "attempt_failure": {
      // A single failed attempt just settles the payment/case into the
      // active "retrying"/"in_progress" state — it does not, by itself,
      // terminate anything.
      const paymentStatus =
        state.paymentStatus === "failed"
          ? transitionPayment("failed", "retrying")
          : state.paymentStatus === "retrying"
            ? transitionPayment("retrying", "retrying")
            : state.paymentStatus;
      const recoveryCaseStatus =
        state.recoveryCaseStatus === "open"
          ? transitionRecoveryCase("open", "in_progress")
          : state.recoveryCaseStatus === "in_progress"
            ? transitionRecoveryCase("in_progress", "in_progress")
            : state.recoveryCaseStatus;
      return { paymentStatus, recoveryCaseStatus };
    }

    case "escalated": {
      const paymentStatus = advancePayment(state.paymentStatus, "escalated");
      const recoveryCaseStatus = advanceCase(state.recoveryCaseStatus, "escalated");
      return { paymentStatus, recoveryCaseStatus };
    }

    case "stopped": {
      const paymentStatus = advancePayment(state.paymentStatus, "stopped");
      const recoveryCaseStatus = advanceCase(state.recoveryCaseStatus, "stopped");
      return { paymentStatus, recoveryCaseStatus };
    }
  }
}

/** Advances a Payment status toward `target`, hopping through "retrying"
 * first only when required (target === "recovered" and currently
 * "failed") — every intermediate hop is a real, existing, valid
 * transition. */
function advancePayment(current: PaymentStatus, target: "recovered" | "escalated" | "stopped"): PaymentStatus {
  if (current === target) return current;

  if (target === "recovered") {
    const afterHop = current === "failed" ? transitionPayment("failed", "retrying") : current;
    return transitionPayment(afterHop as PaymentStatus, "recovered");
  }

  // "escalated" and "stopped" are both directly reachable from "failed"
  // and "retrying" per PAYMENT_TRANSITIONS — no hop needed.
  return transitionPayment(current, target);
}

/** Advances a RecoveryCase status toward `target`, hopping through
 * "in_progress" first when currently "open" (required for "recovered" and
 * "escalated", which have no direct edge from "open" — see file header).
 * "stopped" IS directly reachable from "open", so no hop is needed there. */
function advanceCase(
  current: RecoveryCaseStatus | null,
  target: "recovered" | "escalated" | "stopped",
): RecoveryCaseStatus | null {
  if (current === null) return null;
  if (current === target) return current;

  if (current === "open" && target !== "stopped") {
    const inProgress = transitionRecoveryCase("open", "in_progress");
    return transitionRecoveryCase(inProgress, target);
  }

  return transitionRecoveryCase(current, target);
}
