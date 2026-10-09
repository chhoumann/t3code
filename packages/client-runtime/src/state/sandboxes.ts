import {
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
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  SandboxRegistrations,
  type SandboxIndexEntry,
  sandboxIndex,
} from "../sandbox/sandboxRegistrations.ts";
import { createSandboxEnvironmentAtoms } from "./sandboxCommands.ts";

export type { SandboxIndexEntry };

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
  return { ownersAtom, indexAtom, ownerSandboxesAtom, ...createSandboxEnvironmentAtoms(runtime) };
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
 * Asked to stop, or stopped on its own at its TTL or by the provider. Either
 * way its threads cannot be listed until it resumes.
 */
export function isSandboxStopped(view: Pick<SandboxView, "desired" | "status">): boolean {
  return view.desired === "stopped" || view.status._tag === "stopped";
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
 * Stopped sandboxes stand in for their threads elsewhere, and deleted ones
 * are gone, so neither is pending.
 */
const AWAITING_THREAD: ReadonlySet<SandboxStatus["_tag"]> = new Set([
  ...SANDBOX_LAUNCH_STAGES,
  "ready",
  "resuming",
]);

export function pendingSandboxThreads(
  owners: SandboxOwners,
  threadsOf: (environmentId: EnvironmentId) => ReadonlyArray<LandingCandidate>,
): ReadonlyArray<PendingSandboxThread> {
  const pending: PendingSandboxThread[] = [];
  for (const [ownerEnvironmentId, views] of owners) {
    for (const view of views) {
      const awaited =
        view.status._tag === "failed"
          ? view.desired !== "stopped"
          : view.desired === "running" && AWAITING_THREAD.has(view.status._tag);
      if (!awaited) continue;
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

/**
 * The project a sandbox's environment creates for its clone, as far as
 * project grouping reads it: titled after the checkout directory and
 * identified by the cloned remote. Mirrors the server's sandbox checkout path
 * and repository identity, so a launching sandbox is labeled the way its
 * thread will be.
 */
export function sandboxProject(
  repository: SandboxRepository,
): Pick<EnvironmentProject, "title" | "repositoryIdentity"> {
  const { remoteUrl } = repository;
  const canonicalKey = normalizeGitRemoteUrl(remoteUrl);
  const path = canonicalKey.split("/").slice(1);
  const owner = path[0];
  const name = path.at(-1);
  return {
    title:
      remoteUrl
        .replace(/\/+$/, "")
        .split(/[/:]/)
        .at(-1)
        ?.replace(/\.git$/, "") || "project",
    repositoryIdentity: {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
      ...(path.length > 0 ? { displayName: path.join("/") } : {}),
      ...(owner ? { owner } : {}),
      ...(name ? { name } : {}),
    },
  };
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
    "A sandbox starts from the pushed commit, so local commits would not travel. Push them first.",
};

/**
 * What a sandbox clones: the project's remote at the current commit, which
 * must already be on that remote. Local changes never reach the sandbox.
 */
export function sandboxRepositoryFor(input: {
  readonly remoteUrl: string | null;
  readonly status: VcsStatusResult | null;
}):
  | { readonly _tag: "Ready"; readonly repository: SandboxRepository }
  | { readonly _tag: "Refused"; readonly problem: SandboxRepositoryProblem } {
  const refuse = (problem: SandboxRepositoryProblem) => ({ _tag: "Refused" as const, problem });
  const { status } = input;
  if (status === null || !status.isRepo) return refuse("not-a-repository");
  if (input.remoteUrl === null || !status.hasPrimaryRemote) return refuse("no-remote");
  if (status.headCommit === undefined) return refuse("no-commit");
  // Untracked files never reach the sandbox either, but they are usually caches or build
  // output, so only edits to tracked files block a launch.
  if (status.hasTrackedChanges ?? status.hasWorkingTreeChanges)
    return refuse("uncommitted-changes");
  if (!status.hasUpstream || status.aheadCount > 0) return refuse("not-pushed");
  return {
    _tag: "Ready",
    repository: { remoteUrl: input.remoteUrl, commit: status.headCommit },
  };
}

const isSandboxError = Schema.is(SandboxError);

/** A sandbox command's failure in words, naming the actions an API key lacks. */
export function sandboxFailureMessage(error: unknown): string {
  if (
    isSandboxError(error) &&
    error.missingActions !== undefined &&
    error.missingActions.length > 0
  )
    return `This API key cannot use ${error.missingActions.join(", ")}. Allow those actions for the key, then save again.`;
  return error instanceof Error && error.message.length > 0 ? error.message : "An error occurred.";
}
