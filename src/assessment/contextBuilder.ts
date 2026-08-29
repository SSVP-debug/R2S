// =============================================================================
// Assessment context builder (Aug 30)
// =============================================================================
// Assembles the agent-facing context for a payment by pulling
// Payment/Merchant/Customer/RecoveryCase/RecoveryAttempt rows out of the
// repository and handing them to the EXISTING (unmodified)
// buildAgentPaymentContext() from Day 1 (src/domain/agentContext.ts).
//
// This function does not import GroundTruth and does not call
// repository.getGroundTruthByPayment — it only reaches the same
// repository methods an agent-facing surface was always allowed to use.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import { buildAgentPaymentContext } from "../domain/agentContext.js";
import type { AgentPaymentContext } from "../domain/schemas.js";

export function buildAssessmentContext(
  repo: R2SRepository,
  paymentId: string,
): AgentPaymentContext {
  const payment = repo.getPayment(paymentId);
  if (!payment) {
    throw new Error(`buildAssessmentContext(): Payment ${paymentId} not found`);
  }

  const merchant = repo.getMerchant(payment.merchantId);
  if (!merchant) {
    throw new Error(
      `buildAssessmentContext(): Merchant ${payment.merchantId} not found for payment ${paymentId}`,
    );
  }

  const customer = repo.getCustomer(payment.customerId);
  if (!customer) {
    throw new Error(
      `buildAssessmentContext(): Customer ${payment.customerId} not found for payment ${paymentId}`,
    );
  }

  const recoveryCase = repo.getRecoveryCaseByPayment(paymentId);
  const priorAttempts = recoveryCase
    ? repo.listRecoveryAttemptsByCase(recoveryCase.id)
    : [];

  return buildAgentPaymentContext({
    payment,
    merchant,
    customer,
    recoveryCase,
    priorAttempts,
  });
}
