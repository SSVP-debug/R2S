// =============================================================================
// SANDBOX-ONLY SQLite driver (node:sqlite)
// =============================================================================
// This is NOT Prisma. It exists only because this sandbox's network
// allowlist blocks binaries.prisma.sh, so `@prisma/client` cannot download
// its query engine here (see prisma/schema.prisma header for full
// explanation). This module is the only place in the codebase that touches
// `node:sqlite` directly — everything else goes through
// src/db/repository.ts's R2SRepository interface, which is written so it
// could be re-implemented on top of a real generated `@prisma/client`
// without any change to domain/simulation code.
//
// node:sqlite ships built into Node.js 22+ and requires zero additional
// npm dependencies, which is why it was chosen as the fallback driver
// instead of e.g. better-sqlite3 (a real npm package, not approved for
// this milestone) or an in-memory JS array store (which would not exercise
// real SQLite persistence/constraint behavior, as required).
// =============================================================================

import { DatabaseSync } from "node:sqlite";
import { SCHEMA_DDL } from "./ddl.js";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_DDL);
  return db;
}

export function openInMemoryDatabase(): DatabaseSync {
  return openDatabase(":memory:");
}
