import { describe, it, expect } from "vitest";
import { SqliteRepository } from "../src/db/repository.js";
import { runSimulation } from "../src/simulation/runSimulation.js";
import { buildAssessmentContext } from "../src/assessment/contextBuilder.js";
import { assessFromContext } from "../src/assessment/assessment.js";
import { buildAgentDecisionRequest } from "../src/ai/requestBuilder.js";
import { resolveRecoveryDecision } from "../src/ai/decisionAgent.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { evaluatePolicy } from "../src/policy/policyEngine.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import {
  buildAiDecisionAuditEvent,
  buildPolicyDecisionAuditEvent,
} from "../src/policy/auditIntegration.js";
import { IdSequence } from "../src/simulation/ids.js";
import { auditEventSchema } from "../src/domain/schemas.js";

describe("AI + policy: full pipeline integration", () => {
  it("runs context -> assessment -> AI decision -> policy for every failed payment in a generated dataset without throwing", async () => {
    const repo = new SqliteRepository(":memory:");
    try {
      const summary = runSimulation({ seed: "ai-policy-integration-1", repo });
      const payments = repo.listPaymentsBySimulationRun(summary.simulationRunId);
      const failedPayments = payments.filter((p) => p.status !== "created");
      expect(failedPayments.length).toBeGreaterThan(0);

      const provider = new MockAIProvider();
      const now = new Date("2026-09-01T00:00:00.000Z");

      for (const payment of failedPayments) {
        const context = buildAssessmentContext(repo, payment.id);
        const assessment = assessFromContext(context, now);
        const request = buildAgentDecisionRequest({
          context,
          assessment,
          merchantPolicy: DEFAULT_MERCHANT_POLICY,
        });

        const aiResult = await resolveRecoveryDecision(provider, request);
        expect(["provider", "fallback", "deterministic"]).toContain(aiResult.source);

        const policyResult = evaluatePolicy({
          paymentAmount: payment.amount,
          retryCount: assessment.features.attemptsMade,
          windowRemainingHours: assessment.features.windowRemainingHours,
          priorFailureCount: assessment.features.priorFailureCount,
          recommendation: aiResult.decision,
          merchantPolicy: DEFAULT_MERCHANT_POLICY,
        });

        expect(["ALLOW", "MODIFY", "BLOCK", "ESCALATE"]).toContain(policyResult.decision);
      }
    } finally {
      repo.close();
    }
  });

  it("the AI genuinely recommends OFFER_INCENTIVE (verified before policy), and policy BLOCKs a severely excessive request (>2x ceiling)", async () => {
    // Construct the request with an EXPLICIT OFFER_INCENTIVE candidate —
    // not relying on translation from an unrelated Day-2 candidate — so
    // this test genuinely exercises the OFFER_INCENTIVE path end to end.
    const request = makeOfferIncentiveCandidateRequest({ maxIncentivePercent: 15 });

    const highConfidenceIncentiveProvider = {
      async generateDecision() {
        return {
          action: "OFFER_INCENTIVE" as const,
          confidence: 0.99,
          reasoning: "Extremely confident this incentive will work.",
          incentivePercent: 50,
        };
      },
    };

    const aiResult = await resolveRecoveryDecision(highConfidenceIncentiveProvider, request);

    // Verify the AI's decision is genuinely OFFER_INCENTIVE (not a
    // fallback, not silently rejected) BEFORE handing it to policy.
    expect(aiResult.source).toBe("provider");
    expect(aiResult.decision.action).toBe("OFFER_INCENTIVE");
    expect(aiResult.decision.incentivePercent).toBe(50);

    // 50% requested vs 15% ceiling -> more than double -> policy BLOCKs outright.
    const policyResult = evaluatePolicy({
      paymentAmount: 10000,
      retryCount: 0,
      windowRemainingHours: 100,
      priorFailureCount: 0,
      recommendation: aiResult.decision,
      merchantPolicy: request.merchantPolicy,
    });

    expect(policyResult.decision).toBe("BLOCK");
    expect(policyResult.appliedRules).toContain("incentive_ceiling_exceeded_severely");
  });

  it("policy MODIFIES (caps) a moderately excessive OFFER_INCENTIVE request instead of blocking it", async () => {
    const request = makeOfferIncentiveCandidateRequest({ maxIncentivePercent: 15 });

    const moderateIncentiveProvider = {
      async generateDecision() {
        return {
          action: "OFFER_INCENTIVE" as const,
          confidence: 0.8,
          reasoning: "Requesting a moderate incentive.",
          incentivePercent: 20,
        };
      },
    };

    const aiResult = await resolveRecoveryDecision(moderateIncentiveProvider, request);

    expect(aiResult.source).toBe("provider");
    expect(aiResult.decision.action).toBe("OFFER_INCENTIVE");
    expect(aiResult.decision.incentivePercent).toBe(20);

    const policyResult = evaluatePolicy({
      paymentAmount: 10000,
      retryCount: 0,
      windowRemainingHours: 100,
      priorFailureCount: 0,
      recommendation: aiResult.decision,
      merchantPolicy: request.merchantPolicy,
    });

    expect(policyResult.decision).toBe("MODIFY");
    expect(policyResult.modifiedDecision?.incentivePercent).toBe(15);
    expect(policyResult.appliedRules).toContain("incentive_ceiling_exceeded");
  });
});

