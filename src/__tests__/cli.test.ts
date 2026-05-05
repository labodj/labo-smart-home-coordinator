import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCliInspectionReport,
  createLogger,
  loadMqttOptions,
  loadSystemConfig,
  parseCliArgs,
  reloadCoordinatorConfig,
} from "../cli";

describe("CLI helpers", () => {
  it("parses command line arguments over environment defaults", () => {
    expect(
      parseCliArgs(
        [
          "--broker",
          "mqtt://broker.local:1883",
          "--config",
          "./custom.json",
          "--mqtt-version",
          "5",
          "--username",
          "cli-user",
          "--password",
          "cli-pass",
          "--reject-unauthorized",
          "false",
          "--log-level",
          "debug",
        ],
        {
          LSH_COORDINATOR_MQTT_URL: "mqtt://env-broker:1883",
          LSH_COORDINATOR_USERNAME: "env-user",
        },
      ),
    ).toMatchObject({
      brokerUrl: "mqtt://broker.local:1883",
      configPath: "./custom.json",
      mqttProtocolVersion: 5,
      username: "cli-user",
      password: "cli-pass",
      rejectUnauthorized: false,
      logLevel: "debug",
    });
  });

  it("parses every coordinator and MQTT CLI flag", () => {
    expect(
      parseCliArgs(
        [
          "--homie-base-path",
          "homie/custom/",
          "--lsh-base-path",
          "LABO/",
          "--service-topic",
          "LABO/service",
          "--protocol",
          "msgpack",
          "--qos-conf",
          "1",
          "--qos-state",
          "1",
          "--qos-events",
          "2",
          "--qos-bridge",
          "1",
          "--qos-homie-state",
          "0",
          "--other-devices-prefix",
          "external",
          "--click-timeout",
          "3",
          "--click-cleanup",
          "31",
          "--watchdog-interval",
          "61",
          "--ping-threshold",
          "121",
          "--ping-timeout",
          "4",
          "--initial-state-timeout",
          "5",
          "--other-actors-topic",
          "home/lsh/other-actors",
          "--alerts-topic",
          "home/lsh/alerts",
          "--client-id",
          "coordinator-test",
          "--ca",
          "ca-one.pem",
          "--ca",
          "ca-two.pem",
          "--cert",
          "client.crt",
          "--key",
          "client.key",
          "--key-passphrase",
          "secret",
        ],
        {},
      ),
    ).toMatchObject({
      homieBasePath: "homie/custom/",
      lshBasePath: "LABO/",
      serviceTopic: "LABO/service",
      protocol: "msgpack",
      subscriptionQos: {
        conf: 1,
        state: 1,
        events: 2,
        bridge: 1,
        homieState: 0,
      },
      otherDevicesPrefix: "external",
      clickTimeout: 3,
      clickCleanupInterval: 31,
      watchdogInterval: 61,
      interrogateThreshold: 121,
      pingTimeout: 4,
      initialStateTimeout: 5,
      otherActorsTopic: "home/lsh/other-actors",
      alertsTopic: "home/lsh/alerts",
      clientId: "coordinator-test",
      caPaths: ["ca-one.pem", "ca-two.pem"],
      certPath: "client.crt",
      keyPath: "client.key",
      keyPassphrase: "secret",
    });
  });

  it("parses environment-only options", () => {
    expect(
      parseCliArgs([], {
        LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED: "off",
        LSH_COORDINATOR_MQTT_CA: ["ca-one.pem", "ca-two.pem"].join(
          process.platform === "win32" ? ";" : ":",
        ),
        LSH_COORDINATOR_LOG_LEVEL: "warn",
        LSH_COORDINATOR_CLICK_TIMEOUT: "7",
        LSH_COORDINATOR_QOS_BRIDGE: "1",
      }),
    ).toMatchObject({
      rejectUnauthorized: false,
      caPaths: ["ca-one.pem", "ca-two.pem"],
      logLevel: "warn",
      clickTimeout: 7,
      subscriptionQos: {
        bridge: 1,
      },
    });
  });

  it("parses every supported boolean spelling for TLS verification", () => {
    expect(
      parseCliArgs([], { LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED: "yes" }).rejectUnauthorized,
    ).toBe(true);
    expect(
      parseCliArgs([], { LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED: "no" }).rejectUnauthorized,
    ).toBe(false);
    expect(parseCliArgs(["--reject-unauthorized", "1"], {}).rejectUnauthorized).toBe(true);
    expect(parseCliArgs(["--reject-unauthorized", "0"], {}).rejectUnauthorized).toBe(false);
  });

  it("prints help and exits cleanly", () => {
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`);
    });

    try {
      expect(() => parseCliArgs(["--help"], {})).toThrow("process.exit:0");
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("labo-smart-home-coordinator"));
    } finally {
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects invalid CLI combinations", () => {
    expect(() => parseCliArgs(["--broker"], {})).toThrow("--broker requires a value");
    expect(() => parseCliArgs(["--unknown"], {})).toThrow("Unknown argument");
    expect(() => parseCliArgs([], { LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED: "maybe" })).toThrow(
      "Invalid boolean environment value",
    );
    expect(() => parseCliArgs([], { LSH_COORDINATOR_CLICK_TIMEOUT: "-1" })).toThrow(
      "click timeout must be a positive number",
    );
    expect(() => parseCliArgs([], { LSH_COORDINATOR_LOG_LEVEL: "trace" })).toThrow(
      "must be silent, error, warn, info or debug",
    );
    expect(() => parseCliArgs(["--protocol", "xml"], {})).toThrow("must be json or msgpack");
    expect(() => parseCliArgs(["--qos-events", "3"], {})).toThrow("must be 0, 1 or 2");
    expect(() => parseCliArgs(["--mqtt-version", "3"], {})).toThrow("must be 4 or 5");
    expect(() => parseCliArgs(["--cert", "client.crt"], {})).toThrow(
      "--cert and --key must be used together",
    );
    expect(() => parseCliArgs(["--key", "client.key"], {})).toThrow(
      "--cert and --key must be used together",
    );
    expect(() => parseCliArgs(["--key-passphrase", "secret"], {})).toThrow(
      "--key-passphrase requires --key",
    );
  });

  it("loads system config and MQTT TLS options from disk", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lsh-coordinator-cli-test-"));
    try {
      const configPath = join(tempRoot, "system-config.json");
      const caPath = join(tempRoot, "ca.pem");
      const certPath = join(tempRoot, "client.crt");
      const keyPath = join(tempRoot, "client.key");
      await writeFile(configPath, '{"devices":[{"name":"source"}]}');
      await writeFile(caPath, "CA");
      await writeFile(certPath, "CERT");
      await writeFile(keyPath, "KEY");

      await expect(loadSystemConfig(configPath)).resolves.toEqual({
        devices: [{ name: "source" }],
      });
      await expect(
        loadMqttOptions({
          ...parseCliArgs([], {}),
          caPaths: [caPath],
          certPath,
          keyPath,
          keyPassphrase: "secret",
        }),
      ).resolves.toMatchObject({
        ca: [Buffer.from("CA")],
        cert: Buffer.from("CERT"),
        key: Buffer.from("KEY"),
        passphrase: "secret",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reloads runtime config from disk for SIGHUP handling", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lsh-coordinator-reload-test-"));
    try {
      const configPath = join(tempRoot, "system-config.json");
      await writeFile(configPath, '{"devices":[{"name":"source"}]}');
      const coordinator = {
        reloadSystemConfig: jest.fn().mockResolvedValue(undefined),
      };
      const logger = {
        info: jest.fn(),
      };

      await reloadCoordinatorConfig(coordinator, { configPath }, logger);

      expect(coordinator.reloadSystemConfig).toHaveBeenCalledWith({
        devices: [{ name: "source" }],
      });
      expect(logger.info).toHaveBeenCalledWith(`Reloaded coordinator config from ${configPath}.`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid reload config before touching the runtime", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lsh-coordinator-reload-test-"));
    try {
      const configPath = join(tempRoot, "system-config.json");
      await writeFile(configPath, '{"devices":[{"name":"bad/name"}]}');
      const coordinator = {
        reloadSystemConfig: jest.fn().mockResolvedValue(undefined),
      };

      await expect(reloadCoordinatorConfig(coordinator, { configPath })).rejects.toThrow(
        "Invalid coordinator config",
      );
      expect(coordinator.reloadSystemConfig).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a dry-run inspection report for config and subscriptions", () => {
    const report = buildCliInspectionReport(
      parseCliArgs(
        ["--print-effective-config", "--explain-subscriptions", "--qos-bridge", "1"],
        {},
      ),
      { devices: [{ name: "source" }] },
    );

    expect(report).toMatchObject({
      valid: true,
      effectiveConfig: {
        coordinatorOptions: {
          lshBasePath: "LSH/",
          homieBasePath: "homie/5/",
          subscriptionQos: {
            bridge: 1,
          },
        },
        systemConfig: {
          devices: [{ name: "source" }],
        },
      },
      subscriptions: [
        {
          topic: "LSH/source/bridge",
          qos: 1,
          channel: "bridge",
        },
        {
          topic: "LSH/source/conf",
          qos: 2,
          channel: "conf",
        },
        {
          topic: "LSH/source/events",
          qos: 2,
          channel: "events",
        },
        {
          topic: "LSH/source/state",
          qos: 2,
          channel: "state",
        },
        {
          topic: "homie/5/source/$state",
          qos: 1,
          channel: "homieState",
        },
      ],
    });
    expect(report.effectiveConfig?.coordinatorOptions).not.toHaveProperty("brokerUrl");
  });

  it("creates a level-aware logger", () => {
    expect(createLogger("silent")).toEqual({});
    expect(createLogger("error").error).toBeDefined();
    expect(createLogger("error").warn).toBeUndefined();
  });
});
