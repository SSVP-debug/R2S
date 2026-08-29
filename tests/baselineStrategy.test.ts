import { describe, it, expect } from "vitest";
import {
  decideBaselineAction,
  BASELINE_RETRY_POLICY,
  recoveryWindowEndsAt,
} from "../src/strategy/baselineRetry.js";

const openedAt = new Date("2026-08-01T00:00:00.000Z");

describe("baseline deterministic retry strategy", () => {
  it("retries at the exact scheduled offset, not before", () => {
    const justBefore = new Date(openedAt.getTime() + 59 * 60 * 1000); // 59 min in
    const decision = decideBaselineAction(0, openedAt, justBefore, BASELINE_RETRY_POLICY);
    expect(decision.action).toBe("wait");
  });

  it("retries once the first scheduled offset is reached", () => {
    const atOffset = new Date(openedAt.getTime() + 1 * 60 * 60 * 1000); // exactly 1hr
    const decision = decideBaselineAction(0, openedAt, atOffset, BASELINE_RETRY_POLICY);
    expect(decision).toEqual({ action: "retry_now", attemptNumber: 1 });
  });

  it("enforces the max retry limit: stops after policy.maxRetries attempts", () => {
    const now = new Date(openedAt.getTime() + 100 * 60 * 60 * 1000); // within the 168h window
    const decision = decideBaselineAction(
      BASELINE_RETRY_POLICY.maxRetries,
      openedAt,
      now,
      BASELINE_RETRY_POLICY,
    );
    expect(decision.action).toBe("stop_max_retries_reached");
  });

  it("never exceeds maxRetries attempts across the full schedule", () => {
    expect(BASELINE_RETRY_POLICY.retryIntervalHours.length).toBe(
      BASELINE_RETRY_POLICY.maxRetries,
    );
  });

  it("enforces the recovery window: stops once the window has expired, even with retries remaining", () => {
    const afterWindow = new Date(
      openedAt.getTime() +
        (BASELINE_RETRY_POLICY.recoveryWindowDays * 24 + 1) * 60 * 60 * 1000,
    );
    const decision = decideBaselineAction(0, openedAt, afterWindow, BASELINE_RETRY_POLICY);
    expect(decision.action).toBe("stop_window_expired");
  });

  it("recoveryWindowEndsAt matches policy.recoveryWindowDays", () => {
    const end = recoveryWindowEndsAt(openedAt, BASELINE_RETRY_POLICY);
    const expectedMs =
      openedAt.getTime() + BASELINE_RETRY_POLICY.recoveryWindowDays * 24 * 60 * 60 * 1000;
    expect(end.getTime()).toBe(expectedMs);
  });

  it("window check takes priority over max-retries check when both would apply", () => {
    // Construct a policy where maxRetries would already be hit, but we also
    // push "now" past the window — window expiry should still be reported.
    const policy = {
      ...BASELINE_RETRY_POLICY,
      recoveryWindowDays: 1,
    };
    const now = new Date(openedAt.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days later
    const decision = decideBaselineAction(policy.maxRetries, openedAt, now, policy);
    expect(decision.action).toBe("stop_window_expired");
  });

  it("is a pure function: same inputs always produce the same decision", () => {
    const now = new Date(openedAt.getTime() + 25 * 60 * 60 * 1000);
    const a = decideBaselineAction(1, openedAt, now, BASELINE_RETRY_POLICY);
    const b = decideBaselineAction(1, openedAt, now, BASELINE_RETRY_POLICY);
    expect(a).toEqual(b);
  });
});
