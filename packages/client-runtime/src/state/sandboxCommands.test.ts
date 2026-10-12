import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SandboxAccountId,
  SandboxId,
  SandboxManagedByOwnerError,
  type SandboxStatus,
  type SandboxView,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import {
  onceConnected,
  routeSandboxArchive,
  type SandboxOwnerChange,
  wakeSandbox,
} from "./sandboxCommands.ts";

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");

const sandboxView = (
  status: SandboxStatus,
  desired: SandboxView["desired"] = "running",
): SandboxView => ({
  id: SANDBOX_ID,
  accountId: SandboxAccountId.make("work"),
  title: "Fix the bug",
  message: "Fix the bug in hello.txt",
  repository: {
    remotes: [{ name: "origin", url: "https://example.test/repo.git" }],
    trackedRemote: "origin",
    commit: null,
  },
  threadId: ThreadId.make("thread-seed"),
  desired,
  status,
  environmentId: SANDBOX_ENV,
  httpBaseUrl: "https://sbx-1.boat.test",
  createdAt: "2026-10-09T12:00:00.000Z",
});

type Owners = ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>;

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
const stopped: SandboxStatus = { _tag: "stopped", reason: "external" };

/**
 * A device that follows the owner's sandbox list. Its socket to the owner is
 * open unless `ownerConnected` is false; its socket to the sandbox opens only
 * when the test calls `connect`.
 */
const makeDevice = (view: SandboxView, options?: { readonly ownerConnected?: boolean }) =>
  Effect.gen(function* () {
    const owners = yield* SubscriptionRef.make<Owners>(new Map([[OWNER, [view]]]));
    const sessions = new Map([
      [
        OWNER,
        yield* SubscriptionRef.make(
          options?.ownerConnected === false
            ? Option.none<RpcSession>()
            : Option.some({} as RpcSession),
        ),
      ],
      [SANDBOX_ENV, yield* SubscriptionRef.make(Option.none<RpcSession>())],
    ]);
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
      environmentId,
      effect,
    ) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        EnvironmentSupervisor.EnvironmentSupervisor.of({
          session: sessions.get(environmentId)!,
        } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
      );
    const registry = {
      entries: yield* SubscriptionRef.make(
        new Map([[OWNER, { target: { label: "Work laptop" } }]]),
      ),
      run,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const changes: Array<SandboxOwnerChange> = [];
    const wake = wakeSandbox({
      environmentId: SANDBOX_ENV,
      toOwner: (change) => Effect.sync(() => void changes.push(change)),
    }).pipe(
      withOwners(owners),
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
    );
    return {
      owners,
      wake,
      changes,
      connect: SubscriptionRef.set(sessions.get(SANDBOX_ENV)!, Option.some({} as RpcSession)),
    };
  });

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

