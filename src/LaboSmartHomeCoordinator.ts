/**
 * @file Public coordinator runtime facade.
 *
 * This module is the embeddable boundary of the standalone package. It owns the
 * lifecycle around `LshLogicService`: startup, warm-up, timers, low-priority
 * recovery queues, output ordering and typed events. MQTT is deliberately kept
 * outside this class so the same runtime can be used by a CLI, Node-RED wrapper
 * or test harness.
 */
import { EventEmitter } from "node:events";

import { normalizeCoordinatorOptions } from "./config";
import { LshCodec } from "./LshCodec";
import { LshLogicService } from "./LshLogicService";
import { createAppValidators } from "./schemas";
import { buildCoordinatorMqttSubscriptions } from "./subscriptions";
import { buildTopicSetSignature, normalizeInboundTopic } from "./topic-helpers";
import { LshProtocol, Output } from "./types";
import type {
  AlertPayload,
  CoordinatorOptions,
  DeviceRegistrySnapshot,
  MqttMessage,
  OtherActorsCommandPayload,
  OutputMessages,
  ServiceResult,
  SystemConfig,
} from "./types";
import { sleep } from "./utils";

export type CoordinatorStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "warming_up"
  | "config_error"
  | "closing";

/**
 * Minimal logger contract accepted by the runtime and adapters.
 */
export interface CoordinatorLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

/**
 * Abstract read-only state source for external actors.
 *
 * Node-RED can back this with flow/global context, while standalone embedders
 * can provide any object with a stable `get` method.
 */
export interface OtherActorStateReader {
  get(key: string): unknown;
}

/**
 * Typed EventEmitter contract exposed by `LaboSmartHomeCoordinator`.
 */
export interface LaboSmartHomeCoordinatorEvents {
  log: [message: string];
  warning: [message: string];
  error: [message: string];
  status: [status: CoordinatorStatus];
  mqtt: [message: MqttMessage];
  otherActors: [payload: OtherActorsCommandPayload];
  alert: [payload: AlertPayload];
  debug: [message: MqttMessage];
  state: [snapshot: { devices: DeviceRegistrySnapshot; lastUpdated: number }];
  config: [config: SystemConfig];
}

/**
 * Runtime options required to embed the coordinator without owning MQTT.
 */
export interface LaboSmartHomeCoordinatorRuntimeOptions extends Partial<CoordinatorOptions> {
  systemConfig: SystemConfig;
  otherActorStateReader?: OtherActorStateReader;
  logger?: CoordinatorLogger;
}

type ConfigLoadMode = "startup" | "runtime";

type LowPriorityQueuedMessage = {
  generation: number;
  message: MqttMessage;
  controllerPingDeviceName: string | null;
  bridgeProbe: boolean;
  snapshotRecoveryDeviceName: string | null;
  startupVerificationDeviceCommand: boolean;
};

type LowPriorityTracking = Pick<
  LowPriorityQueuedMessage,
  "controllerPingDeviceName" | "bridgeProbe" | "snapshotRecoveryDeviceName"
>;

type DispatchedLowPriorityTracking = LowPriorityTracking &
  Pick<LowPriorityQueuedMessage, "startupVerificationDeviceCommand">;

/**
 * Small delay used before replaying bridge-local BOOT at startup.
 *
 * The delay gives retained MQTT snapshots a chance to arrive first; if the
 * snapshots are already complete, the coordinator avoids an unnecessary replay.
 */
const STARTUP_BOOT_DELAY_MS = 500;
const LOW_PRIORITY_DRAIN_MIN_DELAY_MS = 50;
const LOW_PRIORITY_DRAIN_JITTER_MS = 200;

/**
 * Default external-state reader used when the embedder does not provide one.
 */
class EmptyOtherActorStateReader implements OtherActorStateReader {
  public get(): unknown {
    return undefined;
  }
}

/**
 * Standalone, transport-agnostic LSH coordinator runtime.
 *
 * The class owns timers, warm-up, watchdog sequencing and output ordering, but
 * it does not own MQTT. Embedders receive MQTT/alert/other-actor events and can
 * decide whether to publish them to a broker, a host output, a test harness
 * or another integration layer.
 */
