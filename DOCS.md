# Documentation

This package is the standalone LSH coordinator runtime. The README gives the
shortest path for installing and running it; this page keeps the rest of the
documentation easy to navigate.

## Start Here

Read these in order if you are bringing up a new coordinator:

1. [README](README.md) for the package purpose, the CLI entry point, and the
   library entry points.
2. [Configuration](docs/CONFIGURATION.md) for the `systemConfig` shape and the
   validation rules.
3. [MQTT and CLI](docs/MQTT_AND_CLI.md) for broker settings, TLS, environment
   variables, and published topics.

That path is enough for a standalone service.

## Common Tasks

| Task                                        | Read this first                                                 |
| ------------------------------------------- | --------------------------------------------------------------- |
| Write the first `system-config.json` file   | [Configuration](docs/CONFIGURATION.md)                          |
| Run the coordinator as a process            | [MQTT and CLI](docs/MQTT_AND_CLI.md)                            |
| Use TLS, mutual TLS, or MQTT authentication | [MQTT and CLI](docs/MQTT_AND_CLI.md#tls-and-mutual-tls)         |
| Embed the runtime in a Node.js service      | [Embedding](docs/EMBEDDING.md)                                  |
| Route external actor intents                | [Configuration](docs/CONFIGURATION.md#other-actors)             |
| Understand startup, watchdog, and recovery  | [Lifecycle contract](LIFECYCLE.md)                              |
| Check the MQTT/protocol source of truth     | [Vendored protocol](vendor/lsh-protocol/shared/lsh_protocol.md) |

## Choose the Right Entry Point

Use the CLI when you want one process dedicated to LSH coordination. It loads a
JSON config file, connects to MQTT, subscribes to the generated topic set, and
publishes outputs back to the broker.

Use `LaboSmartHomeCoordinatorMqtt` when your application is still happy to let
this package own the broker connection, but you want to construct and manage it
from code.

Use `LaboSmartHomeCoordinator` when another runtime already owns transport. In
that mode the coordinator receives messages, emits semantic events, and leaves
publishing or routing to the host.

Use
[`node-red-contrib-lsh-logic`](https://github.com/labodj/node-red-contrib-lsh-logic)
when Node-RED is the orchestration surface. That package wraps this runtime with
editor fields, context access, dynamic subscription messages, and Node-RED
outputs.

## What Belongs Here

This coordinator is about LSH runtime correctness: devices, distributed clicks,
state freshness, recovery, watchdog behavior, alerts, and generic external actor
intents.

It does not describe Home Assistant entities, dashboards, UI names, or
ecosystem-specific commands. Those details belong in the integration that
receives the coordinator output. Keeping that split visible makes the config
easier to review and safer to change.

## Wider LSH Stack

The project-level docs provide the full installation picture:

- [Reference stack](https://github.com/labodj/labo-smart-home/blob/main/REFERENCE_STACK.md)
- [Getting started](https://github.com/labodj/labo-smart-home/blob/main/GETTING_STARTED.md)
- [Glossary](https://github.com/labodj/labo-smart-home/blob/main/GLOSSARY.md)
- [Troubleshooting](https://github.com/labodj/labo-smart-home/blob/main/TROUBLESHOOTING.md)

Use those pages for architecture and operational context. Use this package
documentation for the coordinator API, CLI, and runtime behavior.
