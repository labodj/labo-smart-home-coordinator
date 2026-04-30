# Configuration

The coordinator has one required configuration object: `systemConfig`.

It describes the devices that belong to the LSH installation and the long-click
actions the coordinator should execute. MQTT paths, timing and protocol settings
are runtime options, not part of this file.

Keep this file boring. It is not a general automation language and it should not
try to describe Home Assistant entities, dashboards or presentation details. It
only answers: which LSH devices exist, and what should a long click mean?

## Mental Model

Think of the config as a small map of the house:

- `devices` says which LSH controllers exist.
- `longClickButtons` says what a normal long click should do.
- `superLongClickButtons` says what a super-long click should do.
- `actors` are LSH targets controlled directly by this coordinator.
- `otherActors` are external targets emitted as generic intents.

The coordinator does not guess actions from device names. That is deliberate:
guessing would be convenient until the first wrong relay toggles. It executes
the action map you give it, and it refuses unsafe actions when target state is
not authoritative.

## Minimal Valid Config

This is enough to monitor one device:

```json
{
  "devices": [
    {
      "name": "ingresso"
    }
  ]
}
```

The device name must match the MQTT topic segment. With the default `LSH/` base
path, device `ingresso` publishes on topics such as `LSH/ingresso/state`.

At this stage no button controls anything yet. The coordinator will subscribe,
track lifecycle, validate snapshots and run health checks for the device.

## Commented Example

JSON files cannot contain comments, so this block is `jsonc` for learning. Use
the copyable JSON block below in real files.

```jsonc
{
  // Every known LSH controller goes here.
  "devices": [
    {
      // Device id. It must be the exact MQTT segment used by the device.
      "name": "ingresso",

      // Actions fired by normal long-click events from this device.
      "longClickButtons": [
        {
          // Physical button id reported by the controller.
          "id": 1,

          // LSH devices controlled by this click.
          "actors": [
            {
              // Target device. It must also exist in devices[].
              "name": "cucina",

              // true means "control the whole target device".
              "allActuators": true,

              // Must be empty when allActuators is true.
              "actuators": [],
            },
          ],

          // Optional non-LSH targets. The coordinator emits an intent for them.
          "otherActors": ["zigbee_table_lamp"],
        },
      ],
    },

    // A target device can be listed without local buttons.
    {
      "name": "cucina",
    },
  ],
}
```

Copyable JSON:

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

## Device Entries

Each `devices[]` entry accepts:

| Field                   | Required | Meaning                                         |
| ----------------------- | -------- | ----------------------------------------------- |
| `name`                  | yes      | Device id and MQTT topic segment.               |
| `longClickButtons`      | no       | Actions for long-click events from this device. |
| `superLongClickButtons` | no       | Actions for super-long-click events from it.    |

Device names are intentionally strict. They must be single MQTT topic segments,
using letters, digits, `_` or `-`. Names are checked case-insensitively, so
`Cucina` and `cucina` cannot coexist.

This strictness keeps MQTT topic generation deterministic. A config typo should
fail loudly at startup, not create a half-working topic tree.

## Button Actions

A button action accepts:

| Field         | Required | Meaning                                      |
| ------------- | -------- | -------------------------------------------- |
| `id`          | yes      | Physical button id reported by the device.   |
| `actors`      | no       | LSH targets to control.                      |
| `otherActors` | no       | External targets emitted as generic intents. |

At least one target must exist across `actors` and `otherActors`.

The coordinator treats `longClickButtons` and `superLongClickButtons` the same
way internally. The only difference is the click type reported by the device.

## LSH Actors

An `actor` targets another configured LSH device.

```json
{
  "name": "cucina",
  "allActuators": false,
  "actuators": [1, 2, 3]
}
```

Rules:

- `name` must match a configured device.
- `allActuators: true` means every actuator on that target device.
- `allActuators: true` requires `actuators: []`.
- `allActuators: false` requires a non-empty `actuators` list.

Before confirming a distributed click, the coordinator checks the current target
snapshot. If the target state is missing or stale, the action fails cleanly
instead of guessing the wrong toggle direction.

This is the main safety rule in the coordinator. A distributed click is only
confirmed when the runtime knows enough to execute the action correctly.

## Other Actors

`otherActors` are intentionally simple names:

```json
{
  "id": 2,
  "actors": [],
  "otherActors": ["bedside_lamp", "holiday_tree"]
}
```

When the click runs, the coordinator emits:

```json
{
  "otherActors": ["bedside_lamp", "holiday_tree"],
  "stateToSet": true
}
```

If you use the CLI/MQTT adapter, configure `--other-actors-topic` and the
intent is published there. If you embed the library, listen to the
`otherActors` event and translate the intent to your own ecosystem.

The coordinator can also receive an optional `otherActorStateReader` from
library consumers. That lets it read current external actor state when deciding
toggle direction, without hard-coding Home Assistant, Zigbee2MQTT, Tasmota or
any other integration.

If you do not provide an external state reader, `otherActors` still work as
one-way intents when the coordinator can derive the desired state from LSH
targets. Pure external-only toggles need state feedback, otherwise the
coordinator cannot know whether the next action should turn something on or off.

## Runtime Options

The common runtime options are:

| Option                 | Default            | Meaning                                      |
| ---------------------- | ------------------ | -------------------------------------------- |
| `homieBasePath`        | `homie/5/`         | Homie lifecycle base path.                   |
| `lshBasePath`          | `LSH/`             | LSH device topic base path.                  |
| `serviceTopic`         | `LSH/Node-RED/SRV` | Bridge-wide service topic.                   |
| `protocol`             | `json`             | LSH command payload protocol.                |
| `otherDevicesPrefix`   | `other_devices`    | Prefix used by external actor state readers. |
| `clickTimeout`         | `2`                | Seconds before a click transaction expires.  |
| `clickCleanupInterval` | `30`               | Seconds between expired-click cleanup runs.  |
| `watchdogInterval`     | `60`               | Seconds between health checks.               |
| `interrogateThreshold` | `120`              | Silence before sending a probe.              |
| `pingTimeout`          | `3`                | Seconds to wait for a ping reply.            |
| `initialStateTimeout`  | `2`                | Startup snapshot replay window.              |

MQTT base paths must end with `/`, contain no empty topic segment and contain no
MQTT wildcards. Publish topics such as `serviceTopic` must be concrete topics
and must not end with `/`.

The runtime generates subscriptions itself, so wildcard base paths are rejected.
That keeps parsing, recovery and diagnostics unambiguous.

## Examples

The package includes two strict JSON examples:

- `examples/system-config.minimal.json`
- `examples/system-config.multi-device.json`

They are intentionally small. Start from them, then add only the actions your
installation really needs.
