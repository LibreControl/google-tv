import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  FrameParser,
  PairingClient,
  decodePairingMessage,
  encodeFrame,
  encodePairingMessage,
} from "../src/index.js";

function certificate(bits: number) {
  const directory = mkdtempSync(join(tmpdir(), "google-tv-rsa-"));
  try {
    const certPath = join(directory, "certificate.pem");
    const keyPath = join(directory, "key.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", `rsa:${bits}`, "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-subj", "/CN=localhost", "-days", "1",
    ], { stdio: "pipe" });
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// JWK encodes unsigned integer bytes, independently of Node's TLS modulus hex
// presentation (OpenSSL BN_print omits the high zero nibble for odd-bit keys).
function publicNumbers(cert: Buffer): Buffer[] {
  const key = new X509Certificate(cert).publicKey.export({ format: "jwk" });
  if (!key.n || !key.e) throw new Error("expected an RSA certificate");
  return [Buffer.from(key.n, "base64url"), Buffer.from(key.e, "base64url")];
}

describe("certificate-bound pairing RSA integers", () => {
  it.each([
    { clientBits: 2048, serverBits: 2049 },
    { clientBits: 2049, serverBits: 2048 },
  ])("pairs with $clientBits-bit client and $serverBits-bit server keys", async ({ clientBits, serverBits }) => {
    const local = certificate(clientBits);
    const peer = certificate(serverBits);
    expect(new X509Certificate(local.cert).publicKey.asymmetricKeyDetails?.modulusLength).toBe(clientBits);
    expect(new X509Certificate(peer.cert).publicKey.asymmetricKeyDetails?.modulusLength).toBe(serverBits);
    const nonce = Buffer.from("0bdb", "hex");
    const hash = createHash("sha256");
    for (const bytes of [...publicNumbers(local.cert), ...publicNumbers(peer.cert), nonce]) {
      hash.update(bytes);
    }
    const expectedSecret = hash.digest();
    const code = `${expectedSecret[0].toString(16).padStart(2, "0")}0bdb`;
    const sockets = new Set<TLSSocket>();
    let receivedSecret: Uint8Array | undefined;
    const server = createServer({ ...peer, requestCert: true, rejectUnauthorized: false }, (socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      const parser = new FrameParser();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of parser.push(chunk)) {
          const message = decodePairingMessage(frame);
          if (message.type === "request") {
            socket.write(encodeFrame(encodePairingMessage({ type: "request-ack", status: "ok" })));
          } else if (message.type === "options") {
            socket.write(encodeFrame(encodePairingMessage({ type: "options", status: "ok" })));
          } else if (message.type === "configuration") {
            socket.write(encodeFrame(encodePairingMessage({ type: "configuration-ack", status: "ok" })));
          } else if (message.type === "secret") {
            receivedSecret = message.secret;
            const status = Buffer.from(message.secret).equals(expectedSecret) ? "ok" : "bad-secret";
            socket.write(encodeFrame(encodePairingMessage({ type: "secret-ack", status })));
          }
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const client = new PairingClient({ ...local, host: "127.0.0.1", port: address.port, timeoutMs: 1000 });
    try {
      await client.start();
      const wrongCode = `${(expectedSecret[0] ^ 0xff).toString(16).padStart(2, "0")}0bdb`;
      await expect(client.submitCode(wrongCode)).rejects.toThrow(
        "pairing code failed local certificate hash validation",
      );
      expect(receivedSecret).toBeUndefined();
      await expect(client.submitCode(code)).resolves.toMatchObject({ type: "secret-ack", status: "ok" });
      expect(Buffer.from(receivedSecret ?? [])).toEqual(expectedSecret);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
