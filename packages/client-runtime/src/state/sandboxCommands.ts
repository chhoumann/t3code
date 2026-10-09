import {
  type EnvironmentId,
  type SandboxDesired,
  type SandboxId,
  type SandboxManagedByOwnerError,
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
 * Runs a thread's archive or unarchive in its sandbox, or hands it to the
 * sandbox's owner. Unarchiving a thread of a sandbox that is not running
 * resumes the sandbox. The sandbox refuses to archive its last active
 * top-level thread, naming its owner, and that archive stops the sandbox
 * there instead.
 */
export const routeSandboxThreadLifecycle = <A, E, R, B, E2, R2>(input: {
  readonly action: "archive" | "unarchive";
  readonly environmentId: EnvironmentId;
  readonly run: Effect.Effect<A, E, R>;
  readonly toOwner: (change: SandboxOwnerChange) => Effect.Effect<B, E2, R2>;
}) =>
  Effect.gen(function* () {
    if (input.action === "unarchive") {
      const sandboxes = yield* Effect.serviceOption(SandboxRegistrations.SandboxRegistrations);
      const sandbox = Option.isSome(sandboxes)
        ? SandboxRegistrations.sandboxIndex(yield* SubscriptionRef.get(sandboxes.value.owners)).get(
            input.environmentId,
          )
        : undefined;
      const status = sandbox?.view.status._tag;
      if (
        sandbox !== undefined &&
        status !== "ready" &&
        status !== "destroying" &&
        status !== "destroyed"
      ) {
        return yield* input.toOwner({
          ownerEnvironmentId: sandbox.ownerEnvironmentId,
          sandboxId: sandbox.sandboxId,
          desired: "running",
        });
      }
    }
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
