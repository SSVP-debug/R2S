import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteRepository } from "../src/db/repository.js";
import { runSimulation } from "../src/simulation/runSimulation.js";
import { assessPayment, assessFromContext } from "../src/assessment/assessment.js";
import { buildAssessmentContext } from "../src/assessment/contextBuilder.js";
import { recoveryAssessmentSchema } from "../src/assessment/schemas.js";
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

describe("assessment: structured assessment (integration)", () => {
  it("produces a schema-valid assessment for every failed payment in a generated dataset", () => {
    const repo = new SqliteRepository(":memory:");
    try {
      const summary = runSimulation({ seed: "assessment-integration-1", repo });
      const payments = repo.listPaymentsBySimulationRun(summary.simulationRunId);
      const failedPayments = payments.filter((p) => p.status !== "created");

      expect(failedPayments.length).toBeGreaterThan(0);

      const now = new Date("2026-09-01T00:00:00.000Z");
      for (const payment of failedPayments) {
        const assessment = assessPayment(repo, payment.id, now);
        expect(() => recoveryAssessmentSchema.parse(assessment)).not.toThrow();
        expect(assessment.paymentId).toBe(payment.id);
        expect(assessment.candidateActions.length).toBeGreaterThan(0);
      }
    } finally {
      repo.close();
    }
  });

  it("is deterministic end-to-end for the same seed and same 'now'", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");

    function runOnce() {
      const repo = new SqliteRepository(":memory:");
      try {
        const summary = runSimulation({
          seed: "assessment-determinism",
          repo,
          runCreatedAt: new Date("2026-08-30T00:00:00.000Z"),
        });
        const payments = repo.listPaymentsBySimulationRun(summary.simulationRunId);
        const failed = payments.filter((p) => p.status !== "created");
        return failed.map((p) => assessPayment(repo, p.id, now));
      } finally {
        repo.close();
      }
    }

    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
  });

  it("throws a clear error when assessing a payment with no matching row", () => {
    const repo = new SqliteRepository(":memory:");
    try {
      runSimulation({ seed: "assessment-error-case", repo });
      expect(() => assessPayment(repo, "pay_does_not_exist", new Date())).toThrow();
    } finally {
      repo.close();
    }
  });
});

describe("assessment: ground-truth isolation", () => {
  it("no assessment output ever contains a ground-truth field name, across a full generated dataset", () => {
    const repo = new SqliteRepository(":memory:");
    try {
      const summary = runSimulation({ seed: "assessment-isolation-1", repo });
      const payments = repo.listPaymentsBySimulationRun(summary.simulationRunId);
      const failedPayments = payments.filter((p) => p.status !== "created");
      const now = new Date("2026-09-01T00:00:00.000Z");

      for (const payment of failedPayments) {
        const assessment = assessPayment(repo, payment.id, now);
        const keys = collectAllKeysDeep(assessment);
        for (const forbidden of GROUND_TRUTH_FIELD_NAMES) {
          expect(keys.has(forbidden)).toBe(false);
        }
      }
    } finally {
      repo.close();
    }
  });

  it("assessFromContext never receives a paymentId-only lookup path back into GroundTruth (no repo access at all)", () => {
    // assessFromContext takes a plain AgentPaymentContext object and a Date
    // — it structurally cannot reach the repository or GroundTruth table.
    const context = buildAssessmentContextFixture();
    const assessment = assessFromContext(context, new Date("2026-09-01T00:00:00.000Z"));
    expect(assessment.paymentId).toBe(context.paymentId);
  });

  it("static source check: no file under src/assessment/ imports src/simulation/groundTruth.ts", () => {
    const assessmentDir = join(process.cwd(), "src", "assessment");
    const files = readdirSync(assessmentDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = readFileSync(join(assessmentDir, file), "utf-8");
      const codeOnly = stripComments(raw);
      expect(codeOnly).not.toMatch(/groundTruth(\.js)?['"]/);
      expect(codeOnly).not.toMatch(/from ["']\.\.\/simulation\/groundTruth/);
    }
  });

  it("static source check: no file under src/assessment/ calls repo.getGroundTruthByPayment or repo.insertGroundTruths", () => {
    const assessmentDir = join(process.cwd(), "src", "assessment");
    const files = readdirSync(assessmentDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const raw = readFileSync(join(assessmentDir, file), "utf-8");
      // Strip comments so this checks actual code usage, not documentation
      // prose that legitimately explains the isolation guarantee (which
      // necessarily mentions these method names by name).
      const codeOnly = stripComments(raw);
      expect(codeOnly).not.toMatch(/getGroundTruthByPayment/);
      expect(codeOnly).not.toMatch(/insertGroundTruths/);
    }
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
}

function buildAssessmentContextFixture() {
  return {
    paymentId: "pay_fixture",
    amount: 100000,
    currency: "INR",
    status: "failed" as const,
    failureCategory: "temporary_bank_failure" as const,
    attemptCount: 0,
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
    merchant: { id: "mch_fixture", category: "ecommerce" as const },
    customer: { id: "cus_fixture", riskProfile: "medium" as const },
    recoveryCase: {
      id: "case_fixture",
      status: "open" as const,
      openedAt: new Date("2026-08-30T00:00:00.000Z"),
      recoveryWindowEndsAt: new Date("2026-09-06T00:00:00.000Z"),
    },
    priorAttempts: [],
  };
}
