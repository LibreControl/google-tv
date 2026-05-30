import { describe, expect, it } from "vitest";
import { FrameParser, encodeFrame } from "../src/transport/framing.js";

describe("FrameParser", () => {
  it("parses split frames", () => {
    const parser = new FrameParser();
    const frame = encodeFrame(Uint8Array.from([1, 2, 3]));

    expect(parser.push(frame.slice(0, 2))).toEqual([]);
    expect(parser.push(frame.slice(2))).toEqual([Uint8Array.from([1, 2, 3])]);
  });

  it("parses multiple frames in one chunk", () => {
    const parser = new FrameParser();
    const chunk = Uint8Array.from([
      ...encodeFrame(Uint8Array.from([1])),
      ...encodeFrame(Uint8Array.from([2])),
    ]);

    expect(parser.push(chunk)).toEqual([Uint8Array.from([1]), Uint8Array.from([2])]);
  });
});
