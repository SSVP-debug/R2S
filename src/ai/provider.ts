// =============================================================================
// AI provider abstraction (Aug 31)
// =============================================================================
// Any provider — mock, or a real free/local LLM plugged in later — must
// implement this interface. No provider implementation may reach the
// repository or execute anything; a provider's only job is to look at an
// AgentDecisionRequest and return an AgentDecision.
//
// A real provider is intentionally NOT implemented today (per scope). Only
// MockAIProvider (src/ai/mockProvider.ts) exists, for tests/local dev.
// =============================================================================

import type { AgentDecision, AgentDecisionRequest } from "./types.js";

export interface AIProvider {
  generateDecision(request: AgentDecisionRequest): Promise<AgentDecision>;
}
