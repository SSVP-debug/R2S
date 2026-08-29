// =============================================================================
// Candidate action translation (Aug 31, corrected)
// =============================================================================
// Day 2's Recovery Assessment Engine produces candidate actions in an
// abstract category vocabulary (BestAction: retry_immediate, retry_delayed,
// prompt_instrument_update, escalate_to_human, no_action — see
// src/domain/types.ts). Day 3's AI layer needs a more concrete, tactic-level
// vocabulary (RecoveryAction).
//
// STRICT ONE-TO-ONE MAPPING (corrected per Aug 31 sign-off review):
// each BestAction maps to EXACTLY ONE RecoveryAction. Earlier this module
// expanded some candidates (e.g. retry_delayed) into multiple RecoveryAction
// options, including actions the Assessment Engine never actually
// recommended (OFFER_INCENTIVE, SEND_REMINDER). That violated the candidate
// constraint in spirit: the AI must only ever be offered actions that are
// genuine, faithful translations of what Day 2 actually generated — not a
// superset invented at the bridge layer.
//
// OFFER_INCENTIVE and SEND_REMINDER are therefore NOT reachable through
// this translation today. They remain valid members of the RecoveryAction
// vocabulary (used directly by policy rules and available to a future
// milestone that teaches the Assessment Engine to recommend them), but
// this bridge will not manufacture them out of an unrelated candidate.
//
// This module is the ONLY bridge between the two vocabularies — it does
// not modify src/assessment/candidateActions.ts, it only translates its
// output.
// =============================================================================

import type { BestAction } from "../domain/types.js";
import type { CandidateAction } from "../assessment/candidateActions.js";
import type { CandidateActionForAI, RecoveryAction } from "./types.js";

/** Strict one-to-one semantic mapping: each Day-2 candidate category
 * translates to exactly one Day-3 concrete action — never more than what
 * the Assessment Engine actually recommended. */
export const CANDIDATE_ACTION_MAP: Record<BestAction, RecoveryAction> = {
  retry_immediate: "RETRY_NOW",
  retry_delayed: "RETRY_LATER",
  prompt_instrument_update: "SEND_PAYMENT_LINK",
  escalate_to_human: "ESCALATE",
  no_action: "STOP",
};

/**
 * Translates Day 2's ranked CandidateAction[] into Day 3's
 * CandidateActionForAI[] via the strict 1:1 mapping above, preserving
 * relative priority order. Deduplicates only in the defensive case where
 * the same RecoveryAction would otherwise appear twice (e.g. duplicate
 * entries in the source candidate list) — the mapping itself is injective,
 * so this should not occur in normal operation.
 */
export function translateCandidateActions(
  candidates: CandidateAction[],
): CandidateActionForAI[] {
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);
  const seen = new Set<RecoveryAction>();
  const result: CandidateActionForAI[] = [];

  for (const candidate of sorted) {
    const mapped = CANDIDATE_ACTION_MAP[candidate.action];
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    result.push({
      action: mapped,
      rationale: candidate.rationale,
      priority: result.length + 1,
    });
  }

  return result;
}

