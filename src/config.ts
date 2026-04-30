/**
 * @file Default coordinator options and configuration normalization.
 *
 * All user-provided runtime options pass through this module before the
 * coordinator starts. Centralizing the checks keeps adapters small and prevents
 * invalid topic bases from leaking into subscription generation or topic
 * parsing.
 */
import type { CoordinatorOptions } from "./types";

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

const MQTT_WILDCARD_PATTERN = /[+#]/;

/**
 * Conservative defaults matching the public LSH MQTT profile.
 */
export const DEFAULT_COORDINATOR_OPTIONS: CoordinatorOptions = {
  homieBasePath: "homie/5/",
  lshBasePath: "LSH/",
  serviceTopic: "LSH/Node-RED/SRV",
  protocol: "json",
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
 * Normalizes and validates static coordinator options.
 *
 * The coordinator deliberately rejects wildcard topic configuration at this
 * boundary. It owns the generated subscription set, so accepting wildcards here
 * would make recovery and topic parsing ambiguous.
 */
export const normalizeCoordinatorOptions = (
  options: Partial<CoordinatorOptions> = {},
): CoordinatorOptions => {
  const merged: CoordinatorOptions = {
    ...DEFAULT_COORDINATOR_OPTIONS,
    ...options,
  };

  const normalizedConfig = {
    ...merged,
    homieBasePath: validateTopicBase(merged.homieBasePath, "Homie Base Path"),
    lshBasePath: validateTopicBase(merged.lshBasePath, "LSH Base Path"),
    serviceTopic: validateConcreteTopic(merged.serviceTopic, "Service Topic", {
      requireTrailingSlash: false,
    }),
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
