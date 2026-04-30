/**
 * @file MQTT topic normalization and signature helpers.
 *
 * These helpers sit at the adapter/service boundary, where malformed inbound
 * messages should become explicit errors and generated subscription sets should
 * be compared as semantic sets rather than ordered arrays.
 */
import type { MqttMessage } from "./types";

/**
 * Extracts a normalized topic string from an inbound MQTT-like message.
 * Missing topics are treated as the empty string, while non-string topics are
 * rejected explicitly so adapters fail in a controlled way.
 */
export function normalizeInboundTopic(
  msg: MqttMessage,
): { ok: true; topic: string } | { ok: false; error: string } {
  if (msg.topic === undefined || msg.topic === null) {
    return { ok: true, topic: "" };
  }

  if (typeof msg.topic !== "string") {
    return {
      ok: false,
      error: `Inbound msg.topic must be a string when provided, got ${typeof msg.topic}.`,
    };
  }

  return { ok: true, topic: msg.topic };
}

/**
 * Builds a stable signature for a semantic MQTT topic set.
 * Topics are compared as sets, not as user-defined ordered lists, so sorting is
 * required to avoid unnecessary churn when configuration order changes.
 */
export function buildTopicSetSignature(topics: string[]): string {
  return JSON.stringify([...topics].sort((left, right) => left.localeCompare(right)));
}
