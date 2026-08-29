import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteRepository } from "../src/db/repository.js";
import { buildAssessmentContext } from "../src/assessment/contextBuilder.js";
import { buildAgentPaymentContext } from "../src/domain/agentContext.js";

describe("assessment: contextBuilder", () => {
  let repo: SqliteRepository;
  const runId = "run_ctx_test";

  beforeEach(() => {
    repo = new SqliteRepository(":memory:");
    repo.insertSimulationRun({
      id: runId,
      seed: "ctx-seed",
      generatorVersion: "1.0.0",
      datasetVersion: "r2s-dataset-v1",
      createdAt: new Date("2026-08-30T00:00:00.000Z"),
    });
    repo.insertMerchants([
      {
        id: "mch_1",
        name: "Merchant One",
        category: "ecommerce",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        simulationRunId: runId,
      },
    ]);
    repo.insertCustomers([
      {
        id: "cus_1",
        name: "Customer One",
        email: "c1@example-mail.test",
        riskProfile: "medium",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        merchantId: "mch_1",
        simulationRunId: runId,
      },
    ]);
  });

  afterEach(() => {
    repo.close();
  });

  it("throws if the payment does not exist", () => {
    expect(() => buildAssessmentContext(repo, "pay_does_not_exist")).toThrow();
  });

  it("builds a context matching buildAgentPaymentContext for a payment with no recovery case", () => {
    const payment = {
      id: "pay_1",
      amount: 50000,
      currency: "INR",
      status: "created" as const,
      failureCategory: null,
      attemptCount: 0,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      merchantId: "mch_1",
      customerId: "cus_1",
      simulationRunId: runId,
    };
    repo.insertPayments([payment]);

    const context = buildAssessmentContext(repo, "pay_1");
    const expected = buildAgentPaymentContext({
      payment,
      merchant: repo.getMerchant("mch_1")!,
      customer: repo.getCustomer("cus_1")!,
      recoveryCase: null,
      priorAttempts: [],
    });
    expect(context).toEqual(expected);
    expect(context.recoveryCase).toBeNull();
    expect(context.priorAttempts).toEqual([]);
  });

  it("includes the recovery case and prior attempts when present", () => {
    const payment = {
      id: "pay_2",
      amount: 75000,
      currency: "INR",
      status: "retrying" as const,
      failureCategory: "temporary_bank_failure" as const,
      attemptCount: 1,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T01:00:00.000Z"),
      merchantId: "mch_1",
      customerId: "cus_1",
      simulationRunId: runId,
    };
    repo.insertPayments([payment]);
    repo.insertRecoveryCase({
      id: "case_2",
      status: "in_progress",
      openedAt: new Date("2026-08-02T00:00:00.000Z"),
      closedAt: null,
      recoveryWindowEndsAt: new Date("2026-08-09T00:00:00.000Z"),
      paymentId: "pay_2",
      simulationRunId: runId,
    });
    repo.insertRecoveryAttempt({
      id: "att_1",
      attemptNumber: 1,
      strategy: "baseline_deterministic_retry",
      scheduledAt: new Date("2026-08-02T01:00:00.000Z"),
      executedAt: new Date("2026-08-02T01:00:00.000Z"),
      outcome: "failure",
      amountRecovered: null,
      recoveryCaseId: "case_2",
      simulationRunId: runId,
    });

    const context = buildAssessmentContext(repo, "pay_2");
    expect(context.recoveryCase).not.toBeNull();
    expect(context.recoveryCase!.id).toBe("case_2");
    expect(context.priorAttempts).toHaveLength(1);
    expect(context.priorAttempts[0]!.outcome).toBe("failure");
  });
});
