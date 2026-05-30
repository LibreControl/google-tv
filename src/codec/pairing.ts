import { createHash, createPublicKey } from "node:crypto";
import type tls from "node:tls";
import {
  DecodeError,
  decodeMessage,
  encodeMessage,
  fieldBytes,
  fieldString,
  fieldVarint,
  firstField,
  fromHex,
  hex,
  optionalNumber,
  optionalString,
  type WireValue,
} from "./wire.js";

export type PairingMessage =
  | { type: "request"; serviceName: string; clientName: string; status: PairingStatus }
  | { type: "request-ack"; serverName?: string; status: PairingStatus }
  | { type: "options"; status: PairingStatus }
  | { type: "configuration"; status: PairingStatus }
  | { type: "configuration-ack"; status: PairingStatus }
  | { type: "secret"; secret: Uint8Array; status: PairingStatus }
  | { type: "secret-ack"; secret?: Uint8Array; status: PairingStatus }
  | { type: "unknown"; status: PairingStatus; fields: WireValue[] };

export type PairingStatus = "ok" | "bad-configuration" | "bad-secret" | "error" | "unknown";

const STATUS_OK = 200;
const STATUS_ERROR = 400;
const STATUS_BAD_CONFIGURATION = 401;
const STATUS_BAD_SECRET = 402;
const PROTOCOL_VERSION = 2;
const ROLE_TYPE_INPUT = 1;
const ENCODING_TYPE_HEXADECIMAL = 3;
const SYMBOL_LENGTH = 6;

const FIELD_PROTOCOL_VERSION = 1;
const FIELD_STATUS = 2;
const FIELD_PAIRING_REQUEST = 10;
const FIELD_PAIRING_REQUEST_ACK = 11;
const FIELD_PAIRING_OPTION = 20;
const FIELD_PAIRING_CONFIGURATION = 30;
const FIELD_PAIRING_CONFIGURATION_ACK = 31;
const FIELD_PAIRING_SECRET = 40;
const FIELD_PAIRING_SECRET_ACK = 41;

export function encodePairingMessage(message: PairingMessage): Uint8Array {
  const fields = [
    fieldVarint(FIELD_PROTOCOL_VERSION, PROTOCOL_VERSION),
    fieldVarint(FIELD_STATUS, statusNumber(message.status)),
  ];

  if (message.type === "request") {
    fields.push(
      fieldBytes(
        FIELD_PAIRING_REQUEST,
        encodeMessage([fieldString(1, message.serviceName), fieldString(2, message.clientName)]),
      ),
    );
  } else if (message.type === "options") {
    fields.push(fieldBytes(FIELD_PAIRING_OPTION, encodePairingOptions()));
  } else if (message.type === "configuration") {
    fields.push(fieldBytes(FIELD_PAIRING_CONFIGURATION, encodePairingConfiguration()));
  } else if (message.type === "secret") {
    fields.push(fieldBytes(FIELD_PAIRING_SECRET, encodeMessage([fieldBytes(1, message.secret)])));
  } else if (message.type === "configuration-ack") {
    fields.push(fieldBytes(FIELD_PAIRING_CONFIGURATION_ACK, new Uint8Array(0)));
  } else if (message.type === "request-ack") {
    fields.push(
      fieldBytes(
        FIELD_PAIRING_REQUEST_ACK,
        message.serverName
          ? encodeMessage([fieldString(1, message.serverName)])
          : new Uint8Array(0),
      ),
    );
  } else if (message.type === "secret-ack") {
    fields.push(
      fieldBytes(
        FIELD_PAIRING_SECRET_ACK,
        message.secret ? encodeMessage([fieldBytes(1, message.secret)]) : new Uint8Array(0),
      ),
    );
  }

  return encodeMessage(fields);
}

export function decodePairingMessage(input: Uint8Array): PairingMessage {
  const fields = decodeMessage(input);
  const status = normalizeStatus(optionalNumber(fields, FIELD_STATUS));

  const requestAck = optionalNested(fields, FIELD_PAIRING_REQUEST_ACK);
  if (requestAck) {
    return {
      type: "request-ack",
      serverName: optionalString(requestAck, 1),
      status,
    };
  }

  if (optionalNested(fields, FIELD_PAIRING_OPTION)) {
    return { type: "options", status };
  }

  if (optionalNested(fields, FIELD_PAIRING_CONFIGURATION_ACK)) {
    return { type: "configuration-ack", status };
  }

  const secretAck = optionalNested(fields, FIELD_PAIRING_SECRET_ACK);
  if (secretAck) {
    return {
      type: "secret-ack",
      secret: firstField(secretAck, 1)?.value as Uint8Array | undefined,
      status,
    };
  }

  const request = optionalNested(fields, FIELD_PAIRING_REQUEST);
  if (request) {
    return {
      type: "request",
      serviceName: optionalString(request, 1) ?? "",
      clientName: optionalString(request, 2) ?? "",
      status,
    };
  }

  if (optionalNested(fields, FIELD_PAIRING_CONFIGURATION)) {
    return { type: "configuration", status };
  }

  const secret = optionalNested(fields, FIELD_PAIRING_SECRET);
  if (secret) {
    return {
      type: "secret",
      secret: firstField(secret, 1)?.value as Uint8Array,
      status,
    };
  }

  return { type: "unknown", status, fields };
}

