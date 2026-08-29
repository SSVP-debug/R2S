import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteRepository } from "../src/db/repository.js";
import { runSimulation } from "../src/simulation/runSimulation.js";
import { buildAssessmentContext } from "../src/assessment/contextBuilder.js";
import { assessFromContext } from "../src/assessment/assessment.js";
import { buildAgentDecisionRequest } from "../src/ai/requestBuilder.js";
import { agentDecisionRequestSchema } from "../src/ai/schemas.js";
import { DEFAULT_MERCHANT_POLICY } from "../src/policy/types.js";
import { GROUND_TRUTH_FIELD_NAMES } from "../src/domain/schemas.js";

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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function tsFilesIn(dir: string): { file: string; codeOnly: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({
      file,
      codeOnly: stripComments(readFileSync(join(dir, file), "utf-8")),
    }));
}

describe("AI/policy: ground-truth isolation", () => {
  it("no AgentDecisionRequest built from a real dataset ever contains a ground-truth field name", () => {
    const repo = new SqliteRepository(":memory:");
    try {
      const summary = runSimulation({ seed: "ai-isolation-1", repo });
      const payments = repo.listPaymentsBySimulationRun(summary.simulationRunId);
      const failedPayments = payments.filter((p) => p.status !== "created");
      const now = new Date("2026-09-01T00:00:00.000Z");

      for (const payment of failedPayments) {
        const context = buildAssessmentContext(repo, payment.id);
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
    } finally {
      repo.close();
    }
  });

  it("static source check: no file under src/ai/ imports src/simulation/groundTruth.ts", () => {
    const dir = join(process.cwd(), "src", "ai");
    const files = tsFilesIn(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const { codeOnly } of files) {
      expect(codeOnly).not.toMatch(/from ["']\.\.\/simulation\/groundTruth/);
    }
  });

  it("static source check: no file under src/policy/ imports src/simulation/groundTruth.ts", () => {
    const dir = join(process.cwd(), "src", "policy");
    const files = tsFilesIn(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const { codeOnly } of files) {
      expect(codeOnly).not.toMatch(/from ["']\.\.\/simulation\/groundTruth/);
    }
  });

  it("static source check: no file under src/ai/ or src/policy/ calls repo.getGroundTruthByPayment or repo.insertGroundTruths", () => {
    for (const dir of [join(process.cwd(), "src", "ai"), join(process.cwd(), "src", "policy")]) {
      const files = tsFilesIn(dir);
      for (const { codeOnly } of files) {
        expect(codeOnly).not.toMatch(/getGroundTruthByPayment/);
        expect(codeOnly).not.toMatch(/insertGroundTruths/);
      }
    }
  });

  it("static source check: no file under src/ai/ or src/policy/ imports anything from src/db/ (no direct repository access)", () => {
    for (const dir of [join(process.cwd(), "src", "ai"), join(process.cwd(), "src", "policy")]) {
      const files = tsFilesIn(dir);
      for (const { file, codeOnly } of files) {
        expect(codeOnly, `${dir}/${file} should not import from src/db/`).not.toMatch(
          /from ["'](\.\.\/)+db\//,
        );
      }
    }
  });
});
