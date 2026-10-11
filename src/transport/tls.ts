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

type TlsConnection = {
  socket: tls.TLSSocket;
  ready: Promise<void>;
  cancel: () => void;
  connected: boolean;
};

export class NodeTlsTransport extends EventEmitter implements FrameTransport {
  private connection?: TlsConnection;

  constructor(private readonly options: TlsTransportOptions) {
    super();
  }

  connect(): Promise<void> {
    if (this.connection) {
      return this.connection.ready;
    }

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({
        host: this.options.host,
        port: this.options.port,
        cert: this.options.cert,
        key: this.options.key,
        ca: this.options.ca,
        rejectUnauthorized: this.options.rejectUnauthorized ?? false,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const parser = new FrameParser();
    let cancel!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        socket.destroy(new Error(`TLS connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      cancel = () => {
        clearTimeout(timer);
        reject(new Error("TLS connection cancelled"));
        socket.destroy();
      };

      socket.once("secureConnect", () => {
        clearTimeout(timer);
        if (this.connection !== connection) return;
        connection.connected = true;
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        if (this.connection !== connection) return;
        reject(error);
        // connect() owns pre-handshake failures; error events remain available to
        // subscribers, and established connections retain EventEmitter semantics.
        if (connection.connected || this.listenerCount("error") > 0) {
          this.emit("error", error);
        }
      });
      socket.on("data", (chunk: Buffer) => {
        if (this.connection !== connection) return;
        for (const frame of parser.push(chunk)) {
          // A subscriber can close or replace the connection during delivery.
          if (this.connection !== connection) return;
          this.emit("frame", frame);
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        if (this.connection !== connection) return;
        this.connection = undefined;
        reject(new Error("TLS connection closed before handshake completed"));
        this.emit("close");
      });
    });
    const connection: TlsConnection = { socket, ready, cancel, connected: false };
    this.connection = connection;
    return ready;
  }

  async send(frame: Uint8Array): Promise<void> {
    const connection = this.connection;
    if (!connection?.connected) {
      throw new Error("transport is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      connection.socket.write(encodeFrame(frame), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    this.connection = undefined;
    connection.cancel();
    this.emit("close");
  }

  getCertificates(): { local?: tls.PeerCertificate; peer?: tls.PeerCertificate } {
    const local = this.connection?.socket.getCertificate();
    const peer = this.connection?.socket.getPeerCertificate();
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
