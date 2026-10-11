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
  private activeFeatures?: number;
  private imeMetadata?: { imeCounter: number; fieldCounter: number };
  private connectionGeneration = 0;
  private connected = false;
  private ready = false;
  private voiceSession?: VoiceSession;
  readonly messages: RemoteMessage[] = [];

  constructor(options: RemoteClientOptions) {
    super();
    this.transport =
      "transport" in options
        ? options.transport
        : new NodeTlsTransport({ ...options, port: options.port ?? 6466 });
    this.transport.on("frame", (frame) => this.handleFrame(frame));
    this.transport.on("close", () => {
      this.invalidateConnection(new Error("remote connection closed"));
      this.emit("close");
    });
    this.transport.on("error", (error) => {
      this.invalidateConnection(error);
      this.emit("error", error);
    });
  }

  async connect(): Promise<void> {
    if (this.connected && this.ready) return;
    this.invalidateConnection(new Error("remote connection replaced"));
    this.connected = true;
    const generation = this.connectionGeneration;
    try {
      await this.transport.connect();
      if (generation !== this.connectionGeneration || !this.connected) {
        throw new Error("remote connection closed before Android TV service start");
      }
      await this.waitForReady();
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.invalidateConnection(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
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
    const generation = this.connectionGeneration;
    await this.waitForImeMetadata();
    if (generation !== this.connectionGeneration || !this.connected || !this.imeMetadata) {
      throw new Error("remote connection changed before Android TV text input");
    }
    await this.send({ type: "text", text, ...this.imeMetadata });
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
    this.invalidateConnection(new Error("remote connection closed"));
    await this.transport.close();
  }

  private async send(message: RemoteMessage): Promise<void> {
    await this.transport.send(encodeRemoteMessage(message));
    this.emit("sent", message);
  }

  private handleFrame(frame: Uint8Array): void {
    if (!this.connected) return;
    const generation = this.connectionGeneration;
    const message = decodeRemoteMessage(frame);
    this.messages.push(message);
    // Apply synchronous protocol state before consumers react to the message.
    const handled = this.handleProtocolMessage(message);
    this.emit("message", message);
    void handled.catch((error: Error) => {
      if (generation !== this.connectionGeneration) return;
      this.invalidateConnection(error);
      this.emit("error", error);
    });
  }

  private async handleProtocolMessage(message: RemoteMessage): Promise<void> {
    if (message.type === "configure") {
      this.activeFeatures = message.features & DefaultRemoteFeatures;
      if ((this.activeFeatures & RemoteFeatures.key) === 0) {
        throw new Error("TV remote service did not advertise key support");
      }
      await this.send({ type: "configure", features: this.activeFeatures });
    } else if (message.type === "set-active") {
      await this.send({ type: "set-active", active: this.activeFeatures ?? 0 });
    } else if (message.type === "ping") {
      await this.send({ type: "ping", sequence: message.sequence });
    } else if (message.type === "ready") {
      this.ready = true;
    } else if (
      message.type === "text" &&
      this.activeFeatures !== undefined &&
      (this.activeFeatures & RemoteFeatures.ime) !== 0
    ) {
      this.imeMetadata = { imeCounter: message.imeCounter, fieldCounter: message.fieldCounter };
    } else if (message.type === "voice" && message.phase === "begin") {
      this.voiceSession = { sessionId: message.sessionId, packageName: message.packageName };
    }
  }

  private invalidateConnection(error: Error): void {
    this.connectionGeneration++;
    this.connected = false;
    this.ready = false;
    this.activeFeatures = undefined;
    this.imeMetadata = undefined;
    this.voiceSession = undefined;
    this.emit("connection-ended", error);
  }

  private async waitForImeMetadata(timeoutMs = 5_000): Promise<void> {
    if (!this.connected) throw new Error("remote connection is not connected");
    if (this.activeFeatures !== undefined && (this.activeFeatures & RemoteFeatures.ime) === 0) {
      throw new Error("TV remote service did not advertise text input support");
    }
    if (this.imeMetadata) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for Android TV text input metadata"));
      }, timeoutMs);
      const onMessage = () => {
        if (this.activeFeatures !== undefined && (this.activeFeatures & RemoteFeatures.ime) === 0) {
          onEnd(new Error("TV remote service did not advertise text input support"));
        } else if (this.imeMetadata) {
          cleanup();
          resolve();
        }
      };
      const onEnd = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("connection-ended", onEnd);
      };
      this.on("message", onMessage);
      this.on("connection-ended", onEnd);
    });
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
    if (this.ready) return;
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
        this.off("connection-ended", onError);
      };
      this.on("message", onMessage);
      this.on("close", onClose);
      this.on("error", onError);
      this.on("connection-ended", onError);
    });
  }
}

function padVoiceChunk(chunk: Uint8Array): Uint8Array {
  if (chunk.length >= VoiceChunkMinSize) return chunk;
  const padded = new Uint8Array(VoiceChunkMinSize);
  padded.set(chunk);
  return padded;
}
