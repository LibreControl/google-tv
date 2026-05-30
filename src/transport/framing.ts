import { concatBytes, decodeVarint, encodeVarint } from "../codec/wire.js";

export class FrameParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concatBytes([this.buffer, chunk]);
    const frames: Uint8Array[] = [];

    while (this.buffer.length > 0) {
      let length: number;
      let bodyOffset: number;
      try {
        const decoded = decodeVarint(this.buffer);
        length = Number(decoded.value);
        bodyOffset = decoded.offset;
      } catch {
        return frames;
      }

      const end = bodyOffset + length;
      if (this.buffer.length < end) {
        return frames;
      }

      frames.push(this.buffer.slice(bodyOffset, end));
      this.buffer = this.buffer.slice(end);
    }

    return frames;
  }
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  return concatBytes([encodeVarint(payload.length), payload]);
}
