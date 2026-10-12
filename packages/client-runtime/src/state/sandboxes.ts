import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type OrchestrationV2ThreadShell,
  SandboxAccountId,
  SandboxError,
  type SandboxRepository,
  type SandboxStatus,
  type SandboxView,
  type ServerSettings,
  type ThreadId,
  type VcsStatusResult,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { sandboxRemotes } from "@t3tools/shared/sandboxProject";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  SandboxRegistrations,
  type SandboxIndexEntry,
  type SandboxPresence,
  sandboxIndex,
  sandboxPresence,
} from "../sandbox/sandboxRegistrations.ts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";
import {
  SANDBOX_RECONNECT_TIMEOUT,
  createSandboxEnvironmentAtoms,
  wakesForWork,
} from "./sandboxCommands.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

export { SANDBOX_RECONNECT_TIMEOUT, sandboxPresence, wakesForWork };
export type { SandboxIndexEntry, SandboxPresence };

type SandboxOwners = ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>;

const EMPTY_OWNERS: SandboxOwners = new Map();
const EMPTY_SANDBOXES: ReadonlyArray<SandboxView> = [];

/**
 * The sandboxes this client follows: each owner's list, including sandboxes
 * that have no environment yet, and the index of sandbox environments.
 */
export function createSandboxAtoms<R, E>(
  runtime: Atom.AtomRuntime<SandboxRegistrations | EnvironmentRegistry | R, E>,
) {
  const ownersResultAtom = runtime.atom(
    Stream.unwrap(
      SandboxRegistrations.pipe(
        Effect.map((sandboxes) => SubscriptionRef.changes(sandboxes.owners)),
      ),
    ),
    { initialValue: EMPTY_OWNERS },
  );
  const ownersAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(ownersResultAtom)), () => EMPTY_OWNERS),
  ).pipe(Atom.withLabel("sandboxes:owners"));
  const indexAtom = Atom.make((get) => sandboxIndex(get(ownersAtom))).pipe(
    Atom.withLabel("sandboxes:index"),
  );
  const ownerSandboxesAtom = Atom.family((owner: EnvironmentId) =>
    Atom.make((get) => get(ownersAtom).get(owner) ?? EMPTY_SANDBOXES).pipe(
      Atom.withLabel(`sandboxes:owner:${owner}`),
    ),
  );
  /** A sandbox environment's presence, or null for any other environment. */
  const presenceAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): SandboxPresence | null => {
      const sandbox = get(indexAtom).get(environmentId);
      return sandbox === undefined ? null : sandboxPresence(sandbox.view);
    }).pipe(Atom.withLabel(`sandboxes:presence:${environmentId}`)),
  );
  const sessions = createEnvironmentSessionAtoms(runtime);
  /**
   * Whether this client may send work to an environment's threads, read up
   * front, from the grant `workGrantEnvironmentId` names.
   */
  const canSendWorkAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(
        sessions.sessionStateAtom(workGrantEnvironmentId(get(indexAtom), environmentId)),
      );
      const session = Option.getOrNull(AsyncResult.value(result));
      return (
        result._tag !== "Failure" &&
        session !== null &&
        sessionGrantsScope(session, AuthOrchestrationOperateScope)
      );
    }).pipe(Atom.withLabel(`sandboxes:can-send-work:${environmentId}`)),
  );
  return {
    ownersAtom,
    indexAtom,
    ownerSandboxesAtom,
    presenceAtom,
    canSendWorkAtom,
    ...createSandboxEnvironmentAtoms(runtime),
  };
}

/**
 * The environment whose session says up front whether this client may send
 * work to `environmentId`. A sandbox that sleeps cannot answer for its
 * session, so its owner answers until it is back: the owner is what wakes
 * it, and the sandbox checks the work itself once it runs.
 */
export function workGrantEnvironmentId(
  index: ReadonlyMap<EnvironmentId, SandboxIndexEntry>,
  environmentId: EnvironmentId,
): EnvironmentId {
  const sandbox = index.get(environmentId);
  return sandbox !== undefined && wakesForWork(sandbox.view)
    ? sandbox.ownerEnvironmentId
    : environmentId;
}

/**
 * How work sent to an environment's thread reaches it: now, over this
 * device's socket; once its sandbox, which sleeps, has woken; or not at all
 * while the environment is out of reach for any other reason.
 */