describe("AI + policy: audit event integration", () => {
  it("buildAiDecisionAuditEvent produces a valid AuditEvent using the existing Day-1 event model", async () => {
    const ids = new IdSequence();
    const provider = new MockAIProvider();
    const request = minimalRequest();
    const result = await resolveRecoveryDecision(provider, request);

    const event = buildAiDecisionAuditEvent(ids, {
      paymentId: request.paymentId,
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      result,
    });

    expect(() => auditEventSchema.parse(event)).not.toThrow();
    expect(event.eventType).toBe("recovery_decision");
  });

  it("buildPolicyDecisionAuditEvent maps BLOCK to the existing 'action_blocked' event type", () => {
    const ids = new IdSequence();
    const policyResult = evaluatePolicy({
      paymentAmount: 10000,
      retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
      windowRemainingHours: 100,
      priorFailureCount: 0,
      recommendation: { action: "RETRY_NOW", confidence: 0.5, reasoning: "x" },
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    expect(policyResult.decision).toBe("BLOCK");

    const event = buildPolicyDecisionAuditEvent(ids, {
      paymentId: "pay_1",
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      policyResult,
    });

    expect(() => auditEventSchema.parse(event)).not.toThrow();
    expect(event.eventType).toBe("action_blocked");
  });

  it("buildPolicyDecisionAuditEvent maps ESCALATE to the existing 'escalation' event type", () => {
    const ids = new IdSequence();
    const policyResult = evaluatePolicy({
      paymentAmount: DEFAULT_MERCHANT_POLICY.highValueThresholdMinor,
      retryCount: 0,
      windowRemainingHours: 100,
      priorFailureCount: 0,
      recommendation: { action: "OFFER_INCENTIVE", confidence: 0.5, reasoning: "x", incentivePercent: 5 },
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    expect(policyResult.decision).toBe("ESCALATE");

    const event = buildPolicyDecisionAuditEvent(ids, {
      paymentId: "pay_1",
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      policyResult,
    });

    expect(event.eventType).toBe("escalation");
  });

  it("buildPolicyDecisionAuditEvent maps ALLOW and MODIFY to the existing 'recovery_decision' event type", () => {
    const ids = new IdSequence();

    const allowResult = evaluatePolicy({
      paymentAmount: 10000,
      retryCount: 0,
      windowRemainingHours: 100,
      priorFailureCount: 0,
      recommendation: { action: "RETRY_NOW", confidence: 0.5, reasoning: "x" },
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    const allowEvent = buildPolicyDecisionAuditEvent(ids, {
      paymentId: "pay_1",
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date(),
      policyResult: allowResult,
    });
    expect(allowEvent.eventType).toBe("recovery_decision");

    const modifyResult = evaluatePolicy({
      paymentAmount: 10000,
      retryCount: 0,
      windowRemainingHours: 100,
      priorFailureCount: 2,
      recommendation: { action: "RETRY_NOW", confidence: 0.5, reasoning: "x" },
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    expect(modifyResult.decision).toBe("MODIFY");
    const modifyEvent = buildPolicyDecisionAuditEvent(ids, {
      paymentId: "pay_1",
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date(),
      policyResult: modifyResult,
    });
    expect(modifyEvent.eventType).toBe("recovery_decision");
  });

  it("no audit event payload from AI/policy integration ever contains a ground-truth field name", async () => {
    const ids = new IdSequence();
    const provider = new MockAIProvider();
    const request = minimalRequest();
    const result = await resolveRecoveryDecision(provider, request);
    const aiEvent = buildAiDecisionAuditEvent(ids, {
      paymentId: request.paymentId,
      recoveryCaseId: "case_1",
      simulationRunId: "run_test",
      occurredAt: new Date(),
      result,
    });

    const payloadKeys = Object.keys(aiEvent.payload);
    for (const forbidden of ["recoverable", "recoveryProbability", "bestAction", "recoveredAmount"]) {
      expect(payloadKeys).not.toContain(forbidden);
    }
  });
});

function makeOfferIncentiveCandidateRequest(opts: { maxIncentivePercent: number }) {
  const merchantPolicy = { ...DEFAULT_MERCHANT_POLICY, maxIncentivePercent: opts.maxIncentivePercent };
  return {
    paymentId: "pay_1",
    context: {
      paymentId: "pay_1",
      amount: 10000,
      currency: "INR" as const,
      status: "failed" as const,
      failureCategory: "insufficient_funds" as const,
      attemptCount: 0,
      createdAt: new Date("2026-08-31T00:00:00.000Z"),
      updatedAt: new Date("2026-08-31T00:00:00.000Z"),
      merchant: { id: "mch_1", category: "ecommerce" as const },
      customer: { id: "cus_1", riskProfile: "medium" as const },
      recoveryCase: {
        id: "case_1",
        status: "open" as const,
        openedAt: new Date("2026-08-31T00:00:00.000Z"),
        recoveryWindowEndsAt: new Date("2026-09-07T00:00:00.000Z"),
      },
      priorAttempts: [],
    },
    assessmentSummary: { score: 0.5, scoreBand: "medium" as const },
    // Explicit OFFER_INCENTIVE candidate — this is what makes the test
    // genuinely exercise the OFFER_INCENTIVE path, rather than relying on
    // candidate translation to (incorrectly) manufacture it from an
    // unrelated Day-2 category. A second candidate (STOP) is included so
    // the request is genuinely ambiguous (candidateActions.length > 1) and
    // resolveRecoveryDecision's cost-control gate actually calls the
    // provider instead of short-circuiting to a deterministic single-
    // candidate resolution.
    candidateActions: [
      { action: "OFFER_INCENTIVE" as const, rationale: "insufficient funds; a small incentive may help", priority: 1 },
      { action: "STOP" as const, rationale: "fallback if incentive is not viable", priority: 2 },
    ],
    merchantPolicy,
    recoveryHistory: {
      attemptsMade: 0,
      priorFailureCount: 0,
      priorSuccessCount: 0,
      priorBlockedCount: 0,
    },
  };
}

function minimalRequest() {
  return {
    paymentId: "pay_1",
    context: {
      paymentId: "pay_1",
      amount: 100000,
      currency: "INR" as const,
      status: "failed" as const,
      failureCategory: "temporary_bank_failure" as const,
      attemptCount: 0,
      createdAt: new Date("2026-08-31T00:00:00.000Z"),
      updatedAt: new Date("2026-08-31T00:00:00.000Z"),
      merchant: { id: "mch_1", category: "ecommerce" as const },
      customer: { id: "cus_1", riskProfile: "medium" as const },
      recoveryCase: {
        id: "case_1",
        status: "open" as const,
        openedAt: new Date("2026-08-31T00:00:00.000Z"),
        recoveryWindowEndsAt: new Date("2026-09-07T00:00:00.000Z"),
      },
      priorAttempts: [],
    },
    assessmentSummary: { score: 0.65, scoreBand: "high" as const },
    candidateActions: [
      { action: "RETRY_NOW" as const, rationale: "fresh temporary failure", priority: 1 },
      { action: "STOP" as const, rationale: "fallback", priority: 2 },
    ],
    merchantPolicy: DEFAULT_MERCHANT_POLICY,
    recoveryHistory: {
      attemptsMade: 0,
      priorFailureCount: 0,
      priorSuccessCount: 0,
      priorBlockedCount: 0,
    },
  };
}
