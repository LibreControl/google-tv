import { describe, expect, it } from "vitest";
import { decodeRemoteMessage, encodeRemoteMessage, keyNameToCode } from "../src/codec/remote.js";
import { hex } from "../src/codec/wire.js";

describe("remote codec", () => {
  it("encodes deterministic key frames", () => {
    const encoded = encodeRemoteMessage({ type: "key", keyCode: 3, action: "press" });

    expect(hex(encoded)).toBe("520408031003");
    expect(decodeRemoteMessage(encoded)).toEqual({ type: "key", keyCode: 3, action: "press" });
  });

  it("normalizes key names", () => {
    expect(keyNameToCode("volume-up")).toBe(24);
    expect(keyNameToCode("playPause")).toBe(85);
  });

  it("round-trips text and voice", () => {
    expect(
      decodeRemoteMessage(
        encodeRemoteMessage({ type: "text", text: "hello", imeCounter: 7, fieldCounter: 8 }),
      ),
    ).toEqual({
      type: "text",
      text: "hello",
      imeCounter: 7,
      fieldCounter: 8,
    });

    expect(
      decodeRemoteMessage(
        encodeRemoteMessage({
          type: "voice",
          phase: "begin",
          sessionId: 9,
          packageName: "com.google.android.katniss",
        }),
      ),
    ).toEqual({
      type: "voice",
      phase: "begin",
      sessionId: 9,
      packageName: "com.google.android.katniss",
    });

    expect(
      decodeRemoteMessage(
        encodeRemoteMessage({
          type: "voice",
          phase: "payload",
          sessionId: 9,
          payload: Uint8Array.from([9, 8]),
        }),
      ),
    ).toEqual({ type: "voice", phase: "payload", sessionId: 9, payload: Uint8Array.from([9, 8]) });
  });
});
