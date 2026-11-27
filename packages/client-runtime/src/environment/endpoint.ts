import { joinEnvironmentPath } from "@t3tools/shared/environmentPath";

export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  joinEnvironmentPath(httpBaseUrl, pathname);
