import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  EnvironmentId,
  GitCommandError,
  ProviderInstanceId,
  RunId,
  SandboxAccountId,
  type SandboxAccountConfig,
  SandboxBranchName,
  SandboxRemoteUrl,
  type VcsRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  dedupeRemoteBranchesWithLocalMatches,
  repositoryIdentityFromRemotes,
} from "@t3tools/shared/git";
import {
  deriveLocalBranchNameFromRemoteRef,
  deriveSandboxRunChoices,
  isWorktreeChangeBlocked,
  resolveSandboxDraftSend,
  resolveSandboxDraftSource,
  sandboxBaseSuggestions,
  sandboxRepositoryChoice,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveConfirmedSelectedRef,
  resolveDefaultWorktreeBaseBranch,
  resolveLocalCheckoutBranchMismatch,
  resolveLockedWorkspaceLabel,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
  isBranchHoldCurrent,
  offersWorkspaceModes,
  toBranchActionErrorMessage,
} from "./BranchToolbar.logic";

describe("toBranchActionErrorMessage", () => {
  it("shows a Git failure's detail without the operation and cwd", () => {
    const error = new GitCommandError({
      operation: "GitVcsDriver.switchRef.checkout",
      command: "git",
      cwd: "/tmp/repo",
      detail: "Commit, stash, or discard them, then switch again.",
    });

    expect(toBranchActionErrorMessage(error)).toBe(
      "Commit, stash, or discard them, then switch again.",
    );
    expect(toBranchActionErrorMessage(new Error("boom"))).toBe("boom");
  });
});

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

describe("resolveDefaultWorktreeBaseBranch", () => {
  it("offers nothing while a clone has no refs, then the default branch once they are listed", () => {
    expect(resolveDefaultWorktreeBaseBranch([])).toBeNull();
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "feature", isDefault: false, current: true },
        { name: "staging", isDefault: true, current: false },
      ]),
    ).toBe("staging");
    expect(
      resolveDefaultWorktreeBaseBranch([
        { name: "other", isDefault: false, current: false },
        { name: "feature", isDefault: false, current: true },
      ]),
    ).toBe("feature");
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

describe("offersWorkspaceModes", () => {
  it("offers worktrees from a repository or tracked repositories, never in No project", () => {
    const folder = { isScratchProject: false, isGitRepo: false, tracksGitRepositories: false };
    expect(offersWorkspaceModes(folder)).toBe(false);
    expect(offersWorkspaceModes({ ...folder, isGitRepo: true })).toBe(true);
    expect(offersWorkspaceModes({ ...folder, tracksGitRepositories: true })).toBe(true);
    // Git status assumes a repository until it loads.
    expect(offersWorkspaceModes({ ...folder, isScratchProject: true, isGitRepo: true })).toBe(
      false,
    );
  });
});

