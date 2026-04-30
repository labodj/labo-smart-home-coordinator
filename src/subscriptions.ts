/**
 * @file MQTT subscription builders for standalone and Node-RED adapters.
 *
 * The coordinator derives exact topic subscriptions from the active system
 * config. This module keeps that derivation deterministic and provides the
 * Node-RED control-message projection used by a wrapper node.
 */
import type { CoordinatorOptions, MqttSubscribeMsg, SystemConfig } from "./types";

/**
 * MQTT Quality of Service values accepted by MQTT.js and Node-RED mqtt-in.
 */
export type MqttQoS = 0 | 1 | 2;

/**
 * Exact subscription map keyed by MQTT topic.
 */
export type CoordinatorSubscriptionMap = Record<string, { qos: MqttQoS }>;

/**
 * Builds the exact MQTT subscription set required for the active coordinator
 * config. Standalone MQTT adapters subscribe directly to this map; Node-RED
 * wrappers can convert it to mqtt-in control messages.
 */
export function buildCoordinatorMqttSubscriptions(
  options: Pick<CoordinatorOptions, "homieBasePath" | "lshBasePath">,
  config: SystemConfig,
): CoordinatorSubscriptionMap {
  const subscriptions: CoordinatorSubscriptionMap = {};

  for (const { name } of config.devices) {
    subscriptions[`${options.lshBasePath}${name}/conf`] = { qos: 2 };
    subscriptions[`${options.lshBasePath}${name}/state`] = { qos: 2 };
    subscriptions[`${options.lshBasePath}${name}/events`] = { qos: 2 };
    subscriptions[`${options.lshBasePath}${name}/bridge`] = { qos: 2 };
    subscriptions[`${options.homieBasePath}${name}/$state`] = { qos: 1 };
  }

  return subscriptions;
}

/**
 * Converts the subscription map to the control message shape accepted by
 * Node-RED's built-in mqtt-in node.
 */
export function buildNodeRedSubscriptionMessages(
  subscriptions: CoordinatorSubscriptionMap,
): MqttSubscribeMsg[] {
  const grouped = new Map<MqttQoS, string[]>();
  for (const [topic, { qos }] of Object.entries(subscriptions)) {
    const topics = grouped.get(qos) ?? [];
    topics.push(topic);
    grouped.set(qos, topics);
  }

  return [...grouped.entries()]
    .sort(([leftQos], [rightQos]) => leftQos - rightQos)
    .map(([qos, topics]) => ({
      action: "subscribe",
      topic: topics.sort((left, right) => left.localeCompare(right)),
      qos,
    }));
}
