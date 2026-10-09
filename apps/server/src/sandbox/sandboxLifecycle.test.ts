import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  SandboxAccountId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  ANSWER_DEADLINE_MS,
  CREATE_KEY_WINDOW_MS,
  FIRST_BOOT_DEADLINE_MS,
  INFLIGHT_GRACE_MS,
  TRANSITION_DEADLINE_MS,
  planNext,
  type SandboxObservation,
  type SandboxPlan,
  type SandboxRecord,
} from "./sandboxLifecycle.ts";
import {
  ProviderMachineId,
  type ProviderMachineSetup,
  type ProviderMachineState,
} from "./SandboxProvider.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const ENV = EnvironmentId.make("env-guest");
const TTL_SECONDS = 2 * 60 * 60;

const fresh: SandboxRecord = {
  id: SandboxId.make("sbx-1"),
  accountId: SandboxAccountId.make("boat-work"),
  provider: "boat",
  spec: {
    title: "Fix the bug",
    message: "Fix the bug",
    repository: { remoteUrl: "https://github.com/octocat/Hello-World", commit: null },
    driver: ProviderDriverKind.make("claudeAgent"),
    model: "claude-sonnet-4-6",
    runtimeMode: "full-access",
    interactionMode: "default",
    machine: {
      size: "small",
      ttlSeconds: TTL_SECONDS,
      template: null,
      providerEnvironment: null,
      setupScript: "#!/usr/bin/env bash",
    },
    t3: { kind: "npm", version: "0.0.45" },
  },
  seed: {
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    commandId: CommandId.make("command-1"),
    messageId: MessageId.make("message-1"),
  },
  desired: "running",
  desiredRevision: 1,
  status: { _tag: "creating" },
  settledRevision: 0,
  inflight: null,
  createKey: "t3-sandbox-sbx-1-key",
  createFirstAttemptAt: null,
  machineId: null,
  httpBaseUrl: null,
  environmentId: null,
  runningSince: null,
  inputsWrittenAt: null,
  credentialsStale: false,
  seedLaunchedAt: null,
  createdAt: NOW - 30 * MINUTE,
};

const created: SandboxRecord = {
  ...fresh,
  runningSince: NOW - 5 * MINUTE,
  machineId: ProviderMachineId.make("bx_test"),
};
const booting: SandboxRecord = {
  ...created,
  status: { _tag: "booting" },
  inputsWrittenAt: NOW - 4 * MINUTE,
  httpBaseUrl: "https://bx-test.boat.dev",
};
const launching: SandboxRecord = { ...booting, status: { _tag: "launching" }, environmentId: ENV };
const ready: SandboxRecord = {
  ...launching,
  status: { _tag: "ready" },
  seedLaunchedAt: NOW - 3 * MINUTE,
  settledRevision: 1,
};
const stopRequested: SandboxRecord = { ...ready, desired: "stopped", desiredRevision: 2 };
const stopped: SandboxRecord = {
  ...stopRequested,
  status: { _tag: "stopped", reason: "requested" },
  settledRevision: 2,
};
const resumeRequested: SandboxRecord = { ...stopped, desired: "running", desiredRevision: 3 };
const resumed: SandboxRecord = {
  ...resumeRequested,
  status: { _tag: "resuming" },
  runningSince: NOW - MINUTE,
  credentialsStale: true,
};

const machine = (state: ProviderMachineState, setup: ProviderMachineSetup = null) => ({
  id: ProviderMachineId.make("bx_test"),
  state,
  setup,
});
const observed = (overrides: Partial<SandboxObservation> = {}): SandboxObservation => ({
  now: NOW,
  machine: null,
  environmentId: null,
  ...overrides,
});
const running = observed({ machine: machine("running") });
const answering = observed({ machine: machine("running"), environmentId: ENV });

const settle = (status: SandboxPlan["status"]): SandboxPlan => ({
  status,
  action: { _tag: "Settle" },
});
const failed = (step: string, retryable: boolean) => ({
  status: expect.objectContaining({ _tag: "failed", step, retryable }),
  action: { _tag: "Settle" },
});

