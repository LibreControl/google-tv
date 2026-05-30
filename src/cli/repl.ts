#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PairingClient } from "../client/PairingClient.js";
import { RemoteClient } from "../client/RemoteClient.js";
import type { CertificateBundle } from "../certificates/index.js";
import { RemoteKeyCodes, type RemoteKeyName } from "../codec/remote.js";
import { discoverGoogleTv, localNetworkAddresses } from "../discovery/mdns.js";
import { loadState, saveState, type CliDevice } from "./state.js";

type Session = {
  selected?: CliDevice;
  pairing?: PairingClient;
  remote?: RemoteClient;
  voiceActive: boolean;
  capture: boolean;
};

const keyAliases = new Set(Object.keys(RemoteKeyCodes));

async function main(): Promise<void> {
  const state = await loadState();
  const session: Session = { voiceActive: false, capture: false };
  const rl = readline.createInterface({ input, output, prompt: "google-tv> " });
  let readlineClosed = false;
  rl.on("close", () => {
    readlineClosed = true;
  });

  printHelp();
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "/exit" || trimmed === "exit" || trimmed === "/quit" || trimmed === "quit") {
      rl.close();
      break;
    }
    try {
      if (trimmed) {
        await runCommand(trimmed, state.devices, state.certificate, session);
        await saveState(state);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    if (readlineClosed) break;
    rl.prompt();
  }
}

