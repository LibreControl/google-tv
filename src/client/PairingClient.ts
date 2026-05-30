import {
  PairingMessage,
  decodePairingMessage,
  derivePairingSecret,
  encodePairingMessage,
  extractPairingCertificates,
} from "../codec/pairing.js";
import { FrameTransport, NodeTlsTransport, TlsTransportOptions } from "../transport/tls.js";

export type PairingClientOptions =
  | ({ transport: FrameTransport; clientName?: string } & Partial<TlsTransportOptions>)
  | (TlsTransportOptions & { clientName?: string });

export class PairingClient {
  private readonly transport: FrameTransport;
  private readonly clientName: string;
  private readonly serviceName: string;
  private readonly cert?: string | Buffer;
  private readonly timeoutMs: number;
  private configured = false;

  constructor(options: PairingClientOptions) {
    this.transport =
      "transport" in options
        ? options.transport
        : new NodeTlsTransport({ ...options, port: options.port ?? 6467 });
    this.clientName = options.clientName ?? "librecontrol-google-tv";
    this.serviceName = "androidtvremote2";
    this.cert = options.cert;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async start(): Promise<PairingMessage> {
    await this.transport.connect();
    const requestAck = await this.sendAndWait({
      type: "request",
      status: "ok",
      serviceName: this.serviceName,
      clientName: this.clientName,
    });
    if (requestAck.status !== "ok" || requestAck.type !== "request-ack") {
      throw new Error(
        `expected pairing request ack, got ${requestAck.type} (${requestAck.status})`,
      );
    }

    const options = await this.sendAndWait({ type: "options", status: "ok" });
    if (options.status !== "ok" || options.type !== "options") {
      throw new Error(`expected pairing options, got ${options.type} (${options.status})`);
    }

    const configurationAck = await this.sendAndWait({ type: "configuration", status: "ok" });
    if (configurationAck.status !== "ok" || configurationAck.type !== "configuration-ack") {
      throw new Error(
        `expected pairing configuration ack, got ${configurationAck.type} (${configurationAck.status})`,
      );
    }

    this.configured = true;
    return configurationAck;
  }

  async submitCode(code: string): Promise<PairingMessage> {
    if (!this.configured) {
      throw new Error("pairing has not been started");
    }
    const tlsCertificates = this.transport.getCertificates?.();
    const secret = tlsCertificates
      ? derivePairingSecret(
          code,
          extractPairingCertificates(this.getClientCertificate(), tlsCertificates),
        )
      : new TextEncoder().encode(code.trim().toUpperCase());
    const result = await this.sendAndWait({
      type: "secret",
      status: "ok",
      secret,
    });
    if (result.type !== "secret-ack") {
      throw new Error(`expected secret ack, got ${result.type} (${result.status})`);
    }
    return result;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private getClientCertificate(): string | Buffer {
    if (!this.cert) {
      throw new Error("missing client certificate for pairing secret calculation");
    }
    return this.cert;
  }

  private async sendAndWait(message: PairingMessage): Promise<PairingMessage> {
    const reply = new Promise<PairingMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for pairing reply to ${message.type}`));
      }, this.timeoutMs);
      const onFrame = (frame: Uint8Array) => {
        cleanup();
        try {
          resolve(decodePairingMessage(frame));
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`pairing connection closed while waiting for reply to ${message.type}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.transport.off("frame", onFrame);
        this.transport.off("error", onError);
        this.transport.off("close", onClose);
      };
      this.transport.on("frame", onFrame);
      this.transport.on("error", onError);
      this.transport.on("close", onClose);
    });
    await this.transport.send(encodePairingMessage(message));
    return reply;
  }
}
