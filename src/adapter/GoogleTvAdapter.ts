import { PairingClient } from "../client/PairingClient.js";
import { RemoteClient, type VoiceSession } from "../client/RemoteClient.js";
import type { CertificateBundle } from "../certificates/index.js";
import type { RemoteKeyName } from "../codec/remote.js";

export type GoogleTvDeviceConfig = {
  id?: string;
  name?: string;
  host: string;
  pairingPort?: number;
  remotePort?: number;
  certificate?: CertificateBundle;
};

export type GoogleTvPairingSession = {
  serviceName: string;
  submitCode(code: string): Promise<GoogleTvPairingResult>;
  close(): Promise<void>;
};

export type GoogleTvPairingResult = {
  paired: boolean;
  status: "ok" | "bad-configuration" | "bad-secret" | "error" | "unknown";
  certificate?: Uint8Array;
};

export class GoogleTvDevice {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  private readonly pairingPort: number;
  private readonly remotePort: number;
  private readonly certificate?: CertificateBundle;
  private remote?: RemoteClient;

  constructor(config: GoogleTvDeviceConfig) {
    this.host = config.host;
    this.id = config.id ?? config.host;
    this.name = config.name ?? `Google TV ${config.host}`;
    this.pairingPort = config.pairingPort ?? 6467;
    this.remotePort = config.remotePort ?? 6466;
    this.certificate = config.certificate;
  }

  async startPairing(): Promise<GoogleTvPairingSession> {
    const client = new PairingClient({
      host: this.host,
      port: this.pairingPort,
      cert: this.certificate?.cert,
      key: this.certificate?.key,
    });
    await client.start();

    return {
      serviceName: "androidtvremote2",
      submitCode: async (code) => {
        const result = await client.submitCode(code);
        if (result.type !== "secret-ack") {
          throw new Error(`expected pairing secret ack, got ${result.type}`);
        }
        return {
          paired: result.status === "ok",
          status: result.status,
          certificate: result.secret,
        };
      },
      close: () => client.close(),
    };
  }

  async connect(): Promise<void> {
    this.remote = new RemoteClient({
      host: this.host,
      port: this.remotePort,
      cert: this.certificate?.cert,
      key: this.certificate?.key,
    });
    await this.remote.connect();
  }

  async disconnect(): Promise<void> {
    await this.remote?.close();
    this.remote = undefined;
  }

  async sendKey(key: RemoteKeyName | string): Promise<void> {
    await this.requireRemote().command(key);
  }

  async inputText(text: string): Promise<void> {
    await this.requireRemote().text(text);
  }

  async voiceStart(): Promise<VoiceSession> {
    return await this.requireRemote().voiceBegin();
  }

  async voiceStop(): Promise<void> {
    await this.requireRemote().voiceEnd();
  }

  async voiceStreamPcm(samples: Uint8Array): Promise<void> {
    await this.requireRemote().voiceStreamPcm(samples);
  }

  private requireRemote(): RemoteClient {
    if (!this.remote) {
      throw new Error("Google TV device is not connected");
    }
    return this.remote;
  }
}

export class GoogleTvAdapter {
  readonly id = "google";
  readonly displayName = "Google TV";

  createDevice(config: GoogleTvDeviceConfig): GoogleTvDevice {
    return new GoogleTvDevice(config);
  }
}

export function createGoogleTv(config: GoogleTvDeviceConfig): GoogleTvDevice {
  return new GoogleTvDevice(config);
}
