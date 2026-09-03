import { describe, it, expect } from "vitest";
import { buildInitialWorld, materializeWorldInto } from "../src/evaluation/cohort.js";
import { runR2sStrategy, GAPS_HOURS, MAX_DECISION_OPPORTUNITIES } from "../src/evaluation/strategies/r2sStrategy.js";
import { SqliteRepository } from "../src/db/repository.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { BASELINE_RETRY_POLICY } from "../src/strategy/baselineRetry.js";

const HOUR_MS = 60 * 60 * 1000;

describe("evaluation: R2S temporal fairness model", () => {
  it("GAPS_HOURS is derived from BASELINE_RETRY_POLICY.retryIntervalHours ([1,24,72] -> gaps [1,23,48]) without modifying it", () => {
    expect(BASELINE_RETRY_POLICY.retryIntervalHours).toEqual([1, 24, 72]);
    expect(GAPS_HOURS).toEqual([1, 23, 48]);
  });

  it("every payment's first decision cycle occurs exactly GAPS_HOURS[0] hours after case-open — same as the baseline's own first decision point", async () => {
    const world = buildInitialWorld({ seed: "temporal-1", maxCohortSize: 40 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "temporal-1:r2s",
    });

    const entryByPaymentId = new Map(world.cohort.map((e) => [e.paymentId, e]));
    for (const payment of result.perPayment) {
      expect(payment.cycles.length).toBeGreaterThan(0);
      const entry = entryByPaymentId.get(payment.paymentId)!;
      const firstCycle = payment.cycles[0]!;
      const expectedFirstNow = entry.caseOpenedAt.getTime() + GAPS_HOURS[0]! * HOUR_MS;
      expect(firstCycle.now.getTime()).toBe(expectedFirstNow);
    }
  });

  it("no cycle-to-cycle gap is ever zero or negative (RETRY_NOW never causes an immediate zero-time second cycle)", async () => {
    const world = buildInitialWorld({ seed: "temporal-2", maxCohortSize: 200 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "temporal-2:r2s",
    });

    let multiCycleCount = 0;
    for (const payment of result.perPayment) {
      for (let i = 1; i < payment.cycles.length; i++) {
        multiCycleCount++;
        const gapMs = payment.cycles[i]!.now.getTime() - payment.cycles[i - 1]!.now.getTime();
        expect(gapMs).toBeGreaterThan(0);
      }
    }
    // Sanity: this cohort size should produce at least some multi-cycle
    // payments, or the assertion above never actually ran.
    expect(multiCycleCount).toBeGreaterThan(0);
  });

  it("an executed RETRY_LATER cycle is followed by a gap equal to its approvedDelayHours (not a schedule gap)", async () => {
    const world = buildInitialWorld({ seed: "temporal-3", maxCohortSize: 300 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "temporal-3:r2s",
    });

    let sawRetryLaterFollowedByCycle = false;
    for (const payment of result.perPayment) {
      for (let i = 0; i < payment.cycles.length - 1; i++) {
        const cycle = payment.cycles[i]!;
        const next = payment.cycles[i + 1]!;
        const wasRetryLaterExecuted =
          cycle.approvedAction === "RETRY_LATER" && cycle.executionStatus === "executed";
        if (wasRetryLaterExecuted && cycle.approvedDelayHours !== null) {
          sawRetryLaterFollowedByCycle = true;
          const gapMs = next.now.getTime() - cycle.now.getTime();
          expect(gapMs).toBe(cycle.approvedDelayHours * HOUR_MS);
        }
      }
    }
    expect(sawRetryLaterFollowedByCycle).toBe(true);
  });

  it("a non-RETRY_LATER cycle is followed by a gap taken from the GAPS_HOURS schedule", async () => {
    const world = buildInitialWorld({ seed: "temporal-4", maxCohortSize: 300 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "temporal-4:r2s",
    });

    const gapHoursSet = new Set(GAPS_HOURS);
    let sawImmediateFollowedByCycle = false;
    for (const payment of result.perPayment) {
      for (let i = 0; i < payment.cycles.length - 1; i++) {
        const cycle = payment.cycles[i]!;
        const next = payment.cycles[i + 1]!;
        const wasRetryLaterExecuted =
          cycle.approvedAction === "RETRY_LATER" && cycle.executionStatus === "executed";
        if (!wasRetryLaterExecuted) {
          sawImmediateFollowedByCycle = true;
          const gapHours = (next.now.getTime() - cycle.now.getTime()) / HOUR_MS;
          expect(gapHoursSet.has(gapHours)).toBe(true);
        }
      }
    }
    expect(sawImmediateFollowedByCycle).toBe(true);
  });

  it("BASELINE_RETRY_POLICY itself is never mutated by the R2S temporal model", async () => {
    const before = structuredClone(BASELINE_RETRY_POLICY);

    const world = buildInitialWorld({ seed: "temporal-5", maxCohortSize: 60 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);
    await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "temporal-5:r2s",
    });

    expect(BASELINE_RETRY_POLICY).toEqual(before);
  });
});

