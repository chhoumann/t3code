import { SandboxAccountId, repositoryGroupingKeyOf } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveSandboxProjectDefaults,
  sandboxProject,
  sandboxProjectKey,
} from "./sandboxProject.ts";

const account = { size: "small" as const, stopAfterHours: 2 };

describe("sandbox project defaults", () => {
  it("shares a repository binding across SSH and HTTPS without crossing accounts", () => {
    const personal = SandboxAccountId.make("personal");
    const work = SandboxAccountId.make("work");
    const key = sandboxProjectKey(personal, "https://github.com/chhoumann/quickadd.git");
    expect(sandboxProjectKey(personal, "git@github.com:chhoumann/quickadd.git")).toBe(key);
    expect(sandboxProjectKey(work, "https://github.com/chhoumann/quickadd.git")).not.toBe(key);
  });

  it("keys a project's settings, which hold its canonical key, like a launch from its remote", () => {
    const personal = SandboxAccountId.make("personal");
    expect(sandboxProjectKey(personal, "github.com/chhoumann/quickadd")).toBe(
      '["personal","github.com/chhoumann/quickadd"]',
    );
    expect(sandboxProjectKey(personal, "git@github.com:chhoumann/QuickAdd.git")).toBe(
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

describe("sandboxProject", () => {
  const PROJECT = "https://github.com/pingdotgg/t3code.git";
  const FORK = "git@github.com:chhoumann/t3code.git";

  it("names the project after its checkout and identifies it by its only remote", () => {
    expect(
      sandboxProject({
        remotes: [{ name: "origin", url: "https://github.com/octocat/Hello-World.git" }],
        trackedRemote: "origin",
        commit: null,
      }),
    ).toEqual({
      title: "Hello-World",
      repositoryIdentity: {
        canonicalKey: "github.com/octocat/hello-world",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/octocat/Hello-World.git",
        },
        displayName: "octocat/hello-world",
        provider: "github",
        owner: "octocat",
        name: "hello-world",
      },
    });
  });

  it("groups a launch from a fork-tracking branch with a checkout whose origin is the project", () => {
    const project = sandboxProject({
      remotes: [
        { name: "fork", url: FORK },
        { name: "origin", url: PROJECT },
      ],
      trackedRemote: "fork",
      commit: null,
    });
    expect(project.title).toBe("t3code");
    expect(project.repositoryIdentity.canonicalKey).toBe("github.com/pingdotgg/t3code");
    expect(repositoryGroupingKeyOf(project.repositoryIdentity)).toBe("github.com/pingdotgg/t3code");
  });

  it("groups a launch from a fork that is origin with the fork, under the project's key", () => {
    const project = sandboxProject({
      remotes: [
        { name: "origin", url: FORK },
        { name: "upstream", url: PROJECT },
      ],
      trackedRemote: "origin",
      commit: null,
    });
    expect(project.title).toBe("t3code");
    expect(project.repositoryIdentity.canonicalKey).toBe("github.com/pingdotgg/t3code");
    expect(repositoryGroupingKeyOf(project.repositoryIdentity)).toBe("github.com/chhoumann/t3code");
  });
});
