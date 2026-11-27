const VIRTUAL_ENVIRONMENT_PATH_PATTERN = /^(\/_env\/[A-Za-z0-9_-]+)(?:\/(.*))?$/;
const INTERNAL_FLEET_BRIDGE_PATH_PATTERN =
  /^(\/_fleet\/internal\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)(?:\/(.*))?$/;

export function extractVirtualEnvironmentBasePath(pathname: string): string {
  const match = VIRTUAL_ENVIRONMENT_PATH_PATTERN.exec(pathname);
  return match?.[1] ?? "";
}

export function stripVirtualEnvironmentPrefix(
  pathname: string,
): { readonly environmentId: string; readonly innerPath: string } | null {
  const match = /^\/_env\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (match?.[1] === undefined) {
    return null;
  }
  const rest = match[2];
  return {
    environmentId: match[1],
    innerPath: rest !== undefined && rest.length > 0 ? rest : "/",
  };
}

export function joinEnvironmentPath(
  baseUrl: string,
  pathnameOrRelative: string,
  options?: { readonly preserveSearchAndHash?: boolean },
): string {
  const base = new URL(baseUrl);
  const basePath = extractVirtualEnvironmentBasePath(base.pathname);
  const resolved = new URL(pathnameOrRelative, base.origin);
  if (resolved.origin !== base.origin) {
    return resolved.toString();
  }
  if (resolved.pathname === "/") {
    resolved.pathname = basePath === "" ? "/" : `${basePath}/`;
  } else if (
    basePath !== "" &&
    resolved.pathname !== basePath &&
    !resolved.pathname.startsWith(`${basePath}/`)
  ) {
    resolved.pathname = `${basePath}${resolved.pathname}`;
  }
  if (options?.preserveSearchAndHash !== true) {
    resolved.search = "";
    resolved.hash = "";
  }
  return resolved.toString();
}

export function normalizeEnvironmentBasePath(url: URL, trailingSlash: boolean): string {
  const basePath =
    extractVirtualEnvironmentBasePath(url.pathname) ||
    (INTERNAL_FLEET_BRIDGE_PATH_PATTERN.exec(url.pathname)?.[1] ?? "");
  url.pathname = basePath === "" ? "/" : trailingSlash ? `${basePath}/` : basePath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function toEnvironmentWsUrl(wsBaseUrl: string, wsSubpath = "/ws"): URL {
  const url = new URL(wsBaseUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  const basePath =
    extractVirtualEnvironmentBasePath(url.pathname) ||
    (INTERNAL_FLEET_BRIDGE_PATH_PATTERN.exec(url.pathname)?.[1] ?? "");
  if (
    url.pathname === "" ||
    url.pathname === "/" ||
    (basePath !== "" && (url.pathname === basePath || url.pathname === `${basePath}/`))
  ) {
    url.pathname = `${basePath}${wsSubpath}`;
  }
  return url;
}
