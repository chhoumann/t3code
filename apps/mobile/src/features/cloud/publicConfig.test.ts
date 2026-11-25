import { describe, expect, it, vi } from "vite-plus/test";

import { resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
        tracesHeaders: null,
      },
    });
  });

  it("keeps HTTPS and loopback trace receivers and rejects remote plain HTTP", () => {
    const tracesUrl = (value: string) =>
      resolveCloudPublicConfig({ observability: { tracesUrl: value } }).observability.tracesUrl;

    expect(tracesUrl(" https://otel.example.test/v1/traces ")).toBe(
      "https://otel.example.test/v1/traces",
    );
    expect(tracesUrl("http://localhost:4318/v1/traces")).toBe("http://localhost:4318/v1/traces");
    expect(tracesUrl("http://otel.example.test/v1/traces")).toBeNull();
  });
});
