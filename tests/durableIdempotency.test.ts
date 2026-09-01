import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { runRecoveryOrchestration, resolvePersistedAttemptResult } from "../src/orchestration/recoveryOrchestrator.js";
import { RecoveryExecutor } from "../src/execution/recoveryExecutor.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { createRng } from "../src/simulation/rng.js";
import { IdSequence } from "../src/simulation/ids.js";
import { SqliteRepository } from "../src/db/repository.js";
import type { AIProvider } from "../src/ai/provider.js";
import type { AgentDecision } from "../src/ai/types.js";
import type { RecoveryAttempt as RecoveryAttemptType } from "../src/domain/types.js";
import {
  newFixtureRepo,
  insertFailedPaymentFixture,
  FIXTURE_RUN_ID,
  FIXTURE_MERCHANT_ID,
  FIXTURE_CUSTOMER_ID,
} from "./helpers/orchestrationFixtures.js";

class FixedProvider implements AIProvider {
  constructor(private decision: AgentDecision) {}
  async generateDecision(): Promise<AgentDecision> {
    return this.decision;
  }
}

let openRepos: SqliteRepository[] = [];
function trackedRepo(): SqliteRepository {
  const repo = newFixtureRepo();
  openRepos.push(repo);
  return repo;
}
afterEach(() => {
  for (const r of openRepos) r.close();
  openRepos = [];
});

const provider = new FixedProvider({
  action: "RETRY_NOW",
  confidence: 0.9,
  reasoning: "Fresh temporary failure.",
});

