#!/usr/bin/env node
/**
 * @file Command-line entry point for standalone MQTT operation.
 *
 * The CLI is intentionally thin: it parses environment variables and flags,
 * loads JSON config and TLS material, then starts the MQTT adapter. Keeping the
 * orchestration logic in the library makes the same behavior available to
 * Node-RED and embedders.
 */
import { readFile } from "node:fs/promises";
import { delimiter } from "node:path";

import type { IClientOptions } from "mqtt";

import { DEFAULT_COORDINATOR_SUBSCRIPTION_QOS, normalizeCoordinatorOptions } from "./config";
import { LaboSmartHomeCoordinatorMqtt } from "./mqtt-adapter";
import { createAppValidators } from "./schemas";
import { explainCoordinatorMqttSubscriptions } from "./subscriptions";
import type { CoordinatorLogger } from "./LaboSmartHomeCoordinator";
import type { CoordinatorOptions, MqttQoS, SystemConfig } from "./types";

/**
 * Runtime logging level accepted by the CLI.
 */
type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/**
 * MQTT protocol versions exposed by MQTT.js through `protocolVersion`.
 */
type MqttProtocolVersion = 4 | 5;

/**
 * Fully resolved CLI options after env/default/flag parsing.
 */
export interface CliOptions extends CoordinatorOptions {
  brokerUrl: string;
  configPath: string;
  mqttProtocolVersion: MqttProtocolVersion;
  clientId?: string;
  username?: string;
  password?: string;
  caPaths: string[];
  certPath?: string;
  keyPath?: string;
  keyPassphrase?: string;
  rejectUnauthorized: boolean;
  otherActorsTopic?: string;
  alertsTopic?: string;
  logLevel: LogLevel;
  validateConfig: boolean;
  printEffectiveConfig: boolean;
  explainSubscriptions: boolean;
}

export interface CliInspectionReport {
  valid: true;
  effectiveConfig?: {
    coordinatorOptions: CoordinatorOptions;
    systemConfig: SystemConfig;
  };
  subscriptions?: ReturnType<typeof explainCoordinatorMqttSubscriptions>;
}

export interface ReloadableCoordinator {
  reloadSystemConfig(systemConfig: SystemConfig): Promise<void>;
}

/**
 * Human-readable CLI help shown by `--help`.
 */
const HELP = `labo-smart-home-coordinator

Usage:
  labo-smart-home-coordinator --broker mqtt://localhost:1883 --config ./system-config.json [options]

Options:
  --broker <url>              MQTT broker URL. Default: mqtt://localhost:1883
  --config <file>             Coordinator system config JSON file.
  --homie-base-path <topic>   Homie lifecycle base path. Default: homie/5/
  --lsh-base-path <topic>     LSH topic base path. Default: LSH/
  --service-topic <topic>     Bridge service topic. Default: LSH/Node-RED/SRV
  --protocol <type>           Payload protocol: json or msgpack. Default: json
  --qos-conf <0|1|2>          Subscription QoS for LSH conf topics. Default: 2
  --qos-state <0|1|2>         Subscription QoS for LSH state topics. Default: 2
  --qos-events <0|1|2>        Subscription QoS for LSH events topics. Default: 2
  --qos-bridge <0|1|2>        Subscription QoS for LSH bridge topics. Default: 2
  --qos-homie-state <0|1|2>   Subscription QoS for Homie $state topics. Default: 1
  --other-devices-prefix <p>  Prefix for external actor state lookups. Default: other_devices
  --click-timeout <seconds>   Network click confirm timeout. Default: 2
  --click-cleanup <seconds>   Pending click cleanup interval. Default: 30
  --watchdog-interval <sec>   Watchdog cycle interval. Default: 60
  --ping-threshold <seconds>  Silence threshold before ping. Default: 120
  --ping-timeout <seconds>    Ping response timeout. Default: 3
  --initial-state-timeout <s> Optional startup replay window. Default: 2
  --other-actors-topic <t>    MQTT topic for external actor command intents.
  --alerts-topic <topic>      MQTT topic for coordinator alerts.
  --mqtt-version <version>    MQTT protocol version: 4 or 5. Default: 4
  --client-id <id>            MQTT client id.
  --username <user>           MQTT username.
  --password <password>       MQTT password.
  --ca <file>                 TLS CA certificate file. Can be repeated.
  --cert <file>               TLS client certificate file for mutual TLS.
  --key <file>                TLS client private key file for mutual TLS.
  --key-passphrase <value>    TLS client private key passphrase.
  --reject-unauthorized <bool> Verify broker TLS certificate. Default: true
  --log-level <level>         silent, error, warn, info, debug. Default: info
  --validate-config           Validate config and exit without connecting to MQTT.
  --print-effective-config    Print normalized coordinator config and exit.
  --explain-subscriptions     Print generated subscriptions and exit.
  --help                      Show this help.
`;

