// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real loopback listener.
import { describe, expect, it } from "vite-plus/test";

import { openGitHubAppManifestPage, renderManifestPostPage } from "./GitHubAppManifestPage.ts";

const form = {
  action: "https://github.com/settings/apps/new?state=abc",
  manifest: JSON.stringify({ name: 'T3 "Code"', url: "https://t3.codes" }),
};

describe("GitHub App manifest page", () => {
  it("serves one page that posts the manifest to GitHub, then closes", async () => {
    let opened: string | null = null;
    let body = "";
    await openGitHubAppManifestPage(form, async (url) => {
      opened = url;
      const response = await fetch(url);
      expect(response.headers.get("cache-control")).toBe("no-store");
      body = await response.text();
      return true;
    });
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(body).toContain('action="https://github.com/settings/apps/new?state=abc"');
    const escaped = form.manifest.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    expect(body).toContain(`name="manifest" value="${escaped}"`);
    expect(body).not.toContain(form.manifest);
    await expect(fetch(opened!)).rejects.toThrow();
  });

  it("refuses to post anywhere but GitHub's manifest endpoint", async () => {
    await expect(
      openGitHubAppManifestPage(
        { ...form, action: "https://evil.example/apps/new" },
        async () => true,
      ),
    ).rejects.toThrow("manifest form");
    expect(renderManifestPostPage(form)).toContain('<form method="post"');
  });

  it("fails when the browser cannot be opened", async () => {
    await expect(openGitHubAppManifestPage(form, async () => false)).rejects.toThrow("browser");
  });
});
