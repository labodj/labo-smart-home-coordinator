/**
 * @file Standalone MQTT adapter for the coordinator runtime.
 *
 * The core coordinator intentionally has no MQTT dependency. This adapter owns
 * broker connection, subscriptions and publish serialization for CLI/standalone
 * use while keeping the same event-driven runtime usable by Node-RED.
 */
import mqtt from "mqtt";
import type { IClientOptions } from "mqtt";

import { LaboSmartHomeCoordinator } from "./LaboSmartHomeCoordinator";
import type { CoordinatorLogger } from "./LaboSmartHomeCoordinator";
import type {
  CoordinatorOptions,
  MqttMessage,
  OtherActorsCommandPayload,
  SystemConfig,
} from "./types";

/**
 * Small subset of the MQTT.js async client used by this adapter.
 *
 * Keeping this interface narrow makes the adapter easy to test with fakes and
 * avoids exposing MQTT.js internals through the public package API.
 */
export interface CoordinatorMqttClient {
  on(
    event: "message",
    listener: (topic: string, payload: Buffer, packet: { retain?: boolean }) => void,
  ): this;
  subscribeAsync(subscriptions: Record<string, { qos: 0 | 1 | 2 }>): Promise<unknown>;
  publishAsync(
    topic: string,
    payload: string | Buffer,
    options: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<unknown>;
  endAsync(): Promise<void>;
}

/**
 * Injectable MQTT client factory used by tests and custom embedders.
 */
export type CoordinatorMqttClientFactory = (
  brokerUrl: string,
  options: IClientOptions | undefined,
) => Promise<CoordinatorMqttClient>;

/**
 * Options for the broker-owning standalone adapter.
 */
export interface LaboSmartHomeCoordinatorMqttOptions extends Partial<CoordinatorOptions> {
  brokerUrl: string;
  systemConfig: SystemConfig;
  mqttOptions?: IClientOptions;
  otherActorsTopic?: string;
  alertsTopic?: string;
  otherActorStateReader?: { get(key: string): unknown };
  logger?: CoordinatorLogger;
  clientFactory?: CoordinatorMqttClientFactory;
}

/**
 * Default MQTT.js factory used in production.
 */
const defaultMqttClientFactory: CoordinatorMqttClientFactory = async (brokerUrl, options) =>
  await mqtt.connectAsync(brokerUrl, options);

/**
 * Converts coordinator output payloads to MQTT.js-compatible publish payloads.
 */
const toMqttPayload = (payload: unknown): string | Buffer => {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (typeof payload === "string") {
    return payload;
  }
  // The coordinator uses plain objects for JSON commands. MQTT libraries expect
  // strings or Buffers at the publish boundary, so stringify exactly once here.
  return JSON.stringify(payload);
};

/**
 * MQTT-owning standalone adapter for `LaboSmartHomeCoordinator`.
 */
export class LaboSmartHomeCoordinatorMqtt {
  private readonly coordinator: LaboSmartHomeCoordinator;
  private readonly clientFactory: CoordinatorMqttClientFactory;
  private client: CoordinatorMqttClient | null = null;
  // Inbound MQTT handling and outbound publishes share one queue. This avoids
  // subtle reordering when processing an inbound frame synchronously emits a
  // command that must be published before the next broker message is handled.
  private messageQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: LaboSmartHomeCoordinatorMqttOptions) {
    this.coordinator = new LaboSmartHomeCoordinator({
      ...options,
      logger: options.logger,
      otherActorStateReader: options.otherActorStateReader,
      systemConfig: options.systemConfig,
    });
    this.clientFactory = options.clientFactory ?? defaultMqttClientFactory;
    this.wireCoordinatorOutputs();
  }

  public getCoordinator(): LaboSmartHomeCoordinator {
    return this.coordinator;
  }

  public async start(): Promise<void> {
    if (this.client) {
      return;
    }

    const client = await this.clientFactory(this.options.brokerUrl, this.options.mqttOptions);
    this.client = client;
    client.on("message", (topic, payload, packet) => {
      // MQTT clients deliver Buffer payloads. The coordinator boundary handles
      // JSON decoding, retained metadata and validation, keeping this adapter
      // intentionally thin.
      this.messageQueue = this.messageQueue
        .then(() =>
          this.coordinator.processMqttMessage({
            topic,
            payload,
            retain: packet.retain === true,
          }),
        )
        .catch((error: unknown) => {
          this.options.logger?.error?.(
            `Failed to process MQTT message '${topic}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    });

    await this.coordinator.start();
    await client.subscribeAsync(this.coordinator.getSubscriptions());
    this.options.logger?.info?.(
      `Subscribed to ${Object.keys(this.coordinator.getSubscriptions()).length} LSH topic(s).`,
    );
  }

  public async stop(): Promise<void> {
    await this.flush();
    await this.coordinator.stop();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.endAsync();
    }
  }

  public async flush(): Promise<void> {
    await this.messageQueue;
    await this.coordinator.flush();
  }

  private wireCoordinatorOutputs(): void {
    this.coordinator.on("mqtt", (message) => {
      this.messageQueue = this.messageQueue.then(() => this.publishMqttMessage(message));
    });

    this.coordinator.on("otherActors", (payload) => {
      if (!this.options.otherActorsTopic) {
        // External actors are integration-specific. Without an explicit topic,
        // logging is safer than inventing a broker convention.
        this.options.logger?.debug?.("Other actor command emitted without a configured topic.");
        return;
      }
      this.messageQueue = this.messageQueue.then(() =>
        this.publishJson(this.options.otherActorsTopic!, payload, 1),
      );
    });

    this.coordinator.on("alert", (payload) => {
      if (!this.options.alertsTopic) {
        // Alerts should still be visible when no MQTT topic is configured.
        this.options.logger?.warn?.(payload.message);
        return;
      }
      this.messageQueue = this.messageQueue.then(() =>
        this.publishJson(this.options.alertsTopic!, payload, 1),
      );
    });
  }

  private async publishMqttMessage(message: MqttMessage): Promise<void> {
    const client = this.client;
    if (!client || typeof message.topic !== "string") {
      return;
    }

    await client.publishAsync(message.topic, toMqttPayload(message.payload), {
      qos: message.qos ?? 0,
      retain: message.retain === true,
    });
  }

  private async publishJson(
    topic: string,
    payload: OtherActorsCommandPayload | object,
    qos: 0 | 1 | 2,
  ): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    await client.publishAsync(topic, JSON.stringify(payload), {
      qos,
      retain: false,
    });
  }
}