/**
 * Reads the value after a CLI flag and reports a precise error when missing.
 */
const takeValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

/**
 * Parses boolean environment variables and flag values.
 */
const parseBooleanEnv = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`Invalid boolean environment value '${value}'.`);
};

/**
 * Parses positive numeric options expressed in seconds.
 */
const parsePositiveNumber = (
  value: string | undefined,
  source: string,
  defaultValue: number,
): number => {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${source} must be a positive number.`);
};

/**
 * Parses the payload codec protocol.
 */
const parseProtocol = (value: string | undefined, source: string): "json" | "msgpack" => {
  if (value === undefined) {
    return "json";
  }
  if (value === "json" || value === "msgpack") {
    return value;
  }
  throw new Error(`${source} must be json or msgpack.`);
};

/**
 * Parses an MQTT QoS option.
 */
const parseMqttQos = (
  value: string | undefined,
  source: string,
  defaultValue: MqttQoS,
): MqttQoS => {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2) {
    return parsed;
  }

  throw new Error(`${source} must be 0, 1 or 2.`);
};

/**
 * Parses the MQTT wire protocol version requested by the user.
 */
const parseMqttProtocolVersion = (
  value: string | undefined,
  source: string,
): MqttProtocolVersion => {
  if (value === undefined) {
    return 4;
  }

  const parsed = Number(value);
  if (parsed === 4 || parsed === 5) {
    return parsed;
  }

  throw new Error(`${source} must be 4 or 5.`);
};

/**
 * Parses the desired CLI log verbosity.
 */
const parseLogLevel = (value: string | undefined, source: string): LogLevel => {
  if (value === undefined) {
    return "info";
  }

  if (
    value === "silent" ||
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug"
  ) {
    return value;
  }

  throw new Error(`${source} must be silent, error, warn, info or debug.`);
};

/**
 * Parses path lists using the host platform delimiter.
 */
const parsePathListEnv = (value: string | undefined): string[] =>
  value === undefined ? [] : value.split(delimiter).filter((entry) => entry.length > 0);

/**
 * Builds a logger that exposes only the methods enabled by the selected level.
 */
export const createLogger = (level: LogLevel): CoordinatorLogger => {
  const rank: Record<Exclude<LogLevel, "silent">, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  if (level === "silent") {
    return {};
  }

  const maxRank = rank[level];
  return {
    error: maxRank >= rank.error ? console.error.bind(console) : undefined,
    warn: maxRank >= rank.warn ? console.warn.bind(console) : undefined,
    info: maxRank >= rank.info ? console.info.bind(console) : undefined,
    debug: maxRank >= rank.debug ? console.debug.bind(console) : undefined,
  };
};

/**
 * Parses CLI flags, environment variables and defaults into runtime options.
 *
 * Flags intentionally win over environment variables, so service managers can
 * define broad defaults while one invocation still overrides a single value.
 */
export const parseCliArgs = (args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions => {
  const options: CliOptions = {
    brokerUrl: env.LSH_COORDINATOR_MQTT_URL ?? "mqtt://localhost:1883",
    configPath: env.LSH_COORDINATOR_CONFIG ?? "system-config.json",
    homieBasePath: env.LSH_COORDINATOR_HOMIE_BASE_PATH ?? "homie/5/",
    lshBasePath: env.LSH_COORDINATOR_LSH_BASE_PATH ?? "LSH/",
    serviceTopic: env.LSH_COORDINATOR_SERVICE_TOPIC ?? "LSH/Node-RED/SRV",
    protocol: parseProtocol(env.LSH_COORDINATOR_PROTOCOL, "LSH_COORDINATOR_PROTOCOL"),
    subscriptionQos: {
      conf: parseMqttQos(
        env.LSH_COORDINATOR_QOS_CONF,
        "LSH_COORDINATOR_QOS_CONF",
        DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.conf,
      ),
      state: parseMqttQos(
        env.LSH_COORDINATOR_QOS_STATE,
        "LSH_COORDINATOR_QOS_STATE",
        DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.state,
      ),
      events: parseMqttQos(
        env.LSH_COORDINATOR_QOS_EVENTS,
        "LSH_COORDINATOR_QOS_EVENTS",
        DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.events,
      ),
      bridge: parseMqttQos(
        env.LSH_COORDINATOR_QOS_BRIDGE,
        "LSH_COORDINATOR_QOS_BRIDGE",
        DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.bridge,
      ),
      homieState: parseMqttQos(
        env.LSH_COORDINATOR_QOS_HOMIE_STATE,
        "LSH_COORDINATOR_QOS_HOMIE_STATE",
        DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.homieState,
      ),
    },
    otherDevicesPrefix: env.LSH_COORDINATOR_OTHER_DEVICES_PREFIX ?? "other_devices",
    clickTimeout: parsePositiveNumber(env.LSH_COORDINATOR_CLICK_TIMEOUT, "click timeout", 2),
    clickCleanupInterval: parsePositiveNumber(
      env.LSH_COORDINATOR_CLICK_CLEANUP_INTERVAL,
      "click cleanup interval",
      30,
    ),
    watchdogInterval: parsePositiveNumber(
      env.LSH_COORDINATOR_WATCHDOG_INTERVAL,
      "watchdog interval",
      60,
    ),
    interrogateThreshold: parsePositiveNumber(
      env.LSH_COORDINATOR_INTERROGATE_THRESHOLD,
      "ping threshold",
      120,
    ),
    pingTimeout: parsePositiveNumber(env.LSH_COORDINATOR_PING_TIMEOUT, "ping timeout", 3),
    initialStateTimeout: parsePositiveNumber(
      env.LSH_COORDINATOR_INITIAL_STATE_TIMEOUT,
      "initial state timeout",
      2,
    ),
    otherActorsTopic: env.LSH_COORDINATOR_OTHER_ACTORS_TOPIC,
    alertsTopic: env.LSH_COORDINATOR_ALERTS_TOPIC,
    mqttProtocolVersion: parseMqttProtocolVersion(
      env.LSH_COORDINATOR_MQTT_VERSION,
      "LSH_COORDINATOR_MQTT_VERSION",
    ),
    clientId: env.LSH_COORDINATOR_CLIENT_ID,
    username: env.LSH_COORDINATOR_USERNAME,
    password: env.LSH_COORDINATOR_PASSWORD,
    caPaths: parsePathListEnv(env.LSH_COORDINATOR_MQTT_CA),
    certPath: env.LSH_COORDINATOR_MQTT_CERT,
    keyPath: env.LSH_COORDINATOR_MQTT_KEY,
    keyPassphrase: env.LSH_COORDINATOR_MQTT_KEY_PASSPHRASE,
    rejectUnauthorized: parseBooleanEnv(env.LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED, true),
    logLevel: parseLogLevel(env.LSH_COORDINATOR_LOG_LEVEL, "LSH_COORDINATOR_LOG_LEVEL"),
    validateConfig: false,
    printEffectiveConfig: false,
    explainSubscriptions: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--broker":
        options.brokerUrl = takeValue(args, index, arg);
        index += 1;
        break;
      case "--config":
        options.configPath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--homie-base-path":
        options.homieBasePath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--lsh-base-path":
        options.lshBasePath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--service-topic":
        options.serviceTopic = takeValue(args, index, arg);
        index += 1;
        break;
      case "--protocol":
        options.protocol = parseProtocol(takeValue(args, index, arg), arg);
        index += 1;
        break;
      case "--qos-conf":
        options.subscriptionQos.conf = parseMqttQos(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--qos-state":
        options.subscriptionQos.state = parseMqttQos(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--qos-events":
        options.subscriptionQos.events = parseMqttQos(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--qos-bridge":
        options.subscriptionQos.bridge = parseMqttQos(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--qos-homie-state":
        options.subscriptionQos.homieState = parseMqttQos(takeValue(args, index, arg), arg, 1);
        index += 1;
        break;
      case "--other-devices-prefix":
        options.otherDevicesPrefix = takeValue(args, index, arg);
        index += 1;
        break;
      case "--click-timeout":
        options.clickTimeout = parsePositiveNumber(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--click-cleanup":
        options.clickCleanupInterval = parsePositiveNumber(takeValue(args, index, arg), arg, 30);
        index += 1;
        break;
      case "--watchdog-interval":
        options.watchdogInterval = parsePositiveNumber(takeValue(args, index, arg), arg, 60);
        index += 1;
        break;
      case "--ping-threshold":
        options.interrogateThreshold = parsePositiveNumber(takeValue(args, index, arg), arg, 120);
        index += 1;
        break;
      case "--ping-timeout":
        options.pingTimeout = parsePositiveNumber(takeValue(args, index, arg), arg, 3);
        index += 1;
        break;
      case "--initial-state-timeout":
        options.initialStateTimeout = parsePositiveNumber(takeValue(args, index, arg), arg, 2);
        index += 1;
        break;
      case "--other-actors-topic":
        options.otherActorsTopic = takeValue(args, index, arg);
        index += 1;
        break;
      case "--alerts-topic":
        options.alertsTopic = takeValue(args, index, arg);
        index += 1;
        break;
      case "--mqtt-version":
        options.mqttProtocolVersion = parseMqttProtocolVersion(takeValue(args, index, arg), arg);
        index += 1;
        break;
      case "--client-id":
        options.clientId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--username":
        options.username = takeValue(args, index, arg);
        index += 1;
        break;
      case "--password":
        options.password = takeValue(args, index, arg);
        index += 1;
        break;
      case "--ca":
        options.caPaths.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--cert":
        options.certPath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--key":
        options.keyPath = takeValue(args, index, arg);
        index += 1;
        break;
      case "--key-passphrase":
        options.keyPassphrase = takeValue(args, index, arg);
        index += 1;
        break;
      case "--reject-unauthorized":
        options.rejectUnauthorized = parseBooleanEnv(takeValue(args, index, arg), true);
        index += 1;
        break;
      case "--log-level":
        options.logLevel = parseLogLevel(takeValue(args, index, arg), arg);
        index += 1;
        break;
      case "--validate-config":
        options.validateConfig = true;
        break;
      case "--print-effective-config":
        options.printEffectiveConfig = true;
        break;
      case "--explain-subscriptions":
        options.explainSubscriptions = true;
        break;
      default:
        throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if ((options.certPath && !options.keyPath) || (!options.certPath && options.keyPath)) {
    throw new Error("--cert and --key must be used together for mutual TLS.");
  }

  if (options.keyPassphrase && !options.keyPath) {
    throw new Error("--key-passphrase requires --key.");
  }

  return options;
};

/**
 * Loads and parses the coordinator system configuration JSON file.
 */
export const loadSystemConfig = async (configPath: string): Promise<SystemConfig> => {
  return JSON.parse(await readFile(configPath, "utf8")) as SystemConfig;
};

/**
 * Validates a parsed system configuration and throws a concise CLI error.
 */
export const validateSystemConfigOrThrow = (systemConfig: SystemConfig): void => {
  const validators = createAppValidators();
  if (validators.validateSystemConfig(systemConfig)) {
    return;
  }

  const errorText =
    validators.validateSystemConfig.errors?.map((error) => error.message).join(", ") ??
    "unknown validation error";
  throw new Error(`Invalid coordinator config: ${errorText}`);
};

/**
 * Builds the JSON inspection report emitted by dry-run CLI modes.
 */
export const buildCliInspectionReport = (
  options: CliOptions,
  systemConfig: SystemConfig,
): CliInspectionReport => {
  validateSystemConfigOrThrow(systemConfig);
  const coordinatorOptions = normalizeCoordinatorOptions(options);
  const report: CliInspectionReport = { valid: true };

  if (options.printEffectiveConfig) {
    report.effectiveConfig = {
      coordinatorOptions,
      systemConfig,
    };
  }

  if (options.explainSubscriptions) {
    report.subscriptions = explainCoordinatorMqttSubscriptions(coordinatorOptions, systemConfig);
  }

  return report;
};

const isInspectionMode = (options: CliOptions): boolean =>
  options.validateConfig || options.printEffectiveConfig || options.explainSubscriptions;

/**
 * Reloads the standalone runtime config from disk without reconnecting MQTT.
 */
export const reloadCoordinatorConfig = async (
  coordinator: ReloadableCoordinator,
  options: Pick<CliOptions, "configPath">,
  logger: CoordinatorLogger = {},
): Promise<void> => {
  const systemConfig = await loadSystemConfig(options.configPath);
  validateSystemConfigOrThrow(systemConfig);
  await coordinator.reloadSystemConfig(systemConfig);
  logger.info?.(`Reloaded coordinator config from ${options.configPath}.`);
};

/**
 * Loads MQTT.js options, including optional TLS and mutual-TLS material.
 */
export const loadMqttOptions = async (options: CliOptions): Promise<IClientOptions> => {
  const mqttOptions: IClientOptions & { passphrase?: string } = {
    clientId: options.clientId,
    username: options.username,
    password: options.password,
    protocolVersion: options.mqttProtocolVersion,
    rejectUnauthorized: options.rejectUnauthorized,
  };

  if (options.caPaths.length > 0) {
    mqttOptions.ca = await Promise.all(options.caPaths.map((path) => readFile(path)));
  }

  if (options.certPath) {
    mqttOptions.cert = await readFile(options.certPath);
  }

  if (options.keyPath) {
    mqttOptions.key = await readFile(options.keyPath);
  }

  if (options.keyPassphrase) {
    mqttOptions.passphrase = options.keyPassphrase;
  }

  return mqttOptions;
};

/* istanbul ignore next -- Process signal wiring is covered by package smoke tests. */
export const main = async (): Promise<void> => {
  const options = parseCliArgs(process.argv.slice(2));
  const systemConfig = await loadSystemConfig(options.configPath);
  const logger = createLogger(options.logLevel);

  if (isInspectionMode(options)) {
    process.stdout.write(
      `${JSON.stringify(buildCliInspectionReport(options, systemConfig), null, 2)}\n`,
    );
    return;
  }

  const coordinator = new LaboSmartHomeCoordinatorMqtt({
    ...options,
    systemConfig,
    mqttOptions: await loadMqttOptions(options),
    logger,
  });

  await coordinator.start();

  const stop = async () => {
    await coordinator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGHUP", () => {
    void reloadCoordinatorConfig(coordinator, options, logger).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`Failed to reload coordinator config: ${message}`);
    });
  });
};

/* istanbul ignore next -- Direct CLI execution is verified from the built package. */
if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
