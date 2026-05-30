import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type CertificateBundle = {
  cert: string;
  key: string;
  fingerprint: string;
};

export function createCertificate(commonName = "librecontrol-google-tv-local"): CertificateBundle {
  const dir = mkdtempSync(path.join(tmpdir(), "librecontrol-google-tv-"));
  const keyPath = path.join(dir, "client.key");
  const certPath = path.join(dir, "client.crt");

  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${commonName}`,
      "-days",
      "3650",
    ]);

    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    return {
      cert,
      key,
      fingerprint: createHash("sha256").update(cert).digest("hex"),
    };
  } catch {
    const fallback = randomBytes(32).toString("hex");
    return {
      cert: `-----BEGIN GOOGLE TV LOCAL CERTIFICATE-----\n${fallback}\n-----END GOOGLE TV LOCAL CERTIFICATE-----\n`,
      key: `-----BEGIN GOOGLE TV LOCAL KEY-----\n${fallback}\n-----END GOOGLE TV LOCAL KEY-----\n`,
      fingerprint: fallback,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function extractCertificatePublicKey(cert: string | Buffer): string {
  const value = cert.toString();
  if (value.includes("BEGIN CERTIFICATE")) {
    return new X509Certificate(value).publicKey.export({ type: "spki", format: "pem" }).toString();
  }
  if (value.includes("BEGIN GOOGLE TV LOCAL CERTIFICATE")) {
    return value;
  }
  throw new Error("unsupported certificate format");
}