export class LaboSmartHomeCoordinator extends EventEmitter {
  private readonly options: CoordinatorOptions;
  private readonly logger?: CoordinatorLogger;
  private readonly service: LshLogicService;
  private readonly codec = new LshCodec();

  private cleanupInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private startupBootTimer: NodeJS.Timeout | null = null;
  private initialVerificationTimer: NodeJS.Timeout | null = null;
  private runtimeRecoveryTimer: NodeJS.Timeout | null = null;
  // All immediate output events pass through this promise chain. It keeps MQTT
  // commands, alerts and external actor intents in deterministic order even
  // when processing callbacks schedule more work while a previous output is
  // still being handled by an adapter.
  private sendQueue: Promise<void> = Promise.resolve();
  private lowPriorityDrainPromise: Promise<void> | null = null;
  private pendingLowPriorityMessages: LowPriorityQueuedMessage[] = [];
  private lowPriorityGeneration = 0;
  private isWarmingUp = false;
  private isClosing = false;
  private status: CoordinatorStatus = "stopped";
  private warmupDeadlineAt: number | null = null;
  private runtimeRecoveryQueuedAfterStartup = false;
  private watchdogCycleQueued = false;
  private watchdogCyclePromise: Promise<void> | null = null;
  private tracksStartupVerificationRecoveryWindow = false;
  private lastSubscriptionSignature: string | null = null;

  public constructor(private readonly runtimeOptions: LaboSmartHomeCoordinatorRuntimeOptions) {
    super();
    // The coordinator surfaces service-level errors as events, but an
    // unhandled Node.js "error" event would crash embedders. Keep the event
    // available without making logging-only errors fatal by default.
    this.on("error", () => undefined);
    this.options = normalizeCoordinatorOptions(runtimeOptions);
    this.logger = runtimeOptions.logger;

    this.service = new LshLogicService(
      {
        lshBasePath: this.options.lshBasePath,
        homieBasePath: this.options.homieBasePath,
        serviceTopic: this.options.serviceTopic,
        protocol: this.options.protocol,
        otherDevicesPrefix: this.options.otherDevicesPrefix,
        clickTimeout: this.options.clickTimeout,
        interrogateThreshold: this.options.interrogateThreshold,
        pingTimeout: this.options.pingTimeout,
      },
      runtimeOptions.otherActorStateReader ?? new EmptyOtherActorStateReader(),
      createAppValidators(),
    );
  }

