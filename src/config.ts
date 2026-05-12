/**
 * @file Default coordinator options and configuration normalization.
 *
 * All user-provided runtime options pass through this module before the
 * coordinator starts. Centralizing the checks keeps adapters small and prevents
 * invalid topic bases from leaking into subscription generation or topic
 * parsing.
 */
import type { CoordinatorOptions, CoordinatorSubscriptionQosPolicy, MqttQoS } from "./types";

export type CoordinatorOptionsInput = Omit<Partial<CoordinatorOptions>, "subscriptionQos"> & {
  subscriptionQos?: Partial<CoordinatorSubscriptionQosPolicy>;
};

/**
 * Numeric option keys that share positive-number validation.
 */
type NumericConfigKey =
  | "clickTimeout"
  | "clickCleanupInterval"
  | "watchdogInterval"
  | "interrogateThreshold"
  | "pingTimeout"
  | "initialStateTimeout";

type SubscriptionQosKey = keyof CoordinatorSubscriptionQosPolicy;

const MQTT_WILDCARD_PATTERN = /[+#]/;

/**
 * Defaults matching the public LSH MQTT subscription profile.
 */
export const DEFAULT_COORDINATOR_SUBSCRIPTION_QOS: CoordinatorSubscriptionQosPolicy = {
  conf: 2,
  state: 2,
  events: 2,
  bridge: 2,
  homieState: 1,
};

/**
 * Conservative defaults matching the public LSH MQTT profile.
 */
export const DEFAULT_COORDINATOR_OPTIONS: CoordinatorOptions = {
  homieBasePath: "homie/5/",
  lshBasePath: "LSH/",
  serviceTopic: "LSH/Node-RED/SRV",
  protocol: "json",
  subscriptionQos: { ...DEFAULT_COORDINATOR_SUBSCRIPTION_QOS },
  otherDevicesPrefix: "other_devices",
  clickTimeout: 2,
  clickCleanupInterval: 30,
  watchdogInterval: 60,
  interrogateThreshold: 120,
  pingTimeout: 3,
  initialStateTimeout: 2,
};

/**
 * Trims and validates a required string option.
 */
const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

/**
 * Validates a concrete MQTT topic or base path.
 *
 * The coordinator generates exact subscriptions internally. Accepting wildcards
 * in these base settings would make generated subscriptions and reverse parsing
 * ambiguous, so wildcards are rejected at the configuration boundary.
 */
const validateConcreteTopic = (
  value: string,
  fieldName: string,
  { requireTrailingSlash }: { requireTrailingSlash: boolean },
): string => {
  const normalized = normalizeRequiredString(value, fieldName);

  if (MQTT_WILDCARD_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must not contain MQTT wildcards ('+' or '#').`);
  }

  if (requireTrailingSlash && !normalized.endsWith("/")) {
    throw new Error(`${fieldName} must end with '/'.`);
  }

  if (!requireTrailingSlash && normalized.endsWith("/")) {
    throw new Error(`${fieldName} must not end with '/'.`);
  }

  const topicBody = requireTrailingSlash ? normalized.slice(0, -1) : normalized;
  if (topicBody.length === 0) {
    throw new Error(`${fieldName} must contain at least one non-empty topic segment.`);
  }

  // Empty segments make generated topics ambiguous (`LSH//state`) and are hard
  // to spot in broker logs, so reject them at configuration time.
  const segments = topicBody.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`${fieldName} must not contain empty MQTT topic segments.`);
  }

  return normalized;
};

/**
 * Validates an MQTT base path that must be safe for string concatenation.
 */
const validateTopicBase = (value: string, fieldName: string): string => {
  return validateConcreteTopic(value, fieldName, { requireTrailingSlash: true });
};

/**
 * Normalizes a numeric option and rejects non-positive values.
 */
const normalizePositiveNumber = (value: number, fieldName: string): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
};

/**
 * Normalizes one MQTT QoS value.
 */
const normalizeMqttQos = (value: unknown, fieldName: string): MqttQoS => {
  if (value === 0 || value === 1 || value === 2) {
    return value;
  }

  throw new Error(`${fieldName} must be 0, 1 or 2.`);
};

/**
 * Normalizes the payload protocol selected for LSH MQTT topics.
 */
const normalizeProtocol = (value: unknown): CoordinatorOptions["protocol"] => {
  if (value === "json" || value === "msgpack") {
    return value;
  }

  throw new Error("Protocol must be json or msgpack.");
};