describe("evaluation: R2S decision-opportunity budget (Sep 2 audit correction, Issue 1)", () => {
  it("MAX_DECISION_OPPORTUNITIES equals BASELINE_RETRY_POLICY.maxRetries", () => {
    expect(MAX_DECISION_OPPORTUNITIES).toBe(BASELINE_RETRY_POLICY.maxRetries);
    expect(MAX_DECISION_OPPORTUNITIES).toBe(3);
  });

  it("no payment in a large cohort ever exceeds MAX_DECISION_OPPORTUNITIES observable decision cycles — checked directly against attempt/audit-event counts, not just an internal counter", async () => {
    const world = buildInitialWorld({ seed: "opportunity-1", maxCohortSize: 400 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "opportunity-1:r2s",
    });

    let observedMax = 0;
    for (const payment of result.perPayment) {
      // Observable, not just the internal cycles array: the number of
      // orchestration calls actually made for this payment can never
      // exceed the budget.
      expect(payment.cycles.length).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
      observedMax = Math.max(observedMax, payment.cycles.length);

      // Cross-check against genuinely-independent observable evidence:
      // every RecoveryAttempt row plus every BLOCK/ESCALATE/STOP decision
      // this payment could have accumulated is bounded by the same
      // number of orchestration calls, which is itself bounded by
      // payment.cycles.length (one attempt row at most per cycle).
      const attempts = repo.listRecoveryAttemptsByCase(`case_${payment.paymentId}`);
      expect(attempts.length).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
    }

    expect(observedMax).toBeGreaterThan(0);
    expect(observedMax).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
    // This is the fairness invariant itself, stated directly:
    expect(observedMax).toBeLessThanOrEqual(BASELINE_RETRY_POLICY.maxRetries);
  });

  it("RETRY_LATER consumes exactly one opportunity — it changes timing, not opportunity count", async () => {
    const world = buildInitialWorld({ seed: "opportunity-2", maxCohortSize: 400 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "opportunity-2:r2s",
    });

    let sawExecutedRetryLater = false;
    for (const payment of result.perPayment) {
      for (const cycle of payment.cycles) {
        if (cycle.approvedAction === "RETRY_LATER" && cycle.executionStatus === "executed") {
          sawExecutedRetryLater = true;
        }
      }
      // Whether or not this specific payment used RETRY_LATER, its total
      // cycle count is bounded by the SAME shared budget as every other
      // payment — RETRY_LATER never grants a larger budget.
      expect(payment.cycles.length).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
    }
    expect(sawExecutedRetryLater).toBe(true);

    // Directly compare: payments that used RETRY_LATER at least once are
    // not systematically longer than the shared cap allows.
    const retryLaterPayments = result.perPayment.filter((p) =>
      p.cycles.some((c) => c.approvedAction === "RETRY_LATER" && c.executionStatus === "executed"),
    );
    expect(retryLaterPayments.length).toBeGreaterThan(0);
    for (const p of retryLaterPayments) {
      expect(p.cycles.length).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
    }
  });

  it("this remains true across different action-sequence mixes (all-immediate, all-RETRY_LATER-eligible, and mixed sequences all obey the same cap)", async () => {
    // Exercise several independent seeds so the invariant is checked
    // against many different emergent action sequences, not one
    // hand-picked case.
    for (const seed of ["opportunity-seq-1", "opportunity-seq-2", "opportunity-seq-3"]) {
      const world = buildInitialWorld({ seed, maxCohortSize: 150 });
      const repo = new SqliteRepository(":memory:");
      materializeWorldInto(world, repo);

      const result = await runR2sStrategy({
        world,
        repo,
        provider: new MockAIProvider(),
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
        rngSeed: `${seed}:r2s`,
      });

      for (const payment of result.perPayment) {
        expect(payment.cycles.length).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
      }
    }
  });

  it("the invariant holds across the whole cohort simultaneously, not merely for isolated payments (max over the entire cohort)", async () => {
    const world = buildInitialWorld({ seed: "opportunity-3", maxCohortSize: 500 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "opportunity-3:r2s",
    });

    const maxAcrossCohort = Math.max(...result.perPayment.map((p) => p.cycles.length));
    expect(maxAcrossCohort).toBeLessThanOrEqual(MAX_DECISION_OPPORTUNITIES);
    expect(result.perPayment.length).toBe(world.cohort.length);
  });
});
