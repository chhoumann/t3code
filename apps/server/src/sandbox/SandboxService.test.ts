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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SandboxAccounts from "./SandboxAccounts.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import type { ManagedSandboxMarker } from "./ManagedSandbox.ts";
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
const OWNER_ENV = EnvironmentId.make("env-owner");

/** An in-memory provider and guest sharing one set of machines, kept across service restarts. */
const makeWorld = () => {
  const machines = new Map<string, { state: ProviderMachineState }>();
  const machineByKey = new Map<string, ProviderMachineId>();
  const world = {
    machines,
    createKeys: [] as Array<string>,
    resumes: 0,
    credentialRefreshes: 0,
    managedMarkers: [] as Array<ManagedSandboxMarker>,
    bootEnvFiles: [] as Array<{ readonly envFile: string; readonly setupEnvFile: string }>,
    launchedThreads: [] as Array<string>,
    pairingGrants: [] as Array<{ readonly baseUrl: string; readonly scopes: unknown }>,
    secrets: new Map<string, Uint8Array>(),
    /** Admin sessions the guest accepts. */
    adminTokens: new Set<string>(),
    /** The next create registers its machine, then hangs as if its response were lost. */
    hangNextCreate: null as Deferred.Deferred<void> | null,
    failNextCreate: null as SandboxProviderErrorKind | null,
    failNextDestroy: null as SandboxProviderErrorKind | null,
    destroyAttempts: 0,
    /** The next inspect signals `entered`, then waits for `release`. */
    inspectGate: null as {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null,
    /** The next readiness check dies, then signals. */
    dieNextReadiness: null as Deferred.Deferred<void> | null,
  };

  const provider = SandboxProvider.of({
    checkAccess: () => Effect.succeed([]),
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
      Effect.gen(function* () {
        const gate = world.inspectGate;
        if (gate !== null) {
          world.inspectGate = null;
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
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
    destroy: (_account, id) =>
      Effect.gen(function* () {
        world.destroyAttempts += 1;
        const failure = world.failNextDestroy;
        if (failure !== null) {
          world.failNextDestroy = null;
          return yield* new SandboxProviderError({ operation: "destroy", kind: failure });
        }
        machines.delete(id);
      }),
  });

  const guest = SandboxGuest.SandboxGuest.of({
    writeBootInputs: (_account, _machineId, inputs) =>
      Effect.sync(() => {
        world.managedMarkers.push(inputs.managed);
        world.bootEnvFiles.push({ envFile: inputs.envFile, setupEnvFile: inputs.setupEnvFile });
      }),
    refreshCredentials: () => Effect.sync(() => void (world.credentialRefreshes += 1)),
    readEnvironmentId: (baseUrl) =>
      Effect.gen(function* () {
        const died = world.dieNextReadiness;
        if (died !== null) {
          world.dieNextReadiness = null;
          yield* Deferred.succeed(died, undefined);
          return yield* Effect.die(new Error("readiness check crashed"));
        }
        return yield* Effect.sync(() =>
          machines.get(new URL(baseUrl).hostname.split(".")[0] ?? "")?.state === "running"
            ? GUEST_ENV
            : null,
        );
      }),
    mintAdminSession: () =>
      Effect.sync(() => {
        const token = `admin-token-${world.adminTokens.size + 1}`;
        world.adminTokens.add(token);
        return Redacted.make(token);
      }),
    cloneCheckout: () => Effect.succeed([]),
    launchSeedThread: (_target, input) =>
      Effect.sync(() => void world.launchedThreads.push(input.seed.threadId)),
    issuePairingCredential: (target, grant) =>
      world.adminTokens.has(Redacted.value(target.token))
        ? Effect.sync(() => {
            world.pairingGrants.push({ baseUrl: target.baseUrl, scopes: grant.scopes });
            return Redacted.make("pairing");
          })
        : Effect.fail(
            new SandboxGuest.SandboxGuestError({ operation: "issue-pairing", unauthorized: true }),
          ),
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
          env: [
            { name: "ANTHROPIC_API_KEY", value: Redacted.make(""), setupOnly: false },
            { name: "TAILSCALE_AUTH_KEY", value: Redacted.make("tskey"), setupOnly: true },
          ],
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
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(OWNER_ENV),
        getDescriptor: Effect.die("unused"),
      }),
    ),
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
        Stream.map((views: ReadonlyArray<SandboxView>) =>
          views.find((view) => view.id === id && view.status._tag === tag),
        ),
        Stream.filter((view) => view !== undefined),
        Stream.runHead,
      ),
    ),
    Effect.map(Option.getOrThrow),
  );

const service = SandboxService.SandboxService;

/** Moves the test clock on until the sandbox shows `tag`, for steps that wait between tries. */
const advanceUntilStatus = (id: string, tag: SandboxStatus["_tag"], step: Duration.Input) =>
  Effect.gen(function* () {
    const seen = yield* Effect.forkChild(awaitStatus(id, tag));
    yield* TestClock.adjust(step).pipe(
      Effect.repeat({ until: () => seen.pollUnsafe() !== undefined }),
    );
    return yield* Fiber.join(seen);
  });

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
        // Setup-only values go only to the file the machine setup loads.
        assert.deepStrictEqual(world.bootEnvFiles, [
          { envFile: 'ANTHROPIC_API_KEY=""\n', setupEnvFile: 'TAILSCALE_AUTH_KEY="tskey"\n' },
        ]);
        // The guest learns which owner manages it and which seed to guard.
        assert.deepStrictEqual(world.managedMarkers, [
          {
            ownerEnvironmentId: OWNER_ENV,
            sandboxId: first.id,
            projectId: world.managedMarkers[0]?.projectId,
            threadId: world.launchedThreads[0],
          },
        ]);
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

  it.effect(
    "pairs a client with a ready sandbox within the caller's scopes, and only when ready",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        const started = yield* start;
        yield* Effect.gen(function* () {
          const sandboxes = yield* service;
          const id = SandboxId.make("sbx-connect");
          yield* sandboxes.launch(launchInput(id));
          yield* awaitStatus(id, "ready");
          const [machineId] = [...world.machines.keys()];
          const baseUrl = `https://${machineId}.sandbox.test`;

          const connected = yield* sandboxes.connect({ id, scopes: ["orchestration:read"] });
          assert.deepStrictEqual(connected, {
            environmentId: GUEST_ENV,
            httpBaseUrl: baseUrl,
            pairingCredential: "pairing",
          });
          assert.deepStrictEqual(world.pairingGrants, [
            { baseUrl, scopes: ["orchestration:read"] },
          ]);

          yield* sandboxes.update({ id, desired: "stopped" });
          yield* awaitStatus(id, "stopped");
          const refused = yield* sandboxes
            .connect({ id, scopes: ["orchestration:read"] })
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "SandboxNotReadyError");
          assert.strictEqual(world.pairingGrants.length, 1);
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("takes a request made during a step on the next step, not the next look", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-midstep");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        const gate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        world.inspectGate = gate;
        yield* TestClock.adjust(Duration.minutes(1));
        yield* Deferred.await(gate.entered);

        // Every client hears what was asked before the step in flight ends.
        const subscribed = yield* Deferred.make<void>();
        const asked = yield* Effect.forkChild(
          sandboxes.subscribe().pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.map((views) => views.find((view) => view.id === id)),
            Stream.filter((view) => view?.desired === "stopped"),
            Stream.runHead,
          ),
        );
        yield* Deferred.await(subscribed);
        yield* sandboxes.update({ id, desired: "stopped" });
        const heard = Option.getOrThrow(yield* Fiber.join(asked));
        assert.strictEqual(heard?.status._tag, "ready");

        yield* Deferred.succeed(gate.release, undefined);
        yield* awaitStatus(id, "stopped");
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("restarts a sandbox's loop after a defect and carries on", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const died = yield* Deferred.make<void>();
      world.dieNextReadiness = died;
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-defect");
        yield* sandboxes.launch(launchInput(id));
        yield* Deferred.await(died);
        yield* advanceUntilStatus(id, "ready", Duration.seconds(1));
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("rides out a provider outage during a delete instead of failing it", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-outage");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        world.failNextDestroy = "transient";

        yield* sandboxes.update({ id, desired: "destroyed" });
        yield* advanceUntilStatus(id, "destroyed", Duration.seconds(2));
        assert.strictEqual(world.destroyAttempts, 2);
        assert.strictEqual(world.machines.size, 0);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("mints a new owner session when the sandbox no longer accepts the stored one", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-revoked");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        world.secrets.set("sandbox-sbx-revoked-admin", new TextEncoder().encode("expired"));

        const connected = yield* sandboxes.connect({ id, scopes: ["orchestration:read"] });
        assert.strictEqual(connected.pairingCredential, "pairing");
        const stored = new TextDecoder().decode(world.secrets.get("sandbox-sbx-revoked-admin"));
        assert.isTrue(world.adminTokens.has(stored));
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
