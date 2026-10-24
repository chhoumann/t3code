// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
import * as NodeHttp from "node:http";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A page whose only job is to POST the manifest to GitHub, as GitHub's manifest flow requires. */
export const renderManifestPostPage = (form: {
  readonly action: string;
  readonly manifest: string;
}) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Continuing on GitHub</h1><p>If GitHub does not open, press the button.</p><form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="manifest" value="${escapeHtml(form.manifest)}"><button type="submit">Create GitHub App</button></form></main><script>document.forms[0].submit()</script></body></html>`;

const isGitHubManifestAction = (action: string) => {
  if (!URL.canParse(action)) return false;
  const url = new URL(action);
  return url.origin === "https://github.com" && url.pathname === "/settings/apps/new";
};

/**
 * Serves the manifest form once on the loopback interface and opens it in the
 * system browser, which posts it to GitHub. The listener closes after the
 * page is fetched, or after five minutes.
 */
export async function openGitHubAppManifestPage(
  form: { readonly action: string; readonly manifest: string },
  openBrowser: (url: string) => Promise<boolean>,
): Promise<void> {
  if (!isGitHubManifestAction(form.action)) throw new Error("Not a GitHub App manifest form.");
  const page = renderManifestPostPage(form);
  const served = Promise.withResolvers<void>();
  void served.promise.catch(() => undefined);
  const server = NodeHttp.createServer((incoming, response) => {
    if (incoming.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    served.resolve();
  });
  const timer = setTimeout(
    () => served.reject(new Error("GitHub did not open within five minutes.")),
    300_000,
  );
  timer.unref();
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("address"));
        else resolve(address.port);
      });
    });
    if (!(await openBrowser(`http://127.0.0.1:${port}/`)))
      throw new Error("Could not open your browser.");
    await served.promise;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