type Case = readonly [string, SandboxRecord, SandboxObservation, unknown];

const cases: ReadonlyArray<Case> = [
  // Creation and crash recovery.
  [
    "fresh launch creates",
    fresh,
    observed(),
    { status: { _tag: "creating" }, action: { _tag: "Create" } },
  ],
  [
    "stopped before any create settles without creating",
    { ...fresh, desired: "stopped", desiredRevision: 2 },
    observed(),
    settle({ _tag: "stopped", reason: "requested" }),
  ],
  [
    "crash after create, before the machine id was stored, replays the same create",
    {
      ...fresh,
      inflight: { op: "create", startedAt: NOW - 60 * MINUTE },
      createFirstAttemptAt: NOW - 60 * MINUTE,
    },
    observed(),
    { status: { _tag: "creating" }, action: { _tag: "Create" } },
  ],
  [
    "a create unknown past the key window fails instead of creating again",
    {
      ...fresh,
      inflight: { op: "create", startedAt: NOW - CREATE_KEY_WINDOW_MS },
      createFirstAttemptAt: NOW - CREATE_KEY_WINDOW_MS,
    },
    observed(),
    failed("create", false),
  ],
  [
    "a stored machine id resolves a leftover create",
    { ...created, inflight: { op: "create", startedAt: NOW - MINUTE } },
    observed({ machine: machine("starting") }),
    { status: { _tag: "creating" }, action: { _tag: "ClearInflight" } },
  ],

  // First boot.
  [
    "machine still starting",
    created,
    observed({ machine: machine("starting") }),
    { status: { _tag: "creating" }, action: { _tag: "Wait" } },
  ],
  [
    "running machine gets its inputs",
    created,
    running,
    { status: { _tag: "creating" }, action: { _tag: "WriteInputs" } },
  ],
  [
    "inputs written, port not hosted yet",
    { ...booting, httpBaseUrl: null },
    running,
    { status: { _tag: "booting" }, action: { _tag: "Host" } },
  ],
  [
    "waits for T3 to answer",
    booting,
    running,
    { status: { _tag: "booting" }, action: { _tag: "Wait" } },
  ],
  [
    "a failed boot script fails the boot",
    booting,
    observed({ machine: machine("running", "failed") }),
    failed("boot", false),
  ],
  [
    "T3 not answering past the first boot deadline fails",
    { ...booting, runningSince: NOW - FIRST_BOOT_DEADLINE_MS },
    running,
    failed("boot", false),
  ],
  [
    "a machine still starting past the first boot deadline fails retryably",
    { ...created, runningSince: NOW - FIRST_BOOT_DEADLINE_MS },
    observed({ machine: machine("starting") }),
    failed("boot", true),
  ],
  [
    "a retried first boot boots the same machine once it finished provisioning",
    {
      ...created,
      runningSince: NOW - 2 * FIRST_BOOT_DEADLINE_MS,
      status: { _tag: "failed", step: "boot", message: "x", retryable: true },
      settledRevision: 1,
      desiredRevision: 2,
    },
    running,
    { status: { _tag: "creating" }, action: { _tag: "WriteInputs" } },
  ],
  [
    "T3 answering records the environment",
    booting,
    answering,
    { status: { _tag: "launching" }, action: { _tag: "RecordEnvironment", environmentId: ENV } },
  ],
  [
    "launches the seed thread once T3 answers",
    launching,
    answering,
    { status: { _tag: "launching" }, action: { _tag: "LaunchSeed" } },
  ],
  [
    "waits for T3 before launching",
    launching,
    running,
    { status: { _tag: "launching" }, action: { _tag: "Wait" } },
  ],
  [
    "seed launched: ready",
    { ...launching, seedLaunchedAt: NOW },
    answering,
    { status: { _tag: "ready" }, action: { _tag: "Watch" } },
  ],
  [
    "a ready sandbox stays ready while T3 restarts",
    ready,
    running,
    { status: { _tag: "ready" }, action: { _tag: "Watch" } },
  ],
  [
    "a stop requested mid-boot waits for T3 before stopping",
    { ...booting, desired: "stopped", desiredRevision: 2 },
    running,
    { status: { _tag: "booting" }, action: { _tag: "Wait" } },
  ],
  [
    "a stop requested mid-boot stops once the environment is recorded",
    { ...launching, desired: "stopped", desiredRevision: 2 },
    answering,
    { status: { _tag: "stopping" }, action: { _tag: "Stop" } },
  ],

  // Stop.
  [
    "stop while ready",
    stopRequested,
    running,
    { status: { _tag: "stopping" }, action: { _tag: "Stop" } },
  ],
  [
    "an issued stop not yet visible waits",
    { ...stopRequested, inflight: { op: "stop", startedAt: NOW - MINUTE } },
    running,
    { status: { _tag: "stopping" }, action: { _tag: "Wait" } },
  ],
  [
    "an issued stop lost past the grace is cleared and re-planned",
    { ...stopRequested, inflight: { op: "stop", startedAt: NOW - INFLIGHT_GRACE_MS } },
    running,
    { status: { _tag: "stopping" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "a stop past its deadline fails",
    { ...stopRequested, inflight: { op: "stop", startedAt: NOW - TRANSITION_DEADLINE_MS } },
    observed({ machine: machine("stopping") }),
    failed("stop", true),
  ],
  [
    "a delete gives up on a stop past its deadline",
    {
      ...stopRequested,
      desired: "destroyed",
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("stopping") }),
    { status: { _tag: "destroying" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "a delete after a stop failed past its deadline gives up on the stop",
    {
      ...stopRequested,
      status: { _tag: "failed", step: "stop", message: "x", retryable: true },
      settledRevision: 2,
      desired: "destroyed",
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - 2 * TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("stopping") }),
    { status: { _tag: "destroying" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "asking again after a stop failed past its deadline issues the stop again",
    {
      ...stopRequested,
      status: { _tag: "failed", step: "stop", message: "x", retryable: true },
      settledRevision: 2,
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - 2 * TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("stopping") }),
    { status: { _tag: "stopping" }, action: { _tag: "Stop" } },
  ],
  [
    "a resume asked for after a stop failed past its deadline issues the stop again first",
    {
      ...stopRequested,
      status: { _tag: "failed", step: "stop", message: "x", retryable: true },
      settledRevision: 2,
      desired: "running",
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - 2 * TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("stopping") }),
    { status: { _tag: "stopping" }, action: { _tag: "Stop" } },
  ],
  [
    "a stopped machine resolves the stop",
    { ...stopRequested, inflight: { op: "stop", startedAt: NOW - MINUTE } },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "stopping" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "stopped as asked",
    stopRequested,
    observed({ machine: machine("stopped") }),
    settle({ _tag: "stopped", reason: "requested" }),
  ],
  [
    "a resume requested during a stop waits for the stop to land",
    {
      ...stopRequested,
      desired: "running",
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - MINUTE },
    },
    observed({ machine: machine("stopping") }),
    { status: { _tag: "stopping" }, action: { _tag: "Wait" } },
  ],

  // Resume.
  [
    "resume a stopped sandbox",
    resumeRequested,
    observed({ machine: machine("stopped") }),
    { status: { _tag: "resuming" }, action: { _tag: "Resume" } },
  ],
  [
    "an issued resume not yet visible waits",
    { ...resumed, inflight: { op: "resume", startedAt: NOW - MINUTE } },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "resuming" }, action: { _tag: "Wait" } },
  ],
  [
    "a stop requested during a resume waits for the resume to land",
    {
      ...resumed,
      desired: "stopped",
      desiredRevision: 4,
      inflight: { op: "resume", startedAt: NOW - MINUTE },
    },
    observed({ machine: machine("starting") }),
    { status: { _tag: "resuming" }, action: { _tag: "Wait" } },
  ],
  [
    "a resume past its deadline fails",
    { ...resumed, inflight: { op: "resume", startedAt: NOW - TRANSITION_DEADLINE_MS } },
    observed({ machine: machine("starting") }),
    failed("resume", true),
  ],
  [
    "asking again after a resume failed past its deadline issues the resume again",
    {
      ...resumed,
      status: { _tag: "failed", step: "resume", message: "x", retryable: true },
      settledRevision: 3,
      desiredRevision: 4,
      inflight: { op: "resume", startedAt: NOW - TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("starting") }),
    { status: { _tag: "resuming" }, action: { _tag: "Resume" } },
  ],
  [
    "a machine starting with no resume in flight is tracked, so it gets a deadline",
    { ...resumed, credentialsStale: false },
    observed({ machine: machine("starting") }),
    { status: { _tag: "resuming" }, action: { _tag: "Track", op: "resume" } },
  ],
  [
    "a delete gives up on a resume past its deadline",
    {
      ...resumed,
      desired: "destroyed",
      desiredRevision: 4,
      inflight: { op: "resume", startedAt: NOW - TRANSITION_DEADLINE_MS },
    },
    observed({ machine: machine("starting") }),
    { status: { _tag: "destroying" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "a running machine resolves the resume",
    { ...resumed, inflight: { op: "resume", startedAt: NOW - MINUTE } },
    running,
    { status: { _tag: "resuming" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "credentials are rewritten after every resume",
    resumed,
    running,
    { status: { _tag: "resuming" }, action: { _tag: "RefreshCredentials" } },
  ],
  [
    "waits for T3 after a resume",
    { ...resumed, credentialsStale: false },
    running,
    { status: { _tag: "resuming" }, action: { _tag: "Wait" } },
  ],
  [
    "waits for T3 after a credential refresh that outlasted a transition",
    { ...resumed, runningSince: NOW - TRANSITION_DEADLINE_MS - MINUTE, credentialsStale: false },
    running,
    { status: { _tag: "resuming" }, action: { _tag: "Wait" } },
  ],
  [
    "T3 silent past the answer deadline fails, retryably",
    { ...resumed, runningSince: NOW - ANSWER_DEADLINE_MS, credentialsStale: false },
    running,
    failed("resume", true),
  ],
  [
    "T3 back with the same environment: ready",
    { ...resumed, credentialsStale: false },
    answering,
    { status: { _tag: "ready" }, action: { _tag: "Watch" } },
  ],
  [
    "T3 back as a different environment fails",
    { ...resumed, credentialsStale: false },
    observed({ machine: machine("running"), environmentId: EnvironmentId.make("env-other") }),
    failed("observe", false),
  ],

  // Stops the provider made on its own.
  [
    "a provider stop in progress while ready is tracked, so it gets a deadline",
    ready,
    observed({ machine: machine("stopping") }),
    { status: { _tag: "stopping" }, action: { _tag: "Track", op: "stop" } },
  ],
  [
    "a tracked provider stop that lands settles as the provider's stop",
    { ...ready, inflight: { op: "stop", startedAt: NOW - MINUTE } },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "stopping" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "stopped past the TTL while ready is expired, not resumed",
    { ...ready, runningSince: NOW - TTL_SECONDS * 1000 },
    observed({ machine: machine("stopped") }),
    settle({ _tag: "stopped", reason: "expired" }),
  ],
  [
    "stopped before the TTL while ready is external",
    ready,
    observed({ machine: machine("stopped") }),
    settle({ _tag: "stopped", reason: "external" }),
  ],
  [
    "an expired sandbox stays stopped until asked again",
    { ...ready, status: { _tag: "stopped", reason: "expired" } },
    observed({ machine: machine("stopped") }),
    settle({ _tag: "stopped", reason: "expired" }),
  ],
  [
    "asking for running again resumes an expired sandbox",
    { ...ready, status: { _tag: "stopped", reason: "expired" }, desiredRevision: 2 },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "resuming" }, action: { _tag: "Resume" } },
  ],
  [
    "a resume never issued before a crash is issued, not mistaken for an expiry",
    { ...resumeRequested, status: { _tag: "resuming" } },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "resuming" }, action: { _tag: "Resume" } },
  ],

  // Destroy.
  [
    "destroy a never-created sandbox",
    { ...fresh, desired: "destroyed", desiredRevision: 2 },
    observed(),
    settle({ _tag: "destroyed" }),
  ],
  [
    "destroy after a crash mid-create replays the create to find the machine",
    {
      ...fresh,
      desired: "destroyed",
      desiredRevision: 2,
      inflight: { op: "create", startedAt: NOW - MINUTE },
      createFirstAttemptAt: NOW - MINUTE,
    },
    observed(),
    { status: { _tag: "destroying" }, action: { _tag: "Create" } },
  ],
  [
    "destroy of a create unknown past the key window tells the user to check the provider",
    {
      ...fresh,
      desired: "destroyed",
      desiredRevision: 2,
      inflight: { op: "create", startedAt: NOW - CREATE_KEY_WINDOW_MS },
      createFirstAttemptAt: NOW - CREATE_KEY_WINDOW_MS,
    },
    observed(),
    failed("create", false),
  ],
  [
    "a delete after the user was told the create is unknown lets the sandbox go",
    {
      ...fresh,
      status: planNext({ ...fresh, createFirstAttemptAt: NOW - CREATE_KEY_WINDOW_MS }, observed())
        .status,
      settledRevision: 2,
      desired: "destroyed",
      desiredRevision: 3,
      inflight: { op: "create", startedAt: NOW - CREATE_KEY_WINDOW_MS },
      createFirstAttemptAt: NOW - CREATE_KEY_WINDOW_MS,
    },
    observed(),
    settle({ _tag: "destroyed" }),
  ],
  [
    "a delete after the create-unknown warning lets the sandbox go whatever its wording",
    {
      ...fresh,
      status: { _tag: "failed", step: "create", message: "reworded", retryable: false },
      settledRevision: 2,
      desired: "destroyed",
      desiredRevision: 3,
      createFirstAttemptAt: NOW - CREATE_KEY_WINDOW_MS,
    },
    observed(),
    settle({ _tag: "destroyed" }),
  ],
  [
    "a delete of a create refused outright lets the sandbox go",
    {
      ...fresh,
      status: { _tag: "failed", step: "create", message: "x", retryable: false },
      settledRevision: 1,
      desired: "destroyed",
      desiredRevision: 2,
    },
    observed(),
    settle({ _tag: "destroyed" }),
  ],
  [
    "destroy while booting",
    { ...booting, desired: "destroyed", desiredRevision: 2 },
    running,
    { status: { _tag: "destroying" }, action: { _tag: "Destroy" } },
  ],
  [
    "destroy while ready",
    { ...ready, desired: "destroyed", desiredRevision: 2 },
    running,
    { status: { _tag: "destroying" }, action: { _tag: "Destroy" } },
  ],
  [
    "destroy while stopped",
    { ...stopped, desired: "destroyed", desiredRevision: 3 },
    observed({ machine: machine("stopped") }),
    { status: { _tag: "destroying" }, action: { _tag: "Destroy" } },
  ],
  [
    "destroy while failed",
    {
      ...booting,
      status: { _tag: "failed", step: "boot", message: "x", retryable: false },
      settledRevision: 1,
      desired: "destroyed",
      desiredRevision: 2,
    },
    running,
    { status: { _tag: "destroying" }, action: { _tag: "Destroy" } },
  ],
  [
    "destroy during a resume waits for the resume to land",
    {
      ...resumed,
      desired: "destroyed",
      desiredRevision: 4,
      inflight: { op: "resume", startedAt: NOW - MINUTE },
    },
    observed({ machine: machine("starting") }),
    { status: { _tag: "resuming" }, action: { _tag: "Wait" } },
  ],
  [
    "an issued destroy not yet visible waits",
    {
      ...ready,
      desired: "destroyed",
      desiredRevision: 2,
      inflight: { op: "destroy", startedAt: NOW - MINUTE },
    },
    running,
    { status: { _tag: "destroying" }, action: { _tag: "Wait" } },
  ],
  [
    "a gone machine resolves the destroy",
    {
      ...ready,
      desired: "destroyed",
      desiredRevision: 2,
      inflight: { op: "destroy", startedAt: NOW - MINUTE },
    },
    observed(),
    { status: { _tag: "destroying" }, action: { _tag: "ClearInflight" } },
  ],
  [
    "destroyed once the machine is gone",
    { ...ready, desired: "destroyed", desiredRevision: 2 },
    observed(),
    settle({ _tag: "destroyed" }),
  ],

  // Failure and retry.
  [
    "a failed sandbox stays failed until asked again",
    {
      ...launching,
      status: { _tag: "failed", step: "launch", message: "x", retryable: true },
      settledRevision: 1,
    },
    answering,
    settle({ _tag: "failed", step: "launch", message: "x", retryable: true }),
  ],
  [
    "asking again re-plans a failed sandbox from what is observed",
    {
      ...launching,
      status: { _tag: "failed", step: "launch", message: "x", retryable: true },
      settledRevision: 1,
      desiredRevision: 2,
    },
    answering,
    { status: { _tag: "launching" }, action: { _tag: "LaunchSeed" } },
  ],
  ["a machine deleted outside T3 fails", ready, observed(), failed("observe", false)],
  [
    "a machine the provider reports failed during boot",
    booting,
    observed({ machine: machine("failed") }),
    failed("boot", false),
  ],
  [
    "a machine the provider reports failed later",
    ready,
    observed({ machine: machine("failed") }),
    failed("resume", false),
  ],
];