  public override on<K extends keyof LaboSmartHomeCoordinatorEvents>(
    eventName: K,
    listener: (...args: LaboSmartHomeCoordinatorEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  public override emit<K extends keyof LaboSmartHomeCoordinatorEvents>(
    eventName: K,
    ...args: LaboSmartHomeCoordinatorEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }

  public getOptions(): CoordinatorOptions {
    return structuredClone(this.options);
  }

  public getSystemConfig(): SystemConfig | null {
    return this.service.getSystemConfig();
  }

  public getDeviceRegistry(): DeviceRegistrySnapshot {
    return this.service.getDeviceRegistry();
  }

  public getSubscriptions() {
    const config = this.service.getSystemConfig() ?? this.runtimeOptions.systemConfig;
    return buildCoordinatorMqttSubscriptions(this.options, config);
  }

  public start(): Promise<void> {
    if (this.status !== "stopped") {
      return Promise.resolve();
    }

    this.isClosing = false;
    this.setStatus("starting");
    this.applySystemConfig(this.runtimeOptions.systemConfig, "startup");
    this.startTimers();
    this.setStatus("ready");
    return Promise.resolve();
  }

  public async stop(): Promise<void> {
    if (this.status === "stopped") {
      return;
    }

    this.setStatus("closing");
    this.isClosing = true;
    this.clearTimers();
    this.invalidateLowPriorityDrain();
    await this.flush();
    this.setStatus("stopped");
  }

  public async flush(): Promise<void> {
    if (this.lowPriorityDrainPromise) {
      await this.lowPriorityDrainPromise;
    }
    if (this.watchdogCyclePromise) {
      await this.watchdogCyclePromise;
    }
    await this.sendQueue;
  }

  public updateSystemConfig(config: SystemConfig): Promise<void> {
    this.applySystemConfig(config, "runtime");
    return Promise.resolve();
  }

  public async processMqttMessage(message: MqttMessage): Promise<void> {
    if (this.isClosing) {
      return;
    }

    const topicResult = normalizeInboundTopic(message);
    if (!topicResult.ok) {
      throw new Error(topicResult.error);
    }

    const topic = topicResult.topic;
    // Decode once at the coordinator boundary. After this point the service
    // only sees domain payloads, independent from whether MQTT delivered a
    // Buffer, a string or an object parsed by an auto-detecting adapter.
    const decodedPayload = this.codec.decode(message.payload, this.getPayloadProtocol(topic));
    const result = this.service.processMessage(topic, decodedPayload, {
      retained: message.retain === true,
    });
    await this.processServiceResult(result);
    this.emit("debug", message);
  }

  public async runWatchdogNow(): Promise<void> {
    await this.runWatchdogCycle();
  }

  private applySystemConfig(config: SystemConfig, mode: ConfigLoadMode): void {
    const validators = createAppValidators();
    if (!validators.validateSystemConfig(config)) {
      const errorText =
        validators.validateSystemConfig.errors?.map((error) => error.message).join(", ") ??
        "unknown validation error";
      this.setStatus("config_error");
      throw new Error(`Invalid coordinator config: ${errorText}`);
    }

    if (mode === "startup") {
      this.clearStartupTimers();
    }
    this.invalidateLowPriorityDrain();

    const logMessage = this.service.updateSystemConfig(config);
    this.log(logMessage);
    const activeConfig = this.service.getSystemConfig();
    if (activeConfig) {
      this.emit("config", activeConfig);
    }
    this.emitState();
    this.emitSubscriptionsIfChanged();

    if (mode === "startup") {
      this.scheduleInitialVerification();
    } else if (this.isStartupRecoveryStillPending()) {
      this.runtimeRecoveryQueuedAfterStartup = true;
    } else {
      this.scheduleRuntimeRecoveryVerification();
    }
  }

  private startTimers(): void {
    if (this.cleanupInterval || this.watchdogInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      const log = this.service.cleanupPendingClicks();
      if (log) {
        this.log(log);
      }
    }, this.options.clickCleanupInterval * 1000);

    this.watchdogInterval = setInterval(() => {
      void this.runWatchdogCycle();
    }, this.options.watchdogInterval * 1000);
  }

  private clearTimers(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.cleanupInterval = null;
    this.watchdogInterval = null;
    this.clearStartupTimers();
    this.clearRuntimeRecoveryTimer();
  }

  private async runWatchdogCycle(): Promise<void> {
    if (this.isWarmingUp || this.isClosing) {
      return;
    }

    if (this.watchdogCyclePromise) {
      this.watchdogCycleQueued = true;
      await this.watchdogCyclePromise;
      return;
    }

    let cyclePromise: Promise<void> | null = null;
    cyclePromise = (async () => {
      try {
        do {
          this.watchdogCycleQueued = false;
          if (this.isWarmingUp || this.isClosing) {
            break;
          }

          await this.processServiceResult(this.service.runWatchdogCheck());
        } while (this.watchdogCycleQueued && !this.isClosing);
      } finally {
        this.watchdogCycleQueued = false;
        if (this.watchdogCyclePromise === cyclePromise) {
          this.watchdogCyclePromise = null;
        }
      }
    })();

    this.watchdogCyclePromise = cyclePromise;
    await cyclePromise;
  }

  private async processServiceResult(result: ServiceResult): Promise<void> {
    result.logs.forEach((message) => this.log(message));
    result.warnings.forEach((message) => this.warn(message));
    result.errors.forEach((message) => this.error(message));

    if (result.stateChanged || result.registryChanged) {
      this.emitState();
    }

    this.suppressWarmupRecoveryAlerts(result.messages);
    this.scheduleStaggeredLshMessages(result);

    if (Object.keys(result.messages).length > 0) {
      await this.enqueueSendOperation(() => {
        this.markImmediateLshDispatches(result.messages[Output.Lsh]);
        this.emitOutputMessages(result.messages);
      });
    }
  }

  private emitOutputMessages(messages: OutputMessages): void {
    this.emitMqttMessages(messages[Output.Lsh]);
    this.emitOtherActorMessages(messages[Output.OtherActors]);
    this.emitAlertMessages(messages[Output.Alerts]);
  }

  private suppressWarmupRecoveryAlerts(messages: OutputMessages): void {
    if (!this.isWarmingUp || !messages[Output.Alerts]) {
      return;
    }

    // Startup is noisy by nature: retained snapshots, Homie lifecycle and
    // bridge replies may arrive in any order. Suppress only positive recovery
    // alerts during warm-up; unhealthy alerts are still allowed when the
    // dedicated startup verification path decides they are real.
    const alertMessages = this.toMessageList(messages[Output.Alerts]);
    const filteredAlerts = alertMessages.filter((message) => !this.isRecoveryAlert(message));
    if (filteredAlerts.length === alertMessages.length) {
      return;
    }

    this.log("Suppressing recovery alert during warm-up period.");
    if (filteredAlerts.length === 0) {
      delete messages[Output.Alerts];
      return;
    }

    messages[Output.Alerts] = this.fromMessageList(filteredAlerts);
  }

  private scheduleStaggeredLshMessages(result: ServiceResult): void {
    const lshMessages = this.toMessageList(result.messages[Output.Lsh]);
    if (!result.staggerLshMessages || lshMessages.length <= 1) {
      return;
    }

    this.log(`Sending ${lshMessages.length} LSH messages in a staggered sequence.`);
    // Startup and watchdog repairs can produce bursts of low-priority probes.
    // Draining them separately avoids blocking live click acknowledgements
    // while still preserving ordering inside each individual publish.
    this.scheduleLowPriorityDrain(lshMessages);
    delete result.messages[Output.Lsh];
  }

  private emitMqttMessages(messages: MqttMessage | MqttMessage[] | undefined): void {
    for (const message of this.toMessageList(messages)) {
      this.emit("mqtt", message);
    }
  }

  private emitOtherActorMessages(messages: MqttMessage | MqttMessage[] | undefined): void {
    for (const message of this.toMessageList(messages)) {
      const payload = message.payload as OtherActorsCommandPayload | undefined;
      if (payload) {
        this.emit("otherActors", payload);
      }
    }
  }

  private emitAlertMessages(messages: MqttMessage | MqttMessage[] | undefined): void {
    for (const message of this.toMessageList(messages)) {
      const payload = message.payload as AlertPayload | undefined;
      if (payload) {
        this.emit("alert", payload);
      }
    }
  }

  private toMessageList(messages: MqttMessage | MqttMessage[] | undefined): MqttMessage[] {
    if (!messages) {
      return [];
    }

    return Array.isArray(messages) ? messages : [messages];
  }

  private fromMessageList(messages: MqttMessage[]): MqttMessage | MqttMessage[] {
    return messages.length === 1 ? messages[0] : messages;
  }

  private enqueueSendOperation<T>(work: () => T | Promise<T>): Promise<T> {
    const queuedWork = this.sendQueue.then(work, work);
    this.sendQueue = queuedWork.then(
      () => undefined,
      () => undefined,
    );
    return queuedWork;
  }

  private scheduleLowPriorityDrain(messages: MqttMessage[]): void {
    const generation = this.lowPriorityGeneration;
    this.pendingLowPriorityMessages.push(
      ...messages.map((message) => {
        const controllerPingDeviceName = this.getControllerPingDeviceName(message);
        const snapshotRecoveryDeviceName = this.getSnapshotRecoveryDeviceName(message);
        if (controllerPingDeviceName) {
          this.service.recordQueuedControllerPing(controllerPingDeviceName);
        }

        return {
          generation,
          message,
          controllerPingDeviceName,
          bridgeProbe: this.isBridgeProbeMessage(message),
          snapshotRecoveryDeviceName,
          startupVerificationDeviceCommand:
            this.tracksStartupVerificationRecoveryWindow &&
            (controllerPingDeviceName !== null || snapshotRecoveryDeviceName !== null),
        };
      }),
    );

    if (this.lowPriorityDrainPromise) {
      return;
    }

    this.lowPriorityDrainPromise = (async () => {
      try {
        while (!this.isClosing && this.pendingLowPriorityMessages.length > 0) {
          const nextMessage = this.pendingLowPriorityMessages.shift();
          if (!nextMessage) {
            continue;
          }

          if (nextMessage.generation !== this.lowPriorityGeneration) {
            this.cancelQueuedTracking(nextMessage);
            continue;
          }

          await this.enqueueSendOperation(() => {
            if (this.isClosing || nextMessage.generation !== this.lowPriorityGeneration) {
              this.cancelQueuedTracking(nextMessage);
              return;
            }

            this.recordDispatchedTracking(nextMessage);
            this.emit("mqtt", nextMessage.message);
          });

          if (this.pendingLowPriorityMessages.length > 0) {
            await sleep(
              Math.random() * LOW_PRIORITY_DRAIN_JITTER_MS + LOW_PRIORITY_DRAIN_MIN_DELAY_MS,
            );
          }
        }
      } finally {
        this.lowPriorityDrainPromise = null;
      }
    })();
  }

  private cancelQueuedTracking(message: LowPriorityTracking): void {
    if (message.controllerPingDeviceName) {
      this.service.cancelQueuedControllerPing(message.controllerPingDeviceName);
    }
    if (message.bridgeProbe) {
      this.service.cancelQueuedBridgeProbe();
    }
    if (message.snapshotRecoveryDeviceName) {
      this.service.cancelQueuedSnapshotRecovery(message.snapshotRecoveryDeviceName);
    }
  }

  private recordDispatchedTracking(message: DispatchedLowPriorityTracking): void {
    if (message.controllerPingDeviceName) {
      this.service.recordDispatchedControllerPing(message.controllerPingDeviceName);
    }
    if (message.bridgeProbe) {
      this.service.recordDispatchedBridgeProbe();
    }
    if (message.snapshotRecoveryDeviceName) {
      this.service.recordDispatchedSnapshotRecovery(message.snapshotRecoveryDeviceName);
    }
    if (message.startupVerificationDeviceCommand) {
      this.extendWarmupForStartupVerificationDispatch();
    }
  }

  private invalidateLowPriorityDrain(): void {
    // Config changes make queued recovery frames stale: a device may have been
    // removed, renamed or moved to a different base path. Incrementing the
    // generation lets an active drain notice and discard old work safely.
    this.lowPriorityGeneration++;
    const pendingMessages = this.pendingLowPriorityMessages.splice(0);
    for (const message of pendingMessages) {
      this.cancelQueuedTracking(message);
    }
  }

  private getPayloadProtocol(topic: string): "json" | "msgpack" | "text" {
    return topic.startsWith(this.options.lshBasePath) ? this.options.protocol : "text";
  }

  private getControllerPingDeviceName(message: MqttMessage): string | null {
    if (typeof message.topic !== "string" || !message.topic.startsWith(this.options.lshBasePath)) {
      return null;
    }
    if (!message.topic.endsWith("/IN")) {
      return null;
    }

    const payload = this.decodeCommandPayload(message);
    if (payload?.p !== LshProtocol.PING) {
      return null;
    }

    const deviceName = message.topic.slice(this.options.lshBasePath.length, -"/IN".length);
    return deviceName.length > 0 ? deviceName : null;
  }

  private isBridgeProbeMessage(message: MqttMessage): boolean {
    if (typeof message.topic !== "string" || message.topic !== this.options.serviceTopic) {
      return false;
    }

    return this.decodeCommandPayload(message)?.p === LshProtocol.PING;
  }

  private getSnapshotRecoveryDeviceName(message: MqttMessage): string | null {
    if (typeof message.topic !== "string" || !message.topic.startsWith(this.options.lshBasePath)) {
      return null;
    }
    if (!message.topic.endsWith("/IN")) {
      return null;
    }

    const payload = this.decodeCommandPayload(message);
    if (payload?.p !== LshProtocol.REQUEST_DETAILS && payload?.p !== LshProtocol.REQUEST_STATE) {
      return null;
    }

    const deviceName = message.topic.slice(this.options.lshBasePath.length, -"/IN".length);
    return deviceName.length > 0 ? deviceName : null;
  }

  private decodeCommandPayload(message: MqttMessage): { p?: unknown } | null {
    const decoded = this.codec.decode(message.payload, this.options.protocol);
    return decoded && typeof decoded === "object" ? decoded : null;
  }

  private markImmediateLshDispatches(messages: OutputMessages[Output.Lsh] | undefined): void {
    for (const message of this.toMessageList(messages)) {
      let startupVerificationDeviceCommandDispatched = false;

      const deviceName = this.getControllerPingDeviceName(message);
      if (deviceName) {
        this.service.recordDispatchedControllerPing(deviceName);
        startupVerificationDeviceCommandDispatched = true;
      }

      if (this.isBridgeProbeMessage(message)) {
        this.service.recordDispatchedBridgeProbe();
      }

      const snapshotRecoveryDeviceName = this.getSnapshotRecoveryDeviceName(message);
      if (snapshotRecoveryDeviceName) {
        this.service.recordDispatchedSnapshotRecovery(snapshotRecoveryDeviceName);
        startupVerificationDeviceCommandDispatched = true;
      }

      if (
        startupVerificationDeviceCommandDispatched &&
        this.tracksStartupVerificationRecoveryWindow
      ) {
        this.extendWarmupForStartupVerificationDispatch();
      }
    }
  }

  private scheduleInitialVerification(): void {
    const initialStateTimeoutMs = this.options.initialStateTimeout * 1000;
    const pingTimeoutMs = this.options.pingTimeout * 1000;
    const totalWarmupTimeMs = STARTUP_BOOT_DELAY_MS + initialStateTimeoutMs + pingTimeoutMs;

    this.log(`Starting warm-up for up to ${this.formatDurationSeconds(totalWarmupTimeMs)}s.`);
    this.startWarmup(totalWarmupTimeMs);

    // Give MQTT subscriptions a short settle window before asking the bridge to
    // replay snapshots. Without this, a startup BOOT could race the subscriber
    // and the coordinator would immediately need a second repair pass.
    this.startupBootTimer = setTimeout(() => {
      void this.runStartupSequence(initialStateTimeoutMs, pingTimeoutMs);
    }, STARTUP_BOOT_DELAY_MS);
  }

  private async runStartupSequence(
    initialStateTimeoutMs: number,
    pingTimeoutMs: number,
  ): Promise<void> {
    this.startupBootTimer = null;

    if (!this.service.needsStartupBootReplay()) {
      this.log(
        "Skipping startup BOOT replay because all configured devices already have authoritative snapshots.",
      );
      this.startWarmup(pingTimeoutMs);
      await this.runInitialVerification();
      return;
    }

    this.log("Requesting startup bridge-local BOOT resync.");
    await this.processServiceResult(this.service.getStartupCommands());

    this.initialVerificationTimer = setTimeout(() => {
      void this.runInitialVerification();
    }, initialStateTimeoutMs);
  }

  private async runInitialVerification(): Promise<void> {
    this.initialVerificationTimer = null;
    this.log("Running initial device state verification.");
    this.tracksStartupVerificationRecoveryWindow = true;
    try {
      await this.processServiceResult(this.service.verifyInitialDeviceStates());
    } finally {
      this.tracksStartupVerificationRecoveryWindow = false;
    }

    if (this.runtimeRecoveryQueuedAfterStartup && !this.isClosing) {
      this.scheduleRuntimeRecoveryVerification();
    }
  }

  private scheduleRuntimeRecoveryVerification(): void {
    this.clearRuntimeRecoveryTimer();
    this.runtimeRecoveryQueuedAfterStartup = false;
    this.runtimeRecoveryTimer = setTimeout(() => {
      void this.runRuntimeRecoverySequence(this.options.initialStateTimeout * 1000);
    }, STARTUP_BOOT_DELAY_MS);
  }

  private async runRuntimeRecoverySequence(initialStateTimeoutMs: number): Promise<void> {
    this.runtimeRecoveryTimer = null;
    if (this.isClosing) {
      return;
    }

    this.log("Running post-config device recovery.");
    if (!this.service.needsStartupBootReplay()) {
      await this.runInitialVerification();
      return;
    }

    this.log("Config update left missing snapshots. Requesting bridge-local BOOT resync.");
    await this.processServiceResult(this.service.getStartupCommands());
    this.initialVerificationTimer = setTimeout(() => {
      void this.runInitialVerification();
    }, initialStateTimeoutMs);
  }

  private isStartupRecoveryStillPending(): boolean {
    return (
      this.isWarmingUp || this.startupBootTimer !== null || this.initialVerificationTimer !== null
    );
  }

  private clearStartupTimers(): void {
    if (this.startupBootTimer) clearTimeout(this.startupBootTimer);
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    if (this.initialVerificationTimer) clearTimeout(this.initialVerificationTimer);
    this.startupBootTimer = null;
    this.warmupTimer = null;
    this.initialVerificationTimer = null;
    this.isWarmingUp = false;
    this.warmupDeadlineAt = null;
    this.runtimeRecoveryQueuedAfterStartup = false;
    this.tracksStartupVerificationRecoveryWindow = false;
  }

  private clearRuntimeRecoveryTimer(): void {
    if (this.runtimeRecoveryTimer) clearTimeout(this.runtimeRecoveryTimer);
    this.runtimeRecoveryTimer = null;
  }

  private startWarmup(durationMs: number): void {
    this.setWarmupDeadline(Date.now() + durationMs);
  }

  private setWarmupDeadline(deadlineAt: number): void {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
    }

    this.isWarmingUp = true;
    this.setStatus("warming_up");
    this.warmupDeadlineAt = deadlineAt;
    this.warmupTimer = setTimeout(
      () => {
        this.isWarmingUp = false;
        this.warmupDeadlineAt = null;
        this.warmupTimer = null;
        if (!this.isClosing) {
          this.setStatus("ready");
          this.log("Warm-up period finished.");
        }
      },
      Math.max(deadlineAt - Date.now(), 0),
    );
  }

