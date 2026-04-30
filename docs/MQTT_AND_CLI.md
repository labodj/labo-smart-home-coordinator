# MQTT and CLI

The CLI is the fastest way to run the coordinator as a standalone service. It
loads a JSON config file, connects to MQTT, subscribes to the generated topic set
and publishes coordinator outputs back to the broker.

If you embed the coordinator in another runtime instead of using the CLI, the
input side does not require a specific MQTT client. The coordinator accepts
object, string and Buffer payloads for JSON protocol topics, so adapters can
stay thin and predictable.

Use this mode when you want one process whose only job is LSH coordination. If
you already have Node-RED or another orchestration runtime, embedding may be a
better fit.

## Basic Run

```bash
npx labo-smart-home-coordinator \
  --broker mqtt://localhost:1883 \
  --config ./system-config.json
```

The same setup through environment variables:

```bash
LSH_COORDINATOR_MQTT_URL=mqtt://localhost:1883 \
LSH_COORDINATOR_CONFIG=./system-config.json \
npx labo-smart-home-coordinator
```

The config file is read at startup. For now, restart the process when changing
the file; embedders can use `updateSystemConfig` for runtime reloads.

## MQTT Authentication

Use `--username` and `--password`:

```bash
npx labo-smart-home-coordinator \
  --broker mqtt://192.168.1.20:1883 \
  --username homie \
  --password homie \
  --config ./system-config.json
```

Equivalent environment variables:

```bash
LSH_COORDINATOR_MQTT_URL=mqtt://192.168.1.20:1883
LSH_COORDINATOR_USERNAME=homie
LSH_COORDINATOR_PASSWORD=homie
```

## MQTT v5

MQTT v3.1.1 is the default because it is broadly compatible. MQTT v5 is
available with:

```bash
npx labo-smart-home-coordinator \
  --broker mqtt://localhost:1883 \
  --mqtt-version 5 \
  --config ./system-config.json
```

The coordinator does not depend on MQTT v5 features. Use v5 when your broker and
operational standards already use it; otherwise the default is fine.

## TLS and Mutual TLS

Use `mqtts://` for TLS:

```bash
npx labo-smart-home-coordinator \
  --broker mqtts://mqtt.example.net:8883 \
  --ca ./certs/ca.pem \
  --config ./system-config.json
```

For mutual TLS, pass client certificate and key together:

```bash
npx labo-smart-home-coordinator \
  --broker mqtts://mqtt.example.net:8883 \
  --ca ./certs/ca.pem \
  --cert ./certs/client.crt \
  --key ./certs/client.key \
  --config ./system-config.json
```

If your key is encrypted, add:

```bash
--key-passphrase "changeit"
```

Certificate verification is enabled by default. For a local lab broker with a
self-signed certificate you can disable it explicitly:

```bash
--reject-unauthorized false
```

## Topics Subscribed by the CLI

For every configured device, the runtime subscribes to:

| Topic                     | QoS |
| ------------------------- | --- |
| `LSH/<device>/conf`       | `2` |
| `LSH/<device>/state`      | `2` |
| `LSH/<device>/events`     | `2` |
| `LSH/<device>/bridge`     | `2` |
| `homie/5/<device>/$state` | `1` |

The exact prefixes come from `--lsh-base-path` and `--homie-base-path`.

## Topics Published by the CLI

Coordinator LSH commands are published to:

```text
LSH/<device>/IN
```

Bridge-wide probes and replay requests are published to:

```text
LSH/Node-RED/SRV
```

That topic name is historical and remains the default for existing LSH
installations. You can change it with `--service-topic`.

Optional external outputs:

| Option                 | Payload                                 |
| ---------------------- | --------------------------------------- |
| `--other-actors-topic` | Generic external actor command intents. |
| `--alerts-topic`       | Structured coordinator alerts.          |

If `--other-actors-topic` is omitted, external actor intents are logged at debug
level and not published. If `--alerts-topic` is omitted, alerts are written to
the logger.

## CLI Options

| Option                    | Environment Variable                       |
| ------------------------- | ------------------------------------------ |
| `--broker`                | `LSH_COORDINATOR_MQTT_URL`                 |
| `--config`                | `LSH_COORDINATOR_CONFIG`                   |
| `--homie-base-path`       | `LSH_COORDINATOR_HOMIE_BASE_PATH`          |
| `--lsh-base-path`         | `LSH_COORDINATOR_LSH_BASE_PATH`            |
| `--service-topic`         | `LSH_COORDINATOR_SERVICE_TOPIC`            |
| `--protocol`              | `LSH_COORDINATOR_PROTOCOL`                 |
| `--other-devices-prefix`  | `LSH_COORDINATOR_OTHER_DEVICES_PREFIX`     |
| `--click-timeout`         | `LSH_COORDINATOR_CLICK_TIMEOUT`            |
| `--click-cleanup`         | `LSH_COORDINATOR_CLICK_CLEANUP_INTERVAL`   |
| `--watchdog-interval`     | `LSH_COORDINATOR_WATCHDOG_INTERVAL`        |
| `--ping-threshold`        | `LSH_COORDINATOR_INTERROGATE_THRESHOLD`    |
| `--ping-timeout`          | `LSH_COORDINATOR_PING_TIMEOUT`             |
| `--initial-state-timeout` | `LSH_COORDINATOR_INITIAL_STATE_TIMEOUT`    |
| `--other-actors-topic`    | `LSH_COORDINATOR_OTHER_ACTORS_TOPIC`       |
| `--alerts-topic`          | `LSH_COORDINATOR_ALERTS_TOPIC`             |
| `--mqtt-version`          | `LSH_COORDINATOR_MQTT_VERSION`             |
| `--client-id`             | `LSH_COORDINATOR_CLIENT_ID`                |
| `--username`              | `LSH_COORDINATOR_USERNAME`                 |
| `--password`              | `LSH_COORDINATOR_PASSWORD`                 |
| `--ca`                    | `LSH_COORDINATOR_MQTT_CA`                  |
| `--cert`                  | `LSH_COORDINATOR_MQTT_CERT`                |
| `--key`                   | `LSH_COORDINATOR_MQTT_KEY`                 |
| `--key-passphrase`        | `LSH_COORDINATOR_MQTT_KEY_PASSPHRASE`      |
| `--reject-unauthorized`   | `LSH_COORDINATOR_MQTT_REJECT_UNAUTHORIZED` |
| `--log-level`             | `LSH_COORDINATOR_LOG_LEVEL`                |

`LSH_COORDINATOR_MQTT_CA` accepts multiple files separated by the platform path
delimiter, for example `:` on Linux and macOS or `;` on Windows.

## Operational Notes

Run one coordinator instance for the same LSH fleet. Multiple active instances
would all answer the same click events and publish duplicate commands.

Use retained LSH `conf` and `state` messages. The coordinator can reuse retained
snapshots at startup while still requiring live reachability evidence before it
marks devices healthy.

For JSON protocol installations, adapters may deliver payloads as objects,
strings or Buffers. For MsgPack, preserve binary payloads as Buffers all the way
to the coordinator.
