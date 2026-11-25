import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import {
  GitCommandError,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type RepositoryIdentity,
  type SandboxAccountId,
  type SandboxBranchName,
  type SandboxRemoteUrl,
  type SandboxSource,
  type VcsRef,
  type ProjectId,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import {
  parseSandboxBase,
  sandboxAccountChoices,
  sandboxLaunchLabel,
  sandboxRemoteUrlFromInput,
} from "@t3tools/client-runtime/state/sandboxes";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { ThreadStructureRuntime } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { sanitizeNewRefName } from "@t3tools/shared/git";
import { sandboxSourceForProject } from "@t3tools/shared/sandboxProject";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { m, type MessageResolver } from "../i18n/messages";
import { deriveCanInterruptRunningThread } from "../session-logic";
export { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "@t3tools/shared/git";

const isGitCommandError = Schema.is(GitCommandError);

// A toast clamps to a few lines, so Git failures show their sanitized detail
// rather than the message's operation and cwd prefix.
export function toBranchActionErrorMessage(error: unknown): string {
  if (isGitCommandError(error)) {
    return error.reason === undefined ? error.detail : `${error.detail} (${error.reason})`;
  }
  return thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
}

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
}

/** A picker entry that starts a new sandbox under one owner's account. */
export interface SandboxRunChoice {
  /** The picker value; never collides with an environment id. */
  readonly value: string;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly accountId: SandboxAccountId;
  readonly label: string;
}

/**
 * One entry per account on every environment that launches sandboxes. The
 * owner is named only when more than one environment offers accounts.
 */
export function deriveSandboxRunChoices(
  owners: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly serverConfig: Parameters<typeof sandboxAccountChoices>[1];
  }>,
): ReadonlyArray<SandboxRunChoice> {
  const perOwner = owners
    .map((owner) => ({
      owner,
      accounts: sandboxAccountChoices(owner.environmentId, owner.serverConfig),
    }))
    .filter(({ accounts }) => accounts.length > 0);
  return perOwner.flatMap(({ owner, accounts }) =>
    accounts.map((account) => ({
      value: `sandbox:${owner.environmentId}:${account.accountId}`,
      ownerEnvironmentId: owner.environmentId,
      accountId: account.accountId,
      label:
        perOwner.length > 1
          ? `${sandboxLaunchLabel(account.label)} on ${owner.label}`
          : sandboxLaunchLabel(account.label),
    })),
  );
}

/**
 * Where sending a draft goes once it picked a new sandbox. The pick is kept
 * with the draft, so while its owner is offline or no longer has the account
 * the send is refused rather than run in the draft's own environment.
 */
export function resolveSandboxDraftSend(
  target: {
    readonly ownerEnvironmentId: EnvironmentId;
    readonly accountId: SandboxAccountId;
  } | null,
  choices: ReadonlyArray<SandboxRunChoice>,
):
  | { readonly _tag: "Environment" }
  | { readonly _tag: "Sandbox"; readonly choice: SandboxRunChoice }
  | { readonly _tag: "Unavailable" } {
  if (target === null) return { _tag: "Environment" };
  const choice = choices.find(
    (candidate) =>
      candidate.ownerEnvironmentId === target.ownerEnvironmentId &&
      candidate.accountId === target.accountId,
  );
  return choice === undefined ? { _tag: "Unavailable" } : { _tag: "Sandbox", choice };
}

/**
 * What a sandbox draft clones: the repository it names, else its project's
 * remote, from the base it picked. Null when neither names a repository.
 */
export function resolveSandboxDraftSource(
  target: Partial<SandboxSource>,
  projectIdentity: RepositoryIdentity | null,
): SandboxSource | null {
  const remoteUrl = target.remoteUrl ?? sandboxSourceForProject(projectIdentity)?.remoteUrl;
  return remoteUrl === undefined ? null : { remoteUrl, base: target.base ?? { _tag: "default" } };
}

/** The one repository a draft's picker offers: the project's own, or the one typed into it. */
export type SandboxRepositoryChoice =
  | { readonly _tag: "project"; readonly remoteUrl: SandboxRemoteUrl }
  | { readonly _tag: "typed"; readonly remoteUrl: SandboxRemoteUrl };