describe("resolveLockedWorkspaceLabel", () => {
  it.each([
    ["/home/me/.t3/worktrees/app/t3-ff466c42", "t3-ff466c42"],
    ["/home/me/.t3/worktrees/app/t3-ff466c42/", "t3-ff466c42"],
    ["C:\\Users\\me\\worktrees\\feature-x", "feature-x"],
  ])("names the worktree at %s", (path, label) => {
    expect(resolveLockedWorkspaceLabel(path, "worktree")).toBe(label);
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("strips the whole remote name when it is known", () => {
    expect(deriveLocalBranchNameFromRemoteRef("team/origin/feature", "team/origin")).toBe(
      "feature",
    );
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it.each([
    ["feature/demo", "origin/feature/demo", true],
    ["feature/demo", "feature/demo", false],
    ["demo", "demo", true],
    ["origin/", "origin/", true],
    ["/demo", "/demo", true],
    ["", "", false],
  ])("filters origin ref %s / %s (hidden: %s)", (localName, remoteName, hidden) => {
    const input: VcsRef[] = [
      {
        name: localName,
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: remoteName,
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

    const result = dedupeRemoteBranchesWithLocalMatches(input);
    const expected = hidden ? [input[0], input[2]] : input;
    expect(result).toEqual(expected);
    for (const [index, ref] of result.entries()) {
      expect(ref).toBe(expected[index]);
    }
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
        activeProjectCwd: "/repo/nested-checkout/packages/app",
        activeProjectCheckoutRoot: "/repo/nested-checkout",
        activeWorktreePath: null,
        refName: { isDefault: true, worktreePath: "/repo" },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: "/repo",
      reuseExistingWorktree: true,
      staysInActiveCheckout: false,
    });
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
      staysInActiveCheckout: false,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    // A subdirectory project's own checkout is reported at the repository root.
    // The checkout root is undefined until the project's status loads.
    for (const [activeProjectCwd, activeWorktreePath, activeProjectCheckoutRoot] of [
      ["/repo", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", null, "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", undefined],
      ["/repo/packages/app", null, undefined],
    ] as const) {
      expect(
        resolveBranchSelectionTarget({
          activeProjectCwd,
          activeProjectCheckoutRoot,
          activeWorktreePath,
          refName: {
            isDefault: true,
            worktreePath: "/repo",
          },
        }),
      ).toEqual({
        checkoutCwd: "/repo",
        nextWorktreePath: null,
        reuseExistingWorktree: true,
        // A ref listed in the thread's own checkout may be stale, so it is checked out, not assumed.
        staysInActiveCheckout: activeWorktreePath === null,
      });
    }
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
      staysInActiveCheckout: true,
    });
  });
});

describe("isWorktreeChangeBlocked", () => {
  const runtime = (status: "preparing" | "running" | "completed") => ({
    status,
    activeRunId: status === "completed" ? null : RunId.make("run"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
  });

  it.each([
    ["preparing", "/repo/wt-a", null, true],
    ["running", "/repo/wt-a", "/repo/wt-b", true],
    ["running", null, "/repo/wt-b", true],
    ["running", "/repo/wt-a", "/repo/wt-a", false],
    ["completed", "/repo/wt-a", null, false],
  ] as const)(
    "a %s turn moving %s -> %s is blocked: %s",
    (status, currentWorktreePath, nextWorktreePath, blocked) => {
      expect(
        isWorktreeChangeBlocked({
          runtime: runtime(status),
          currentWorktreePath,
          nextWorktreePath,
        }),
      ).toBe(blocked);
    },
  );
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

describe("isBranchHoldCurrent", () => {
  const environmentId = EnvironmentId.make("env-a");
  const hold = {
    branch: "feature",
    environmentId,
    checkouts: [{ cwd: "/repo", replaces: "main" }],
  };
  const current = { canonicalBranch: "main", environmentId, cwd: "/repo" };

  it("keeps showing the checked-out branch while status still reports the old one", () => {
    expect(isBranchHoldCurrent(hold, current)).toBe(true);
  });

  it("lets go once status moves, even to a different branch than the checkout", () => {
    for (const canonicalBranch of ["feature", "other", null]) {
      expect(isBranchHoldCurrent(hold, { ...current, canonicalBranch })).toBe(false);
    }
  });

  it("does not apply to another checkout that happens to be on the old branch", () => {
    expect(isBranchHoldCurrent(hold, { ...current, cwd: "/other" })).toBe(false);
  });

  it("follows a thread moving from its worktree to the project root", () => {
    const moveHold = {
      branch: "main",
      environmentId,
      checkouts: [
        { cwd: "/repo-feature", replaces: "feature" },
        { cwd: "/repo", replaces: "dev" },
      ],
    };
    expect(
      isBranchHoldCurrent(moveHold, {
        environmentId,
        cwd: "/repo-feature",
        canonicalBranch: "feature",
      }),
    ).toBe(true);
    expect(
      isBranchHoldCurrent(moveHold, { environmentId, cwd: "/repo", canonicalBranch: "dev" }),
    ).toBe(true);
    expect(
      isBranchHoldCurrent(moveHold, { environmentId, cwd: "/repo", canonicalBranch: "main" }),
    ).toBe(false);
  });

  it("does not apply to the same path on another environment", () => {
    expect(
      isBranchHoldCurrent(hold, { ...current, environmentId: EnvironmentId.make("env-b") }),
    ).toBe(false);
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

describe("sandboxRepositoryChoice", () => {
  const project = SandboxRemoteUrl.make("https://github.com/Example/App.git");

  it("offers the project's repository while nothing is typed, and nothing without one", () => {
    expect(sandboxRepositoryChoice("", project)).toEqual({ _tag: "project", remoteUrl: project });
    expect(sandboxRepositoryChoice("  ", project)).toEqual({ _tag: "project", remoteUrl: project });
    expect(sandboxRepositoryChoice("", null)).toBeNull();
  });

  it("offers only the typed repository once something is typed, as its HTTPS clone URL", () => {
    expect(sandboxRepositoryChoice("Example/Other", project)).toEqual({
      _tag: "typed",
      remoteUrl: "https://github.com/Example/Other.git",
    });
    expect(sandboxRepositoryChoice("git@github.com:Example/Other.git", null)).toEqual({
      _tag: "typed",
      remoteUrl: "https://github.com/Example/Other.git",
    });
    expect(sandboxRepositoryChoice("~/code/other", project)).toBeNull();
  });

  it("follows the project when its own repository is typed, in any spelling", () => {
    expect(sandboxRepositoryChoice("Example/App", project)).toEqual({
      _tag: "project",
      remoteUrl: project,
    });
    expect(sandboxRepositoryChoice("git@github.com:example/app.git", project)).toEqual({
      _tag: "project",
      remoteUrl: project,
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

describe("resolveConfirmedSelectedRef", () => {
  const listed: VcsRef = {
    name: "previous",
    isRemote: false,
    current: false,
    isDefault: false,
    worktreePath: "/worktree-b",
  };

  it.each([
    [
      "the claimed worktree still has it checked out",
      [{ ...listed, current: true }],
      "/worktree-b",
    ],
    ["the claimed worktree has moved to another branch", [], null],
    ["the claimed worktree lists it but not as current", [listed], null],
    ["the read failed", null, null],
  ] as const)("%s", (_label, refs, expected) => {
    expect(resolveConfirmedSelectedRef(listed, refs === null ? null : { refs }).worktreePath).toBe(
      expected,
    );
  });
});
