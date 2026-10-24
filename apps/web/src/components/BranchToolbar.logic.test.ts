import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  EnvironmentId,
  SandboxAccountId,
  type SandboxAccountConfig,
  SandboxBranchName,
  SandboxRemoteUrl,
  type VcsRef,
} from "@t3tools/contracts";
import { repositoryIdentityFromRemotes } from "@t3tools/shared/git";
import { describe, expect, it } from "vite-plus/test";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  deriveSandboxRunChoices,
  resolveSandboxDraftSend,
  resolveSandboxDraftSource,
  sandboxBaseSuggestions,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveLocalCheckoutBranchMismatch,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarPrBranch", () => {
  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("keeps a server thread in worktree mode while its worktree is still being created", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
        preparingWorktree: true,
      }),
    ).toBe("worktree");
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
      }),
    ).toBe("local");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "new-branch",
        normalizedQuery: "new branch",
        createBranchItemValue: null,
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });
});

describe("sanitizeNewRefName", () => {
  it("collapses a run of whitespace into a single dash", () => {
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
  });

  it("replaces tabs, which git rejects just like spaces", () => {
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
    expect(sanitizeNewRefName("new\u2009branch")).toBe("new\u2009branch");
  });

  it("does not collapse dashes the user typed", () => {
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });
});

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("deriveSandboxRunChoices", () => {
  const account = (label: string): SandboxAccountConfig => ({
    label,
    provider: "boat",
    providerEnvironment: null,
    size: "small",
    stopAfterHours: 8,
    machineSetupScript: null,
    env: [],
  });
  const owner = (
    environmentId: EnvironmentId,
    label: string,
    accounts: Record<string, SandboxAccountConfig>,
    sandboxes = true,
  ) => ({
    environmentId,
    label,
    serverConfig: {
      environment: { capabilities: { sandboxes } },
      settings: { sandboxAccounts: accounts },
    },
  });

  it("offers one entry per account, without naming a sole owner", () => {
    expect(
      deriveSandboxRunChoices([
        owner(localEnvironmentId, "This device", {
          work: account("Work"),
          personal: account("Personal"),
        }),
        owner(remoteEnvironmentId, "Build box", {}),
      ]).map((choice) => choice.label),
    ).toEqual(["New sandbox · Personal", "New sandbox · Work"]);
  });

  it("names the owner when several environments offer accounts", () => {
    const choices = deriveSandboxRunChoices([
      owner(localEnvironmentId, "This device", { work: account("Work") }),
      owner(remoteEnvironmentId, "Build box", { work: account("Work") }),
    ]);
    expect(choices.map((choice) => choice.label)).toEqual([
      "New sandbox · Work on This device",
      "New sandbox · Work on Build box",
    ]);
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(2);
    expect(choices[1]).toMatchObject({
      ownerEnvironmentId: remoteEnvironmentId,
      accountId: SandboxAccountId.make("work"),
    });
  });

  it("skips environments that do not serve sandboxes", () => {
    expect(
      deriveSandboxRunChoices([
        owner(localEnvironmentId, "This device", { work: account("Work") }, false),
      ]),
    ).toEqual([]);
  });
});

describe("resolveSandboxDraftSend", () => {
  const owner = EnvironmentId.make("environment-owner");
  const work = SandboxAccountId.make("work");
  const choice = {
    value: `sandbox:${owner}:${work}`,
    ownerEnvironmentId: owner,
    accountId: work,
    label: "New sandbox · Work",
  };

  it("launches the picked sandbox while its owner offers the account", () => {
    expect(
      resolveSandboxDraftSend({ ownerEnvironmentId: owner, accountId: work }, [choice]),
    ).toEqual({ _tag: "Sandbox", choice });
  });

  it("refuses rather than runs locally while the picked owner is unavailable", () => {
    expect(resolveSandboxDraftSend({ ownerEnvironmentId: owner, accountId: work }, [])).toEqual({
      _tag: "Unavailable",
    });
  });

  it("sends a draft that picked no sandbox in its own environment", () => {
    expect(resolveSandboxDraftSend(null, [choice])).toEqual({ _tag: "Environment" });
  });
});

describe("resolveSandboxDraftSource", () => {
  const checkout = repositoryIdentityFromRemotes(
    [{ name: "origin", url: "https://github.com/Example/App.git" }],
    sourceControlClients,
  );
  const other = SandboxRemoteUrl.make("https://github.com/Example/Other.git");
  const release = { _tag: "branch" as const, name: SandboxBranchName.make("release") };

  it("clones the project's remote from the default branch", () => {
    expect(resolveSandboxDraftSource({}, checkout)).toEqual({
      remoteUrl: "https://github.com/Example/App.git",
      base: { _tag: "default" },
    });
  });

  it("clones the repository the draft names instead of its project's, from its base", () => {
    expect(resolveSandboxDraftSource({ remoteUrl: other, base: release }, checkout)).toEqual({
      remoteUrl: other,
      base: release,
    });
  });

  it("has no source for a project without a remote until the draft names a repository", () => {
    expect(resolveSandboxDraftSource({ base: release }, null)).toBeNull();
    expect(resolveSandboxDraftSource({ remoteUrl: other }, null)).toEqual({
      remoteUrl: other,
      base: { _tag: "default" },
    });
  });
});

describe("sandboxBaseSuggestions", () => {
  const ref = (name: string, remoteName?: string): VcsRef => ({
    name,
    current: false,
    isDefault: false,
    worktreePath: null,
    isRemote: remoteName !== undefined,
    ...(remoteName === undefined ? {} : { remoteName }),
  });
  const refs = [
    ref("main"),
    ref("local-only"),
    ref("origin/main", "origin"),
    ref("origin/feature/login", "origin"),
    ref("upstream/release", "upstream"),
  ];

  it("offers the branches of the remote the sandbox clones, by name", () => {
    const plain = repositoryIdentityFromRemotes(
      [{ name: "origin", url: "https://github.com/Example/App.git" }],
      sourceControlClients,
    );
    expect(sandboxBaseSuggestions(refs, plain)).toEqual(["main", "feature/login"]);
  });

  it("offers a fork's own branches, not its upstream's", () => {
    const fork = repositoryIdentityFromRemotes(
      [
        { name: "upstream", url: "https://github.com/Example/App.git" },
        { name: "origin", url: "https://github.com/Me/App.git" },
      ],
      sourceControlClients,
    );
    expect(sandboxBaseSuggestions(refs, fork)).toEqual(["main", "feature/login"]);
  });

  it("offers the sole remote's branches whatever it is named", () => {
    const upstreamOnly = repositoryIdentityFromRemotes(
      [{ name: "upstream", url: "https://github.com/Example/App.git" }],
      sourceControlClients,
    );
    expect(sandboxBaseSuggestions(refs, upstreamOnly)).toEqual(["release"]);
  });
});
