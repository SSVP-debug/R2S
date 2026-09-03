// =============================================================================
// `npm run evaluate` CLI entry point (Sep 2, corrected)
// =============================================================================
// Runs the standard 5-seed evaluation at the spec's target scale (~1,000
// eligible failed payments per seed — see experimentRunner.ts's
// EVALUATION_SCALE_GENERATOR_OPTIONS, runEvaluation()'s default) and prints
// a concise report. Writes the full machine-readable result to
// evaluation-results/evaluation-v1.json.
//
// No UI, no dashboard — plain stdout text plus a JSON artifact, per spec.
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvaluation, DEFAULT_EVALUATION_SEEDS } from "../evaluation/experimentRunner.js";
import { renderReport } from "../evaluation/report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "..", "evaluation-results", "evaluation-v1.json");

async function main(): Promise<void> {
  const result = await runEvaluation({ seeds: DEFAULT_EVALUATION_SEEDS });

  console.log(renderReport(result));

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\nFull result written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
