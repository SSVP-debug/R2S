import { describe, it, expect } from "vitest";
import {
  transitionPayment,
  transitionRecoveryCase,
  canTransitionPayment,
  canTransitionRecoveryCase,
  isTerminalPaymentStatus,
  isTerminalRecoveryCaseStatus,
  InvalidTransitionError,
} from "../src/simulation/stateMachine.js";

describe("payment state machine", () => {
  it("allows created -> failed", () => {
    expect(transitionPayment("created", "failed")).toBe("failed");
  });

  it("allows failed -> retrying", () => {
    expect(transitionPayment("failed", "retrying")).toBe("retrying");
  });

  it("allows retrying -> recovered", () => {
    expect(transitionPayment("retrying", "recovered")).toBe("recovered");
  });

  it("allows retrying -> retrying (repeated failed attempts)", () => {
    expect(transitionPayment("retrying", "retrying")).toBe("retrying");
  });

  it("allows retrying -> failed_final", () => {
    expect(transitionPayment("retrying", "failed_final")).toBe("failed_final");
  });

  it("allows failed -> escalated and escalated -> recovered", () => {
    expect(transitionPayment("failed", "escalated")).toBe("escalated");
    expect(transitionPayment("escalated", "recovered")).toBe("recovered");
  });

  it("rejects created -> recovered (must go through failed first)", () => {
    expect(canTransitionPayment("created", "recovered")).toBe(false);
    expect(() => transitionPayment("created", "recovered")).toThrow(InvalidTransitionError);
  });

  it("rejects recovered -> anything (terminal state)", () => {
    expect(() => transitionPayment("recovered", "failed")).toThrow(InvalidTransitionError);
    expect(() => transitionPayment("recovered", "retrying")).toThrow(InvalidTransitionError);
  });

  it("rejects failed_final -> retrying (terminal state)", () => {
    expect(() => transitionPayment("failed_final", "retrying")).toThrow(InvalidTransitionError);
  });

  it("identifies terminal statuses correctly", () => {
    expect(isTerminalPaymentStatus("recovered")).toBe(true);
    expect(isTerminalPaymentStatus("failed_final")).toBe(true);
    expect(isTerminalPaymentStatus("stopped")).toBe(true);
    expect(isTerminalPaymentStatus("created")).toBe(false);
    expect(isTerminalPaymentStatus("failed")).toBe(false);
    expect(isTerminalPaymentStatus("retrying")).toBe(false);
  });
});

describe("recovery case state machine", () => {
  it("allows open -> in_progress -> recovered", () => {
    expect(transitionRecoveryCase("open", "in_progress")).toBe("in_progress");
    expect(transitionRecoveryCase("in_progress", "recovered")).toBe("recovered");
  });

  it("allows in_progress -> failed", () => {
    expect(transitionRecoveryCase("in_progress", "failed")).toBe("failed");
  });

  it("allows open -> stopped directly (window expired before any attempt)", () => {
    expect(transitionRecoveryCase("open", "stopped")).toBe("stopped");
  });

  it("rejects open -> recovered (must pass through in_progress)", () => {
    expect(canTransitionRecoveryCase("open", "recovered")).toBe(false);
    expect(() => transitionRecoveryCase("open", "recovered")).toThrow(InvalidTransitionError);
  });

  it("rejects transitions out of terminal states", () => {
    expect(() => transitionRecoveryCase("recovered", "failed")).toThrow(InvalidTransitionError);
    expect(() => transitionRecoveryCase("failed", "recovered")).toThrow(InvalidTransitionError);
    expect(() => transitionRecoveryCase("stopped", "in_progress")).toThrow(InvalidTransitionError);
  });

  it("identifies terminal statuses correctly", () => {
    expect(isTerminalRecoveryCaseStatus("recovered")).toBe(true);
    expect(isTerminalRecoveryCaseStatus("failed")).toBe(true);
    expect(isTerminalRecoveryCaseStatus("stopped")).toBe(true);
    expect(isTerminalRecoveryCaseStatus("open")).toBe(false);
    expect(isTerminalRecoveryCaseStatus("in_progress")).toBe(false);
  });
});
