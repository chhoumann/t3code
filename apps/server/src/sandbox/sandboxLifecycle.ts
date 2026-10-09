/**
 * The sandbox lifecycle as a pure planner. A sandbox row holds what the user
 * asked for (`desired`, bumped `desiredRevision` on every request) and the
 * facts the reconciler has established. `planNext` turns the row plus a fresh
 * look at the provider and the guest into the status to show and the one
 * action to take next. The reconciler runs that action and plans again.
 *
 * @module sandboxLifecycle
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  SandboxRepository,
  ThreadId,
  type EnvironmentId,
  type SandboxAccountId,
  type SandboxDesired,
  SandboxMachineSize,
  type SandboxFailedStep,
  type SandboxId,
  type SandboxStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SandboxT3Source } from "./sandboxBootScript.ts";
import type { ProviderMachine, ProviderMachineId } from "./SandboxProvider.ts";

/** Boat replays a create for the same key for 24 hours; stop trusting it an hour early. */
export const CREATE_KEY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** How long a provider call may take to show up in what the provider reports. */
export const INFLIGHT_GRACE_MS = 2 * 60 * 1000;
/** From the latest create until the machine runs and T3 answers in it for the first time. */
export const FIRST_BOOT_DEADLINE_MS = 20 * 60 * 1000;
/** From a stop or resume until the machine reports it. */
export const TRANSITION_DEADLINE_MS = 10 * 60 * 1000;
/**
 * From a create or resume until T3 answers in the running machine. A resume
 * may spend a transition starting and the guest's ten-minute exec rewriting
 * credentials before T3 restarts.
 */
export const ANSWER_DEADLINE_MS = 30 * 60 * 1000;

/** Fixed at launch, so a replayed create sends the provider the same request. */
export const SandboxSpec = Schema.Struct({
  title: Schema.String,
  message: Schema.String,
  repository: SandboxRepository,
  driver: ProviderDriverKind,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  machine: Schema.Struct({
    size: SandboxMachineSize,
    ttlSeconds: Schema.NullOr(Schema.Number),
    template: Schema.NullOr(Schema.String),
    providerEnvironment: Schema.NullOr(Schema.String),
    /** Rendered once: a newer owner build must not change what a replayed create sends. */
    setupScript: Schema.String,
  }),
  t3: SandboxT3Source,
});
export type SandboxSpec = typeof SandboxSpec.Type;

/** Allocated at launch and reused by every retry, so the guest dedupes them. */
export const SandboxSeedIds = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
});
export type SandboxSeedIds = typeof SandboxSeedIds.Type;

/** A provider call that may or may not have taken effect. Persisted before the call. */
export const SandboxInflight = Schema.Struct({
  op: Schema.Literals(["create", "stop", "resume", "destroy"]),
  startedAt: Schema.Number,
});
export type SandboxInflight = typeof SandboxInflight.Type;

/** Times are epoch milliseconds. */
export interface SandboxRecord {
  readonly id: SandboxId;
  readonly accountId: SandboxAccountId;
  readonly provider: "boat";
  readonly spec: SandboxSpec;
  readonly seed: SandboxSeedIds;
  /** Written by commands only. */
  readonly desired: SandboxDesired;
  readonly desiredRevision: number;
  /** Everything below is written by the reconciler only. */
  readonly status: SandboxStatus;
  /** The desired revision the reconciler last converged on or gave up on. */
  readonly settledRevision: number;
  readonly inflight: SandboxInflight | null;
  /** The provider's idempotency key for the next create. Replaced only when a create is known not to have happened. */
  readonly createKey: string;
  /** Set while a create may have reached the provider without its machine id being stored; cleared once it is. */
  readonly createFirstAttemptAt: number | null;
  readonly machineId: ProviderMachineId | null;
  readonly httpBaseUrl: string | null;
  readonly environmentId: EnvironmentId | null;
  /** When the latest create or resume was issued. */
  readonly runningSince: number | null;
  readonly inputsWrittenAt: number | null;
  /** Set by every resume: the account's credentials must be written again for the new boot. */
  readonly credentialsStale: boolean;
  readonly seedLaunchedAt: number | null;
  readonly createdAt: number;
}

export interface SandboxObservation {
  readonly now: number;
  /** Null when there is no machine id yet or the provider no longer has the machine. */
  readonly machine: ProviderMachine | null;
  /** What the guest answered as. Null when it did not answer, or was not asked because the sandbox is ready. */
  readonly environmentId: EnvironmentId | null;
}