/**
 * Normalizes the coordinator subscription QoS policy.
 */
export const normalizeCoordinatorSubscriptionQos = (
  policy: Partial<CoordinatorSubscriptionQosPolicy> = {},
): CoordinatorSubscriptionQosPolicy => {
  const labels: Record<SubscriptionQosKey, string> = {
    conf: "Configuration Subscription QoS",
    state: "State Subscription QoS",
    events: "Events Subscription QoS",
    bridge: "Bridge Subscription QoS",
    homieState: "Homie State Subscription QoS",
  };

  for (const key of Object.keys(policy)) {
    if (!(key in labels)) {
      throw new Error(`Unknown subscription QoS policy key '${key}'.`);
    }
  }

  return {
    conf: normalizeMqttQos(policy.conf ?? DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.conf, labels.conf),
    state: normalizeMqttQos(
      policy.state ?? DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.state,
      labels.state,
    ),
    events: normalizeMqttQos(
      policy.events ?? DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.events,
      labels.events,
    ),
    bridge: normalizeMqttQos(
      policy.bridge ?? DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.bridge,
      labels.bridge,
    ),
    homieState: normalizeMqttQos(
      policy.homieState ?? DEFAULT_COORDINATOR_SUBSCRIPTION_QOS.homieState,
      labels.homieState,
    ),
  };
};

/**
 * Normalizes and validates static coordinator options.
 *
 * The coordinator deliberately rejects wildcard topic configuration at this
 * boundary. It owns the generated subscription set, so accepting wildcards here
 * would make recovery and topic parsing ambiguous.
 */
export const normalizeCoordinatorOptions = (
  options: CoordinatorOptionsInput = {},
): CoordinatorOptions => {
  const { subscriptionQos } = options;
  const merged: CoordinatorOptions = {
    homieBasePath: options.homieBasePath ?? DEFAULT_COORDINATOR_OPTIONS.homieBasePath,
    lshBasePath: options.lshBasePath ?? DEFAULT_COORDINATOR_OPTIONS.lshBasePath,
    serviceTopic: options.serviceTopic ?? DEFAULT_COORDINATOR_OPTIONS.serviceTopic,
    protocol: options.protocol ?? DEFAULT_COORDINATOR_OPTIONS.protocol,
    subscriptionQos: normalizeCoordinatorSubscriptionQos(subscriptionQos),
    otherDevicesPrefix:
      options.otherDevicesPrefix ?? DEFAULT_COORDINATOR_OPTIONS.otherDevicesPrefix,
    clickTimeout: options.clickTimeout ?? DEFAULT_COORDINATOR_OPTIONS.clickTimeout,
    clickCleanupInterval:
      options.clickCleanupInterval ?? DEFAULT_COORDINATOR_OPTIONS.clickCleanupInterval,
    watchdogInterval: options.watchdogInterval ?? DEFAULT_COORDINATOR_OPTIONS.watchdogInterval,
    interrogateThreshold:
      options.interrogateThreshold ?? DEFAULT_COORDINATOR_OPTIONS.interrogateThreshold,
    pingTimeout: options.pingTimeout ?? DEFAULT_COORDINATOR_OPTIONS.pingTimeout,
    initialStateTimeout:
      options.initialStateTimeout ?? DEFAULT_COORDINATOR_OPTIONS.initialStateTimeout,
  };

  const normalizedConfig: CoordinatorOptions = {
    ...merged,
    homieBasePath: validateTopicBase(merged.homieBasePath, "Homie Base Path"),
    lshBasePath: validateTopicBase(merged.lshBasePath, "LSH Base Path"),
    serviceTopic: validateConcreteTopic(merged.serviceTopic, "Service Topic", {
      requireTrailingSlash: false,
    }),
    protocol: normalizeProtocol(merged.protocol),
    otherDevicesPrefix: normalizeRequiredString(merged.otherDevicesPrefix, "External State Prefix"),
  };

  const numericFields: Record<NumericConfigKey, string> = {
    clickTimeout: "Click Confirm Timeout",
    clickCleanupInterval: "Click Cleanup",
    watchdogInterval: "Watchdog Interval",
    interrogateThreshold: "Ping Threshold",
    pingTimeout: "Ping Timeout",
    initialStateTimeout: "Initial Replay Window",
  };

  for (const [key, label] of Object.entries(numericFields) as Array<[NumericConfigKey, string]>) {
    normalizedConfig[key] = normalizePositiveNumber(normalizedConfig[key], label);
  }

  return normalizedConfig;
};
