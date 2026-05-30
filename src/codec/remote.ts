import {
  DecodeError,
  decodeMessage,
  decodeString,
  encodeMessage,
  fieldBytes,
  fieldString,
  fieldVarint,
  firstField,
  optionalNumber,
  optionalString,
  type WireValue,
} from "./wire.js";

export const RemoteKeyCodes = {
  home: 3,
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  select: 23,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  playPause: 85,
  assistant: 84,
  search: 84,
} as const;

export const RemoteFeatures = {
  ping: 1 << 0,
  key: 1 << 1,
  ime: 1 << 2,
  voice: 1 << 3,
  power: 1 << 5,
  volume: 1 << 6,
  appLink: 1 << 9,
} as const;

export const DefaultRemoteFeatures =
  RemoteFeatures.ping |
  RemoteFeatures.key |
  RemoteFeatures.ime |
  RemoteFeatures.voice |
  RemoteFeatures.power |
  RemoteFeatures.volume |
  RemoteFeatures.appLink;

export type RemoteKeyName = keyof typeof RemoteKeyCodes;
export type KeyAction = "down" | "up" | "press";

export type RemoteConfigureMessage = {
  type: "configure";
  features: number;
  deviceModel?: string;
  vendor?: string;
  appVersion?: string;
};

export type RemoteSetActiveMessage = {
  type: "set-active";
  active: number;
};

export type RemoteReadyMessage = {
  type: "ready";
  started: boolean;
};

export type RemoteKeyMessage = {
  type: "key";
  keyCode: number;
  action: KeyAction;
};

export type RemoteTextMessage = {
  type: "text";
  text: string;
  imeCounter: number;
  fieldCounter: number;
};

export type RemotePingMessage = {
  type: "ping";
  sequence: number;
};

export type RemoteVoiceMessage = {
  type: "voice";
  phase: "begin" | "payload" | "end";
  sessionId: number;
  packageName?: string;
  payload?: Uint8Array;
};

export type RemoteUnknownMessage = {
  type: "unknown";
  field: number;
  fields: WireValue[];
};

export type RemoteMessage =
  | RemoteConfigureMessage
  | RemoteSetActiveMessage
  | RemoteReadyMessage
  | RemoteKeyMessage
  | RemoteTextMessage
  | RemotePingMessage
  | RemoteVoiceMessage
  | RemoteUnknownMessage;

const directionToWire = {
  down: 1,
  up: 2,
  press: 3,
} as const;

const directionFromWire = new Map<number, KeyAction>(
  Object.entries(directionToWire).map(([key, value]) => [value, key as KeyAction]),
);

