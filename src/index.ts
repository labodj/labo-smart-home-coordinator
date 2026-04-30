/**
 * @file Public transport-agnostic package entry point.
 *
 * This barrel intentionally exports the coordinator core, shared types and
 * generated protocol constants, but not the MQTT.js adapter. Consumers that want
 * broker ownership should import from `labo-smart-home-coordinator/mqtt`.
 */
export {
  LaboSmartHomeCoordinator,
  type CoordinatorLogger,
  type CoordinatorStatus,
  type LaboSmartHomeCoordinatorEvents,
  type LaboSmartHomeCoordinatorRuntimeOptions,
  type OtherActorStateReader,
} from "./LaboSmartHomeCoordinator";
export { DEFAULT_COORDINATOR_OPTIONS, normalizeCoordinatorOptions } from "./config";
export { LshCodec } from "./LshCodec";
export { LshLogicService } from "./LshLogicService";
export {
  buildCoordinatorMqttSubscriptions,
  buildNodeRedSubscriptionMessages,
  type CoordinatorSubscriptionMap,
  type MqttQoS,
} from "./subscriptions";
export {
  type Actor,
  type AlertPayload,
  type ButtonAction,
  type CoordinatorOptions,
  type DeviceDetailsPayload,
  type DeviceEntry,
  type DeviceRegistrySnapshot,
  type DeviceStateSnapshot,
  type MqttMessage,
  type OtherActorsCommandPayload,
  type SystemConfig,
} from "./types";
export {
  ClickType,
  LshProtocol,
  LSH_PROTOCOL_KEYS,
  LSH_PROTOCOL_SPEC_REVISION,
  LSH_WIRE_PROTOCOL_MAJOR,
} from "./types";
export { PACKAGE_VERSION } from "./version";
