import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const libraryUrl = JSON.stringify(new URL("../src/index.ts", import.meta.url).href);

const childImports = `
  import assert from "node:assert/strict";
  import { once } from "node:events";
  import { promisify } from "node:util";
  import {
    FrameParser,
    MemoryTransport,
    NodeTlsTransport,
    PairingClient,
    createGoogleTv,
    encodeFrame,
    encodePairingMessage,
  } from ${libraryUrl};
`;

// Use a genuine localhost TLS endpoint, not the shared in-memory TV fixture.
// Capture OpenSSL's progress output, but allow certificate generation errors to fail.
const localhostCertificate = `
  import { execFileSync } from "node:child_process";
  import { mkdtempSync, readFileSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  const directory = mkdtempSync(join(tmpdir(), "google-tv-lifecycle-"));
  let certificate;
  let key;
  try {
    const certificatePath = join(directory, "server.crt");
    const keyPath = join(directory, "server.key");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certificatePath,
      "-subj", "/CN=localhost", "-days", "1",
    ], { stdio: "pipe" });
    certificate = readFileSync(certificatePath);
    key = readFileSync(keyPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
`;

const rejectingTlsServer = `
  ${localhostCertificate}
  import { createServer } from "node:tls";

  let receivedRequest = false;
  const server = createServer({ cert: certificate, key }, (socket) => {
    const parser = new FrameParser();
    socket.on("data", (chunk) => {
      for (const frame of parser.push(chunk)) {
        assert.ok(frame.length > 0);
        receivedRequest = true;
        socket.write(encodeFrame(encodePairingMessage({
          type: "request-ack", status: "bad-configuration",
        })));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
`;

const stalledTlsServer = `
  import { createServer } from "node:net";

  // Accept TCP but never complete TLS, keeping connect() genuinely in flight.
  const server = createServer();
  const accepted = once(server, "connection");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
`;

const reconnectingTlsServer = `
  ${localhostCertificate}
  import tls from "node:tls";

  // Observe genuine socket lifetimes through a controlled dependency seam,
  // without reading NodeTlsTransport's private socket field.
  const clientSockets = [];
  const connect = tls.connect.bind(tls);
  tls.connect = (...args) => {
    const socket = connect(...args);
    clientSockets.push(socket);
    return socket;
  };

  // Keep the old peer's readable half alive until the test releases it.
  const server = tls.createServer({ cert: certificate, key, allowHalfOpen: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const transport = new NodeTlsTransport({ host: "127.0.0.1", port });

  const firstAccepted = once(server, "secureConnection");
  await transport.connect();
  const [firstPeer] = await firstAccepted;
  const firstEnded = once(firstPeer, "end");
  const firstClosed = once(clientSockets[0], "close");
  await transport.close();
  await firstEnded;

  const secondAccepted = once(server, "secureConnection");
  await transport.connect();
  const [secondPeer] = await secondAccepted;
`;

async function expectNaturalExit(script: string, message: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `${childImports}\n${script}`,
    ],
    { cwd: new URL("..", import.meta.url), timeout: 3_000 },
  );

  expect(stdout.trim()).toBe(message);
  expect(stderr).toBe("");
}

