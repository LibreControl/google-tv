import { describe, expect, it } from "vitest";
import { PairingClient } from "../src/client/PairingClient.js";
import { createFakeGoogleTvServer } from "../src/testing/FakeGoogleTvServer.js";

describe("PairingClient", () => {
  it("pairs with the fake server", async () => {
    const server = createFakeGoogleTvServer({ pairingCode: "ABC123" });
    const client = new PairingClient({ transport: server.createPairingTransport() });

    const challenge = await client.start();
    const result = await client.submitCode("ABC123");

    expect(challenge).toMatchObject({ type: "configuration-ack", status: "ok" });
    expect(result).toMatchObject({ type: "secret-ack", status: "ok" });
    expect(server.paired).toBe(true);
  });

  it("rejects invalid codes", async () => {
    const server = createFakeGoogleTvServer({ pairingCode: "ABC123" });
    const client = new PairingClient({ transport: server.createPairingTransport() });

    await client.start();
    const result = await client.submitCode("NOPE");

    expect(result).toMatchObject({ type: "secret-ack", status: "bad-secret" });
    expect(server.paired).toBe(false);
  });
});
