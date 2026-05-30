import dgram from "node:dgram";
import os from "node:os";

export type GoogleTvDiscoveryResult = {
  name: string;
  host: string;
  port?: number;
  serviceName: string;
  addresses: string[];
  txt: Record<string, string | true>;
};

export type DiscoverGoogleTvOptions = {
  timeoutMs?: number;
  services?: string[];
};

type MdnsRecord = {
  name: string;
  type: number;
  classCode: number;
  ttl: number;
  data: string | { priority: number; weight: number; port: number; target: string } | Buffer;
};

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const CLASS_UNICAST_RESPONSE = 0x8000;

const defaultServices = ["_androidtvremote2._tcp.local", "_androidtvremote._tcp.local"];

export async function discoverGoogleTv(
  options: DiscoverGoogleTvOptions = {},
): Promise<GoogleTvDiscoveryResult[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const services = options.services ?? defaultServices;
  const interfaces = localNetworkAddresses();
  const records = (
    await Promise.all(
      (interfaces.length > 0 ? interfaces : [undefined]).map((networkInterface) =>
        discoverOnInterface(services, timeoutMs, networkInterface),
      ),
    )
  ).flat();

  return buildResults(records, services);
}

async function discoverOnInterface(
  services: string[],
  timeoutMs: number,
  networkInterface?: string,
): Promise<MdnsRecord[]> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const records: MdnsRecord[] = [];

  try {
    await bindSocket(socket, networkInterface);
  } catch {
    socket.close();
    return records;
  }

  try {
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
    if (networkInterface) socket.setMulticastInterface(networkInterface);
  } catch {
    // Some environments restrict multicast socket options.
  }

  tryAddMembership(socket, networkInterface);
  socket.on("message", (message) => {
    records.push(...parseResponse(message));
  });

  for (const service of services) {
    await sendUdp(socket, createPtrQuery(service, { requestUnicastResponse: true }));
  }

  await delay(timeoutMs);
  socket.close();
  return records;
}

function bindSocket(socket: dgram.Socket, networkInterface?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      socket.off("error", onError);
      resolve();
    };

    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ address: networkInterface, port: 0 });
  });
}

function tryAddMembership(socket: dgram.Socket, networkInterface?: string): void {
  try {
    socket.addMembership(MDNS_ADDRESS, networkInterface);
  } catch {
    // Binding can succeed even when membership fails on some interfaces.
  }
}

