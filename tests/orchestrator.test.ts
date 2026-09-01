import { describe, it, expect, afterEach } from "vitest";
import { runRecoveryOrchestration } from "../src/orchestration/recoveryOrchestrator.js";
import { RecoveryExecutor } from "../src/execution/recoveryExecutor.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { evaluatePolicy } from "../src/policy/policyEngine.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { createRng } from "../src/simulation/rng.js";
import { IdSequence } from "../src/simulation/ids.js";
import { recoveryRunResultSchema } from "../src/orchestration/schemas.js";
import type { AIProvider } from "../src/ai/provider.js";
import type { AgentDecision } from "../src/ai/types.js";
import {
  newFixtureRepo,
  insertFailedPaymentFixture,
} from "./helpers/orchestrationFixtures.js";
import type { SqliteRepository } from "../src/db/repository.js";

class FixedProvider implements AIProvider {
  constructor(private decision: AgentDecision) {}
  async generateDecision(): Promise<AgentDecision> {
    return this.decision;
  }
}

class ThrowingProvider implements AIProvider {
  async generateDecision(): Promise<AgentDecision> {
    throw new Error("orchestrator-level simulated provider outage");
  }
}

let openRepos: SqliteRepository[] = [];
function trackedRepo(): SqliteRepository {
  const repo = newFixtureRepo();
  openRepos.push(repo);
  return repo;
}
afterEach(() => {
  for (const r of openRepos) r.close();
  openRepos = [];
});

function evaluatePolicyForIncentive(recommendation: AgentDecision) {
  return evaluatePolicy({
    paymentAmount: 10000, // below high-value threshold, isolates the ceiling rule
    retryCount: 0,
    windowRemainingHours: 100,
    priorFailureCount: 0,
    recommendation,
    merchantPolicy: DEFAULT_MERCHANT_POLICY, // maxIncentivePercent: 15
  });
}

describe("orchestrator: decision provenance (item 6)", () => {
  it("labels a single-candidate resolution as BASELINE (no AI call made)", async () => {
    const repo = trackedRepo();
    // A failed payment whose recovery window has already expired ->
    // Day 2's assessment yields a single STOP candidate (score 0, no
    // viable action) -> the cost-control gate in
    // src/ai/decisionAgent.ts resolves this deterministically without
    // calling the provider.
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_baseline",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
      caseOpenedAt: new Date("2026-08-01T00:00:00.000Z"),
      recoveryWindowDays: 1, // window ends 2026-08-02 — long past by "now" below
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_baseline",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("prov-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.decisionSource).toBe("BASELINE");
  });

  it("labels a genuine mock-provider decision as AI", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_ai",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_ai",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("prov-test-2"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.decisionSource).toBe("AI");
  });

  it("labels a provider failure as FALLBACK", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_fallback",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new ThrowingProvider(),
      paymentId: "pay_fallback",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("prov-test-3"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.decisionSource).toBe("FALLBACK");
  });
});

describe("orchestrator: SAFETY INVARIANT — BLOCK means zero execution (item 8, part 1)", () => {
  it("AI recommends RETRY_NOW + Policy BLOCK (retry limit reached) => executor execution count is ZERO", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_block",
      failureCategory: "temporary_bank_failure", // always offers retry_immediate -> RETRY_NOW
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
      priorAttempts: DEFAULT_MERCHANT_POLICY.maxRetries,
      priorAttemptOutcome: "failure",
    });

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.9,
      reasoning: "Temporary bank failure looks recoverable.",
    });

    const executor = new RecoveryExecutor();
    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_block",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("block-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
      executor,
    });

    expect(result.aiDecision.action).toBe("RETRY_NOW");
    expect(result.policyResult.decision).toBe("BLOCK");
    expect(result.execution).toBeNull();
    expect(executor.executedCount()).toBe(0);
  });
});

