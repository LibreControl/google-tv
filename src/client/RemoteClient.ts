import { EventEmitter } from "node:events";
import {
  RemoteKeyName,
  RemoteMessage,
  DefaultRemoteFeatures,
  RemoteFeatures,
  decodeRemoteMessage,
  encodeRemoteMessage,
  keyNameToCode,
} from "../codec/remote.js";
import { FrameTransport, NodeTlsTransport, TlsTransportOptions } from "../transport/tls.js";

export type RemoteClientOptions =
  | ({ transport: FrameTransport } & Partial<TlsTransportOptions>)
  | TlsTransportOptions;

export type VoiceSession = {
  sessionId: number;
  packageName?: string;
};

const VoiceChunkSize = 20 * 1024;
const VoiceChunkMinSize = 8 * 1024;

export class RemoteClient extends EventEmitter {
  private readonly transport: FrameTransport;
  private activeFeatures = DefaultRemoteFeatures;
  private imeCounter = 0;
  private fieldCounter = 0;
  private voiceSession?: VoiceSession;
  readonly messages: RemoteMessage[] = [];

  constructor(options: RemoteClientOptions) {
    super();
    this.transport =
      "transport" in options
        ? options.transport
        : new NodeTlsTransport({ ...options, port: options.port ?? 6466 });
    this.transport.on("frame", (frame) => this.handleFrame(frame));
    this.transport.on("close", () => this.emit("close"));
    this.transport.on("error", (error) => this.emit("error", error));
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    await this.waitForReady();
  }

  async command(key: RemoteKeyName | string): Promise<void> {
    const keyCode = keyNameToCode(key);
    await this.send({ type: "key", keyCode, action: "press" });
  }

  async commandDownUp(key: RemoteKeyName | string, delayMs = 80): Promise<void> {
    await this.keyDown(key);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await this.keyUp(key);
  }

  async keyDown(key: RemoteKeyName | string): Promise<void> {
    await this.send({ type: "key", keyCode: keyNameToCode(key), action: "down" });
  }

  async keyUp(key: RemoteKeyName | string): Promise<void> {
    await this.send({ type: "key", keyCode: keyNameToCode(key), action: "up" });
  }

  async text(text: string): Promise<void> {
    await this.send({
      type: "text",
      text,
      imeCounter: this.imeCounter,
      fieldCounter: this.fieldCounter,
    });
  }

  async voiceBegin(timeoutMs = 5_000): Promise<VoiceSession> {
    const nextSession = this.waitForVoiceBegin(timeoutMs);
    await this.commandDownUp("assistant");
    const session = await nextSession;
    await this.send({ type: "voice", phase: "begin", sessionId: session.sessionId });
    return session;
  }

  async voicePayload(payload: Uint8Array): Promise<void> {
    const session = this.requireVoiceSession();
    await this.send({ type: "voice", phase: "payload", sessionId: session.sessionId, payload });
  }

  async voiceEnd(): Promise<void> {
    const session = this.requireVoiceSession();
    await this.send({ type: "voice", phase: "end", sessionId: session.sessionId });
    this.voiceSession = undefined;
  }

  async voiceStreamPcm(
    samples: Uint8Array,
    options: { chunkSize?: number; chunkDelayMs?: number } = {},
  ): Promise<void> {
    const chunkSize = options.chunkSize ?? VoiceChunkSize;
    const chunkDelayMs = options.chunkDelayMs ?? 20;
    for (let offset = 0; offset < samples.length; offset += chunkSize) {
      await this.voicePayload(padVoiceChunk(samples.slice(offset, offset + chunkSize)));
      if (chunkDelayMs > 0 && offset + chunkSize < samples.length) {
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
      }
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async send(message: RemoteMessage): Promise<void> {
    await this.transport.send(encodeRemoteMessage(message));
    this.emit("sent", message);
  }

  private handleFrame(frame: Uint8Array): void {
    const message = decodeRemoteMessage(frame);
    this.messages.push(message);
    this.emit("message", message);
    void this.handleProtocolMessage(message);
  }

  private async handleProtocolMessage(message: RemoteMessage): Promise<void> {
    if (message.type === "configure") {
      this.activeFeatures = message.features & DefaultRemoteFeatures;
      await this.send({ type: "configure", features: this.activeFeatures });
      if ((this.activeFeatures & RemoteFeatures.key) === 0) {
        this.emit("error", new Error("TV remote service did not advertise key support"));
      }
    } else if (message.type === "set-active") {
      await this.send({ type: "set-active", active: this.activeFeatures });
    } else if (message.type === "ping") {
      await this.send({ type: "ping", sequence: message.sequence });
    } else if (message.type === "text") {
      this.imeCounter = message.imeCounter;
      this.fieldCounter = message.fieldCounter;
    } else if (message.type === "voice" && message.phase === "begin") {
      this.voiceSession = { sessionId: message.sessionId, packageName: message.packageName };
    }
  }

  private requireVoiceSession(): VoiceSession {
    if (!this.voiceSession) {
      throw new Error("voice session has not started; run voiceBegin first");
    }
    return this.voiceSession;
  }

  private async waitForVoiceBegin(timeoutMs: number): Promise<VoiceSession> {
    if (this.voiceSession) return this.voiceSession;
    return await new Promise<VoiceSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for Android TV voice session"));
      }, timeoutMs);
      const onMessage = (message: RemoteMessage) => {
        if (message.type === "voice" && message.phase === "begin") {
          const session = { sessionId: message.sessionId, packageName: message.packageName };
          cleanup();
          resolve(session);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("remote connection closed before Android TV voice session started"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("close", onClose);
        this.off("error", onError);
      };
      this.on("message", onMessage);
      this.on("close", onClose);
      this.on("error", onError);
    });
  }

  private async waitForReady(timeoutMs = 5_000): Promise<void> {
    if (this.messages.some((message) => message.type === "ready")) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for Android TV remote service start"));
      }, timeoutMs);
      const onMessage = (message: RemoteMessage) => {
        if (message.type === "ready") {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("remote connection closed before Android TV service start"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("close", onClose);
        this.off("error", onError);
      };
      this.on("message", onMessage);
      this.on("close", onClose);
      this.on("error", onError);
    });
  }
}

function padVoiceChunk(chunk: Uint8Array): Uint8Array {
  if (chunk.length >= VoiceChunkMinSize) return chunk;
  const padded = new Uint8Array(VoiceChunkMinSize);
  padded.set(chunk);
  return padded;
}
