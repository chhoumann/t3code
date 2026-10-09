import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SandboxAccountId,
  type SandboxAccountConfig,
  SandboxError,
  type SandboxStatus,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isSandboxStopped,
  sandboxAccountChoices,
  sandboxFailureMessage,
  sandboxLandingThreadId,
  sandboxLaunchStageIndex,
  sandboxRepositoryFor,
} from "./sandboxes.ts";

const OWNER = EnvironmentId.make("environment-owner");
const REMOTE = "https://github.com/octocat/Hello-World.git";
const HEAD = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

const pushed: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  headCommit: HEAD,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 2,
  pr: null,
};

const account = (label: string): SandboxAccountConfig => ({
  label,
  provider: "boat",
  template: null,
  providerEnvironment: null,
  size: "small",
  stopAfterHours: 8,
  machineSetupScript: null,
  env: [],
});

describe("sandboxRepositoryFor", () => {
  it("pins the remote at the current commit once it is pushed, even when behind", () => {
    expect(sandboxRepositoryFor({ remoteUrl: REMOTE, status: pushed })).toEqual({
      _tag: "Ready",
      repository: { remoteUrl: REMOTE, commit: HEAD },
    });
  });

  it.each([
    ["not-a-repository", null, { ...pushed, isRepo: false }],
    ["no-remote", null, pushed],
    ["no-remote", REMOTE, { ...pushed, hasPrimaryRemote: false }],
    ["no-commit", REMOTE, { ...pushed, headCommit: undefined }],
    ["uncommitted-changes", REMOTE, { ...pushed, hasWorkingTreeChanges: true }],
    ["not-pushed", REMOTE, { ...pushed, aheadCount: 1 }],
    ["not-pushed", REMOTE, { ...pushed, hasUpstream: false }],
  ] as const)("refuses with %s", (problem, remoteUrl, status) => {
    expect(sandboxRepositoryFor({ remoteUrl, status })).toEqual({ _tag: "Refused", problem });
  });

  it("refuses before the status has loaded", () => {
    expect(sandboxRepositoryFor({ remoteUrl: REMOTE, status: null })).toEqual({
      _tag: "Refused",
      problem: "not-a-repository",
    });
  });
});

describe("isSandboxStopped", () => {
  it("counts a sandbox stopped at its TTL or by the provider, not only one asked to stop", () => {
    expect(
      isSandboxStopped({ desired: "running", status: { _tag: "stopped", reason: "expired" } }),
    ).toBe(true);
    expect(
      isSandboxStopped({ desired: "running", status: { _tag: "stopped", reason: "external" } }),
    ).toBe(true);
    expect(isSandboxStopped({ desired: "stopped", status: { _tag: "stopping" } })).toBe(true);
    expect(isSandboxStopped({ desired: "running", status: { _tag: "ready" } })).toBe(false);
  });
});

describe("sandboxLaunchStageIndex", () => {
  it.each([
    [{ _tag: "creating" }, 0],
    [{ _tag: "booting" }, 1],
    [{ _tag: "launching" }, 2],
    [{ _tag: "ready" }, null],
    [{ _tag: "failed", step: "boot", message: "boom", retryable: true }, null],
    [{ _tag: "stopped", reason: "requested" }, null],
  ] as ReadonlyArray<readonly [SandboxStatus, number | null]>)(
    "%j is stage %s",
    (status, stage) => {
      expect(sandboxLaunchStageIndex(status)).toBe(stage);
    },
  );
});

describe("sandboxAccountChoices", () => {
  const config = (sandboxes: boolean | undefined) => ({
    environment: { capabilities: sandboxes === undefined ? {} : { sandboxes } },
    settings: {
      sandboxAccounts: {
        [SandboxAccountId.make("work")]: account("Work"),
        [SandboxAccountId.make("personal")]: account("Personal"),
      },
    },
  });

  it("lists an owner's accounts by label", () => {
    expect(sandboxAccountChoices(OWNER, config(true))).toEqual([
      { ownerEnvironmentId: OWNER, accountId: "personal", label: "Personal" },
      { ownerEnvironmentId: OWNER, accountId: "work", label: "Work" },
    ]);
  });

  it("offers nothing from an environment that does not serve sandboxes", () => {
    expect(sandboxAccountChoices(OWNER, config(undefined))).toEqual([]);
    expect(sandboxAccountChoices(OWNER, config(false))).toEqual([]);
    expect(sandboxAccountChoices(OWNER, null)).toEqual([]);
  });
});

describe("sandboxFailureMessage", () => {
  it("names the actions a key lacks", () => {
    const error = new SandboxError({
      code: "key-missing-actions",
      message: "missing",
      missingActions: ["sandbox.resume", "host"],
    });
    expect(sandboxFailureMessage(error)).toBe(
      "This API key cannot use sandbox.resume, host. Allow those actions for the key, then save again.",
    );
  });

  it("passes any other failure's own message through", () => {
    const error = new SandboxError({ code: "account-in-use", message: "Work owns 2 sandboxes." });
    expect(sandboxFailureMessage(error)).toBe("Work owns 2 sandboxes.");
  });
});

describe("sandboxLandingThreadId", () => {
  const SEED = ThreadId.make("thread-seed");
  const thread = (
    id: string,
    updatedAt: string,
    overrides: { archived?: boolean; deleted?: boolean; parent?: ThreadId } = {},
  ) => ({
    id: ThreadId.make(id),
    updatedAt: DateTime.makeUnsafe(updatedAt),
    archivedAt: overrides.archived ? DateTime.makeUnsafe(updatedAt) : null,
    deletedAt: overrides.deleted ? DateTime.makeUnsafe(updatedAt) : null,
    lineage: { parentThreadId: overrides.parent ?? null },
  });

  it("opens the first thread while it is active, however recently others changed", () => {
    expect(
      sandboxLandingThreadId(
        [
          thread("thread-later", "2026-10-09T13:00:00Z"),
          thread("thread-seed", "2026-10-09T12:00:00Z"),
        ],
        SEED,
      ),
    ).toBe(SEED);
  });

  it("opens the active top-level thread updated last once the first is gone or archived", () => {
    const threads = [
      thread("thread-seed", "2026-10-09T14:00:00Z", { archived: true }),
      thread("thread-older", "2026-10-09T12:00:00Z"),
      thread("thread-newer", "2026-10-09T13:00:00Z"),
      thread("thread-child", "2026-10-09T15:00:00Z", { parent: ThreadId.make("thread-newer") }),
      thread("thread-deleted", "2026-10-09T16:00:00Z", { deleted: true }),
    ];
    expect(sandboxLandingThreadId(threads, SEED)).toBe("thread-newer");
    expect(sandboxLandingThreadId(threads.slice(1), SEED)).toBe("thread-newer");
  });

  it("has nothing to open before the sandbox lists an active thread", () => {
    expect(sandboxLandingThreadId([], SEED)).toBeNull();
  });
});
