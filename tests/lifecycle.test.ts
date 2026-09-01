import { describe, it, expect } from "vitest";
import { applyOrchestrationOutcome } from "../src/orchestration/lifecycle.js";
import {
  canTransitionStage,
  transitionStage,
  isTerminalStage,
  InvalidStageTransitionError,
} from "../src/orchestration/stageTransitions.js";
import { InvalidTransitionError } from "../src/simulation/stateMachine.js";
import type { LifecycleState } from "../src/orchestration/lifecycle.js";

describe("orchestration lifecycle: applyOrchestrationOutcome (domain state, via existing state machine)", () => {
  it("attempt_success on a fresh 'failed'/'open' case reaches 'recovered' via the existing failed->retrying->recovered composition", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: "open" };
    const next = applyOrchestrationOutcome(state, "attempt_success");
    expect(next.paymentStatus).toBe("recovered");
    expect(next.recoveryCaseStatus).toBe("recovered");
  });

  it("attempt_success on an already-'retrying'/'in_progress' case goes directly to 'recovered'", () => {
    const state: LifecycleState = { paymentStatus: "retrying", recoveryCaseStatus: "in_progress" };
    const next = applyOrchestrationOutcome(state, "attempt_success");
    expect(next.paymentStatus).toBe("recovered");
    expect(next.recoveryCaseStatus).toBe("recovered");
  });

  it("attempt_failure on a fresh 'failed'/'open' case moves to 'retrying'/'in_progress'", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: "open" };
    const next = applyOrchestrationOutcome(state, "attempt_failure");
    expect(next.paymentStatus).toBe("retrying");
    expect(next.recoveryCaseStatus).toBe("in_progress");
  });

  it("attempt_failure on an already-'retrying' payment stays 'retrying' (self-loop)", () => {
    const state: LifecycleState = { paymentStatus: "retrying", recoveryCaseStatus: "in_progress" };
    const next = applyOrchestrationOutcome(state, "attempt_failure");
    expect(next.paymentStatus).toBe("retrying");
    expect(next.recoveryCaseStatus).toBe("in_progress");
  });

  it("blocked leaves state completely unchanged", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: "open" };
    const next = applyOrchestrationOutcome(state, "blocked");
    expect(next).toEqual(state);
  });

  it("escalated on a fresh 'failed'/'open' case reaches 'escalated' via the open->in_progress->escalated composition (the genuine integration gap)", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: "open" };
    const next = applyOrchestrationOutcome(state, "escalated");
    expect(next.paymentStatus).toBe("escalated");
    expect(next.recoveryCaseStatus).toBe("escalated");
  });

  it("escalated on an already-'in_progress' case goes directly to 'escalated'", () => {
    const state: LifecycleState = { paymentStatus: "retrying", recoveryCaseStatus: "in_progress" };
    const next = applyOrchestrationOutcome(state, "escalated");
    expect(next.paymentStatus).toBe("escalated");
    expect(next.recoveryCaseStatus).toBe("escalated");
  });

  it("stopped on a fresh 'failed'/'open' case reaches 'stopped' directly (no hop needed)", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: "open" };
    const next = applyOrchestrationOutcome(state, "stopped");
    expect(next.paymentStatus).toBe("stopped");
    expect(next.recoveryCaseStatus).toBe("stopped");
  });

  it("handles a null recoveryCaseStatus gracefully (no case exists)", () => {
    const state: LifecycleState = { paymentStatus: "failed", recoveryCaseStatus: null };
    const next = applyOrchestrationOutcome(state, "stopped");
    expect(next.paymentStatus).toBe("stopped");
    expect(next.recoveryCaseStatus).toBeNull();
  });

  it("every transition performed is a genuinely valid existing state-machine transition (no invalid-transition error is ever thrown for supported event/state combinations)", () => {
    const events = ["attempt_success", "attempt_failure", "blocked", "escalated", "stopped"] as const;
    const startStates: LifecycleState[] = [
      { paymentStatus: "failed", recoveryCaseStatus: "open" },
      { paymentStatus: "retrying", recoveryCaseStatus: "in_progress" },
    ];
    for (const event of events) {
      for (const start of startStates) {
        expect(() => applyOrchestrationOutcome(start, event)).not.toThrow(InvalidTransitionError);
      }
    }
  });
});

describe("orchestration lifecycle: stage transitions", () => {
  it("valid stage transitions succeed in the documented order", () => {
    expect(canTransitionStage("recovery_pending", "decision_made")).toBe(true);
    expect(canTransitionStage("decision_made", "policy_evaluated")).toBe(true);
    expect(canTransitionStage("policy_evaluated", "action_executed")).toBe(true);
    expect(canTransitionStage("action_executed", "outcome_evaluated")).toBe(true);
    expect(canTransitionStage("outcome_evaluated", "completed")).toBe(true);
  });

  it("policy_evaluated can skip directly to completed (BLOCK/ESCALATE — no execution)", () => {
    expect(canTransitionStage("policy_evaluated", "completed")).toBe(true);
  });

  it("action_executed can skip directly to completed (STOP/ESCALATE reached via ALLOW — no outcome to evaluate)", () => {
    expect(canTransitionStage("action_executed", "completed")).toBe(true);
  });

  it("rejects invalid/out-of-order transitions", () => {
    expect(canTransitionStage("recovery_pending", "policy_evaluated")).toBe(false);
    expect(canTransitionStage("recovery_pending", "action_executed")).toBe(false);
    expect(canTransitionStage("recovery_pending", "completed")).toBe(false);
    expect(canTransitionStage("decision_made", "action_executed")).toBe(false);
    expect(() => transitionStage("recovery_pending", "completed")).toThrow(
      InvalidStageTransitionError,
    );
  });

  it("rejects transitions out of the terminal 'completed' stage", () => {
    expect(canTransitionStage("completed", "recovery_pending")).toBe(false);
    expect(() => transitionStage("completed", "decision_made")).toThrow(
      InvalidStageTransitionError,
    );
  });

  it("isTerminalStage correctly identifies 'completed' as the only terminal stage", () => {
    expect(isTerminalStage("completed")).toBe(true);
    expect(isTerminalStage("recovery_pending")).toBe(false);
    expect(isTerminalStage("decision_made")).toBe(false);
    expect(isTerminalStage("policy_evaluated")).toBe(false);
    expect(isTerminalStage("action_executed")).toBe(false);
    expect(isTerminalStage("outcome_evaluated")).toBe(false);
  });
});
