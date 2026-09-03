import { describe, it, expect } from "vitest";
import { generateCandidateActions } from "../src/assessment/candidateActions.js";
import { BEST_ACTIONS } from "../src/domain/types.js";
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

describe("assessment: candidate action generation", () => {
  it("is deterministic: same features + score always produce the same candidates", () => {
    const features = makeFeatures();
    const a = generateCandidateActions(features, 0.7);
    const b = generateCandidateActions(features, 0.7);
    expect(a).toEqual(b);
  });

  it("every candidate action is drawn from the fixed BEST_ACTIONS vocabulary", () => {
    const features = makeFeatures({ failureCategory: "insufficient_funds" });
    const candidates = generateCandidateActions(features, 0.4);
    for (const c of candidates) {
      expect(BEST_ACTIONS).toContain(c.action);
    }
  });

  it("returns only no_action when there is no open case", () => {
    const features = makeFeatures({ hasOpenCase: false, recoveryCaseStatus: null, windowRemainingHours: null });
    const candidates = generateCandidateActions(features, 0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.action).toBe("no_action");
  });

  it("returns only no_action when the recovery case is already closed", () => {
    for (const status of ["recovered", "failed", "stopped"] as const) {
      const features = makeFeatures({ recoveryCaseStatus: status });
      const candidates = generateCandidateActions(features, 0.5);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.action).toBe("no_action");
    }
  });

  it("returns only no_action once the recovery window has expired", () => {
    const features = makeFeatures({ windowRemainingHours: -5 });
    const candidates = generateCandidateActions(features, 0.5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.action).toBe("no_action");
  });

  it("prioritizes prompt_instrument_update for invalid_instrument failures", () => {
    const features = makeFeatures({ failureCategory: "invalid_instrument" });
    const candidates = generateCandidateActions(features, 0.15);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("prompt_instrument_update");
  });

  it("prioritizes escalate_to_human for repeated_failure", () => {
    const features = makeFeatures({ failureCategory: "repeated_failure" });
    const candidates = generateCandidateActions(features, 0.2);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("escalate_to_human");
  });

  it("prioritizes retry_immediate for a fresh temporary_bank_failure with no prior attempts", () => {
    const features = makeFeatures({ failureCategory: "temporary_bank_failure", attemptsMade: 0 });
    const candidates = generateCandidateActions(features, 0.7);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("retry_immediate");
  });

  it("overrides towards escalate_to_human when score is low and there are prior failures", () => {
    const features = makeFeatures({
      failureCategory: "temporary_bank_failure",
      priorFailureCount: 2,
      attemptsMade: 2,
    });
    const candidates = generateCandidateActions(features, 0.1);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("escalate_to_human");
  });

  it("priorities are unique and sequential starting at 1", () => {
    const features = makeFeatures({ failureCategory: "authentication_failure" });
    const candidates = generateCandidateActions(features, 0.5);
    const priorities = candidates.map((c) => c.priority).sort((a, b) => a - b);
    expect(priorities).toEqual(Array.from({ length: candidates.length }, (_, i) => i + 1));
  });

  it("every candidate has a non-empty rationale string", () => {
    const features = makeFeatures({ failureCategory: "unknown" });
    const candidates = generateCandidateActions(features, 0.3);
    for (const c of candidates) {
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  // ===========================================================================
  // Sep 3 controlled experiment: low-confidence escalation override requires
  // priorFailureCount >= 2 (raised from > 0). These tests pin the exact
  // boundary the experiment changed and prove nothing else about candidate
  // generation moved.
  // ===========================================================================

  it("does NOT override to escalate_to_human on a low-confidence score with exactly 1 prior failure", () => {
    for (const failureCategory of ["insufficient_funds", "unknown", "temporary_bank_failure"] as const) {
      const features = makeFeatures({
        failureCategory,
        priorFailureCount: 1,
        attemptsMade: 1,
      });
      const candidates = generateCandidateActions(features, 0.1);
      const top = candidates.find((c) => c.priority === 1);
      expect(top?.action).not.toBe("escalate_to_human");
    }
  });

  it("DOES override to escalate_to_human on a low-confidence score with exactly 2 prior failures", () => {
    for (const failureCategory of ["insufficient_funds", "unknown", "temporary_bank_failure"] as const) {
      const features = makeFeatures({
        failureCategory,
        priorFailureCount: 2,
        attemptsMade: 2,
      });
      const candidates = generateCandidateActions(features, 0.1);
      const top = candidates.find((c) => c.priority === 1);
      expect(top?.action).toBe("escalate_to_human");
    }
  });

  it("still overrides to escalate_to_human beyond 2 prior failures (>= 2, not == 2)", () => {
    const features = makeFeatures({
      failureCategory: "insufficient_funds",
      priorFailureCount: 3,
      attemptsMade: 3,
    });
    const candidates = generateCandidateActions(features, 0.1);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("escalate_to_human");
  });

  it("does not override on a high-confidence score even with 2+ prior failures (score gate unchanged)", () => {
    const features = makeFeatures({
      failureCategory: "insufficient_funds",
      priorFailureCount: 3,
      attemptsMade: 3,
    });
    const candidates = generateCandidateActions(features, 0.8);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).not.toBe("escalate_to_human");
  });

  it("leaves category-specific top-priority action selection unchanged with 1 prior failure and a non-low score", () => {
    // Same fixture shape as the "prioritizes retry_immediate..." test above,
    // but with a prior failure present, to confirm the override's
    // priorFailureCount threshold change didn't alter unrelated
    // category-priority behavior.
    const features = makeFeatures({
      failureCategory: "temporary_bank_failure",
      priorFailureCount: 1,
      attemptsMade: 1,
    });
    const candidates = generateCandidateActions(features, 0.6);
    const top = candidates.find((c) => c.priority === 1);
    expect(top?.action).toBe("retry_immediate");
  });

  it("priorities stay unique and sequential starting at 1 when the override does NOT fire (1 prior failure)", () => {
    const features = makeFeatures({
      failureCategory: "authentication_failure",
      priorFailureCount: 1,
      attemptsMade: 1,
    });
    const candidates = generateCandidateActions(features, 0.1);
    const priorities = candidates.map((c) => c.priority).sort((a, b) => a - b);
    expect(priorities).toEqual(Array.from({ length: candidates.length }, (_, i) => i + 1));
  });
});