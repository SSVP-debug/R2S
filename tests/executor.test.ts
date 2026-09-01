import { describe, it, expect } from "vitest";
import { RecoveryExecutor } from "../src/execution/recoveryExecutor.js";
import { RECOVERY_ACTIONS } from "../src/ai/types.js";
import type { RecoveryAction } from "../src/ai/types.js";
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

const RECOVERY_TACTIC_ACTIONS: RecoveryAction[] = [
  "RETRY_NOW",
  "RETRY_LATER",
  "SEND_PAYMENT_LINK",
  "SEND_REMINDER",
  "OFFER_INCENTIVE",
];

describe("execution: RecoveryExecutor — valid execution", () => {
  it("executes each of the 5 genuine recovery-tactic actions with status 'executed'", () => {
    for (const action of RECOVERY_TACTIC_ACTIONS) {
      const executor = new RecoveryExecutor();
      const result = executor.execute(makeRequest({ action, idempotencyKey: `key:${action}` }));
      expect(result.status).toBe("executed");
      expect(result.executedAt).not.toBeNull();
      expect(result.idempotent).toBe(false);
    }
  });

  it("execution does not throw for any of the 7 RecoveryAction vocabulary values", () => {
    for (const action of RECOVERY_ACTIONS) {
      const executor = new RecoveryExecutor();
      expect(() => executor.execute(makeRequest({ action, idempotencyKey: `key:${action}` }))).not.toThrow();
    }
  });

  it("preserves the idempotencyKey, paymentId, recoveryCaseId, attemptNumber, and action in the result", () => {
    const executor = new RecoveryExecutor();
    const request = makeRequest({ attemptNumber: 3 });
    const result = executor.execute(request);
    expect(result.idempotencyKey).toBe(request.idempotencyKey);
    expect(result.paymentId).toBe(request.paymentId);
    expect(result.recoveryCaseId).toBe(request.recoveryCaseId);
    expect(result.attemptNumber).toBe(3);
    expect(result.action).toBe("RETRY_NOW");
  });

  it("executedCount() reflects only genuinely executed (not skipped/rejected) actions", () => {
    const executor = new RecoveryExecutor();
    executor.execute(makeRequest({ action: "RETRY_NOW", idempotencyKey: "k1" }));
    executor.execute(makeRequest({ action: "STOP", idempotencyKey: "k2" }));
    executor.execute(makeRequest({ action: "ESCALATE", idempotencyKey: "k3" }));
    executor.execute(makeRequest({ action: "SEND_REMINDER", idempotencyKey: "k4" }));
    expect(executor.executedCount()).toBe(2);
  });
});

describe("execution: RecoveryExecutor — ESCALATE/STOP are never executed (skipped)", () => {
  it("STOP is skipped, not executed — no attempt at recovery is made", () => {
    const executor = new RecoveryExecutor();
    const result = executor.execute(makeRequest({ action: "STOP" }));
    expect(result.status).toBe("skipped");
    expect(result.executedAt).toBeNull();
  });

  it("ESCALATE is skipped, not executed — no attempt at recovery is made", () => {
    const executor = new RecoveryExecutor();
    const result = executor.execute(makeRequest({ action: "ESCALATE" }));
    expect(result.status).toBe("skipped");
    expect(result.executedAt).toBeNull();
  });

  it("execution status 'executed' does not automatically mean the payment was recovered", () => {
    // Execution only means the action was attempted — recovery is decided
    // separately by the outcome simulator, which the executor never calls
    // and knows nothing about.
    const executor = new RecoveryExecutor();
    const result = executor.execute(makeRequest({ action: "RETRY_NOW" }));
    expect(result.status).toBe("executed");
    expect(result).not.toHaveProperty("success");
    expect(result).not.toHaveProperty("recovered");
  });
});

describe("execution: RecoveryExecutor — invalid action rejection", () => {
  it("rejects an action outside the RecoveryAction vocabulary", () => {
    const executor = new RecoveryExecutor();
    const result = executor.execute(
      makeRequest({ action: "TELEPORT_PAYMENT" as unknown as RecoveryAction }),
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBeDefined();
    expect(result.executedAt).toBeNull();
  });

  it("does not throw on an invalid action — returns a well-formed rejected result instead", () => {
    const executor = new RecoveryExecutor();
    expect(() =>
      executor.execute(makeRequest({ action: "" as unknown as RecoveryAction })),
    ).not.toThrow();
  });

  it("a rejected action does not count toward executedCount()", () => {
    const executor = new RecoveryExecutor();
    executor.execute(makeRequest({ action: "NOT_REAL" as unknown as RecoveryAction }));
    expect(executor.executedCount()).toBe(0);
  });
});
