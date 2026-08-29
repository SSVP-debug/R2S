import { describe, it, expect } from "vitest";
import { computeRecoveryScore, scoreBand } from "../src/assessment/scoring.js";
import type { RecoveryFeatures } from "../src/assessment/features.js";

function makeFeatures(overrides: Partial<RecoveryFeatures> = {}): RecoveryFeatures {
  return {
    paymentId: "pay_1",
    failureCategory: "temporary_bank_failure",
    riskProfile: "medium",
    merchantCategory: "ecommerce",
    hasOpenCase: true,
    recoveryCaseStatus: "open",
    attemptsMade: 0,
    priorFailureCount: 0,
    priorSuccessCount: 0,
    priorBlockedCount: 0,
    windowRemainingHours: 100,
    hoursSinceCaseOpened: 0,
    ...overrides,
  };
}

describe("assessment: deterministic recovery scoring", () => {
  it("is a pure function: identical features always produce the identical score", () => {
    const features = makeFeatures();
    expect(computeRecoveryScore(features)).toBe(computeRecoveryScore(features));
  });

  it("always returns a score within [0, 1]", () => {
    for (const category of [
      "temporary_bank_failure",
      "insufficient_funds",
      "authentication_failure",
      "invalid_instrument",
      "repeated_failure",
      "unknown",
    ] as const) {
      for (const riskProfile of ["low", "medium", "high"] as const) {
        for (const priorFailureCount of [0, 1, 3, 10]) {
          const score = computeRecoveryScore(
            makeFeatures({ failureCategory: category, riskProfile, priorFailureCount }),
          );
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("returns 0 when there is no open case", () => {
    expect(computeRecoveryScore(makeFeatures({ hasOpenCase: false }))).toBe(0);
  });

  it("returns 0 once the recovery window has expired", () => {
    expect(computeRecoveryScore(makeFeatures({ windowRemainingHours: -1 }))).toBe(0);
  });

  it("returns 0 if failureCategory is null despite an open case (defensive)", () => {
    expect(computeRecoveryScore(makeFeatures({ failureCategory: null }))).toBe(0);
  });

  it("higher-risk customers score lower than lower-risk customers, all else equal", () => {
    const low = computeRecoveryScore(makeFeatures({ riskProfile: "low" }));
    const high = computeRecoveryScore(makeFeatures({ riskProfile: "high" }));
    expect(low).toBeGreaterThan(high);
  });

  it("more prior failures reduce the score (decay), all else equal", () => {
    const zero = computeRecoveryScore(makeFeatures({ priorFailureCount: 0 }));
    const three = computeRecoveryScore(makeFeatures({ priorFailureCount: 3 }));
    expect(three).toBeLessThan(zero);
  });

  it("invalid_instrument scores lower than temporary_bank_failure, all else equal", () => {
    const bankFailure = computeRecoveryScore(makeFeatures({ failureCategory: "temporary_bank_failure" }));
    const invalidInstrument = computeRecoveryScore(makeFeatures({ failureCategory: "invalid_instrument" }));
    expect(invalidInstrument).toBeLessThan(bankFailure);
  });

  it("scoreBand buckets scores into low/medium/high consistently with thresholds", () => {
    expect(scoreBand(0)).toBe("low");
    expect(scoreBand(0.29)).toBe("low");
    expect(scoreBand(0.3)).toBe("medium");
    expect(scoreBand(0.59)).toBe("medium");
    expect(scoreBand(0.6)).toBe("high");
    expect(scoreBand(1)).toBe("high");
  });
});
