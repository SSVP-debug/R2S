import { describe, it, expect } from "vitest";
import { buildInitialWorld, materializeWorldInto } from "../src/evaluation/cohort.js";
import { runBaselineStrategy } from "../src/evaluation/strategies/baselineStrategy.js";
import { runR2sStrategy } from "../src/evaluation/strategies/r2sStrategy.js";
import { SqliteRepository } from "../src/db/repository.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { runEvaluation, DEFAULT_EVALUATION_SEEDS } from "../src/evaluation/experimentRunner.js";

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
