import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type OrchestrationV2ThreadShell,
  SandboxAccountId,
  type SandboxBase,
  SandboxBranchName,
  SandboxError,
  type SandboxRemoteUrl,
  type SandboxStatus,
  type SandboxView,
  type ServerSettings,
  type ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";
import { sandboxRemoteUrl } from "@t3tools/shared/sandboxProject";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { normalizePastedCloneUrl } from "../operations/projects.ts";
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
import { createSandboxEnvironmentAtoms, wakesForWork } from "./sandboxCommands.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import type { EnvironmentShellStatus } from "./shell.ts";

export { sandboxPresence, wakesForWork };
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
  const workGrantAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      sessionWorkGrant(
        get(sessions.sessionStateAtom(workGrantEnvironmentId(get(indexAtom), environmentId))),
      ),
    ).pipe(Atom.withLabel(`sandboxes:work-grant:${environmentId}`)),
  );
  /** `workGrantAtom` once granted. */
  const canSendWorkAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(workGrantAtom(environmentId)) === "granted").pipe(
      Atom.withLabel(`sandboxes:can-send-work:${environmentId}`),
    ),
  );
  return {
    ownersAtom,
    indexAtom,
    ownerSandboxesAtom,
    presenceAtom,
    workGrantAtom,
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

/** Whether a session lets this client send work, pending until it loads. */
export type WorkGrant = "pending" | "granted" | "denied";

export function sessionWorkGrant(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
): WorkGrant {
  if (result._tag === "Initial") return "pending";
  return result._tag === "Success" &&
    sessionGrantsScope(result.value, AuthOrchestrationOperateScope)
    ? "granted"
    : "denied";
}

/**
 * How work sent to an environment's thread reaches it: now, over this
 * device's socket; once its sandbox, which sleeps, has woken; or not at all
 * while the environment is out of reach for any other reason.
 */
export type WorkDelivery = "now" | "after-wake" | "offline";

export function workDelivery(input: {
  /** The environment's sandbox, as its owner last described it; undefined for any other environment. */
  readonly sandbox:
    | (Pick<SandboxView, "desired" | "status"> & {
        readonly httpBaseUrl?: string | null | undefined;
      })
    | undefined;
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
  resolve: MFunctionType = mFallback,
): SandboxWakeStatus | null {
  switch (sandboxPresence(view)) {
    case "launching":
      switch (view.status._tag) {
        case "creating":
          return { kind: "waking", label: resolve(msg("Starting machine")) };
        case "booting":
          return { kind: "waking", label: resolve(msg("Installing T3")) };
        default:
          return { kind: "waking", label: resolve(msg("Starting thread")) };
      }
    case "asleep":
      return { kind: "asleep", label: resolve(msg("Asleep")) };
    case "waking":
      return { kind: "waking", label: resolve(msg("Waking")) };
    case "running":
      return phase === "available" || phase === "connecting" || phase === "reconnecting"
        ? { kind: "connecting", label: resolve(msg("Connecting")) }
        : null;
    case "failed":
      return view.status._tag === "failed"
        ? {
            kind: "failed",
            label:
              view.status.step === "resume"
                ? resolve(msg("Could not wake: {message}", { message: view.status.message }))
                : resolve(msg("Sandbox failed: {message}", { message: view.status.message })),
          }
        : null;
    default:
      return null;
  }
}

/** The stages a new sandbox shows before its thread opens, in order. */
const SANDBOX_LAUNCH_STAGES = ["creating", "booting", "launching"] as const;

/** Where a new sandbox is in `SANDBOX_LAUNCH_STAGES`; null once it is past them or off that path. */
export function sandboxLaunchStageIndex(status: SandboxStatus): number | null {
  const index = SANDBOX_LAUNCH_STAGES.findIndex((stage) => stage === status._tag);
  return index === -1 ? null : index;
}

/** What a sandbox on its way to its thread is doing. Ready means the thread is about to open. */
export function sandboxLaunchStatusLabel(
  status: SandboxStatus,
  resolve: MFunctionType = mFallback,
): string {
  return status._tag === "ready"
    ? resolve(msg("Opening thread"))
    : SANDBOX_STATUS_LABEL[status._tag];
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
 * Whether this device has loaded which of an environment's threads it lists:
 * at once for one it never registered (null), which lists none until it
 * connects, and once the shell it cached has loaded for one it did.
 */
function threadsLoaded(shell: EnvironmentShellStatus | null): boolean {
  return shell !== "empty";
}

/**
 * Action for the sandbox launch view: open the thread once viewable (from cache if asleep,
 * once connected if running), wake an asleep uncached sandbox if granted, or offer Resume.
 */
export type SandboxLaunchAction =
  | {
      readonly _tag: "OpenThread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly _tag: "Wake"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "Asleep" }
  | { readonly _tag: "OfferResume" }
  | { readonly _tag: "Follow" };

export function sandboxLaunchAction(input: {
  readonly view: Pick<SandboxView, "desired" | "status" | "environmentId">;
  /** The thread the sandbox lands on, as this device lists it (`sandboxLandingThreadId`). */
  readonly landingThreadId: ThreadId | null;
  /** This device's shell of the sandbox's environment; null when it never registered it. */
  readonly shell: EnvironmentShellStatus | null;
  /** Whether this client may send the sandbox work (`workGrantAtom`). */
  readonly grant: WorkGrant;
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
      if (landingThreadId !== null) {
        return { _tag: "OpenThread", environmentId, threadId: landingThreadId };
      }
      return threadsLoaded(input.shell) && input.grant === "granted"
        ? { _tag: "Wake", environmentId }
        : { _tag: "Asleep" };
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
 * Panel shown by the sandbox launch view; local wake failures only apply until the
 * sandbox's request revision advances.
 */
export type SandboxLaunchPanel =
  | { readonly _tag: "Stages"; readonly current: number }
  | { readonly _tag: "Status"; readonly label: string }
  | { readonly _tag: "Resume"; readonly label: string; readonly available: boolean }
  | {
      readonly _tag: "Failed";
      readonly heading: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly _tag: "WakeFailed";
      readonly heading: string;
      readonly message: string;
      readonly environmentId: EnvironmentId;
    };

export function sandboxLaunchPanel(
  input: {
    readonly view: Pick<SandboxView, "status" | "revision" | "environmentId">;
    readonly action: SandboxLaunchAction;
    readonly wakeFailure: SandboxWakeFailure | null;
  },
  resolve: MFunctionType = mFallback,
): SandboxLaunchPanel {
  const { view, action, wakeFailure } = input;
  if (view.status._tag === "failed") {
    return {
      _tag: "Failed",
      heading: SANDBOX_STATUS_LABEL.failed,
      message: view.status.message,
      retryable: view.status.retryable,
    };
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
    return {
      _tag: "WakeFailed",
      heading: resolve(msg("Could not wake")),
      message: wakeFailure.message,
      environmentId: view.environmentId,
    };
  }
  const stage = sandboxLaunchStageIndex(view.status);
  if (stage !== null) return { _tag: "Stages", current: stage };
  switch (action._tag) {
    case "Wake":
      return { _tag: "Status", label: SANDBOX_STATUS_LABEL.resuming };
    case "Asleep":
      return { _tag: "Status", label: resolve(msg("Asleep")) };
    default:
      return { _tag: "Status", label: sandboxLaunchStatusLabel(view.status, resolve) };
  }
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
 * Sandboxes pending until `sandboxLandingThreadId` lists their thread. Asleep sandboxes
 * stay pending only after cached shells load if the thread is still absent.
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
  /** This device's shell of an environment; null when it never registered it. */
  shellOf: (environmentId: EnvironmentId) => EnvironmentShellStatus | null,
): ReadonlyArray<PendingSandboxThread> {
  const pending: PendingSandboxThread[] = [];
  for (const [ownerEnvironmentId, views] of owners) {
    for (const view of views) {
      const presence = sandboxPresence(view);
      if (!AWAITING_THREAD.has(presence)) continue;
      const { environmentId } = view;
      if (environmentId !== null) {
        if (sandboxLandingThreadId(threadsOf(environmentId), view.threadId) !== null) continue;
        if (presence === "asleep" && !threadsLoaded(shellOf(environmentId))) continue;
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

export function sandboxLaunchLabel(
  accountLabel: string,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(msg("New sandbox · {account}", { account: accountLabel }));
}

/**
 * A typed or pasted repository, `owner/repo` or an SSH or HTTPS URL, as a
 * sandbox clones it. Null when it has no HTTPS form.
 */
export function sandboxRemoteUrlFromInput(input: string): SandboxRemoteUrl | null {
  return sandboxRemoteUrl(normalizePastedCloneUrl(input));
}

const isSandboxBranchName = Schema.is(SandboxBranchName);

/** A typed base: empty for the remote's default branch, else a branch name. Null when it is neither. */
export function parseSandboxBase(input: string): SandboxBase | null {
  const name = input.trim();
  if (name.length === 0) return { _tag: "default" };
  return isSandboxBranchName(name) ? { _tag: "branch", name } : null;
}

const isSandboxError = Schema.is(SandboxError);

/**
 * Why a sandbox command failed, in words, naming the actions an API key
 * lacks. Null when it succeeded or was interrupted, which needs no word.
 */
export function sandboxCommandFailure(
  result: AtomCommandResult<unknown, unknown>,
  resolve: MFunctionType = mFallback,
): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (
    isSandboxError(error) &&
    error.missingActions !== undefined &&
    error.missingActions.length > 0
  )
    return resolve(
      msg("This API key cannot use {actions}. Allow those actions for the key, then save again.", {
        actions: error.missingActions.join(", "),
      }),
    );
  return error instanceof Error && error.message.length > 0
    ? error.message
    : resolve(msg("An error occurred."));
}
