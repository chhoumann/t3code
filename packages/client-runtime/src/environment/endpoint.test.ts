import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("preserves /_env/<id> path prefixes when normalizing and joining endpoint URLs", () => {
    expect(normalizeHttpBaseUrl("https://hub.example.com/_env/env_1/pair?x=1")).toBe(
      "https://hub.example.com/_env/env_1/",
    );
    expect(deriveWsBaseUrl("https://hub.example.com/_env/env_1/")).toBe(
      "wss://hub.example.com/_env/env_1/",
    );
    expect(environmentEndpointUrl("https://hub.example.com/_env/env_1/", "/oauth/token")).toBe(
      "https://hub.example.com/_env/env_1/oauth/token",
    );
  });
});