describe("orchestrator: SAFETY INVARIANT — MODIFY reaches executor only in modified form (item 8, part 2)", () => {
  it("AI recommends RETRY_NOW after repeated failures + Policy MODIFIES to RETRY_LATER => executor receives RETRY_LATER, never RETRY_NOW", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_modify",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
      priorAttempts: 2, // meets the repeated-failure threshold, below maxRetries
      priorAttemptOutcome: "failure",
    });

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.95,
      reasoning: "Still looks worth an immediate retry.",
    });

    const executor = new RecoveryExecutor();
    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_modify",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("modify-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
      executor,
    });

    expect(result.aiDecision.action).toBe("RETRY_NOW");
    expect(result.policyResult.decision).toBe("MODIFY");
    expect(result.policyResult.modifiedDecision?.action).toBe("RETRY_LATER");

    // The executor must have received the MODIFIED action, never the
    // AI's original RETRY_NOW.
    expect(result.execution).not.toBeNull();
    expect(result.execution?.action).toBe("RETRY_LATER");
    expect(result.execution?.action).not.toBe("RETRY_NOW");
  });

  it("(incentive-ceiling variant, tested at the policy+executor composition level): a MODIFY-capped incentive reaches the executor only at the capped value, never the original", () => {
    // OFFER_INCENTIVE is not reachable through the legitimate Day-2
    // candidate-translation path after the Aug 31 sign-off correction
    // (see src/ai/candidateTranslation.ts header) — so this specific
    // scenario cannot be driven through the full orchestrator via a real
    // assessment the way the RETRY_NOW/RETRY_LATER case above can. It is
    // tested here at the same policy+executor composition level Aug 31's
    // own aiPolicyIntegration.test.ts already established as correct for
    // this exact scenario, directly exercising the orchestrator's MODIFY
    // handling logic ("if MODIFY, execute modifiedDecision, never the
    // original recommendation").
    const recommendation: AgentDecision = {
      action: "OFFER_INCENTIVE",
      confidence: 0.9,
      reasoning: "Requesting a 20% incentive.",
      incentivePercent: 20,
    };

    const policyResult = evaluatePolicyForIncentive(recommendation);
    expect(policyResult.decision).toBe("MODIFY");
    expect(policyResult.modifiedDecision?.incentivePercent).toBe(15);

    // Exactly what the orchestrator does: use modifiedDecision when MODIFY.
    const approvedDecision =
      policyResult.decision === "MODIFY" && policyResult.modifiedDecision
        ? policyResult.modifiedDecision
        : recommendation;

    const executor = new RecoveryExecutor();
    const execution = executor.execute({
      idempotencyKey: "pay_incentive:case_incentive:1",
      paymentId: "pay_incentive",
      recoveryCaseId: "case_incentive",
      attemptNumber: 1,
      action: approvedDecision.action,
      incentivePercent: approvedDecision.incentivePercent,
      requestedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(execution.status).toBe("executed");
    expect(approvedDecision.incentivePercent).toBe(15);
    expect(approvedDecision.incentivePercent).not.toBe(20);
  });
});

describe("orchestrator: policy integration (item 7) — ALLOW/MODIFY/BLOCK/ESCALATE/STOP", () => {
  it("ALLOW: the approved action is executed", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_allow",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 1.0,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.9,
      reasoning: "Fresh temporary failure.",
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_allow",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("orch-success-1"), // deterministically yields success
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.policyResult.decision).toBe("ALLOW");
    expect(result.execution?.status).toBe("executed");
    expect(result.execution?.action).toBe("RETRY_NOW");
  });

  it("ESCALATE (AI/baseline-recommended, policy ALLOWs it): no payment recovery is executed; escalation is recorded", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_escalate",
      failureCategory: "repeated_failure", // Day 2 always offers escalate_to_human here
      groundTruth: {
        recoverable: false,
        recoveryProbability: 0.1,
        bestAction: "no_action",
        recoveredAmount: 0,
      },
    });

    const executor = new RecoveryExecutor();
    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_escalate",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("escalate-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
      executor,
    });

    expect(result.aiDecision.action).toBe("ESCALATE");
    expect(result.policyResult.decision).toBe("ALLOW"); // policy doesn't object to ESCALATE
    expect(result.execution?.status).toBe("skipped"); // never a real recovery attempt
    expect(executor.executedCount()).toBe(0);
    expect(result.outcome).toBeNull(); // no outcome simulation for a skipped action
    expect(result.finalState.paymentStatus).toBe("escalated");
    expect(result.events.some((e) => e.eventType === "escalation")).toBe(true);
    // Issue 2: ESCALATE must never produce an action_executed event.
    expect(result.events.some((e) => e.eventType === "action_executed")).toBe(false);
  });

  it("STOP: no recovery action is executed; payment/case transition to stopped", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_stop",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const provider = new FixedProvider({
      action: "STOP",
      confidence: 0.5,
      reasoning: "Deliberately stopping for this test.",
    });

    const executor = new RecoveryExecutor();
    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_stop",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("stop-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
      executor,
    });

    expect(result.policyResult.decision).toBe("ALLOW"); // STOP is never blocked
    expect(result.execution?.status).toBe("skipped");
    expect(executor.executedCount()).toBe(0);
    expect(result.outcome).toBeNull();
    expect(result.finalState.paymentStatus).toBe("stopped");
    expect(result.finalState.recoveryCaseStatus).toBe("stopped");
    expect(result.events.some((e) => e.eventType === "stopped")).toBe(true);
    // Issue 2: STOP must never produce an action_executed event.
    expect(result.events.some((e) => e.eventType === "action_executed")).toBe(false);
  });
});