export type WorkDelivery = "now" | "after-wake" | "offline";

export function workDelivery(input: {
  /** The environment's sandbox, as its owner last described it; undefined for any other environment. */
  readonly sandbox: Pick<SandboxView, "desired" | "status"> | undefined;
  readonly connected: boolean;
}): WorkDelivery {
  if (input.sandbox !== undefined && wakesForWork(input.sandbox)) return "after-wake";
  return input.connected ? "now" : "offline";
}

export const SANDBOX_STATUS_LABEL: Record<SandboxStatus["_tag"], string> = {
  creating: "Starting machine",
  booting: "Installing T3",
  launching: "Starting thread",
  ready: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  resuming: "Resuming",
  destroying: "Deleting",
  destroyed: "Deleted",
  failed: "Failed",
};

/**
 * What a thread of a sandbox shows while the sandbox does not serve it:
 * asleep, then waking while its owner resumes the machine, then connecting
 * until this device has a socket to it again; or why it failed, since
 * sending again retries. Null once connected, and off that path.
 */
export type SandboxWakeStatus =
  | { readonly kind: "asleep" | "waking" | "connecting"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string };

export function sandboxWakeStatus(
  view: Pick<SandboxView, "desired" | "status">,
  phase: EnvironmentConnectionPhase,
): SandboxWakeStatus | null {
  switch (sandboxPresence(view)) {
    case "asleep":
      return { kind: "asleep", label: "Asleep" };
    case "waking":
      return { kind: "waking", label: "Waking" };
    case "running":
      return phase === "available" || phase === "connecting" || phase === "reconnecting"
        ? { kind: "connecting", label: "Connecting" }
        : null;
    case "failed":
      return view.status._tag === "failed"
        ? {
            kind: "failed",
            label: `${view.status.step === "resume" ? "Could not wake" : "Sandbox failed"}: ${view.status.message}`,
          }
        : null;
    default:
      return null;
  }
}

/** The stages a new sandbox shows before its thread opens, in order. */
export const SANDBOX_LAUNCH_STAGES = ["creating", "booting", "launching"] as const;

/** Where a new sandbox is in `SANDBOX_LAUNCH_STAGES`; null once it is past them or off that path. */
export function sandboxLaunchStageIndex(status: SandboxStatus): number | null {
  const index = SANDBOX_LAUNCH_STAGES.findIndex((stage) => stage === status._tag);
  return index === -1 ? null : index;
}

/** What a sandbox on its way to its thread is doing. Ready means the thread is about to open. */
export function sandboxLaunchStatusLabel(status: SandboxStatus): string {
  return status._tag === "ready" ? "Opening thread" : SANDBOX_STATUS_LABEL[status._tag];
}

type LandingCandidate = Pick<
  OrchestrationV2ThreadShell,
  "id" | "archivedAt" | "deletedAt" | "updatedAt"
> & { readonly lineage: Pick<OrchestrationV2ThreadShell["lineage"], "parentThreadId"> };

/**
 * The thread a sandbox opens on once it runs: its first thread while that is
 * active, else the active top-level thread updated last. The sandbox always
 * keeps one active top-level thread, but its first may be archived or gone.
 */
export function sandboxLandingThreadId(
  threads: ReadonlyArray<LandingCandidate>,
  seedThreadId: ThreadId,
): ThreadId | null {
  let latest: LandingCandidate | null = null;
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (thread.lineage.parentThreadId !== null) continue;
    if (thread.id === seedThreadId) return thread.id;
    if (latest === null || DateTime.isGreaterThan(thread.updatedAt, latest.updatedAt)) {
      latest = thread;
    }
  }
  return latest?.id ?? null;
}

/**
 * What a sandbox's launch view does on this device. It opens the thread the
 * sandbox lands on once this device can show it: an asleep sandbox's from
 * cache, since sending to it wakes the sandbox, and a running one's once
 * connected. It wakes an asleep sandbox whose thread this device never
 * loaded, and offers to resume one the user put away. Otherwise it follows
 * the sandbox as its owner reports it.
 */
