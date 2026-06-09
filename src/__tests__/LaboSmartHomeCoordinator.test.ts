import {
  clearInterval as realClearInterval,
  clearTimeout as realClearTimeout,
  setInterval as realSetInterval,
  setTimeout as realSetTimeout,
} from "node:timers";

import { LaboSmartHomeCoordinator } from "../LaboSmartHomeCoordinator";
import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "../types";
import type { MqttMessage, ServiceResult, SystemConfig } from "../types";

const restoreRealTimerGlobals = (): void => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
};

const systemConfig: SystemConfig = {
  devices: [
    {
      name: "source",
      longClickButtons: [
        {
          id: 1,
          actors: [{ name: "target", allActuators: true, actuators: [] }],
          otherActors: [],
        },
      ],
    },
    { name: "target" },
  ],
};

const createCoordinator = (
  config: SystemConfig = systemConfig,
  overrides: Partial<ConstructorParameters<typeof LaboSmartHomeCoordinator>[0]> = {},
) =>
  new LaboSmartHomeCoordinator({
    systemConfig: config,
    clickCleanupInterval: 60,
    watchdogInterval: 60,
    initialStateTimeout: 60,
    pingTimeout: 60,
    ...overrides,
  });

type CoordinatorInternals = {
  processServiceResult(result: ServiceResult): Promise<void>;
  service: {
    runWatchdogCheck(): ServiceResult;
  };
};

const getInternals = (coordinator: LaboSmartHomeCoordinator): CoordinatorInternals =>
  coordinator as unknown as CoordinatorInternals;

const createServiceResult = (overrides: Partial<ServiceResult> = {}): ServiceResult => ({
  messages: {},
  logs: [],
  warnings: [],
  errors: [],
  stateChanged: false,
  ...overrides,
});

const sendDeviceOnline = async (
  coordinator: LaboSmartHomeCoordinator,
  deviceName: string,
): Promise<void> => {
  await coordinator.processMqttMessage({
    topic: `LSH/${deviceName}/conf`,
    payload: {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: deviceName,
      a: [1],
      b: [1],
    },
  });
  await coordinator.processMqttMessage({
    topic: `LSH/${deviceName}/state`,
    payload: { p: LshProtocol.ACTUATORS_STATE, s: [0] },
  });
  await coordinator.processMqttMessage({
    topic: `homie/5/${deviceName}/$state`,
    payload: "ready",
  });
};

