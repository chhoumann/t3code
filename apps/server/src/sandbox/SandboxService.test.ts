import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  SandboxAccountId,
  SandboxId,
  type SandboxStatus,
  type SandboxView,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SandboxAccounts from "./SandboxAccounts.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import {
  ProviderMachineId,
  SandboxProvider,
  SandboxProviderError,
  type ProviderMachineState,
  type SandboxProviderErrorKind,
} from "./SandboxProvider.ts";
import * as SandboxService from "./SandboxService.ts";

const ACCOUNT_ID = SandboxAccountId.make("boat-work");
const GUEST_ENV = EnvironmentId.make("env-guest");

/** An in-memory provider and guest sharing one set of machines, kept across service restarts. */
const makeWorld = () => {
  const machines = new Map<string, { state: ProviderMachineState }>();
  const machineByKey = new Map<string, ProviderMachineId>();
  const world = {
    machines,
    createKeys: [] as Array<string>,
    resumes: 0,
    credentialRefreshes: 0,
    launchedThreads: [] as Array<string>,
    secrets: new Map<string, Uint8Array>(),
    /** The next create registers its machine, then hangs as if its response were lost. */
    hangNextCreate: null as Deferred.Deferred<void> | null,
    failNextCreate: null as SandboxProviderErrorKind | null,
  };

  const provider = SandboxProvider.of({
    create: (_account, input) =>
      Effect.gen(function* () {
        world.createKeys.push(input.idempotencyKey);
        const failure = world.failNextCreate;
        if (failure !== null) {
          world.failNextCreate = null;
          return yield* new SandboxProviderError({ operation: "create", kind: failure });
        }
        let id = machineByKey.get(input.idempotencyKey);
        if (id === undefined) {
          id = ProviderMachineId.make(`bx${machineByKey.size + 1}`);
          machineByKey.set(input.idempotencyKey, id);
          machines.set(id, { state: "running" });
        }
        const hang = world.hangNextCreate;
        if (hang !== null) {
          world.hangNextCreate = null;
          yield* Deferred.succeed(hang, undefined);
          return yield* Effect.never;
        }
        return { id, state: "running" as const, setup: "done" as const };
      }),
    inspect: (_account, id) =>
      Effect.sync(() => {
        const machine = machines.get(id);
        return machine === undefined ? null : { id, state: machine.state, setup: "done" as const };
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    writeFile: () => Effect.void,
    host: (_account, id) => Effect.succeed(`https://${id}.sandbox.test`),
    stop: (_account, id) => Effect.sync(() => void machines.set(id, { state: "stopped" })),
    resume: (_account, id) =>
      Effect.sync(() => {
        world.resumes += 1;
        machines.set(id, { state: "running" });
      }),
    destroy: (_account, id) => Effect.sync(() => void machines.delete(id)),
  });

  const guest = SandboxGuest.SandboxGuest.of({
    writeBootInputs: () => Effect.void,
    refreshCredentials: () => Effect.sync(() => void (world.credentialRefreshes += 1)),
    readEnvironmentId: (baseUrl) =>
      Effect.sync(() =>
        machines.get(new URL(baseUrl).hostname.split(".")[0] ?? "")?.state === "running"
          ? GUEST_ENV
          : null,
      ),
    mintAdminSession: () => Effect.succeed(Redacted.make("admin-token")),
    cloneCheckout: () => Effect.succeed([]),
    launchSeedThread: (_target, input) =>
      Effect.sync(() => {
        const resumed = world.launchedThreads.includes(input.seed.threadId);
        world.launchedThreads.push(input.seed.threadId);
        return { resumed };
      }),
    issuePairingCredential: () => Effect.succeed(Redacted.make("pairing")),
  });

  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(world.secrets.get(name))),
    set: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void world.secrets.delete(name)),
  });

  const serviceLayer = SandboxService.layer.pipe(
    Layer.provide(
      SandboxAccounts.layerStatic([
        {
          id: ACCOUNT_ID,
          provider: "boat",
          apiKey: Redacted.make("boat-key"),
          env: [{ name: "ANTHROPIC_API_KEY", value: Redacted.make("") }],
          machineSetupScript: null,
          template: null,
          providerEnvironment: null,
          size: "small",
          // One minute, so a machine stopped by the first watch is past its TTL.
          stopAfterHours: 1 / 60,
        },
      ]),
    ),
    Layer.provide(Layer.succeed(SandboxProvider, provider)),
    Layer.provide(Layer.succeed(SandboxGuest.SandboxGuest, guest)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
    Layer.provide(NodeCrypto.layer),
  );

  /** Starts the service in its own scope over the test's database; closing the scope is a crash. */
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(serviceLayer, scope);
    return { scope, context };
  });

  return { world, start };
};

