// =============================================================================
// Synthetic data generator
// =============================================================================
// Generates merchants, customers, and payment history (including failed
// payments) with realistic behavioral correlations, entirely from the
// seeded RNG. No Math.random(), no wall-clock dependence in the generated
// business data (a fixed simulated "now" anchor is used so datasets are
// reproducible independent of when the generator is run).
// =============================================================================

import type { Rng } from "./rng.js";
import { IdSequence } from "./ids.js";
import { weightedFailureCategories } from "./failureTaxonomy.js";
import {
  MERCHANT_CATEGORIES,
  RISK_PROFILES,
  type Merchant,
  type Customer,
  type Payment,
  type RiskProfile,
} from "../domain/types.js";

export interface GeneratorOptions {
  merchantCount: number;
  customersPerMerchant: { min: number; max: number };
  paymentsPerCustomer: { min: number; max: number };
  /** Base probability a given payment fails, before risk-profile adjustment. */
  baseFailureRate: number;
  /** Anchor "now" for generated business timestamps — kept fixed per run so
   * the same seed always produces the same timestamps regardless of wall
   * clock time. */
  simulatedNow: Date;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  merchantCount: 5,
  customersPerMerchant: { min: 8, max: 20 },
  paymentsPerCustomer: { min: 2, max: 6 },
  baseFailureRate: 0.3,
  simulatedNow: new Date("2026-08-29T00:00:00.000Z"),
};

const RISK_PROFILE_WEIGHTS: Record<RiskProfile, number> = {
  low: 50,
  medium: 35,
  high: 15,
};

/** Failure-rate multiplier by risk profile — higher risk customers fail more
 * often, on top of the per-category weighting already applied. */
const RISK_PROFILE_FAILURE_RATE_MULTIPLIER: Record<RiskProfile, number> = {
  low: 0.5,
  medium: 1.0,
  high: 1.8,
};

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Rohan", "Ananya", "Diya", "Saanvi", "Aadhya", "Kiara", "Myra",
  "Anika", "Navya", "Riya", "Priya",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Reddy", "Iyer", "Nair", "Patel", "Singh",
  "Rao", "Menon", "Kulkarni", "Das", "Chatterjee", "Pillai", "Joshi",
];
const MERCHANT_NAME_PARTS = [
  "Kirana", "Bazaar", "Mart", "Express", "Hub", "Store", "Traders",
  "Ventures", "Digital", "Retail", "Logistics", "Services",
];

export interface GeneratedDataset {
  merchants: Merchant[];
  customers: Customer[];
  payments: Payment[];
}

export function generateMerchants(
  rng: Rng,
  ids: IdSequence,
  simulationRunId: string,
  options: GeneratorOptions,
): Merchant[] {
  const merchants: Merchant[] = [];
  for (let i = 0; i < options.merchantCount; i++) {
    const category = rng.pick(MERCHANT_CATEGORIES);
    const name = `${rng.pick(MERCHANT_NAME_PARTS)} ${rng.pick(MERCHANT_NAME_PARTS)}`;
    merchants.push({
      id: ids.next("mch"),
      name,
      category,
      createdAt: options.simulatedNow,
      simulationRunId,
    });
  }
  return merchants;
}

export function generateCustomers(
  rng: Rng,
  ids: IdSequence,
  simulationRunId: string,
  merchants: Merchant[],
  options: GeneratorOptions,
): Customer[] {
  const customers: Customer[] = [];
  for (const merchant of merchants) {
    const count = rng.int(
      options.customersPerMerchant.min,
      options.customersPerMerchant.max,
    );
    for (let i = 0; i < count; i++) {
      const riskProfile = rng.weightedPick(
        RISK_PROFILES,
        RISK_PROFILES.map((p) => RISK_PROFILE_WEIGHTS[p]),
      );
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      const id = ids.next("cus");
      customers.push({
        id,
        name: `${first} ${last}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}.${id}@example-mail.test`,
        riskProfile,
        createdAt: options.simulatedNow,
        merchantId: merchant.id,
        simulationRunId,
      });
    }
  }
  return customers;
}

/** Returns both the generated payments AND, for each *failed* payment, the
 * customer risk profile it was generated with — the caller needs the risk
 * profile again to compute ground truth without re-deriving it. */
export function generatePayments(
  rng: Rng,
  ids: IdSequence,
  simulationRunId: string,
  customers: Customer[],
  options: GeneratorOptions,
): Payment[] {
  const payments: Payment[] = [];

  for (const customer of customers) {
    const count = rng.int(
      options.paymentsPerCustomer.min,
      options.paymentsPerCustomer.max,
    );
    for (let i = 0; i < count; i++) {
      // Amount: skewed towards small/medium transactions, occasional large
      // ones — gaussian in log-space keeps it strictly positive.
      const amount = Math.max(
        10000, // 100.00 INR minimum, in paise
        Math.round(rng.gaussian(150000, 120000)),
      );

      const failureRate =
        options.baseFailureRate *
        RISK_PROFILE_FAILURE_RATE_MULTIPLIER[customer.riskProfile];
      const failed = rng.bool(Math.min(failureRate, 0.95));

      const createdAt = new Date(
        options.simulatedNow.getTime() -
          rng.int(0, 30) * 24 * 60 * 60 * 1000 -
          rng.int(0, 86_400_000),
      );

      if (!failed) {
        payments.push({
          id: ids.next("pay"),
          amount,
          currency: "INR",
          status: "created",
          failureCategory: null,
          attemptCount: 0,
          createdAt,
          updatedAt: createdAt,
          merchantId: customer.merchantId,
          customerId: customer.id,
          simulationRunId,
        });
        continue;
      }

      const weighted = weightedFailureCategories(customer.riskProfile);
      const failureCategory = rng.weightedPick(
        weighted.map((w) => w.category),
        weighted.map((w) => w.weight),
      );

      payments.push({
        id: ids.next("pay"),
        amount,
        currency: "INR",
        status: "failed",
        failureCategory,
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt,
        merchantId: customer.merchantId,
        customerId: customer.id,
        simulationRunId,
      });
    }
  }

  return payments;
}

export function generateDataset(
  rng: Rng,
  simulationRunId: string,
  options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS,
): GeneratedDataset {
  const ids = new IdSequence();
  const merchants = generateMerchants(rng, ids, simulationRunId, options);
  const customers = generateCustomers(rng, ids, simulationRunId, merchants, options);
  const payments = generatePayments(rng, ids, simulationRunId, customers, options);
  return { merchants, customers, payments };
}