/**
 * What the repository picker offers for `query`: the project's repository
 * while nothing is typed, else what was typed once it names a repository.
 * Null offers nothing.
 */
export function sandboxRepositoryChoice(
  query: string,
  projectRemoteUrl: SandboxRemoteUrl | null,
): SandboxRepositoryChoice | null {
  if (query.trim().length === 0) {
    return projectRemoteUrl === null ? null : { _tag: "project", remoteUrl: projectRemoteUrl };
  }
  const typed = sandboxRemoteUrlFromInput(query);
  if (typed === null) return null;
  // Typing the project's own repository follows the project rather than pinning its URL.
  return projectRemoteUrl !== null &&
    normalizeGitRemoteUrl(typed) === normalizeGitRemoteUrl(projectRemoteUrl)
    ? { _tag: "project", remoteUrl: projectRemoteUrl }
    : { _tag: "typed", remoteUrl: typed };
}

/**
 * Branches a project's checkout knows on the remote its sandbox clones,
 * offered as bases by name. The sandbox fetches the branch itself, so
 * nothing about the local checkout travels.
 */
export function sandboxBaseSuggestions(
  refs: ReadonlyArray<VcsRef>,
  identity: RepositoryIdentity,
): SandboxBranchName[] {
  // The remote `sandboxSourceForProject` clones.
  const remoteName = identity.origin === undefined ? identity.locator.remoteName : "origin";
  return refs.flatMap((ref) => {
    if (!ref.isRemote || ref.remoteName !== remoteName) return [];
    const base = parseSandboxBase(ref.name.slice(remoteName.length + 1));
    return base?._tag === "branch" ? [base.name] : [];
  });
}

/** "Add to another machine" stays muted until hovered: easy to find, quieter than the machines. */
export const ADD_TO_MACHINE_LABEL_CLASS =
  "flex min-w-0 items-center gap-1.5 opacity-55 in-data-highlighted:opacity-100 in-data-popup-open:opacity-100";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(
  input: {
    isPrimary: boolean;
    environmentId: EnvironmentId;
    runtimeLabel?: string | null;
    savedLabel?: string | null;
  },
  resolve: MessageResolver = m,
): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? resolve(msg("This device"));
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

/** Whether a new thread here may choose between Current checkout and New worktree. */
export function offersWorkspaceModes(input: {
  isScratchProject: boolean;
  isGitRepo: boolean;
  tracksGitRepositories: boolean;
}): boolean {
  // No project never has git, even while its status loads and isGitRepo still assumes it does.
  return !input.isScratchProject && (input.isGitRepo || input.tracksGitRepositories);
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  showEnvironmentIndicator: boolean;
}): boolean {
  // A new thread always shows the strip, since it names the permissions the first send uses.
  return (
    input.hasActiveProject &&
    (input.isDraftHeroState ||
      (input.persistInActiveThreads && (input.isGitRepo || input.showEnvironmentIndicator)))
  );
}

// Hysteresis prevents labels and icons from flapping at the width boundary.
const CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX = 16;

export function resolveContextStripLabelsCompact(input: {
  compact: boolean;
  neededWidth: number;
  availableWidth: number;
}): boolean {
  return input.compact
    ? input.neededWidth > input.availableWidth - CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX
    : input.neededWidth > input.availableWidth;
}

export function resolveEnvModeLabel(mode: EnvMode, resolve: MessageResolver = m): string {
  return mode === "worktree" ? resolve(msg("New worktree")) : resolve(msg("Current checkout"));
}

export const WORKTREE_SUBMODULES_LABELS: Record<WorktreeSubmodules, string> = {
  recursive: msg("Recursive"),
  "top-level": msg("Top level only"),
  none: msg("Skip"),
};

export function resolveCurrentWorkspaceLabel(
  activeWorktreePath: string | null,
  resolve: MessageResolver = m,
): string {
  return activeWorktreePath
    ? resolve(msg("Current worktree"))
    : resolveEnvModeLabel("local", resolve);
}

export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  effectiveEnvMode: EnvMode,
  resolve: MessageResolver = m,
): string {
  if (activeWorktreePath)
    return activeWorktreePath.split(/[\\/]/).findLast(Boolean) ?? resolve(msg("Worktree"));
  return effectiveEnvMode === "worktree"
    ? resolveEnvModeLabel("worktree", resolve)
    : resolve(msg("Local checkout"));
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
}

