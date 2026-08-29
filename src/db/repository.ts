// =============================================================================
// Persistence abstraction
// =============================================================================
// `R2SRepository` is the smallest interface domain/simulation code needs to
// persist and read back R2S entities. It exists so that:
//
//   1. Generators, the state machine, the baseline strategy, and outcome
//      simulation never import node:sqlite (or Prisma) directly — they only
//      ever produce/consume plain domain objects (src/domain/types.ts).
//   2. Swapping the sandbox's node:sqlite driver for a real generated
//      `@prisma/client` later (see README "Migration path") means writing
//      one new class that implements this same interface — no changes to
//      generator.ts, groundTruth.ts, stateMachine.ts, baselineRetry.ts,
//      simulateOutcome.ts, or agentContext.ts.
//
// GROUND-TRUTH ISOLATION: note there is no `getAgentPaymentContext` method
// here that joins GroundTruth — agent context is built in
// src/domain/agentContext.ts purely from Payment/Merchant/Customer/
// RecoveryCase/RecoveryAttempt data already fetched through this
// repository's other methods. `getGroundTruthByPaymentId` is intentionally
// named and documented as internal-only.
// =============================================================================

import type { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  Customer,
  GroundTruth,
  Merchant,
  Payment,
  RecoveryAttempt,
  RecoveryCase,
  RecoveryPolicy,
  SimulationRun,
} from "../domain/types.js";
import {
  AUDIT_ENTITY_TYPES,
  EVENT_TYPES,
  FAILURE_CATEGORIES,
  MERCHANT_CATEGORIES,
  RISK_PROFILES,
  PAYMENT_STATUSES,
  RECOVERY_ATTEMPT_OUTCOMES,
  RECOVERY_CASE_STATUSES,
  BEST_ACTIONS,
} from "../domain/types.js";
import { openDatabase, openInMemoryDatabase } from "./sqliteDriver.js";

export interface R2SRepository {
  insertSimulationRun(run: SimulationRun): void;
  insertMerchants(merchants: Merchant[]): void;
  insertCustomers(customers: Customer[]): void;
  insertPayments(payments: Payment[]): void;
  insertRecoveryPolicy(policy: RecoveryPolicy): void;
  insertRecoveryCase(recoveryCase: RecoveryCase): void;
  insertRecoveryAttempt(attempt: RecoveryAttempt): void;
  insertAuditEvents(events: AuditEvent[]): void;
  /** INTERNAL-ONLY: evaluation/simulation use only. Never call this to
   * build agent-facing data. */
  insertGroundTruths(entries: GroundTruth[]): void;

  updatePayment(
    id: string,
    updates: Partial<Pick<Payment, "status" | "failureCategory" | "attemptCount" | "updatedAt">>,
  ): void;
  updateRecoveryCase(
    id: string,
    updates: Partial<Pick<RecoveryCase, "status" | "closedAt">>,
  ): void;
  updateRecoveryAttempt(
    id: string,
    updates: Partial<Pick<RecoveryAttempt, "executedAt" | "outcome" | "amountRecovered">>,
  ): void;

  getPayment(id: string): Payment | null;
  getMerchant(id: string): Merchant | null;
  getCustomer(id: string): Customer | null;
  getRecoveryCaseByPayment(paymentId: string): RecoveryCase | null;
  listRecoveryAttemptsByCase(recoveryCaseId: string): RecoveryAttempt[];
  listPaymentsBySimulationRun(simulationRunId: string): Payment[];
  listAuditEventsByPayment(paymentId: string): AuditEvent[];
  countRows(table: string): number;

  /** INTERNAL-ONLY: evaluation/simulation use only. Never call this to
   * build agent-facing data. */
  getGroundTruthByPayment(paymentId: string): GroundTruth | null;

  close(): void;
}

// ---- helpers: Date <-> ISO string, boolean <-> 0/1 -------------------------
const toIso = (d: Date): string => d.toISOString();
const fromIso = (s: string): Date => new Date(s);
const toIsoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
const fromIsoOrNull = (s: string | null): Date | null => (s ? new Date(s) : null);

function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value as T;
}

