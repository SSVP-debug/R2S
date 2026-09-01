import { describe, it, expect } from "vitest";
import { computeRecoveryMetrics } from "../src/evaluation/metrics.js";
import type { EvaluationRecord } from "../src/evaluation/types.js";
import type { Payment, RecoveryAttempt } from "../src/domain/types.js";
import type { PolicyResult } from "../src/policy/types.js";

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_1",
    amount: 100000,
    currency: "INR",
    status: "failed",
    failureCategory: "temporary_bank_failure",
    attemptCount: 0,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    merchantId: "mch_1",
    customerId: "cus_1",
    simulationRunId: "run_1",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<RecoveryAttempt> = {}): RecoveryAttempt {
  return {
    id: "att_1",
    attemptNumber: 1,
    strategy: "ai_orchestrated",
    scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
    executedAt: new Date("2026-09-01T00:00:00.000Z"),
    outcome: "success",
    amountRecovered: 100000,
    recoveryCaseId: "case_1",
    simulationRunId: "run_1",
    ...overrides,
  };
}

function makePolicyResult(overrides: Partial<PolicyResult> = {}): PolicyResult {
  return {
    decision: "ALLOW",
    action: "RETRY_NOW",
    reason: "no rules triggered",
    appliedRules: [],
    ...overrides,
  };
}

describe("evaluation: metrics formulas", () => {
  it("eligibleFailedPayments excludes payments with status 'created' (never failed)", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ id: "p1", status: "created" }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p2", status: "failed" }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p3", status: "recovered" }), attempts: [], policyResult: null },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.eligibleFailedPayments).toBe(2);
  });

  it("recoveryRate = recoveredPayments / eligibleFailedPayments", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ id: "p1", status: "recovered" }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p2", status: "failed_final" }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p3", status: "recovered" }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p4", status: "stopped" }), attempts: [], policyResult: null },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.eligibleFailedPayments).toBe(4);
    expect(metrics.recoveredPayments).toBe(2);
    expect(metrics.recoveryRate).toBeCloseTo(0.5);
  });

  it("recoveredRevenue = sum of amount for recovered payments only", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ id: "p1", status: "recovered", amount: 50000 }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p2", status: "recovered", amount: 30000 }), attempts: [], policyResult: null },
      { payment: makePayment({ id: "p3", status: "failed_final", amount: 999999 }), attempts: [], policyResult: null },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.recoveredRevenue).toBe(80000);
  });

  it("recoveryAttempts counts only non-'pending' attempts across eligible payments", () => {
    const records: EvaluationRecord[] = [
      {
        payment: makePayment({ id: "p1", status: "recovered" }),
        attempts: [
          makeAttempt({ outcome: "failure" }),
          makeAttempt({ outcome: "success" }),
          makeAttempt({ outcome: "pending" }),
        ],
        policyResult: null,
      },
      {
        payment: makePayment({ id: "p2", status: "created" }), // not eligible
        attempts: [makeAttempt({ outcome: "success" })],
        policyResult: null,
      },
    ];
    const metrics = computeRecoveryMetrics(records);
    // 2 non-pending attempts on p1; p2's attempt is excluded (p2 not eligible)
    expect(metrics.recoveryAttempts).toBe(2);
  });

  it("blockedRecommendations counts policy results with decision BLOCK", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ id: "p1" }), attempts: [], policyResult: makePolicyResult({ decision: "BLOCK" }) },
      { payment: makePayment({ id: "p2" }), attempts: [], policyResult: makePolicyResult({ decision: "ALLOW" }) },
      { payment: makePayment({ id: "p3" }), attempts: [], policyResult: makePolicyResult({ decision: "BLOCK" }) },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.blockedRecommendations).toBe(2);
  });

  it("escalationCount counts policy results with decision ESCALATE", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ id: "p1" }), attempts: [], policyResult: makePolicyResult({ decision: "ESCALATE" }) },
      { payment: makePayment({ id: "p2" }), attempts: [], policyResult: makePolicyResult({ decision: "MODIFY" }) },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.escalationCount).toBe(1);
  });

  it("recoveryEfficiency = recoveredRevenue / recoveryAttempts", () => {
    const records: EvaluationRecord[] = [
      {
        payment: makePayment({ id: "p1", status: "recovered", amount: 100000 }),
        attempts: [makeAttempt({ outcome: "failure" }), makeAttempt({ outcome: "success" })],
        policyResult: null,
      },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.recoveryEfficiency).toBeCloseTo(100000 / 2);
  });
});

describe("evaluation: zero-denominator safety", () => {
  it("recoveryRate is 0 (not NaN/Infinity) when there are no eligible failed payments", () => {
    const metrics = computeRecoveryMetrics([]);
    expect(metrics.eligibleFailedPayments).toBe(0);
    expect(metrics.recoveryRate).toBe(0);
    expect(Number.isFinite(metrics.recoveryRate)).toBe(true);
  });

  it("recoveryEfficiency is 0 (not NaN/Infinity) when there are no recovery attempts", () => {
    const records: EvaluationRecord[] = [
      { payment: makePayment({ status: "failed_final" }), attempts: [], policyResult: null },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.recoveryAttempts).toBe(0);
    expect(metrics.recoveryEfficiency).toBe(0);
    expect(Number.isFinite(metrics.recoveryEfficiency)).toBe(true);
  });

  it("all counts are 0 for a completely empty input", () => {
    const metrics = computeRecoveryMetrics([]);
    expect(metrics).toEqual({
      eligibleFailedPayments: 0,
      recoveredPayments: 0,
      recoveryRate: 0,
      recoveredRevenue: 0,
      recoveryAttempts: 0,
      blockedRecommendations: 0,
      escalationCount: 0,
      recoveryEfficiency: 0,
    });
  });

  it("recoveryEfficiency is 0 even if recoveredRevenue is somehow positive with zero attempts (defensive)", () => {
    // Constructed edge case: a payment marked recovered but with no
    // recorded attempts at all (e.g. recovered by some path outside this
    // metrics module's attempt-tracking). Efficiency must still not divide
    // by zero.
    const records: EvaluationRecord[] = [
      { payment: makePayment({ status: "recovered", amount: 50000 }), attempts: [], policyResult: null },
    ];
    const metrics = computeRecoveryMetrics(records);
    expect(metrics.recoveredRevenue).toBe(50000);
    expect(metrics.recoveryAttempts).toBe(0);
    expect(metrics.recoveryEfficiency).toBe(0);
  });
});
