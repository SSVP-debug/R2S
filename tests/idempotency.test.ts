import { describe, it, expect } from "vitest";
import { RecoveryExecutor } from "../src/execution/recoveryExecutor.js";
import type { RecoveryExecutionRequest } from "../src/execution/recoveryExecutor.js";

function makeRequest(overrides: Partial<RecoveryExecutionRequest> = {}): RecoveryExecutionRequest {
  return {
    idempotencyKey: "pay_1:case_1:1",
    paymentId: "pay_1",
    recoveryCaseId: "case_1",
    attemptNumber: 1,
    action: "RETRY_NOW",
    requestedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("execution: idempotency", () => {
  it("duplicate execution with the same key does not execute twice (executedCount stays at 1)", () => {
    const executor = new RecoveryExecutor();
    const request = makeRequest();
    executor.execute(request);
    executor.execute(request);
    executor.execute(request);
    expect(executor.executedCount()).toBe(1);
  });

  it("the second call with the same key returns idempotent: true", () => {
    const executor = new RecoveryExecutor();
    const request = makeRequest();
    const first = executor.execute(request);
    const second = executor.execute(request);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
  });

  it("the idempotent result is deterministically equal to the original (aside from the idempotent flag)", () => {
    const executor = new RecoveryExecutor();
    const request = makeRequest();
    const first = executor.execute(request);
    const second = executor.execute(request);
    expect({ ...second, idempotent: first.idempotent }).toEqual(first);
  });

  it("a repeated call ignores changed parameters for the same key — the ORIGINAL execution result wins", () => {
    const executor = new RecoveryExecutor();
    const first = executor.execute(makeRequest({ action: "RETRY_NOW" }));
    // Same idempotency key, but a caller mistakenly (or maliciously)
    // attempts to re-execute with a different action.
    const second = executor.execute(makeRequest({ action: "OFFER_INCENTIVE", incentivePercent: 50 }));
    expect(second.action).toBe(first.action); // still RETRY_NOW, not OFFER_INCENTIVE
    expect(second.idempotent).toBe(true);
  });

  it("different idempotency keys execute independently (no false-positive deduplication)", () => {
    const executor = new RecoveryExecutor();
    const a = executor.execute(makeRequest({ idempotencyKey: "pay_1:case_1:1" }));
    const b = executor.execute(makeRequest({ idempotencyKey: "pay_1:case_1:2", attemptNumber: 2 }));
    expect(a.idempotent).toBe(false);
    expect(b.idempotent).toBe(false);
    expect(executor.executedCount()).toBe(2);
  });

  it("hasResult() correctly reports whether a key has been resolved", () => {
    const executor = new RecoveryExecutor();
    expect(executor.hasResult("pay_1:case_1:1")).toBe(false);
    executor.execute(makeRequest());
    expect(executor.hasResult("pay_1:case_1:1")).toBe(true);
  });

  it("idempotency also applies to skipped (STOP/ESCALATE) and rejected results, not just executed ones", () => {
    const executor = new RecoveryExecutor();
    const stopFirst = executor.execute(makeRequest({ action: "STOP" }));
    const stopSecond = executor.execute(makeRequest({ action: "STOP" }));
    expect(stopFirst.idempotent).toBe(false);
    expect(stopSecond.idempotent).toBe(true);
    expect(stopSecond.status).toBe("skipped");
  });

  it("the idempotency key format paymentId:recoveryCaseId:attemptNumber uniquely scopes execution per attempt", () => {
    const executor = new RecoveryExecutor();
    const key = (paymentId: string, caseId: string, attempt: number) => `${paymentId}:${caseId}:${attempt}`;

    executor.execute(makeRequest({ idempotencyKey: key("pay_1", "case_1", 1), paymentId: "pay_1", recoveryCaseId: "case_1", attemptNumber: 1 }));
    executor.execute(makeRequest({ idempotencyKey: key("pay_2", "case_2", 1), paymentId: "pay_2", recoveryCaseId: "case_2", attemptNumber: 1 }));
    executor.execute(makeRequest({ idempotencyKey: key("pay_1", "case_1", 2), paymentId: "pay_1", recoveryCaseId: "case_1", attemptNumber: 2 }));

    // Three genuinely distinct attempts (different payment or different
    // attempt number) -> three distinct executions.
    expect(executor.executedCount()).toBe(3);
  });
});
