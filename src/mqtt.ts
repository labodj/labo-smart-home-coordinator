/**
 * @file Public MQTT adapter barrel.
 *
 * Importing from `labo-smart-home-coordinator/mqtt` gives standalone users the
 * broker-owning adapter without pulling it into the transport-agnostic root
 * import path.
 */
export {
  LaboSmartHomeCoordinatorMqtt,
  type CoordinatorMqttClient,
  type CoordinatorMqttClientFactory,
  type LaboSmartHomeCoordinatorMqttOptions,
} from "./mqtt-adapter";
export {
  buildCoordinatorMqttSubscriptions,
  buildNodeRedSubscriptionMessages,
  type CoordinatorSubscriptionMap,
  type MqttQoS,
} from "./subscriptions";
