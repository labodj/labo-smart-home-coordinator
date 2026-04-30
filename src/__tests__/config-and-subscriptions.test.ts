import { DEFAULT_COORDINATOR_OPTIONS, normalizeCoordinatorOptions } from "../config";
import {
  buildCoordinatorMqttSubscriptions,
  buildNodeRedSubscriptionMessages,
} from "../subscriptions";
import type { SystemConfig } from "../types";

const systemConfig: SystemConfig = {
  devices: [{ name: "ingresso" }, { name: "cucina" }],
};

describe("standalone coordinator configuration helpers", () => {
  it("normalizes defaults and trims user-provided MQTT paths", () => {
    expect(
      normalizeCoordinatorOptions({
        homieBasePath: " homie/5/ ",
        lshBasePath: " LSH/ ",
        serviceTopic: " LSH/service ",
        watchdogInterval: 10,
      }),
    ).toMatchObject({
      ...DEFAULT_COORDINATOR_OPTIONS,
      homieBasePath: "homie/5/",
      lshBasePath: "LSH/",
      serviceTopic: "LSH/service",
      watchdogInterval: 10,
    });
  });

  it("rejects wildcard or malformed MQTT path options", () => {
    expect(() => normalizeCoordinatorOptions({ homieBasePath: "   " })).toThrow(
      "Homie Base Path cannot be empty",
    );
    expect(() => normalizeCoordinatorOptions({ homieBasePath: "/" })).toThrow(
      "Homie Base Path must contain at least one non-empty topic segment",
    );
    expect(() => normalizeCoordinatorOptions({ lshBasePath: "LSH/#/" })).toThrow(
      "LSH Base Path must not contain MQTT wildcards",
    );
    expect(() => normalizeCoordinatorOptions({ homieBasePath: "homie/5" })).toThrow(
      "Homie Base Path must end with '/'",
    );
    expect(() => normalizeCoordinatorOptions({ lshBasePath: "LSH//" })).toThrow(
      "LSH Base Path must not contain empty MQTT topic segments",
    );
    expect(() => normalizeCoordinatorOptions({ serviceTopic: "/LSH/service" })).toThrow(
      "Service Topic must not contain empty MQTT topic segments",
    );
    expect(() => normalizeCoordinatorOptions({ serviceTopic: "LSH/service/" })).toThrow(
      "Service Topic must not end with '/'",
    );
    expect(() => normalizeCoordinatorOptions({ pingTimeout: 0 })).toThrow(
      "Ping Timeout must be a positive number",
    );
    expect(() => normalizeCoordinatorOptions({ watchdogInterval: -1 })).toThrow(
      "Watchdog Interval must be a positive number",
    );
  });

  it("builds the exact MQTT subscription set for every configured device", () => {
    const subscriptions = buildCoordinatorMqttSubscriptions(
      { homieBasePath: "homie/5/", lshBasePath: "LSH/" },
      systemConfig,
    );

    expect(subscriptions).toEqual({
      "LSH/ingresso/conf": { qos: 2 },
      "LSH/ingresso/state": { qos: 2 },
      "LSH/ingresso/events": { qos: 2 },
      "LSH/ingresso/bridge": { qos: 2 },
      "homie/5/ingresso/$state": { qos: 1 },
      "LSH/cucina/conf": { qos: 2 },
      "LSH/cucina/state": { qos: 2 },
      "LSH/cucina/events": { qos: 2 },
      "LSH/cucina/bridge": { qos: 2 },
      "homie/5/cucina/$state": { qos: 1 },
    });
  });

  it("groups subscription maps into Node-RED mqtt-in control messages for wrappers", () => {
    expect(
      buildNodeRedSubscriptionMessages({
        "homie/5/ingresso/$state": { qos: 1 },
        "LSH/ingresso/state": { qos: 2 },
        "LSH/ingresso/conf": { qos: 2 },
      }),
    ).toEqual([
      {
        action: "subscribe",
        qos: 1,
        topic: ["homie/5/ingresso/$state"],
      },
      {
        action: "subscribe",
        qos: 2,
        topic: ["LSH/ingresso/conf", "LSH/ingresso/state"],
      },
    ]);
  });
});
