import type {
  RepositoryIdentity,
  SandboxAccountId,
  SandboxMachineSize,
  SandboxProjectDefaults,
  SandboxSource,
} from "@t3tools/contracts";
import { SandboxRemoteUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { cloneUrlForProtocol } from "./cloneUrl.ts";
import { repositoryIdentityFromRemotes, type RemoteRecognizer } from "./git.ts";

const HTTPS_CLONE_URL = /^https:\/\/(?:[^@/\s]+@)?([^/\s?#]+)\/([^\s?#]+?)\/*$/;
const decodeRemoteUrl = Schema.decodeUnknownOption(SandboxRemoteUrl);

/**
 * `url` as the guest clones it: SSH rewritten to HTTPS, credentials and a
 * trailing slash dropped. Null for a remote that has no HTTPS form, such as a
 * local path or a custom SSH port.
 */
export function sandboxRemoteUrl(url: string): SandboxRemoteUrl | null {
  const https = cloneUrlForProtocol(url, "https");
  const parts = https === null ? null : HTTPS_CLONE_URL.exec(https);
  if (parts === null) return null;
  const [, host, path] = parts;
  const option = decodeRemoteUrl(`https://${host}/${path}`);
  return option._tag === "Some" ? option.value : null;
}

/**
 * The repository a sandbox for a checkout clones, at the remote's default
 * branch: `origin` when the checkout is a fork, else the primary remote. The
 * same pick `repositoryGroupingKeyOf` names, so the sandbox groups with the
 * checkout and reads its sandbox defaults. Null without a cloneable remote.
 */
export function sandboxSourceForProject(identity: RepositoryIdentity | null): SandboxSource | null {
  if (identity === null) return null;
  const url =
    identity.origin === undefined ? identity.locator.remoteUrl : identity.origin.remoteUrl;
  const remoteUrl = url === undefined ? null : sandboxRemoteUrl(url);
  return remoteUrl === null ? null : { remoteUrl, base: { _tag: "default" } };
}

/**
 * The identity of the clone a source makes, which has one remote, `origin`.
 * The guest resolves the same identity from its clone, so grouping, defaults,
 * and the guest project agree without copying remote lists.
 */
export function sandboxRepositoryIdentity(
  source: SandboxSource,
  recognizer: RemoteRecognizer,
): RepositoryIdentity {
  return repositoryIdentityFromRemotes([{ name: "origin", url: source.remoteUrl }], recognizer);
}

/** The guest project's title, and the name of its clone directory. */
export function sandboxProjectTitle(identity: RepositoryIdentity): string {
  return identity.name ?? "project";
}

/** All checkouts of a repository share a binding, separately for each cloud account. */
export function sandboxProjectKey(
  accountId: SandboxAccountId,
  remoteUrl: string,
  recognizer: RemoteRecognizer,
): string {
  return JSON.stringify([accountId, recognizer.repositoryKeyFromRemote(remoteUrl)]);
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