describe("Sep 1 correction — Issue 2: action_executed is emitted only for genuinely executed actions", () => {
  it("(5) STOP produces no action_executed event", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_issue2_stop",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new FixedProvider({ action: "STOP", confidence: 0.5, reasoning: "x" }),
      paymentId: "pay_issue2_stop",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("issue2-stop-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.execution?.status).toBe("skipped");
    expect(result.events.some((e) => e.eventType === "action_executed")).toBe(false);
    // A "stopped" event may still be emitted.
    expect(result.events.some((e) => e.eventType === "stopped")).toBe(true);
  });

  it("(6) ESCALATE produces no action_executed event", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_issue2_escalate",
      failureCategory: "repeated_failure",
      groundTruth: {
        recoverable: false,
        recoveryProbability: 0.1,
        bestAction: "no_action",
        recoveredAmount: 0,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_issue2_escalate",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("issue2-escalate-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.aiDecision.action).toBe("ESCALATE");
    expect(result.execution?.status).toBe("skipped");
    expect(result.events.some((e) => e.eventType === "action_executed")).toBe(false);
    // An "escalation" event may still be emitted.
    expect(result.events.some((e) => e.eventType === "escalation")).toBe(true);
  });

  it("(7) ALLOW + a genuine recovery action DOES produce action_executed", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_issue2_allow",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new FixedProvider({ action: "RETRY_NOW", confidence: 0.9, reasoning: "x" }),
      paymentId: "pay_issue2_allow",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("issue2-allow-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.execution?.status).toBe("executed");
    expect(result.events.some((e) => e.eventType === "action_executed")).toBe(true);
  });

  it("a rejected action (defensive/unreachable in normal flow) also never produces action_executed", async () => {
    // Directly exercises the executor's "rejected" path to prove the
    // orchestrator's action_executed gating covers all three
    // ExecutionStatus values, not just "skipped".
    const executor = new RecoveryExecutor();
    const rejected = executor.execute({
      idempotencyKey: "k1",
      paymentId: "pay_x",
      recoveryCaseId: "case_x",
      attemptNumber: 1,
      action: "NOT_A_REAL_ACTION" as never,
      requestedAt: new Date(),
    });
    expect(rejected.status).toBe("rejected");
    // The orchestrator's own gating (execution.status === "executed") is
    // exercised end-to-end by the ALLOW/STOP/ESCALATE tests above; this
    // confirms the executor never mislabels a rejected action as
    // "executed", which is the precondition the orchestrator's gate
    // relies on.
  });
});

