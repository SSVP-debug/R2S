import { describe, it, expect } from "vitest";
import { agentDecisionSchema } from "../src/ai/schemas.js";

describe("AI: agentDecisionSchema validation", () => {
  it("accepts a valid RETRY_NOW decision with no conditional fields", () => {
    const result = agentDecisionSchema.safeParse({
      action: "RETRY_NOW",
      confidence: 0.8,
      reasoning: "Temporary bank failure, first attempt.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid RETRY_LATER decision with delayHours", () => {
    const result = agentDecisionSchema.safeParse({
      action: "RETRY_LATER",
      confidence: 0.6,
      reasoning: "Insufficient funds; wait for next payday cycle.",
      delayHours: 48,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid OFFER_INCENTIVE decision with incentivePercent", () => {
    const result = agentDecisionSchema.safeParse({
      action: "OFFER_INCENTIVE",
      confidence: 0.5,
      reasoning: "Delayed retry candidate; a small incentive may help.",
      incentivePercent: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown action", () => {
    const result = agentDecisionSchema.safeParse({
      action: "DO_SOMETHING_ELSE",
      confidence: 0.5,
      reasoning: "Not a real action.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = agentDecisionSchema.safeParse({
      action: "STOP",
      confidence: 1.5,
      reasoning: "Too confident.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const result = agentDecisionSchema.safeParse({
      action: "STOP",
      confidence: -0.1,
      reasoning: "Negative confidence.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric confidence", () => {
    const result = agentDecisionSchema.safeParse({
      action: "STOP",
      confidence: "high",
      reasoning: "Malformed confidence.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects RETRY_LATER missing delayHours", () => {
    const result = agentDecisionSchema.safeParse({
      action: "RETRY_LATER",
      confidence: 0.5,
      reasoning: "Missing delayHours.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects OFFER_INCENTIVE missing incentivePercent", () => {
    const result = agentDecisionSchema.safeParse({
      action: "OFFER_INCENTIVE",
      confidence: 0.5,
      reasoning: "Missing incentivePercent.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty reasoning string", () => {
    const result = agentDecisionSchema.safeParse({
      action: "STOP",
      confidence: 0.5,
      reasoning: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects incentivePercent out of [0, 100]", () => {
    const result = agentDecisionSchema.safeParse({
      action: "OFFER_INCENTIVE",
      confidence: 0.5,
      reasoning: "Excessive incentive.",
      incentivePercent: 150,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative delayHours", () => {
    const result = agentDecisionSchema.safeParse({
      action: "RETRY_LATER",
      confidence: 0.5,
      reasoning: "Negative delay makes no sense.",
      delayHours: -5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a completely malformed object", () => {
    const result = agentDecisionSchema.safeParse({ foo: "bar" });
    expect(result.success).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(agentDecisionSchema.safeParse(null).success).toBe(false);
    expect(agentDecisionSchema.safeParse(undefined).success).toBe(false);
  });
});
