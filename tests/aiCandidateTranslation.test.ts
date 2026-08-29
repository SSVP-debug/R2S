import { describe, it, expect } from "vitest";
import { translateCandidateActions, CANDIDATE_ACTION_MAP } from "../src/ai/candidateTranslation.js";
import { RECOVERY_ACTIONS } from "../src/ai/types.js";
import { BEST_ACTIONS } from "../src/domain/types.js";
import type { CandidateAction } from "../src/assessment/candidateActions.js";

describe("AI: candidate action translation (strict 1:1 mapping)", () => {
  it("every BestAction maps to exactly one RecoveryAction", () => {
    for (const bestAction of BEST_ACTIONS) {
      expect(typeof CANDIDATE_ACTION_MAP[bestAction]).toBe("string");
    }
  });

  it("every mapped RecoveryAction is a member of the RECOVERY_ACTIONS vocabulary", () => {
    for (const bestAction of BEST_ACTIONS) {
      expect(RECOVERY_ACTIONS).toContain(CANDIDATE_ACTION_MAP[bestAction]);
    }
  });

  it("the mapping is exactly the specified strict semantic mapping", () => {
    expect(CANDIDATE_ACTION_MAP).toEqual({
      retry_immediate: "RETRY_NOW",
      retry_delayed: "RETRY_LATER",
      prompt_instrument_update: "SEND_PAYMENT_LINK",
      escalate_to_human: "ESCALATE",
      no_action: "STOP",
    });
  });

  it("OFFER_INCENTIVE is never produced by translation (not reachable from any BestAction)", () => {
    for (const bestAction of BEST_ACTIONS) {
      expect(CANDIDATE_ACTION_MAP[bestAction]).not.toBe("OFFER_INCENTIVE");
    }
  });

  it("SEND_REMINDER is never produced by translation (not reachable from any BestAction)", () => {
    for (const bestAction of BEST_ACTIONS) {
      expect(CANDIDATE_ACTION_MAP[bestAction]).not.toBe("SEND_REMINDER");
    }
  });

  it("translates a single candidate into exactly its one mapped RecoveryAction", () => {
    const candidates: CandidateAction[] = [
      { action: "retry_delayed", rationale: "wait it out", priority: 1 },
    ];
    const translated = translateCandidateActions(candidates);
    expect(translated).toEqual([{ action: "RETRY_LATER", rationale: "wait it out", priority: 1 }]);
  });

  it("translates a full ranked candidate list 1:1, preserving priority order", () => {
    const candidates: CandidateAction[] = [
      { action: "escalate_to_human", rationale: "urgent", priority: 1 },
      { action: "retry_immediate", rationale: "fallback", priority: 2 },
    ];
    const translated = translateCandidateActions(candidates);
    expect(translated[0]!.action).toBe("ESCALATE");
    expect(translated[1]!.action).toBe("RETRY_NOW");
    expect(translated.map((t) => t.priority)).toEqual([1, 2]);
  });

  it("does not introduce any RecoveryAction not directly derived from a supplied candidate", () => {
    const candidates: CandidateAction[] = [
      { action: "retry_delayed", rationale: "wait", priority: 1 },
      { action: "no_action", rationale: "fallback", priority: 2 },
    ];
    const translated = translateCandidateActions(candidates);
    const actions = translated.map((t) => t.action);
    // Only RETRY_LATER and STOP were actually derived from the two
    // supplied candidates — nothing else (e.g. OFFER_INCENTIVE,
    // SEND_REMINDER) may appear.
    expect(actions.sort()).toEqual(["RETRY_LATER", "STOP"]);
  });

  it("is deterministic: same input always produces the same output", () => {
    const candidates: CandidateAction[] = [
      { action: "retry_delayed", rationale: "x", priority: 1 },
    ];
    const a = translateCandidateActions(candidates);
    const b = translateCandidateActions(candidates);
    expect(a).toEqual(b);
  });

  it("no_action always translates to exactly STOP", () => {
    const translated = translateCandidateActions([
      { action: "no_action", rationale: "fallback", priority: 1 },
    ]);
    expect(translated).toEqual([{ action: "STOP", rationale: "fallback", priority: 1 }]);
  });

  it("deduplicates only in the defensive case of duplicate source candidates mapping to the same action", () => {
    const candidates: CandidateAction[] = [
      { action: "retry_immediate", rationale: "primary", priority: 1 },
      { action: "retry_immediate", rationale: "duplicate", priority: 2 },
    ];
    const translated = translateCandidateActions(candidates);
    expect(translated).toHaveLength(1);
    expect(translated[0]!.action).toBe("RETRY_NOW");
  });
});
