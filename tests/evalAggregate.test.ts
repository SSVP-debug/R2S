import { describe, it, expect } from "vitest";
import { computeAggregateStats } from "../src/evaluation/aggregate.js";

describe("evaluation: computeAggregateStats", () => {
  it("computes mean, median, min, max, and population standard deviation on a known set", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const stats = computeAggregateStats(values);
    expect(stats.mean).toBeCloseTo(5);
    expect(stats.minimum).toBe(2);
    expect(stats.maximum).toBe(9);
    expect(stats.standardDeviation).toBeCloseTo(2, 5);
    expect(stats.sampleCount).toBe(8);
  });

  it("computes median correctly for odd-length arrays", () => {
    const stats = computeAggregateStats([3, 1, 2]);
    expect(stats.median).toBe(2);
  });

  it("computes median correctly for even-length arrays (average of two middle values)", () => {
    const stats = computeAggregateStats([1, 2, 3, 4]);
    expect(stats.median).toBeCloseTo(2.5);
  });

  it("does not mutate the input array while sorting internally", () => {
    const values = [5, 1, 3];
    const original = [...values];
    computeAggregateStats(values);
    expect(values).toEqual(original);
  });

  it("handles an empty array safely (no NaN)", () => {
    const stats = computeAggregateStats([]);
    expect(stats.sampleCount).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.median).toBe(0);
    expect(stats.minimum).toBe(0);
    expect(stats.maximum).toBe(0);
    expect(stats.standardDeviation).toBe(0);
    expect(Number.isNaN(stats.mean)).toBe(false);
  });

  it("handles a single-value array (stddev 0)", () => {
    const stats = computeAggregateStats([42]);
    expect(stats.mean).toBe(42);
    expect(stats.median).toBe(42);
    expect(stats.minimum).toBe(42);
    expect(stats.maximum).toBe(42);
    expect(stats.standardDeviation).toBe(0);
  });
});
