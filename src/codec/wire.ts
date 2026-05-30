export type WireValue = {
  field: number;
  wireType: 0 | 2;
  value: bigint | Uint8Array;
};

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export function encodeVarint(value: number | bigint): Uint8Array {
  let next = BigInt(value);
  if (next < 0n) {
    throw new RangeError("varint cannot encode negative values");
  }

  const bytes: number[] = [];
  do {
    let byte = Number(next & 0x7fn);
    next >>= 7n;
    if (next !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (next !== 0n);

  return Uint8Array.from(bytes);
}

export function decodeVarint(input: Uint8Array, offset = 0): { value: bigint; offset: number } {
  let shift = 0n;
  let value = 0n;

  for (let index = offset; index < input.length; index += 1) {
    const byte = input[index]!;
    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, offset: index + 1 };
    }

    shift += 7n;
    if (shift > 63n) {
      throw new DecodeError("varint is too large");
    }
  }

  throw new DecodeError("truncated varint");
}

export function encodeString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function encodeMessage(values: WireValue[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const item of values) {
    chunks.push(encodeVarint((item.field << 3) | item.wireType));
    if (item.wireType === 0) {
      chunks.push(encodeVarint(item.value as bigint));
    } else {
      const bytes = item.value as Uint8Array;
      chunks.push(encodeVarint(bytes.length), bytes);
    }
  }
  return concatBytes(chunks);
}

export function decodeMessage(input: Uint8Array): WireValue[] {
  const values: WireValue[] = [];
  let offset = 0;

  while (offset < input.length) {
    const tag = decodeVarint(input, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);

    if (field <= 0) {
      throw new DecodeError("invalid protobuf field number");
    }

    if (wireType === 0) {
      const decoded = decodeVarint(input, offset);
      offset = decoded.offset;
      values.push({ field, wireType, value: decoded.value });
    } else if (wireType === 2) {
      const length = decodeVarint(input, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > input.length) {
        throw new DecodeError("truncated length-delimited field");
      }
      values.push({ field, wireType, value: input.slice(offset, end) });
      offset = end;
    } else {
      throw new DecodeError(`unsupported wire type ${wireType}`);
    }
  }

  return values;
}

export function fieldString(field: number, value: string): WireValue {
  return { field, wireType: 2, value: encodeString(value) };
}

export function fieldBytes(field: number, value: Uint8Array): WireValue {
  return { field, wireType: 2, value };
}

export function fieldVarint(field: number, value: number | bigint): WireValue {
  return { field, wireType: 0, value: BigInt(value) };
}

export function firstField(values: WireValue[], field: number): WireValue | undefined {
  return values.find((value) => value.field === field);
}

export function requireString(values: WireValue[], field: number): string {
  const value = firstField(values, field);
  if (!value || value.wireType !== 2) {
    throw new DecodeError(`missing string field ${field}`);
  }
  return decodeString(value.value as Uint8Array);
}

export function optionalString(values: WireValue[], field: number): string | undefined {
  const value = firstField(values, field);
  return value?.wireType === 2 ? decodeString(value.value as Uint8Array) : undefined;
}

export function optionalNumber(values: WireValue[], field: number): number | undefined {
  const value = firstField(values, field);
  return value?.wireType === 0 ? Number(value.value as bigint) : undefined;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replaceAll(/\s/g, ""), "hex"));
}
