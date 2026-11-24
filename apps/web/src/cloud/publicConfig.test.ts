import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveRelayTracingConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  describe("browser origins", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    });

    it.each(["https://example.com", "https://nightly.app.example.com:443"])(
      "enables production auth on the configured root and subdomains: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(true);
      },
    );

    it.each(["http://localhost:3773", "https://machine.example.ts.net"])(
      "disables production auth on private browser origins: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["http://app.example.com:443", "https://app.example.com:3773"])(
      "rejects unsupported schemes and ports even on the configured domain: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each(["https://notexample.com", "https://example.com.evil.test"])(
      "rejects domain lookalikes: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasCloudPublicConfig()).toBe(false);
      },
    );

    it.each([
      ["https://tenant.clerk.accounts.dev", true],
      ["https://other.clerk.accounts.dev", false],
    ])("keeps a provider hostname scoped to its own instance: %s", (origin, expected) => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("tenant.clerk.accounts.dev$")}`);
      vi.stubGlobal("window", { location: new URL(origin) });

      expect(hasCloudPublicConfig()).toBe(expected);
    });

    it("keeps production keys available in the Electron auth shell", () => {
      vi.stubGlobal("window", { location: new URL("file:///app/index.html"), desktopBridge: {} });

      expect(hasCloudPublicConfig()).toBe(true);
    });
  });
});

describe("resolveRelayTracingConfig", () => {
  it("stays off until a receiver is configured", () => {
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "");

    expect(resolveRelayTracingConfig()).toBeNull();
  });

  it("exports to a generic OTLP receiver with only a URL", () => {
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://otel.example.test/v1/traces");

    expect(resolveRelayTracingConfig()).toEqual({
      tracesUrl: "https://otel.example.test/v1/traces",
    });
  });

  it("sends custom OTLP headers and fails closed when they are malformed", () => {
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://otel.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_HEADERS", "x-api-key=web%20key");

    expect(resolveRelayTracingConfig()).toEqual({
      tracesUrl: "https://otel.example.test/v1/traces",
      tracesHeaders: { "x-api-key": "web key" },
    });

    vi.stubEnv("VITE_RELAY_OTLP_TRACES_HEADERS", "x-api-key");
    expect(resolveRelayTracingConfig()).toBeNull();
  });
});