describe("LaboSmartHomeCoordinator", () => {
  afterEach(() => {
    jest.useRealTimers();
    restoreRealTimerGlobals();
  });

  it("starts, emits state/config events and exposes generated subscriptions", async () => {
    const coordinator = createCoordinator();
    const statuses: string[] = [];
    const configs: SystemConfig[] = [];
    const states: unknown[] = [];

    coordinator.on("status", (status) => statuses.push(status));
    coordinator.on("config", (config) => configs.push(config));
    coordinator.on("state", (state) => states.push(state));

    await coordinator.start();
    try {
      expect(statuses).toContain("starting");
      expect(statuses).toContain("warming_up");
      expect(statuses).toContain("ready");
      expect(configs).toHaveLength(1);
      expect(states.length).toBeGreaterThanOrEqual(1);
      expect(coordinator.getSubscriptions()).toHaveProperty("LSH/source/conf", { qos: 2 });
    } finally {
      await coordinator.stop();
    }
  });

  it("turns a confirmed distributed click into MQTT command events", async () => {
    const coordinator = createCoordinator();
    const mqttMessages: MqttMessage[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await sendDeviceOnline(coordinator, "target");

      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_REQUEST,
          c: 10,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_CONFIRM,
          c: 10,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.flush();

      expect(mqttMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "LSH/source/IN",
            payload: {
              p: LshProtocol.NETWORK_CLICK_ACK,
              c: 10,
              i: 1,
              t: ClickType.Long,
            },
          }),
          expect.objectContaining({
            topic: "LSH/target/IN",
            payload: { p: LshProtocol.SET_STATE, s: [1] },
          }),
        ]),
      );
    } finally {
      await coordinator.stop();
    }
  });

  it("accepts JSON protocol payloads as objects, JSON strings or Buffers", async () => {
    const coordinator = createCoordinator({ devices: [{ name: "source" }] });
    const states: unknown[] = [];
    coordinator.on("state", (snapshot) => states.push(snapshot));

    await coordinator.start();
    try {
      await coordinator.processMqttMessage({
        topic: "LSH/source/conf",
        payload: Buffer.from(
          JSON.stringify({
            p: LshProtocol.DEVICE_DETAILS,
            v: LSH_WIRE_PROTOCOL_MAJOR,
            n: "source",
            a: [1],
            b: [1],
          }),
        ),
      });
      await coordinator.processMqttMessage({
        topic: "LSH/source/state",
        payload: JSON.stringify({ p: LshProtocol.ACTUATORS_STATE, s: [1] }),
      });
      await coordinator.processMqttMessage({
        topic: "homie/5/source/$state",
        payload: Buffer.from("ready"),
      });

      expect(coordinator.getDeviceRegistry().source).toMatchObject({
        connected: true,
        actuatorStates: [true],
      });
      expect(states.length).toBeGreaterThanOrEqual(3);
    } finally {
      await coordinator.stop();
    }
  });

  it("emits generic other-actor intents for external targets", async () => {
    const externalConfig: SystemConfig = {
      devices: [
        {
          name: "source",
          longClickButtons: [{ id: 1, actors: [], otherActors: ["bedside_lamp"] }],
        },
      ],
    };
    const coordinator = createCoordinator(externalConfig, {
      otherActorStateReader: {
        get: jest.fn().mockReturnValue(false),
      },
    });
    const otherActorIntents: unknown[] = [];
    coordinator.on("otherActors", (payload) => otherActorIntents.push(payload));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_REQUEST,
          c: 11,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_CONFIRM,
          c: 11,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.flush();

      expect(otherActorIntents).toContainEqual({
        otherActors: ["bedside_lamp"],
        stateToSet: true,
      });
    } finally {
      await coordinator.stop();
    }
  });

  it("uses a safe empty external-state reader when no reader is configured", async () => {
    const externalConfig: SystemConfig = {
      devices: [
        {
          name: "source",
          longClickButtons: [{ id: 1, actors: [], otherActors: ["bedside_lamp"] }],
        },
      ],
    };
    const coordinator = createCoordinator(externalConfig);
    const otherActorIntents: unknown[] = [];
    const warnings: string[] = [];
    coordinator.on("otherActors", (payload) => otherActorIntents.push(payload));
    coordinator.on("warning", (message) => warnings.push(message));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_REQUEST,
          c: 12,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.processMqttMessage({
        topic: "LSH/source/events",
        payload: {
          p: LshProtocol.NETWORK_CLICK_CONFIRM,
          c: 12,
          i: 1,
          t: ClickType.Long,
        },
      });
      await coordinator.flush();

      expect(otherActorIntents).toEqual([]);
      expect(warnings).toContain("State for otherActor 'bedside_lamp' not found or not a boolean.");
    } finally {
      await coordinator.stop();
    }
  });

  it("runs startup BOOT replay and warm-up timers deterministically", async () => {
    jest.useFakeTimers();
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    const logs: string[] = [];
    const alerts: unknown[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));
    coordinator.on("log", (message) => logs.push(message));
    coordinator.on("alert", (payload) => alerts.push(payload));

    await coordinator.start();
    try {
      await jest.advanceTimersByTimeAsync(500);
      await coordinator.flush();

      expect(mqttMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "LSH/Node-RED/SRV",
            payload: { p: LshProtocol.BOOT },
          }),
        ]),
      );

      await jest.advanceTimersByTimeAsync(5);
      await coordinator.flush();
      expect(logs).toContain("Running initial device state verification.");

      await jest.advanceTimersByTimeAsync(5);
      await coordinator.runWatchdogNow();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
    }
  });

  it("skips startup BOOT replay when retained snapshots complete during the settle window", async () => {
    jest.useFakeTimers();
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    const logs: string[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await jest.advanceTimersByTimeAsync(500);
      await coordinator.flush();

      expect(mqttMessages).not.toContainEqual(
        expect.objectContaining({
          topic: "LSH/Node-RED/SRV",
          payload: { p: LshProtocol.BOOT },
        }),
      );
      expect(logs).toContain(
        "Skipping startup BOOT replay because all configured devices already have authoritative snapshots.",
      );
      expect(logs).toContain("Running initial device state verification.");
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
    }
  });

  it("runs post-startup recovery after a runtime config adds a missing device", async () => {
    jest.useFakeTimers();
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    const logs: string[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await jest.advanceTimersByTimeAsync(505);
      await coordinator.flush();
      mqttMessages.length = 0;

      await coordinator.updateSystemConfig({
        devices: [{ name: "source" }, { name: "garage" }],
      });
      await jest.advanceTimersByTimeAsync(500);
      await coordinator.flush();

      expect(logs).toContain("Running post-config device recovery.");
      expect(logs).toContain(
        "Config update left missing snapshots. Requesting bridge-local BOOT resync.",
      );
      expect(mqttMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "LSH/Node-RED/SRV",
            payload: { p: LshProtocol.BOOT },
          }),
        ]),
      );

      await jest.advanceTimersByTimeAsync(2);
      await coordinator.flush();
      expect(logs).toContain("Running initial device state verification.");
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
    }
  });

  it("runs post-startup verification without BOOT when runtime config is already complete", async () => {
    jest.useFakeTimers();
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    const logs: string[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await jest.advanceTimersByTimeAsync(505);
      await coordinator.flush();
      mqttMessages.length = 0;

      await coordinator.updateSystemConfig({ devices: [{ name: "source" }] });
      await jest.advanceTimersByTimeAsync(500);
      await coordinator.flush();

      expect(logs).toContain("Running post-config device recovery.");
      expect(mqttMessages).not.toContainEqual(
        expect.objectContaining({
          topic: "LSH/Node-RED/SRV",
          payload: { p: LshProtocol.BOOT },
        }),
      );
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
    }
  });

  it("drops stale low-priority recovery messages after a runtime config change", async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(1);
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }, { name: "target" }] },
      {
        initialStateTimeout: 60,
        pingTimeout: 60,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));

    await coordinator.start();
    try {
      await getInternals(coordinator).processServiceResult(
        createServiceResult({
          staggerLshMessages: true,
          messages: {
            [Output.Lsh]: [
              { topic: "LSH/source/IN", payload: { p: LshProtocol.PING } },
              { topic: "LSH/target/IN", payload: { p: LshProtocol.PING } },
            ],
          },
        }),
      );

      await Promise.resolve();
      await coordinator.updateSystemConfig({ devices: [{ name: "source" }] });
      await jest.advanceTimersByTimeAsync(300);
      await coordinator.flush();

      expect(mqttMessages).toEqual([
        expect.objectContaining({
          topic: "LSH/source/IN",
          payload: { p: LshProtocol.PING },
        }),
      ]);
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it("cancels pending low-priority recovery messages when stopping", async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(1);
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }, { name: "target" }] },
      {
        initialStateTimeout: 60,
        pingTimeout: 60,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const mqttMessages: MqttMessage[] = [];
    coordinator.on("mqtt", (message) => mqttMessages.push(message));

    await coordinator.start();
    try {
      await getInternals(coordinator).processServiceResult(
        createServiceResult({
          staggerLshMessages: true,
          messages: {
            [Output.Lsh]: [
              { topic: "LSH/source/IN", payload: { p: LshProtocol.PING } },
              { topic: "LSH/target/IN", payload: { p: LshProtocol.PING } },
            ],
          },
        }),
      );

      await Promise.resolve();
      const stopPromise = coordinator.stop();
      await jest.advanceTimersByTimeAsync(300);
      await stopPromise;
      await coordinator.flush();

      expect(mqttMessages).toHaveLength(1);
      expect(mqttMessages[0]).toMatchObject({
        topic: "LSH/source/IN",
        payload: { p: LshProtocol.PING },
      });
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it("coalesces overlapping manual watchdog runs into ordered cycles", async () => {
    jest.useFakeTimers();
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const internals = getInternals(coordinator);
    const watchdogSpy = jest
      .spyOn(internals.service, "runWatchdogCheck")
      .mockReturnValue(createServiceResult());

    await coordinator.start();
    try {
      await sendDeviceOnline(coordinator, "source");
      await jest.advanceTimersByTimeAsync(505);
      await coordinator.flush();

      await Promise.all([coordinator.runWatchdogNow(), coordinator.runWatchdogNow()]);

      expect(watchdogSpy).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.stop();
      jest.useRealTimers();
      watchdogSpy.mockRestore();
    }
  });

  it("keeps unhealthy alerts while suppressing warm-up recovery noise", async () => {
    const coordinator = createCoordinator({ devices: [{ name: "source" }] });
    const alerts: unknown[] = [];
    const logs: string[] = [];
    coordinator.on("alert", (payload) => alerts.push(payload));
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await getInternals(coordinator).processServiceResult(
        createServiceResult({
          messages: {
            [Output.Alerts]: [
              {
                payload: {
                  status: "healthy",
                  message: "source recovered",
                  event_type: "device_recovered",
                  event_source: "watchdog",
                  devices: [{ name: "source", reason: "reachable" }],
                },
              },
              {
                payload: {
                  status: "unhealthy",
                  message: "source is offline",
                  event_type: "device_unreachable",
                  event_source: "watchdog",
                  devices: [{ name: "source", reason: "timeout" }],
                },
              },
            ],
          },
        }),
      );

      expect(logs).toContain("Suppressing recovery alert during warm-up period.");
      expect(alerts).toEqual([
        {
          status: "unhealthy",
          message: "source is offline",
          event_type: "device_unreachable",
          event_source: "watchdog",
          devices: [{ name: "source", reason: "timeout" }],
        },
      ]);
    } finally {
      await coordinator.stop();
    }
  });

  it("does not suppress unhealthy warm-up alerts", async () => {
    const coordinator = createCoordinator({ devices: [{ name: "source" }] });
    const alerts: unknown[] = [];
    const logs: string[] = [];
    coordinator.on("alert", (payload) => alerts.push(payload));
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await getInternals(coordinator).processServiceResult(
        createServiceResult({
          messages: {
            [Output.Alerts]: {
              payload: {
                status: "unhealthy",
                message: "source is offline",
                event_type: "device_unreachable",
                event_source: "watchdog",
                devices: [{ name: "source", reason: "timeout" }],
              },
            },
          },
        }),
      );

      expect(logs).not.toContain("Suppressing recovery alert during warm-up period.");
      expect(alerts).toEqual([
        {
          status: "unhealthy",
          message: "source is offline",
          event_type: "device_unreachable",
          event_source: "watchdog",
          devices: [{ name: "source", reason: "timeout" }],
        },
      ]);
    } finally {
      await coordinator.stop();
    }
  });

  it("defers runtime recovery when config changes during startup warm-up", async () => {
    const coordinator = createCoordinator();
    await coordinator.start();
    try {
      await coordinator.updateSystemConfig({
        devices: [{ name: "source" }, { name: "target" }, { name: "garage" }],
      });

      expect(coordinator.getSubscriptions()).toHaveProperty("LSH/garage/conf", { qos: 2 });
    } finally {
      await coordinator.stop();
    }
  });

  it("runs queued runtime recovery after startup verification completes", async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
    const coordinator = createCoordinator(
      { devices: [{ name: "source" }] },
      {
        initialStateTimeout: 0.001,
        pingTimeout: 0.001,
        watchdogInterval: 60,
        clickCleanupInterval: 60,
      },
    );
    const logs: string[] = [];
    coordinator.on("log", (message) => logs.push(message));

    await coordinator.start();
    try {
      await coordinator.updateSystemConfig({
        devices: [{ name: "source" }, { name: "target" }],
      });

      await jest.advanceTimersByTimeAsync(2000);
      await coordinator.flush();

      expect(logs).toContain("Running initial device state verification.");
      expect(logs).toContain("Running post-config device recovery.");
    } finally {
      const stopPromise = coordinator.stop();
      await jest.advanceTimersByTimeAsync(1000);
      await stopPromise;
      jest.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it("surfaces invalid inbound topics as controlled errors", async () => {
    const coordinator = createCoordinator();
    await coordinator.start();
    try {
      await expect(
        coordinator.processMqttMessage({ topic: 42, payload: "ready" } as unknown as MqttMessage),
      ).rejects.toThrow("Inbound msg.topic must be a string");
    } finally {
      await coordinator.stop();
    }
  });

  it("rejects invalid runtime configs without replacing the active one", async () => {
    const coordinator = createCoordinator();
    await coordinator.start();
    try {
      expect(() =>
        coordinator.updateSystemConfig({
          devices: [{ name: "bad/name" }],
        }),
      ).toThrow("Invalid coordinator config");
      expect(coordinator.getSystemConfig()).toEqual(systemConfig);
    } finally {
      await coordinator.stop();
    }
  });

  it("keeps lifecycle methods idempotent and ignores input while stopped", async () => {
    const coordinator = createCoordinator();
    await coordinator.start();
    await coordinator.start();

    expect(coordinator.getOptions()).toMatchObject({
      homieBasePath: "homie/5/",
      lshBasePath: "LSH/",
    });
    expect(coordinator.getDeviceRegistry()).toEqual({});

    await coordinator.stop();
    await expect(
      coordinator.processMqttMessage({
        topic: "homie/5/source/$state",
        payload: "ready",
      }),
    ).resolves.toBeUndefined();
    await coordinator.stop();
  });

  it("emits non-fatal service warnings through logger and events", async () => {
    const logger = { warn: jest.fn(), info: jest.fn() };
    const coordinator = createCoordinator({ devices: [{ name: "source" }] }, { logger });
    const warnings: string[] = [];
    coordinator.on("warning", (message) => warnings.push(message));

    await coordinator.start();
    try {
      await coordinator.processMqttMessage({
        topic: "LSH/source/conf",
        payload: {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR + 1,
          n: "source",
          a: [1],
          b: [],
        },
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Protocol major mismatch for source"),
      );
      expect(warnings).toEqual([expect.stringContaining("Protocol major mismatch for source")]);
    } finally {
      await coordinator.stop();
    }
  });
});