describe("wakeSandbox", () => {
  it.effect(
    "asks the owner to run an asleep sandbox, then resolves once it is back and connected",
    () =>
      Effect.gen(function* () {
        const device = yield* makeDevice(sandboxView(stopped));
        const pending = yield* Effect.forkChild(device.wake);
        yield* Effect.yieldNow;
        expect(device.changes).toEqual(ownerChange("running"));

        // The owner's list still shows the sleep it was asked to end, then the resume.
        yield* showStatus(device.owners, stopped);
        yield* showStatus(device.owners, resuming);
        yield* showStatus(device.owners, ready);
        yield* Effect.yieldNow;
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* device.connect;
        expect(yield* Fiber.join(pending)).toBe(true);
      }),
  );

  it.effect("joins a wake already on its way without asking the owner again", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(sandboxView(resuming));
      const pending = yield* Effect.forkChild(device.wake);
      yield* Effect.yieldNow;
      yield* showStatus(device.owners, ready);
      yield* Effect.yieldNow;
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* device.connect;
      expect(yield* Fiber.join(pending)).toBe(true);
      expect(device.changes).toEqual([]);
    }),
  );

  it.effect("wakes a put-away sandbox, as unarchiving its thread does", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(
        sandboxView({ _tag: "stopped", reason: "requested" }, "stopped"),
      );
      const pending = yield* Effect.forkChild(device.wake);
      yield* Effect.yieldNow;
      expect(device.changes).toEqual(ownerChange("running"));
      yield* showStatus(device.owners, ready);
      yield* device.connect;
      expect(yield* Fiber.join(pending)).toBe(true);
    }),
  );

  it.effect("leaves a running sandbox alone", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(sandboxView(ready));
      expect(yield* device.wake).toBe(false);
      expect(device.changes).toEqual([]);
    }),
  );

  it.effect("fails at once, without asking, when the owner is offline", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(sandboxView(stopped), { ownerConnected: false });
      expect(yield* Effect.flip(device.wake)).toMatchObject({
        _tag: "SandboxError",
        message: "Work laptop is offline, so it cannot wake this sandbox.",
      });
      expect(device.changes).toEqual([]);
    }),
  );

  it.effect("fails when the sandbox stops again after it showed waking", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(sandboxView(stopped));
      const pending = yield* Effect.forkChild(Effect.flip(device.wake));
      yield* Effect.yieldNow;
      yield* showStatus(device.owners, resuming);
      yield* showStatus(device.owners, stopped);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "SandboxError",
        message: "The sandbox stopped again before it woke.",
      });
    }),
  );

  it.effect("fails at once, without asking, when asking again cannot fix the sandbox", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(
        sandboxView({
          _tag: "failed",
          step: "resume",
          message: "The account's API key was revoked.",
          retryable: false,
        }),
      );
      expect(yield* Effect.flip(device.wake)).toMatchObject({
        _tag: "SandboxError",
        message: "The sandbox could not wake. The account's API key was revoked.",
      });
      expect(device.changes).toEqual([]);
    }),
  );

  it.effect("fails with the owner's reason when the machine does not come back", () =>
    Effect.gen(function* () {
      const device = yield* makeDevice(sandboxView(stopped));
      const pending = yield* Effect.forkChild(Effect.flip(device.wake));
      yield* Effect.yieldNow;
      yield* showStatus(device.owners, resuming);
      yield* showStatus(device.owners, {
        _tag: "failed",
        step: "resume",
        message: "The machine did not start in time.",
        retryable: true,
      });
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "SandboxError",
        message: "The sandbox could not wake. The machine did not start in time.",
      });
    }),
  );

  it.effect(
    "stops waiting, so the thread's next command can run, when the owner never reports back",
    () =>
      Effect.gen(function* () {
        const device = yield* makeDevice(sandboxView(stopped));
        const pending = yield* Effect.forkChild(Effect.flip(device.wake));
        yield* TestClock.adjust("9 minutes");
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 minute");
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "SandboxError",
          message: "The sandbox did not wake within 10 minutes.",
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("onceConnected", () => {
  /** A registry whose one environment has `session` as its connection. */
  const inEnvironment = (connected: boolean) =>
    Effect.gen(function* () {
      const session = yield* SubscriptionRef.make(
        connected ? Option.some({} as RpcSession) : Option.none<RpcSession>(),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        session,
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const registry = {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"];
      return {
        session,
        run: <A, E>(effect: Effect.Effect<A, E>) =>
          onceConnected(SANDBOX_ENV, effect).pipe(
            Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
          ),
      };
    });

  it.effect("runs right away in an environment that is connected", () =>
    Effect.gen(function* () {
      const { run } = yield* inEnvironment(true);
      expect(yield* run(Effect.succeed("unarchived"))).toBe("unarchived");
    }),
  );

  it.effect("runs once the environment connects", () =>
    Effect.gen(function* () {
      const { run, session } = yield* inEnvironment(false);
      const pending = yield* Effect.forkChild(run(Effect.succeed("unarchived")));
      yield* Effect.yieldNow;
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(session, Option.some({} as RpcSession));
      expect(yield* Fiber.join(pending)).toBe("unarchived");
    }),
  );

  it.effect("fails without running once the device has not reconnected in time", () =>
    Effect.gen(function* () {
      const { run } = yield* inEnvironment(false);
      let ran = false;
      const pending = yield* Effect.forkChild(
        Effect.flip(run(Effect.sync(() => void (ran = true)))),
      );
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "SandboxError", code: "not-ready" });
      expect(ran).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
