import { describe, it, expect } from "vitest";
import { extractFeatures } from "../src/assessment/features.js";
import type { AgentPaymentContext } from "../src/domain/schemas.js";

function makeContext(overrides: Partial<AgentPaymentContext> = {}): AgentPaymentContext {
  return {
    paymentId: "pay_1",
    amount: 100000,
    currency: "INR",
    status: "failed",
    failureCategory: "temporary_bank_failure",
    attemptCount: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    merchant: { id: "mch_1", category: "ecommerce" },
    customer: { id: "cus_1", riskProfile: "medium" },
    recoveryCase: {
      id: "case_1",
      status: "open",
      openedAt: new Date("2026-08-01T00:00:00.000Z"),
      recoveryWindowEndsAt: new Date("2026-08-08T00:00:00.000Z"),
    },
    priorAttempts: [],
    ...overrides,
  };
}

describe("assessment: feature extraction", () => {
  it("extracts basic categorical features directly from the context", () => {
    const context = makeContext();
    const features = extractFeatures(context, new Date("2026-08-01T00:00:00.000Z"));
    expect(features.paymentId).toBe("pay_1");
    expect(features.failureCategory).toBe("temporary_bank_failure");
    expect(features.riskProfile).toBe("medium");
    expect(features.merchantCategory).toBe("ecommerce");
    expect(features.hasOpenCase).toBe(true);
    expect(features.recoveryCaseStatus).toBe("open");
  });

  it("returns null window/elapsed fields and hasOpenCase=false when there is no recovery case", () => {
    const context = makeContext({ recoveryCase: null, status: "created", failureCategory: null });
    const features = extractFeatures(context, new Date("2026-08-01T00:00:00.000Z"));
    expect(features.hasOpenCase).toBe(false);
    expect(features.recoveryCaseStatus).toBeNull();
    expect(features.windowRemainingHours).toBeNull();
    expect(features.hoursSinceCaseOpened).toBeNull();
  });

  it("computes windowRemainingHours and hoursSinceCaseOpened correctly", () => {
    const context = makeContext();
    // Case opened at 2026-08-01T00:00:00Z, window ends 2026-08-08T00:00:00Z (168h)
    const now = new Date("2026-08-02T00:00:00.000Z"); // 24h after opening
    const features = extractFeatures(context, now);
    expect(features.hoursSinceCaseOpened).toBeCloseTo(24, 5);
    expect(features.windowRemainingHours).toBeCloseTo(144, 5); // 168 - 24
  });

  it("windowRemainingHours goes negative once the window has expired", () => {
    const context = makeContext();
    const now = new Date("2026-08-10T00:00:00.000Z"); // past the 08-08 window end
    const features = extractFeatures(context, now);
    expect(features.windowRemainingHours).toBeLessThan(0);
  });

  it("counts prior attempt outcomes correctly", () => {
    const context = makeContext({
      priorAttempts: [
        { attemptNumber: 1, strategy: "baseline_deterministic_retry", scheduledAt: new Date(), executedAt: new Date(), outcome: "failure" },
        { attemptNumber: 2, strategy: "baseline_deterministic_retry", scheduledAt: new Date(), executedAt: new Date(), outcome: "failure" },
        { attemptNumber: 3, strategy: "baseline_deterministic_retry", scheduledAt: new Date(), executedAt: null, outcome: "blocked" },
      ],
    });
    const features = extractFeatures(context, new Date("2026-08-01T00:00:00.000Z"));
    expect(features.attemptsMade).toBe(3);
    expect(features.priorFailureCount).toBe(2);
    expect(features.priorBlockedCount).toBe(1);
    expect(features.priorSuccessCount).toBe(0);
  });

  it("is a pure function: same inputs always produce the same output", () => {
    const context = makeContext();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const a = extractFeatures(context, now);
    const b = extractFeatures(context, now);
    expect(a).toEqual(b);
  });
});
