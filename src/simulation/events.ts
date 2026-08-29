// =============================================================================
// Event model
// =============================================================================
// Pure helper for constructing AuditEvent records for the 11 canonical
// event types. This module does not persist anything — it just builds
// well-formed, validated event objects; the simulation orchestrator and
// repository layer are responsible for persisting them.
// =============================================================================

import { auditEventSchema } from "../domain/schemas.js";
import type {
  AuditEntityType,
  AuditEvent,
  EventType,
} from "../domain/types.js";
import { IdSequence } from "./ids.js";

export function createEvent(
  ids: IdSequence,
  params: {
    entityType: AuditEntityType;
    entityId: string;
    eventType: EventType;
    occurredAt: Date;
    paymentId: string | null;
    simulationRunId: string;
    payload?: Record<string, unknown>;
  },
): AuditEvent {
  const event: AuditEvent = {
    id: ids.next("evt"),
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: params.eventType,
    payload: params.payload ?? {},
    occurredAt: params.occurredAt,
    paymentId: params.paymentId,
    simulationRunId: params.simulationRunId,
  };
  return auditEventSchema.parse(event);
}

/** Simple in-memory accumulator used while running a simulation; the
 * orchestrator flushes this to the repository at the end of the run. */
export class EventLog {
  private events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    this.events.push(event);
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }
}
