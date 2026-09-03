import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildInitialWorld, materializeWorldInto } from "../src/evaluation/cohort.js";
import { runBaselineStrategy } from "../src/evaluation/strategies/baselineStrategy.js";
import { runR2sStrategy } from "../src/evaluation/strategies/r2sStrategy.js";
import { SqliteRepository } from "../src/db/repository.js";
import { MockAIProvider } from "../src/ai/mockProvider.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { buildAssessmentContext } from "../src/assessment/contextBuilder.js";
import { assessFromContext } from "../src/assessment/assessment.js";
import { buildAgentDecisionRequest } from "../src/ai/requestBuilder.js";
import { agentDecisionRequestSchema } from "../src/ai/schemas.js";
import { GROUND_TRUTH_FIELD_NAMES } from "../src/domain/schemas.js";
import type { PaymentStatus } from "../src/domain/types.js";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function tsFilesIn(dir: string): { file: string; codeOnly: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, codeOnly: stripComments(readFileSync(join(dir, file), "utf-8")) }));
}

function collectAllKeysDeep(obj: unknown, keys: Set<string> = new Set()): Set<string> {
  if (obj === null || typeof obj !== "object") return keys;
  if (Array.isArray(obj)) {
    for (const item of obj) collectAllKeysDeep(item, keys);
    return keys;
  }
  for (const [k, v] of Object.entries(obj)) {
    keys.add(k);
    collectAllKeysDeep(v, keys);
  }
  return keys;
}

