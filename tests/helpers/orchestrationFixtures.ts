// Shared fixture builders for orchestrator/executor integration tests.
// Not a test file itself — imported by orchestrator test suites.

import { SqliteRepository } from "../../src/db/repository.js";
import type {
  Customer,
  FailureCategory,
  GroundTruth,
  Merchant,
  Payment,
  RecoveryAttempt,
  RecoveryCase,
} from "../../src/domain/types.js";

export const FIXTURE_RUN_ID = "run_orchestration_fixture";
export const FIXTURE_MERCHANT_ID = "mch_fixture";
export const FIXTURE_CUSTOMER_ID = "cus_fixture";

export function newFixtureRepo(): SqliteRepository {
  const repo = new SqliteRepository(":memory:");
  repo.insertSimulationRun({
    id: FIXTURE_RUN_ID,
    seed: "orchestration-fixture-seed",
    generatorVersion: "1.0.0",
    datasetVersion: "r2s-dataset-v1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  const merchant: Merchant = {
    id: FIXTURE_MERCHANT_ID,
    name: "Fixture Merchant",
    category: "ecommerce",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    simulationRunId: FIXTURE_RUN_ID,
  };
  repo.insertMerchants([merchant]);
  const customer: Customer = {
    id: FIXTURE_CUSTOMER_ID,
    name: "Fixture Customer",
    email: "fixture@example-mail.test",
    riskProfile: "medium",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    merchantId: FIXTURE_MERCHANT_ID,
    simulationRunId: FIXTURE_RUN_ID,
  };
  repo.insertCustomers([customer]);
  return repo;
}

/** Inserts a failed Payment + RecoveryCase (+ GroundTruth, hand-specified
 * so tests can force deterministic recoverable/non-recoverable outcomes
 * without depending on the seeded generator) + optional prior
 * RecoveryAttempts. Returns the ids needed by the orchestrator. */
export function insertFailedPaymentFixture(
  repo: SqliteRepository,
  params: {
    paymentId: string;
    amount?: number;
    failureCategory: FailureCategory;
    groundTruth: Omit<GroundTruth, "id" | "paymentId" | "simulationRunId">;
    priorAttempts?: number;
    priorAttemptOutcome?: "success" | "failure";
    caseOpenedAt?: Date;
    recoveryWindowDays?: number;
  },
): { paymentId: string; recoveryCaseId: string } {
  const {
    paymentId,
    amount = 100000,
    failureCategory,
    groundTruth,
    priorAttempts = 0,
    priorAttemptOutcome = "failure",
    caseOpenedAt = new Date("2026-09-01T00:00:00.000Z"),
    recoveryWindowDays = 7,
  } = params;

  const payment: Payment = {
    id: paymentId,
    amount,
    currency: "INR",
    status: priorAttempts > 0 ? "retrying" : "failed",
    failureCategory,
    attemptCount: priorAttempts,
    createdAt: caseOpenedAt,
    updatedAt: caseOpenedAt,
    merchantId: FIXTURE_MERCHANT_ID,
    customerId: FIXTURE_CUSTOMER_ID,
    simulationRunId: FIXTURE_RUN_ID,
  };
  repo.insertPayments([payment]);

  const recoveryCaseId = `case_${paymentId}`;
  const recoveryWindowEndsAt = new Date(
    caseOpenedAt.getTime() + recoveryWindowDays * 24 * 60 * 60 * 1000,
  );
  const recoveryCase: RecoveryCase = {
    id: recoveryCaseId,
    status: priorAttempts > 0 ? "in_progress" : "open",
    openedAt: caseOpenedAt,
    closedAt: null,
    recoveryWindowEndsAt,
    paymentId,
    simulationRunId: FIXTURE_RUN_ID,
  };
  repo.insertRecoveryCase(recoveryCase);

  repo.insertGroundTruths([
    {
      id: `gt_${paymentId}`,
      paymentId,
      simulationRunId: FIXTURE_RUN_ID,
      ...groundTruth,
    },
  ]);

  for (let i = 1; i <= priorAttempts; i++) {
    const attempt: RecoveryAttempt = {
      id: `att_${paymentId}_${i}`,
      attemptNumber: i,
      strategy: "baseline_deterministic_retry",
      scheduledAt: caseOpenedAt,
      executedAt: caseOpenedAt,
      outcome: priorAttemptOutcome,
      amountRecovered: priorAttemptOutcome === "success" ? amount : null,
      recoveryCaseId,
      simulationRunId: FIXTURE_RUN_ID,
    };
    repo.insertRecoveryAttempt(attempt);
  }

  return { paymentId, recoveryCaseId };
}
