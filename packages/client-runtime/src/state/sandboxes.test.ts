import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SandboxAccountId,
  type SandboxAccountConfig,
  SandboxError,
  SandboxId,
  type SandboxStatus,
  type SandboxView,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";

import {
  pendingSandboxThreads,
  sandboxAccountChoices,
  sandboxCommandFailure,
  sandboxLandingThreadId,
  sandboxLaunchAction,
  sandboxLaunchPanel,
  sandboxLaunchStageIndex,
  sandboxPresence,
  sandboxRepositoryFor,
  sandboxWakeStatus,
  workDelivery,
  workGrantEnvironmentId,
} from "./sandboxes.ts";
import { sandboxIndex } from "../sandbox/sandboxRegistrations.ts";
import type { EnvironmentShellStatus } from "./shell.ts";

const OWNER = EnvironmentId.make("environment-owner");
const REMOTE = "https://github.com/octocat/Hello-World.git";
const HEAD = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

const pushed: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  remotes: [{ name: "origin", url: REMOTE }],
  trackedRemote: "origin",
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
  providerEnvironment: null,
  size: "small",
  stopAfterHours: 8,
  machineSetupScript: null,
  env: [],
});

describe("sandboxRepositoryFor", () => {
  const PROJECT = "https://github.com/pingdotgg/t3code.git";
  const FORK = "git@github.com:chhoumann/t3code.git";
  const onBranch = (
    trackedRemote: string,
    remotes: VcsStatusResult["remotes"],
  ): VcsStatusResult => ({
    ...pushed,
    remotes,
    trackedRemote,
    isDefaultRef: false,
    refName: "fix",
  });

  it("pins the remote at the current commit once it is pushed, even when behind", () => {
    expect(sandboxRepositoryFor(pushed)).toEqual({
      _tag: "Ready",
      repository: {
        remotes: [{ name: "origin", url: REMOTE }],
        trackedRemote: "origin",
        commit: HEAD,
      },
    });
  });

  it("clones the fork a branch tracks and keeps origin, when origin is the project", () => {
    const status = onBranch("fork", [
      { name: "fork", url: FORK },
      { name: "origin", url: PROJECT },
      { name: "colleague", url: "https://github.com/hubot/t3code.git" },
    ]);
    expect(sandboxRepositoryFor(status)).toEqual({
      _tag: "Ready",
      repository: {
        remotes: [
          { name: "fork", url: FORK },
          { name: "origin", url: PROJECT },
        ],
        trackedRemote: "fork",
        commit: HEAD,
      },
    });
  });

  it("clones origin when it is the fork the branch tracks, and keeps upstream", () => {
    const status = onBranch("origin", [
      { name: "origin", url: FORK },
      { name: "upstream", url: PROJECT },
    ]);
    expect(sandboxRepositoryFor(status)).toEqual({
      _tag: "Ready",
      repository: {
        remotes: [
          { name: "origin", url: FORK },
          { name: "upstream", url: PROJECT },
        ],
        trackedRemote: "origin",
        commit: HEAD,
      },
    });
  });

  it("keeps the remote the identity falls back to without origin or upstream", () => {
    const status = onBranch("work", [
      { name: "mirror", url: PROJECT },
      { name: "work", url: FORK },
    ]);
    expect(sandboxRepositoryFor(status)).toEqual({
      _tag: "Ready",
      repository: {
        remotes: [
          { name: "work", url: FORK },
          { name: "mirror", url: PROJECT },
        ],
        trackedRemote: "work",
        commit: HEAD,
      },
    });
  });

  it.each([
    ["not-a-repository", { ...pushed, isRepo: false }],
    ["no-remote", { ...pushed, remotes: [], trackedRemote: undefined }],
    ["no-commit", { ...pushed, headCommit: undefined }],
    ["uncommitted-changes", { ...pushed, hasWorkingTreeChanges: true }],
    ["uncommitted-changes", { ...pushed, hasWorkingTreeChanges: true, hasTrackedChanges: true }],
    ["not-pushed", { ...pushed, aheadCount: 1 }],
    ["not-pushed", { ...pushed, hasUpstream: false, trackedRemote: undefined }],
    // A branch that tracks another local branch has an upstream but no remote.
    ["not-pushed", { ...pushed, trackedRemote: undefined }],
  ] as const)("refuses with %s", (problem, status) => {
    expect(sandboxRepositoryFor(status)).toEqual({ _tag: "Refused", problem });
  });

  it("launches when only untracked files changed, since they never travel anyway", () => {
    const status = { ...pushed, hasWorkingTreeChanges: true, hasTrackedChanges: false };
    expect(sandboxRepositoryFor(status)).toMatchObject({ _tag: "Ready" });
  });

  it("refuses before the status has loaded", () => {
    expect(sandboxRepositoryFor(null)).toEqual({ _tag: "Refused", problem: "not-a-repository" });
  });
});

