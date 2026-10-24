import { isLoopbackHost } from "./preview.ts";

const SETTINGS_KEYS = ["machine", "project", "checkout", "environmentId", "instanceId"];
/** GitHub sends the browser back here after creating, installing, or authorizing the sandbox App. */
const GITHUB_CALLBACK_PATH_PREFIX = "/settings/sandboxes/github/callback/";
const GITHUB_CALLBACK_KEYS = ["code", "state", "installation_id", "setup_action"];

export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || url.origin === "https://app.t3.codes");
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    const allowedKeys = url.pathname.startsWith(GITHUB_CALLBACK_PATH_PREFIX)
      ? GITHUB_CALLBACK_KEYS
      : SETTINGS_KEYS;
    for (const key of Array.from(url.searchParams.keys())) {
      if (url.pathname === "/welcome" || !allowedKeys.includes(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
