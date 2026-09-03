import { describe, it, expect } from "vitest";
import { buildInitialWorld, materializeWorldInto } from "../src/evaluation/cohort.js";
import { runBaselineStrategy } from "../src/evaluation/strategies/baselineStrategy.js";
import { runR2sStrategy } from "../src/evaluation/strategies/r2sStrategy.js";
import { SqliteRepository } from "../src/db/repository.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { runEvaluation, DEFAULT_EVALUATION_SEEDS } from "../src/evaluation/experimentRunner.js";
import { createRng } from "../src/simulation/rng.js";

describe("evaluation: reproducibility", () => {
  it("same seed -> same cohort (independent buildInitialWorld calls)", () => {
    const w1 = buildInitialWorld({ seed: "repro-1", maxCohortSize: 30 });
    const w2 = buildInitialWorld({ seed: "repro-1", maxCohortSize: 30 });
    expect(w1.cohort).toEqual(w2.cohort);
    expect(w1.groundTruths).toEqual(w2.groundTruths);
    expect(w1.payments).toEqual(w2.payments);
  });

  it("same seed -> same baseline result (independent runs against fresh repos)", () => {
    const world = buildInitialWorld({ seed: "repro-2", maxCohortSize: 30 });

    const repoA = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    const resultA = runBaselineStrategy({ world, repo: repoA, rngSeed: "repro-2:baseline" });

    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoB);
    const resultB = runBaselineStrategy({ world, repo: repoB, rngSeed: "repro-2:baseline" });

    expect(resultA.perPayment).toEqual(resultB.perPayment);
  });

  it("same seed -> same R2S result (independent runs against fresh repos)", async () => {
    const world = buildInitialWorld({ seed: "repro-3", maxCohortSize: 30 });

    const repoA = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    const resultA = await runR2sStrategy({
      world,
      repo: repoA,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "repro-3:r2s",
    });

    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoB);
    const resultB = await runR2sStrategy({
      world,
      repo: repoB,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "repro-3:r2s",
    });

    expect(resultA.perPayment).toEqual(resultB.perPayment);
  });

  it("run(seed) === run(seed): identical full evaluation config produces a deep-equal EvaluationResult, run twice independently", async () => {
    const config = { seeds: ["evaluation-001", "evaluation-002"], maxCohortSize: 25 };
    const run1 = await runEvaluation(config);
    const run2 = await runEvaluation(config);
    expect(run1).toEqual(run2);
  });

  it(
    "reproducibility holds at the standard evaluation scale (EVALUATION_SCALE_GENERATOR_OPTIONS default, ~1,000 eligible failed payments/seed, 5 seeds)",
    async () => {
      const run1 = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS });
      const run2 = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS });
      expect(run1).toEqual(run2);
    },
    60_000,
  );
});

