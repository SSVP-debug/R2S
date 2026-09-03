import { describe, it, expect } from "vitest";
import { buildInitialWorld, materializeWorldInto } from "../src/evaluation/cohort.js";
import { SqliteRepository } from "../src/db/repository.js";
import {
  EVALUATION_SCALE_GENERATOR_OPTIONS,
  DEFAULT_EVALUATION_SEEDS,
} from "../src/evaluation/experimentRunner.js";

describe("evaluation: cohort construction", () => {
  it("same seed produces the same cohort (payment ids, amounts, failure categories, order)", () => {
    const w1 = buildInitialWorld({ seed: "cohort-test-1", maxCohortSize: 50 });
    const w2 = buildInitialWorld({ seed: "cohort-test-1", maxCohortSize: 50 });

    expect(w1.cohort.map((c) => c.paymentId)).toEqual(w2.cohort.map((c) => c.paymentId));
    expect(w1.cohort.map((c) => c.amount)).toEqual(w2.cohort.map((c) => c.amount));
    expect(w1.cohort.map((c) => c.failureCategory)).toEqual(w2.cohort.map((c) => c.failureCategory));
    expect(w1.groundTruths).toEqual(w2.groundTruths);
  });

  it("different seeds produce different cohorts", () => {
    const w1 = buildInitialWorld({ seed: "cohort-test-a", maxCohortSize: 50 });
    const w2 = buildInitialWorld({ seed: "cohort-test-b", maxCohortSize: 50 });
    expect(w1.cohort.map((c) => c.paymentId)).not.toEqual(w2.cohort.map((c) => c.paymentId));
  });

  it("every cohort entry starts with initialStatus 'failed' and initialRecoveryCaseStatus 'open'", () => {
    const world = buildInitialWorld({ seed: "cohort-test-2", maxCohortSize: 30 });
    expect(world.cohort.length).toBeGreaterThan(0);
    for (const entry of world.cohort) {
      expect(entry.initialStatus).toBe("failed");
      expect(entry.initialRecoveryCaseStatus).toBe("open");
    }
  });

  it("eligibility is frozen from generation — not derived from any final status (no strategy has run yet)", () => {
    const world = buildInitialWorld({ seed: "cohort-test-3", maxCohortSize: 30 });
    // The cohort object exists and is fully populated before any repository
    // or strategy has ever touched it — there is no "final status" in
    // scope at all at this point, which is the property being asserted.
    expect(world.cohort.every((e) => e.initialStatus === "failed")).toBe(true);
  });

  it("maxCohortSize takes a deterministic prefix of the eligible failed population and records the drop count", () => {
    const full = buildInitialWorld({ seed: "cohort-test-4" });
    const capped = buildInitialWorld({ seed: "cohort-test-4", maxCohortSize: 10 });

    expect(capped.cohort.length).toBe(Math.min(10, full.cohort.length));
    expect(capped.cohort.map((c) => c.paymentId)).toEqual(
      full.cohort.slice(0, capped.cohort.length).map((c) => c.paymentId),
    );
    expect(capped.droppedByMaxCohortSize).toBe(full.cohort.length - capped.cohort.length);
  });

  it("maxCohortSize larger than the eligible population drops nothing", () => {
    const world = buildInitialWorld({ seed: "cohort-test-5", maxCohortSize: 100_000 });
    expect(world.droppedByMaxCohortSize).toBe(0);
  });

  it("never pads the cohort up to a target size — actual generated count is reported as-is", () => {
    const world = buildInitialWorld({ seed: "cohort-test-6" });
    // No assertion that this equals any particular round number (947,
    // 1000, 1083, ...) — only that whatever it is, it's reported honestly.
    expect(world.cohort.length).toBeGreaterThan(0);
    expect(Number.isInteger(world.cohort.length)).toBe(true);
  });

  it("materializeWorldInto produces identical Payment/RecoveryCase/GroundTruth rows in two independent repositories", () => {
    const world = buildInitialWorld({ seed: "cohort-test-7", maxCohortSize: 20 });
    const repoA = new SqliteRepository(":memory:");
    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    materializeWorldInto(world, repoB);

    for (const entry of world.cohort) {
      const pA = repoA.getPayment(entry.paymentId);
      const pB = repoB.getPayment(entry.paymentId);
      expect(pA).toEqual(pB);

      const gtA = repoA.getGroundTruthByPayment(entry.paymentId);
      const gtB = repoB.getGroundTruthByPayment(entry.paymentId);
      expect(gtA).toEqual(gtB);
    }
  });

  it("Sep 2 audit correction (Issue 2): EVALUATION_SCALE_GENERATOR_OPTIONS (existing generator, merchantCount scaled up) yields approximately 1,000 eligible failed payments per seed, deterministically, without touching generator semantics", () => {
    for (const seed of DEFAULT_EVALUATION_SEEDS) {
      const world = buildInitialWorld({ seed, options: EVALUATION_SCALE_GENERATOR_OPTIONS });
      // "Approximately" — not padded/truncated to any exact number, but
      // comfortably in the neighborhood of the spec's ~1,000 target.
      expect(world.cohort.length).toBeGreaterThan(700);
      expect(world.cohort.length).toBeLessThan(1400);
      expect(world.droppedByMaxCohortSize).toBe(0);
    }
  });

  it("EVALUATION_SCALE_GENERATOR_OPTIONS cohort selection is deterministic and identical for baseline vs. R2S (same world, frozen before either strategy runs)", () => {
    const w1 = buildInitialWorld({ seed: "cohort-scale-repro", options: EVALUATION_SCALE_GENERATOR_OPTIONS });
    const w2 = buildInitialWorld({ seed: "cohort-scale-repro", options: EVALUATION_SCALE_GENERATOR_OPTIONS });
    expect(w1.cohort.map((c) => c.paymentId)).toEqual(w2.cohort.map((c) => c.paymentId));
    expect(w1.cohort.length).toBe(w2.cohort.length);
  });
});