export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: { branch: string | null; worktreePath: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
      };
    }
  }
  return latest === null ? null : { branch: latest.branch, worktreePath: latest.worktreePath };
}

export function resolvePreviousWorktreeLabel(
  seed: PreviousWorktreeSeed,
  resolve: MessageResolver = m,
): string {
  return seed.branch
    ? resolve(msg("Previous worktree ({branch})", { branch: seed.branch }))
    : resolve(msg("Previous worktree"));
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  preparingWorktree?: boolean;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, preparingWorktree } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath || preparingWorktree ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export interface BranchHold {
  readonly branch: string | null;
  readonly environmentId: EnvironmentId;
  /**
   * Each checkout the thread can show before it catches up, with the branch its status reported
   * before the switch. A move from a worktree to the project root lists both.
   */
  readonly checkouts: ReadonlyArray<{ readonly cwd: string; readonly replaces: string | null }>;
}

/**
 * A finished checkout's branch stays on screen until status reports any change, because the status
 * stream and the RPC reply are not ordered and showing status first would flip back to the old branch.
 */
export function isBranchHoldCurrent(
  hold: BranchHold,
  current: {
    readonly canonicalBranch: string | null;
    readonly environmentId: EnvironmentId;
    readonly cwd: string | null;
  },
): boolean {
  return (
    hold.environmentId === current.environmentId &&
    hold.checkouts.some(
      (checkout) => checkout.cwd === current.cwd && checkout.replaces === current.canonicalBranch,
    )
  );
}

/**
 * The base a New worktree thread gets without the user picking one. Only a listed ref qualifies:
 * during a clone the status names an unborn HEAD that no ref backs.
 */
export function resolveDefaultWorktreeBaseBranch(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string | null {
  return (refs.find((ref) => ref.isDefault) ?? refs.find((ref) => ref.current))?.name ?? null;
}

export function resolveBranchTriggerLabel(
  input: {
    activeWorktreePath: string | null;
    effectiveEnvMode: EnvMode;
    resolvedActiveBranch: string | null;
    resolvedActiveBranchIsRemote: boolean | null;
    startFromOrigin: boolean;
  },
  resolve: MessageResolver = m,
): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return resolve(msg("Select ref"));
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    // Only the server can determine a local branch's configured remote.
    return startFromOrigin && resolvedActiveBranchIsRemote === false
      ? resolve(msg("From {branch} (remote)", { branch: resolvedActiveBranch }))
      : resolve(msg("From {branch}", { branch: resolvedActiveBranch }));
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

/**
 * Keeps a picked ref's worktree claim only when a read in that worktree finds it checked out.
 * `freshRead` is `null` when the read failed.
 */
export function resolveConfirmedSelectedRef(
  listedRef: VcsRef,
  freshRead: { readonly refs: ReadonlyArray<VcsRef> } | null,
): VcsRef {
  const checkedOut =
    freshRead?.refs.some((ref) => ref.name === listedRef.name && !ref.isRemote && ref.current) ??
    false;
  return checkedOut ? listedRef : { ...listedRef, worktreePath: null };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeProjectCheckoutRoot?: string | undefined;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
  staysInActiveCheckout: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    // Until the project's checkout root loads, a checkout containing the project counts as its own.
    const isProjectCheckout =
      input.activeProjectCheckoutRoot === undefined
        ? workspaceRelativeFilePath(activeProjectCwd, refName.worktreePath) !== null
        : workspaceRelativeFilePath(input.activeProjectCheckoutRoot, refName.worktreePath) === ".";
    const nextWorktreePath = isProjectCheckout ? null : refName.worktreePath;
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath,
      reuseExistingWorktree: true,
      // Listed refs can predate a checkout made outside the picker, so only Git can confirm this one.
      staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
    staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
  };
}

export function isWorktreeChangeBlocked(input: {
  runtime: ThreadStructureRuntime | null;
  currentWorktreePath: string | null;
  nextWorktreePath: string | null;
}): boolean {
  return (
    input.nextWorktreePath !== input.currentWorktreePath &&
    deriveCanInterruptRunningThread(true, input.runtime)
  );
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}
