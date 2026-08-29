import { describe, it, expect } from "vitest";
import { createEvent, EventLog } from "../src/simulation/events.js";
import { IdSequence } from "../src/simulation/ids.js";
import { EVENT_TYPES } from "../src/domain/types.js";

describe("event model", () => {
  it("can construct a valid event for every one of the 11 canonical event types", () => {
    const ids = new IdSequence();
    for (const eventType of EVENT_TYPES) {
      const event = createEvent(ids, {
        entityType: "Payment",
        entityId: "pay_1",
        eventType,
        occurredAt: new Date("2026-08-29T00:00:00.000Z"),
        paymentId: "pay_1",
        simulationRunId: "run_test",
      });
      expect(event.eventType).toBe(eventType);
      expect(event.id).toMatch(/^evt_\d{6}$/);
    }
  });

  it("assigns unique, sequential ids across events", () => {
    const ids = new IdSequence();
    const a = createEvent(ids, {
      entityType: "Payment",
      entityId: "pay_1",
      eventType: "payment_created",
      occurredAt: new Date(),
      paymentId: "pay_1",
      simulationRunId: "run_test",
    });
    const b = createEvent(ids, {
      entityType: "Payment",
      entityId: "pay_1",
      eventType: "payment_failed",
      occurredAt: new Date(),
      paymentId: "pay_1",
      simulationRunId: "run_test",
    });
    expect(a.id).not.toBe(b.id);
  });

  it("EventLog accumulates events in insertion order", () => {
    const ids = new IdSequence();
    const log = new EventLog();
    const e1 = createEvent(ids, {
      entityType: "Payment",
      entityId: "pay_1",
      eventType: "payment_created",
      occurredAt: new Date(),
      paymentId: "pay_1",
      simulationRunId: "run_test",
    });
    const e2 = createEvent(ids, {
      entityType: "Payment",
      entityId: "pay_1",
      eventType: "payment_failed",
      occurredAt: new Date(),
      paymentId: "pay_1",
      simulationRunId: "run_test",
    });
    log.record(e1);
    log.record(e2);
    expect(log.all()).toEqual([e1, e2]);
  });

  it("rejects an unrecognized event type at the schema level", () => {
    const ids = new IdSequence();
    expect(() =>
      createEvent(ids, {
        entityType: "Payment",
        entityId: "pay_1",
        // @ts-expect-error deliberately invalid for the test
        eventType: "not_a_real_event",
        occurredAt: new Date(),
        paymentId: "pay_1",
        simulationRunId: "run_test",
      }),
    ).toThrow();
  });
});