export type SandboxLaunchAction =
  | {
      readonly _tag: "OpenThread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly _tag: "Wake"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "OfferResume" }
  | { readonly _tag: "Follow" };

export function sandboxLaunchAction(input: {
  readonly view: Pick<SandboxView, "desired" | "status" | "environmentId">;
  /** The thread the sandbox lands on, as this device lists it (`sandboxLandingThreadId`). */
  readonly landingThreadId: ThreadId | null;
  /** Whether this device has a socket to the sandbox's environment. */
  readonly connected: boolean;
}): SandboxLaunchAction {
  const { environmentId } = input.view;
  const { landingThreadId } = input;
  switch (sandboxPresence(input.view)) {
    case "put-away":
      return { _tag: "OfferResume" };
    case "asleep":
      // A wake reaches a sandbox through its environment, which one that slept mid-launch lacks.
      if (environmentId === null) return { _tag: "OfferResume" };
      return landingThreadId === null
        ? { _tag: "Wake", environmentId }
        : { _tag: "OpenThread", environmentId, threadId: landingThreadId };
    case "running":
      return environmentId !== null && landingThreadId !== null && input.connected
        ? { _tag: "OpenThread", environmentId, threadId: landingThreadId }
        : { _tag: "Follow" };
    default:
      return { _tag: "Follow" };
  }
}

/**
 * A wake this device asked for that failed, and the sandbox's request
 * revision when it did (`SandboxView.revision`).
 */
export interface SandboxWakeFailure {
  readonly message: string;
  readonly revision: number;
}

/**
 * What a sandbox's launch view shows: the stages of a new sandbox, where it
 * stands, Resume for one the user put away, or why it failed. The sandbox's
 * own failure retries through its owner. A wake this device asked for that
 * failed retries the wake, and shows only until the sandbox's next request,
 * such as a resume asked for elsewhere, which that failure says nothing about.
 */
export type SandboxLaunchPanel =
  | { readonly _tag: "Stages"; readonly current: number }
  | { readonly _tag: "Status"; readonly label: string }
  | { readonly _tag: "Resume"; readonly label: string; readonly available: boolean }
  | { readonly _tag: "Failed"; readonly message: string; readonly retryable: boolean }
  | {
      readonly _tag: "WakeFailed";
      readonly message: string;
      readonly environmentId: EnvironmentId;
    };

export function sandboxLaunchPanel(input: {
  readonly view: Pick<SandboxView, "status" | "revision" | "environmentId">;
  readonly action: SandboxLaunchAction;
  readonly wakeFailure: SandboxWakeFailure | null;
}): SandboxLaunchPanel {
  const { view, action, wakeFailure } = input;
  if (view.status._tag === "failed") {
    return { _tag: "Failed", message: view.status.message, retryable: view.status.retryable };
  }
  if (action._tag === "OfferResume") {
    return {
      _tag: "Resume",
      label: SANDBOX_STATUS_LABEL[view.status._tag],
      available: view.status._tag !== "stopping",
    };
  }
  if (
    wakeFailure !== null &&
    wakeFailure.revision === view.revision &&
    view.environmentId !== null
  ) {
    return { _tag: "WakeFailed", message: wakeFailure.message, environmentId: view.environmentId };
  }
  const stage = sandboxLaunchStageIndex(view.status);
  if (stage !== null) return { _tag: "Stages", current: stage };
  return {
    _tag: "Status",
    label:
      action._tag === "Wake"
        ? SANDBOX_STATUS_LABEL.resuming
        : sandboxLaunchStatusLabel(view.status),
  };
}

/**
 * A sandbox listed in place of its thread: meant to run, or failed on the
 * way, while none of its environment's threads has reached this client.
 * Every client of the owner derives it from the owner's list.
 */
export interface PendingSandboxThread {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly view: SandboxView;
}

/**
 * The sandboxes to list until their thread arrives, newest first. A sandbox
 * stops being pending once its environment lists the thread its launch view
 * opens (`sandboxLandingThreadId`), so the thread replaces it in one update.
 * An asleep sandbox lists its threads from cache, so it is pending only on a
 * device that never loaded them. Put-away sandboxes stand in for their
 * threads under Settings and deleted ones are gone, so neither is pending.
 */
const AWAITING_THREAD: ReadonlySet<SandboxPresence> = new Set([
  "launching",
  "running",
  "waking",
  "asleep",
  "failed",
]);

export function pendingSandboxThreads(
  owners: SandboxOwners,
  threadsOf: (environmentId: EnvironmentId) => ReadonlyArray<LandingCandidate>,
): ReadonlyArray<PendingSandboxThread> {
  const pending: PendingSandboxThread[] = [];
  for (const [ownerEnvironmentId, views] of owners) {
    for (const view of views) {
      if (!AWAITING_THREAD.has(sandboxPresence(view))) continue;
      if (
        view.environmentId !== null &&
        sandboxLandingThreadId(threadsOf(view.environmentId), view.threadId) !== null
      ) {
        continue;
      }
      pending.push({ ownerEnvironmentId, view });
    }
  }
  return pending.sort(
    (left, right) =>
      right.view.createdAt.localeCompare(left.view.createdAt) ||
      left.view.id.localeCompare(right.view.id),
  );
}

export interface SandboxAccountChoice {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly accountId: SandboxAccountId;
  readonly label: string;
}

/** The accounts an environment can launch sandboxes under, by label. */
export function sandboxAccountChoices(
  ownerEnvironmentId: EnvironmentId,
  config: {
    readonly environment: {
      readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "sandboxes">;
    };
    readonly settings: Pick<ServerSettings, "sandboxAccounts">;
  } | null,
): ReadonlyArray<SandboxAccountChoice> {
  if (config?.environment.capabilities.sandboxes !== true) return [];
  return Object.entries(config.settings.sandboxAccounts)
    .map(([accountId, account]) => ({
      ownerEnvironmentId,
      accountId: SandboxAccountId.make(accountId),
      label: account.label,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function sandboxLaunchLabel(accountLabel: string): string {
  return `New sandbox · ${accountLabel}`;
}

export type SandboxRepositoryProblem =
  | "not-a-repository"
  | "no-remote"
  | "no-commit"
  | "uncommitted-changes"
  | "not-pushed";

export const SANDBOX_REPOSITORY_PROBLEM_MESSAGE: Record<SandboxRepositoryProblem, string> = {
  "not-a-repository": "A sandbox clones the project, so it needs a Git repository.",
  "no-remote": "A sandbox clones the project from its remote. Add one to start a sandbox.",
  "no-commit": "A sandbox starts from a commit. Make one to start a sandbox.",
  "uncommitted-changes":
    "A sandbox starts from the pushed commit, so uncommitted changes would not travel. Commit and push them first.",
  "not-pushed":
    "A sandbox clones the remote your branch tracks at its pushed commit, so local commits would not travel. Push the branch first.",
};

/**
 * What a sandbox clones: the remote the current branch tracks, at the
 * current commit, which must already be on that remote. Local changes never
 * reach the sandbox. The clone also gets the remotes the checkout's
 * repository identity reads, under the same names.
 */
export function sandboxRepositoryFor(
  status: VcsStatusResult | null,
):
  | { readonly _tag: "Ready"; readonly repository: SandboxRepository }
  | { readonly _tag: "Refused"; readonly problem: SandboxRepositoryProblem } {
  const refuse = (problem: SandboxRepositoryProblem) => ({ _tag: "Refused" as const, problem });
  if (status === null || !status.isRepo) return refuse("not-a-repository");
  const remotes = status.remotes ?? [];
  if (!Arr.isReadonlyArrayNonEmpty(remotes)) return refuse("no-remote");
  if (status.headCommit === undefined) return refuse("no-commit");
  // Untracked files never reach the sandbox either, but they are usually caches or build
  // output, so only edits to tracked files block a launch.
  if (status.hasTrackedChanges ?? status.hasWorkingTreeChanges)
    return refuse("uncommitted-changes");
  const tracked = remotes.find((remote) => remote.name === status.trackedRemote);
  if (tracked === undefined || !status.hasUpstream || status.aheadCount > 0)
    return refuse("not-pushed");
  return {
    _tag: "Ready",
    repository: {
      remotes: sandboxRemotes(remotes, tracked),
      trackedRemote: tracked.name,
      commit: status.headCommit,
    },
  };
}

const isSandboxError = Schema.is(SandboxError);

/**
 * Why a sandbox command failed, in words, naming the actions an API key
 * lacks. Null when it succeeded or was interrupted, which needs no word.
 */
export function sandboxCommandFailure(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (
    isSandboxError(error) &&
    error.missingActions !== undefined &&
    error.missingActions.length > 0
  )
    return `This API key cannot use ${error.missingActions.join(", ")}. Allow those actions for the key, then save again.`;
  return error instanceof Error && error.message.length > 0 ? error.message : "An error occurred.";
}
