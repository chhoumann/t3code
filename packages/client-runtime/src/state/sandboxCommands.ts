import {
  type EnvironmentId,
  type SandboxDesired,
  SandboxError,
  type SandboxId,
  type SandboxManagedByOwnerError,
  type SandboxStatus,
  WS_METHODS,
  isSandboxManagedByOwnerError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import { type AtomCommand, createEnvironmentRpcCommand } from "./runtime.ts";

/** How long a device may take to reconnect to a sandbox once its owner reports it back. */
const RECONNECT_TIMEOUT = Duration.minutes(2);

/** Sandbox lifecycle commands, run against the environment that owns the sandbox. */
export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
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
 * Runs a thread's archive in its environment. A sandbox refuses to archive its
 * last active top-level thread, naming its owner, and that archive stops the
 * sandbox there instead.
 */
export const routeSandboxArchive = <A, E, R, B, E2, R2>(input: {
  readonly run: Effect.Effect<A, E, R>;
  readonly toOwner: (change: SandboxOwnerChange) => Effect.Effect<B, E2, R2>;
}) =>
  input.run.pipe(
    Effect.catchIf(
      (error): error is E & SandboxManagedByOwnerError => isSandboxManagedByOwnerError(error),
      (error) =>
        input.toOwner({
          ownerEnvironmentId: error.ownerEnvironmentId,
          sandboxId: error.sandboxId,
          desired: "stopped",
        }),
    ),
  );

/** A sandbox in one of these comes back when asked to run; any other state is not a resume. */
const RESUMABLE: ReadonlySet<string> = new Set(["stopping", "stopped", "resuming"]);

const notBack = (message: string) => new SandboxError({ code: "not-ready", message });

/**
 * Resolves once the owner reports the sandbox ready again, and fails once it
 * reports the resume went nowhere. The owner's list may still show the stop
 * the resume follows, so `stopped` ends the wait only after a resume showed.
 */
const awaitSandboxBack = (
  registrations: SandboxRegistrations.SandboxRegistrations["Service"],
  sandbox: { readonly ownerEnvironmentId: EnvironmentId; readonly sandboxId: SandboxId },
) =>
  SubscriptionRef.changes(registrations.owners).pipe(
    Stream.map(
      (owners) =>
        owners.get(sandbox.ownerEnvironmentId)?.find((view) => view.id === sandbox.sandboxId)
          ?.status._tag ?? "destroyed",
    ),
    Stream.mapAccum(
      () => false,
      (
        resumed,
        tag,
      ): readonly [boolean, ReadonlyArray<SandboxStatus["_tag"] | "stopped-again">] => [
        resumed || tag === "resuming",
        [tag === "stopped" && resumed ? "stopped-again" : tag],
      ],
    ),
    Stream.filter((tag) => !RESUMABLE.has(tag)),
    Stream.runHead,
    Effect.flatMap((tag) =>
      Option.getOrUndefined(tag) === "ready"
        ? Effect.void
        : Effect.fail(notBack("The sandbox did not come back, so the thread stays archived.")),
    ),
  );

/**
 * Runs `effect` in the environment once it has a session again, as it does
 * shortly after its sandbox is back.
 */
export const onceConnected = <A, E, R>(
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const session = yield* SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter(Option.isSome),
          Stream.runHead,
          Effect.timeoutOrElse({ duration: RECONNECT_TIMEOUT, orElse: () => Effect.succeedNone }),
        );
        if (Option.isNone(session)) {
          return yield* notBack("The sandbox is back, but this device could not reconnect to it.");
        }
        return yield* effect;
      }),
    );
  });

/**
 * Runs a thread's unarchive in its environment. In a sandbox that is stopped,
 * it asks the sandbox's owner to resume it and waits for it, then runs
 * `whenBack` instead, so the command stays pending until the thread is back.
 */
export const routeSandboxUnarchive = <A, E, R, A2, E2, R2, B, E3, R3>(input: {
  readonly environmentId: EnvironmentId;
  readonly run: Effect.Effect<A, E, R>;
  readonly whenBack: Effect.Effect<A2, E2, R2>;
  readonly toOwner: (change: SandboxOwnerChange) => Effect.Effect<B, E3, R3>;
}) =>
  Effect.gen(function* () {
    const registrations = yield* Effect.serviceOption(SandboxRegistrations.SandboxRegistrations);
    if (Option.isNone(registrations)) return yield* input.run;
    const sandbox = SandboxRegistrations.sandboxIndex(
      yield* SubscriptionRef.get(registrations.value.owners),
    ).get(input.environmentId);
    if (sandbox === undefined || !RESUMABLE.has(sandbox.view.status._tag)) {
      return yield* input.run;
    }
    yield* input.toOwner({
      ownerEnvironmentId: sandbox.ownerEnvironmentId,
      sandboxId: sandbox.sandboxId,
      desired: "running",
    });
    yield* awaitSandboxBack(registrations.value, sandbox);
    return yield* input.whenBack;
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
