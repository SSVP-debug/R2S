import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/rng.js";
import { computeGroundTruth } from "../src/simulation/groundTruth.js";
import { buildAgentPaymentContext } from "../src/domain/agentContext.js";
import {
  agentPaymentContextSchema,
  GROUND_TRUTH_FIELD_NAMES,
} from "../src/domain/schemas.js";
import { BEST_ACTIONS } from "../src/domain/types.js";
import type { Customer, Payment } from "../src/domain/types.js";

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_000001",
    amount: 250000,
    currency: "INR",
    status: "failed",
    failureCategory: "temporary_bank_failure",
    attemptCount: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    merchantId: "mch_000001",
    customerId: "cus_000001",
    simulationRunId: "run_test",
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cus_000001",
    name: "Test Customer",
    email: "test@example-mail.test",
    riskProfile: "medium",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    merchantId: "mch_000001",
    simulationRunId: "run_test",
    ...overrides,
  };
}

describe("ground truth", () => {
  it("is deterministic for the same rng sequence, payment, and customer", () => {
    const payment = makePayment();
    const customer = makeCustomer();
    const a = computeGroundTruth(createRng("gt-seed"), "gt_1", payment, customer);
    const b = computeGroundTruth(createRng("gt-seed"), "gt_1", payment, customer);
    expect(a).toEqual(b);
  });

  it("throws if the payment has no failureCategory", () => {
    const payment = makePayment({ status: "created", failureCategory: null });
    const customer = makeCustomer();
    expect(() =>
      computeGroundTruth(createRng("gt-seed-2"), "gt_2", payment, customer),
    ).toThrow();
  });

  it("recoveryProbability is always within [0, 1]", () => {
    const rng = createRng("gt-range-check");
    for (let i = 0; i < 200; i++) {
      const payment = makePayment({
        id: `pay_${i}`,
        failureCategory: rng.pick([
          "temporary_bank_failure",
          "insufficient_funds",
          "authentication_failure",
          "invalid_instrument",
          "repeated_failure",
          "unknown",
        ]),
      });
      const customer = makeCustomer({ riskProfile: rng.pick(["low", "medium", "high"]) });
      const gt = computeGroundTruth(rng, `gt_${i}`, payment, customer);
      expect(gt.recoveryProbability).toBeGreaterThanOrEqual(0);
      expect(gt.recoveryProbability).toBeLessThanOrEqual(1);
    }
  });

  it("bestAction is always one of the defined BEST_ACTIONS", () => {
    const rng = createRng("gt-best-action-check");
    for (let i = 0; i < 50; i++) {
      const payment = makePayment({ id: `pay_${i}` });
      const customer = makeCustomer();
      const gt = computeGroundTruth(rng, `gt_${i}`, payment, customer);
      expect(BEST_ACTIONS).toContain(gt.bestAction);
    }
  });

  it("non-recoverable ground truth always has bestAction 'no_action' and recoveredAmount 0", () => {
    // invalid_instrument has retryable: false in the taxonomy, and a low
    // base recovery probability, so across many draws we should see
    // non-recoverable outcomes to check this invariant on.
    const rng = createRng("gt-non-recoverable");
    let sawNonRecoverable = false;
    for (let i = 0; i < 100; i++) {
      const payment = makePayment({ id: `pay_${i}`, failureCategory: "invalid_instrument" });
      const customer = makeCustomer({ riskProfile: "high" });
      const gt = computeGroundTruth(rng, `gt_${i}`, payment, customer);
      if (!gt.recoverable) {
        sawNonRecoverable = true;
        expect(gt.bestAction).toBe("no_action");
        expect(gt.recoveredAmount).toBe(0);
      }
    }
    expect(sawNonRecoverable).toBe(true);
  });

  it("recoveredAmount never exceeds the payment amount", () => {
    const rng = createRng("gt-amount-check");
    for (let i = 0; i < 100; i++) {
      const amount = rng.int(10000, 5000000);
      const payment = makePayment({ id: `pay_${i}`, amount });
      const customer = makeCustomer();
      const gt = computeGroundTruth(rng, `gt_${i}`, payment, customer);
      expect(gt.recoveredAmount).toBeLessThanOrEqual(amount);
    }
  });

  describe("isolation from agent-facing context", () => {
    it("buildAgentPaymentContext never includes any ground-truth field name", () => {
      const payment = makePayment();
      const context = buildAgentPaymentContext({
        payment,
        merchant: {
          id: "mch_000001",
          name: "Test Merchant",
          category: "ecommerce",
          createdAt: payment.createdAt,
          simulationRunId: "run_test",
        },
        customer: makeCustomer(),
        recoveryCase: null,
        priorAttempts: [],
      });

      const keys = collectAllKeysDeep(context);
      for (const forbidden of GROUND_TRUTH_FIELD_NAMES) {
        expect(keys.has(forbidden)).toBe(false);
      }
    });

    it("agentPaymentContextSchema.parse strips any ground-truth fields injected after the fact", () => {
      const payment = makePayment();
      const context = buildAgentPaymentContext({
        payment,
        merchant: {
          id: "mch_000001",
          name: "Test Merchant",
          category: "ecommerce",
          createdAt: payment.createdAt,
          simulationRunId: "run_test",
        },
        customer: makeCustomer(),
        recoveryCase: null,
        priorAttempts: [],
      });

      // Simulate an attempted leak: even if someone tried to bolt ground
      // truth onto the object after the fact, re-validating through the
      // schema strips it back down to the declared agent-facing shape.
      const tampered = {
        ...context,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
      };

      const revalidated = agentPaymentContextSchema.parse(tampered);
      expect((revalidated as Record<string, unknown>).recoveryProbability).toBeUndefined();
      expect((revalidated as Record<string, unknown>).bestAction).toBeUndefined();
    });
  });
});

function collectAllKeysDeep(obj: unknown, keys: Set<string> = new Set()): Set<string> {
  if (obj === null || typeof obj !== "object") return keys;
  if (Array.isArray(obj)) {
    for (const item of obj) collectAllKeysDeep(item, keys);
    return keys;
  }
  for (const [k, v] of Object.entries(obj)) {
    keys.add(k);
    collectAllKeysDeep(v, keys);
  }
  return keys;
}
