import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  SandboxAccountId,
  SandboxId,
  SandboxManagedByOwnerError,
  type SandboxStatus,
  type SandboxView,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import {
  routeSandboxArchive,
  routeSandboxUnarchive,
  type SandboxOwnerChange,
} from "./sandboxCommands.ts";

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");

const sandboxView = (status: SandboxStatus): SandboxView => ({
  id: SANDBOX_ID,
  accountId: SandboxAccountId.make("work"),
  title: "Fix the bug",
  message: "Fix the bug in hello.txt",
  repository: { remoteUrl: "https://example.test/repo.git", commit: null },
  threadId: ThreadId.make("thread-seed"),
  desired: "running",
  status,
  environmentId: SANDBOX_ENV,
  httpBaseUrl: "https://sbx-1.boat.test",
  createdAt: "2026-10-09T12:00:00.000Z",
});

type Owners = ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>;

/** The client's view of the owner's sandboxes, which a test moves along by hand. */
const makeOwners = (status: SandboxStatus | null) =>
  SubscriptionRef.make<Owners>(new Map(status === null ? [] : [[OWNER, [sandboxView(status)]]]));

const showStatus = (owners: SubscriptionRef.SubscriptionRef<Owners>, status: SandboxStatus) =>
  SubscriptionRef.set(owners, new Map([[OWNER, [sandboxView(status)]]]));

const withOwners = (owners: SubscriptionRef.SubscriptionRef<Owners>) =>
  Effect.provideService(
    SandboxRegistrations.SandboxRegistrations,
    SandboxRegistrations.SandboxRegistrations.of({ owners, start: Effect.void }),
  );

const ownerChange = (desired: SandboxOwnerChange["desired"]): ReadonlyArray<SandboxOwnerChange> => [
  { ownerEnvironmentId: OWNER, sandboxId: SANDBOX_ID, desired },
];

const ready: SandboxStatus = { _tag: "ready" };
const resuming: SandboxStatus = { _tag: "resuming" };
const stopped: SandboxStatus = { _tag: "stopped", reason: "requested" };

/** Unarchives in the sandbox; `whenBack` records that it ran after a resume. */
const unarchive = (owners: SubscriptionRef.SubscriptionRef<Owners>) => {
  const changes: Array<SandboxOwnerChange> = [];
  const run = routeSandboxUnarchive({
    environmentId: SANDBOX_ENV,
    run: Effect.succeed("unarchived"),
    whenBack: Effect.succeed("unarchived after resume"),
    toOwner: (change) => Effect.sync(() => void changes.push(change)),
  }).pipe(withOwners(owners));
  return { run, changes };
};

describe("routeSandboxArchive", () => {
  it.effect("an archive the sandbox refuses as its last active thread stops the sandbox", () =>
    Effect.gen(function* () {
      const changes: Array<SandboxOwnerChange> = [];
      const result = yield* routeSandboxArchive({
        run: Effect.fail(
          new SandboxManagedByOwnerError({
            ownerEnvironmentId: OWNER,
            sandboxId: SANDBOX_ID,
            operation: "archive-thread",
          }),
        ),
        toOwner: (change) => Effect.sync(() => changes.push(change)).pipe(Effect.as("owner")),
      });
      expect(result).toBe("owner");
      expect(changes).toEqual(ownerChange("stopped"));
    }),
  );

  it.effect("an archive the sandbox accepts stays in the sandbox", () =>
    Effect.gen(function* () {
      const changes: Array<SandboxOwnerChange> = [];
      const result = yield* routeSandboxArchive({
        run: Effect.succeed("guest"),
        toOwner: (change) => Effect.sync(() => void changes.push(change)),
      });
      expect(result).toBe("guest");
      expect(changes).toEqual([]);
    }),
  );
});

describe("routeSandboxUnarchive", () => {
  it.effect("resumes a stopped sandbox and unarchives only once it is back", () =>
    Effect.gen(function* () {
      const owners = yield* makeOwners(stopped);
      const { run, changes } = unarchive(owners);
      const pending = yield* Effect.forkChild(run);
      yield* Effect.yieldNow;
      expect(changes).toEqual(ownerChange("running"));
      expect(pending.pollUnsafe()).toBeUndefined();

      // The owner's list still shows the stop it was asked to undo, then the resume.
      yield* showStatus(owners, stopped);
      yield* showStatus(owners, resuming);
      yield* Effect.yieldNow;
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* showStatus(owners, ready);
      expect(yield* Fiber.join(pending)).toBe("unarchived after resume");
    }),
  );

  it.effect("fails when the resumed sandbox fails instead of coming back", () =>
    Effect.gen(function* () {
      const owners = yield* makeOwners(stopped);
      const { run } = unarchive(owners);
      const pending = yield* Effect.forkChild(Effect.flip(run));
      yield* Effect.yieldNow;
      yield* showStatus(owners, resuming);
      yield* showStatus(owners, {
        _tag: "failed",
        step: "resume",
        message: "The machine did not start in time.",
        retryable: true,
      });
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "SandboxError", code: "not-ready" });
    }),
  );

  it.effect("unarchives in a running sandbox, or outside one, right away", () =>
    Effect.gen(function* () {
      const running = unarchive(yield* makeOwners(ready));
      expect(yield* running.run).toBe("unarchived");
      expect(running.changes).toEqual([]);

      const failure = new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("unarchive"),
        commandType: "thread.unarchive",
        message: "Failed",
      });
      const outside = yield* routeSandboxUnarchive({
        environmentId: SANDBOX_ENV,
        run: Effect.fail(failure),
        whenBack: Effect.void,
        toOwner: () => Effect.void,
      }).pipe(withOwners(yield* makeOwners(null)), Effect.flip);
      expect(outside).toBe(failure);
    }),
  );
});