describe("orchestrator: outcome separation (item 3) — ACTION EXECUTED ≠ PAYMENT RECOVERED", () => {
  it("a genuinely executed action can still fail to recover the payment (non-recoverable ground truth)", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_exec_fail",
      failureCategory: "invalid_instrument", // deterministically non-recoverable by construction
      groundTruth: {
        recoverable: false,
        recoveryProbability: 0.1,
        bestAction: "no_action",
        recoveredAmount: 0,
      },
    });

    const provider = new FixedProvider({
      action: "SEND_PAYMENT_LINK",
      confidence: 0.6,
      reasoning: "Prompting the customer to update their instrument.",
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_exec_fail",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("exec-fail-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    // The action WAS executed...
    expect(result.execution?.status).toBe("executed");
    // ...but the payment was NOT recovered — these are separate facts.
    expect(result.outcome).not.toBeNull();
    expect(result.outcome?.success).toBe(false);
    expect(result.finalState.paymentStatus).not.toBe("recovered");
  });

  it("a genuinely executed action that DOES recover the payment reflects both facts correctly", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_exec_success",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 1.0,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.9,
      reasoning: "Fresh temporary failure.",
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_exec_success",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("orch-success-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.execution?.status).toBe("executed");
    expect(result.outcome?.success).toBe(true);
    expect(result.finalState.paymentStatus).toBe("recovered");
  });
});

describe("orchestrator: candidate constraint is preserved end-to-end (item 4 follow-through)", () => {
  it("if the provider returns an action not present in candidateActions, the invalid action is never passed to policy or executed", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_bad_candidate",
      failureCategory: "temporary_bank_failure", // candidates: RETRY_NOW, STOP only
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const provider = new FixedProvider({
      action: "ESCALATE", // not offered for a fresh temporary_bank_failure case
      confidence: 0.9,
      reasoning: "Trying to escalate anyway.",
    });

    const executor = new RecoveryExecutor();
    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_bad_candidate",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("bad-candidate-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
      executor,
    });

    expect(result.decisionSource).toBe("FALLBACK");
    expect(result.aiDecision.action).not.toBe("ESCALATE");
  });
});

describe("orchestrator: idempotency at the orchestration level (item 4 follow-through)", () => {
  it("two duplicate deliveries of the same orchestration request (identical starting state) execute the recovery action only once", async () => {
    // Models genuine "at-least-once delivery": the same logical request
    // (same payment, same starting state — e.g. a caller retried after a
    // timeout without knowing the first attempt actually succeeded)
    // arrives twice. Both computations start from IDENTICAL fixture state
    // (two separately-seeded repos, not one repo mutated by the first
    // call) and so both independently compute the SAME idempotency key —
    // exactly the scenario idempotency protection exists for. The
    // executor (shared across both "deliveries", as a real deployment
    // would share one execution-tracking store) must execute only once.
    const repoA = trackedRepo();
    const repoB = trackedRepo();
    for (const repo of [repoA, repoB]) {
      insertFailedPaymentFixture(repo, {
        paymentId: "pay_dup_delivery",
        failureCategory: "temporary_bank_failure",
        groundTruth: {
          recoverable: true,
          recoveryProbability: 0.9,
          bestAction: "retry_immediate",
          recoveredAmount: 100000,
        },
      });
    }

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.9,
      reasoning: "Fresh temporary failure.",
    });
    const executor = new RecoveryExecutor();
    const ids = new IdSequence();
    const now = new Date("2026-09-01T00:00:00.000Z");

    const first = await runRecoveryOrchestration({
      repo: repoA,
      provider,
      paymentId: "pay_dup_delivery",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("dup-delivery-1"),
      now,
      executor,
      ids,
    });

    const second = await runRecoveryOrchestration({
      repo: repoB,
      provider,
      paymentId: "pay_dup_delivery",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("dup-delivery-1"),
      now,
      executor,
      ids,
    });

    expect(first.execution?.idempotencyKey).toBe(second.execution?.idempotencyKey);
    expect(first.execution?.idempotent).toBe(false);
    expect(second.execution?.idempotent).toBe(true);
    expect(executor.executedCount()).toBe(1);
  });

  it("an idempotent replay (genuine duplicate delivery) returns the existing execution result and does not re-run outcome simulation or persist a second attempt", async () => {
    const repoA = trackedRepo();
    const repoB = trackedRepo();
    for (const repo of [repoA, repoB]) {
      insertFailedPaymentFixture(repo, {
        paymentId: "pay_idempotent_2",
        failureCategory: "temporary_bank_failure",
        groundTruth: {
          recoverable: true,
          recoveryProbability: 0.9,
          bestAction: "retry_immediate",
          recoveredAmount: 100000,
        },
      });
    }

    const provider = new FixedProvider({
      action: "RETRY_NOW",
      confidence: 0.9,
      reasoning: "Fresh temporary failure.",
    });
    const executor = new RecoveryExecutor();
    const ids = new IdSequence();
    const now = new Date("2026-09-01T00:00:00.000Z");

    const first = await runRecoveryOrchestration({
      repo: repoA,
      provider,
      paymentId: "pay_idempotent_2",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("orch-success-1"),
      now,
      executor,
      ids,
    });
    // First delivery genuinely computed an outcome (real execution).
    expect(first.outcome).not.toBeNull();
    expect(first.execution?.idempotent).toBe(false);

    // Second, DUPLICATE delivery of the exact same logical request
    // (identical starting state, via a separately-seeded but identical
    // repo — modelling e.g. a caller retrying after a timeout without
    // knowing the first delivery already succeeded).
    const second = await runRecoveryOrchestration({
      repo: repoB,
      provider,
      paymentId: "pay_idempotent_2",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("orch-success-1"),
      now,
      executor,
      ids,
    });

    // Replay: idempotent, returns the SAME execution result, but does not
    // re-derive a fresh outcome (see recoveryOrchestrator.ts's idempotent
    // early-return).
    expect(second.execution?.idempotencyKey).toBe(first.execution?.idempotencyKey);
    expect(second.execution?.idempotent).toBe(true);
    expect(second.execution).toEqual({ ...first.execution, idempotent: true });
    expect(second.outcome).toBeNull();

    // repoB's Payment row was NOT updated by the duplicate delivery — it
    // still reflects only whatever repoB's own pipeline did up to (and
    // excluding) the idempotent short-circuit. Since the idempotent
    // early-return happens before any repo.updatePayment/insertRecoveryAttempt
    // call, repoB's payment row remains at its pre-execution attemptCount.
    const repoBPayment = repoB
      .listPaymentsBySimulationRun("run_orchestration_fixture")
      .find((p) => p.id === "pay_idempotent_2");
    expect(repoBPayment?.attemptCount).toBe(0);
  });
});

