// =============================================================================
// Decision agent orchestration (Aug 31)
// =============================================================================
// This module calls an AIProvider and enforces every safety rule around it:
//   - validates the provider's output against agentDecisionSchema
//   - enforces the candidate constraint (the AI may only pick an action
//     that was actually offered to it)
//   - falls back to a safe deterministic decision (STOP or ESCALATE) if the
//     provider throws, times out (via the caller's own timeout wrapping —
//     see note below), or returns invalid/out-of-candidate output
//   - skips calling the provider entirely when the case is unambiguous
//     (cost control: `resolveRecoveryDecision`)
//
// AUTHORITY MODEL: this module produces a *recommendation* only. It never
// touches the repository, never imports groundTruth.ts, and never marks
// anything as executed. The Policy Engine (src/policy/) has final say over
// what actually happens with this recommendation.
//
// NOTE ON TIMEOUTS: no network timeout logic lives here because no real
// network-calling provider exists yet (per scope). When a real provider is
// added, wrap its `generateDecision` call with a timeout in that provider's
// own implementation (or a decorator provider) — this function already
// treats any rejected promise from `provider.generateDecision` (including
// one caused by a timeout) as a safe-fallback trigger.
// =============================================================================

import type { AIProvider } from "./provider.js";
import { agentDecisionSchema } from "./schemas.js";
import type { AgentDecision, AgentDecisionRequest, AgentDecisionResult } from "./types.js";

/**
 * Deterministic cost-control gate: if the Assessment Engine's candidates
 * have already narrowed things down to a single unambiguous action, there
 * is nothing for an AI to adjudicate — skip the call entirely.
 */
export function shouldCallAI(request: AgentDecisionRequest): boolean {
  return request.candidateActions.length > 1;
}

/**
 * Top-level entry point: resolves a recovery decision for a payment,
 * skipping the AI call for unambiguous (single-candidate) cases and
 * routing everything else through the full validated AI pipeline.
 */
export async function resolveRecoveryDecision(
  provider: AIProvider,
  request: AgentDecisionRequest,
): Promise<AgentDecisionResult> {
  if (!shouldCallAI(request)) {
    return resolveDeterministically(request);
  }
  return runDecisionAgent(provider, request);
}

function resolveDeterministically(request: AgentDecisionRequest): AgentDecisionResult {
  const only = request.candidateActions[0];
  if (!only) {
    // Defensive: agentDecisionRequestSchema requires >=1 candidate, so this
    // should be unreachable in practice.
    return {
      paymentId: request.paymentId,
      decision: {
        action: "STOP",
        confidence: 1,
        reasoning: "No candidate actions were supplied; nothing to do.",
      },
      source: "deterministic",
    };
  }

  const decision: AgentDecision = {
    action: only.action,
    confidence: 1,
    reasoning: `Deterministically resolved: only one candidate action (${only.action}) was available. ${only.rationale}`,
  };
  if (only.action === "RETRY_LATER") decision.delayHours = 24;
  if (only.action === "OFFER_INCENTIVE") decision.incentivePercent = 0;

  return { paymentId: request.paymentId, decision, source: "deterministic" };
}

/**
 * Calls the given provider, validates and constrains its output, and falls
 * back to a safe deterministic decision on any failure. Always resolves —
 * never throws.
 */
export async function runDecisionAgent(
  provider: AIProvider,
  request: AgentDecisionRequest,
): Promise<AgentDecisionResult> {
  let rawDecision: unknown;
  try {
    rawDecision = await provider.generateDecision(request);
  } catch (err) {
    return safeFallback(
      request,
      `AI provider threw an error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = agentDecisionSchema.safeParse(rawDecision);
  if (!parsed.success) {
    return safeFallback(
      request,
      `AI provider returned invalid output: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const decision = parsed.data;

  const allowedActions = new Set(request.candidateActions.map((c) => c.action));
  if (!allowedActions.has(decision.action)) {
    return safeFallback(
      request,
      `AI selected action "${decision.action}" which was not in the supplied candidate list.`,
    );
  }

  return { paymentId: request.paymentId, decision, source: "provider" };
}

/**
 * Safe deterministic fallback. Prefers ESCALATE when the case already has
 * prior failed attempts (ambiguous/risky — a human should look at it),
 * otherwise STOP (fresh case — safest to do nothing automated rather than
 * guess).
 */
function safeFallback(request: AgentDecisionRequest, reason: string): AgentDecisionResult {
  const action = request.recoveryHistory.priorFailureCount > 0 ? "ESCALATE" : "STOP";
  return {
    paymentId: request.paymentId,
    decision: {
      action,
      confidence: 0,
      reasoning: `Safe fallback engaged: ${reason}`,
    },
    source: "fallback",
    fallbackReason: reason,
  };
}