export type SandboxAction =
  | { readonly _tag: "Create" }
  | { readonly _tag: "WriteInputs" }
  | { readonly _tag: "Host" }
  | { readonly _tag: "RecordEnvironment"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "LaunchSeed" }
  | { readonly _tag: "RefreshCredentials" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Resume" }
  | { readonly _tag: "Destroy" }
  | { readonly _tag: "ClearInflight" }
  /** A transition the provider started on its own, recorded as in flight so it gets a deadline. */
  | { readonly _tag: "Track"; readonly op: "stop" | "resume" }
  /** Look again shortly. */
  | { readonly _tag: "Wait" }
  /** Converged and running: look again now and then, for a stop the provider makes on its own. */
  | { readonly _tag: "Watch" }
  /** Converged or given up: stop reconciling until the next request. */
  | { readonly _tag: "Settle" };

export interface SandboxPlan {
  readonly status: SandboxStatus;
  readonly action: SandboxAction;
}

const plan = (status: SandboxStatus, action: SandboxAction): SandboxPlan => ({ status, action });
const act = (
  tag: Exclude<SandboxAction["_tag"], "RecordEnvironment" | "Track">,
): SandboxAction => ({
  _tag: tag,
});

const creating: SandboxStatus = { _tag: "creating" };
const booting: SandboxStatus = { _tag: "booting" };
const launching: SandboxStatus = { _tag: "launching" };
const ready: SandboxStatus = { _tag: "ready" };
const stopping: SandboxStatus = { _tag: "stopping" };
const resuming: SandboxStatus = { _tag: "resuming" };
const destroying: SandboxStatus = { _tag: "destroying" };
const destroyed: SandboxStatus = { _tag: "destroyed" };
const failed = (step: SandboxFailedStep, message: string, retryable: boolean): SandboxStatus => ({
  _tag: "failed",
  step,
  message,
  retryable,
});
const creationUnknown = failed(
  "create",
  "T3 could not confirm whether Boat created this machine. Check the Boat dashboard, then delete the sandbox to forget it.",
  false,
);

/** Converged or given up on the latest request: nothing happens until the next one. */
export function isParked(record: SandboxRecord): boolean {
  const tag = record.status._tag;
  return (
    record.settledRevision === record.desiredRevision &&
    (tag === "stopped" || tag === "failed" || tag === "destroyed")
  );
}

export function planNext(record: SandboxRecord, observation: SandboxObservation): SandboxPlan {
  if (isParked(record)) return plan(record.status, act("Settle"));
  if (record.inflight !== null) {
    const resolution = resolveInflight(record, record.inflight, observation);
    if (resolution !== null) return resolution;
  }
  if (record.desired === "destroyed") return planDestroy(record, observation);
  if (record.machineId === null) return planCreate(record, observation);

  const machine = observation.machine;
  if (machine === null) {
    return plan(failed("observe", "The machine was deleted outside T3.", false), act("Settle"));
  }
  const firstBootDone = record.environmentId !== null;
  switch (machine.state) {
    case "failed":
      return plan(
        failed(
          firstBootDone ? "resume" : "boot",
          "The provider reports the machine failed.",
          false,
        ),
        act("Settle"),
      );
    case "stopping":
      return plan(stopping, { _tag: "Track", op: "stop" });
    case "starting":
      if (firstBootDone) return plan(resuming, { _tag: "Track", op: "resume" });
      // Retry looks at the same machine again, which may have finished provisioning since.
      return firstBootDeadlinePassed(record, observation)
        ? plan(failed("boot", "The machine did not start in time.", true), act("Settle"))
        : plan(record.inputsWrittenAt === null ? creating : booting, act("Wait"));
    case "stopped":
      return planStopped(record, observation);
    case "running":
      return firstBootDone
        ? planRunning(record, observation)
        : planFirstBoot(record, observation, machine);
  }
}

/**
 * A call that may not have shown up yet is settled by looking before anything
 * else happens, so a stop issued before a crash is never mistaken for a
 * machine that stopped on its own, and a resume is never lost under a stop.
 */
function resolveInflight(
  record: SandboxRecord,
  inflight: SandboxInflight,
  observation: SandboxObservation,
): SandboxPlan | null {
  const machine = observation.machine;
  const age = observation.now - inflight.startedAt;
  const withinGrace = age < INFLIGHT_GRACE_MS;
  switch (inflight.op) {
    case "create":
      return record.machineId === null ? null : plan(creating, act("ClearInflight"));
    case "stop":
      if (machine === null || machine.state === "stopped" || machine.state === "failed") {
        return plan(stopping, act("ClearInflight"));
      }
      if (machine.state === "stopping") {
        return age < TRANSITION_DEADLINE_MS
          ? plan(stopping, act("Wait"))
          : giveUp(record, plan(stopping, act("Stop")), "The machine did not stop in time.");
      }
      return plan(stopping, act(withinGrace ? "Wait" : "ClearInflight"));
    case "resume":
      if (machine === null || machine.state === "running" || machine.state === "failed") {
        return plan(resuming, act("ClearInflight"));
      }
      if (machine.state === "starting") {
        return age < TRANSITION_DEADLINE_MS
          ? plan(resuming, act("Wait"))
          : giveUp(record, plan(resuming, act("Resume")), "The machine did not start in time.");
      }
      return plan(resuming, act(withinGrace ? "Wait" : "ClearInflight"));
    case "destroy":
      return plan(destroying, act(machine === null || !withinGrace ? "ClearInflight" : "Wait"));
  }
}

/**
 * A transition past its deadline fails the request it served. A delete stops
 * waiting on it; any other request after that failure issues the call again,
 * which lands the transition before the request is planned.
 */
function giveUp(record: SandboxRecord, reissue: SandboxPlan, message: string): SandboxPlan {
  if (record.desired === "destroyed") return plan(destroying, act("ClearInflight"));
  if (record.status._tag === "failed") return reissue;
  const step = reissue.action._tag === "Stop" ? "stop" : "resume";
  return plan(failed(step, message, true), act("Settle"));
}

function firstBootDeadlinePassed(record: SandboxRecord, observation: SandboxObservation) {
  return observation.now - (record.runningSince ?? record.createdAt) >= FIRST_BOOT_DEADLINE_MS;
}

function planDestroy(record: SandboxRecord, observation: SandboxObservation): SandboxPlan {
  if (record.machineId !== null) {
    return observation.machine === null
      ? plan(destroyed, act("Settle"))
      : plan(destroying, act("Destroy"));
  }
  if (record.createFirstAttemptAt === null) return plan(destroyed, act("Settle"));
  // Replaying the create with the same key is the only way to learn the id of a machine it made.
  if (observation.now - record.createFirstAttemptAt < CREATE_KEY_WINDOW_MS) {
    return plan(destroying, act("Create"));
  }
  // Past the key window nothing more can be learned. The user is told to look for a stray
  // machine first; a delete after that lets the sandbox go.
  // Only that warning fails a create for good while its attempt is still unresolved: a refusal
  // that proves nothing was created clears the attempt.
  return record.status._tag === "failed" &&
    record.status.step === "create" &&
    !record.status.retryable
    ? plan(destroyed, act("Settle"))
    : plan(creationUnknown, act("Settle"));
}

function planCreate(record: SandboxRecord, observation: SandboxObservation): SandboxPlan {
  if (record.createFirstAttemptAt === null) {
    return record.desired === "stopped"
      ? plan({ _tag: "stopped", reason: "requested" }, act("Settle"))
      : plan(creating, act("Create"));
  }
  return observation.now - record.createFirstAttemptAt < CREATE_KEY_WINDOW_MS
    ? plan(creating, act("Create"))
    : plan(creationUnknown, act("Settle"));
}

function planStopped(record: SandboxRecord, observation: SandboxObservation): SandboxPlan {
  if (record.desired === "stopped") {
    return plan({ _tag: "stopped", reason: "requested" }, act("Settle"));
  }
  // Already converged on this request, so the provider stopped it; it stays stopped until asked again.
  if (record.settledRevision === record.desiredRevision) {
    const ttlMs =
      record.spec.machine.ttlSeconds === null ? null : record.spec.machine.ttlSeconds * 1000;
    const expired =
      ttlMs !== null &&
      record.runningSince !== null &&
      observation.now - record.runningSince >= ttlMs;
    return plan({ _tag: "stopped", reason: expired ? "expired" : "external" }, act("Settle"));
  }
  return plan(resuming, act("Resume"));
}

/**
 * The creation script runs once, so a stop requested mid-boot waits for T3 to
 * answer first; stopping earlier would leave a machine that never finishes
 * installing.
 */
function planFirstBoot(
  record: SandboxRecord,
  observation: SandboxObservation,
  machine: ProviderMachine,
): SandboxPlan {
  if (record.inputsWrittenAt === null) return plan(creating, act("WriteInputs"));
  if (record.httpBaseUrl === null) return plan(booting, act("Host"));
  if (observation.environmentId !== null) {
    return plan(launching, { _tag: "RecordEnvironment", environmentId: observation.environmentId });
  }
  // The provider's setup status is only meaningful here: after a resume it reports stale values.
  if (machine.setup === "failed") {
    return plan(failed("boot", "The sandbox boot script failed.", false), act("Settle"));
  }
  return firstBootDeadlinePassed(record, observation)
    ? plan(failed("boot", "T3 did not start in the sandbox in time.", false), act("Settle"))
    : plan(booting, act("Wait"));
}

function planRunning(record: SandboxRecord, observation: SandboxObservation): SandboxPlan {
  if (record.desired === "stopped") return plan(stopping, act("Stop"));
  const waiting = record.seedLaunchedAt === null ? launching : resuming;
  if (record.credentialsStale) return plan(waiting, act("RefreshCredentials"));
  if (record.status._tag === "ready") return plan(ready, act("Watch"));
  if (observation.environmentId === null) {
    const since = record.runningSince ?? record.createdAt;
    return observation.now - since < ANSWER_DEADLINE_MS
      ? plan(waiting, act("Wait"))
      : plan(
          failed(
            record.seedLaunchedAt === null ? "launch" : "resume",
            "T3 in the sandbox did not answer in time.",
            true,
          ),
          act("Settle"),
        );
  }
  if (observation.environmentId !== record.environmentId) {
    return plan(
      failed("observe", "The sandbox answers as a different environment.", false),
      act("Settle"),
    );
  }
  if (record.seedLaunchedAt === null) return plan(launching, act("LaunchSeed"));
  return plan(ready, act("Watch"));
}
