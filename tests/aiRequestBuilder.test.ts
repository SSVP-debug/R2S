import { describe, it, expect } from "vitest";
import { buildAgentDecisionRequest } from "../src/ai/requestBuilder.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import type { AgentPaymentContext } from "../src/domain/schemas.js";
import type { RecoveryAssessment } from "../src/assessment/schemas.js";

function makeContext(overrides: Partial<AgentPaymentContext> = {}): AgentPaymentContext {
  return {
    paymentId: "pay_1",
    amount: 100000,
    currency: "INR",
    status: "failed",
    failureCategory: "insufficient_funds",
    attemptCount: 0,
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
    merchant: { id: "mch_1", category: "ecommerce" },
    customer: { id: "cus_1", riskProfile: "medium" },
    recoveryCase: {
      id: "case_1",
      status: "open",
      openedAt: new Date("2026-08-31T00:00:00.000Z"),
      recoveryWindowEndsAt: new Date("2026-09-07T00:00:00.000Z"),
    },
    priorAttempts: [],
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<RecoveryAssessment> = {}): RecoveryAssessment {
  return {
    paymentId: "pay_1",
    assessedAt: new Date("2026-08-31T00:00:00.000Z"),
    engineVersion: "1.0.0",
    score: 0.4,
    scoreBand: "medium",
    features: {
      paymentId: "pay_1",
      failureCategory: "insufficient_funds",
      riskProfile: "medium",
      merchantCategory: "ecommerce",
      hasOpenCase: true,
      recoveryCaseStatus: "open",
      attemptsMade: 1,
      priorFailureCount: 1,
      priorSuccessCount: 0,
      priorBlockedCount: 0,
      windowRemainingHours: 100,
      hoursSinceCaseOpened: 24,
    },
    candidateActions: [
      { action: "retry_delayed", rationale: "insufficient funds; wait", priority: 1 },
      { action: "no_action", rationale: "fallback", priority: 2 },
    ],
    ...overrides,
  };
}

describe("AI: request builder", () => {
  it("builds a valid AgentDecisionRequest from context + assessment + merchant policy", () => {
    const request = buildAgentDecisionRequest({
      context: makeContext(),
      assessment: makeAssessment(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    expect(request.paymentId).toBe("pay_1");
    expect(request.assessmentSummary).toEqual({ score: 0.4, scoreBand: "medium" });
    expect(request.merchantPolicy).toEqual(DEFAULT_MERCHANT_POLICY);
  });

  it("translates candidateActions through the BestAction -> RecoveryAction bridge", () => {
    const request = buildAgentDecisionRequest({
      context: makeContext(),
      assessment: makeAssessment(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    const actions = request.candidateActions.map((c) => c.action);
    expect(actions).toContain("RETRY_LATER");
    expect(actions).toContain("STOP");
  });

  it("carries recoveryHistory forward from the assessment's features", () => {
    const request = buildAgentDecisionRequest({
      context: makeContext(),
      assessment: makeAssessment(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
    });
    expect(request.recoveryHistory).toEqual({
      attemptsMade: 1,
      priorFailureCount: 1,
      priorSuccessCount: 0,
      priorBlockedCount: 0,
    });
  });

  it("throws if context.paymentId and assessment.paymentId do not match", () => {
    expect(() =>
      buildAgentDecisionRequest({
        context: makeContext({ paymentId: "pay_1" }),
        assessment: makeAssessment({ paymentId: "pay_DIFFERENT" }),
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
      }),
    ).toThrow();
  });

  it("is deterministic: same inputs always produce the same request", () => {
    const context = makeContext();
    const assessment = makeAssessment();
    const a = buildAgentDecisionRequest({ context, assessment, merchantPolicy: DEFAULT_MERCHANT_POLICY });
    const b = buildAgentDecisionRequest({ context, assessment, merchantPolicy: DEFAULT_MERCHANT_POLICY });
    expect(a).toEqual(b);
  });
});
