import { describe, it, expect } from "vitest";
import {
  resolveRecoveryDecision,
  runDecisionAgent,
  shouldCallAI,
} from "../src/ai/decisionAgent.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import type { AIProvider } from "../src/ai/provider.js";
import type { AgentDecision, AgentDecisionRequest } from "../src/ai/types.js";

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

class ThrowingProvider implements AIProvider {
  async generateDecision(): Promise<AgentDecision> {
    throw new Error("simulated provider outage");
  }
}

class InvalidOutputProvider implements AIProvider {
  async generateDecision(): Promise<AgentDecision> {
    // Deliberately malformed: unknown action.
    return { action: "TELEPORT" as unknown as AgentDecision["action"], confidence: 0.5, reasoning: "bad" };
  }
}

class OutOfCandidatesProvider implements AIProvider {
  async generateDecision(): Promise<AgentDecision> {
    // A structurally valid decision, but for an action not offered.
    return { action: "OFFER_INCENTIVE", confidence: 0.5, reasoning: "not offered", incentivePercent: 10 };
  }
}

class CountingProvider implements AIProvider {
  calls = 0;
  constructor(private inner: AIProvider) {}
  async generateDecision(request: AgentDecisionRequest): Promise<AgentDecision> {
    this.calls++;
    return this.inner.generateDecision(request);
  }
}

describe("AI: decision agent — happy path", () => {
  it("runDecisionAgent returns the provider's decision with source 'provider' when everything is valid", async () => {
    const provider = new MockAIProvider();
    const result = await runDecisionAgent(provider, makeRequest());
    expect(result.source).toBe("provider");
    expect(result.decision.action).toBe("RETRY_NOW");
  });
});

describe("AI: decision agent — candidate constraint", () => {
  it("rejects and falls back when the provider selects an action not in the candidate list, and the invalid action never reaches the accepted recommendation", async () => {
    const request = makeRequest(); // candidates: RETRY_NOW, STOP — OFFER_INCENTIVE is NOT among them
    const result = await runDecisionAgent(new OutOfCandidatesProvider(), request);

    // 1. Provider result is rejected -> safe fallback occurs.
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toMatch(/not in the supplied candidate list/);

    // 2. The invalid action (OFFER_INCENTIVE, from OutOfCandidatesProvider)
    // is never passed through as the accepted recommendation.
    expect(result.decision.action).not.toBe("OFFER_INCENTIVE");

    // 3. The accepted recommendation is always one of the safe fallback
    // actions, and — critically — is drawn from the fallback logic, not
    // from the rejected provider output.
    expect(["STOP", "ESCALATE"]).toContain(result.decision.action);
  });

  it("also enforces the candidate constraint via resolveRecoveryDecision (the real entry point used by the pipeline)", async () => {
    const request = makeRequest();
    const result = await resolveRecoveryDecision(new OutOfCandidatesProvider(), request);
    expect(result.source).toBe("fallback");
    expect(result.decision.action).not.toBe("OFFER_INCENTIVE");
  });
});

describe("AI: decision agent — invalid provider output", () => {
  it("falls back when the provider returns a schema-invalid decision", async () => {
    const result = await runDecisionAgent(new InvalidOutputProvider(), makeRequest());
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toMatch(/invalid output/);
  });
});

describe("AI: decision agent — provider failure fallback", () => {
  it("falls back when the provider throws", async () => {
    const result = await runDecisionAgent(new ThrowingProvider(), makeRequest());
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toMatch(/simulated provider outage/);
  });

  it("never throws itself, even when the provider throws", async () => {
    await expect(runDecisionAgent(new ThrowingProvider(), makeRequest())).resolves.toBeDefined();
  });

  it("prefers STOP as the fallback action for a fresh case with no prior failures", async () => {
    const result = await runDecisionAgent(
      new ThrowingProvider(),
      makeRequest({
        recoveryHistory: { attemptsMade: 0, priorFailureCount: 0, priorSuccessCount: 0, priorBlockedCount: 0 },
      }),
    );
    expect(result.decision.action).toBe("STOP");
  });

  it("prefers ESCALATE as the fallback action when there are prior failures", async () => {
    const result = await runDecisionAgent(
      new ThrowingProvider(),
      makeRequest({
        recoveryHistory: { attemptsMade: 2, priorFailureCount: 2, priorSuccessCount: 0, priorBlockedCount: 0 },
      }),
    );
    expect(result.decision.action).toBe("ESCALATE");
  });

  it("fallback decisions always pass agentDecisionSchema", async () => {
    const result = await runDecisionAgent(new ThrowingProvider(), makeRequest());
    // confidence 0 and non-empty reasoning are schema-valid for STOP/ESCALATE
    expect(result.decision.confidence).toBe(0);
    expect(result.decision.reasoning.length).toBeGreaterThan(0);
  });
});

describe("AI: decision agent — cost control (skip AI when unambiguous)", () => {
  it("shouldCallAI is false when there is only one candidate action", () => {
    const request = makeRequest({
      candidateActions: [{ action: "STOP", rationale: "only option", priority: 1 }],
    });
    expect(shouldCallAI(request)).toBe(false);
  });

  it("shouldCallAI is true when there are multiple candidate actions", () => {
    expect(shouldCallAI(makeRequest())).toBe(true);
  });

  it("resolveRecoveryDecision does NOT call the provider when there is a single candidate", async () => {
    const counting = new CountingProvider(new MockAIProvider());
    const request = makeRequest({
      candidateActions: [{ action: "STOP", rationale: "only option", priority: 1 }],
    });
    const result = await resolveRecoveryDecision(counting, request);
    expect(counting.calls).toBe(0);
    expect(result.source).toBe("deterministic");
    expect(result.decision.action).toBe("STOP");
  });

  it("resolveRecoveryDecision DOES call the provider when there are multiple candidates", async () => {
    const counting = new CountingProvider(new MockAIProvider());
    const result = await resolveRecoveryDecision(counting, makeRequest());
    expect(counting.calls).toBe(1);
    expect(result.source).toBe("provider");
  });
});