describe("evaluation: fairness between baseline and R2S", () => {
  it("both repositories start with identical payment ids, amounts, failure categories, and initial states", () => {
    const world = buildInitialWorld({ seed: "fairness-1", maxCohortSize: 25 });
    const repoA = new SqliteRepository(":memory:");
    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    materializeWorldInto(world, repoB);

    for (const entry of world.cohort) {
      const pA = repoA.getPayment(entry.paymentId)!;
      const pB = repoB.getPayment(entry.paymentId)!;
      expect(pA.id).toBe(pB.id);
      expect(pA.amount).toBe(pB.amount);
      expect(pA.failureCategory).toBe(pB.failureCategory);
      expect(pA.status).toBe(pB.status);
      expect(pA.status).toBe("failed");

      const caseA = repoA.getRecoveryCaseByPayment(entry.paymentId)!;
      const caseB = repoB.getRecoveryCaseByPayment(entry.paymentId)!;
      expect(caseA.status).toBe(caseB.status);
      expect(caseA.status).toBe("open");
      expect(caseA.recoveryWindowEndsAt).toEqual(caseB.recoveryWindowEndsAt);
    }
  });

  it("hidden ground truth is identical in both repositories", () => {
    const world = buildInitialWorld({ seed: "fairness-2", maxCohortSize: 25 });
    const repoA = new SqliteRepository(":memory:");
    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    materializeWorldInto(world, repoB);

    for (const entry of world.cohort) {
      expect(repoA.getGroundTruthByPayment(entry.paymentId)).toEqual(
        repoB.getGroundTruthByPayment(entry.paymentId),
      );
    }
  });

  it("mutating the baseline's repository via its own strategy does not affect the R2S repository's state", async () => {
    const world = buildInitialWorld({ seed: "fairness-3", maxCohortSize: 15 });
    const repoA = new SqliteRepository(":memory:");
    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    materializeWorldInto(world, repoB);

    const beforeB = world.cohort.map((e) => repoB.getPayment(e.paymentId));

    runBaselineStrategy({ world, repo: repoA, rngSeed: "fairness-3:baseline" });

    const afterB = world.cohort.map((e) => repoB.getPayment(e.paymentId));
    expect(afterB).toEqual(beforeB);

    const afterA = world.cohort.map((e) => repoA.getPayment(e.paymentId)!.status);
    expect(afterA.some((status) => status !== "failed")).toBe(true);
  });

  it("running R2S after baseline (independent repos) does not leak any baseline mutation into R2S's results", async () => {
    const world = buildInitialWorld({ seed: "fairness-4", maxCohortSize: 15 });
    const repoA = new SqliteRepository(":memory:");
    const repoB = new SqliteRepository(":memory:");
    materializeWorldInto(world, repoA);
    materializeWorldInto(world, repoB);

    runBaselineStrategy({ world, repo: repoA, rngSeed: "fairness-4:baseline" });

    for (const entry of world.cohort) {
      expect(repoB.getPayment(entry.paymentId)!.status).toBe("failed");
    }

    await runR2sStrategy({
      world,
      repo: repoB,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "fairness-4:r2s",
    });

    for (const entry of world.cohort) {
      const status = repoA.getPayment(entry.paymentId)!.status;
      expect(["recovered", "failed_final", "stopped"]).toContain(status);
    }
  });

  it("R2S actually exercises assessment -> AI -> policy -> executor -> outcome for every cycle", async () => {
    const world = buildInitialWorld({ seed: "fairness-5", maxCohortSize: 20 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "fairness-5:r2s",
    });

    let sawAnyCycle = false;
    for (const payment of result.perPayment) {
      for (const cycle of payment.cycles) {
        sawAnyCycle = true;
        expect(["BASELINE", "AI", "FALLBACK"]).toContain(cycle.decisionSource);
        expect(typeof cycle.aiAction).toBe("string");
        expect(["ALLOW", "MODIFY", "BLOCK", "ESCALATE"]).toContain(cycle.policyDecision);
        if (cycle.policyDecision === "BLOCK") {
          expect(cycle.executionStatus).toBeNull();
          expect(cycle.outcomeSuccess).toBeNull();
        } else {
          expect(cycle.executionStatus).not.toBeNull();
        }
      }
    }
    expect(sawAnyCycle).toBe(true);
  });

  it("baseline uses only its own deterministic-retry vocabulary — never R2S's action set", async () => {
    const world = buildInitialWorld({ seed: "fairness-6", maxCohortSize: 30 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = runBaselineStrategy({ world, repo, rngSeed: "fairness-6:baseline" });

    for (const p of result.perPayment) {
      expect(["recovered", "failed_final", "stopped"]).toContain(p.outcome);
    }

    for (const entry of world.cohort) {
      const attempts = repo.listRecoveryAttemptsByCase(`case_${entry.paymentId}`);
      for (const attempt of attempts) {
        expect(attempt.strategy).toBe("baseline_deterministic_retry");
      }
    }
  });

  it("ground truth never enters an AgentDecisionRequest built from a cohort-materialized world", () => {
    const world = buildInitialWorld({ seed: "fairness-7", maxCohortSize: 15 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const now = new Date("2026-09-02T00:00:00.000Z");
    for (const entry of world.cohort) {
      const context = buildAssessmentContext(repo, entry.paymentId);
      const assessment = assessFromContext(context, now);
      const request = buildAgentDecisionRequest({
        context,
        assessment,
        merchantPolicy: DEFAULT_MERCHANT_POLICY,
      });

      expect(() => agentDecisionRequestSchema.parse(request)).not.toThrow();

      const keys = collectAllKeysDeep(request);
      for (const forbidden of GROUND_TRUTH_FIELD_NAMES) {
        expect(keys.has(forbidden)).toBe(false);
      }
    }
  });

  it("static source check: no file under src/evaluation/strategies/ imports src/simulation/groundTruth.ts", () => {
    const dir = join(process.cwd(), "src", "evaluation", "strategies");
    const files = tsFilesIn(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const { codeOnly } of files) {
      expect(codeOnly).not.toMatch(/from ["'](\.\.\/)+simulation\/groundTruth/);
    }
  });

  it("static source check: no file under src/evaluation/strategies/ calls repo.getGroundTruthByPayment", () => {
    const dir = join(process.cwd(), "src", "evaluation", "strategies");
    const files = tsFilesIn(dir);
    for (const { codeOnly } of files) {
      expect(codeOnly).not.toMatch(/getGroundTruthByPayment/);
    }
  });

  it("static source check: MockAIProvider never imports groundTruth.ts or the repository", () => {
    const files = tsFilesIn(join(process.cwd(), "src", "ai"));
    const mockProvider = files.find((f) => f.file === "mockProvider.ts")!;
    expect(mockProvider).toBeDefined();
    expect(mockProvider.codeOnly).not.toMatch(/groundTruth/);
    expect(mockProvider.codeOnly).not.toMatch(/from ["'](\.\.\/)+db\//);
  });

  it("Sep 2 audit correction (Issue 4): a payment whose decision-opportunity budget is exhausted without reaching a terminal state on its own is explicitly stopped — never left ambiguous", async () => {
    const world = buildInitialWorld({ seed: "lifecycle-1", maxCohortSize: 400 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "lifecycle-1:r2s",
    });

    const exhausted = result.perPayment.filter((p) => p.opportunityBudgetExhausted);
    // This cohort/seed should produce at least one genuinely exhausted
    // case, or the regression this test targets could never have been
    // observed in the first place.
    expect(exhausted.length).toBeGreaterThan(0);

    const VALID_TERMINAL_OR_ESCALATED: PaymentStatus[] = [
      "recovered",
      "failed_final",
      "stopped",
      "escalated",
    ];
    for (const p of exhausted) {
      // Never left in "failed" or "retrying" — always driven to an
      // explicit, valid domain state.
      expect(VALID_TERMINAL_OR_ESCALATED).toContain(p.finalPaymentStatus);
      // Specifically: budget exhaustion (as opposed to the orchestrator's
      // own STOP/ESCALATE) always resolves to "stopped" per the
      // terminateExhaustedPayment() implementation.
      expect(p.finalPaymentStatus).toBe("stopped");

      // The repository itself reflects the same state (not just the
      // in-memory result object).
      const payment = repo.getPayment(p.paymentId)!;
      expect(payment.status).toBe("stopped");
      const recoveryCase = repo.getRecoveryCaseByPayment(p.paymentId)!;
      expect(recoveryCase.status).toBe("stopped");
      expect(recoveryCase.closedAt).not.toBeNull();

      // No RecoveryAttempt or "action_executed" audit event was
      // fabricated for the termination itself (preserve-list item 8).
      const attempts = repo.listRecoveryAttemptsByCase(`case_${p.paymentId}`);
      expect(attempts.length).toBe(p.cycles.filter((c) => c.executionStatus === "executed").length);
    }
  });

  it("final correction: firstCycleAvailableActions faithfully reflects the agent's real candidate set (translated from the SAME decision's assessment, not recomputed later)", async () => {
    const world = buildInitialWorld({ seed: "avail-1", maxCohortSize: 100 });
    const repo = new SqliteRepository(":memory:");
    materializeWorldInto(world, repo);

    const result = await runR2sStrategy({
      world,
      repo,
      provider: new MockAIProvider(),
      merchantPolicy: DEFAULT_MERCHANT_POLICY,
      rngSeed: "avail-1:r2s",
    });

    for (const payment of result.perPayment) {
      expect(payment.firstCycleAvailableActions.length).toBeGreaterThan(0);
      // The agent's own first-cycle selected action was necessarily one
      // of the actions it was offered — the captured set is internally
      // consistent with the decision that was actually made.
      if (payment.firstCycleAiAction) {
        expect(payment.firstCycleAvailableActions).toContain(payment.firstCycleAiAction);
      }
    }
  });

  it("final correction: computing best-available-action agreement never introduces GroundTruth into any AI-facing path — only firstCycleAvailableActions (RecoveryAction[], already translated) and GroundTruth are combined, strictly in the evaluation layer, after decisions are made", () => {
    // Static proof: strategyMetrics.ts (the only file that calls
    // computeBestAvailableAction) is not part of the decision pipeline —
    // it is never imported by assessment/, ai/, policy/, execution/, or
    // orchestration/.
    const pipelineDirs = ["assessment", "ai", "policy", "execution", "orchestration"];
    for (const dir of pipelineDirs) {
      const files = tsFilesIn(join(process.cwd(), "src", dir));
      for (const { file, codeOnly } of files) {
        expect(codeOnly, `${dir}/${file} must not import strategyMetrics.ts`).not.toMatch(
          /strategyMetrics/,
        );
      }
    }
  });

  it("final correction: r2sStrategy.ts's capture of firstCycleAvailableActions reads only result.assessment.candidateActions (already computed, non-GroundTruth-derived) — never GroundTruth", () => {
    const files = tsFilesIn(join(process.cwd(), "src", "evaluation", "strategies"));
    const r2sStrategy = files.find((f) => f.file === "r2sStrategy.ts")!;
    expect(r2sStrategy).toBeDefined();
    expect(r2sStrategy.codeOnly).not.toMatch(/groundTruth/i);
    expect(r2sStrategy.codeOnly).not.toMatch(/getGroundTruthByPayment/);
  });
});
