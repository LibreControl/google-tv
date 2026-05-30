import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { decodeString } from "../codec/wire.js";
import { decodePairingMessage, encodePairingMessage } from "../codec/pairing.js";
import {
  DefaultRemoteFeatures,
  RemoteMessage,
  decodeRemoteMessage,
  encodeRemoteMessage,
} from "../codec/remote.js";
import { FrameTransport, createMemoryTransportPair } from "../transport/tls.js";

export type FakeGoogleTvServerOptions = {
  pairingCode?: string;
  name?: string;
};

export class FakeGoogleTvServer extends EventEmitter {
  readonly name: string;
  readonly pairingCode: string;
  readonly remoteMessages: RemoteMessage[] = [];
  paired = false;
  private nextVoiceSessionId = 100;
  private readonly certificate = randomBytes(64);

  constructor(options: FakeGoogleTvServerOptions = {}) {
    super();
    this.name = options.name ?? "Fake Google TV";
    this.pairingCode = options.pairingCode ?? "A1B2C3";
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
    client.on("connect", async () => {
      await server.send(
        encodeRemoteMessage({ type: "configure", features: DefaultRemoteFeatures }),
      );
    });
    server.on("frame", async (frame) => {
      const message = decodeRemoteMessage(frame);
      this.remoteMessages.push(message);
      this.emit("remoteMessage", message);
      if (message.type === "configure") {
        await server.send(
          encodeRemoteMessage({ type: "set-active", active: DefaultRemoteFeatures }),
        );
      } else if (message.type === "set-active") {
        await server.send(encodeRemoteMessage({ type: "ready", started: true }));
      } else if (message.type === "ping") {
        await server.send(encodeRemoteMessage({ type: "ping", sequence: message.sequence }));
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
}

export function createFakeGoogleTvServer(options?: FakeGoogleTvServerOptions): FakeGoogleTvServer {
  return new FakeGoogleTvServer(options);
}