  private extendWarmupForStartupVerificationDispatch(now = Date.now()): void {
    if (!this.isWarmingUp) {
      return;
    }

    const nextDeadline = now + this.options.pingTimeout * 1000;
    if (this.warmupDeadlineAt !== null && this.warmupDeadlineAt >= nextDeadline) {
      return;
    }

    // If verification emits another controller-side command near the end of the
    // warm-up window, extend the window just enough for its reply timeout. This
    // avoids producing a recovery notification for a probe we deliberately sent.
    this.setWarmupDeadline(nextDeadline);
  }

  private isRecoveryAlert(message: MqttMessage): boolean {
    const { payload } = message;
    return (
      payload !== null &&
      typeof payload === "object" &&
      (payload as { status?: unknown }).status === "healthy"
    );
  }

  private emitState(): void {
    this.emit("state", {
      devices: this.service.getDeviceRegistry(),
      lastUpdated: Date.now(),
    });
  }

  private emitSubscriptionsIfChanged(): void {
    const subscriptions = this.getSubscriptions();
    const signature = buildTopicSetSignature(Object.keys(subscriptions));
    if (signature === this.lastSubscriptionSignature) {
      return;
    }

    this.lastSubscriptionSignature = signature;
    this.log(
      `Coordinator subscription set contains ${Object.keys(subscriptions).length} topic(s).`,
    );
  }

  private setStatus(status: CoordinatorStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private log(message: string): void {
    this.logger?.info?.(message);
    this.emit("log", message);
  }

  private warn(message: string): void {
    this.logger?.warn?.(message);
    this.emit("warning", message);
  }

  private error(message: string): void {
    this.logger?.error?.(message);
    this.emit("error", message);
  }

  private formatDurationSeconds(durationMs: number): string {
    const seconds = durationMs / 1000;
    return Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1);
  }
}