export class SqliteRepository implements R2SRepository {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = path === ":memory:" ? openInMemoryDatabase() : openDatabase(path);
  }

  insertSimulationRun(run: SimulationRun): void {
    this.db
      .prepare(
        `INSERT INTO SimulationRun (id, seed, generatorVersion, datasetVersion, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.seed, run.generatorVersion, run.datasetVersion, toIso(run.createdAt));
  }

  insertMerchants(merchants: Merchant[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO Merchant (id, name, category, createdAt, simulationRunId)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const m of merchants) {
      stmt.run(m.id, m.name, m.category, toIso(m.createdAt), m.simulationRunId);
    }
  }

  insertCustomers(customers: Customer[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO Customer (id, name, email, riskProfile, createdAt, merchantId, simulationRunId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of customers) {
      stmt.run(
        c.id,
        c.name,
        c.email,
        c.riskProfile,
        toIso(c.createdAt),
        c.merchantId,
        c.simulationRunId,
      );
    }
  }

  insertPayments(payments: Payment[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO Payment
        (id, amount, currency, status, failureCategory, attemptCount, createdAt, updatedAt, merchantId, customerId, simulationRunId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of payments) {
      stmt.run(
        p.id,
        p.amount,
        p.currency,
        p.status,
        p.failureCategory,
        p.attemptCount,
        toIso(p.createdAt),
        toIso(p.updatedAt),
        p.merchantId,
        p.customerId,
        p.simulationRunId,
      );
    }
  }

  insertRecoveryPolicy(policy: RecoveryPolicy): void {
    this.db
      .prepare(
        `INSERT INTO RecoveryPolicy (id, name, maxRetries, retryIntervalHours, recoveryWindowDays, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.id,
        policy.name,
        policy.maxRetries,
        JSON.stringify(policy.retryIntervalHours),
        policy.recoveryWindowDays,
        toIso(policy.createdAt),
      );
  }

  insertRecoveryCase(rc: RecoveryCase): void {
    this.db
      .prepare(
        `INSERT INTO RecoveryCase (id, status, openedAt, closedAt, recoveryWindowEndsAt, paymentId, simulationRunId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rc.id,
        rc.status,
        toIso(rc.openedAt),
        toIsoOrNull(rc.closedAt),
        toIso(rc.recoveryWindowEndsAt),
        rc.paymentId,
        rc.simulationRunId,
      );
  }

  insertRecoveryAttempt(attempt: RecoveryAttempt): void {
    this.db
      .prepare(
        `INSERT INTO RecoveryAttempt
          (id, attemptNumber, strategy, scheduledAt, executedAt, outcome, amountRecovered, recoveryCaseId, simulationRunId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.attemptNumber,
        attempt.strategy,
        toIso(attempt.scheduledAt),
        toIsoOrNull(attempt.executedAt),
        attempt.outcome,
        attempt.amountRecovered,
        attempt.recoveryCaseId,
        attempt.simulationRunId,
      );
  }

  insertAuditEvents(events: AuditEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO AuditEvent (id, entityType, entityId, eventType, payload, occurredAt, paymentId, simulationRunId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      stmt.run(
        e.id,
        e.entityType,
        e.entityId,
        e.eventType,
        JSON.stringify(e.payload),
        toIso(e.occurredAt),
        e.paymentId,
        e.simulationRunId,
      );
    }
  }

  insertGroundTruths(entries: GroundTruth[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO GroundTruth (id, paymentId, recoverable, recoveryProbability, bestAction, recoveredAmount, simulationRunId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const g of entries) {
      stmt.run(
        g.id,
        g.paymentId,
        g.recoverable ? 1 : 0,
        g.recoveryProbability,
        g.bestAction,
        g.recoveredAmount,
        g.simulationRunId,
      );
    }
  }

  updatePayment(
    id: string,
    updates: Partial<Pick<Payment, "status" | "failureCategory" | "attemptCount" | "updatedAt">>,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.failureCategory !== undefined) {
      sets.push("failureCategory = ?");
      values.push(updates.failureCategory);
    }
    if (updates.attemptCount !== undefined) {
      sets.push("attemptCount = ?");
      values.push(updates.attemptCount);
    }
    if (updates.updatedAt !== undefined) {
      sets.push("updatedAt = ?");
      values.push(toIso(updates.updatedAt));
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE Payment SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  updateRecoveryCase(
    id: string,
    updates: Partial<Pick<RecoveryCase, "status" | "closedAt">>,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.closedAt !== undefined) {
      sets.push("closedAt = ?");
      values.push(toIsoOrNull(updates.closedAt));
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE RecoveryCase SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  updateRecoveryAttempt(
    id: string,
    updates: Partial<Pick<RecoveryAttempt, "executedAt" | "outcome" | "amountRecovered">>,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (updates.executedAt !== undefined) {
      sets.push("executedAt = ?");
      values.push(toIsoOrNull(updates.executedAt));
    }
    if (updates.outcome !== undefined) {
      sets.push("outcome = ?");
      values.push(updates.outcome);
    }
    if (updates.amountRecovered !== undefined) {
      sets.push("amountRecovered = ?");
      values.push(updates.amountRecovered);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE RecoveryAttempt SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  getPayment(id: string): Payment | null {
    const row = this.db.prepare(`SELECT * FROM Payment WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      amount: row.amount as number,
      currency: row.currency as string,
      status: assertOneOf(row.status as string, PAYMENT_STATUSES, "Payment.status"),
      failureCategory:
        row.failureCategory === null
          ? null
          : assertOneOf(row.failureCategory as string, FAILURE_CATEGORIES, "Payment.failureCategory"),
      attemptCount: row.attemptCount as number,
      createdAt: fromIso(row.createdAt as string),
      updatedAt: fromIso(row.updatedAt as string),
      merchantId: row.merchantId as string,
      customerId: row.customerId as string,
      simulationRunId: row.simulationRunId as string,
    };
  }

  getMerchant(id: string): Merchant | null {
    const row = this.db.prepare(`SELECT * FROM Merchant WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      category: assertOneOf(row.category as string, MERCHANT_CATEGORIES, "Merchant.category"),
      createdAt: fromIso(row.createdAt as string),
      simulationRunId: row.simulationRunId as string,
    };
  }

  getCustomer(id: string): Customer | null {
    const row = this.db.prepare(`SELECT * FROM Customer WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      riskProfile: assertOneOf(row.riskProfile as string, RISK_PROFILES, "Customer.riskProfile"),
      createdAt: fromIso(row.createdAt as string),
      merchantId: row.merchantId as string,
      simulationRunId: row.simulationRunId as string,
    };
  }

  getRecoveryCaseByPayment(paymentId: string): RecoveryCase | null {
    const row = this.db
      .prepare(`SELECT * FROM RecoveryCase WHERE paymentId = ?`)
      .get(paymentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      status: assertOneOf(row.status as string, RECOVERY_CASE_STATUSES, "RecoveryCase.status"),
      openedAt: fromIso(row.openedAt as string),
      closedAt: fromIsoOrNull(row.closedAt as string | null),
      recoveryWindowEndsAt: fromIso(row.recoveryWindowEndsAt as string),
      paymentId: row.paymentId as string,
      simulationRunId: row.simulationRunId as string,
    };
  }

  listRecoveryAttemptsByCase(recoveryCaseId: string): RecoveryAttempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM RecoveryAttempt WHERE recoveryCaseId = ? ORDER BY attemptNumber ASC`)
      .all(recoveryCaseId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      attemptNumber: row.attemptNumber as number,
      strategy: row.strategy as string,
      scheduledAt: fromIso(row.scheduledAt as string),
      executedAt: fromIsoOrNull(row.executedAt as string | null),
      outcome: assertOneOf(
        row.outcome as string,
        RECOVERY_ATTEMPT_OUTCOMES,
        "RecoveryAttempt.outcome",
      ),
      amountRecovered: row.amountRecovered as number | null,
      recoveryCaseId: row.recoveryCaseId as string,
      simulationRunId: row.simulationRunId as string,
    }));
  }

  listPaymentsBySimulationRun(simulationRunId: string): Payment[] {
    const rows = this.db
      .prepare(`SELECT id FROM Payment WHERE simulationRunId = ? ORDER BY id ASC`)
      .all(simulationRunId) as { id: string }[];
    return rows.map((r) => {
      const p = this.getPayment(r.id);
      if (!p) throw new Error(`Payment ${r.id} vanished mid-query`);
      return p;
    });
  }

  listAuditEventsByPayment(paymentId: string): AuditEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM AuditEvent WHERE paymentId = ? ORDER BY occurredAt ASC`)
      .all(paymentId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      entityType: assertOneOf(row.entityType as string, AUDIT_ENTITY_TYPES, "AuditEvent.entityType"),
      entityId: row.entityId as string,
      eventType: assertOneOf(row.eventType as string, EVENT_TYPES, "AuditEvent.eventType"),
      payload: JSON.parse(row.payload as string),
      occurredAt: fromIso(row.occurredAt as string),
      paymentId: row.paymentId as string | null,
      simulationRunId: row.simulationRunId as string,
    }));
  }

  countRows(table: string): number {
    const allowed = new Set([
      "SimulationRun",
      "Merchant",
      "Customer",
      "Payment",
      "RecoveryCase",
      "RecoveryAttempt",
      "RecoveryPolicy",
      "AuditEvent",
      "GroundTruth",
    ]);
    if (!allowed.has(table)) throw new Error(`Unknown table: ${table}`);
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  getGroundTruthByPayment(paymentId: string): GroundTruth | null {
    const row = this.db
      .prepare(`SELECT * FROM GroundTruth WHERE paymentId = ?`)
      .get(paymentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      paymentId: row.paymentId as string,
      recoverable: row.recoverable === 1,
      recoveryProbability: row.recoveryProbability as number,
      bestAction: assertOneOf(row.bestAction as string, BEST_ACTIONS, "GroundTruth.bestAction"),
      recoveredAmount: row.recoveredAmount as number,
      simulationRunId: row.simulationRunId as string,
    };
  }

  close(): void {
    this.db.close();
  }
}