describe("planNext", () => {
  it.each(cases)("%s", (_, record, observation, expected) => {
    expect(planNext(record, observation)).toEqual(expected);
  });
});

/**
 * Plans step after step against a machine that never leaves `state`, applying
 * each action's facts the way the reconciler records them, and returns the
 * status the sandbox settles on, or null if it would wait forever.
 */
const settleAgainstStuckMachine = (start: SandboxRecord, state: ProviderMachineState) => {
  const inflightAfter = (action: SandboxPlan["action"], now: number, current: SandboxRecord) => {
    switch (action._tag) {
      case "Stop":
        return { op: "stop" as const, startedAt: now };
      case "Resume":
        return { op: "resume" as const, startedAt: now };
      case "Track":
        return { op: action.op, startedAt: now };
      case "ClearInflight":
        return null;
      case "Wait":
        return current.inflight;
      default:
        throw new Error(`Unexpected ${action._tag} against a stuck machine.`);
    }
  };
  let record = start;
  for (let now = NOW; now < NOW + 4 * ANSWER_DEADLINE_MS; now += MINUTE) {
    const { status, action } = planNext(record, observed({ now, machine: machine(state) }));
    if (action._tag === "Settle") return status;
    record = Object.assign({}, record, { status, inflight: inflightAfter(action, now, record) });
  }
  return null;
};