async function runCommand(
  line: string,
  devices: CliDevice[],
  certificate: CertificateBundle,
  session: Session,
): Promise<void> {
  const [command, ...args] = line.split(" ");
  let slash = command?.startsWith("/") ? command.slice(1) : command;
  let commandArgs = args;

  if (session.pairing && command && !command.startsWith("/") && /^[0-9a-fA-F]{6}$/.test(command)) {
    slash = "code";
    commandArgs = [command];
  }

  if (!slash) return;
  if (slash === "help") return printHelp();
  if (slash === "exit" || slash === "quit") process.exit(0);

  if (slash === "devices") {
    printDevices(devices);
    return;
  }

  if (slash === "scan") {
    console.log("scanning mDNS for Google TV remote services...");
    const found = await discoverGoogleTv();
    const added = mergeDiscoveredDevices(devices, found);
    if (found.length > 0) {
      console.log(`found ${found.length} device${found.length === 1 ? "" : "s"}; added ${added}`);
    } else {
      const networks = localNetworkAddresses();
      console.log(
        `no devices found on mDNS${
          networks.length > 0 ? ` from local interface(s): ${networks.join(", ")}` : ""
        }`,
      );
      console.log("if the TV is visible on screen, try /add <tv-ip> <name> and then /pair <id>");
    }
    printDevices(devices);
    return;
  }

  if (slash === "add") {
    const host = commandArgs[0];
    if (!host) throw new Error("usage: /add <host> [name]");
    const device = {
      id: nextId(devices),
      host,
      name: commandArgs.slice(1).join(" ") || `Google TV ${devices.length + 1}`,
      paired: false,
    };
    devices.push(device);
    console.log(`added [${device.id}] ${device.name} ${device.host}`);
    return;
  }

  if (slash === "status") {
    console.log({
      selected: session.selected,
      connected: Boolean(session.remote),
      pairing: Boolean(session.pairing),
      voiceActive: session.voiceActive,
      capture: session.capture,
    });
    return;
  }

  if (slash === "pair") {
    const device = requireDevice(devices, commandArgs[0]);
    session.selected = device;
    session.pairing = new PairingClient({
      host: device.host,
      port: 6467,
      cert: certificate.cert,
      key: certificate.key,
    });
    await session.pairing.start();
    console.log(`pairing with ${device.name}; check the TV for the 6-character code`);
    console.log("enter the code shown on TV with /code <code>");
    return;
  }

  if (slash === "code") {
    if (!session.pairing || !session.selected) throw new Error("start with /pair <id>");
    console.log("submitting pairing code...");
    const result = await session.pairing.submitCode(commandArgs.join(""));
    session.selected.paired = result.type === "secret-ack" && result.status === "ok";
    console.log(
      session.selected.paired
        ? `paired ${session.selected.name}`
        : `pairing failed: ${result.type === "secret-ack" ? result.status : result.type}`,
    );
    await session.pairing.close();
    session.pairing = undefined;
    return;
  }

  if (slash === "connect") {
    const device = requireDevice(devices, commandArgs[0]);
    session.selected = device;
    session.remote = new RemoteClient({
      host: device.host,
      port: 6466,
      cert: certificate.cert,
      key: certificate.key,
    });
    session.remote.on("sent", (message) => {
      if (session.capture) console.log("client>", message);
    });
    session.remote.on("message", (message) => {
      if (session.capture) console.log("tv>", message);
    });
    await session.remote.connect();
    console.log(`connected ${device.name}`);
    return;
  }

  if (slash === "disconnect") {
    await session.remote?.close();
    session.remote = undefined;
    console.log("disconnected");
    return;
  }

  if (slash === "reconnect") {
    if (!session.selected) throw new Error("no selected device");
    await session.remote?.close();
    session.remote = new RemoteClient({
      host: session.selected.host,
      port: 6466,
      cert: certificate.cert,
      key: certificate.key,
    });
    session.remote.on("sent", (message) => {
      if (session.capture) console.log("client>", message);
    });
    session.remote.on("message", (message) => {
      if (session.capture) console.log("tv>", message);
    });
    await session.remote.connect();
    console.log(`reconnected ${session.selected.name}`);
    return;
  }

  if (slash === "text") {
    await requireRemote(session).text(commandArgs.join(" "));
    console.log("sent text");
    return;
  }

  if (slash === "voice") {
    const action = commandArgs[0];
    if (action === "start") {
      const voice = await requireRemote(session).voiceBegin();
      session.voiceActive = true;
      console.log(
        `voice started session ${voice.sessionId}${voice.packageName ? ` (${voice.packageName})` : ""}`,
      );
    } else if (action === "stop") {
      await requireRemote(session).voiceEnd();
      session.voiceActive = false;
      console.log("voice stopped");
    } else if (action === "pcm") {
      const file = commandArgs[1];
      if (!file) throw new Error("usage: /voice pcm <pcm-file>");
      const samples = await readFile(file);
      await streamVoiceSamples(requireRemote(session), samples, session);
    } else if (action === "wav") {
      const file = commandArgs[1];
      if (!file) throw new Error("usage: /voice wav <wav-file>");
      const samples = extractWavPcm(await readFile(file));
      await streamVoiceSamples(requireRemote(session), samples, session);
    } else {
      throw new Error("usage: /voice start|stop|pcm <pcm-file>|wav <wav-file>");
    }
    return;
  }

  if (slash === "capture") {
    const action = commandArgs[0];
    session.capture = action === "start" ? true : action === "stop" ? false : session.capture;
    console.log(`capture ${session.capture ? "on" : "off"}`);
    return;
  }

  if (slash === "spam") {
    const [key = "", countRaw = "1", delayRaw = "0"] = commandArgs;
    await spam(requireRemote(session), key, Number(countRaw), Number(delayRaw));
    return;
  }

  if (slash === "sequence") {
    const [sequence = "", delayRaw = "100"] = commandArgs;
    for (const key of sequence.split(",").filter(Boolean)) {
      await requireRemote(session).commandDownUp(key);
      await delay(Number(delayRaw));
    }
    console.log(`sent sequence ${sequence}`);
    return;
  }

  if (slash === "tap") {
    const [key = "", delayRaw = "80"] = commandArgs;
    await requireRemote(session).commandDownUp(key, Number(delayRaw));
    console.log(`tapped ${key}`);
    return;
  }

  if (slash === "matrix") {
    for (const key of keyAliases) {
      await requireRemote(session).commandDownUp(key);
      await delay(50);
    }
    console.log(`sent ${keyAliases.size} commands`);
    return;
  }

  if (slash === "stress") {
    const count = Number(commandArgs[0] ?? "1000");
    const keys = [...keyAliases];
    for (let index = 0; index < count; index += 1) {
      await requireRemote(session).commandDownUp(keys[index % keys.length]!);
      await delay(25);
    }
    console.log(`stress complete: ${count} commands`);
    return;
  }

  if (keyAliases.has(slash)) {
    await requireRemote(session).commandDownUp(slash as RemoteKeyName);
    console.log(`sent ${slash}`);
    return;
  }

  throw new Error(`unknown command /${slash}; try /help`);
}

