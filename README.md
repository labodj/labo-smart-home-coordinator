# Labo Smart Home Coordinator

[![npm](https://img.shields.io/npm/v/labo-smart-home-coordinator.svg)](https://www.npmjs.com/package/labo-smart-home-coordinator)
[![npm downloads](https://img.shields.io/npm/dm/labo-smart-home-coordinator.svg)](https://www.npmjs.com/package/labo-smart-home-coordinator)
[![CI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Flabodj%2Flabo-smart-home-coordinator%2Factions%2Fworkflows%2Fci.yaml%2Fruns%3Fbranch%3Dmain%26status%3Dsuccess%26per_page%3D1&query=%24.workflow_runs%5B0%5D.head_sha&label=CI&logo=github&color=2ea44f)](https://github.com/labodj/labo-smart-home-coordinator/actions/workflows/ci.yaml)
[![Latest Release](https://img.shields.io/github/release/labodj/labo-smart-home-coordinator.svg)](https://github.com/labodj/labo-smart-home-coordinator/releases)
[![License](https://img.shields.io/github/license/labodj/labo-smart-home-coordinator.svg)](https://github.com/labodj/labo-smart-home-coordinator/blob/main/LICENSE)

[![works with MQTT Homie](https://homieiot.github.io/img/works-with-homie.svg "works with MQTT Homie")](https://homieiot.github.io/)

`labo-smart-home-coordinator` is the standalone runtime for the public LSH MQTT
coordination contract. It listens to LSH device telemetry, keeps a live device
registry, validates distributed long-click actions, emits actuator commands,
publishes alerts and can route intents for non-LSH devices.

In practical terms, this is the piece that answers: "a button was long-pressed;
what is safe to switch right now?" It can run as a CLI process, be embedded in a
Node.js service, or sit behind a Node-RED wrapper.

## Why This Exists

LSH devices already know how to report their configuration, state, Homie
lifecycle and click events over MQTT. What they need is a small, strict runtime
that answers a few practical questions:

- Which devices are expected to exist?
- Which button should control which actuators?
- Is the target state fresh enough to execute a distributed click safely?
- When should a bridge or controller be probed instead of spammed?
- How should external targets be exposed without hard-coding a specific smart
  home ecosystem?

This package keeps that orchestration focused. Home Assistant discovery,
dashboards and ecosystem-specific actions stay outside this coordinator, so the
runtime can stay small, predictable and easy to reason about.

## How It Fits

You need three things:

- an MQTT broker that already carries LSH/Homie traffic;
- a `system-config.json` file that describes devices and click actions;
- either the built-in CLI, the MQTT adapter, or your own wrapper.

The coordinator does not replace your broker. It consumes MQTT messages,
decides what should happen, and publishes the resulting commands or intents.

## Install

```bash
npm install labo-smart-home-coordinator
```

Node.js 18 or newer is required.

## Run It From the CLI

The CLI owns the MQTT connection for you. Give it a broker URL and a
`system-config.json` file:

```bash
npx labo-smart-home-coordinator \
  --broker mqtt://localhost:1883 \
  --config ./system-config.json
```

With authentication and MQTT v5:

```bash
npx labo-smart-home-coordinator \
  --broker mqtt://192.168.1.20:1883 \
  --username homie \
  --password homie \
  --mqtt-version 5 \
  --config ./system-config.json
```

TLS and mutual TLS are supported from the CLI:

```bash
npx labo-smart-home-coordinator \
  --broker mqtts://mqtt.example.net:8883 \
  --ca ./certs/ca.pem \
  --cert ./certs/client.crt \
  --key ./certs/client.key \
  --config ./system-config.json
```

See the full CLI and environment variable reference in
[MQTT and CLI](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/MQTT_AND_CLI.md).

## Use It as a Library

Use the transport-agnostic coordinator when your application already owns MQTT
or wants to feed messages from another source. The runtime does not care whether
the message came from `mqtt`, Node-RED, a test fixture or a replay tool:

```ts
import { LaboSmartHomeCoordinator } from "labo-smart-home-coordinator";

const coordinator = new LaboSmartHomeCoordinator({
  systemConfig,
  homieBasePath: "homie/5/",
  lshBasePath: "LSH/",
});

coordinator.on("mqtt", (message) => mqttClient.publish(message.topic!, message.payload));
coordinator.on("alert", (alert) => console.warn(alert.message));
coordinator.on("otherActors", (command) => routeExternalActors(command));

await coordinator.start();
await coordinator.processMqttMessage({
  topic: "LSH/cucina/state",
  payload: { p: 2, s: [1] },
});
```

The input boundary is intentionally adapter-agnostic. For JSON-based LSH
installations, `payload` may be an object, a JSON string or a `Buffer`
containing JSON text. That means a future Node-RED wrapper can receive messages
from the built-in `mqtt in` node in `auto-detect` mode and pass them through
without custom parsing.

MsgPack installations should preserve payloads as `Buffer`s, because MsgPack is
binary and cannot be represented safely as a string.

Use the MQTT adapter when you want the package to own the broker connection:

```ts
import { LaboSmartHomeCoordinatorMqtt } from "labo-smart-home-coordinator/mqtt";

const runtime = new LaboSmartHomeCoordinatorMqtt({
  brokerUrl: "mqtt://localhost:1883",
  systemConfig,
  otherActorsTopic: "home/other-actors/commands",
  alertsTopic: "home/alerts",
});

await runtime.start();
```

The embedding guide is in
[Embedding](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/EMBEDDING.md).

## Configuration in One Minute

The config file lists the devices the coordinator should know about and the
button actions it should execute. Start with device names only, then add button
actions one by one.

```json
{
  "devices": [
    {
      "name": "ingresso",
      "longClickButtons": [
        {
          "id": 1,
          "actors": [
            {
              "name": "cucina",
              "allActuators": true,
              "actuators": []
            }
          ],
          "otherActors": ["zigbee_table_lamp"]
        }
      ]
    },
    {
      "name": "cucina"
    }
  ]
}
```

That means: when device `ingresso` reports a long click on button `1`, toggle
all actuators on device `cucina` and also emit an intent for
`zigbee_table_lamp`.

For a commented walkthrough, validation rules and larger examples, read
[Configuration](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/CONFIGURATION.md).

## Safe by Default

The coordinator is intentionally conservative:

- it reuses retained `conf` and `state` snapshots, but does not treat retained
  lifecycle traffic as proof of live reachability;
- it refuses a distributed click when the target state is not authoritative;
- it rate-limits recovery probes so a broken device does not flood the broker;
- it separates LSH commands, alerts and external actor intents cleanly.

That behavior is more strict than a quick automation script, but it is what you
want from a runtime that may control real lights and relays every day.

## MQTT Topics

For every configured device, the runtime listens to:

- `LSH/<device>/conf`
- `LSH/<device>/state`
- `LSH/<device>/events`
- `LSH/<device>/bridge`
- `homie/5/<device>/$state`

It publishes device commands to `LSH/<device>/IN` and bridge-wide commands to
the configured service topic, usually `LSH/Node-RED/SRV` for existing LSH
installations.

## Other Actors

`otherActors` are intentionally generic. The coordinator does not assume
whether `zigbee_table_lamp` is Home Assistant, Zigbee2MQTT, Tasmota or a custom
service. It emits a small intent:

```json
{
  "otherActors": ["zigbee_table_lamp"],
  "stateToSet": true
}
```

The CLI/MQTT adapter can publish those intents to a topic of your choice with
`--other-actors-topic`. If you embed the library, listen to the `otherActors`
event and route it however your home automation stack expects.

This keeps the package useful outside a single house setup: the LSH decision is
made here, while the ecosystem-specific translation remains yours.

## Home Assistant Discovery

This package does not create Home Assistant discovery entities. Keep discovery
decoupled by pairing it with
[`node-red-contrib-homie-home-assistant-discovery`](https://flows.nodered.org/node/node-red-contrib-homie-home-assistant-discovery)
or with the standalone
[`homie-home-assistant-discovery`](https://www.npmjs.com/package/homie-home-assistant-discovery)
library.

The split is deliberate: this coordinator handles LSH runtime correctness;
Homie-to-Home-Assistant discovery handles names, entity platforms, icons and
discovery IDs.

## Documentation

- [Configuration](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/CONFIGURATION.md)
- [MQTT and CLI](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/MQTT_AND_CLI.md)
- [Embedding](https://github.com/labodj/labo-smart-home-coordinator/blob/main/docs/EMBEDDING.md)
- [Lifecycle Contract](https://github.com/labodj/labo-smart-home-coordinator/blob/main/LIFECYCLE.md)
- [LSH protocol reference](https://github.com/labodj/labo-smart-home-coordinator/blob/main/vendor/lsh-protocol/shared/lsh_protocol.md)

## License

Apache-2.0. See
[LICENSE](https://github.com/labodj/labo-smart-home-coordinator/blob/main/LICENSE).