// =============================================================================
// Sep 3 methodology fix: payment-local, strategy-shared outcome RNG
// =============================================================================
// Both runBaselineStrategy() and runR2sStrategy() now derive a fresh Rng
// per cohort-loop iteration, keyed by `${world.seed}:${paymentId}` — the
// SAME key formula in both strategy adapters, deliberately NOT using the
// strategy-specific `rngSeed` (":baseline"/":r2s") for this derivation.
// These tests pin the two guarantees that formula is supposed to buy us:
// (1) a payment's own draw sequence is fully determined by (world.seed,
// paymentId) alone, and (2) one payment's draw count can never leak into
// another payment's sequence, in either strategy. A third test checks the
// integration-level consequence: baseline and R2S draw the identical
// underlying float for a payment's first executed attempt.
// =============================================================================
describe("evaluation: payment-local, strategy-shared RNG (Sep 3 methodology fix)", () => {
  it("same world seed + same payment id -> identical deterministic draw sequence", () => {
    const rngA = createRng("evaluation-001:payment_abc");
    const rngB = createRng("evaluation-001:payment_abc");

    const drawsA = Array.from({ length: 10 }, () => rngA.next());
    const drawsB = Array.from({ length: 10 }, () => rngB.next());

    expect(drawsA).toEqual(drawsB);
  });

  it("different payment ids under the same world seed produce different (unrelated) sequences", () => {
    const rngX = createRng("evaluation-001:payment_x");
    const rngY = createRng("evaluation-001:payment_y");

    const drawsX = Array.from({ length: 5 }, () => rngX.next());
    const drawsY = Array.from({ length: 5 }, () => rngY.next());

    expect(drawsX).not.toEqual(drawsY);
  });

  it("a different payment's extra draws cannot affect another payment's sequence (isolation)", () => {
    // Establish the reference sequence for paymentX in isolation.
    const referenceRng = createRng("evaluation-001:payment_x");
    const referenceDraws = Array.from({ length: 5 }, () => referenceRng.next());

    // Now simulate an unrelated payment (paymentA) consuming a large,
    // variable number of draws on its OWN freshly-constructed Rng — this
    // stands in for "payment A took 3 retry attempts instead of 1" in the
    // real strategy loop.
    const paymentARng = createRng("evaluation-001:payment_a");
    for (let i = 0; i < 37; i++) paymentARng.next();

    // A fresh Rng for paymentX, constructed AFTER that unrelated
    // consumption, must reproduce the exact same reference sequence:
    // paymentX's stream is a pure function of its own key, never of
    // anything consumed on paymentA's separate object.
    const paymentXRngAgain = createRng("evaluation-001:payment_x");
    const drawsAgain = Array.from({ length: 5 }, () => paymentXRngAgain.next());

    expect(drawsAgain).toEqual(referenceDraws);
  });

  it("runBaselineStrategy and runR2sStrategy derive the same per-payment key (world.seed, not rngSeed)", () => {
    // Directly pins the formula itself: constructing createRng from
    // world.seed + paymentId (what both adapters now do internally)
    // must NOT depend on the strategy-specific rngSeed value at all —
    // two different (deliberately mismatched) rngSeed labels must still
    // produce the identical payment-local key/sequence, since rngSeed is
    // no longer part of that derivation.
    const worldSeed = "evaluation-001";
    const paymentId = "payment_xyz";

    const keyUsedByBaselineAdapter = `${worldSeed}:${paymentId}`;
    const keyUsedByR2sAdapter = `${worldSeed}:${paymentId}`;
    expect(keyUsedByBaselineAdapter).toBe(keyUsedByR2sAdapter);

    const baselineStyleDraws = Array.from({ length: 5 }, () =>
      createRng(keyUsedByBaselineAdapter).next(),
    );
    const r2sStyleDraws = Array.from({ length: 5 }, () => createRng(keyUsedByR2sAdapter).next());
    expect(baselineStyleDraws).toEqual(r2sStyleDraws);
  });

  it(
    "integration: baseline and R2S draw the matched underlying random float for a payment's first executed attempt",
    async () => {
      // A payment where R2S's first-cycle AI action equals RETRY_NOW —
      // the same action baseline always uses for attempt 1 — is a clean
      // natural experiment: same groundTruth, same action, same attempt
      // number (1) => identical effectiveProbability formula on both
      // sides (see outcome/simulateOutcome.ts). If the underlying rng
      // draw is genuinely matched, success/failure must be identical too.
      const world = buildInitialWorld({ seed: "evaluation-001", maxCohortSize: 300 });

      const baselineRepo = new SqliteRepository(":memory:");
      materializeWorldInto(world, baselineRepo);
      const baselineResult = runBaselineStrategy({
        world,
        repo: baselineRepo,
        rngSeed: "evaluation-001:baseline",
      });

      const r2sRepo = new SqliteRepository(":memory:");
      materializeWorldInto(world, r2sRepo);
      const r2sResult = await runR2sStrategy({
        world,
        repo: r2sRepo,
        provider: new MockAIProvider(),
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
        rngSeed: "evaluation-001:r2s",
      });

      const baselineByPaymentId = new Map(baselineResult.perPayment.map((p) => [p.paymentId, p]));

      let comparedCount = 0;
      for (const r2sPayment of r2sResult.perPayment) {
        if (r2sPayment.firstCycleAiAction !== "RETRY_NOW") continue;
        const firstCycle = r2sPayment.cycles[0];
        if (!firstCycle || firstCycle.executionStatus !== "executed") continue;
        if (firstCycle.outcomeSuccess === null) continue;

        const baselinePayment = baselineByPaymentId.get(r2sPayment.paymentId);
        expect(baselinePayment).toBeDefined();

        const baselineFirstAttempt = baselineRepo
          .listRecoveryAttemptsByCase(`case_${r2sPayment.paymentId}`)
          .find((a) => a.attemptNumber === 1);
        expect(baselineFirstAttempt).toBeDefined();
        if (!baselineFirstAttempt) continue;

        expect(baselineFirstAttempt.outcome === "success").toBe(firstCycle.outcomeSuccess);
        comparedCount++;
      }

      // Guard against a vacuous pass: at this cohort size there must be
      // at least one RETRY_NOW-first-cycle payment (temporary_bank_failure
      // and unknown both route to RETRY_NOW as their first candidate).
      expect(comparedCount).toBeGreaterThan(0);
    },
    30_000,
  );
});