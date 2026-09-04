# R2S — Demo Script (3–5 minutes)

A beat-by-beat walkthrough for presenting R2S to judges. Each beat names what to show and what to say. Total target time: ~4 minutes; trim beats 3–4 if you're short on time, never trim beat 9 (the honest results) or beat 10 (the RNG story) — those are the credibility anchors.

---

### 1. The problem (30s)
**Show:** nothing yet, just talk.
**Say:** "When a payment fails, a merchant has two bad default options: retry blindly on a fixed schedule, or escalate to a human too early. Both waste money — blind retries on failures that will never succeed, premature escalation on failures a simple nudge would have fixed. R2S decides per-payment, based on context, what action is actually worth taking."

### 2. Failed payment simulation (30s)
**Show:** `npm run seed`, or a sample record from the generated world — a payment with a failure category (e.g. `insufficient_funds`), amount, and merchant.
**Say:** "This is a synthetic world — merchants, customers, payments — generated from a seed, so it's fully reproducible. Every failed payment is tagged with a hidden ground-truth failure category and a hidden 'best action.' That answer key exists only here, in the simulation layer."

### 3. Assessment (30s)
**Show:** the `RecoveryFeatures` object built for that payment — failure category, prior attempt count, days remaining in the recovery window, case status — and the ranked candidate actions it produces.
**Say:** "The assessment engine builds this purely from what would actually be observable in production: attempt history, time remaining, case state. It never touches the hidden ground truth. This is the only information that gets passed forward."

### 4. AI recommendation (30s)
**Show:** the sanitized `AgentDecisionRequest` going into `MockAIProvider`, and the structured JSON decision coming back (action + rationale).
**Say:** "This sanitized context is the *only* thing the AI ever sees — ground truth is structurally excluded from this type, not just filtered by convention. The AI is a deterministic mock, so there's zero cost and zero external dependency, but it plays the same advisor role a real LLM call would."

### 5. Policy approval / rejection (30s)
**Show:** one case where the policy engine approves the AI's action, and — if you have one ready — a case where it downgrades or blocks it (e.g. a retry blocked because `maxRetries` is already reached, or an incentive capped by `maxIncentivePercent`).
**Say:** "The AI never gets the final word. Every recommendation passes through a deterministic policy engine that enforces hard limits — retry counts, recovery window, incentive caps, a high-value-payment threshold. This is what keeps the system safe regardless of what the AI says."

### 6. Recovery action (20s)
**Show:** the approved action reaching `RecoveryExecutor`, and the idempotency key being reserved before execution.
**Say:** "Only a policy-approved action reaches the executor — and it's simulation-only, it never calls a real gateway. Every execution is keyed by a durable, SQLite-backed idempotency key, reserved before the action runs, so nothing can be double-executed — even if the process crashes mid-flight."

### 7. Outcome (20s)
**Show:** the action-conditioned outcome for that attempt, and the lifecycle transition (e.g. `retrying` → `recovered`).
**Say:** "Whether the attempt succeeds depends on which action was taken, not a fixed probability — and the randomness driving that outcome is now payment-local, which matters for the fairness story in a minute."

### 8. Metrics (20s)
**Show:** a per-run metrics summary — attempts, recovery rate, revenue.
**Say:** "Every run produces a full metrics breakdown: attempts, recovery rate, revenue recovered, and — for R2S specifically — how often its decisions matched the best available option."

### 9. Baseline vs. R2S evaluation — the honest table (40s)
**Show:** the results table from `README.md` §4 / `evaluation-results/evaluation-v1.json`.
**Say:** "Here's the real result, 5 seeds, fairness-controlled: baseline recovers 56.99%, R2S recovers 53.50% — R2S currently trails on raw recovery. But R2S does this with about 31% fewer attempts, and recovers ₹570 per attempt versus baseline's ₹420 — a 35% efficiency win. We're not hiding the gap. Fewer, better-targeted actions instead of exhaustive retrying is a real trade-off, and it's the one we're reporting."

### 10. The RNG story — your strongest credibility moment (30s)
**Show:** the methodology section, specifically the `createRng(seed:paymentId)` fix.
**Say:** "The first version of this evaluation had a subtler problem: we were drawing outcome randomness from one shared stream per strategy, consumed in order. That meant one payment's attempt count could shift the random draws every *later* payment in that run received — contamination that had nothing to do with decision quality. We found this ourselves, fixed it to draw randomness per-payment instead of per-stream, and then ran a single controlled experiment — raising an escalation threshold from `>0` to `>=2` prior failures — which reproducibly closed part of the gap across all 5 seeds. That's the story: real engineering, a self-found methodology bug, and one evaluated, narrowly-scoped fix — not a cherry-picked benchmark."

---

## Closing line

"What we're submitting is an auditable AI revenue-recovery system with a rigorous, self-correcting evaluation methodology — not a cherry-picked benchmark win. R2S doesn't beat baseline on volume yet; it beats it on precision, and the whole pipeline — including where it currently falls short — is verifiable end to end in the test suite."

---

## If asked follow-up questions

- **"Why not just tune the model until it beats baseline?"** — Because the point of the evaluation harness is to produce a trustworthy number, not a flattering one. Every prior milestone is frozen; the only two changes made after the first honest result were a methodology bug fix (RNG) and one pre-specified, evaluated threshold change. Tuning further based on the outcome would defeat the purpose.
- **"Why a mock AI instead of a real LLM?"** — Hard ₹0 constraint for the buildathon track. The architecture (advisor-only AI, policy-as-final-authority, structural ground-truth isolation) is exactly what you'd want with a real LLM in production — swapping `MockAIProvider` for a real `AIProvider` implementation is the only change required.
- **"What stops the AI from doing something unsafe?"** — The policy engine, not the AI's own judgment. It has hard-coded, deterministic limits (max retries, recovery window, incentive cap, high-value threshold) and can override or block any AI recommendation. This is verified by dedicated policy tests independent of what the AI outputs.
