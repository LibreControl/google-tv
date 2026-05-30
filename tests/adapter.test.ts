import { describe, expect, it } from "vitest";
import { GoogleTvAdapter, createGoogleTv } from "../src/adapter/GoogleTvAdapter.js";

describe("GoogleTvAdapter", () => {
  it("creates Google TV device facades", () => {
    const adapter = new GoogleTvAdapter();
    const device = adapter.createDevice({ host: "192.168.1.10", name: "Living Room" });

    expect(adapter.id).toBe("google");
    expect(device.id).toBe("192.168.1.10");
    expect(device.name).toBe("Living Room");
  });

  it("creates devices from the convenience factory", () => {
    const device = createGoogleTv({ host: "192.168.1.11" });

    expect(device.name).toBe("Google TV 192.168.1.11");
  });
});