describe("pairing lifecycle at public API boundaries", () => {
  it("allows the caller to close PairingClient after a post-TLS start rejection", async () => {
    await expectNaturalExit(
      `
        ${rejectingTlsServer}
        const client = new PairingClient({ host: "127.0.0.1", port });
        try {
          await assert.rejects(client.start(), /bad-configuration/);
          assert.equal(receivedRequest, true);
        } finally {
          // A directly constructed client remains accessible to its owner.
          await client.close();
          server.close();
        }
        console.log("caller closed rejected pairing client");
      `,
      "caller closed rejected pairing client",
    );
  });

  it("releases the inaccessible client when adapter startPairing rejects", async () => {
    await expectNaturalExit(
      `
        ${rejectingTlsServer}
        const tv = createGoogleTv({ host: "127.0.0.1", pairingPort: port });
        await assert.rejects(tv.startPairing(), /bad-configuration/);
        assert.equal(receivedRequest, true);
        // No session was returned, so the consumer has no session.close().
        // Stop accepting connections without destroying any accepted sockets.
        server.close();
        console.log("adapter rejected pairing without retaining a connection");
      `,
      "adapter rejected pairing without retaining a connection",
    );
  });

  it("cancels an in-flight TLS connect and releases its socket before timeout", async () => {
    await expectNaturalExit(
      `
        ${stalledTlsServer}
        const transport = new NodeTlsTransport({
          host: "127.0.0.1", port, timeoutMs: 10_000,
        });
        const rejected = assert.rejects(transport.connect());
        const [socket] = await accepted;
        const closed = once(socket, "close");
        await transport.close();
        // The child deadline is shorter than TLS's own timeout; await real signals.
        await rejected;
        await closed;
        await promisify(server.close.bind(server))();
        console.log("pending TLS connect cancelled and socket released");
      `,
      "pending TLS connect cancelled and socket released",
    );
  });

  it("allows PairingClient close to cancel an in-flight start before the TLS timeout", async () => {
    await expectNaturalExit(
      `
        ${stalledTlsServer}
        const client = new PairingClient({
          host: "127.0.0.1", port, timeoutMs: 10_000,
        });
        const rejected = assert.rejects(client.start());
        const [socket] = await accepted;
        const closed = once(socket, "close");
        await client.close();
        await rejected;
        await closed;
        await promisify(server.close.bind(server))();
        console.log("pending pairing start cancelled and socket released");
      `,
      "pending pairing start cancelled and socket released",
    );
  });

  it("does not forward a late frame from a closed connection into a new connection", async () => {
    await expectNaturalExit(
      `
        ${reconnectingTlsServer}
        const frames = [];
        transport.on("frame", (frame) => frames.push(Array.from(frame)));

        // Deliver a queued old-socket event deterministically. The socket is real;
        // only event delivery is controlled, avoiding a network scheduling guess.
        clientSockets[0].emit("data", encodeFrame(Uint8Array.of(0xee)));
        const received = once(transport, "frame");
        secondPeer.write(encodeFrame(Uint8Array.of(0xa5)));
        await received;
        assert.deepEqual(frames, [[0xa5]]);

        firstPeer.destroy();
        await firstClosed;
        await transport.close();
        secondPeer.end();
        await promisify(server.close.bind(server))();
        console.log("only the new connection delivered a frame");
      `,
      "only the new connection delivered a frame",
    );
  });

  it("keeps the new connection usable after the old socket finishes closing", async () => {
    await expectNaturalExit(
      `
        ${reconnectingTlsServer}
        firstPeer.destroy();
        await firstClosed;

        const received = once(secondPeer, "data");
        await transport.send(Uint8Array.of(0xa5));
        const [data] = await received;
        assert.deepEqual(Array.from(data), Array.from(encodeFrame(Uint8Array.of(0xa5))));

        await transport.close();
        secondPeer.end();
        await promisify(server.close.bind(server))();
        console.log("new connection remained usable after old socket close");
      `,
      "new connection remained usable after old socket close",
    );
  });

  it("reports a rejected send without a second unhandled reply-timeout rejection", async () => {
    await expectNaturalExit(
      `
        const sendError = new Error("injected pairing send failure");
        class RejectingSendTransport extends MemoryTransport {
          send() {
            return Promise.reject(sendError);
          }
        }
        const client = new PairingClient({
          transport: new RejectingSendTransport(), timeoutMs: 100,
        });
        await assert.rejects(client.start(), (error) => error === sendError);
        console.log("only the original send failure was reported");
        // Natural exit and strict unhandled rejections expose an orphan reply.
        // This integration observes Node's actual unhandled-rejection/exit behavior,
        // which an in-process fake clock cannot establish.
      `,
      "only the original send failure was reported",
    );
  });

  it("releases reply subscriptions on the caller-owned transport after send rejection", async () => {
    await expectNaturalExit(
      `
        const sendError = new Error("injected pairing send failure");
        class RejectingSendTransport extends MemoryTransport {
          send() {
            return Promise.reject(sendError);
          }
        }
        const transport = new RejectingSendTransport();
        const client = new PairingClient({ transport, timeoutMs: 30_000 });
        await assert.rejects(client.start(), (error) => error === sendError);
        // The injected transport is owned and observable by the caller. Settled
        // operations must release their subscriptions, not retain the operation.
        for (const event of ["frame", "error", "close"]) {
          assert.equal(transport.listenerCount(event), 0, event + " subscription retained");
        }
        console.log("rejected send released its transport subscriptions");
      `,
      "rejected send released its transport subscriptions",
    );
  });

  it("does not retain a long reply timer after the send has already rejected", async () => {
    await expectNaturalExit(
      `
        const sendError = new Error("injected pairing send failure");
        class RejectingSendTransport extends MemoryTransport {
          send() {
            return Promise.reject(sendError);
          }
        }
        const client = new PairingClient({
          transport: new RejectingSendTransport(), timeoutMs: 30_000,
        });
        await assert.rejects(client.start(), (error) => error === sendError);
        console.log("rejected send retained no reply timer");
        // A 30-second orphan timer cannot naturally exit within the child deadline.
      `,
      "rejected send retained no reply timer",
    );
  });
});
