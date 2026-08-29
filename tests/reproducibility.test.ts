import { describe, it, expect } from "vitest";
import { SqliteRepository } from "../src/db/repository.js";
import { runSimulation, type SimulationSummary } from "../src/simulation/runSimulation.js";

const FIXED_RUN_CREATED_AT = new Date("2026-08-29T00:00:00.000Z");

function fullSnapshot(repo: SqliteRepository, runId: string) {
  const payments = repo.listPaymentsBySimulationRun(runId);
  return payments.map((payment) => {
    const recoveryCase = repo.getRecoveryCaseByPayment(payment.id);
    const attempts = recoveryCase
      ? repo.listRecoveryAttemptsByCase(recoveryCase.id)
      : [];
    const groundTruth = repo.getGroundTruthByPayment(payment.id);
    const events = repo.listAuditEventsByPayment(payment.id);
    return { payment, recoveryCase, attempts, groundTruth, events };
  });
}

function runAndSnapshot(seed: string): { summary: SimulationSummary; snapshot: unknown } {
  const repo = new SqliteRepository(":memory:");
  try {
    const summary = runSimulation({ seed, repo, runCreatedAt: FIXED_RUN_CREATED_AT });
    const snapshot = fullSnapshot(repo, summary.simulationRunId);
    return { summary, snapshot };
  } finally {
    repo.close();
  }
}

describe("reproducibility", () => {
  it("produces an identical full dataset (payments, recovery cases, attempts, ground truth, events) for the same seed", () => {
    const runA = runAndSnapshot("reproducibility-seed-1");
    const runB = runAndSnapshot("reproducibility-seed-1");

    expect(runA.summary).toEqual(runB.summary);
    expect(runA.snapshot).toEqual(runB.snapshot);
  });

  it("produces a different dataset for a different seed", () => {
    const runA = runAndSnapshot("reproducibility-seed-A");
    const runB = runAndSnapshot("reproducibility-seed-B");

    expect(runA.snapshot).not.toEqual(runB.snapshot);
  });

  it("summary counts are internally consistent", () => {
    const { summary } = runAndSnapshot("reproducibility-consistency-check");
    expect(summary.recoveredCount + summary.failedFinalCount + summary.stoppedCount).toBe(
      summary.failedPaymentCount,
    );
    expect(summary.paymentCount).toBeGreaterThanOrEqual(summary.failedPaymentCount);
  });

  it("is reproducible across three independent runs, not just two", () => {
    const seed = "reproducibility-triple-check";
    const a = runAndSnapshot(seed);
    const b = runAndSnapshot(seed);
    const c = runAndSnapshot(seed);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(b.snapshot).toEqual(c.snapshot);
  });
});
