/**
 * @file MQTT subscription builders for standalone and Node-RED adapters.
 *
 * The coordinator derives exact topic subscriptions from the active system
 * config. This module keeps that derivation deterministic and provides the
 * Node-RED control-message projection used by a wrapper node.
 */
import { normalizeCoordinatorSubscriptionQos } from "./config";
import type {
  CoordinatorOptions,
  CoordinatorSubscriptionQosPolicy,
  MqttQoS,
  MqttSubscribeMsg,
  SystemConfig,
} from "./types";

export type { MqttQoS } from "./types";

type SubscriptionBuildOptions = Pick<CoordinatorOptions, "homieBasePath" | "lshBasePath"> & {
  subscriptionQos?: Partial<CoordinatorSubscriptionQosPolicy>;
};

type SubscriptionChannel = "conf" | "state" | "events" | "bridge" | "homieState";

/**
 * Exact subscription map keyed by MQTT topic.
 */
export type CoordinatorSubscriptionMap = Record<string, { qos: MqttQoS }>;

/**
 * Human-readable description for one generated MQTT subscription.
 */
export interface CoordinatorSubscriptionExplanation {
  topic: string;
  qos: MqttQoS;
  device: string;
  channel: SubscriptionChannel;
  purpose: string;
}

const SUBSCRIPTION_PURPOSES: Record<SubscriptionChannel, string> = {
  conf: "retained device configuration snapshots",
  state: "retained and live actuator state snapshots",
  events: "controller-backed device events",
  bridge: "bridge-local diagnostics and service replies",
  homieState: "Homie lifecycle state",
};

/**
 * Builds the exact MQTT subscription set required for the active coordinator
 * config. Standalone MQTT adapters subscribe directly to this map; Node-RED
 * wrappers can convert it to mqtt-in control messages.
 */
export function buildCoordinatorMqttSubscriptions(
  options: SubscriptionBuildOptions,
  config: SystemConfig,
): CoordinatorSubscriptionMap {
  const subscriptions: CoordinatorSubscriptionMap = {};
  const qos = normalizeCoordinatorSubscriptionQos(options.subscriptionQos);

  for (const { name } of config.devices) {
    subscriptions[`${options.lshBasePath}${name}/conf`] = { qos: qos.conf };
    subscriptions[`${options.lshBasePath}${name}/state`] = { qos: qos.state };
    subscriptions[`${options.lshBasePath}${name}/events`] = { qos: qos.events };
    subscriptions[`${options.lshBasePath}${name}/bridge`] = { qos: qos.bridge };
    subscriptions[`${options.homieBasePath}${name}/$state`] = { qos: qos.homieState };
  }

  return subscriptions;
}

/**
 * Explains the generated subscription set in a stable, CLI-friendly shape.
 */
export function explainCoordinatorMqttSubscriptions(
  options: SubscriptionBuildOptions,
  config: SystemConfig,
): CoordinatorSubscriptionExplanation[] {
  const qos = normalizeCoordinatorSubscriptionQos(options.subscriptionQos);
  const explanations: CoordinatorSubscriptionExplanation[] = [];

  for (const { name } of config.devices) {
    explanations.push(
      {
        topic: `${options.lshBasePath}${name}/conf`,
        qos: qos.conf,
        device: name,
        channel: "conf",
        purpose: SUBSCRIPTION_PURPOSES.conf,
      },
      {
        topic: `${options.lshBasePath}${name}/state`,
        qos: qos.state,
        device: name,
        channel: "state",
        purpose: SUBSCRIPTION_PURPOSES.state,
      },
      {
        topic: `${options.lshBasePath}${name}/events`,
        qos: qos.events,
        device: name,
        channel: "events",
        purpose: SUBSCRIPTION_PURPOSES.events,
      },
      {
        topic: `${options.lshBasePath}${name}/bridge`,
        qos: qos.bridge,
        device: name,
        channel: "bridge",
        purpose: SUBSCRIPTION_PURPOSES.bridge,
      },
      {
        topic: `${options.homieBasePath}${name}/$state`,
        qos: qos.homieState,
        device: name,
        channel: "homieState",
        purpose: SUBSCRIPTION_PURPOSES.homieState,
      },
    );
  }

  return explanations.sort((left, right) =>
    left.topic < right.topic ? -1 : left.topic > right.topic ? 1 : 0,
  );
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
