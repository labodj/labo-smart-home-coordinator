/**
 * @file Unit tests for the ClickTransactionManager class.
 * These tests verify the core logic of the two-phase commit protocol for network clicks.
 */
import { ClickTransactionManager } from "../ClickTransactionManager";
import type { Actor } from "../types";

describe("ClickTransactionManager", () => {
  /** The instance of the ClickTransactionManager class under test. */
  let manager: ClickTransactionManager;
  /** Test constant for the click timeout in seconds. */
  const CLICK_TIMEOUT_SEC = 10;

  beforeEach(() => {
    manager = new ClickTransactionManager(CLICK_TIMEOUT_SEC);
    // Use fake timers to control time-based logic like timeouts without waiting.
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Restore real timers after each test to avoid side effects.
    jest.useRealTimers();
  });

  it("should start a transaction correctly", () => {
    expect(manager.getPendingCount()).toBe(0);
    manager.startTransaction("slot1", "key1", [], []);
    expect(manager.getPendingCount()).toBe(1);
  });

  it("should consume a pending transaction and return its details", () => {
    const actors: Actor[] = [{ name: "actor1", allActuators: true, actuators: [] }];
    manager.startTransaction("slot1", "key1", actors, ["other1"]);

    const consumed = manager.consumeTransaction("key1");

    expect(consumed).not.toBeNull();
    expect(consumed?.actors).toEqual(actors);
    expect(consumed?.otherActors).toEqual(["other1"]);
    // The transaction should be removed from the pending list after consumption.
    expect(manager.getPendingCount()).toBe(0);
  });

  it("should return null when consuming a non-existent transaction", () => {
    const consumed = manager.consumeTransaction("non-existent-key");
    expect(consumed).toBeNull();
  });

  it("should not clean up a recent transaction", () => {
    manager.startTransaction("slot1", "key1", [], []);

    // Advance time by less than the timeout period.
    jest.advanceTimersByTime((CLICK_TIMEOUT_SEC - 1) * 1000);

    const cleanedCount = manager.cleanupExpired();
    expect(cleanedCount).toBe(0);
    expect(manager.getPendingCount()).toBe(1);
  });

  it("should clean up an expired transaction", () => {
    manager.startTransaction("slot1", "key1", [], []);

    // Advance time by more than the timeout period.
    jest.advanceTimersByTime((CLICK_TIMEOUT_SEC + 1) * 1000);

    const cleanedCount = manager.cleanupExpired();
    expect(cleanedCount).toBe(1);
    expect(manager.getPendingCount()).toBe(0);
  });

  it("keeps the original deadline and targets when a request is repeated", () => {
    manager.startTransaction("a.1.1", "a.1.1.255", [], ["lamp"]);
    jest.advanceTimersByTime(7500);
    manager.startTransaction("a.1.1", "a.1.1.255", [], ["other"]);
    jest.advanceTimersByTime(2501);
    expect(manager.consumeTransaction("a.1.1.255")).toBeNull();
    manager.startTransaction("a.1.1", "a.1.1.1", [], ["lamp"]);
    manager.startTransaction("a.1.1", "a.1.1.1", [], ["other"]);
    expect(manager.consumeTransaction("a.1.1.1")?.otherActors).toEqual(["lamp"]);
    expect(manager.consumeTransaction("a.1.1.1")).toBeNull();
  });

  it.each([true, false])(
    "allows correlation reuse after expiry regardless of cleanup (%s)",
    (sweep) => {
      manager.startTransaction("a.1.1", "a.1.1.1", [], ["first"]);
      jest.advanceTimersByTime(CLICK_TIMEOUT_SEC * 1000 + 1);
      if (sweep) manager.cleanupExpired();
      manager.startTransaction("a.1.1", "a.1.1.1", [], ["second"]);
      expect(manager.consumeTransaction("a.1.1.1")?.otherActors).toEqual(["second"]);
    },
  );

  it("invalidates only pending clicks involving the incompatible device", () => {
    manager.startTransaction("a.1.1", "source", [], []);
    manager.startTransaction(
      "b.1.1",
      "target",
      [{ name: "a", allActuators: true, actuators: [] }],
      [],
    );
    manager.startTransaction("aa.1.1", "unrelated", [], []);
    manager.clearDevice("a");
    expect(manager.consumeTransaction("source")).toBeNull();
    expect(manager.consumeTransaction("target")).toBeNull();
    expect(manager.consumeTransaction("unrelated")).not.toBeNull();
  });

  it("should replace the previous correlation for the same logical slot", () => {
    manager.startTransaction("slot1", "key1", [], []);
    manager.startTransaction("slot1", "key2", [], []);

    expect(manager.consumeTransaction("key1")).toBeNull();
    expect(manager.consumeTransaction("key2")).not.toBeNull();
  });

  it("should reject an expired transaction even before cleanup runs", () => {
    manager.startTransaction("slot1", "key1", [], []);

    jest.advanceTimersByTime((CLICK_TIMEOUT_SEC + 1) * 1000);

    expect(manager.consumeTransaction("key1")).toBeNull();
    expect(manager.getPendingCount()).toBe(0);
  });
});