async function streamVoiceSamples(
  remote: RemoteClient,
  samples: Uint8Array,
  session: Session,
): Promise<void> {
  const voice = await remote.voiceBegin();
  session.voiceActive = true;
  console.log(`voice started session ${voice.sessionId}; streaming ${samples.length} bytes`);
  try {
    await remote.voiceStreamPcm(samples);
  } finally {
    await remote.voiceEnd();
    session.voiceActive = false;
  }
  console.log("voice streamed");
}

function extractWavPcm(wav: Uint8Array): Uint8Array {
  const input = Buffer.from(wav);
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("expected a WAV file");
  }

  let offset = 12;
  let validFormat = false;
  while (offset + 8 <= input.length) {
    const id = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > input.length) throw new Error(`invalid WAV ${id} chunk`);

    if (id === "fmt ") {
      const format = input.readUInt16LE(start);
      const channels = input.readUInt16LE(start + 2);
      const sampleRate = input.readUInt32LE(start + 4);
      const bitsPerSample = input.readUInt16LE(start + 14);
      validFormat = format === 1 && channels === 1 && sampleRate === 8000 && bitsPerSample === 16;
      if (!validFormat) {
        throw new Error("WAV must be PCM s16le, mono, 8000 Hz");
      }
    } else if (id === "data") {
      if (!validFormat) throw new Error("WAV data chunk appeared before a valid fmt chunk");
      return input.subarray(start, end);
    }

    offset = end + (size % 2);
  }

  throw new Error("WAV is missing a data chunk");
}

function printHelp(): void {
  console.log(`commands:
  /scan
  /devices
  /add <host> [name]
  /pair <id>
  /code <code>
  /connect <id>
  /home /back /up /down /left /right /select /playPause /volumeUp /volumeDown /power /assistant /search
  /text <value>
  /voice start|stop|pcm <pcm-file>|wav <wav-file>
  /tap <key> [holdMs]
  /spam <key> <count> <delayMs>
  /sequence <comma-separated-keys> <delayMs>
  /matrix
  /stress <count>
  /capture start|stop
  /status
  /disconnect | /reconnect
  /exit`);
}

function printDevices(devices: CliDevice[]): void {
  if (devices.length === 0) {
    console.log("no devices; use /add <host> [name] or set GOOGLE_TV_HOSTS=ip1,ip2");
    return;
  }
  for (const device of devices) {
    console.log(
      `[${device.id}] ${device.name}    ${device.host}    paired: ${device.paired ? "yes" : "no"}`,
    );
  }
}

function mergeDiscoveredDevices(
  devices: CliDevice[],
  found: Awaited<ReturnType<typeof discoverGoogleTv>>,
): number {
  let added = 0;
  for (const discovered of found) {
    const existing = devices.find(
      (device) =>
        device.host === discovered.host ||
        discovered.addresses.includes(device.host) ||
        device.name === discovered.name,
    );
    if (existing) {
      existing.host = discovered.host;
      existing.name = discovered.name || existing.name;
      continue;
    }
    devices.push({
      id: nextId(devices),
      host: discovered.host,
      name: discovered.name,
      paired: false,
    });
    added += 1;
  }
  return added;
}

function requireDevice(devices: CliDevice[], idRaw?: string): CliDevice {
  const id = Number(idRaw);
  const device = devices.find((candidate) => candidate.id === id);
  if (!device) throw new Error("unknown device id; run /scan");
  return device;
}

function requireRemote(session: Session): RemoteClient {
  if (!session.remote) throw new Error("not connected; run /connect <id>");
  return session.remote;
}

async function spam(
  remote: RemoteClient,
  key: string,
  count: number,
  delayMs: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await remote.commandDownUp(key);
    if (delayMs > 0) await delay(delayMs);
  }
  console.log(`sent ${key} ${count} times, ${delayMs}ms apart`);
}

function nextId(devices: CliDevice[]): number {
  return Math.max(0, ...devices.map((device) => device.id)) + 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