describe("planNext over time", () => {
  it("fails again, instead of waiting forever, when a retried stop never lands", () => {
    const retried: SandboxRecord = {
      ...stopRequested,
      status: { _tag: "failed", step: "stop", message: "x", retryable: true },
      settledRevision: 2,
      desiredRevision: 3,
      inflight: { op: "stop", startedAt: NOW - 2 * TRANSITION_DEADLINE_MS },
    };
    expect(settleAgainstStuckMachine(retried, "stopping")).toMatchObject({
      _tag: "failed",
      step: "stop",
      retryable: true,
    });
  });

  it("fails again when a retried resume never lands", () => {
    const retried: SandboxRecord = {
      ...resumed,
      status: { _tag: "failed", step: "resume", message: "x", retryable: true },
      settledRevision: 3,
      desiredRevision: 4,
      inflight: { op: "resume", startedAt: NOW - TRANSITION_DEADLINE_MS },
    };
    expect(settleAgainstStuckMachine(retried, "starting")).toMatchObject({
      _tag: "failed",
      step: "resume",
    });
  });

  it("fails a stop the provider began on its own that never lands", () => {
    expect(settleAgainstStuckMachine(ready, "stopping")).toMatchObject({
      _tag: "failed",
      step: "stop",
    });
  });

  it("fails a first create stuck in provisioning", () => {
    expect(settleAgainstStuckMachine(created, "starting")).toMatchObject({
      _tag: "failed",
      step: "boot",
      retryable: true,
    });
  });
});
