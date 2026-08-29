import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Simulation + SQLite tests are deterministic but not free-running in parallel
    // against the same on-disk file; each test creates its own isolated
    // in-memory or temp-file database, so default pooling is fine.
    testTimeout: 15000,
  },
});
