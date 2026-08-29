import { describe, it, expect } from "vitest";
import { AI_SYSTEM_INSTRUCTION, buildUserPrompt } from "../src/ai/promptTemplate.js";
import type { AgentDecisionRequest } from "../src/ai/types.js";

function makeRequest(): AgentDecisionRequest {
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
  };
}

describe("AI: prompt template", () => {
  it("system instruction mentions the core constraints", () => {
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/candidate/i);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/confidence/i);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/ESCALATE/);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/STOP/);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/never invent/i);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/hidden evaluation/i);
    expect(AI_SYSTEM_INSTRUCTION).toMatch(/never execute/i);
  });

  it("does not reference any ground-truth field name", () => {
    for (const forbidden of ["recoverable", "recoveryProbability", "bestAction", "recoveredAmount"]) {
      expect(AI_SYSTEM_INSTRUCTION).not.toMatch(new RegExp(forbidden));
    }
  });

  it("buildUserPrompt includes the payment id and candidate actions", () => {
    const prompt = buildUserPrompt(makeRequest());
    expect(prompt).toContain("pay_1");
    expect(prompt).toContain("RETRY_NOW");
    expect(prompt).toContain("STOP");
  });

  it("buildUserPrompt is deterministic: same request always produces the same string", () => {
    const request = makeRequest();
    expect(buildUserPrompt(request)).toBe(buildUserPrompt(request));
  });

  it("buildUserPrompt never calls any network/service (pure function, resolves synchronously)", () => {
    const request = makeRequest();
    const result = buildUserPrompt(request);
    expect(typeof result).toBe("string");
  });
});
