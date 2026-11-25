import Constants from "expo-constants";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { connectionTracesEnabled } from "./diagnosticsSetting";

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

const RELEASE_CHANNEL_BY_VARIANT: Readonly<Record<string, ReleaseChannel | undefined>> = {
  development: "dev",
  preview: "preview",
  production: "stable",
};

/** Any valid traces URL is enough; dataset, token, and headers are optional. */
export function resolveTracingConfig() {
  return RelayTracing.resolveRelayClientTracingConfig(resolveCloudPublicConfig().observability);
}

export function layerFromConfig(
  config: RelayTracing.RelayClientTracingConfig | null,
  resource: TracingResource,
) {
  const channel =
    typeof __DEV__ !== "undefined" && __DEV__
      ? "dev"
      : RELEASE_CHANNEL_BY_VARIANT[resource.appVariant];
  return RelayTracing.layer(
    config,
    {
      serviceName: "t3code-mobile",
      serviceVersion: resource.serviceVersion,
      runtime: "react-native",
      serviceInstanceId: resource.serviceInstanceId,
      client: `mobile-${resource.appVariant}`,
      attributes: channel && releaseResourceAttributes(channel),
    },
    { isEnabled: connectionTracesEnabled },
  );
}

export const layer = layerFromConfig(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  serviceInstanceId: Constants.sessionId,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