function sendUdp(socket: dgram.Socket, message: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(message, MDNS_PORT, MDNS_ADDRESS, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function buildResults(records: MdnsRecord[], services: string[]): GoogleTvDiscoveryResult[] {
  const serviceSet = new Set(services.map(normalizeName));
  const ptrTargets = records
    .filter((record) => record.type === TYPE_PTR && serviceSet.has(normalizeName(record.name)))
    .map((record) => String(record.data));

  const results = new Map<string, GoogleTvDiscoveryResult>();

  for (const serviceName of ptrTargets) {
    const srv = records.find(
      (record) =>
        record.type === TYPE_SRV && normalizeName(record.name) === normalizeName(serviceName),
    );
    const srvData =
      srv?.data && typeof srv.data === "object" && !Buffer.isBuffer(srv.data)
        ? srv.data
        : undefined;
    const target = srvData?.target ?? serviceName;
    const addresses = records
      .filter(
        (record) =>
          (record.type === TYPE_A || record.type === TYPE_AAAA) &&
          normalizeName(record.name) === normalizeName(target) &&
          typeof record.data === "string",
      )
      .map((record) => String(record.data));

    const host = addresses[0] ?? target.replace(/\.$/, "");
    const txt = parseTxt(
      records.find(
        (record) =>
          record.type === TYPE_TXT && normalizeName(record.name) === normalizeName(serviceName),
      )?.data,
    );
    results.set(normalizeName(serviceName), {
      name: humanName(serviceName, txt),
      host,
      port: srvData?.port,
      serviceName,
      addresses,
      txt,
    });
  }

  return [...results.values()];
}

function createPtrQuery(name: string, options: { requestUnicastResponse?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(1, 4);
  parts.push(header, encodeDnsName(name));

  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_PTR, 0);
  question.writeUInt16BE(
    options.requestUnicastResponse ? CLASS_IN | CLASS_UNICAST_RESPONSE : CLASS_IN,
    2,
  );
  parts.push(question);

  return Buffer.concat(parts);
}

function parseResponse(message: Buffer): MdnsRecord[] {
  if (message.length < 12) return [];
  const questionCount = message.readUInt16BE(4);
  const answerCount = message.readUInt16BE(6);
  const authorityCount = message.readUInt16BE(8);
  const additionalCount = message.readUInt16BE(10);
  let offset = 12;

  for (let index = 0; index < questionCount; index += 1) {
    const skipped = readDnsName(message, offset);
    offset = skipped.offset + 4;
  }

  const records: MdnsRecord[] = [];
  const recordCount = answerCount + authorityCount + additionalCount;
  for (let index = 0; index < recordCount && offset < message.length; index += 1) {
    const parsed = readRecord(message, offset);
    if (!parsed) break;
    records.push(parsed.record);
    offset = parsed.offset;
  }
  return records;
}

function readRecord(
  message: Buffer,
  startOffset: number,
): { record: MdnsRecord; offset: number } | undefined {
  const name = readDnsName(message, startOffset);
  let offset = name.offset;
  if (offset + 10 > message.length) return undefined;

  const type = message.readUInt16BE(offset);
  const classCode = message.readUInt16BE(offset + 2);
  const ttl = message.readUInt32BE(offset + 4);
  const dataLength = message.readUInt16BE(offset + 8);
  offset += 10;
  const dataOffset = offset;
  offset += dataLength;
  if (offset > message.length) return undefined;

  let data: MdnsRecord["data"] = message.subarray(dataOffset, offset);
  if (type === TYPE_PTR) {
    data = readDnsName(message, dataOffset).name;
  } else if (type === TYPE_SRV && dataLength >= 6) {
    data = {
      priority: message.readUInt16BE(dataOffset),
      weight: message.readUInt16BE(dataOffset + 2),
      port: message.readUInt16BE(dataOffset + 4),
      target: readDnsName(message, dataOffset + 6).name,
    };
  } else if (type === TYPE_A && dataLength === 4) {
    data = [...message.subarray(dataOffset, offset)].join(".");
  } else if (type === TYPE_AAAA && dataLength === 16) {
    data = formatIpv6(message.subarray(dataOffset, offset));
  }

  return {
    record: {
      name: name.name,
      type,
      classCode,
      ttl,
      data,
    },
    offset,
  };
}

function readDnsName(message: Buffer, startOffset: number): { name: string; offset: number } {
  const labels: string[] = [];
  let offset = startOffset;
  let jumped = false;
  let nextOffset = startOffset;

  for (let depth = 0; depth < 32; depth += 1) {
    const length = message[offset];
    if (length === undefined) break;

    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (message[offset + 1] ?? 0);
      if (!jumped) nextOffset = offset + 2;
      offset = pointer;
      jumped = true;
      continue;
    }

    offset += 1;
    if (length === 0) {
      if (!jumped) nextOffset = offset;
      break;
    }

    labels.push(message.subarray(offset, offset + length).toString("utf8"));
    offset += length;
    if (!jumped) nextOffset = offset;
  }

  return { name: `${labels.join(".")}.`, offset: nextOffset };
}

function encodeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".");
  return Buffer.concat([
    ...labels.map((label) =>
      Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)]),
    ),
    Buffer.from([0]),
  ]);
}

function parseTxt(data: MdnsRecord["data"] | undefined): Record<string, string | true> {
  if (!Buffer.isBuffer(data)) return {};
  const values: Record<string, string | true> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset] ?? 0;
    offset += 1;
    const value = data.subarray(offset, offset + length).toString("utf8");
    offset += length;
    const equals = value.indexOf("=");
    if (equals === -1) values[value] = true;
    else values[value.slice(0, equals)] = value.slice(equals + 1);
  }
  return values;
}

function humanName(serviceName: string, txt: Record<string, string | true>): string {
  const model = typeof txt.md === "string" ? txt.md : undefined;
  const name = serviceName.split("._androidtvremote")[0]?.replace(/\\032/g, " ");
  return model ?? name ?? "Google TV";
}

function formatIpv6(bytes: Buffer): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 2) {
    parts.push(bytes.readUInt16BE(index).toString(16));
  }
  return parts.join(":");
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function localNetworkAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address): address is os.NetworkInterfaceInfo => Boolean(address))
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}
