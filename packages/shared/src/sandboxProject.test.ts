import {
  SandboxAccountId,
  SandboxRemoteUrl,
  SourceControlProviderKind,
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveSandboxProjectDefaults,
  sandboxProjectKey,
  sandboxProjectTitle,
  sandboxRemoteUrl,
  sandboxRepositoryIdentity,
  sandboxSourceForProject,
} from "./sandboxProject.ts";
import {
  normalizeGitRemoteUrl,
  repositoryIdentityFromRemotes,
  type RemoteRecognizer,
} from "./git.ts";

const recognizer: RemoteRecognizer = {
  recognizeRemote: (remoteUrl) =>
    normalizeGitRemoteUrl(remoteUrl).startsWith("github.com/")
      ? {
          kind: SourceControlProviderKind.make("github"),
          name: "GitHub",
          baseUrl: "https://github.com",
        }
      : null,
  repositoryKeyFromRemote: normalizeGitRemoteUrl,
};

const account = { size: "small" as const, stopAfterHours: 2 };
const PROJECT = "https://github.com/pingdotgg/t3code.git";
const FORK = "git@github.com:chhoumann/t3code.git";
const FORK_HTTPS = SandboxRemoteUrl.make("https://github.com/chhoumann/t3code.git");
const defaultBase = { _tag: "default" } as const;

/** What a checkout's enrichment reports for these remotes. */
const checkout = (remotes: ReadonlyArray<{ name: string; url: string }>): RepositoryIdentity => {
  const [first, ...rest] = remotes;
  return repositoryIdentityFromRemotes([first!, ...rest], recognizer);
};

describe("sandbox project defaults", () => {
  it("shares a repository binding across SSH and HTTPS without crossing accounts", () => {
    const personal = SandboxAccountId.make("personal");
    const work = SandboxAccountId.make("work");
    const key = sandboxProjectKey(
      personal,
      "https://github.com/chhoumann/quickadd.git",
      recognizer,
    );
    expect(sandboxProjectKey(personal, "git@github.com:chhoumann/quickadd.git", recognizer)).toBe(
      key,
    );
    expect(
      sandboxProjectKey(work, "https://github.com/chhoumann/quickadd.git", recognizer),
    ).not.toBe(key);
  });

  it("keys a project's settings, which hold its canonical key, like a launch from its remote", () => {
    const personal = SandboxAccountId.make("personal");
    expect(sandboxProjectKey(personal, "github.com/chhoumann/quickadd", recognizer)).toBe(
      '["personal","github.com/chhoumann/quickadd"]',
    );
    expect(sandboxProjectKey(personal, "git@github.com:chhoumann/QuickAdd.git", recognizer)).toBe(
      '["personal","github.com/chhoumann/quickadd"]',
    );
  });

  it("inherits account defaults while allowing an explicit unlimited lifetime", () => {
    expect(resolveSandboxProjectDefaults(account, undefined)).toEqual({
      template: null,
      size: "small",
      stopAfterHours: 2,
    });
    expect(
      resolveSandboxProjectDefaults(account, { template: "quickadd", stopAfterHours: null }),
    ).toEqual({
      template: "quickadd",
      size: "small",
      stopAfterHours: null,
    });
  });
});

describe("sandboxRemoteUrl", () => {
  it.each([
    [
      "an SSH remote",
      "git@github.com:chhoumann/t3code.git",
      "https://github.com/chhoumann/t3code.git",
    ],
    [
      "an ssh:// remote",
      "ssh://git@github.com/chhoumann/t3code.git",
      "https://github.com/chhoumann/t3code.git",
    ],
    [
      "an HTTPS remote",
      "https://github.com/chhoumann/t3code",
      "https://github.com/chhoumann/t3code",
    ],
    [
      "a trailing slash",
      "https://github.com/chhoumann/t3code/",
      "https://github.com/chhoumann/t3code",
    ],
    [
      "embedded credentials",
      "https://user:token@github.com/chhoumann/t3code.git",
      "https://github.com/chhoumann/t3code.git",
    ],
  ])("clones %s over HTTPS", (_, url, expected) => {
    expect(sandboxRemoteUrl(url)).toBe(expected);
  });

  it.each([
    ["a local path", "/home/user/projects/t3code"],
    ["a custom SSH port", "ssh://git@github.com:2222/chhoumann/t3code.git"],
  ])("has no HTTPS form for %s", (_, url) => {
    expect(sandboxRemoteUrl(url)).toBeNull();
  });
});

describe("sandboxSourceForProject", () => {
  it("clones a plain checkout's remote at the default branch, whatever the checkout's state", () => {
    expect(sandboxSourceForProject(checkout([{ name: "origin", url: FORK }]))).toEqual({
      remoteUrl: FORK_HTTPS,
      base: defaultBase,
    });
  });

  it("clones the fork that is origin, which the checkout groups under", () => {
    const identity = checkout([
      { name: "origin", url: FORK },
      { name: "upstream", url: PROJECT },
    ]);
    const source = sandboxSourceForProject(identity);
    expect(source).toEqual({ remoteUrl: FORK_HTTPS, base: defaultBase });
    expect(sandboxRepositoryIdentity(source!, recognizer).canonicalKey).toBe(
      repositoryGroupingKeyOf(identity),
    );
  });

  it("clones the project when origin is the project and a fork is another remote", () => {
    const identity = checkout([
      { name: "fork", url: FORK },
      { name: "origin", url: PROJECT },
    ]);
    const source = sandboxSourceForProject(identity);
    expect(source?.remoteUrl).toBe(PROJECT);
    expect(sandboxRepositoryIdentity(source!, recognizer).canonicalKey).toBe(
      repositoryGroupingKeyOf(identity),
    );
  });

  it("has no source without a repository or a cloneable remote", () => {
    expect(sandboxSourceForProject(null)).toBeNull();
    expect(
      sandboxSourceForProject(checkout([{ name: "origin", url: "/srv/git/t3code" }])),
    ).toBeNull();
  });
});

describe("sandboxRepositoryIdentity", () => {
  it("names the project after the repository and identifies it by its one remote", () => {
    const identity = sandboxRepositoryIdentity(
      {
        remoteUrl: SandboxRemoteUrl.make("https://github.com/octocat/Hello-World.git"),
        base: defaultBase,
      },
      recognizer,
    );
    expect(identity).toEqual({
      canonicalKey: "github.com/octocat/hello-world",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/octocat/Hello-World.git",
      },
      displayName: "octocat/Hello-World",
      provider: "github",
      owner: "octocat",
      name: "Hello-World",
    });
    expect(sandboxProjectTitle(identity)).toBe("Hello-World");
  });
});