describe("orchestrator: audit events (item 13)", () => {
  it("records events for the AI/policy decision at minimum", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_audit",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_audit",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("audit-test-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(
      result.events.filter((e) => e.eventType === "recovery_decision").length,
    ).toBeGreaterThanOrEqual(2); // AI + policy
  });

  it("BLOCK produces an 'action_blocked' event", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_audit_block",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
      priorAttempts: DEFAULT_MERCHANT_POLICY.maxRetries,
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new FixedProvider({ action: "RETRY_NOW", confidence: 0.9, reasoning: "x" }),
      paymentId: "pay_audit_block",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("audit-block-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.events.some((e) => e.eventType === "action_blocked")).toBe(true);
  });

  it("no audit event payload contains a ground-truth field name", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_audit_gt",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new MockAIProvider(),
      paymentId: "pay_audit_gt",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("audit-gt-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    for (const event of result.events) {
      const keys = Object.keys(event.payload);
      for (const forbidden of ["recoverable", "recoveryProbability", "bestAction", "recoveredAmount"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("orchestrator: complete recovery run result is schema-valid (item 11)", () => {
  it("validates the ALLOW+executed+recovered run against recoveryRunResultSchema", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_schema_allow",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 1.0,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new FixedProvider({ action: "RETRY_NOW", confidence: 0.9, reasoning: "x" }),
      paymentId: "pay_schema_allow",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("orch-success-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(() => recoveryRunResultSchema.parse(result)).not.toThrow();
    expect(result.stage).toBe("completed");
  });

  it("validates a BLOCK run against recoveryRunResultSchema", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_schema_block",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
      priorAttempts: DEFAULT_MERCHANT_POLICY.maxRetries,
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider: new FixedProvider({ action: "RETRY_NOW", confidence: 0.9, reasoning: "x" }),
      paymentId: "pay_schema_block",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("schema-block-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(() => recoveryRunResultSchema.parse(result)).not.toThrow();
    expect(result.execution).toBeNull();
    expect(result.outcome).toBeNull();
  });
});
