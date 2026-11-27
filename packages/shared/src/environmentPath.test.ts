import { describe, expect, it } from "vite-plus/test";

import {
  extractVirtualEnvironmentBasePath,
  joinEnvironmentPath,
  stripVirtualEnvironmentPrefix,
  toEnvironmentWsUrl,
} from "./environmentPath.ts";
import { resolveRemotePairingTarget } from "./remote.ts";
import { createAdvertisedEndpoint } from "./advertisedEndpoint.ts";

describe("environmentPath", () => {
  it("extracts and strips virtual environment base paths", () => {
    expect(extractVirtualEnvironmentBasePath("/")).toBe("");
    expect(extractVirtualEnvironmentBasePath("/_env/env_123")).toBe("/_env/env_123");
    expect(extractVirtualEnvironmentBasePath("/_env/env_123/api/auth/session")).toBe(
      "/_env/env_123",
    );
    expect(stripVirtualEnvironmentPrefix("/_env/env_123/.well-known/t3/environment")).toEqual({
      environmentId: "env_123",
      innerPath: "/.well-known/t3/environment",
    });
    expect(stripVirtualEnvironmentPrefix("/_env/env_123")).toEqual({
      environmentId: "env_123",
      innerPath: "/",
    });
    expect(stripVirtualEnvironmentPrefix("/api/health")).toBeNull();
  });

  it("joins paths under /_env/<id> without clobbering or double-prefixing", () => {
    expect(joinEnvironmentPath("https://hub.example.com/", "/oauth/token")).toBe(
      "https://hub.example.com/oauth/token",
    );
    expect(joinEnvironmentPath("https://hub.example.com/_env/env_123", "/oauth/token")).toBe(
      "https://hub.example.com/_env/env_123/oauth/token",
    );
    expect(joinEnvironmentPath("https://hub.example.com/_env/env_123/", "/_env/env_123/mcp")).toBe(
      "https://hub.example.com/_env/env_123/mcp",
    );
    expect(
      joinEnvironmentPath("https://hub.example.com/_env/env_123", "/api/assets/a1?sig=ok", {
        preserveSearchAndHash: true,
      }),
    ).toBe("https://hub.example.com/_env/env_123/api/assets/a1?sig=ok");
    // Cross-origin fallback URLs must pass through untouched.
    expect(
      joinEnvironmentPath(
        "https://hub.example.com/_env/env_123",
        "http://127.0.0.1:3773/api/assets/a1?sig=ok",
        { preserveSearchAndHash: true },
      ),
    ).toBe("http://127.0.0.1:3773/api/assets/a1?sig=ok");
  });

  it("resolves WebSocket URLs cleanly under /_env/<id> and internal fleet bridges", () => {
    expect(toEnvironmentWsUrl("wss://hub.example.com/_env/env_123/", "/ws").toString()).toBe(
      "wss://hub.example.com/_env/env_123/ws",
    );
    expect(
      toEnvironmentWsUrl("https://hub.example.com/_env/env_123", "/api/preview/tunnel").toString(),
    ).toBe("wss://hub.example.com/_env/env_123/api/preview/tunnel");
    expect(
      toEnvironmentWsUrl("http://127.0.0.1:59051/_fleet/internal/sec_1/env_2", "/ws").toString(),
    ).toBe("ws://127.0.0.1:59051/_fleet/internal/sec_1/env_2/ws");
    expect(
      toEnvironmentWsUrl("http://127.0.0.1:59051/_fleet/internal/sec_1/env_2/", "/ws").toString(),
    ).toBe("ws://127.0.0.1:59051/_fleet/internal/sec_1/env_2/ws");
    expect(toEnvironmentWsUrl("ws://127.0.0.1:3773/ws", "/ws").toString()).toBe(
      "ws://127.0.0.1:3773/ws",
    );
  });

  it("preserves /_env/<id> across resolveRemotePairingTarget and createAdvertisedEndpoint", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://hub.example.com/_env/env_123/pair#token=t1",
      }),
    ).toEqual({
      credential: "t1",
      httpBaseUrl: "https://hub.example.com/_env/env_123/",
      wsBaseUrl: "wss://hub.example.com/_env/env_123/",
    });

    const advertised = createAdvertisedEndpoint({
      id: "e1",
      label: "Sandbox",
      provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
      httpBaseUrl: "https://hub.example.com/_env/env_123",
      reachability: "public",
      source: "desktop-core",
    });
    expect(advertised.httpBaseUrl).toBe("https://hub.example.com/_env/env_123/");
    expect(advertised.wsBaseUrl).toBe("wss://hub.example.com/_env/env_123/");
  });
});
