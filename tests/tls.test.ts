import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeTlsTransport } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function refusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP server address");
  }
  await promisify(server.close.bind(server))();
  return address.port;
}

describe("refused TLS connections", () => {
  it("rejects standalone PairingClient.start without uncaught errors or retained handles", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { once } from "node:events";
          import { createServer } from "node:net";
          import { promisify } from "node:util";
          import { PairingClient } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};

          const server = createServer();
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const { port } = server.address();
          await promisify(server.close.bind(server))();
          const client = new PairingClient({ host: "127.0.0.1", port });
          await assert.rejects(client.start(), { code: "ECONNREFUSED" });
          console.log("rejected ECONNREFUSED");
          // Exit naturally: no error listeners, client.close(), or process.exit().
        `,
      ],
      { cwd: new URL("..", import.meta.url), timeout: 3_000 },
    );

    expect(stdout.trim()).toBe("rejected ECONNREFUSED");
    expect(stderr).toBe("");
  });

  it("notifies subscribers with the original rejection error", async () => {
    const transport = new NodeTlsTransport({ host: "127.0.0.1", port: await refusedPort() });
    let emittedError: Error | undefined;
    transport.on("error", (error) => {
      emittedError = error;
    });

    const error = await transport.connect().catch((error: Error) => error);
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(emittedError).toBe(error);
  });
});
