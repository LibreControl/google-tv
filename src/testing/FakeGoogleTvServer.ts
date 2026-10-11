import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { decodeString } from "../codec/wire.js";
import { decodePairingMessage, encodePairingMessage } from "../codec/pairing.js";
import {
  DefaultRemoteFeatures,
  RemoteMessage,
  RemoteFeatures,
  decodeRemoteMessage,
  encodeRemoteMessage,
} from "../codec/remote.js";
import { FrameTransport, createMemoryTransportPair } from "../transport/tls.js";

export type FakeGoogleTvServerOptions = {
  pairingCode?: string;
  name?: string;
  remoteFeatures?: number;
  delayImeMetadata?: boolean;
  imeCounter?: number;
  fieldCounter?: number;
};

export class FakeGoogleTvServer extends EventEmitter {
  readonly name: string;
  readonly pairingCode: string;
  readonly remoteMessages: RemoteMessage[] = [];
  paired = false;
  acceptedText = "";
  private readonly remoteFeatures: number;
  private readonly delayImeMetadata: boolean;
  private imeCounter: number;
  private fieldCounter: number;
  private remoteTransport?: FrameTransport;
  private imeMetadataSent = false;
  private nextVoiceSessionId = 100;
  private readonly certificate = randomBytes(64);

  constructor(options: FakeGoogleTvServerOptions = {}) {
    super();
    this.name = options.name ?? "Fake Google TV";
    this.pairingCode = options.pairingCode ?? "A1B2C3";
    this.remoteFeatures = options.remoteFeatures ?? DefaultRemoteFeatures;
    this.delayImeMetadata = options.delayImeMetadata ?? false;
    this.imeCounter = options.imeCounter ?? 17;
    this.fieldCounter = options.fieldCounter ?? 23;
  }

  createPairingTransport(): FrameTransport {
    const [client, server] = createMemoryTransportPair();
    server.connect();
    server.on("frame", async (frame) => {
      const message = decodePairingMessage(frame);
      if (message.type === "request") {
        await server.send(
          encodePairingMessage({
            type: "request-ack",
            status: "ok",
            serverName: this.name,
          }),
        );
      } else if (message.type === "options") {
        await server.send(encodePairingMessage({ type: "options", status: "ok" }));
      } else if (message.type === "configuration") {
        await server.send(encodePairingMessage({ type: "configuration-ack", status: "ok" }));
      } else if (message.type === "secret") {
        this.paired = decodeString(message.secret).trim().toUpperCase() === this.pairingCode;
        await server.send(
          encodePairingMessage({
            type: "secret-ack",
            status: this.paired ? "ok" : "bad-secret",
            secret: this.paired ? this.certificate : undefined,
          }),
        );
      }
    });
    return client;
  }

  createRemoteTransport(): FrameTransport {
    const [client, server] = createMemoryTransportPair();
    server.connect();
    this.remoteTransport = server;
    client.on("connect", async () => {
      await server.connect();
      this.imeMetadataSent = false;
      await server.send(encodeRemoteMessage({ type: "configure", features: this.remoteFeatures }));
    });
    server.on("frame", async (frame) => {
      const message = decodeRemoteMessage(frame);
      this.remoteMessages.push(message);
      this.emit("remoteMessage", message);
      if (message.type === "configure") {
        await server.send(encodeRemoteMessage({ type: "set-active", active: message.features }));
      } else if (message.type === "set-active") {
        await server.send(encodeRemoteMessage({ type: "ready", started: true }));
        if (!this.delayImeMetadata && (this.remoteFeatures & RemoteFeatures.ime) !== 0) {
          await this.sendImeMetadata();
        }
      } else if (message.type === "ping") {
        await server.send(encodeRemoteMessage({ type: "ping", sequence: message.sequence }));
      } else if (message.type === "text") {
        if (
          this.imeMetadataSent &&
          (this.remoteFeatures & RemoteFeatures.ime) !== 0 &&
          message.imeCounter === this.imeCounter &&
          message.fieldCounter === this.fieldCounter
        ) {
          this.acceptedText = message.text;
          this.fieldCounter++;
          await this.sendImeMetadata();
          this.emit("textAccepted", this.acceptedText);
        } else {
          this.emit("textRejected", message);
        }
      } else if (message.type === "key" && message.keyCode === 84 && message.action === "up") {
        await server.send(
          encodeRemoteMessage({
            type: "voice",
            phase: "begin",
            sessionId: this.nextVoiceSessionId++,
            packageName: "com.google.android.katniss",
          }),
        );
      }
    });
    return client;
  }

  async sendImeMetadata(
    imeCounter = this.imeCounter,
    fieldCounter = this.fieldCounter,
  ): Promise<void> {
    if (!this.remoteTransport) throw new Error("fake remote connection has not started");
    this.imeCounter = imeCounter;
    this.fieldCounter = fieldCounter;
    this.imeMetadataSent = true;
    await this.remoteTransport.send(
      encodeRemoteMessage({
        type: "text",
        text: this.acceptedText,
        imeCounter,
        fieldCounter,
      }),
    );
  }

  async closeRemoteConnection(): Promise<void> {
    await this.remoteTransport?.close();
  }
}

export function createFakeGoogleTvServer(options?: FakeGoogleTvServerOptions): FakeGoogleTvServer {
  return new FakeGoogleTvServer(options);
}
