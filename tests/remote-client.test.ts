import { describe, expect, it } from "vitest";
import { RemoteClient } from "../src/client/RemoteClient.js";
import { createFakeGoogleTvServer } from "../src/testing/FakeGoogleTvServer.js";

describe("RemoteClient", () => {
  it("connects, receives ready, and sends commands", async () => {
    const server = createFakeGoogleTvServer();
    const client = new RemoteClient({ transport: server.createRemoteTransport() });

    await client.connect();
    await waitFor(() => client.messages.some((message) => message.type === "ready"));
    await client.command("home");
    await client.text("hello");
    const voice = await client.voiceBegin();
    expect(voice).toEqual({ sessionId: 100, packageName: "com.google.android.katniss" });
    await client.voiceStreamPcm(Uint8Array.from([1, 2, 3]), { chunkDelayMs: 0 });
    await client.voiceEnd();
    await waitFor(() => server.remoteMessages.length >= 9);

    expect(server.remoteMessages.map((message) => message.type)).toEqual([
      "configure",
      "set-active",
      "key",
      "text",
      "key",
      "key",
      "voice",
      "voice",
      "voice",
    ]);
    expect(server.remoteMessages.slice(-3)).toEqual([
      { type: "voice", phase: "begin", sessionId: 100 },
      {
        type: "voice",
        phase: "payload",
        sessionId: 100,
        payload: padded(Uint8Array.from([1, 2, 3]), 8 * 1024),
      },
      { type: "voice", phase: "end", sessionId: 100 },
    ]);
  });
});

function padded(input: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  output.set(input);
  return output;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
