import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RemoteClient } from "../src/client/RemoteClient.js";
import { RemoteFeatures, RemoteMessage, encodeRemoteMessage } from "../src/codec/remote.js";
import { FakeGoogleTvServer, createFakeGoogleTvServer } from "../src/testing/FakeGoogleTvServer.js";
import { createMemoryTransportPair } from "../src/transport/tls.js";

describe("RemoteClient", () => {
  it("connects, sends keys and voice, and accepts immediate Unicode text using TV counters", async () => {
    const server = createFakeGoogleTvServer({ imeCounter: 37, fieldCounter: 59 });
    const client = new RemoteClient({ transport: server.createRemoteTransport() });
    try {
      await client.connect();
      const accepted = once(server, "textAccepted");
      await client.text("こんにちは 🌍 café");
      await accepted;
      expect(server.acceptedText).toBe("こんにちは 🌍 café");
      expect(server.remoteMessages.find((message) => message.type === "text")).toEqual({
        type: "text",
        text: "こんにちは 🌍 café",
        imeCounter: 37,
        fieldCounter: 59,
      });
      const acceptedAgain = once(server, "textAccepted");
      await client.text("次の入力 🦊");
      await acceptedAgain;
      expect(server.acceptedText).toBe("次の入力 🦊");
      expect(server.remoteMessages.filter((message) => message.type === "text").at(-1)).toEqual({
        type: "text",
        text: "次の入力 🦊",
        imeCounter: 37,
        fieldCounter: 60,
      });
      await client.command("home");
      const voice = await client.voiceBegin();
      expect(voice).toEqual({ sessionId: 100, packageName: "com.google.android.katniss" });
      const ended = nextRemoteMessage(
        server,
        (message) => message.type === "voice" && message.phase === "end",
      );
      await client.voiceStreamPcm(Uint8Array.from([1, 2, 3]), { chunkDelayMs: 0 });
      await client.voiceEnd();
      await ended;
      expect(server.remoteMessages.filter((message) => message.type === "voice")).toEqual([
        { type: "voice", phase: "begin", sessionId: 100 },
        {
          type: "voice",
          phase: "payload",
          sessionId: 100,
          payload: padded(Uint8Array.from([1, 2, 3]), 8 * 1024),
        },
        { type: "voice", phase: "end", sessionId: 100 },
      ]);
    } finally {
      await client.close();
    }
  });

  it.each([
    [71, 93],
    [0, 0],
  ])(
    "waits for deliberately delayed IME metadata (%i, %i) without blocking keys",
    async (imeCounter, fieldCounter) => {
      const server = createFakeGoogleTvServer({ delayImeMetadata: true });
      const client = new RemoteClient({ transport: server.createRemoteTransport() });
      try {
        await client.connect();
        const text = client.text("漢字 🐈");
        const key = nextRemoteMessage(server, (message) => message.type === "key");
        await client.command("home");
        await key;
        expect(server.remoteMessages.some((message) => message.type === "text")).toBe(false);
        const accepted = once(server, "textAccepted");
        await server.sendImeMetadata(imeCounter, fieldCounter);
        await text;
        await accepted;
        expect(server.acceptedText).toBe("漢字 🐈");
        expect(server.remoteMessages.find((message) => message.type === "text")).toEqual({
          type: "text",
          text: "漢字 🐈",
          imeCounter,
          fieldCounter,
        });
      } finally {
        await client.close();
      }
    },
  );

  it("rejects pending text on remote closure and uses fresh metadata on reconnect", async () => {
    const server = createFakeGoogleTvServer({ delayImeMetadata: true });
    const client = new RemoteClient({ transport: server.createRemoteTransport() });
    try {
      await client.connect();
      const rejected = expect(client.text("old pending text")).rejects.toThrow(
        "remote connection closed",
      );
      const closed = once(client, "close");
      await server.closeRemoteConnection();
      await closed;
      await rejected;
      await client.connect();
      const text = client.text("新しい接続 🌱");
      const key = nextRemoteMessage(server, (message) => message.type === "key");
      await client.command("home");
      await key;
      expect(server.remoteMessages.some((message) => message.type === "text")).toBe(false);
      const accepted = once(server, "textAccepted");
      await server.sendImeMetadata(101, 203);
      await text;
      await accepted;
      expect(server.remoteMessages.find((message) => message.type === "text")).toEqual({
        type: "text",
        text: "新しい接続 🌱",
        imeCounter: 101,
        fieldCounter: 203,
      });
    } finally {
      await client.close();
    }
  });

  it("invalidates previously usable IME metadata on an explicit close and reconnect", async () => {
    const server = createFakeGoogleTvServer({ delayImeMetadata: true });
    const client = new RemoteClient({ transport: server.createRemoteTransport() });
    try {
      await client.connect();
      await server.sendImeMetadata(8, 9);
      const accepted = once(server, "textAccepted");
      await client.text("first");
      await accepted;
      await client.close();
      // Late frames while disconnected cannot populate the next connection's cache.
      await server.sendImeMetadata(11, 12);
      await client.connect();
      const pending = client.text("second");
      const key = nextRemoteMessage(server, (message) => message.type === "key");
      await client.command("home");
      await key;
      expect(server.remoteMessages.filter((message) => message.type === "text")).toHaveLength(1);
      const acceptedAgain = once(server, "textAccepted");
      await server.sendImeMetadata(88, 99);
      await pending;
      await acceptedAgain;
      expect(server.remoteMessages.filter((message) => message.type === "text").at(-1)).toEqual({
        type: "text",
        text: "second",
        imeCounter: 88,
        fieldCounter: 99,
      });
    } finally {
      await client.close();
    }
  });

  it("keeps key-only connections usable and fails text clearly without transmitting it", async () => {
    const server = createFakeGoogleTvServer({
      remoteFeatures: RemoteFeatures.key | RemoteFeatures.ping,
    });
    const client = new RemoteClient({ transport: server.createRemoteTransport() });
    try {
      await client.connect();
      await expect(client.text("unsupported")).rejects.toThrow(
        "did not advertise text input support",
      );
      const key = nextRemoteMessage(server, (message) => message.type === "key");
      await client.command("home");
      await key;
      expect(server.remoteMessages.some((message) => message.type === "text")).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects text after the existing five-second metadata timeout without sending defaults", async () => {
    vi.useFakeTimers();
    const server = createFakeGoogleTvServer({ delayImeMetadata: true });
    const client = new RemoteClient({ transport: server.createRemoteTransport() });
    try {
      await client.connect();
      const rejected = expect(client.text("missing metadata")).rejects.toThrow(
        "timed out waiting for Android TV text input metadata",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(server.remoteMessages.some((message) => message.type === "text")).toBe(false);
    } finally {
      await client.close();
      vi.useRealTimers();
    }
  });

  it("rejects pending text on transport errors and discards metadata", async () => {
    const [transport, tv] = createMemoryTransportPair();
    await tv.connect();
    const client = new RemoteClient({ transport });
    client.on("error", () => {});
    transport.on("connect", () => {
      void tv.send(
        encodeRemoteMessage({
          type: "configure",
          features: RemoteFeatures.key | RemoteFeatures.ime,
        }),
      );
      void tv.send(encodeRemoteMessage({ type: "ready", started: true }));
    });
    try {
      await client.connect();
      const failure = new Error("transport failed");
      const rejected = expect(client.text("pending")).rejects.toBe(failure);
      transport.emit("error", failure);
      await rejected;
      await expect(client.text("after failure")).rejects.toThrow("not connected");
    } finally {
      await client.close();
      await tv.close();
    }
  });
});

async function nextRemoteMessage(
  server: FakeGoogleTvServer,
  predicate: (message: RemoteMessage) => boolean,
): Promise<RemoteMessage> {
  for (;;) {
    const [message] = (await once(server, "remoteMessage")) as [RemoteMessage];
    if (predicate(message)) return message;
  }
}

function padded(input: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  output.set(input);
  return output;
}
