// =============================================================================
// SANDBOX-ONLY SQLite DDL
// =============================================================================
// This DDL is NOT the authoritative data model — prisma/schema.prisma is.
// It exists solely because this sandbox cannot download Prisma's engine
// binaries (see prisma/schema.prisma header and README "Sandbox limitation"
// section). It is hand-mirrored field-for-field from schema.prisma so the
// two never drift silently; if you change one, change the other.
//
// Foreign keys are turned ON (`PRAGMA foreign_keys = ON`) so referential
// integrity is enforced by SQLite itself, not just by application code.
// =============================================================================

export const SCHEMA_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS SimulationRun (
  id                TEXT PRIMARY KEY,
  seed              TEXT NOT NULL,
  generatorVersion  TEXT NOT NULL,
  datasetVersion    TEXT NOT NULL,
  createdAt         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simrun_seed ON SimulationRun(seed);

CREATE TABLE IF NOT EXISTS Merchant (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  simulationRunId  TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_simrun ON Merchant(simulationRunId);

CREATE TABLE IF NOT EXISTS Customer (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  riskProfile      TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  merchantId       TEXT NOT NULL REFERENCES Merchant(id),
  simulationRunId  TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_merchant ON Customer(merchantId);
CREATE INDEX IF NOT EXISTS idx_customer_simrun ON Customer(simulationRunId);

CREATE TABLE IF NOT EXISTS Payment (
  id               TEXT PRIMARY KEY,
  amount           INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  status           TEXT NOT NULL,
  failureCategory  TEXT,
  attemptCount     INTEGER NOT NULL DEFAULT 0,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  merchantId       TEXT NOT NULL REFERENCES Merchant(id),
  customerId       TEXT NOT NULL REFERENCES Customer(id),
  simulationRunId  TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_payment_merchant ON Payment(merchantId);
CREATE INDEX IF NOT EXISTS idx_payment_customer ON Payment(customerId);
CREATE INDEX IF NOT EXISTS idx_payment_simrun ON Payment(simulationRunId);
CREATE INDEX IF NOT EXISTS idx_payment_status ON Payment(status);

CREATE TABLE IF NOT EXISTS RecoveryCase (
  id                     TEXT PRIMARY KEY,
  status                 TEXT NOT NULL,
  openedAt               TEXT NOT NULL,
  closedAt               TEXT,
  recoveryWindowEndsAt   TEXT NOT NULL,
  paymentId              TEXT NOT NULL UNIQUE REFERENCES Payment(id),
  simulationRunId        TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_reccase_simrun ON RecoveryCase(simulationRunId);
CREATE INDEX IF NOT EXISTS idx_reccase_status ON RecoveryCase(status);

CREATE TABLE IF NOT EXISTS RecoveryAttempt (
  id               TEXT PRIMARY KEY,
  attemptNumber    INTEGER NOT NULL,
  strategy         TEXT NOT NULL,
  scheduledAt      TEXT NOT NULL,
  executedAt       TEXT,
  outcome          TEXT NOT NULL,
  amountRecovered  INTEGER,
  recoveryCaseId   TEXT NOT NULL REFERENCES RecoveryCase(id),
  simulationRunId  TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_recattempt_case ON RecoveryAttempt(recoveryCaseId);
CREATE INDEX IF NOT EXISTS idx_recattempt_simrun ON RecoveryAttempt(simulationRunId);

CREATE TABLE IF NOT EXISTS RecoveryPolicy (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  maxRetries          INTEGER NOT NULL,
  retryIntervalHours  TEXT NOT NULL,
  recoveryWindowDays  INTEGER NOT NULL,
  createdAt           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS AuditEvent (
  id               TEXT PRIMARY KEY,
  entityType       TEXT NOT NULL,
  entityId         TEXT NOT NULL,
  eventType        TEXT NOT NULL,
  payload          TEXT NOT NULL,
  occurredAt       TEXT NOT NULL,
  paymentId        TEXT REFERENCES Payment(id),
  simulationRunId  TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_auditevent_simrun ON AuditEvent(simulationRunId);
CREATE INDEX IF NOT EXISTS idx_auditevent_entity ON AuditEvent(entityType, entityId);
CREATE INDEX IF NOT EXISTS idx_auditevent_type ON AuditEvent(eventType);

-- HIDDEN GROUND TRUTH — isolated table. No application code outside
-- src/simulation/groundTruth.ts, src/outcome/simulateOutcome.ts, src/seed.ts,
-- and tests may query this table. There is deliberately no "agent context"
-- query helper anywhere in the codebase that joins against it.
CREATE TABLE IF NOT EXISTS GroundTruth (
  id                   TEXT PRIMARY KEY,
  paymentId            TEXT NOT NULL UNIQUE REFERENCES Payment(id),
  recoverable          INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
  recoveryProbability  REAL NOT NULL,
  bestAction           TEXT NOT NULL,
  recoveredAmount      INTEGER NOT NULL,
  simulationRunId      TEXT NOT NULL REFERENCES SimulationRun(id)
);
CREATE INDEX IF NOT EXISTS idx_groundtruth_simrun ON GroundTruth(simulationRunId);
`;
