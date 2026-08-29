// =============================================================================
// Simulation orchestrator
// =============================================================================
// Ties together: generation -> hidden ground truth -> recovery case lifecycle
// -> baseline deterministic retry strategy -> outcome simulation -> event
// log, persisting everything through the R2SRepository abstraction.
//
// This is the only place that both (a) computes ground truth and (b) drives
// the recovery pipeline — but note the pipeline itself (baseline strategy)
// never receives the ground truth object; only simulateAttemptOutcome() does.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import { createRng } from "./rng.js";
import { generateDataset, DEFAULT_GENERATOR_OPTIONS, type GeneratorOptions } from "./generator.js";
import { computeGroundTruth } from "./groundTruth.js";
import { IdSequence } from "./ids.js";
import { createEvent } from "./events.js";
import {
  transitionPayment,
  transitionRecoveryCase,
} from "./stateMachine.js";
import { BASELINE_RETRY_POLICY, decideBaselineAction } from "../strategy/baselineRetry.js";
import { simulateAttemptOutcome } from "../outcome/simulateOutcome.js";
import { buildSimulationRun } from "../meta/versioning.js";
import type {
  Customer,
  GroundTruth,
  Payment,
  RecoveryAttemptOutcome,
  RecoveryCaseStatus,
} from "../domain/types.js";

export interface SimulationSummary {
  simulationRunId: string;
  merchantCount: number;
  customerCount: number;
  paymentCount: number;
  failedPaymentCount: number;
  recoveredCount: number;
  failedFinalCount: number;
  stoppedCount: number;
}

export interface RunSimulationParams {
  seed: string;
  repo: R2SRepository;
  options?: GeneratorOptions;
  /** Fixed timestamp for the SimulationRun.createdAt metadata field. Defaults
   * to wall-clock "now" (this field is run metadata, not generated business
   * data, so it is intentionally allowed to vary run-to-run unless a caller
   * — e.g. a reproducibility test — pins it explicitly). */
  runCreatedAt?: Date;
}