describe("sandboxPresence", () => {
  it.each([
    ["running", "running", { _tag: "ready" }],
    ["asleep", "running", { _tag: "stopped", reason: "external" }],
    ["asleep", "running", { _tag: "stopping", reason: "idle" }],
    ["waking", "running", { _tag: "resuming" }],
    ["put-away", "stopped", { _tag: "ready" }],
    ["put-away", "stopped", { _tag: "stopped", reason: "requested" }],
    ["launching", "running", { _tag: "booting" }],
    [
      "failed",
      "running",
      { _tag: "failed", step: "resume", message: "Boat refused", retryable: true },
    ],
    [
      "failed",
      "destroyed",
      { _tag: "failed", step: "destroy", message: "Boat refused", retryable: true },
    ],
    ["gone", "destroyed", { _tag: "stopped", reason: "requested" }],
    ["gone", "stopped", { _tag: "destroying" }],
  ] as const)("reads %s when it should be %s and is %o", (presence, desired, status) => {
    expect(sandboxPresence({ desired, status })).toBe(presence);
  });
});

describe("sandboxWakeStatus", () => {
  const stopped: SandboxStatus = { _tag: "stopped", reason: "idle" };
  const ready: SandboxStatus = { _tag: "ready" };
  it.each([
    ["asleep", "running", stopped, "available", { kind: "asleep", label: "Asleep" }],
    ["waking", "running", { _tag: "resuming" }, "available", { kind: "waking", label: "Waking" }],
    [
      "back, not dialed",
      "running",
      ready,
      "available",
      { kind: "connecting", label: "Connecting" },
    ],
    ["back, dialing", "running", ready, "connecting", { kind: "connecting", label: "Connecting" }],
    [
      "back, redialing",
      "running",
      ready,
      "reconnecting",
      { kind: "connecting", label: "Connecting" },
    ],
    ["back and connected", "running", ready, "connected", null],
    ["running while this device is offline", "running", ready, "offline", null],
    ["put away", "stopped", { _tag: "stopped", reason: "requested" }, "available", null],
    [
      "failed to resume",
      "running",
      {
        _tag: "failed",
        step: "resume",
        message: "The machine did not start in time.",
        retryable: true,
      },
      "available",
      { kind: "failed", label: "Could not wake: The machine did not start in time." },
    ],
    [
      "failed on another step",
      "running",
      { _tag: "failed", step: "observe", message: "Boat could not be reached.", retryable: true },
      "available",
      { kind: "failed", label: "Sandbox failed: Boat could not be reached." },
    ],
  ] as const)("shows a sandbox %s", (_case, desired, status, phase, expected) => {
    expect(sandboxWakeStatus({ desired, status }, phase)).toEqual(expected);
  });
});

