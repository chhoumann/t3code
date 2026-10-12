import type {
  GitRemote,
  RepositoryIdentity,
  SandboxAccountId,
  SandboxMachineSize,
  SandboxProjectDefaults,
  SandboxRepository,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { normalizeGitRemoteUrl, pickPrimaryRemote, repositoryIdentityFromRemotes } from "./git.ts";

/**
 * The remotes a sandbox's clone gets from a checkout: the one its branch
 * tracks, and the ones `repositoryIdentityFromRemotes` reads, so the clone
 * resolves to the checkout's repository identity.
 */
export function sandboxRemotes(
  remotes: Arr.NonEmptyReadonlyArray<GitRemote>,
  tracked: GitRemote,
): Arr.NonEmptyReadonlyArray<GitRemote> {
  const candidates: Arr.NonEmptyReadonlyArray<GitRemote> = [
    tracked,
    pickPrimaryRemote(remotes),
    ...remotes.filter((remote) => remote.name === "origin"),
  ];
  return Arr.dedupeWith(candidates, (left, right) => left.name === right.name);
}

/**
 * The project a sandbox's environment creates for its clone, named after the
 * checkout directory. The clone has the launching checkout's remotes under
 * their names, so it resolves to the checkout's repository identity: its
 * thread groups with the checkout's, and the launch reads the checkout's
 * sandbox defaults.
 */
export function sandboxProject(repository: SandboxRepository): {
  readonly title: string;
  readonly repositoryIdentity: RepositoryIdentity;
} {
  const repositoryIdentity = repositoryIdentityFromRemotes(repository.remotes);
  return {
    title:
      repositoryIdentity.locator.remoteUrl
        .replace(/\/+$/, "")
        .split(/[/:]/)
        .at(-1)
        ?.replace(/\.git$/, "") || "project",
    repositoryIdentity,
  };
}

/** All checkouts of a repository share a binding, separately for each cloud account. */
export function sandboxProjectKey(accountId: SandboxAccountId, remoteUrl: string): string {
  return JSON.stringify([accountId, normalizeGitRemoteUrl(remoteUrl)]);
}

/** Whether `key` is one of the account's `sandboxProjectKey` bindings. */
export function isSandboxProjectKeyOf(key: string, accountId: SandboxAccountId): boolean {
  return key.startsWith(`${JSON.stringify([accountId]).slice(0, -1)},`);
}

export function resolveSandboxProjectDefaults(
  account: { readonly size: SandboxMachineSize; readonly stopAfterHours: number | null },
  project: SandboxProjectDefaults | undefined,
) {
  return {
    template: project?.template ?? null,
    size: project?.size ?? account.size,
    stopAfterHours:
      project?.stopAfterHours === undefined ? account.stopAfterHours : project.stopAfterHours,
  };
}