describe("Sep 1 correction — Issue 3: durable (SQLite-backed) idempotency", () => {
  it("repository.getRecoveryAttemptByIdempotencyKey returns null before any attempt exists", () => {
    const repo = trackedRepo();
    expect(repo.getRecoveryAttemptByIdempotencyKey("does_not_exist")).toBeNull();
  });

  it("repository.getRecoveryAttemptByIdempotencyKey finds a persisted attempt after orchestration", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_durable_1",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const result = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_durable_1",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("durable-lookup-1"),
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    const key = result.execution!.idempotencyKey;
    const found = repo.getRecoveryAttemptByIdempotencyKey(key);
    expect(found).not.toBeNull();
    expect(found!.idempotencyKey).toBe(key);
    expect(found!.action).toBe("RETRY_NOW");
  });

  it("(1) same key in the same process: the SECOND orchestration call is idempotent and does not execute again", async () => {
    const repoA = trackedRepo();
    const repoB = trackedRepo();
    for (const repo of [repoA, repoB]) {
      insertFailedPaymentFixture(repo, {
        paymentId: "pay_same_process",
        failureCategory: "temporary_bank_failure",
        groundTruth: {
          recoverable: true,
          recoveryProbability: 0.9,
          bestAction: "retry_immediate",
          recoveredAmount: 100000,
        },
      });
    }

    const executor = new RecoveryExecutor();
    const ids = new IdSequence();
    const now = new Date("2026-09-01T00:00:00.000Z");

    const first = await runRecoveryOrchestration({
      repo: repoA,
      provider,
      paymentId: "pay_same_process",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("same-process-1"),
      now,
      executor,
      ids,
    });

    const second = await runRecoveryOrchestration({
      repo: repoB,
      provider,
      paymentId: "pay_same_process",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("same-process-1"),
      now,
      executor,
      ids,
    });

    expect(first.execution?.idempotent).toBe(false);
    expect(second.execution?.idempotent).toBe(true);
    expect(second.execution?.idempotencyKey).toBe(first.execution?.idempotencyKey);
    expect(second.outcome).toBeNull();
    expect(executor.executedCount()).toBe(1);
  });

  it("(2) same key after constructing a NEW executor/orchestrator call against the SAME database: still idempotent (the in-memory cache is gone, the DB check catches it)", async () => {
    // Models the realistic crash scenario durable idempotency exists for:
    // "process 1" reserves an attempt (durably persists a "pending"
    // RecoveryAttempt row) and then crashes before ever calling/completing
    // the executor — so nothing in-memory survives, only the durable
    // reservation on disk. A FILE-BASED SQLite database (not ":memory:",
    // which cannot be reopened as a fresh connection) is used so the
    // second call genuinely reopens a brand-new connection to the same
    // physical database, exactly as a restarted process would.
    const dbPath = join(tmpdir(), `r2s-durable-idempotency-${Date.now()}-${process.pid}.db`);
    let repoInstance1: SqliteRepository | null = null;
    let repoInstance2: SqliteRepository | null = null;
    try {
      repoInstance1 = new SqliteRepository(dbPath);
      repoInstance1.insertSimulationRun({
        id: FIXTURE_RUN_ID,
        seed: "durable-file-seed",
        generatorVersion: "1.0.0",
        datasetVersion: "r2s-dataset-v1",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      repoInstance1.insertMerchants([
        {
          id: FIXTURE_MERCHANT_ID,
          name: "Fixture Merchant",
          category: "ecommerce",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          simulationRunId: FIXTURE_RUN_ID,
        },
      ]);
      repoInstance1.insertCustomers([
        {
          id: FIXTURE_CUSTOMER_ID,
          name: "Fixture Customer",
          email: "fixture@example-mail.test",
          riskProfile: "medium",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          merchantId: FIXTURE_MERCHANT_ID,
          simulationRunId: FIXTURE_RUN_ID,
        },
      ]);
      insertFailedPaymentFixture(repoInstance1, {
        paymentId: "pay_new_executor",
        failureCategory: "temporary_bank_failure",
        groundTruth: {
          recoverable: true,
          recoveryProbability: 0.9,
          bestAction: "retry_immediate",
          recoveredAmount: 100000,
        },
      });

      const now = new Date("2026-09-01T00:00:00.000Z");
      const idempotencyKey = "pay_new_executor:case_pay_new_executor:1";

      // "Process 1": reserves attempt 1 (as the orchestrator itself would,
      // right before calling the executor — see recoveryOrchestrator.ts's
      // reservation step) and then crashes — no executor call, no
      // completion, nothing in memory survives.
      repoInstance1.insertRecoveryAttempt({
        id: `att_${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        attemptNumber: 1,
        strategy: "ai_orchestrated",
        action: "RETRY_NOW",
        idempotencyKey,
        scheduledAt: now,
        executedAt: null,
        outcome: "pending",
        amountRecovered: null,
        recoveryCaseId: "case_pay_new_executor",
        simulationRunId: FIXTURE_RUN_ID,
      });
      repoInstance1.close();

      // "Process 2": a brand new SqliteRepository connection to the SAME
      // FILE, a brand new RecoveryExecutor, a brand new IdSequence.
      // Receives (or independently re-derives) the same logical request.
      repoInstance2 = new SqliteRepository(dbPath);
      const second = await runRecoveryOrchestration({
        repo: repoInstance2,
        provider,
        paymentId: "pay_new_executor",
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
        rng: createRng("new-executor-1"),
        now,
        executor: new RecoveryExecutor(),
        ids: new IdSequence(),
      });

      // FINAL IDEMPOTENCY CORRECTION: a persisted-but-unsettled ("pending")
      // reservation must NEVER be reported as "executed" — that would
      // falsely claim the action ran when only a reservation exists. The
      // corrected status is "pending".
      expect(second.execution?.status).toBe("pending");
      expect(second.execution?.status).not.toBe("executed");
      expect(second.execution?.idempotent).toBe(true);
      expect(second.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(second.execution?.executedAt).toBeNull();
      expect(second.outcome).toBeNull();
      expect(second.events.some((e) => e.eventType === "action_executed")).toBe(false);
      expect(second.stage).toBe("completed");

      // The persisted row itself remains genuinely "pending" — the second
      // call did not settle it, execute anything, or fabricate an outcome.
      const stillPending = repoInstance2.getRecoveryAttemptByIdempotencyKey(idempotencyKey);
      expect(stillPending?.outcome).toBe("pending");
      expect(stillPending?.executedAt).toBeNull();

      // Still only ONE RecoveryAttempt row for this key, durably, on disk
      // — the process-2 call did not insert a second one.
      const allAttempts = repoInstance2
        .listRecoveryAttemptsByCase("case_pay_new_executor")
        .filter((a) => a.idempotencyKey === idempotencyKey);
      expect(allAttempts).toHaveLength(1);
    } finally {
      repoInstance2?.close();
      try {
        unlinkSync(dbPath);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("(3) different keys execute independently", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_diff_key_a",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_diff_key_b",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const executor = new RecoveryExecutor();
    const ids = new IdSequence();
    const now = new Date("2026-09-01T00:00:00.000Z");

    const a = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_diff_key_a",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("diff-key-a"),
      now,
      executor,
      ids,
    });
    const b = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_diff_key_b",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("diff-key-b"),
      now,
      executor,
      ids,
    });

    expect(a.execution?.idempotencyKey).not.toBe(b.execution?.idempotencyKey);
    expect(a.execution?.idempotent).toBe(false);
    expect(b.execution?.idempotent).toBe(false);
    expect(executor.executedCount()).toBe(2);
  });

  it("(4) a duplicate idempotencyKey cannot create two RecoveryAttempt records — the database itself rejects it", () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_unique_constraint",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const attemptBase = {
      attemptNumber: 1,
      strategy: "ai_orchestrated",
      action: "RETRY_NOW" as const,
      idempotencyKey: "pay_unique_constraint:case_pay_unique_constraint:1",
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      executedAt: new Date("2026-09-01T00:00:00.000Z"),
      outcome: "success" as const,
      amountRecovered: 100000,
      recoveryCaseId: "case_pay_unique_constraint",
      simulationRunId: "run_orchestration_fixture",
    };

    repo.insertRecoveryAttempt({ id: "att_1", ...attemptBase });

    // A second row with the SAME idempotencyKey must be rejected by the
    // database's UNIQUE constraint (a different primary-key id, but the
    // same idempotencyKey — proving the constraint, not just the PK, is
    // what's enforced).
    expect(() => repo.insertRecoveryAttempt({ id: "att_2", ...attemptBase })).toThrow();
  });

  it("(4b) null idempotencyKey values (Aug 29 baseline attempts) do NOT collide with each other under the unique constraint", () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_null_keys",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const base = {
      strategy: "baseline_deterministic_retry",
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      executedAt: new Date("2026-09-01T00:00:00.000Z"),
      outcome: "failure" as const,
      amountRecovered: null,
      recoveryCaseId: "case_pay_null_keys",
      simulationRunId: "run_orchestration_fixture",
    };

    // No `action`/`idempotencyKey` at all — mirrors exactly what Aug 29's
    // runSimulation.ts inserts. Multiple such rows must coexist fine.
    expect(() =>
      repo.insertRecoveryAttempt({ id: "att_null_1", attemptNumber: 1, ...base }),
    ).not.toThrow();
    expect(() =>
      repo.insertRecoveryAttempt({ id: "att_null_2", attemptNumber: 2, ...base }),
    ).not.toThrow();
    expect(() =>
      repo.insertRecoveryAttempt({ id: "att_null_3", attemptNumber: 3, ...base }),
    ).not.toThrow();
  });

  it("a durable idempotent replay does not re-run outcome simulation or emit a second execution/outcome event", async () => {
    const repo = trackedRepo();
    insertFailedPaymentFixture(repo, {
      paymentId: "pay_durable_no_dup_events",
      failureCategory: "temporary_bank_failure",
      groundTruth: {
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
      },
    });

    const now = new Date("2026-09-01T00:00:00.000Z");

    await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_durable_no_dup_events",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("no-dup-events-1"),
      now,
      executor: new RecoveryExecutor(),
      ids: new IdSequence(),
    });

    const replay = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId: "pay_durable_no_dup_events",
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("no-dup-events-1"),
      now: new Date("2026-09-01T00:05:00.000Z"),
      executor: new RecoveryExecutor(), // fresh — forces the DB path
      ids: new IdSequence(),
    });

    // The replay's own event list contains only the (freshly re-run)
    // AI/policy decision events — no action_executed, no
    // payment_recovered/recovery_failed, since nothing was actually
    // (re-)executed or (re-)evaluated for outcome.
    expect(replay.events.some((e) => e.eventType === "action_executed")).toBe(false);
    expect(replay.events.some((e) => e.eventType === "payment_recovered")).toBe(false);
    expect(replay.events.some((e) => e.eventType === "recovery_failed")).toBe(false);
    expect(replay.outcome).toBeNull();
  });
});

describe("Sep 1 final idempotency correction — a persisted pending attempt is never reported as executed", () => {
  it("genuine process-restart integration test: a real crash after reservation (before settlement) leaves a durable 'pending' record; a fresh orchestrator call recognizes it and does NOT claim execution happened", async () => {
    // 1. Create a repository/database.
    const repo = trackedRepo();

    // 2. Create a valid failed payment/recovery case — deliberately
    // WITHOUT ground truth yet, so that when orchestration reaches the
    // outcome-simulation step (which requires ground truth to exist), it
    // genuinely throws. This reproduces "the process crashed after
    // reserving the attempt but before completing it" using REAL code
    // execution, not a hand-simulated shortcut.
    const paymentId = "pay_genuine_crash";
    const recoveryCaseId = `case_${paymentId}`;
    repo.insertPayments([
      {
        id: paymentId,
        amount: 100000,
        currency: "INR",
        status: "failed",
        failureCategory: "temporary_bank_failure",
        attemptCount: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        merchantId: FIXTURE_MERCHANT_ID,
        customerId: FIXTURE_CUSTOMER_ID,
        simulationRunId: FIXTURE_RUN_ID,
      },
    ]);
    repo.insertRecoveryCase({
      id: recoveryCaseId,
      status: "open",
      openedAt: new Date("2026-09-01T00:00:00.000Z"),
      closedAt: null,
      recoveryWindowEndsAt: new Date("2026-09-08T00:00:00.000Z"),
      paymentId,
      simulationRunId: FIXTURE_RUN_ID,
    });
    // No GroundTruth row inserted yet — see above.

    const now = new Date("2026-09-01T00:00:00.000Z");

    // 3. Start orchestration with a deterministic executor / controlled
    // execution path. This call reserves the attempt, calls the executor
    // (which genuinely executes RETRY_NOW), and THEN throws when it can't
    // find ground truth to simulate the outcome — modelling a crash that
    // happens after the durable reservation but before settlement.
    await expect(
      runRecoveryOrchestration({
        repo,
        provider,
        paymentId,
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
        rng: createRng("genuine-crash-1"),
        now,
        executor: new RecoveryExecutor(),
        ids: new IdSequence(),
      }),
    ).rejects.toThrow(/no GroundTruth found/);

    // 4. Ensure a pending RecoveryAttempt reservation exists — durably
    // persisted before the throw.
    const idempotencyKey = `${paymentId}:${recoveryCaseId}:1`;
    const reserved = repo.getRecoveryAttemptByIdempotencyKey(idempotencyKey);
    expect(reserved).not.toBeNull();
    expect(reserved?.outcome).toBe("pending");
    expect(reserved?.executedAt).toBeNull();

    // The underlying data issue is now fixed (as it eventually would be in
    // a real system) — the point under test is the RETRY's behavior when
    // it encounters the pending reservation, not the original failure.
    repo.insertGroundTruths([
      {
        id: `gt_${paymentId}`,
        paymentId,
        recoverable: true,
        recoveryProbability: 0.9,
        bestAction: "retry_immediate",
        recoveredAmount: 100000,
        simulationRunId: FIXTURE_RUN_ID,
      },
    ]);

    // 5. Construct a NEW RecoveryExecutor instance.
    const freshExecutor = new RecoveryExecutor();

    // 6 & 7. Construct a NEW orchestration call against the SAME SQLite
    // database, submitting (independently re-deriving) the SAME
    // idempotency key — attemptNumber reuses the pending reservation's
    // number rather than incrementing past it (see
    // recoveryOrchestrator.ts's pending-attempt-number reuse logic).
    const retryResult = await runRecoveryOrchestration({
      repo,
      provider,
      paymentId,
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rng: createRng("genuine-crash-1"),
      now: new Date("2026-09-01T00:10:00.000Z"),
      executor: freshExecutor,
      ids: new IdSequence(),
    });

    // 8. Verify every required outcome.
    expect(retryResult.execution?.idempotencyKey).toBe(idempotencyKey);

    // RecoveryAttempt row count remains 1.
    const allAttempts = repo
      .listRecoveryAttemptsByCase(recoveryCaseId)
      .filter((a) => a.idempotencyKey === idempotencyKey);
    expect(allAttempts).toHaveLength(1);

    // No second execution occurs (the fresh executor never executed anything).
    expect(freshExecutor.executedCount()).toBe(0);

    // No second outcome simulation occurs.
    expect(retryResult.outcome).toBeNull();

    // No action_executed event is emitted by the second call.
    expect(retryResult.events.some((e) => e.eventType === "action_executed")).toBe(false);

    // Persisted pending state remains pending.
    const stillPending = repo.getRecoveryAttemptByIdempotencyKey(idempotencyKey);
    expect(stillPending?.outcome).toBe("pending");
    expect(stillPending?.executedAt).toBeNull();

    // Returned result does NOT claim execution happened.
    expect(retryResult.execution?.status).toBe("pending");
    expect(retryResult.execution?.status).not.toBe("executed");
    expect(retryResult.execution?.idempotent).toBe(true);
    expect(retryResult.stage).toBe("completed");
  });

  it("a genuinely SETTLED persisted attempt still correctly reports status 'executed' and preserves its known outcome (direct unit test of the extracted resolution logic)", () => {
    // As established above, reaching this branch via a live, sequential
    // orchestrator call is not generally possible: once ANY attempt is
    // persisted for a case, the orchestrator's own next-attempt-number
    // computation always advances past it, so a fresh call can never
    // recompute a key matching an already-settled row (this is exactly
    // WHY the "pending" branch — reachable via the pending-reuse path —
    // was the real bug, and the "settled" branch is a defensive
    // safeguard for genuinely concurrent duplicate requests). It is
    // therefore tested directly here, against the same pure function
    // (`resolvePersistedAttemptResult`) the orchestrator itself calls.
    const settledSuccess: RecoveryAttemptType = {
      id: "att_1",
      attemptNumber: 1,
      strategy: "ai_orchestrated",
      action: "RETRY_NOW",
      idempotencyKey: "pay_x:case_x:1",
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      executedAt: new Date("2026-09-01T00:00:05.000Z"),
      outcome: "success",
      amountRecovered: 75000,
      recoveryCaseId: "case_x",
      simulationRunId: "run_x",
    };

    const { execution, outcome } = resolvePersistedAttemptResult(settledSuccess, {
      idempotencyKey: "pay_x:case_x:1",
      paymentId: "pay_x",
      recoveryCaseId: "case_x",
      attemptNumber: 1,
      fallbackAction: "STOP",
    });

    expect(execution.status).toBe("executed");
    expect(execution.idempotent).toBe(true);
    expect(execution.executedAt).toEqual(settledSuccess.executedAt);
    expect(execution.action).toBe("RETRY_NOW");
    expect(outcome).not.toBeNull();
    expect(outcome?.success).toBe(true);
    expect(outcome?.amountRecovered).toBe(75000);
  });

  it("a genuinely SETTLED (failed) persisted attempt preserves its failure outcome, not just success", () => {
    const settledFailure: RecoveryAttemptType = {
      id: "att_2",
      attemptNumber: 1,
      strategy: "ai_orchestrated",
      action: "SEND_PAYMENT_LINK",
      idempotencyKey: "pay_y:case_y:1",
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      executedAt: new Date("2026-09-01T00:00:05.000Z"),
      outcome: "failure",
      amountRecovered: null,
      recoveryCaseId: "case_y",
      simulationRunId: "run_y",
    };

    const { execution, outcome } = resolvePersistedAttemptResult(settledFailure, {
      idempotencyKey: "pay_y:case_y:1",
      paymentId: "pay_y",
      recoveryCaseId: "case_y",
      attemptNumber: 1,
      fallbackAction: "STOP",
    });

    expect(execution.status).toBe("executed");
    expect(outcome).not.toBeNull();
    expect(outcome?.success).toBe(false);
    expect(outcome?.amountRecovered).toBe(0);
  });

  it("resolvePersistedAttemptResult correctly distinguishes pending from settled for the identical shape of input, differing only in outcome/executedAt", () => {
    const base = {
      id: "att_3",
      attemptNumber: 1,
      strategy: "ai_orchestrated",
      action: "RETRY_NOW" as const,
      idempotencyKey: "pay_z:case_z:1",
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
      recoveryCaseId: "case_z",
      simulationRunId: "run_z",
    };
    const params = {
      idempotencyKey: "pay_z:case_z:1",
      paymentId: "pay_z",
      recoveryCaseId: "case_z",
      attemptNumber: 1,
      fallbackAction: "STOP" as const,
    };

    const pendingResult = resolvePersistedAttemptResult(
      { ...base, executedAt: null, outcome: "pending", amountRecovered: null },
      params,
    );
    expect(pendingResult.execution.status).toBe("pending");
    expect(pendingResult.outcome).toBeNull();

    const settledResult = resolvePersistedAttemptResult(
      { ...base, executedAt: new Date("2026-09-01T00:00:05.000Z"), outcome: "success", amountRecovered: 50000 },
      params,
    );
    expect(settledResult.execution.status).toBe("executed");
    expect(settledResult.outcome?.success).toBe(true);
  });
});
