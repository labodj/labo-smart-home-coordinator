# Lifecycle Contract

This document describes how `labo-smart-home-coordinator` decides what is
alive, what can be repaired, when alerts are allowed and how startup, runtime
config changes, watchdog probes and live traffic interact.

The README is the usage guide. This file is the operational contract.

## Core Principles

The runtime deliberately separates **last known state** from **current
reachability**.

- Retained `conf` and `state` payloads are authoritative topology and actuator
  snapshots.
- Retained Homie `$state=ready` is not proof that the device is alive now.
- Retained `events` and `bridge` payloads are ignored for current reachability.
- Live controller-backed LSH traffic, live Homie lifecycle transitions and live
  bridge service replies are runtime reachability proofs.
- Live Homie `init` and `sleeping` are diagnostics. They refresh diagnostics but
  never mark the bridge or controller path reachable.
- Live Homie `disconnected` and `lost` are offline states.
- An empty Homie `$state` payload is the v5 device-removal signal; the runtime
  removes local device state.
- Recovery uses the lightest repair that can close the observed gap.

Startup can therefore reuse retained snapshots while still waiting for live
evidence before calling a device healthy.

## Recovery Paths

Every configured device is classified into one recovery path:

| Path                   | Meaning                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `controller_reachable` | The controller path is usable. Snapshot repair and controller pings are allowed.               |
| `bridge_only`          | The bridge is alive, but reports `controller_connected=false`. Controller recovery is skipped. |
| `offline`              | No live bridge reachability is known. The runtime probes the bridge path first.                |

Startup verification, watchdog repair and bridge-service recovery all use this
same classification. That keeps behavior consistent across cold boot and normal
runtime.

## Startup

Startup has three phases:

1. Apply and validate `systemConfig`.
2. Optionally request a bridge-local `BOOT` replay, only when at least one
   configured device lacks an authoritative `conf + state` snapshot.
3. Run initial verification:
   - reachable but incomplete devices receive only the missing snapshot
     requests;
   - still-unreachable devices receive direct controller `PING`;
   - bridge-only devices are logged but do not receive controller-directed
     recovery.

During warm-up, normal watchdog recovery alerts are suppressed. Startup
reachability is decided by the dedicated verification path, not by watchdog
alerts racing the initial sync.

Periodic watchdog and cleanup timers start only after a valid configuration has
been applied.

## Runtime Config Update

A successful runtime config update does not restart the process.

Instead, the runtime:

- replaces the active config atomically;
- clears pending click transactions;
- drops stale low-priority startup/watchdog traffic from the previous config
  generation;
- schedules a post-update recovery pass;
- defers that recovery if startup verification is still pending;
- recomputes MQTT subscriptions from the new device set.

If validation fails, `updateSystemConfig` throws and the active runtime keeps the
last valid config.

## Watchdog

The watchdog is conservative:

- never-seen configured devices may trigger unhealthy alerts and bridge probes;
- devices in `bridge_only` state never receive controller-directed pings;
- offline devices are bridge-probed first;
- stale state stays latched until real live activity clears it;
- bridge probes are rate-limited independently from controller ping timestamps;
- bridge probe cooldown follows the actual service-topic broadcast, so it is
  global across the fleet rather than per device;
- controller `PING` timeout accounting starts when the command is actually
  emitted, not when the watchdog merely queues it;
- startup warm-up remains active until `pingTimeout` after the last startup
  verification controller-side command is emitted.

## Snapshot Recovery

Snapshot repair is rate-limited per device.

- If `conf` details are missing, request both `REQUEST_DETAILS` and
  `REQUEST_STATE`.
- If only `state` is missing, request only `REQUEST_STATE`.
- Bridge replies that report `runtime_synchronized=false` may force immediate
  repair.
- Snapshot recovery cooldown starts only after the planned recovery burst has
  actually been emitted.
- A partial burst invalidated mid-drain does not suppress the replacement retry.
- Once a complete authoritative snapshot exists again, the repair cooldown is
  cleared.

## Distributed Clicks

Distributed long-click actions use a request, ACK and confirm lifecycle.

The runtime validates targets before confirming the action. A click fails fast
when a target device is reachable but lacks an authoritative actuator snapshot.
Guessing would be worse than rejecting that user action and waiting for the next
valid event.

Runtime config updates clear pending click transactions. In-flight distributed
clicks are intentionally failed rather than preserved across a config change.

## Output Ordering

The coordinator serializes immediate outputs through one internal queue.

- High-priority live outputs are emitted in order.
- Low-priority bulk startup/watchdog traffic drains in the background.
- The stagger sleep happens outside the send queue, so later high-priority live
  traffic can overtake future low-priority frames.
- Config updates invalidate stale low-priority queued traffic from older config
  generations.

The MQTT adapter uses the same sequencing when publishing to the broker.

## Alerts

Alert behavior is designed to avoid notification storms.

- Unhealthy alerts latch through `alertSent`.
- `alertSent` does not block future recovery checks.
- Recovery alerts are suppressed during warm-up.
- A real live recovery signal clears the unhealthy latch.

Alert payloads include structured fields such as `event_type` and
`event_source`, so notification flows can distinguish lifecycle events from true
watchdog outages without parsing formatted text.

## Non-Goals

The lifecycle is designed to be idempotent and robust, not transactionally
perfect.

It deliberately avoids complex cross-restart recovery for in-flight click
transactions and rare startup/update timing races that would add more complexity
than they remove.
