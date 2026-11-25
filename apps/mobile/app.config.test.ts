import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_RELAY_URL: process.env.TEST_RELAY_URL,
    EXPO_PUBLIC_MOBILE_OBSERVE_ENDPOINT_URL: process.env.TEST_OBSERVE_ENDPOINT_URL,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  [undefined, undefined, null, "https://observe.invalid"],
  [
    "https://relay.example.test",
    undefined,
    "https://relay.example.test/v1/mobile/observe",
    "https://relay.example.test/v1/mobile/observe",
  ],
  [
    "https://relay.example.test",
    "https://crashes.example.test/observe",
    "https://crashes.example.test/observe",
    "https://crashes.example.test/observe",
  ],
])(
  "sends crash reports to the configured endpoint (relay %j, explicit %j)",
  async (relayUrl, explicitUrl, exposed, compiled) => {
    vi.stubEnv("TEST_RELAY_URL", relayUrl);
    vi.stubEnv("TEST_OBSERVE_ENDPOINT_URL", explicitUrl);
    const config = await loadConfig(undefined);
    expect(config.extra?.observability?.observeEndpointUrl).toBe(exposed);
    expect(config.extra?.eas?.observe?.endpointUrl).toBe(compiled);
  },
);

it("ships no trace receiver unless one is configured", async () => {
  const config = await loadConfig(undefined);
  expect(config.extra?.observability?.tracesUrl).toBeNull();
});
