// =============================================================================
// Orchestration stage transitions (Sep 1)
// =============================================================================
// Validates progress through the orchestrator's own pipeline stages
// (recovery_pending -> decision_made -> policy_evaluated ->
// [action_executed] -> [outcome_evaluated] -> completed). The
// action_executed and outcome_evaluated stages are skippable: a BLOCK or
// ESCALATE policy result goes straight from policy_evaluated to completed
// (no execution happened), and a "skipped" execution (STOP/ESCALATE
// reaching the executor via an ALLOWed decision) goes straight from
// action_executed to completed (no outcome to evaluate).
//
// This mirrors the *pattern* of src/simulation/stateMachine.ts (explicit
// transition table, invalid transitions rejected) applied to an entirely
// different concern — pipeline progress, not payment/recovery-case entity
// status. See src/orchestration/types.ts header for why this is not a
// "parallel state definition."
// =============================================================================

import type { OrchestrationStage } from "./types.js";

export class InvalidStageTransitionError extends Error {
  constructor(from: OrchestrationStage, to: OrchestrationStage) {
    super(`Invalid orchestration stage transition: ${from} -> ${to}`);
    this.name = "InvalidStageTransitionError";
  }
}

const STAGE_TRANSITIONS: Record<OrchestrationStage, ReadonlySet<OrchestrationStage>> = {
  recovery_pending: new Set(["decision_made"]),
  decision_made: new Set(["policy_evaluated"]),
  policy_evaluated: new Set(["action_executed", "completed"]),
  action_executed: new Set(["outcome_evaluated", "completed"]),
  outcome_evaluated: new Set(["completed"]),
  completed: new Set([]),
};

export function canTransitionStage(
  from: OrchestrationStage,
  to: OrchestrationStage,
): boolean {
  return STAGE_TRANSITIONS[from].has(to);
}

export function transitionStage(
  from: OrchestrationStage,
  to: OrchestrationStage,
): OrchestrationStage {
  if (!canTransitionStage(from, to)) {
    throw new InvalidStageTransitionError(from, to);
  }
  return to;
}

export function isTerminalStage(stage: OrchestrationStage): boolean {
  return STAGE_TRANSITIONS[stage].size === 0;
}
