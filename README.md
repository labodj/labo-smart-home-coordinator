# Labo Smart Home Coordinator

[![npm](https://img.shields.io/npm/v/labo-smart-home-coordinator.svg)](https://www.npmjs.com/package/labo-smart-home-coordinator)
[![npm downloads](https://img.shields.io/npm/dm/labo-smart-home-coordinator.svg)](https://www.npmjs.com/package/labo-smart-home-coordinator)
[![CI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Flabodj%2Flabo-smart-home-coordinator%2Factions%2Fworkflows%2Fci.yaml%2Fruns%3Fbranch%3Dmain%26status%3Dsuccess%26per_page%3D1&query=%24.workflow_runs%5B0%5D.head_sha&label=CI&logo=github&color=2ea44f)](https://github.com/labodj/labo-smart-home-coordinator/actions/workflows/ci.yaml)
[![Latest Release](https://img.shields.io/github/release/labodj/labo-smart-home-coordinator.svg)](https://github.com/labodj/labo-smart-home-coordinator/releases/latest)
[![License](https://img.shields.io/github/license/labodj/labo-smart-home-coordinator.svg)](https://github.com/labodj/labo-smart-home-coordinator/blob/main/LICENSE)

[![works with MQTT Homie](https://homieiot.github.io/img/works-with-homie.svg "works with MQTT Homie")](https://homieiot.github.io/)

`labo-smart-home-coordinator` is the standalone TypeScript runtime for the
public LSH MQTT coordination contract. It listens to LSH device telemetry, keeps
a live registry, validates distributed long-click actions, emits actuator
commands, publishes alerts, and exposes generic intents for non-LSH devices.

In practical terms, it answers one careful question: a button was long-pressed,
so what is safe to switch right now?

## Why This Exists

LSH devices already publish their configuration, state, Homie lifecycle, and
click events over MQTT. This package adds the small runtime that coordinates
across devices and refuses actions when the required state is not reliable.

It keeps that responsibility focused:

- the config names the LSH devices and the click actions you want;
- the coordinator checks whether target state is fresh enough to act;
- LSH commands, alerts, and external actor intents stay separate;
- Home Assistant discovery, dashboards, and ecosystem-specific commands remain
  outside the core runtime.

You can run it as a CLI process, embed it in a Node.js service, or use it
through the Node-RED wrapper package.

## Install

```bash
npm install labo-smart-home-coordinator
```

Node.js 18 or newer is required.

## Run It from the CLI

The CLI owns the MQTT connection for you:

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

TLS and mutual TLS are supported:

```bash
npx labo-smart-home-coordinator \
  --broker mqtts://mqtt.example.net:8883 \
  --ca ./certs/ca.pem \
  --cert ./certs/client.crt \
  --key ./certs/client.key \
  --config ./system-config.json
```

## Use It as a Library

Use the transport-agnostic runtime when your application already owns MQTT or
wants to feed messages from another source:

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

## Minimal Config

The config file lists the LSH devices the coordinator should know about and the
button actions it should execute.

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

## Runtime Behavior

The coordinator is conservative by design. It reuses retained `conf` and
`state` snapshots, but it does not treat retained lifecycle traffic as proof
that a device is alive right now. A distributed click is confirmed only when the
target state is authoritative, and recovery probes are rate-limited so a broken
device does not flood the broker.

It subscribes to `conf`, `state`, `events`, `bridge`, and Homie `$state` topics
for every configured device. It publishes LSH commands to device `IN` topics and
bridge-wide probes to the configured service topic.

## Documentation

The full documentation map lives in
[DOCS.md](https://github.com/labodj/labo-smart-home-coordinator/blob/main/DOCS.md).
Start there for configuration, CLI options, embedding, MQTT behavior, and the
lifecycle contract.

The Node-RED sibling is
[`node-red-contrib-lsh-logic`](https://flows.nodered.org/node/node-red-contrib-lsh-logic).
It wraps this runtime with Node-RED editor fields, context access, dynamic MQTT
subscriptions, and physical outputs.

## Maintainer Notes

The local quality gate runs type checking, linting, Markdown checks, formatting
checks, package validation, coverage, and a production dependency audit:

```bash
npm ci
npm run check
```

## License

Apache-2.0. See
[LICENSE](https://github.com/labodj/labo-smart-home-coordinator/blob/main/LICENSE).
