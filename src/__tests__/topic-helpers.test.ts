import type { MqttMessage } from "../types";
import { buildTopicSetSignature, normalizeInboundTopic } from "../topic-helpers";

describe("topic helpers", () => {
  it("normalizes missing topics to an empty topic string", () => {
    expect(normalizeInboundTopic({ payload: "ready" })).toEqual({ ok: true, topic: "" });
  });

  it("rejects non-string topic values explicitly", () => {
    expect(
      normalizeInboundTopic({ topic: 42, payload: "ready" } as unknown as MqttMessage),
    ).toEqual({
      ok: false,
      error: "Inbound msg.topic must be a string when provided, got number.",
    });
  });

  it("builds a stable set signature independent from input order", () => {
    expect(buildTopicSetSignature(["b", "a", "c"])).toBe(buildTopicSetSignature(["c", "b", "a"]));
  });
});
