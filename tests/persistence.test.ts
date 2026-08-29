import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteRepository } from "../src/db/repository.js";

// These tests deliberately exercise the real node:sqlite-backed repository
// (not in-memory JS objects) so that SQLite's own constraint enforcement
// (foreign keys, unique indexes) is actually being tested, per the Aug 29
// requirement that database behavior not be bypassed with plain JS objects
// where SQLite persistence is expected to be exercised.

describe("SqliteRepository (sandbox persistence layer)", () => {
  let repo: SqliteRepository;
  const runId = "run_persistence_test";

  beforeEach(() => {
    repo = new SqliteRepository(":memory:");
    repo.insertSimulationRun({
      id: runId,
      seed: "persistence-seed",
      generatorVersion: "1.0.0",
      datasetVersion: "r2s-dataset-v1",
      createdAt: new Date("2026-08-29T00:00:00.000Z"),
    });
  });

  afterEach(() => {
    repo.close();
  });

  it("round-trips a Merchant through real SQLite storage", () => {
    repo.insertMerchants([
      {
        id: "mch_1",
        name: "Test Merchant",
        category: "ecommerce",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        simulationRunId: runId,
      },
    ]);
    const m = repo.getMerchant("mch_1");
    expect(m).not.toBeNull();
    expect(m!.name).toBe("Test Merchant");
    expect(m!.category).toBe("ecommerce");
    expect(m!.createdAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("round-trips a GroundTruth row, correctly converting boolean <-> 0/1", () => {
    repo.insertMerchants([
      { id: "mch_1", name: "M", category: "ecommerce", createdAt: new Date(), simulationRunId: runId },
    ]);
    repo.insertCustomers([
      {
        id: "cus_1",
        name: "C",
        email: "c@example-mail.test",
        riskProfile: "low",
        createdAt: new Date(),
        merchantId: "mch_1",
        simulationRunId: runId,
      },
    ]);
    repo.insertPayments([
      {
        id: "pay_1",
        amount: 10000,
        currency: "INR",
        status: "failed",
        failureCategory: "temporary_bank_failure",
        attemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        merchantId: "mch_1",
        customerId: "cus_1",
        simulationRunId: runId,
      },
    ]);
    repo.insertGroundTruths([
      {
        id: "gt_1",
        paymentId: "pay_1",
        recoverable: true,
        recoveryProbability: 0.73,
        bestAction: "retry_immediate",
        recoveredAmount: 10000,
        simulationRunId: runId,
      },
    ]);

    const gt = repo.getGroundTruthByPayment("pay_1");
    expect(gt).not.toBeNull();
    expect(gt!.recoverable).toBe(true);
    expect(typeof gt!.recoverable).toBe("boolean");
    expect(gt!.recoveryProbability).toBeCloseTo(0.73);
  });

  it("enforces foreign key constraints on Customer.merchantId", () => {
    expect(() =>
      repo.insertCustomers([
        {
          id: "cus_bad",
          name: "Bad",
          email: "bad@example-mail.test",
          riskProfile: "low",
          createdAt: new Date(),
          merchantId: "mch_nonexistent",
          simulationRunId: runId,
        },
      ]),
    ).toThrow();
  });

  it("enforces foreign key constraints on Payment.customerId", () => {
    repo.insertMerchants([
      { id: "mch_1", name: "M", category: "ecommerce", createdAt: new Date(), simulationRunId: runId },
    ]);
    expect(() =>
      repo.insertPayments([
        {
          id: "pay_bad",
          amount: 10000,
          currency: "INR",
          status: "created",
          failureCategory: null,
          attemptCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          merchantId: "mch_1",
          customerId: "cus_nonexistent",
          simulationRunId: runId,
        },
      ]),
    ).toThrow();
  });

  it("enforces the unique constraint on RecoveryCase.paymentId (one case per payment)", () => {
    repo.insertMerchants([
      { id: "mch_1", name: "M", category: "ecommerce", createdAt: new Date(), simulationRunId: runId },
    ]);
    repo.insertCustomers([
      {
        id: "cus_1",
        name: "C",
        email: "c@example-mail.test",
        riskProfile: "low",
        createdAt: new Date(),
        merchantId: "mch_1",
        simulationRunId: runId,
      },
    ]);
    repo.insertPayments([
      {
        id: "pay_1",
        amount: 10000,
        currency: "INR",
        status: "failed",
        failureCategory: "unknown",
        attemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        merchantId: "mch_1",
        customerId: "cus_1",
        simulationRunId: runId,
      },
    ]);
    const caseBase = {
      status: "open" as const,
      openedAt: new Date(),
      closedAt: null,
      recoveryWindowEndsAt: new Date(),
      paymentId: "pay_1",
      simulationRunId: runId,
    };
    repo.insertRecoveryCase({ id: "case_1", ...caseBase });
    expect(() => repo.insertRecoveryCase({ id: "case_2", ...caseBase })).toThrow();
  });

  it("countRows reflects actual inserted row counts", () => {
    expect(repo.countRows("SimulationRun")).toBe(1);
    expect(repo.countRows("Merchant")).toBe(0);
    repo.insertMerchants([
      { id: "mch_1", name: "M", category: "ecommerce", createdAt: new Date(), simulationRunId: runId },
      { id: "mch_2", name: "M2", category: "travel", createdAt: new Date(), simulationRunId: runId },
    ]);
    expect(repo.countRows("Merchant")).toBe(2);
  });

  it("updatePayment persists partial updates correctly", () => {
    repo.insertMerchants([
      { id: "mch_1", name: "M", category: "ecommerce", createdAt: new Date(), simulationRunId: runId },
    ]);
    repo.insertCustomers([
      {
        id: "cus_1",
        name: "C",
        email: "c@example-mail.test",
        riskProfile: "low",
        createdAt: new Date(),
        merchantId: "mch_1",
        simulationRunId: runId,
      },
    ]);
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    repo.insertPayments([
      {
        id: "pay_1",
        amount: 10000,
        currency: "INR",
        status: "failed",
        failureCategory: "unknown",
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt,
        merchantId: "mch_1",
        customerId: "cus_1",
        simulationRunId: runId,
      },
    ]);
    const updatedAt = new Date("2026-08-02T00:00:00.000Z");
    repo.updatePayment("pay_1", { status: "retrying", attemptCount: 1, updatedAt });
    const p = repo.getPayment("pay_1");
    expect(p!.status).toBe("retrying");
    expect(p!.attemptCount).toBe(1);
    expect(p!.updatedAt.toISOString()).toBe(updatedAt.toISOString());
    // Untouched fields remain as they were:
    expect(p!.failureCategory).toBe("unknown");
    expect(p!.amount).toBe(10000);
  });
});
