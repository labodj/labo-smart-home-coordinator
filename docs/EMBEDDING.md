# Embedding

The package exposes two layers:

- `LaboSmartHomeCoordinator`, a transport-agnostic runtime.
- `LaboSmartHomeCoordinatorMqtt`, a convenience adapter that owns an MQTT
  connection.

Use the first when your application already has MQTT infrastructure or wants to
drive tests manually. Use the second when you want a ready-made process that
subscribes and publishes for you.

Most integrations start with the MQTT adapter. Use the transport-agnostic
runtime when you are writing a wrapper, integrating into Node-RED, or testing a
recorded stream of messages.

## Transport-Agnostic Runtime

```ts
import { LaboSmartHomeCoordinator } from "labo-smart-home-coordinator";

const coordinator = new LaboSmartHomeCoordinator({
  systemConfig,
  homieBasePath: "homie/5/",
  lshBasePath: "LSH/",
});

coordinator.on("mqtt", (message) => {
  // Publish message.topic and message.payload with your MQTT client.
  // JSON payloads are objects; MsgPack payloads are Buffers.
});

coordinator.on("alert", (alert) => {
  // Route to logs, notifications or metrics.
});

coordinator.on("otherActors", (command) => {
  // Translate external actor intents to your own integration.
});

await coordinator.start();
```

Feed every relevant MQTT message into `processMqttMessage`:

```ts
await coordinator.processMqttMessage({
  topic: "LSH/cucina/conf",
  payload: {
    p: 1,
    v: 1,
    n: "cucina",
    a: [1, 2, 3],
    b: [1],
  },
  retain: true,
});
```

The coordinator does not subscribe by itself in this mode. Read the exact
subscription map from it and apply it in your host runtime:

```ts
const subscriptions = coordinator.getSubscriptions();
await mqttClient.subscribeAsync(subscriptions);
```

Override subscription QoS through the same runtime options used by the CLI:

```ts
const coordinator = new LaboSmartHomeCoordinator({
  systemConfig,
  subscriptionQos: {
    conf: 1,
    state: 1,
    events: 2,
    bridge: 1,
    homieState: 1,
  },
});
```

Use `explainCoordinatorMqttSubscriptions` when a wrapper needs a
human-readable dry-run view of the exact topics, QoS values, and why each topic
is subscribed.

## Payload Shapes

The coordinator accepts the same payload shapes that common MQTT adapters
produce:

- an object, when a JSON payload has already been parsed;
- a string, when the adapter exposes MQTT text as-is;
- a `Buffer`, when the adapter preserves the raw MQTT payload.

That behavior keeps wrappers small: read `msg.topic`, read `msg.payload`, pass
both to `processMqttMessage`, and let the coordinator normalize the domain
payload once at the boundary.

For a Node-RED wrapper, this means the built-in `mqtt in` node can be configured
with payload output set to `auto-detect` for JSON-based LSH installations. JSON
objects, JSON strings, and JSON Buffers are all accepted by the coordinator.

For MsgPack installations, keep the payload binary. MsgPack frames must reach
the coordinator as `Buffer`s because converting binary payloads to strings is
lossy and adapter-dependent.

A minimal Node-RED wrapper can stay thin: pass inbound MQTT messages to
`processMqttMessage`, send `mqtt` events to `mqtt out`, and expose
`otherActors` / `alert` events on separate outputs.

## MQTT Adapter

```ts
import { LaboSmartHomeCoordinatorMqtt } from "labo-smart-home-coordinator/mqtt";

const runtime = new LaboSmartHomeCoordinatorMqtt({
  brokerUrl: "mqtt://localhost:1883",
  systemConfig,
  mqttOptions: {
    protocolVersion: 5,
    username: "homie",
    password: "homie",
  },
  otherActorsTopic: "home/lsh/other-actors",
  alertsTopic: "home/lsh/alerts",
});

await runtime.start();
```

The adapter uses the same `mqtt` package options you would pass to
`mqtt.connectAsync`, including TLS certificates and MQTT v5 settings.

The adapter subscribes after the coordinator has validated config, so a bad
device map fails before it starts consuming broker traffic.

## Other Actor State Reader

Some external targets need toggle semantics. The coordinator can read their
current state through a tiny adapter interface:

```ts
const runtime = new LaboSmartHomeCoordinator({
  systemConfig,
  otherActorStateReader: {
    get(key) {
      return externalStateStore.get(key);
    },
  },
});
```

Keys use `otherDevicesPrefix` plus the actor name. With the default prefix,
actor `bedside_lamp` is read from `other_devices.bedside_lamp`.

Return booleans from this reader. Unknown, missing or non-boolean states are not
used for toggle decisions.

## Events

| Event         | Meaning                                         |
| ------------- | ----------------------------------------------- |
| `mqtt`        | LSH command ready to publish.                   |
| `otherActors` | External actor intent ready to route.           |
| `alert`       | Structured alert payload.                       |
| `state`       | Device registry snapshot changed.               |
| `config`      | Effective runtime config changed.               |
| `status`      | Runtime status changed.                         |
| `log`         | Informational runtime log.                      |
| `warning`     | Warning runtime log.                            |
| `error`       | Non-fatal service error event.                  |
| `debug`       | Original inbound MQTT message after processing. |

The coordinator installs a default no-op `error` listener so non-fatal service
errors do not crash host applications that only use a logger.

## Updating Config at Runtime

```ts
await coordinator.updateSystemConfig(nextSystemConfig);
```

The update is atomic. Pending click transactions are cleared, stale queued
startup or watchdog traffic is invalidated and a recovery pass is scheduled for
the new device set.