export function runSimulation(params: RunSimulationParams): SimulationSummary {
  const { seed, repo, options = DEFAULT_GENERATOR_OPTIONS, runCreatedAt } = params;

  const simulationRunId = `run_${seed.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const rng = createRng(seed);
  const ids = new IdSequence();

  const simRun = buildSimulationRun(simulationRunId, seed, runCreatedAt ?? new Date());
  repo.insertSimulationRun(simRun);
  repo.insertRecoveryPolicy(BASELINE_RETRY_POLICY);

  const dataset = generateDataset(rng, simulationRunId, options);
  repo.insertMerchants(dataset.merchants);
  repo.insertCustomers(dataset.customers);
  repo.insertPayments(dataset.payments);

  const customersById = new Map<string, Customer>(dataset.customers.map((c) => [c.id, c]));

  let recoveredCount = 0;
  let failedFinalCount = 0;
  let stoppedCount = 0;
  let failedPaymentCount = 0;

  for (const payment of dataset.payments) {
    emitAndPersist(repo, ids, {
      entityType: "Payment",
      entityId: payment.id,
      eventType: "payment_created",
      occurredAt: payment.createdAt,
      paymentId: payment.id,
      simulationRunId,
    });

    if (payment.status !== "failed") continue;
    failedPaymentCount++;

    const customer = customersById.get(payment.customerId);
    if (!customer) throw new Error(`Customer ${payment.customerId} not found`);

    emitAndPersist(repo, ids, {
      entityType: "Payment",
      entityId: payment.id,
      eventType: "payment_failed",
      occurredAt: payment.updatedAt,
      paymentId: payment.id,
      simulationRunId,
      payload: { failureCategory: payment.failureCategory },
    });

    // ---- Hidden ground truth (evaluation-only) ----
    const groundTruth = computeGroundTruth(rng, ids.next("gt"), payment, customer);
    repo.insertGroundTruths([groundTruth]);

    // ---- Open recovery case ----
    const openedAt = payment.updatedAt;
    const recoveryWindowEndsAt = new Date(
      openedAt.getTime() + BASELINE_RETRY_POLICY.recoveryWindowDays * 24 * 60 * 60 * 1000,
    );
    const recoveryCaseId = ids.next("case");
    repo.insertRecoveryCase({
      id: recoveryCaseId,
      status: "open",
      openedAt,
      closedAt: null,
      recoveryWindowEndsAt,
      paymentId: payment.id,
      simulationRunId,
    });
    emitAndPersist(repo, ids, {
      entityType: "RecoveryCase",
      entityId: recoveryCaseId,
      eventType: "recovery_started",
      occurredAt: openedAt,
      paymentId: payment.id,
      simulationRunId,
    });

    const outcome = runBaselineRecoveryLoop({
      repo,
      ids,
      rng,
      payment,
      groundTruth,
      recoveryCaseId,
      openedAt,
      simulationRunId,
    });

    if (outcome === "recovered") recoveredCount++;
    else if (outcome === "failed_final") failedFinalCount++;
    else stoppedCount++;
  }

  return {
    simulationRunId,
    merchantCount: dataset.merchants.length,
    customerCount: dataset.customers.length,
    paymentCount: dataset.payments.length,
    failedPaymentCount,
    recoveredCount,
    failedFinalCount,
    stoppedCount,
  };
}

function emitAndPersist(
  repo: R2SRepository,
  ids: IdSequence,
  params: Parameters<typeof createEvent>[1],
): void {
  const event = createEvent(ids, params);
  repo.insertAuditEvents([event]);
}

type LoopOutcome = "recovered" | "failed_final" | "stopped";

function runBaselineRecoveryLoop(args: {
  repo: R2SRepository;
  ids: IdSequence;
  rng: ReturnType<typeof createRng>;
  payment: Payment;
  groundTruth: GroundTruth;
  recoveryCaseId: string;
  openedAt: Date;
  simulationRunId: string;
}): LoopOutcome {
  const { repo, ids, rng, payment, groundTruth, recoveryCaseId, openedAt, simulationRunId } = args;

  let paymentStatus = payment.status; // "failed"
  let caseStatus: RecoveryCaseStatus = "open";
  let attemptsMade = 0;
  let now = new Date(openedAt.getTime());
  let attemptCount = payment.attemptCount;

  const maxIterations = BASELINE_RETRY_POLICY.maxRetries + 2; // safety bound
  for (let i = 0; i < maxIterations; i++) {
    // Advance simulated "now" to the next candidate retry time (or, if the
    // policy has run out of scheduled offsets, leave "now" where it is —
    // decideBaselineAction will correctly report stop_max_retries_reached).
    const offsetHours = BASELINE_RETRY_POLICY.retryIntervalHours[attemptsMade];
    if (offsetHours !== undefined) {
      now = new Date(openedAt.getTime() + offsetHours * 60 * 60 * 1000);
    }

    const decision = decideBaselineAction(attemptsMade, openedAt, now, BASELINE_RETRY_POLICY);

    emitAndPersist(repo, ids, {
      entityType: "RecoveryCase",
      entityId: recoveryCaseId,
      eventType: "recovery_decision",
      occurredAt: now,
      paymentId: payment.id,
      simulationRunId,
      payload: { decision },
    });

    if (decision.action === "stop_max_retries_reached" || decision.action === "stop_window_expired") {
      const finalOutcome: LoopOutcome =
        decision.action === "stop_window_expired" ? "stopped" : "failed_final";

      const nextPaymentStatus = finalOutcome === "stopped" ? "stopped" : "failed_final";
      paymentStatus = transitionPayment(paymentStatus, nextPaymentStatus);
      repo.updatePayment(payment.id, { status: paymentStatus, updatedAt: now });

      const nextCaseStatus = finalOutcome === "stopped" ? "stopped" : "failed";
      caseStatus = transitionRecoveryCase(caseStatus, nextCaseStatus);
      repo.updateRecoveryCase(recoveryCaseId, { status: caseStatus, closedAt: now });

      emitAndPersist(repo, ids, {
        entityType: "RecoveryCase",
        entityId: recoveryCaseId,
        eventType: finalOutcome === "stopped" ? "stopped" : "recovery_failed",
        occurredAt: now,
        paymentId: payment.id,
        simulationRunId,
      });

      return finalOutcome;
    }

    if (decision.action === "wait") {
      // Unreachable given how "now" is advanced above (we always jump
      // straight to the next scheduled offset), but handled explicitly
      // rather than silently ignored, per the exhaustive decision type.
      throw new Error(
        `Unexpected 'wait' decision in deterministic orchestrator for payment ${payment.id}`,
      );
    }

    // decision.action === "retry_now"
    if (attemptsMade === 0) {
      // First attempt: move payment/case out of the initial "failed"/"open"
      // state into the active recovery pipeline.
      paymentStatus = transitionPayment(paymentStatus, "retrying");
      caseStatus = transitionRecoveryCase(caseStatus, "in_progress");
      repo.updatePayment(payment.id, { status: paymentStatus, updatedAt: now });
      repo.updateRecoveryCase(recoveryCaseId, { status: caseStatus });
    }

    const attemptNumber = decision.attemptNumber;

    emitAndPersist(repo, ids, {
      entityType: "RecoveryAttempt",
      entityId: `${recoveryCaseId}#${attemptNumber}`,
      eventType: "action_requested",
      occurredAt: now,
      paymentId: payment.id,
      simulationRunId,
      payload: { attemptNumber, strategy: BASELINE_RETRY_POLICY.name },
    });

    const attemptId = ids.next("att");
    repo.insertRecoveryAttempt({
      id: attemptId,
      attemptNumber,
      strategy: BASELINE_RETRY_POLICY.name,
      scheduledAt: now,
      executedAt: null,
      outcome: "pending",
      amountRecovered: null,
      recoveryCaseId,
      simulationRunId,
    });

    emitAndPersist(repo, ids, {
      entityType: "RecoveryAttempt",
      entityId: attemptId,
      eventType: "action_executed",
      occurredAt: now,
      paymentId: payment.id,
      simulationRunId,
      payload: { attemptNumber },
    });

    // ---- Outcome simulation: uses hidden ground truth internally only ----
    const attemptResult = simulateAttemptOutcome(rng, groundTruth, attemptNumber, payment.amount);
    const outcome: RecoveryAttemptOutcome = attemptResult.success ? "success" : "failure";
    repo.updateRecoveryAttempt(attemptId, {
      executedAt: now,
      outcome,
      amountRecovered: attemptResult.amountRecovered,
    });

    attemptsMade++;
    attemptCount++;
    repo.updatePayment(payment.id, { attemptCount, updatedAt: now });

    if (attemptResult.success) {
      paymentStatus = transitionPayment(paymentStatus, "recovered");
      caseStatus = transitionRecoveryCase(caseStatus, "recovered");
      repo.updatePayment(payment.id, { status: paymentStatus, updatedAt: now });
      repo.updateRecoveryCase(recoveryCaseId, { status: caseStatus, closedAt: now });

      emitAndPersist(repo, ids, {
        entityType: "Payment",
        entityId: payment.id,
        eventType: "payment_recovered",
        occurredAt: now,
        paymentId: payment.id,
        simulationRunId,
        payload: { amountRecovered: attemptResult.amountRecovered },
      });

      return "recovered";
    }

    // Failure: stay in "retrying" / "in_progress", loop continues to next
    // decision (which will either schedule the next retry or stop).
    paymentStatus = transitionPayment(paymentStatus, "retrying");
  }

  // Safety net: should be unreachable given maxIterations bound, but if the
  // loop somehow exhausts without a terminal decision, stop the case rather
  // than leaving it open indefinitely.
  caseStatus = transitionRecoveryCase(caseStatus, "stopped");
  repo.updateRecoveryCase(recoveryCaseId, { status: caseStatus, closedAt: now });
  paymentStatus = transitionPayment(paymentStatus, "stopped");
  repo.updatePayment(payment.id, { status: paymentStatus, updatedAt: now });
  return "stopped";
}
