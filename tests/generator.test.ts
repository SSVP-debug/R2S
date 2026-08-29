import { describe, it, expect } from "vitest";
import { createRng } from "../src/simulation/rng.js";
import {
  generateDataset,
  DEFAULT_GENERATOR_OPTIONS,
} from "../src/simulation/generator.js";
import { FAILURE_CATEGORIES } from "../src/domain/types.js";

describe("generator", () => {
  it("is deterministic: same seed produces identical datasets", () => {
    const a = generateDataset(createRng("seed-alpha"), "run_a");
    const b = generateDataset(createRng("seed-alpha"), "run_a");
    expect(a).toEqual(b);
  });

  it("produces different datasets for different seeds", () => {
    const a = generateDataset(createRng("seed-alpha"), "run_a");
    const b = generateDataset(createRng("seed-beta"), "run_a");
    expect(a).not.toEqual(b);
  });

  it("generates the requested number of merchants", () => {
    const { merchants } = generateDataset(createRng("seed-1"), "run_1", {
      ...DEFAULT_GENERATOR_OPTIONS,
      merchantCount: 7,
    });
    expect(merchants).toHaveLength(7);
  });

  it("maintains referential integrity: every customer references a real merchant", () => {
    const { merchants, customers } = generateDataset(createRng("seed-2"), "run_2");
    const merchantIds = new Set(merchants.map((m) => m.id));
    for (const c of customers) {
      expect(merchantIds.has(c.merchantId)).toBe(true);
    }
  });

  it("maintains referential integrity: every payment references a real merchant and customer", () => {
    const { merchants, customers, payments } = generateDataset(
      createRng("seed-3"),
      "run_3",
    );
    const merchantIds = new Set(merchants.map((m) => m.id));
    const customerIds = new Set(customers.map((c) => c.id));
    for (const p of payments) {
      expect(merchantIds.has(p.merchantId)).toBe(true);
      expect(customerIds.has(p.customerId)).toBe(true);
    }
  });

  it("a payment's merchantId always matches its customer's merchantId", () => {
    const { customers, payments } = generateDataset(createRng("seed-4"), "run_4");
    const customerById = new Map(customers.map((c) => [c.id, c]));
    for (const p of payments) {
      const customer = customerById.get(p.customerId);
      expect(customer).toBeDefined();
      expect(p.merchantId).toBe(customer!.merchantId);
    }
  });

  it("only assigns a failureCategory to failed payments, and vice versa", () => {
    const { payments } = generateDataset(createRng("seed-5"), "run_5");
    for (const p of payments) {
      if (p.status === "failed") {
        expect(p.failureCategory).not.toBeNull();
        expect(FAILURE_CATEGORIES).toContain(p.failureCategory);
      } else {
        expect(p.failureCategory).toBeNull();
      }
    }
  });

  it("generates all amounts as positive integers (no floats, no zero/negative)", () => {
    const { payments } = generateDataset(createRng("seed-6"), "run_6");
    for (const p of payments) {
      expect(Number.isInteger(p.amount)).toBe(true);
      expect(p.amount).toBeGreaterThan(0);
    }
  });

  it("uses all six failure categories across a large enough sample", () => {
    const { payments } = generateDataset(createRng("seed-large"), "run_large", {
      ...DEFAULT_GENERATOR_OPTIONS,
      merchantCount: 10,
      customersPerMerchant: { min: 20, max: 30 },
      paymentsPerCustomer: { min: 5, max: 8 },
      baseFailureRate: 0.5,
    });
    const seen = new Set(
      payments.filter((p) => p.failureCategory).map((p) => p.failureCategory),
    );
    for (const category of FAILURE_CATEGORIES) {
      expect(seen.has(category)).toBe(true);
    }
  });

  it("high-risk customers fail noticeably more often than low-risk customers (behavioral correlation)", () => {
    const { customers, payments } = generateDataset(
      createRng("seed-correlation"),
      "run_correlation",
      {
        ...DEFAULT_GENERATOR_OPTIONS,
        merchantCount: 6,
        customersPerMerchant: { min: 20, max: 30 },
        paymentsPerCustomer: { min: 6, max: 10 },
      },
    );
    const riskByCustomer = new Map(customers.map((c) => [c.id, c.riskProfile]));

    const rateFor = (profile: "low" | "high") => {
      const relevant = payments.filter((p) => riskByCustomer.get(p.customerId) === profile);
      const failed = relevant.filter((p) => p.status === "failed");
      return failed.length / relevant.length;
    };

    const lowRate = rateFor("low");
    const highRate = rateFor("high");
    expect(highRate).toBeGreaterThan(lowRate);
  });
});
