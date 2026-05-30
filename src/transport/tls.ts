import { EventEmitter } from "node:events";
import tls from "node:tls";
import { FrameParser, encodeFrame } from "./framing.js";

export type TransportEvents = {
  connect: [];
  frame: [Uint8Array];
  close: [];
  error: [Error];
};

export interface FrameTransport {
  connect(): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
  getCertificates?(): { local?: tls.PeerCertificate; peer?: tls.PeerCertificate };
  on<K extends keyof TransportEvents>(
    event: K,
    listener: (...args: TransportEvents[K]) => void,
  ): this;
  off<K extends keyof TransportEvents>(
    event: K,
    listener: (...args: TransportEvents[K]) => void,
  ): this;
}

export type TlsTransportOptions = {
  host: string;
  port: number;
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
};

export class NodeTlsTransport extends EventEmitter implements FrameTransport {
  private socket?: tls.TLSSocket;
  private readonly parser = new FrameParser();

  constructor(private readonly options: TlsTransportOptions) {
    super();
  }

  connect(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.options.host,
        port: this.options.port,
        cert: this.options.cert,
        key: this.options.key,
        ca: this.options.ca,
        rejectUnauthorized: this.options.rejectUnauthorized ?? false,
      });

      const timer = setTimeout(() => {
        socket.destroy(new Error(`TLS connection timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs ?? 15_000);

      socket.once("secureConnect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        this.emit("error", error);
        reject(error);
      });
      socket.on("data", (chunk: Buffer) => {
        for (const frame of this.parser.push(chunk)) {
          this.emit("frame", frame);
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        this.socket = undefined;
        this.emit("close");
      });
    });
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.socket) {
      throw new Error("transport is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(encodeFrame(frame), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    socket?.end();
  }

  getCertificates(): { local?: tls.PeerCertificate; peer?: tls.PeerCertificate } {
    const local = this.socket?.getCertificate();
    const peer = this.socket?.getPeerCertificate();
    return {
      local: local && "raw" in local ? local : undefined,
      peer: peer && "raw" in peer ? peer : undefined,
    };
  }
}

export class MemoryTransport extends EventEmitter implements FrameTransport {
  peer?: MemoryTransport;
  connected = false;

  connect(): Promise<void> {
    this.connected = true;
    queueMicrotask(() => this.emit("connect"));
    return Promise.resolve();
  }

  send(frame: Uint8Array): Promise<void> {
    if (!this.connected) {
      throw new Error("transport is not connected");
    }
    queueMicrotask(() => this.peer?.emit("frame", frame));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.connected = false;
    queueMicrotask(() => {
      this.emit("close");
      this.peer?.emit("close");
    });
    return Promise.resolve();
  }
}

export function createMemoryTransportPair(): [MemoryTransport, MemoryTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}
