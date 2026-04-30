/**
 * @file Encodes and decodes LSH payloads at adapter boundaries.
 *
 * The coordinator core works with plain JavaScript objects. This codec is the
 * only place that knows whether a transport is carrying JSON text, already
 * decoded JSON, or raw MsgPack bytes.
 */
import { decode, encode } from "@msgpack/msgpack";

/**
 * Supported serialization protocols.
 */
export type Protocol = "json" | "msgpack";

/**
 * Protocol accepted by inbound decoding.
 *
 * `text` is used by tests and adapter boundaries that need to parse a raw
 * string without implying a configured device protocol.
 */
export type DecodeProtocol = Protocol | "text";

/**
 * Handles the encoding and decoding of messages between the coordinator and devices.
 * Centralizes the logic for handling different protocols (JSON vs MsgPack).
 *
 * The decoder intentionally accepts the same shapes produced by common MQTT
 * adapters: Buffers, strings and already-parsed objects. That keeps wrappers
 * thin and lets a Node-RED `mqtt in` node run in auto-detect mode for JSON
 * installations without adding adapter-specific branches elsewhere.
 */
export class LshCodec {
  /**
   * Decodes an incoming payload.
   * Buffer payloads must be decoded using the explicit transport protocol
   * selected by the caller. Requiring the protocol at the API boundary keeps
   * future call sites from accidentally falling back to the text path.
   *
   * @param payload - The raw payload from an inbound MQTT-like message.
   * @param protocol - The transport protocol expected for this MQTT topic.
   * @returns The decoded JavaScript object.
   * @throws Error if decoding fails.
   */
  public decode(payload: unknown, protocol: DecodeProtocol): unknown {
    if (Buffer.isBuffer(payload)) {
      if (protocol === "msgpack") {
        return decode(payload);
      }

      // JSON payloads can still arrive as Buffers when an MQTT client or
      // Node-RED flow is configured to preserve the raw wire payload. Decode it
      // exactly like a text frame so callers do not need transport-specific code.
      return this.decodeText(payload.toString("utf8"));
    }

    if (protocol === "msgpack") {
      throw new Error("MsgPack payloads must arrive as Buffers.");
    }

    // Auto-detecting adapters may parse JSON before handing payloads to the
    // coordinator. Preserve the already-decoded object instead of serializing
    // and parsing it again.
    if (typeof payload === "object" && payload !== null) {
      return payload;
    }

    if (typeof payload === "string") {
      return this.decodeText(payload);
    }

    return payload;
  }

  private decodeText(payload: string): unknown {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }

  /**
   * Encodes a payload for transmission based on the configured protocol.
   *
   * @param payload - The JavaScript object to encode.
   * @param protocol - The target protocol ('json' or 'msgpack').
   * @returns A Buffer for MsgPack or the original value for JSON adapters.
   */
  public encode<T>(payload: T, protocol: "msgpack"): Buffer;
  public encode<T>(payload: T, protocol: "json"): T;
  public encode<T>(payload: T, protocol: Protocol): Buffer | T;
  public encode<T>(payload: T, protocol: Protocol): Buffer | T {
    if (protocol === "msgpack") {
      // Reuse the Uint8Array backing store so MsgPack commands do not pay an
      // extra copy before they are handed to the MQTT adapter.
      const encodedPayload = encode(payload);
      return Buffer.from(
        encodedPayload.buffer,
        encodedPayload.byteOffset,
        encodedPayload.byteLength,
      );
    }

    // For JSON we return the value and let the adapter choose serialization.
    return payload;
  }
}
