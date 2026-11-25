// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// Each public value is read from the first non-empty alias and written back under every alias,
// so server (`T3CODE_*`), web (`VITE_*`), and mobile (`EXPO_PUBLIC_*`) builds see the same value.
const PUBLIC_CONFIG_ALIASES = {
  clerkPublishableKey: [
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ],
  clerkJwtTemplate: [
    "T3CODE_CLERK_JWT_TEMPLATE",
    "VITE_CLERK_JWT_TEMPLATE",
    "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  ],
  clerkCliOAuthClientId: ["T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "VITE_CLERK_CLI_OAUTH_CLIENT_ID"],
  relayUrl: ["T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"],
  posthogHost: ["T3CODE_POSTHOG_HOST"],
  posthogKey: ["T3CODE_POSTHOG_KEY"],
  mobileOtlpTracesUrl: ["T3CODE_MOBILE_OTLP_TRACES_URL", "EXPO_PUBLIC_OTLP_TRACES_URL"],
  mobileOtlpTracesDataset: ["T3CODE_MOBILE_OTLP_TRACES_DATASET", "EXPO_PUBLIC_OTLP_TRACES_DATASET"],
  mobileOtlpTracesToken: ["T3CODE_MOBILE_OTLP_TRACES_TOKEN", "EXPO_PUBLIC_OTLP_TRACES_TOKEN"],
  mobileOtlpTracesHeaders: ["T3CODE_MOBILE_OTLP_TRACES_HEADERS", "EXPO_PUBLIC_OTLP_TRACES_HEADERS"],
  mobileObserveEndpointUrl: [
    "T3CODE_MOBILE_OBSERVE_ENDPOINT_URL",
    "EXPO_PUBLIC_MOBILE_OBSERVE_ENDPOINT_URL",
  ],
  relayClientOtlpTracesUrl: ["T3CODE_RELAY_CLIENT_OTLP_TRACES_URL", "VITE_RELAY_OTLP_TRACES_URL"],
  relayClientOtlpTracesDataset: [
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
    "VITE_RELAY_OTLP_TRACES_DATASET",
  ],
  relayClientOtlpTracesToken: [
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
    "VITE_RELAY_OTLP_TRACES_TOKEN",
  ],
  relayClientOtlpTracesHeaders: [
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_HEADERS",
    "VITE_RELAY_OTLP_TRACES_HEADERS",
  ],
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const sources = [baseEnv, localEnv, rootEnv];
  const resolved: Record<string, string> = {};
  for (const names of Object.values(PUBLIC_CONFIG_ALIASES)) {
    const value = firstNonEmpty(sources, ...names);
    if (value) {
      for (const name of names) resolved[name] = value;
    }
  }

  return { ...rootEnv, ...localEnv, ...baseEnv, ...resolved };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
