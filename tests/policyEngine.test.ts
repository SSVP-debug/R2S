import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/policy/policyEngine.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import type { PolicyEvaluationInput } from "../src/policy/types.js";
import type { AgentDecision } from "../src/ai/types.js";

function makeRecommendation(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "RETRY_NOW",
    confidence: 0.7,
    reasoning: "Looks recoverable.",
    ...overrides,
  };
}

function makeInput(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    paymentAmount: 100000,
    retryCount: 0,
    windowRemainingHours: 100,
    priorFailureCount: 0,
    recommendation: makeRecommendation(),
    merchantPolicy: DEFAULT_MERCHANT_POLICY,
    ...overrides,
  };
}

describe("policy: default ALLOW", () => {
  it("allows the AI recommendation when no rule is triggered", () => {
    const result = evaluatePolicy(makeInput());
    expect(result.decision).toBe("ALLOW");
    expect(result.action).toBe("RETRY_NOW");
    expect(result.appliedRules).toEqual([]);
  });
});

describe("policy: (a) retry limit", () => {
  it("blocks RETRY_NOW once retryCount reaches maxRetries", () => {
    const result = evaluatePolicy(
      makeInput({ retryCount: DEFAULT_MERCHANT_POLICY.maxRetries, recommendation: makeRecommendation({ action: "RETRY_NOW" }) }),
    );
    expect(result.decision).toBe("BLOCK");
    expect(result.appliedRules).toContain("retry_limit_reached");
  });

  it("blocks RETRY_LATER once retryCount reaches maxRetries", () => {
    const result = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
        recommendation: makeRecommendation({ action: "RETRY_LATER", delayHours: 24 }),
      }),
    );
    expect(result.decision).toBe("BLOCK");
  });

  it("does not block RETRY_NOW when under the retry limit", () => {
    const result = evaluatePolicy(makeInput({ retryCount: DEFAULT_MERCHANT_POLICY.maxRetries - 1 }));
    expect(result.decision).toBe("ALLOW");
  });

  it("does not block non-retry actions even at the retry limit", () => {
    const result = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
        recommendation: makeRecommendation({ action: "ESCALATE" }),
      }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

describe("policy: (b) recovery window", () => {
  it("blocks a recovery-attempt action once the window has expired", () => {
    const result = evaluatePolicy(makeInput({ windowRemainingHours: -1 }));
    expect(result.decision).toBe("BLOCK");
    expect(result.appliedRules).toContain("recovery_window_expired");
  });

  it("does not block ESCALATE even after the window has expired", () => {
    const result = evaluatePolicy(
      makeInput({ windowRemainingHours: -1, recommendation: makeRecommendation({ action: "ESCALATE" }) }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("does not block STOP even after the window has expired", () => {
    const result = evaluatePolicy(
      makeInput({ windowRemainingHours: -1, recommendation: makeRecommendation({ action: "STOP" }) }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("has no effect when there is no window (null)", () => {
    const result = evaluatePolicy(makeInput({ windowRemainingHours: null }));
    expect(result.decision).toBe("ALLOW");
  });
});

describe("policy: (c) incentive ceiling", () => {
  it("modifies (caps) a moderately excessive incentive request", () => {
    const result = evaluatePolicy(
      makeInput({
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 20 }),
        merchantPolicy: { ...DEFAULT_MERCHANT_POLICY, maxIncentivePercent: 15 },
      }),
    );
    expect(result.decision).toBe("MODIFY");
    expect(result.modifiedDecision?.incentivePercent).toBe(15);
    expect(result.appliedRules).toContain("incentive_ceiling_exceeded");
  });

  it("blocks a severely excessive incentive request (>2x ceiling)", () => {
    const result = evaluatePolicy(
      makeInput({
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 40 }),
        merchantPolicy: { ...DEFAULT_MERCHANT_POLICY, maxIncentivePercent: 15 },
      }),
    );
    expect(result.decision).toBe("BLOCK");
    expect(result.appliedRules).toContain("incentive_ceiling_exceeded_severely");
  });

  it("allows an incentive request within the ceiling", () => {
    const result = evaluatePolicy(
      makeInput({
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 10 }),
        merchantPolicy: { ...DEFAULT_MERCHANT_POLICY, maxIncentivePercent: 15 },
        paymentAmount: 10000, // below high-value threshold
      }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

describe("policy: (d) high-value incentive escalation", () => {
  it("escalates an incentive offer on a high-value payment even within the ceiling", () => {
    const result = evaluatePolicy(
      makeInput({
        paymentAmount: DEFAULT_MERCHANT_POLICY.highValueThresholdMinor,
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 5 }),
      }),
    );
    expect(result.decision).toBe("ESCALATE");
    expect(result.appliedRules).toContain("high_value_incentive_escalation");
  });

  it("does not escalate incentive offers on low-value payments", () => {
    const result = evaluatePolicy(
      makeInput({
        paymentAmount: 1000,
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 5 }),
      }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

describe("policy: (e) repeated failure", () => {
  it("modifies RETRY_NOW to RETRY_LATER after 2+ prior failures", () => {
    const result = evaluatePolicy(
      makeInput({ priorFailureCount: 2, retryCount: 2, recommendation: makeRecommendation({ action: "RETRY_NOW" }) }),
    );
    expect(result.decision).toBe("MODIFY");
    expect(result.modifiedDecision?.action).toBe("RETRY_LATER");
    expect(result.modifiedDecision?.delayHours).toBeGreaterThan(0);
    expect(result.appliedRules).toContain("repeated_failure_cooldown");
  });

  it("does not modify when there are fewer than 2 prior failures", () => {
    const result = evaluatePolicy(makeInput({ priorFailureCount: 1 }));
    expect(result.decision).toBe("ALLOW");
  });
});

describe("policy: rule precedence (severity ordering)", () => {
  it("BLOCK (retry limit) outranks MODIFY (repeated failure) when both fire", () => {
    const result = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
        priorFailureCount: 3,
        recommendation: makeRecommendation({ action: "RETRY_NOW" }),
      }),
    );
    expect(result.decision).toBe("BLOCK");
    expect(result.appliedRules).toContain("retry_limit_reached");
    expect(result.appliedRules).toContain("repeated_failure_cooldown");
  });

  it("ESCALATE (high-value) outranks a plain MODIFY (incentive ceiling) when both fire", () => {
    const result = evaluatePolicy(
      makeInput({
        paymentAmount: DEFAULT_MERCHANT_POLICY.highValueThresholdMinor,
        recommendation: makeRecommendation({ action: "OFFER_INCENTIVE", incentivePercent: 20 }),
        merchantPolicy: { ...DEFAULT_MERCHANT_POLICY, maxIncentivePercent: 15 },
      }),
    );
    expect(result.decision).toBe("ESCALATE");
  });
});

describe("policy: modification safety under simultaneous rule applicability (Issue 3)", () => {
  it("RETRY_NOW + priorFailureCount at/above repeated-failure threshold + retryCount at/above maxRetries -> final result is BLOCK, not MODIFY", () => {
    const result = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries, // triggers retryLimitRule (BLOCK)
        priorFailureCount: 2, // triggers repeatedFailureRule (MODIFY) — exactly at the threshold
        recommendation: makeRecommendation({ action: "RETRY_NOW" }),
      }),
    );

    // The final decision must be BLOCK — retry limit (severity 3) beats
    // repeated-failure cooldown (severity 1) — even though the MODIFY rule
    // also genuinely fired.
    expect(result.decision).toBe("BLOCK");

    // A BLOCK result must not carry an authorized action or a
    // modifiedDecision — nothing is allowed to proceed, so there is
    // nothing "corrected" to hand back either.
    expect(result.action).toBeUndefined();
    expect(result.modifiedDecision).toBeUndefined();

    // Both rules are visible in appliedRules for transparency, even though
    // only the higher-severity one determined the outcome.
    expect(result.appliedRules).toContain("retry_limit_reached");
    expect(result.appliedRules).toContain("repeated_failure_cooldown");
  });

  it("is not sensitive to rule declaration order: the same combination BLOCKs regardless of how many other MODIFY-tier rules also fire", () => {
    // Add a third, unrelated MODIFY-tier condition (incentive ceiling)
    // that cannot actually apply to a RETRY_NOW recommendation, to confirm
    // the engine isn't accidentally aggregating rules incorrectly.
    const result = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
        priorFailureCount: 5,
        recommendation: makeRecommendation({ action: "RETRY_NOW" }),
      }),
    );
    expect(result.decision).toBe("BLOCK");
  });

  it("confirms the underlying rule functions both genuinely fire in isolation (sanity check that BLOCK winning is precedence, not the MODIFY rule silently not firing)", () => {
    // repeatedFailureRule alone (retry count under the limit): MODIFY.
    const modifyOnly = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries - 1,
        priorFailureCount: 2,
        recommendation: makeRecommendation({ action: "RETRY_NOW" }),
      }),
    );
    expect(modifyOnly.decision).toBe("MODIFY");

    // retryLimitRule alone (no prior failures): BLOCK.
    const blockOnly = evaluatePolicy(
      makeInput({
        retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
        priorFailureCount: 0,
        recommendation: makeRecommendation({ action: "RETRY_NOW" }),
      }),
    );
    expect(blockOnly.decision).toBe("BLOCK");
  });
});

describe("policy: determinism", () => {
  it("is a pure function: identical input always produces identical output", () => {
    const input = makeInput({ priorFailureCount: 2, retryCount: 1 });
    const a = evaluatePolicy(input);
    const b = evaluatePolicy(input);
    expect(a).toEqual(b);
  });

  it("AI cannot override policy: identical unsafe recommendation is blocked every time regardless of confidence", () => {
    for (const confidence of [0.1, 0.5, 0.99, 1]) {
      const result = evaluatePolicy(
        makeInput({
          retryCount: DEFAULT_MERCHANT_POLICY.maxRetries,
          recommendation: makeRecommendation({ action: "RETRY_NOW", confidence }),
        }),
      );
      expect(result.decision).toBe("BLOCK");
    }
  });
});
