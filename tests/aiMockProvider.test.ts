import { describe, it, expect } from "vitest";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { agentDecisionSchema } from "../src/ai/schemas.js";
import type { AgentDecisionRequest } from "../src/ai/types.js";

function makeRequest(overrides: Partial<AgentDecisionRequest> = {}): AgentDecisionRequest {
  return {
    paymentId: "pay_1",
    context: {
      paymentId: "pay_1",
      amount: 100000,
      currency: "INR",
      status: "failed",
      failureCategory: "temporary_bank_failure",
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
    },
    assessmentSummary: { score: 0.65, scoreBand: "high" },
    candidateActions: [
      { action: "RETRY_NOW", rationale: "fresh temporary failure", priority: 1 },
      { action: "STOP", rationale: "fallback", priority: 2 },
    ],
    merchantPolicy: {
      maxRetries: 3,
      recoveryWindowDays: 7,
      maxIncentivePercent: 15,
      highValueThresholdMinor: 500000,
    },
    recoveryHistory: {
      attemptsMade: 0,
      priorFailureCount: 0,
      priorSuccessCount: 0,
      priorBlockedCount: 0,
    },
    ...overrides,
  };
}

describe("AI: MockAIProvider", () => {
  it("always returns output that passes agentDecisionSchema", async () => {
    const provider = new MockAIProvider();
    const decision = await provider.generateDecision(makeRequest());
    expect(() => agentDecisionSchema.parse(decision)).not.toThrow();
  });

  it("selects the highest-priority (priority=1) candidate action", async () => {
    const provider = new MockAIProvider();
    const decision = await provider.generateDecision(makeRequest());
    expect(decision.action).toBe("RETRY_NOW");
  });

  it("is deterministic: same request always produces the same decision", async () => {
    const provider = new MockAIProvider();
    const request = makeRequest();
    const a = await provider.generateDecision(request);
    const b = await provider.generateDecision(request);
    expect(a).toEqual(b);
  });

  it("includes delayHours when the selected action is RETRY_LATER", async () => {
    const provider = new MockAIProvider();
    const request = makeRequest({
      candidateActions: [{ action: "RETRY_LATER", rationale: "wait", priority: 1 }],
    });
    const decision = await provider.generateDecision(request);
    expect(decision.action).toBe("RETRY_LATER");
    expect(decision.delayHours).toBeDefined();
    expect(decision.delayHours).toBeGreaterThan(0);
  });

  it("includes incentivePercent (capped to merchant policy) when the selected action is OFFER_INCENTIVE", async () => {
    const provider = new MockAIProvider();
    const request = makeRequest({
      candidateActions: [{ action: "OFFER_INCENTIVE", rationale: "nudge", priority: 1 }],
      merchantPolicy: {
        maxRetries: 3,
        recoveryWindowDays: 7,
        maxIncentivePercent: 5, // lower than the mock's own default of 10
        highValueThresholdMinor: 500000,
      },
    });
    const decision = await provider.generateDecision(request);
    expect(decision.action).toBe("OFFER_INCENTIVE");
    expect(decision.incentivePercent).toBeLessThanOrEqual(5);
  });

  it("confidence is derived from the assessment score and stays within [0, 1]", async () => {
    const provider = new MockAIProvider();
    const decision = await provider.generateDecision(
      makeRequest({ assessmentSummary: { score: 0.42, scoreBand: "medium" } }),
    );
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it("never selects an action outside the supplied candidate list", async () => {
    const provider = new MockAIProvider();
    const request = makeRequest({
      candidateActions: [{ action: "ESCALATE", rationale: "only option", priority: 1 }],
    });
    const decision = await provider.generateDecision(request);
    expect(decision.action).toBe("ESCALATE");
  });
});
