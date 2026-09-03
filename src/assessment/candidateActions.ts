// =============================================================================
// Candidate action generation (Aug 30)
// =============================================================================
// Deterministic, rule-based candidate action generation. This is NOT a
// policy or an agent: it only produces a ranked list of *candidate*
// actions with human-readable rationale strings built from templates —
// it does not decide which one "wins", does not execute anything, and
// has no AI/LLM involvement anywhere in this file.
//
// The action vocabulary (BEST_ACTIONS) is intentionally the same fixed
// vocabulary used by src/domain/types.ts's ground-truth `bestAction`
// field, since candidate actions are meant to eventually be compared
// against the (still hidden) ground-truth best action for evaluation.
// Sharing an action *vocabulary* is not a ground-truth leak — no ground
// truth VALUE is read anywhere in this file.
// =============================================================================

import type { RecoveryFeatures } from "./features.js";
import type { BestAction } from "../domain/types.js";

export interface CandidateAction {
  action: BestAction;
  rationale: string;
  /** 1 = most recommended. Lower is higher priority. */
  priority: number;
}

export function generateCandidateActions(
  features: RecoveryFeatures,
  score: number,
): CandidateAction[] {
  // Case closed or never opened: nothing actionable.
  if (!features.hasOpenCase) {
    return [
      {
        action: "no_action",
        rationale: "Payment has no open recovery case.",
        priority: 1,
      },
    ];
  }

  if (
    features.recoveryCaseStatus &&
    ["recovered", "failed", "stopped"].includes(features.recoveryCaseStatus)
  ) {
    return [
      {
        action: "no_action",
        rationale: `Recovery case is already closed (status: ${features.recoveryCaseStatus}).`,
        priority: 1,
      },
    ];
  }

  if (features.windowRemainingHours !== null && features.windowRemainingHours <= 0) {
    return [
      {
        action: "no_action",
        rationale: "Recovery window has expired; no further action is worthwhile.",
        priority: 1,
      },
    ];
  }

  const candidates: CandidateAction[] = [];

  switch (features.failureCategory) {
    case "invalid_instrument":
      candidates.push({
        action: "prompt_instrument_update",
        rationale: "Failure category indicates the payment instrument itself is invalid or expired.",
        priority: 1,
      });
      break;

    case "authentication_failure":
      candidates.push({
        action: "prompt_instrument_update",
        rationale: "Authentication/verification failures are often resolved by having the customer re-authenticate or update their instrument.",
        priority: 1,
      });
      candidates.push({
        action: "retry_delayed",
        rationale: "A delayed retry can also succeed if the failure was a transient authentication hiccup.",
        priority: 2,
      });
      break;

    case "repeated_failure":
      candidates.push({
        action: "escalate_to_human",
        rationale: "Repeated failures on this case suggest automated retries are unlikely to help further.",
        priority: 1,
      });
      break;

    case "temporary_bank_failure":
      candidates.push({
        action: "retry_immediate",
        rationale: "Temporary bank failures typically resolve quickly, so an immediate retry is reasonable.",
        priority: 1,
      });
      break;

    case "insufficient_funds":
      candidates.push({
        action: "retry_delayed",
        rationale: "Insufficient-funds failures are more likely to succeed after giving the customer time (e.g. next payday cycle).",
        priority: 1,
      });
      break;

    case "unknown":
    default:
      candidates.push({
        action: features.attemptsMade === 0 ? "retry_immediate" : "retry_delayed",
        rationale: "Failure category is unclear; a standard retry is the reasonable default first step.",
        priority: 1,
      });
      break;
  }

  // Low-confidence override: if the score is low and we've already made at
  // least two attempts, prefer escalation over yet another automated retry.
  // (Sep 3 controlled experiment: raised from `> 0` to `>= 2` — requires
  // repeated evidence of failure, not just a single failed attempt, before
  // escalation is offered as the top candidate. No other threshold, prior,
  // or effectiveness value changed.)
  if (score < 0.3 && features.priorFailureCount >= 2) {
    candidates.unshift({
      action: "escalate_to_human",
      rationale: `Recovery score is low (${score.toFixed(2)}) after ${features.priorFailureCount} failed attempt(s); further automated retries have diminishing value.`,
      priority: 1,
    });
    // Renumber the rest below the new top pick.
    for (let i = 1; i < candidates.length; i++) {
      candidates[i]!.priority = i + 1;
    }
  }

  // Always offer no_action as the lowest-priority fallback candidate, for
  // completeness of the action set.
  candidates.push({
    action: "no_action",
    rationale: "Fallback: take no further action on this attempt cycle.",
    priority: candidates.length + 1,
  });

  return candidates;
}