export function derivePairingSecret(
  code: string,
  certificatesOrNonce: PairingCertificates | Uint8Array,
  publicKey?: Uint8Array,
): Uint8Array {
  if (certificatesOrNonce instanceof Uint8Array) {
    return createHash("sha256")
      .update(code.trim().toUpperCase())
      .update(Buffer.from(certificatesOrNonce))
      .update(Buffer.from(publicKey ?? new Uint8Array(0)))
      .digest();
  }

  const normalized = code.trim().replaceAll(/\s/g, "").toUpperCase();
  const codeBytes = fromHex(normalized);
  const hash = createHash("sha256")
    .update(fromHex(certificatesOrNonce.local.modulus))
    .update(fromHex(padExponent(certificatesOrNonce.local.exponent)))
    .update(fromHex(certificatesOrNonce.peer.modulus))
    .update(fromHex(padExponent(certificatesOrNonce.peer.exponent)))
    .update(fromHex(normalized.slice(2)))
    .digest();

  if (hash[0] !== codeBytes[0]) {
    throw new DecodeError("pairing code failed local certificate hash validation");
  }

  return hash;
}

export type PairingCertificates = {
  local: RsaCertificateParts;
  peer: RsaCertificateParts;
};

export type RsaCertificateParts = {
  modulus: string;
  exponent: string;
};

export function extractPairingCertificates(
  localCertPem: string | Buffer,
  tlsCertificates?: { local?: tls.PeerCertificate; peer?: tls.PeerCertificate },
): PairingCertificates {
  const local =
    certificatePartsFromPeer(tlsCertificates?.local) ?? certificatePartsFromPem(localCertPem);
  const peer = certificatePartsFromPeer(tlsCertificates?.peer);
  if (!peer) {
    throw new DecodeError("missing TV certificate details from TLS connection");
  }
  return { local, peer };
}

function encodePairingOptions(): Uint8Array {
  return encodeMessage([fieldBytes(1, encodePairingEncoding()), fieldVarint(3, ROLE_TYPE_INPUT)]);
}

function encodePairingConfiguration(): Uint8Array {
  return encodeMessage([fieldBytes(1, encodePairingEncoding()), fieldVarint(2, ROLE_TYPE_INPUT)]);
}

function encodePairingEncoding(): Uint8Array {
  return encodeMessage([fieldVarint(1, ENCODING_TYPE_HEXADECIMAL), fieldVarint(2, SYMBOL_LENGTH)]);
}

function optionalNested(fields: WireValue[], field: number): WireValue[] | undefined {
  const value = firstField(fields, field);
  if (!value || value.wireType !== 2) return undefined;
  return decodeMessage(value.value as Uint8Array);
}

function normalizeStatus(status?: number): PairingStatus {
  if (status === STATUS_OK) return "ok";
  if (status === STATUS_BAD_CONFIGURATION) return "bad-configuration";
  if (status === STATUS_BAD_SECRET) return "bad-secret";
  if (status === STATUS_ERROR) return "error";
  return "unknown";
}

function statusNumber(status: PairingStatus): number {
  if (status === "ok") return STATUS_OK;
  if (status === "bad-configuration") return STATUS_BAD_CONFIGURATION;
  if (status === "bad-secret") return STATUS_BAD_SECRET;
  if (status === "error") return STATUS_ERROR;
  return 0;
}

function certificatePartsFromPeer(cert?: tls.PeerCertificate): RsaCertificateParts | undefined {
  if (!cert?.modulus || !cert.exponent) return undefined;
  return {
    modulus: cert.modulus,
    exponent: cert.exponent.replace(/^0x/i, ""),
  };
}

function certificatePartsFromPem(cert: string | Buffer): RsaCertificateParts {
  const key = createPublicKey(cert);
  const jwk = key.export({ format: "jwk" }) as JsonWebKey;
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    throw new DecodeError("pairing requires an RSA client certificate");
  }
  return {
    modulus: hex(Buffer.from(jwk.n, "base64url")),
    exponent: hex(Buffer.from(jwk.e, "base64url")),
  };
}

function padExponent(value: string): string {
  return value.length % 2 === 0 ? value : `0${value}`;
}