export function encodeRemoteMessage(message: RemoteMessage): Uint8Array {
  if (message.type === "configure") {
    return encodeMessage([fieldBytes(1, encodeRemoteConfigure(message.features))]);
  }

  if (message.type === "set-active") {
    return encodeMessage([fieldBytes(2, encodeMessage([fieldVarint(1, message.active)]))]);
  }

  if (message.type === "key") {
    return encodeMessage([
      fieldBytes(
        10,
        encodeMessage([
          fieldVarint(1, message.keyCode),
          fieldVarint(2, directionToWire[message.action]),
        ]),
      ),
    ]);
  }

  if (message.type === "text") {
    const position = Math.max(0, message.text.length - 1);
    return encodeMessage([
      fieldBytes(
        21,
        encodeMessage([
          fieldVarint(1, message.imeCounter),
          fieldVarint(2, message.fieldCounter),
          fieldBytes(
            3,
            encodeMessage([
              fieldVarint(1, 1),
              fieldBytes(
                2,
                encodeMessage([
                  fieldVarint(1, position),
                  fieldVarint(2, position),
                  fieldString(3, message.text),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ]);
  }

  if (message.type === "ping") {
    return encodeMessage([fieldBytes(9, encodeMessage([fieldVarint(1, message.sequence)]))]);
  }

  if (message.type === "voice") {
    const field = message.phase === "begin" ? 30 : message.phase === "payload" ? 31 : 32;
    const fields = [fieldVarint(1, message.sessionId)];
    if (message.phase === "begin" && message.packageName) {
      fields.push(fieldString(2, message.packageName));
    }
    if (message.phase === "payload" && message.payload) {
      fields.push(fieldBytes(2, message.payload));
    }
    return encodeMessage([fieldBytes(field, encodeMessage(fields))]);
  }

  if (message.type === "ready") {
    return encodeMessage([
      fieldBytes(40, encodeMessage([fieldVarint(1, message.started ? 1 : 0)])),
    ]);
  }

  throw new DecodeError(`cannot encode remote message ${message.type}`);
}

export function decodeRemoteMessage(input: Uint8Array): RemoteMessage {
  const fields = decodeMessage(input);
  const field = fields[0];
  if (!field || field.wireType !== 2) {
    throw new DecodeError("missing remote message payload");
  }
  const nested = decodeMessage(field.value as Uint8Array);

  if (field.field === 1) {
    const deviceInfo = optionalNested(nested, 2) ?? [];
    return {
      type: "configure",
      features: optionalNumber(nested, 1) ?? 0,
      deviceModel: optionalString(deviceInfo, 1),
      vendor: optionalString(deviceInfo, 2),
      appVersion: optionalString(deviceInfo, 6),
    };
  }

  if (field.field === 2) {
    return { type: "set-active", active: optionalNumber(nested, 1) ?? 0 };
  }

  if (field.field === 8) {
    return { type: "ping", sequence: optionalNumber(nested, 1) ?? 0 };
  }

  if (field.field === 9) {
    return { type: "ping", sequence: optionalNumber(nested, 1) ?? 0 };
  }

  if (field.field === 10) {
    const action = directionFromWire.get(optionalNumber(nested, 2) ?? 0);
    if (!action) {
      throw new DecodeError("missing key action");
    }
    return { type: "key", keyCode: optionalNumber(nested, 1) ?? 0, action };
  }

  if (field.field === 20) {
    const appInfo = optionalNested(nested, 1) ?? [];
    const textStatus = optionalNested(nested, 2) ?? [];
    return {
      type: "unknown",
      field: field.field,
      fields: [
        ...fields,
        fieldString(1000, optionalString(appInfo, 12) ?? ""),
        fieldString(1001, optionalString(textStatus, 2) ?? ""),
      ],
    };
  }

  if (field.field === 21) {
    return {
      type: "text",
      text: decodeBatchEditText(nested),
      imeCounter: optionalNumber(nested, 1) ?? 0,
      fieldCounter: optionalNumber(nested, 2) ?? 0,
    };
  }

  if (field.field === 30) {
    return {
      type: "voice",
      phase: "begin",
      sessionId: optionalNumber(nested, 1) ?? 0,
      packageName: optionalString(nested, 2),
    };
  }

  if (field.field === 31) {
    return {
      type: "voice",
      phase: "payload",
      sessionId: optionalNumber(nested, 1) ?? 0,
      payload: firstField(nested, 2)?.value as Uint8Array | undefined,
    };
  }

  if (field.field === 32) {
    return {
      type: "voice",
      phase: "end",
      sessionId: optionalNumber(nested, 1) ?? 0,
    };
  }

  if (field.field === 40) {
    return { type: "ready", started: Boolean(optionalNumber(nested, 1)) };
  }

  return { type: "unknown", field: field.field, fields };
}

export function keyNameToCode(name: string): number {
  const normalized = name.replaceAll("-", "").toLowerCase();
  const entry = Object.entries(RemoteKeyCodes).find(([key]) => key.toLowerCase() === normalized);
  if (!entry) {
    throw new RangeError(`unsupported key ${name}`);
  }
  return entry[1];
}

function encodeRemoteConfigure(features: number): Uint8Array {
  return encodeMessage([
    fieldVarint(1, features),
    fieldBytes(
      2,
      encodeMessage([
        fieldString(1, "node"),
        fieldString(2, "librecontrol"),
        fieldVarint(3, 1),
        fieldString(4, "1"),
        fieldString(5, "atvremote"),
        fieldString(6, "1.0.0"),
      ]),
    ),
  ]);
}

function optionalNested(fields: WireValue[], field: number): WireValue[] | undefined {
  const value = firstField(fields, field);
  if (!value || value.wireType !== 2) return undefined;
  return decodeMessage(value.value as Uint8Array);
}

function decodeBatchEditText(fields: WireValue[]): string {
  const editInfo = optionalNested(fields, 3);
  const object = editInfo ? optionalNested(editInfo, 2) : undefined;
  const value = object ? firstField(object, 3) : undefined;
  return value?.wireType === 2 ? decodeString(value.value as Uint8Array) : "";
}
