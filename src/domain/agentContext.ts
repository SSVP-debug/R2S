// =============================================================================
// Agent-facing context builder
// =============================================================================
// This is the ONLY function that should ever be used to build data for a
// future recovery agent. It takes domain entities directly (never a
// GroundTruth object — note there is no GroundTruth parameter in this
// function's signature at all) and returns AgentPaymentContext, validated
// against agentPaymentContextSchema.
//
// There is no code path in this file that can reach GroundTruth: the type
// system enforces it (no GroundTruth import here), and
// agentPaymentContextSchema.parse() enforces the output shape at runtime.
// =============================================================================

import {
  agentPaymentContextSchema,
  type AgentPaymentContext,
} from "./schemas.js";
import type {
  Payment,
  Merchant,
  Customer,
  RecoveryCase,
  RecoveryAttempt,
} from "./types.js";

export function buildAgentPaymentContext(input: {
  payment: Payment;
  merchant: Merchant;
  customer: Customer;
  recoveryCase: RecoveryCase | null;
  priorAttempts: RecoveryAttempt[];
}): AgentPaymentContext {
  const { payment, merchant, customer, recoveryCase, priorAttempts } = input;

  const context: AgentPaymentContext = {
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    failureCategory: payment.failureCategory,
    attemptCount: payment.attemptCount,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,

    merchant: {
      id: merchant.id,
      category: merchant.category,
    },

    customer: {
      id: customer.id,
      riskProfile: customer.riskProfile,
    },

    recoveryCase: recoveryCase
      ? {
          id: recoveryCase.id,
          status: recoveryCase.status,
          openedAt: recoveryCase.openedAt,
          recoveryWindowEndsAt: recoveryCase.recoveryWindowEndsAt,
        }
      : null,

    priorAttempts: priorAttempts
      .slice()
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((a) => ({
        attemptNumber: a.attemptNumber,
        strategy: a.strategy,
        scheduledAt: a.scheduledAt,
        executedAt: a.executedAt,
        outcome: a.outcome,
      })),
  };

  // Validate the exact shape at runtime — this will throw if any extra
  // (e.g. ground-truth) field were ever accidentally added above, because
  // Zod's default behavior on unknown keys combined with our explicit
  // object shape means only these fields can ever be returned.
  return agentPaymentContextSchema.parse(context);
}