describe("workDelivery", () => {
  const ready: SandboxStatus = { _tag: "ready" };
  it.each([
    ["an environment this device is connected to", undefined, true, "now"],
    ["an environment this device cannot reach", undefined, false, "offline"],
    [
      "a sandbox that sleeps",
      { desired: "running", status: { _tag: "stopped", reason: "idle" } },
      false,
      "after-wake",
    ],
    [
      "a sandbox stopping while its socket is still up",
      { desired: "running", status: { _tag: "stopping", reason: "idle" } },
      true,
      "after-wake",
    ],
    [
      "a sandbox already waking",
      { desired: "running", status: { _tag: "resuming" } },
      false,
      "after-wake",
    ],
    [
      "a sandbox that was put away",
      { desired: "stopped", status: { _tag: "stopped", reason: "requested" } },
      false,
      "after-wake",
    ],
    [
      "a sandbox whose wake failed",
      {
        desired: "running",
        status: { _tag: "failed", step: "resume", message: "No machine.", retryable: true },
      },
      false,
      "after-wake",
    ],
    [
      "a running sandbox this device has yet to reach",
      { desired: "running", status: ready },
      false,
      "offline",
    ],
    [
      "a running sandbox this device is connected to",
      { desired: "running", status: ready },
      true,
      "now",
    ],
    [
      "a sandbox being deleted",
      { desired: "destroyed", status: { _tag: "destroying" } },
      false,
      "offline",
    ],
  ] as const)("sends to %s", (_case, sandbox, connected, delivery) => {
    expect(workDelivery({ sandbox, connected })).toBe(delivery);
  });
});

