/**
 * ManagedSandbox - what a sandbox's own T3 server knows about the owner that
 * runs it, and the guard that keeps clients and agents in the sandbox from
 * archiving or deleting its last active top-level thread, directly or with
 * its project. That would leave the machine running unseen; the owner stops
 * or destroys the sandbox instead.
 *
 * The owner writes the marker with the boot inputs. A server without one is
 * not a sandbox and is never guarded.
 *
 * @module ManagedSandbox
 */
import {
  EnvironmentId,
  ProjectId,
  SandboxId,
  SandboxManagedByOwnerError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { MANAGED_SANDBOX_FILE } from "./sandboxBootScript.ts";

/** The subject of the admin session the owner mints in its sandboxes. */
export const SANDBOX_OWNER_SUBJECT = "sandbox-owner";

export const ManagedSandboxMarker = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  sandboxId: SandboxId,
});
export type ManagedSandboxMarker = typeof ManagedSandboxMarker.Type;

export const encodeManagedSandboxMarker = Schema.encodeSync(
  Schema.fromJsonString(ManagedSandboxMarker),
);
const decodeManagedSandboxMarker = Schema.decodeEffect(Schema.fromJsonString(ManagedSandboxMarker));

export interface ManagedSandboxGuest {
  readonly marker: ManagedSandboxMarker;
  /** Held from the guard's check through the change it allows, so two changes cannot both pass. */
  readonly lock: Semaphore.Semaphore;
}

/** Null outside a sandbox. Services read it once, when they are built. */
export class ManagedSandbox extends Context.Reference<ManagedSandboxGuest | null>(
  "t3/sandbox/ManagedSandbox",
  { defaultValue: () => null },
) {}

export const makeManagedSandboxGuest = (marker: ManagedSandboxMarker): ManagedSandboxGuest => ({
  marker,
  lock: Semaphore.makeUnsafe(1),
});

/**
 * The authenticated subject a transport is serving. Absent for the CLI and
 * other in-process callers, which the guard treats like any non-owner.
 */
export class CommandCaller extends Context.Reference<{ readonly subject: string } | null>(
  "t3/sandbox/CommandCaller",
  { defaultValue: () => null },
) {}

interface GuardedThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

/**
 * Runs `change` unless a caller other than the owner would leave the sandbox
 * with no active top-level thread: `change` removes the threads `removes`
 * picks from those `activeTopLevelThreads` reads.
 */
export const guardLastActiveThread = <A, E, R, E2, R2>(
  managed: ManagedSandboxGuest | null,
  input: {
    readonly operation: SandboxManagedByOwnerError["operation"];
    readonly activeTopLevelThreads: Effect.Effect<ReadonlyArray<GuardedThread>, E2, R2>;
    readonly removes: (thread: GuardedThread) => boolean;
  },
  change: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | E2 | SandboxManagedByOwnerError, R | R2> =>
  Effect.gen(function* () {
    if (managed === null || (yield* CommandCaller)?.subject === SANDBOX_OWNER_SUBJECT) {
      return yield* change;
    }
    return yield* managed.lock.withPermits(1)(
      Effect.gen(function* () {
        const active = yield* input.activeTopLevelThreads;
        const remaining = active.filter((thread) => !input.removes(thread));
        if (remaining.length < active.length && remaining.length === 0) {
          return yield* new SandboxManagedByOwnerError({
            ownerEnvironmentId: managed.marker.ownerEnvironmentId,
            sandboxId: managed.marker.sandboxId,
            operation: input.operation,
          });
        }
        return yield* change;
      }),
    );
  });

export const layer = Layer.effect(
  ManagedSandbox,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem
      .readFileString(path.join(config.baseDir, MANAGED_SANDBOX_FILE))
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.die(error),
        }),
      );
    // The owner writes the marker with our own schema; one it cannot decode is a bug.
    return raw === null
      ? null
      : makeManagedSandboxGuest(yield* decodeManagedSandboxMarker(raw).pipe(Effect.orDie));
  }),
);
