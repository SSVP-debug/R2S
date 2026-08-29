// =============================================================================
// Seed script
// =============================================================================
// CLI entry point: generates a full R2S synthetic dataset and persists it.
//
// SANDBOX NOTE: persists via SqliteRepository (src/db/repository.ts), which
// uses node:sqlite in this sandbox session because @prisma/client's engine
// binary cannot be downloaded here. See prisma/schema.prisma and README for
// the real-Prisma migration path. No product/domain logic here is
// sandbox-specific — only the `new SqliteRepository(...)` line would change
// to a Prisma-backed repository implementation.
//
// Usage:
//   npx tsx src/seed.ts [seed] [outputPath]
//   npx tsx src/seed.ts demo-seed-1 ./r2s.db
// =============================================================================

import { SqliteRepository } from "./db/repository.js";
import { runSimulation } from "./simulation/runSimulation.js";

function main(): void {
  const seed = process.argv[2] ?? "r2s-default-seed";
  const outputPath = process.argv[3] ?? "./r2s.db";

  console.log(`R2S seed — seed="${seed}" output="${outputPath}"`);

  const repo = new SqliteRepository(outputPath);
  try {
    const summary = runSimulation({ seed, repo });
    console.log("Simulation complete:");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    repo.close();
  }
}

main();
