// =============================================================================
// AI + Policy audit event integration (Aug 31)
// =============================================================================
// Represents AI decisions and policy outcomes through the EXISTING event
// model from Day 1 (src/simulation/events.ts, src/domain/types.ts) —
// no new event types are added. Notably, BLOCK and ESCALATE map onto the
// "action_blocked" and "escalation" event types that were defined on Day 1
// but had no producer yet; this is the first thing that actually emits
// them.
//
// These builders only construct AuditEvent objects (validated via the
// existing createEvent()/auditEventSchema) — they do not persist anything.
// Persisting them is the caller's responsibility, exactly as with every
// other event in the system.
//
// No ground-truth field is ever placed in these payloads — AI decisions and
// policy results structurally cannot contain one (see src/ai/types.ts and
// src/policy/types.ts).
// =============================================================================

import type { AuditEvent, EventType } from "../domain/types.js";
import { createEvent } from "../simulation/events.js";
import type { IdSequence } from "../simulation/ids.js";
import type { AgentDecisionResult } from "../ai/types.js";
import type { PolicyResult } from "./types.js";

export function buildAiDecisionAuditEvent(
  ids: IdSequence,
  params: {
    paymentId: string;
    recoveryCaseId: string;
    simulationRunId: string;
    occurredAt: Date;
    result: AgentDecisionResult;
  },
): AuditEvent {
  const { result } = params;
  return createEvent(ids, {
    entityType: "RecoveryCase",
    entityId: params.recoveryCaseId,
    eventType: "recovery_decision",
    occurredAt: params.occurredAt,
    paymentId: params.paymentId,
    simulationRunId: params.simulationRunId,
    payload: {
      source: result.source,
      action: result.decision.action,
      confidence: result.decision.confidence,
      reasoning: result.decision.reasoning,
      delayHours: result.decision.delayHours ?? null,
      incentivePercent: result.decision.incentivePercent ?? null,
      fallbackReason: result.fallbackReason ?? null,
    },
  });
}

const POLICY_DECISION_EVENT_TYPE: Record<PolicyResult["decision"], EventType> = {
  ALLOW: "recovery_decision",
  MODIFY: "recovery_decision",
  BLOCK: "action_blocked",
  ESCALATE: "escalation",
};

export function buildPolicyDecisionAuditEvent(
  ids: IdSequence,
  params: {
    paymentId: string;
    recoveryCaseId: string;
    simulationRunId: string;
    occurredAt: Date;
    policyResult: PolicyResult;
  },
): AuditEvent {
  const { policyResult } = params;
  return createEvent(ids, {
    entityType: "RecoveryCase",
    entityId: params.recoveryCaseId,
    eventType: POLICY_DECISION_EVENT_TYPE[policyResult.decision],
    occurredAt: params.occurredAt,
    paymentId: params.paymentId,
    simulationRunId: params.simulationRunId,
    payload: {
      decision: policyResult.decision,
      action: policyResult.action ?? null,
      reason: policyResult.reason,
      appliedRules: policyResult.appliedRules,
      modifiedAction: policyResult.modifiedDecision?.action ?? null,
    },
  });
}