const launchInput = (id: string) => ({
  id: SandboxId.make(id),
  accountId: ACCOUNT_ID,
  title: "Fix the bug",
  message: "Fix the bug in hello.txt",
  repository: { remoteUrl: "https://github.com/octocat/Hello-World.git", commit: null },
  driver: ProviderDriverKind.make("claudeAgent"),
  model: "claude-sonnet-4-6",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

/** The sandbox's view once it shows `tag`, whether it already does or does later. */
const awaitStatus = (id: string, tag: SandboxStatus["_tag"]) =>
  SandboxService.SandboxService.pipe(
    Effect.flatMap((service) =>
      service.subscribe().pipe(
        Stream.filter((view: SandboxView) => view.id === id && view.status._tag === tag),
        Stream.runHead,
      ),
    ),
    Effect.map(Option.getOrThrow),
  );

const service = SandboxService.SandboxService;

describe("SandboxService", () => {
  it.effect(
    "replays a create interrupted before its machine id was stored once, with the same key",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        const hung = yield* Deferred.make<void>();
        world.hangNextCreate = hung;

        const first = yield* start;
        yield* service.pipe(
          Effect.flatMap((sandboxes) => sandboxes.launch(launchInput("sbx-crash"))),
          Effect.provide(first.context),
        );
        yield* Deferred.await(hung);
        yield* Scope.close(first.scope, Exit.void);

        const second = yield* start;
        const view = yield* awaitStatus("sbx-crash", "ready").pipe(Effect.provide(second.context));
        yield* Scope.close(second.scope, Exit.void);

        assert.strictEqual(world.machines.size, 1);
        assert.strictEqual(world.createKeys.length, 2);
        assert.strictEqual(new Set(world.createKeys).size, 1);
        assert.strictEqual(world.launchedThreads.length, 1);
        assert.strictEqual(view.environmentId, GUEST_ENV);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("returns the first launch's sandbox when the launch is retried", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const first = yield* sandboxes.launch(launchInput("sbx-retry"));
        const second = yield* sandboxes.launch({ ...launchInput("sbx-retry"), title: "Other" });
        yield* awaitStatus("sbx-retry", "ready");

        assert.strictEqual(second.title, "Fix the bug");
        assert.strictEqual(second.createdAt, first.createdAt);
        assert.strictEqual((yield* sandboxes.list()).length, 1);
        assert.strictEqual(world.machines.size, 1);
        assert.strictEqual(world.launchedThreads.length, 1);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "converges through stop, resume, and destroy, keeping the environment across the resume",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        const started = yield* start;
        yield* Effect.gen(function* () {
          const sandboxes = yield* service;
          const id = SandboxId.make("sbx-cycle");
          yield* sandboxes.launch(launchInput(id));
          const ready = yield* awaitStatus(id, "ready");
          const [machineId] = [...world.machines.keys()];

          yield* sandboxes.update({ id, desired: "stopped" });
          const stopped = yield* awaitStatus(id, "stopped");
          assert.deepStrictEqual(stopped.status, { _tag: "stopped", reason: "requested" });
          assert.strictEqual(world.machines.get(machineId ?? "")?.state, "stopped");

          yield* sandboxes.update({ id, desired: "running" });
          const resumed = yield* awaitStatus(id, "ready");
          assert.strictEqual(resumed.environmentId, ready.environmentId);
          assert.strictEqual(world.resumes, 1);
          assert.strictEqual(world.credentialRefreshes, 1);
          assert.strictEqual(world.launchedThreads.length, 1);
          assert.isTrue(world.secrets.has("sandbox-sbx-cycle-admin"));

          yield* sandboxes.update({ id, desired: "destroyed" });
          yield* awaitStatus(id, "destroyed");
          assert.strictEqual(world.machines.size, 0);
          assert.isFalse(world.secrets.has("sandbox-sbx-cycle-admin"));
          const refused = yield* sandboxes.update({ id, desired: "running" }).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "SandboxDestroyedError");
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("records a stop at the TTL as expired and resumes only when asked", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-ttl");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        for (const machine of world.machines.values()) machine.state = "stopped";

        yield* TestClock.adjust(Duration.minutes(1));
        const expired = yield* awaitStatus(id, "stopped");
        assert.deepStrictEqual(expired.status, { _tag: "stopped", reason: "expired" });
        yield* TestClock.adjust(Duration.hours(1));
        assert.strictEqual(world.resumes, 0);

        yield* sandboxes.update({ id, desired: "running" });
        yield* awaitStatus(id, "ready");
        assert.strictEqual(world.resumes, 1);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("destroys the machine of a sandbox that crashed before its machine id was stored", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const hung = yield* Deferred.make<void>();
      world.hangNextCreate = hung;
      const id = SandboxId.make("sbx-orphan");

      const first = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        yield* sandboxes.launch(launchInput(id));
        yield* Deferred.await(hung);
        yield* sandboxes.update({ id, desired: "destroyed" });
      }).pipe(Effect.provide(first.context));
      yield* Scope.close(first.scope, Exit.void);
      assert.strictEqual(world.machines.size, 1);

      const second = yield* start;
      yield* awaitStatus(id, "destroyed").pipe(Effect.provide(second.context));
      yield* Scope.close(second.scope, Exit.void);
      assert.strictEqual(world.machines.size, 0);
      assert.strictEqual(new Set(world.createKeys).size, 1);
      assert.strictEqual(world.launchedThreads.length, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "fails on an account limit without retrying, and creates under a new key when asked again",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        world.failNextCreate = "limit";
        const started = yield* start;
        yield* Effect.gen(function* () {
          const sandboxes = yield* service;
          const id = SandboxId.make("sbx-limit");
          yield* sandboxes.launch(launchInput(id));
          const failed = yield* awaitStatus(id, "failed");
          assert.deepInclude(failed.status, { _tag: "failed", step: "create", retryable: true });
          yield* TestClock.adjust(Duration.hours(1));
          assert.strictEqual(world.createKeys.length, 1);

          yield* sandboxes.update({ id, desired: "running" });
          yield* awaitStatus(id, "ready");
          assert.strictEqual(world.createKeys.length, 2);
          assert.notStrictEqual(world.createKeys[1], world.createKeys[0]);
          assert.strictEqual(world.machines.size, 1);
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
