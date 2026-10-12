import type {
  SandboxAccountId,
  SandboxMachineSize,
  SandboxProjectDefaults,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "./git.ts";

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
