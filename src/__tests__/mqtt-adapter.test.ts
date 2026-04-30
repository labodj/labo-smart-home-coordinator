import { LaboSmartHomeCoordinatorMqtt } from "../mqtt-adapter";
import type { CoordinatorMqttClient } from "../mqtt-adapter";
import type { SystemConfig } from "../types";

const systemConfig: SystemConfig = {
  devices: [{ name: "source" }],
};

type MessageListener = (topic: string, payload: Buffer, packet: { retain?: boolean }) => void;

const createMockClient = () => {
  const listeners = new Map<"message", MessageListener>();
  const client: CoordinatorMqttClient = {
    on: jest.fn((event: "message", listener) => {
      listeners.set(event, listener);
      return client;
    }),
    subscribeAsync: jest.fn().mockResolvedValue(undefined),
    publishAsync: jest.fn().mockResolvedValue(undefined),
    endAsync: jest.fn().mockResolvedValue(undefined),
  };
  return { client, listeners };
};

describe("LaboSmartHomeCoordinatorMqtt", () => {
  it("connects, subscribes and publishes coordinator MQTT events", async () => {
    const { client } = createMockClient();
    const factory = jest.fn().mockResolvedValue(client);
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: factory,
      mqttOptions: { protocolVersion: 5, username: "user", password: "pass" },
    });

    await runtime.start();

    expect(factory).toHaveBeenCalledWith("mqtt://broker.local:1883", {
      protocolVersion: 5,
      username: "user",
      password: "pass",
    });
    expect(client.subscribeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        "LSH/source/conf": { qos: 2 },
        "homie/5/source/$state": { qos: 1 },
      }),
    );

    runtime.getCoordinator().emit("mqtt", {
      topic: "LSH/source/IN",
      payload: { p: 10 },
      qos: 1,
      retain: true,
    });
    await runtime.flush();

    expect(client.publishAsync).toHaveBeenCalledWith("LSH/source/IN", '{"p":10}', {
      qos: 1,
      retain: true,
    });

    await runtime.stop();
    expect(client.endAsync).toHaveBeenCalledTimes(1);
  });

  it("routes optional other-actor and alert events to configured MQTT topics", async () => {
    const { client } = createMockClient();
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
      otherActorsTopic: "home/lsh/other-actors",
      alertsTopic: "home/lsh/alerts",
    });

    await runtime.start();

    runtime.getCoordinator().emit("otherActors", {
      otherActors: ["bedside_lamp"],
      stateToSet: true,
    });
    runtime.getCoordinator().emit("alert", {
      message: "source is offline",
      status: "unhealthy",
      event_type: "device_unreachable",
      event_source: "watchdog",
      devices: [{ name: "source", reason: "timeout" }],
    });
    await runtime.flush();

    expect(client.publishAsync).toHaveBeenCalledWith(
      "home/lsh/other-actors",
      '{"otherActors":["bedside_lamp"],"stateToSet":true}',
      { qos: 1, retain: false },
    );
    expect(client.publishAsync).toHaveBeenCalledWith(
      "home/lsh/alerts",
      '{"message":"source is offline","status":"unhealthy","event_type":"device_unreachable","event_source":"watchdog","devices":[{"name":"source","reason":"timeout"}]}',
      { qos: 1, retain: false },
    );

    await runtime.stop();
  });

  it("logs optional outputs when no external MQTT topics are configured", async () => {
    const { client } = createMockClient();
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
      logger,
    });

    await runtime.start();
    runtime.getCoordinator().emit("otherActors", {
      otherActors: ["bedside_lamp"],
      stateToSet: true,
    });
    runtime.getCoordinator().emit("alert", {
      message: "source is offline",
      status: "unhealthy",
      event_type: "device_unreachable",
      event_source: "watchdog",
      devices: [{ name: "source", reason: "timeout" }],
    });
    await runtime.flush();

    expect(logger.debug).toHaveBeenCalledWith(
      "Other actor command emitted without a configured topic.",
    );
    expect(logger.warn).toHaveBeenCalledWith("source is offline");
    await runtime.stop();
  });

  it("serializes inbound broker messages through the coordinator", async () => {
    const { client, listeners } = createMockClient();
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
    });
    const debugMessages: string[] = [];
    runtime.getCoordinator().on("debug", (message) => {
      if (typeof message.topic === "string") {
        debugMessages.push(message.topic);
      }
    });

    await runtime.start();
    const listener = listeners.get("message");
    expect(listener).toBeDefined();
    listener?.("homie/5/source/$state", Buffer.from("ready"), { retain: false });
    await runtime.flush();

    expect(debugMessages).toContain("homie/5/source/$state");
    await runtime.stop();
  });

  it("logs inbound processing failures without breaking the MQTT queue", async () => {
    const { client, listeners } = createMockClient();
    const logger = { error: jest.fn() };
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
      logger,
    });
    const debugMessages: string[] = [];
    runtime.getCoordinator().on("debug", (message) => {
      if (typeof message.topic === "string") {
        debugMessages.push(message.topic);
      }
    });

    await runtime.start();
    jest
      .spyOn(runtime.getCoordinator(), "processMqttMessage")
      .mockRejectedValueOnce(new Error("synthetic processing failure"));
    listeners.get("message")?.("LSH/source/conf", Buffer.from([1, 2, 3]), {
      retain: false,
    });
    await runtime.flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to process MQTT message 'LSH/source/conf'"),
    );

    listeners.get("message")?.("homie/5/source/$state", Buffer.from("ready"), {
      retain: false,
    });
    await runtime.flush();

    expect(debugMessages).toContain("homie/5/source/$state");
    await runtime.stop();
  });

  it("publishes Buffer and string payloads without JSON stringifying them", async () => {
    const { client } = createMockClient();
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
    });

    await runtime.start();
    runtime.getCoordinator().emit("mqtt", {
      topic: "LSH/source/IN",
      payload: Buffer.from([1, 2, 3]),
    });
    runtime.getCoordinator().emit("mqtt", {
      topic: "LSH/source/text",
      payload: "ready",
    });
    await runtime.flush();

    expect(client.publishAsync).toHaveBeenCalledWith("LSH/source/IN", Buffer.from([1, 2, 3]), {
      qos: 0,
      retain: false,
    });
    expect(client.publishAsync).toHaveBeenCalledWith("LSH/source/text", "ready", {
      qos: 0,
      retain: false,
    });
    await runtime.stop();
  });

  it("keeps adapter lifecycle idempotent", async () => {
    const { client } = createMockClient();
    const factory = jest.fn().mockResolvedValue(client);
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: factory,
    });

    await runtime.stop();
    await runtime.start();
    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.endAsync).toHaveBeenCalledTimes(1);
  });

  it("ignores outbound MQTT events that cannot be published", async () => {
    const { client } = createMockClient();
    const runtime = new LaboSmartHomeCoordinatorMqtt({
      brokerUrl: "mqtt://broker.local:1883",
      systemConfig,
      clientFactory: jest.fn().mockResolvedValue(client),
    });

    runtime.getCoordinator().emit("mqtt", { payload: { p: 10 } });
    await runtime.flush();
    expect(client.publishAsync).not.toHaveBeenCalled();

    await runtime.start();
    runtime.getCoordinator().emit("mqtt", { payload: { p: 10 } });
    await runtime.flush();
    expect(client.publishAsync).not.toHaveBeenCalled();

    await runtime.stop();
  });
});