describe("workGrantEnvironmentId", () => {
  const SANDBOX_ENVIRONMENT = EnvironmentId.make("environment-sandbox");
  const index = (desired: SandboxView["desired"], status: SandboxStatus) =>
    sandboxIndex(
      new Map([
        [
          OWNER,
          [
            {
              id: SandboxId.make("sbx-1"),
              accountId: SandboxAccountId.make("work"),
              title: "Fix the flaky test",
              message: "Fix the flaky test",
              repository: {
                remotes: [{ name: "origin", url: REMOTE }],
                trackedRemote: "origin",
                commit: HEAD,
              },
              threadId: ThreadId.make("thread-seed"),
              desired,
              revision: 1,
              settledRevision: 1,
              status,
              environmentId: SANDBOX_ENVIRONMENT,
              httpBaseUrl: "https://sbx-1.boat.test",
              createdAt: "2026-10-09T12:00:00.000Z",
            },
          ],
        ],
      ]),
    );

  it.each([
    ["its owner's", "asleep", "running", { _tag: "stopped", reason: "external" }, OWNER],
    ["its owner's", "waking", "running", { _tag: "resuming" }, OWNER],
    [
      "its owner's",
      "failed on its way back",
      "running",
      { _tag: "failed", step: "resume", message: "Boat refused", retryable: true },
      OWNER,
    ],
    ["its own", "running", "running", { _tag: "ready" }, SANDBOX_ENVIRONMENT],
    [
      "its own",
      "being deleted",
      "destroyed",
      { _tag: "failed", step: "destroy", message: "Boat refused", retryable: true },
      SANDBOX_ENVIRONMENT,
    ],
  ] as const)(
    "reads %s grant for work sent to a sandbox that is %s",
    (_grant, _state, desired, status, expected) => {
      expect(workGrantEnvironmentId(index(desired, status), SANDBOX_ENVIRONMENT)).toBe(expected);
    },
  );

  it("reads an environment's own grant when it is not a sandbox", () => {
    const remote = EnvironmentId.make("environment-remote");
    expect(
      workGrantEnvironmentId(index("running", { _tag: "stopped", reason: "external" }), remote),
    ).toBe(remote);
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

describe("sandboxCommandFailure", () => {
  const failed = (error: SandboxError) => AsyncResult.failure<unknown, unknown>(Cause.fail(error));

  it("names the actions a key lacks", () => {
    const error = new SandboxError({
      code: "key-missing-actions",
      message: "missing",
      missingActions: ["sandbox.resume", "host"],
    });
    expect(sandboxCommandFailure(failed(error))).toBe(
      "This API key cannot use sandbox.resume, host. Allow those actions for the key, then save again.",
    );
  });

  it("passes any other failure's own message through", () => {
    const error = new SandboxError({ code: "account-in-use", message: "Work owns 2 sandboxes." });
    expect(sandboxCommandFailure(failed(error))).toBe("Work owns 2 sandboxes.");
  });

  it("has nothing to say for a command that succeeded or was interrupted", () => {
    expect(sandboxCommandFailure(AsyncResult.success<unknown, unknown>(undefined))).toBeNull();
    expect(
      sandboxCommandFailure(AsyncResult.failure<unknown, unknown>(Cause.interrupt())),
    ).toBeNull();
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

describe("sandboxLaunchAction", () => {
  const SANDBOX_ENVIRONMENT = EnvironmentId.make("environment-sandbox");
  const LANDING = ThreadId.make("thread-seed");
  const asleep = {
    desired: "running" as const,
    status: { _tag: "stopped" as const, reason: "external" as const },
    environmentId: SANDBOX_ENVIRONMENT,
  };
  const ready = { ...asleep, status: { _tag: "ready" as const } };

  it("wakes an asleep sandbox once this device knows it lists none of its threads", () => {
    const decide = (shell: EnvironmentShellStatus | null, landingThreadId: ThreadId | null) =>
      sandboxLaunchAction({ view: asleep, landingThreadId, connected: false, shell });
    expect([
      decide(null, null),
      decide("empty", null),
      decide("cached", null),
      decide("synchronizing", null),
      decide("live", null),
      decide("cached", LANDING),
    ]).toEqual([
      { _tag: "Wake", environmentId: "environment-sandbox" },
      { _tag: "Asleep" },
      { _tag: "Wake", environmentId: "environment-sandbox" },
      { _tag: "Wake", environmentId: "environment-sandbox" },
      { _tag: "Wake", environmentId: "environment-sandbox" },
      { _tag: "OpenThread", environmentId: "environment-sandbox", threadId: "thread-seed" },
    ]);
  });

  it("wakes an asleep sandbox whose thread this device never loaded", () => {
    expect(
      sandboxLaunchAction({ view: asleep, landingThreadId: null, connected: false, shell: "live" }),
    ).toEqual({
      _tag: "Wake",
      environmentId: "environment-sandbox",
    });
    expect(
      sandboxLaunchAction({
        view: { ...asleep, status: { _tag: "stopping", reason: "external" } },
        landingThreadId: null,
        connected: false,
        shell: "live",
      }),
    ).toEqual({ _tag: "Wake", environmentId: "environment-sandbox" });
  });

  it("opens an asleep sandbox's thread from cache without waking it", () => {
    expect(
      sandboxLaunchAction({
        view: asleep,
        landingThreadId: LANDING,
        connected: false,
        shell: "live",
      }),
    ).toEqual({
      _tag: "OpenThread",
      environmentId: "environment-sandbox",
      threadId: "thread-seed",
    });
  });

  it("offers to resume a put-away sandbox, whatever this device has loaded", () => {
    const putAway = {
      ...asleep,
      desired: "stopped" as const,
      status: { _tag: "stopped" as const, reason: "requested" as const },
    };
    expect(
      sandboxLaunchAction({
        view: putAway,
        landingThreadId: null,
        connected: false,
        shell: "live",
      }),
    ).toEqual({ _tag: "OfferResume" });
    expect(
      sandboxLaunchAction({
        view: putAway,
        landingThreadId: LANDING,
        connected: false,
        shell: "live",
      }),
    ).toEqual({ _tag: "OfferResume" });
  });

  it("offers to resume an asleep sandbox that stopped before it had an environment", () => {
    expect(
      sandboxLaunchAction({
        view: { ...asleep, environmentId: null },
        landingThreadId: null,
        connected: false,
        shell: "live",
      }),
    ).toEqual({ _tag: "OfferResume" });
  });

  it("opens a running sandbox's thread once this device is connected and lists it", () => {
    expect(
      sandboxLaunchAction({
        view: ready,
        landingThreadId: LANDING,
        connected: true,
        shell: "live",
      }),
    ).toEqual({
      _tag: "OpenThread",
      environmentId: "environment-sandbox",
      threadId: "thread-seed",
    });
    expect(
      sandboxLaunchAction({
        view: ready,
        landingThreadId: LANDING,
        connected: false,
        shell: "live",
      }),
    ).toEqual({ _tag: "Follow" });
    expect(
      sandboxLaunchAction({ view: ready, landingThreadId: null, connected: true, shell: "live" }),
    ).toEqual({
      _tag: "Follow",
    });
  });

  it("follows a sandbox that is launching, waking, or failed, without waking it", () => {
    for (const status of [
      { _tag: "launching" },
      { _tag: "resuming" },
      { _tag: "failed", step: "resume", message: "boom", retryable: true },
    ] as const) {
      expect(
        sandboxLaunchAction({
          view: { ...asleep, status },
          landingThreadId: null,
          connected: false,
          shell: "live",
        }),
      ).toEqual({ _tag: "Follow" });
    }
  });
});

describe("sandboxLaunchPanel", () => {
  const SANDBOX_ENVIRONMENT = EnvironmentId.make("environment-sandbox");
  const OFFLINE = "Work laptop is offline, so it cannot wake this sandbox.";
  const view = (status: SandboxStatus, revision = 1) => ({
    status,
    revision,
    environmentId: SANDBOX_ENVIRONMENT,
  });
  const stopped: SandboxStatus = { _tag: "stopped", reason: "external" };
  const wake = { _tag: "Wake", environmentId: SANDBOX_ENVIRONMENT } as const;
  const follow = { _tag: "Follow" } as const;

  it("shows where the sandbox stands", () => {
    expect([
      sandboxLaunchPanel({ view: view({ _tag: "booting" }), action: follow, wakeFailure: null }),
      sandboxLaunchPanel({ view: view(stopped), action: wake, wakeFailure: null }),
      sandboxLaunchPanel({ view: view(stopped), action: { _tag: "Asleep" }, wakeFailure: null }),
      sandboxLaunchPanel({ view: view({ _tag: "resuming" }), action: follow, wakeFailure: null }),
      sandboxLaunchPanel({ view: view({ _tag: "ready" }), action: follow, wakeFailure: null }),
      sandboxLaunchPanel({
        view: view({ _tag: "stopping", reason: "requested" }),
        action: { _tag: "OfferResume" },
        wakeFailure: null,
      }),
      sandboxLaunchPanel({
        view: view({ _tag: "failed", step: "boot", message: "boom", retryable: false }),
        action: follow,
        wakeFailure: null,
      }),
    ]).toEqual([
      { _tag: "Stages", current: 1 },
      { _tag: "Status", label: "Resuming" },
      { _tag: "Status", label: "Asleep" },
      { _tag: "Status", label: "Resuming" },
      { _tag: "Status", label: "Opening thread" },
      { _tag: "Resume", label: "Stopping", available: false },
      { _tag: "Failed", message: "boom", retryable: false },
    ]);
  });

  it("keeps a wake that failed here, with Retry, while the sandbox has no newer request", () => {
    expect(
      sandboxLaunchPanel({
        view: view(stopped),
        action: wake,
        wakeFailure: { message: OFFLINE, revision: 1 },
      }),
    ).toEqual({ _tag: "WakeFailed", message: OFFLINE, environmentId: "environment-sandbox" });
    // The wake's own request woke the sandbox, but this device never reached it.
    expect(
      sandboxLaunchPanel({
        view: view({ _tag: "ready" }, 2),
        action: follow,
        wakeFailure: {
          message: "The sandbox is awake, but this device could not reconnect to it.",
          revision: 2,
        },
      }),
    ).toEqual({
      _tag: "WakeFailed",
      message: "The sandbox is awake, but this device could not reconnect to it.",
      environmentId: "environment-sandbox",
    });
  });

  it("drops a wake that failed here once a resume starts from elsewhere", () => {
    const failedHere = { message: OFFLINE, revision: 1 };
    // Resumed from Settings or another device.
    expect(
      sandboxLaunchPanel({
        view: view({ _tag: "resuming" }, 2),
        action: follow,
        wakeFailure: failedHere,
      }),
    ).toEqual({ _tag: "Status", label: "Resuming" });
    // The owner's resume failed, and its Retry asked again.
    const resumeFailed: SandboxStatus = {
      _tag: "failed",
      step: "resume",
      message: "The machine did not start in time.",
      retryable: true,
    };
    expect(
      sandboxLaunchPanel({ view: view(resumeFailed, 2), action: follow, wakeFailure: failedHere }),
    ).toEqual({ _tag: "Failed", message: "The machine did not start in time.", retryable: true });
    expect(
      sandboxLaunchPanel({
        view: view({ _tag: "resuming" }, 3),
        action: follow,
        wakeFailure: failedHere,
      }),
    ).toEqual({ _tag: "Status", label: "Resuming" });
  });
});

describe("pendingSandboxThreads", () => {
  const SANDBOX_ENVIRONMENT = EnvironmentId.make("environment-sandbox");
  const sandbox = (
    id: string,
    createdAt: string,
    overrides: Partial<Pick<SandboxView, "desired" | "status" | "environmentId">> = {},
  ): SandboxView => ({
    id: SandboxId.make(id),
    accountId: SandboxAccountId.make("work"),
    title: id,
    message: "Fix the flaky test",
    repository: {
      remotes: [{ name: "origin", url: REMOTE }],
      trackedRemote: "origin",
      commit: HEAD,
    },
    threadId: ThreadId.make(`seed-${id}`),
    desired: "running",
    revision: 1,
    settledRevision: 1,
    status: { _tag: "creating" },
    environmentId: null,
    httpBaseUrl: null,
    createdAt,
    ...overrides,
  });
  const seed = (view: SandboxView, overrides: { archived?: boolean } = {}) => ({
    id: view.threadId,
    updatedAt: DateTime.makeUnsafe(view.createdAt),
    archivedAt: overrides.archived ? DateTime.makeUnsafe(view.createdAt) : null,
    deletedAt: null,
    lineage: { parentThreadId: null },
  });
  const ids = (pending: ReturnType<typeof pendingSandboxThreads>) =>
    pending.map(({ ownerEnvironmentId, view }) => `${ownerEnvironmentId}/${view.id}`);

  it("lists a sandbox from launch until its environment lists its thread", () => {
    const launching = sandbox("launching", "2026-10-09T12:00:00Z", {
      status: { _tag: "launching" },
    });
    const readyNotSynced = sandbox("ready", "2026-10-09T12:00:00Z", {
      status: { _tag: "ready" },
      environmentId: SANDBOX_ENVIRONMENT,
    });
    const owners = new Map([[OWNER, [launching, readyNotSynced]]]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          () => [],
          () => "live",
        ),
      ),
    ).toEqual(["environment-owner/launching", "environment-owner/ready"]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          (environmentId) => (environmentId === SANDBOX_ENVIRONMENT ? [seed(readyNotSynced)] : []),
          () => "live",
        ),
      ),
    ).toEqual(["environment-owner/launching"]);
  });

  it("gives way to whichever thread the sandbox opens on, not only its first", () => {
    const ready = sandbox("ready", "2026-10-09T12:00:00Z", {
      status: { _tag: "ready" },
      environmentId: SANDBOX_ENVIRONMENT,
    });
    const owners = new Map([[OWNER, [ready]]]);
    const other = { ...seed(ready), id: ThreadId.make("thread-other") };
    expect(
      pendingSandboxThreads(
        owners,
        () => [seed(ready, { archived: true }), other],
        () => "live",
      ),
    ).toEqual([]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          () => [seed(ready, { archived: true })],
          () => "live",
        ),
      ),
    ).toEqual(["environment-owner/ready"]);
  });

  it("keeps a failed sandbox until it is retried or deleted", () => {
    const failed = (desired: SandboxView["desired"]) =>
      sandbox(`failed-${desired}`, "2026-10-09T12:00:00Z", {
        desired,
        status: { _tag: "failed", step: "boot", message: "boom", retryable: true },
      });
    const owners = new Map([[OWNER, [failed("running"), failed("destroyed"), failed("stopped")]]]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          () => [],
          () => "live",
        ),
      ),
    ).toEqual(["environment-owner/failed-destroyed", "environment-owner/failed-running"]);
  });

  it("leaves out sandboxes that are stopping, stopped, or deleted", () => {
    const owners = new Map([
      [
        OWNER,
        [
          sandbox("stopping", "2026-10-09T12:00:00Z", {
            desired: "stopped",
            status: { _tag: "stopping", reason: "requested" },
          }),
          sandbox("archived", "2026-10-09T12:00:00Z", {
            desired: "stopped",
            status: { _tag: "ready" },
          }),
          sandbox("stopped", "2026-10-09T12:00:00Z", {
            desired: "stopped",
            status: { _tag: "stopped", reason: "requested" },
          }),
          sandbox("destroying", "2026-10-09T12:00:00Z", {
            desired: "destroyed",
            status: { _tag: "destroying" },
          }),
          sandbox("destroyed", "2026-10-09T12:00:00Z", {
            desired: "destroyed",
            status: { _tag: "destroyed" },
          }),
          sandbox("resuming", "2026-10-09T12:00:00Z", { status: { _tag: "resuming" } }),
        ],
      ],
    ]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          () => [],
          () => "live",
        ),
      ),
    ).toEqual(["environment-owner/resuming"]);
  });

  it("lists an asleep sandbox only on a device that has yet to load its thread", () => {
    const asleep = sandbox("asleep", "2026-10-09T12:00:00Z", {
      status: { _tag: "stopped", reason: "external" },
      environmentId: SANDBOX_ENVIRONMENT,
    });
    const owners = new Map([[OWNER, [asleep]]]);
    const listed = (
      shell: EnvironmentShellStatus | null,
      threads: ReadonlyArray<ReturnType<typeof seed>>,
    ) =>
      ids(
        pendingSandboxThreads(
          owners,
          () => threads,
          () => shell,
        ),
      );
    expect([
      listed(null, []),
      listed("empty", []),
      listed("cached", []),
      listed("live", []),
      listed("cached", [seed(asleep)]),
    ]).toEqual([
      ["environment-owner/asleep"],
      [],
      ["environment-owner/asleep"],
      ["environment-owner/asleep"],
      [],
    ]);
  });

  it("orders every owner's sandboxes newest first", () => {
    const otherOwner = EnvironmentId.make("environment-other-owner");
    const owners = new Map([
      [
        OWNER,
        [
          sandbox("oldest", "2026-10-09T10:00:00Z"),
          sandbox("newest", "2026-10-09T13:00:00Z", { status: { _tag: "booting" } }),
        ],
      ],
      [otherOwner, [sandbox("middle", "2026-10-09T12:00:00Z")]],
    ]);
    expect(
      ids(
        pendingSandboxThreads(
          owners,
          () => [],
          () => "live",
        ),
      ),
    ).toEqual([
      "environment-owner/newest",
      "environment-other-owner/middle",
      "environment-owner/oldest",
    ]);
  });
});
