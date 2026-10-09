import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type SandboxDesired,
  type SandboxId,
  type SandboxManagedByOwnerError,
  type ThreadId,
  WS_METHODS,
  isSandboxManagedByOwnerError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import { type AtomCommand, createEnvironmentRpcCommand } from "./runtime.ts";

/** Sandbox lifecycle commands, run against the environment that owns the sandbox. */
export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    launch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:launch",
      tag: WS_METHODS.sandboxesLaunch,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:update",
      tag: WS_METHODS.sandboxesUpdate,
    }),
    saveAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:save-account",
      tag: WS_METHODS.sandboxesSaveAccount,
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:remove-account",
      tag: WS_METHODS.sandboxesRemoveAccount,
    }),
  };
}

export interface SandboxOwnerChange {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly desired: SandboxDesired;
}

/**
 * Archiving a sandbox's last active top-level thread stops the sandbox, and
 * unarchiving a thread of a sandbox that is not running resumes it. Both are
 * the owner's to do. Null leaves the thread command to the sandbox itself.
 */
function sandboxThreadRoute(input: {
  readonly action: "archive" | "unarchive";
  readonly sandbox: SandboxRegistrations.SandboxIndexEntry | undefined;
  readonly threadId: ThreadId;
  readonly snapshot: OrchestrationV2ShellSnapshot | null;
}): SandboxOwnerChange | null {
  const { sandbox } = input;
  if (sandbox === undefined) return null;
  const change = (desired: SandboxDesired): SandboxOwnerChange => ({
    ownerEnvironmentId: sandbox.ownerEnvironmentId,
    sandboxId: sandbox.sandboxId,
    desired,
  });
  if (input.action === "unarchive") {
    const status = sandbox.view.status._tag;
    return status === "ready" || status === "destroying" || status === "destroyed"
      ? null
      : change("running");
  }
  if (input.snapshot === null) return null;
  const activeTopLevel = input.snapshot.threads.filter(
    (thread) => thread.archivedAt === null && thread.lineage.parentThreadId === null,
  );
  return activeTopLevel.length === 1 && activeTopLevel[0]?.id === input.threadId
    ? change("stopped")
    : null;
}

/**
 * Runs a thread's archive or unarchive, or hands it to the sandbox's owner
 * per `sandboxThreadRoute`. A sandbox that refuses to archive the thread its
 * owner manages names the owner, and the archive stops the sandbox there.
 */
export const routeSandboxThreadLifecycle = <A, E, R, B, E2, R2>(input: {
  readonly action: "archive" | "unarchive";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly snapshot: OrchestrationV2ShellSnapshot | null;
  readonly run: Effect.Effect<A, E, R>;
  readonly toOwner: (change: SandboxOwnerChange) => Effect.Effect<B, E2, R2>;
}) =>
  Effect.gen(function* () {
    const sandboxes = yield* Effect.serviceOption(SandboxRegistrations.SandboxRegistrations);
    const index = Option.isSome(sandboxes)
      ? SandboxRegistrations.sandboxIndex(yield* SubscriptionRef.get(sandboxes.value.owners))
      : new Map<EnvironmentId, SandboxRegistrations.SandboxIndexEntry>();
    const route = sandboxThreadRoute({
      action: input.action,
      sandbox: index.get(input.environmentId),
      threadId: input.threadId,
      snapshot: input.snapshot,
    });
    if (route !== null) return yield* input.toOwner(route);
    return yield* input.run.pipe(
      Effect.catchIf(
        (error): error is E & SandboxManagedByOwnerError =>
          input.action === "archive" && isSandboxManagedByOwnerError(error),
        (error) =>
          input.toOwner({
            ownerEnvironmentId: error.ownerEnvironmentId,
            sandboxId: error.sandboxId,
            desired: "stopped",
          }),
      ),
    );
  });

/** Runs another command from inside a command's effect, keeping its permission checks. */
export const runAtomCommand = <W, A, E>(
  command: AtomCommand<W, A, E>,
  registry: AtomRegistry.AtomRegistry,
  input: W,
): Effect.Effect<A, E> =>
  Effect.promise(() => command.run(registry, input)).pipe(
    Effect.flatMap((result) =>
      AsyncResult.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause),
    ),
  );
