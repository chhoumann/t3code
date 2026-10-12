import {
  type EnvironmentId,
  type SandboxDesired,
  SandboxError,
  type SandboxId,
  type SandboxManagedByOwnerError,
  type SandboxStatus,
  type SandboxView,
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
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * How long a wake may take to be reported back. A resume takes a minute or
 * two; past this the owner may be gone, and the thread's other commands wait
 * behind this one.
 */
const RESUME_TIMEOUT = Duration.minutes(10);
/** How long a device may take to reconnect to a sandbox once its owner reports it awake. */
const RECONNECT_TIMEOUT = Duration.minutes(2);

/** Sandbox lifecycle commands, run against the environment that owns the sandbox. */
export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    templates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandbox:templates",
      tag: WS_METHODS.sandboxesListTemplates,
      staleTimeMs: 30_000,
    }),
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

const notAwake = (message: string) => new SandboxError({ code: "not-ready", message });

/** Statuses a sandbox rests in until it is asked for something else. */
const OUTCOMES: ReadonlySet<SandboxStatus["_tag"]> = new Set([
  "ready",
  "stopped",
  "failed",
  "destroyed",
]);

/**
 * Resolves once the owner reports the sandbox running as the outcome of the
 * request `revision` (`SandboxView.revision`), and fails once it reports that
 * request ended any other way. The owner's list may still show where the
 * sandbox stood before that request, which never ends the wait.
 */
const awaitSandboxBack = (
  registrations: SandboxRegistrations.SandboxRegistrations["Service"],
  sandbox: { readonly ownerEnvironmentId: EnvironmentId; readonly sandboxId: SandboxId },
  revision: number,
) =>
  SubscriptionRef.changes(registrations.owners).pipe(
    Stream.map((owners) =>
      owners.get(sandbox.ownerEnvironmentId)?.find((view) => view.id === sandbox.sandboxId),
    ),
    Stream.filter(
      (view) =>
        view === undefined ||
        SandboxRegistrations.sandboxPresence(view) === "gone" ||
        (view.settledRevision >= revision && OUTCOMES.has(view.status._tag)),
    ),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: RESUME_TIMEOUT,
      orElse: () => Effect.fail(notAwake("The sandbox did not wake within 10 minutes.")),
    }),
    Effect.flatMap((settled) => {
      const view = Option.getOrUndefined(settled);
      if (view === undefined || SandboxRegistrations.sandboxPresence(view) === "gone") {
        return Effect.fail(notAwake("The sandbox was deleted."));
      }
      switch (view.status._tag) {
        case "ready":
          return Effect.void;
        case "failed":
          return Effect.fail(notAwake(`The sandbox could not wake. ${view.status.message}`));
        default:
          return Effect.fail(notAwake("The sandbox stopped again before it woke."));
      }
    }),
  );

/**
 * Runs `effect` in the environment once it has a session again, as it does
 * shortly after its sandbox wakes.
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
          return yield* notAwake(
            "The sandbox is awake, but this device could not reconnect to it.",
          );
        }
        return yield* effect;
      }),
    );
  });

/** Fails at once when the sandbox's owner cannot be asked, since only it can wake the sandbox. */
const requireOwner = (ownerEnvironmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const connected = yield* registry
      .run(
        ownerEnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.session)),
          Effect.map(Option.isSome),
        ),
      )
      .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.succeed(false) }));
    if (connected) return;
    const owner = (yield* SubscriptionRef.get(registry.entries)).get(ownerEnvironmentId);
    return yield* notAwake(
      `${owner?.target.label ?? "The sandbox's owner"} is offline, so it cannot wake this sandbox.`,
    );
  });

/**
 * Whether work sent to a sandbox's environment wakes the sandbox first: it
 * sleeps, was put away, failed on its way to running, or is already waking.
 * A sandbox being deleted never wakes.
 */
export function wakesForWork(view: Pick<SandboxView, "desired" | "status">): boolean {
  if (view.desired === "destroyed") return false;
  const presence = SandboxRegistrations.sandboxPresence(view);
  return (
    presence === "asleep" ||
    presence === "put-away" ||
    presence === "failed" ||
    presence === "waking"
  );
}

/**
 * Wakes the sandbox an environment belongs to when work sent to it needs that
 * (`wakesForWork`): asks the sandbox's owner to run it, unless a resume is
 * already on its way, then waits for the owner to report it running and for
 * this device's socket to it. Succeeds with whether it had to wake; any other
 * environment is left alone.
 */
export const wakeSandbox = <E, R>(input: {
  readonly environmentId: EnvironmentId;
  /** Asks the owner for the change, succeeding with the sandbox as the owner accepted it. */
  readonly toOwner: (change: SandboxOwnerChange) => Effect.Effect<SandboxView, E, R>;
}) =>
  Effect.gen(function* () {
    const registrations = yield* Effect.serviceOption(SandboxRegistrations.SandboxRegistrations);
    if (Option.isNone(registrations)) return false;
    const sandbox = SandboxRegistrations.sandboxIndex(
      yield* SubscriptionRef.get(registrations.value.owners),
    ).get(input.environmentId);
    if (sandbox === undefined || !wakesForWork(sandbox.view)) return false;
    const { status } = sandbox.view;
    if (status._tag === "failed" && !status.retryable) {
      return yield* notAwake(`The sandbox could not wake. ${status.message}`);
    }
    const revision =
      SandboxRegistrations.sandboxPresence(sandbox.view) === "waking"
        ? sandbox.view.revision
        : yield* requireOwner(sandbox.ownerEnvironmentId).pipe(
            Effect.andThen(
              input.toOwner({
                ownerEnvironmentId: sandbox.ownerEnvironmentId,
                sandboxId: sandbox.sandboxId,
                desired: "running",
              }),
            ),
            Effect.map((accepted) => accepted.revision),
          );
    yield* awaitSandboxBack(registrations.value, sandbox, revision);
    yield* onceConnected(input.environmentId, Effect.void);
    return true;
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
