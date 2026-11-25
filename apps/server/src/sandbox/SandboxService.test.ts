import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  SandboxAccountId,
  SandboxId,
  SandboxRemoteUrl,
  ServerSettingsError,
  type SandboxSource,
  type SandboxStatus,
  type SandboxView,
} from "@t3tools/contracts";
import { sandboxProjectKey } from "@t3tools/shared/sandboxProject";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { GitHubAppConnection, type GitHubUserToken } from "./GitHubAppConnection.ts";
import * as SandboxAccounts from "./SandboxAccounts.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import type { ManagedSandboxMarker } from "./ManagedSandbox.ts";
import type { SandboxGuestActivity } from "./sandboxActivity.ts";
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

/** Where an auto-stop `ttlSeconds` from now lands. */
const deadline = (ttlSeconds: number | null) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => (ttlSeconds === null ? null : now + ttlSeconds * 1000)),
  );

/** An in-memory provider and guest sharing one set of machines, kept across service restarts. */
const makeWorld = (settingsLayer = ServerSettings.layerTest()) => {
  const machines = new Map<string, { state: ProviderMachineState; archiveAfter: number | null }>();
  const machineByKey = new Map<string, ProviderMachineId>();
  const world = {
    machines,
    templateKeys: [] as Array<string>,
    createKeys: [] as Array<string>,
    createInputs: [] as Array<Parameters<SandboxProvider["Service"]["create"]>[1]>,
    resumes: [] as Array<number | null>,
    /** Every `ttlSeconds` the owner moved a machine's deadline to. */
    deadlines: [] as Array<number>,
    /** Every deadline move fails like this; null lets them through. */
    refuseDeadlines: null as SandboxProviderErrorKind | null,
    /** Deadline moves refused by `refuseDeadlines`. */
    refusedDeadlines: 0,
    /** Every inspect fails like this; null lets them through. */
    failInspects: null as SandboxProviderErrorKind | null,
    /** Stops the owner asked for; the provider's own deadline is not one. */
    stops: 0,
    /** What the guest's agents report; null when the guest does not answer. */
    activity: { busy: false, lastActivityAt: 0 } as SandboxGuestActivity | null,
    credentialRefreshes: 0,
    /** What every credential refresh reports about T3's restart. */
    restartPendingOnRefresh: false,
    serverRestarts: 0,
    /** Signalled by the next server restart. */
    restarted: null as Deferred.Deferred<void> | null,
    /** The token the owner's GitHub App connection hands out; null when no user is connected. */
    githubToken: null as GitHubUserToken | null,
    /** How often the connection was asked for the token itself, which may refresh it. */
    tokenRequests: 0,
    /** Fed into the connection's generations stream, as a rotation would. */
    rotations: null as Queue.Queue<number | null> | null,
    /** Every token a guest was signed in with, in order with the project preparations. */
    guestSteps: [] as Array<string>,
    /** Signalled by the next token delivery. */
    delivered: null as Deferred.Deferred<number> | null,
    managedMarkers: [] as Array<ManagedSandboxMarker>,
    bootEnvFiles: [] as Array<{ readonly envFile: string; readonly setupEnvFile: string }>,
    launchedThreads: [] as Array<{ readonly threadId: string; readonly baseRef: string }>,
    prepared: [] as Array<SandboxGuest.SandboxSeedProject>,
    /** The next preparation signals, then hangs as if the owner died mid-clone. */
    hangNextPrepare: null as Deferred.Deferred<void> | null,
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
    listTemplates: (account) =>
      Effect.sync(() => {
        const key = Redacted.value(account.apiKey);
        world.templateKeys.push(key);
        return [`${key}-template`];
      }),
    create: (_account, input) =>
      Effect.gen(function* () {
        world.createKeys.push(input.idempotencyKey);
        world.createInputs.push(input);
        const failure = world.failNextCreate;
        if (failure !== null) {
          world.failNextCreate = null;
          return yield* new SandboxProviderError({ operation: "create", kind: failure });
        }
        let id = machineByKey.get(input.idempotencyKey);
        if (id === undefined) {
          id = ProviderMachineId.make(`bx${machineByKey.size + 1}`);
          machineByKey.set(input.idempotencyKey, id);
          machines.set(id, { state: "running", archiveAfter: yield* deadline(input.ttlSeconds) });
        }
        const hang = world.hangNextCreate;
        if (hang !== null) {
          world.hangNextCreate = null;
          yield* Deferred.succeed(hang, undefined);
          return yield* Effect.never;
        }
        return {
          id,
          state: "running" as const,
          setup: "done" as const,
          archiveAfter: machines.get(id)?.archiveAfter ?? null,
        };
      }),
    inspect: (_account, id) =>
      Effect.gen(function* () {
        const gate = world.inspectGate;
        if (gate !== null) {
          world.inspectGate = null;
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        if (world.failInspects !== null) {
          return yield* new SandboxProviderError({
            operation: "inspect",
            kind: world.failInspects,
          });
        }
        const machine = machines.get(id);
        if (machine === undefined) return null;
        // Boat stops a machine on its own once its deadline passes.
        const now = yield* Clock.currentTimeMillis;
        if (machine.state === "running" && machine.archiveAfter !== null) {
          if (now >= machine.archiveAfter) machine.state = "stopped";
        }
        return {
          id,
          state: machine.state,
          setup: "done" as const,
          archiveAfter: machine.archiveAfter,
        };
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    writeFile: () => Effect.void,
    host: (_account, id) => Effect.succeed(`https://${id}.sandbox.test`),
    setDeadline: (_account, id, ttlSeconds) =>
      Effect.gen(function* () {
        if (world.refuseDeadlines !== null) {
          world.refusedDeadlines += 1;
          return yield* new SandboxProviderError({
            operation: "set-deadline",
            kind: world.refuseDeadlines,
          });
        }
        world.deadlines.push(ttlSeconds);
        const machine = machines.get(id);
        if (machine !== undefined) machine.archiveAfter = yield* deadline(ttlSeconds);
      }),
    stop: (_account, id) =>
      Effect.sync(() => {
        world.stops += 1;
        const machine = machines.get(id);
        if (machine !== undefined) machine.state = "stopped";
      }),
    resume: (_account, id, input) =>
      Effect.gen(function* () {
        world.resumes.push(input.ttlSeconds);
        machines.set(id, { state: "running", archiveAfter: yield* deadline(input.ttlSeconds) });
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
    refreshCredentials: () =>
      Effect.sync(() => {
        world.credentialRefreshes += 1;
        return { restartPending: world.restartPendingOnRefresh };
      }),
    restartServer: () =>
      Effect.gen(function* () {
        world.serverRestarts += 1;
        const restarted = world.restarted;
        if (restarted !== null) {
          world.restarted = null;
          yield* Deferred.succeed(restarted, undefined);
        }
      }),
    deliverGitHubToken: (_account, _machineId, token) =>
      Effect.gen(function* () {
        world.guestSteps.push(`github-login:${token.generation}:${token.login}`);
        const delivered = world.delivered;
        if (delivered !== null) {
          world.delivered = null;
          yield* Deferred.succeed(delivered, token.generation);
        }
      }),
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
    prepareProject: (_target, project) =>
      Effect.gen(function* () {
        world.prepared.push(project);
        world.guestSteps.push("prepare");
        const hang = world.hangNextPrepare;
        if (hang !== null) {
          world.hangNextPrepare = null;
          yield* Deferred.succeed(hang, undefined);
          return yield* Effect.never;
        }
        return { branch: "main", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" };
      }),
    launchSeedThread: (_target, input) =>
      Effect.sync(
        () =>
          void world.launchedThreads.push({
            threadId: input.seed.threadId,
            baseRef: input.baseRef,
          }),
      ),
    readActivity: () =>
      world.activity === null
        ? Effect.fail(new SandboxGuest.SandboxGuestError({ operation: "read-activity" }))
        : Effect.succeed(world.activity),
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

  const connectionLayer = Layer.effect(
    GitHubAppConnection,
    Effect.gen(function* () {
      const rotations = yield* Queue.unbounded<number | null>();
      world.rotations = rotations;
      return GitHubAppConnection.of({
        current: () =>
          Effect.sync(() => {
            world.tokenRequests += 1;
            return world.githubToken;
          }),
        generation: Effect.sync(() => world.githubToken?.generation ?? null),
        generations: Stream.fromQueue(rotations),
      });
    }),
  );

  const serviceLayer = SandboxService.layer.pipe(
    Layer.provide(connectionLayer),
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
          providerEnvironment: null,
          size: "small",
          stopAfterHours: 1,
        },
        {
          id: SandboxAccountId.make("boat-personal"),
          provider: "boat",
          apiKey: Redacted.make("personal-key"),
          env: [],
          machineSetupScript: null,
          providerEnvironment: null,
          size: "default",
          stopAfterHours: 2,
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
    Layer.provideMerge(settingsLayer),
  );

  /** Starts the service in its own scope over the test's database; closing the scope is a crash. */
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(serviceLayer, scope);
    return { scope, context };
  });

  return { world, start };
};

const source = (remoteUrl: string): SandboxSource => ({
  remoteUrl: SandboxRemoteUrl.make(remoteUrl),
  base: { _tag: "default" },
});

const launchInput = (id: string) => ({
  id: SandboxId.make(id),
  accountId: ACCOUNT_ID,
  title: "Fix the bug",
  message: "Fix the bug in hello.txt",
  source: source("https://github.com/octocat/Hello-World.git"),
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

const decodeSeed = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ projectId: Schema.String, threadId: Schema.String })),
);

/** The seed ids the launch allocated for a sandbox. */
const storedSeed = (id: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ seed_json: string }>`SELECT seed_json FROM sandboxes WHERE sandbox_id = ${id}`,
    ),
    Effect.flatMap((rows) => decodeSeed(rows[0]?.seed_json ?? "")),
    Effect.orDie,
  );

/** Resolves once a launched sandbox is destroyed and so no longer listed. */
const awaitGone = (id: string) =>
  SandboxService.SandboxService.pipe(
    Effect.flatMap((service) =>
      service.subscribe().pipe(
        Stream.filter((views) => views.every((view) => view.id !== id)),
        Stream.runHead,
      ),
    ),
    Effect.asVoid,
  );

/** Moves the test clock on until `awaited` resolves, for steps that wait between tries. */
const advanceUntil = <A, E, R>(awaited: Effect.Effect<A, E, R>, step: Duration.Input) =>
  Effect.gen(function* () {
    const seen = yield* Effect.forkChild(awaited);
    yield* TestClock.adjust(step).pipe(
      Effect.repeat({ until: () => seen.pollUnsafe() !== undefined }),
    );
    return yield* Fiber.join(seen);
  });

describe("SandboxService", () => {
  it.effect("lists templates from the requested account and refuses unknown accounts", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        assert.deepStrictEqual(yield* sandboxes.listTemplates(ACCOUNT_ID), ["boat-key-template"]);
        assert.deepStrictEqual(
          yield* sandboxes.listTemplates(SandboxAccountId.make("boat-personal")),
          ["personal-key-template"],
        );
        const error = yield* sandboxes
          .listTemplates(SandboxAccountId.make("missing"))
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "SandboxAccountNotFoundError");
        assert.deepStrictEqual(world.templateKeys, ["boat-key", "personal-key"]);
        assert.deepStrictEqual(world.createKeys, []);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "uses a repository's defaults however its URL is spelled, prepares its clone, and freezes each launch",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        const started = yield* start;
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          // What the project's settings page writes: its repository identity's canonical key.
          const key = sandboxProjectKey(
            ACCOUNT_ID,
            "github.com/octocat/hello-world",
            sourceControlDefinitions,
          );
          yield* settings.updateSettings({
            sandboxProjectDefaults: {
              [key]: { template: "quickadd-dev", size: "large", stopAfterHours: 0.25 },
            },
          });
          const sandboxes = yield* service;
          yield* sandboxes.launch(launchInput("project-a"));
          const readyA = yield* awaitStatus("project-a", "ready");
          yield* sandboxes.launch({
            ...launchInput("project-b"),
            source: source("https://github.com/octocat/website.git"),
          });
          yield* awaitStatus("project-b", "ready");
          yield* sandboxes.launch({
            ...launchInput("project-a-spelled"),
            source: source("https://github.com/Octocat/Hello-World"),
          });
          yield* awaitStatus("project-a-spelled", "ready");
          assert.strictEqual(world.createInputs[0]?.template, "quickadd-dev");
          assert.strictEqual(world.createInputs[0]?.size, "large");
          // Boat's own stop leaves T3 its 30 minutes to answer, plus the 10 minute grace.
          assert.strictEqual(world.createInputs[0]?.ttlSeconds, 2400);
          assert.strictEqual(world.createInputs[1]?.template, null);
          assert.strictEqual(world.createInputs[1]?.size, "small");
          // The account's hour without activity, plus the grace.
          assert.strictEqual(world.createInputs[1]?.ttlSeconds, 4200);
          assert.strictEqual(world.createInputs[2]?.template, "quickadd-dev");
          assert.deepStrictEqual(world.bootEnvFiles[0], world.bootEnvFiles[1]);
          // The guest clones the source into a project named after the repository, then the
          // seed thread starts from the branch the preparation pinned.
          const seed = yield* storedSeed("project-a");
          assert.deepStrictEqual(world.prepared[0], {
            projectId: seed.projectId,
            title: "Hello-World",
            path: "/home/user/projects/Hello-World",
            createdAt: readyA.createdAt,
            source: launchInput("project-a").source,
          });
          assert.deepStrictEqual(world.launchedThreads[0], {
            threadId: seed.threadId,
            baseRef: "origin/main",
          });
          assert.deepStrictEqual(readyA.resolvedBase, {
            branch: "main",
            commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
          });
          yield* settings.updateSettings({
            sandboxProjectDefaults: { [key]: { template: "updated" } },
          });
          yield* sandboxes.launch(launchInput("project-a"));
          assert.strictEqual(world.createInputs.length, 3);
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("prepares the project again after a crash mid-clone, launching one thread", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const hung = yield* Deferred.make<void>();
      world.hangNextPrepare = hung;
      const id = SandboxId.make("sbx-crash-clone");

      const first = yield* start;
      yield* service.pipe(
        Effect.flatMap((sandboxes) => sandboxes.launch(launchInput(id))),
        Effect.provide(first.context),
      );
      yield* Deferred.await(hung);
      yield* Scope.close(first.scope, Exit.void);

      const second = yield* start;
      const view = yield* awaitStatus(id, "ready").pipe(Effect.provide(second.context));
      yield* Scope.close(second.scope, Exit.void);

      assert.strictEqual(world.prepared.length, 2);
      assert.strictEqual(world.prepared[0]?.projectId, world.prepared[1]?.projectId);
      assert.strictEqual(world.launchedThreads.length, 1);
      assert.strictEqual(view.resolvedBase?.branch, "main");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("fails a launch whose project defaults cannot be read, creating nothing", () =>
    Effect.gen(function* () {
      const unreadable = Layer.effect(
        ServerSettings.ServerSettingsService,
        ServerSettings.ServerSettingsService.pipe(
          Effect.map((settings) => ({
            ...settings,
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
            ),
          })),
        ),
      ).pipe(Layer.provide(ServerSettings.layerTest()));
      const { world, start } = makeWorld(unreadable);
      const started = yield* start;
      const error = yield* service.pipe(
        Effect.flatMap((sandboxes) => sandboxes.launch(launchInput("sbx-unreadable"))),
        Effect.flip,
        Effect.provide(started.context),
      );
      const listed = yield* service.pipe(
        Effect.flatMap((sandboxes) => sandboxes.list()),
        Effect.provide(started.context),
      );
      yield* Scope.close(started.scope, Exit.void);

      assert.strictEqual(error._tag, "SandboxPersistenceError");
      assert.deepStrictEqual(listed, []);
      assert.deepStrictEqual(world.createKeys, []);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

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
        // The guest learns which owner manages it.
        assert.deepStrictEqual(world.managedMarkers, [
          { ownerEnvironmentId: OWNER_ENV, sandboxId: first.id },
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
          assert.strictEqual(world.resumes.length, 1);
          assert.strictEqual(world.credentialRefreshes, 1);
          assert.strictEqual(world.launchedThreads.length, 1);
          assert.isTrue(world.secrets.has("sandbox-sbx-cycle-admin"));
          // No GitHub user is connected, so nothing was delivered and nothing waited for one.
          assert.deepStrictEqual(world.guestSteps, ["prepare"]);

          yield* sandboxes.update({ id, desired: "destroyed" });
          yield* awaitGone(id);
          assert.strictEqual(world.machines.size, 0);
          assert.deepStrictEqual(yield* sandboxes.list(), []);
          assert.isFalse(world.secrets.has("sandbox-sbx-cycle-admin"));
          const refused = yield* sandboxes.update({ id, desired: "running" }).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "SandboxDestroyedError");
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("records a stop it did not issue as external and resumes only when asked", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-external");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        for (const machine of world.machines.values()) machine.state = "stopped";

        yield* TestClock.adjust(Duration.minutes(1));
        const external = yield* awaitStatus(id, "stopped");
        assert.deepStrictEqual(external.status, { _tag: "stopped", reason: "external" });
        assert.strictEqual(external.desired, "running");
        yield* TestClock.adjust(Duration.hours(1));
        assert.strictEqual(world.resumes.length, 0);

        const accepted = yield* sandboxes.update({ id, desired: "running" });
        assert.deepInclude(accepted, { revision: 2, settledRevision: 1 });
        const resumed = yield* awaitStatus(id, "ready");
        assert.deepInclude(resumed, { revision: 2, settledRevision: 2 });
        assert.strictEqual(world.resumes.length, 1);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "keeps a sandbox running through a turn longer than its stop time, stops it once idle, and resumes it when asked",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        world.activity = { busy: true, lastActivityAt: 0 };
        const started = yield* start;
        yield* Effect.gen(function* () {
          const sandboxes = yield* service;
          const id = SandboxId.make("sbx-idle");
          yield* sandboxes.launch(launchInput(id));
          yield* awaitStatus(id, "ready");

          // Boat alone would stop the machine 70 minutes in; the turn runs for 3 hours.
          yield* advanceUntil(Effect.sleep(Duration.hours(3)), Duration.minutes(1));
          const [machine] = [...world.machines.values()];
          assert.strictEqual(machine?.state, "running");
          assert.strictEqual((yield* sandboxes.list())[0]?.status._tag, "ready");
          assert.isAbove(world.deadlines.length, 0);
          // Each move puts Boat's stop the hour's stop time plus the grace past the work.
          assert.deepStrictEqual(new Set(world.deadlines), new Set([4200]));

          const idleAt = yield* Clock.currentTimeMillis;
          world.activity = { busy: false, lastActivityAt: idleAt };
          const asleep = yield* advanceUntil(awaitStatus(id, "stopped"), Duration.minutes(1));
          assert.deepStrictEqual(asleep.status, { _tag: "stopped", reason: "idle" });
          assert.strictEqual(asleep.desired, "running");
          assert.strictEqual(world.stops, 1);
          assert.isAtLeast((yield* Clock.currentTimeMillis) - idleAt, Duration.toMillis("1 hour"));

          yield* TestClock.adjust(Duration.hours(1));
          assert.deepStrictEqual(world.resumes, []);
          yield* sandboxes.update({ id, desired: "running" });
          yield* awaitStatus(id, "ready");
          assert.deepStrictEqual(world.resumes, [4200]);
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("keeps a working sandbox ready when Boat refuses to move its stop", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      world.activity = { busy: true, lastActivityAt: 0 };
      world.refuseDeadlines = "missing-scope";
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-refused-deadline");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");

        yield* advanceUntil(Effect.sleep(Duration.minutes(30)), Duration.minutes(1));
        const [machine] = [...world.machines.values()];
        assert.strictEqual(machine?.state, "running");
        assert.deepStrictEqual((yield* sandboxes.list())[0]?.status, { _tag: "ready" });
        assert.isAbove(world.refusedDeadlines, 0);
        assert.deepStrictEqual(world.deadlines, []);
        assert.strictEqual(world.stops, 0);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "tells a waiting client how a retried wake ended when it fails the same way again",
    () =>
      Effect.gen(function* () {
        const { world, start } = makeWorld();
        const started = yield* start;
        yield* Effect.gen(function* () {
          const sandboxes = yield* service;
          const id = SandboxId.make("sbx-same-failure");
          yield* sandboxes.launch(launchInput(id));
          yield* awaitStatus(id, "ready");
          world.failInspects = "unauthorized";
          const failed = yield* advanceUntil(awaitStatus(id, "failed"), Duration.minutes(1));
          assert.deepInclude(failed, { revision: 1, settledRevision: 1 });

          // Subscribed before the retry, so only what the owner publishes can end the wait.
          const subscribed = yield* Deferred.make<void>();
          const waiting = yield* Effect.forkChild(
            sandboxes.subscribe().pipe(
              Stream.tap(() => Deferred.succeed(subscribed, undefined)),
              Stream.map((views) => views.find((view) => view.id === id)),
              Stream.filter((view) => view !== undefined && view.settledRevision >= 2),
              Stream.runHead,
            ),
          );
          yield* Deferred.await(subscribed);
          const accepted = yield* sandboxes.update({ id, desired: "running" });
          assert.deepInclude(accepted, { revision: 2, settledRevision: 1 });

          const settled = yield* advanceUntil(
            Fiber.join(waiting).pipe(
              Effect.timeoutOrElse({
                duration: Duration.minutes(10),
                orElse: () => Effect.die(new Error("the retry's outcome was never published")),
              }),
            ),
            Duration.minutes(1),
          );
          assert.deepInclude(Option.getOrThrow(settled), {
            revision: 2,
            settledRevision: 2,
            status: failed.status,
          });
        }).pipe(Effect.provide(started.context));
        yield* Scope.close(started.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("leaves a sandbox whose T3 does not answer to Boat's own stop, as external", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      world.activity = null;
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-silent");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        const readyAt = yield* Clock.currentTimeMillis;

        const stopped = yield* advanceUntil(awaitStatus(id, "stopped"), Duration.minutes(1));
        assert.deepStrictEqual(stopped.status, { _tag: "stopped", reason: "external" });
        assert.strictEqual(stopped.desired, "running");
        assert.strictEqual(world.stops, 0);
        assert.deepStrictEqual(world.deadlines, []);
        assert.isAtLeast(
          (yield* Clock.currentTimeMillis) - readyAt,
          Duration.toMillis("70 minutes"),
        );
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
      yield* awaitGone(id).pipe(Effect.provide(second.context));
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
        yield* advanceUntil(awaitStatus(id, "ready"), Duration.seconds(1));
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
        yield* advanceUntil(awaitGone(id), Duration.seconds(2));
        assert.strictEqual(world.destroyAttempts, 2);
        assert.strictEqual(world.machines.size, 0);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("does nothing for a launch retried after its sandbox was destroyed", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-late-retry");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        yield* sandboxes.update({ id, desired: "destroyed" });
        yield* awaitGone(id);

        const retried = yield* sandboxes.launch(launchInput(id));
        assert.strictEqual(retried.status._tag, "destroyed");
        yield* TestClock.adjust(Duration.hours(1));
        assert.strictEqual(world.createKeys.length, 1);
        assert.deepStrictEqual(yield* sandboxes.list(), []);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("lets a refused delete be asked again", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-refused-delete");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        world.failNextDestroy = "invalid";

        yield* sandboxes.update({ id, desired: "destroyed" });
        const failed = yield* awaitStatus(id, "failed");
        assert.deepInclude(failed.status, { step: "destroy", retryable: true });

        yield* sandboxes.update({ id, desired: "destroyed" });
        yield* awaitGone(id);
        assert.strictEqual(world.machines.size, 0);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("signs a guest in to GitHub before its clone, and again when the token rotates", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const token = (generation: number): GitHubUserToken => ({
        generation,
        token: Redacted.make(`ghu_${generation}`),
        expiresAt: Date.UTC(2026, 9, 25, 20),
        login: "octocat",
        name: "The Octocat",
        email: null,
      });
      world.githubToken = token(1);
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-github");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        assert.deepStrictEqual(world.guestSteps, ["github-login:1:octocat", "prepare"]);

        const delivered = yield* Deferred.make<number>();
        world.delivered = delivered;
        world.githubToken = token(2);
        yield* Queue.offer(world.rotations!, 2);
        assert.strictEqual(yield* Deferred.await(delivered), 2);
        assert.deepStrictEqual(world.guestSteps, [
          "github-login:1:octocat",
          "prepare",
          "github-login:2:octocat",
        ]);
        // Only the deliveries asked for the token itself; every look read the generation.
        assert.strictEqual(world.tokenRequests, 2);

        // The user disconnected: the guest keeps the login it has.
        world.githubToken = null;
        yield* Queue.offer(world.rotations!, null);
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(world.guestSteps.length, 3);
      }).pipe(Effect.provide(started.context));
      yield* Scope.close(started.scope, Exit.void);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("restarts T3 for a changed env only once the resumed agents are idle", () =>
    Effect.gen(function* () {
      const { world, start } = makeWorld();
      const started = yield* start;
      yield* Effect.gen(function* () {
        const sandboxes = yield* service;
        const id = SandboxId.make("sbx-env");
        yield* sandboxes.launch(launchInput(id));
        yield* awaitStatus(id, "ready");
        yield* sandboxes.update({ id, desired: "stopped" });
        yield* awaitStatus(id, "stopped");

        world.restartPendingOnRefresh = true;
        world.activity = { busy: true, lastActivityAt: 0 };
        yield* sandboxes.update({ id, desired: "running" });
        yield* awaitStatus(id, "ready");
        yield* TestClock.adjust("3 minutes");
        assert.strictEqual(world.credentialRefreshes, 1);
        assert.strictEqual(world.serverRestarts, 0);

        const restarted = yield* Deferred.make<void>();
        world.restarted = restarted;
        world.activity = { busy: false, lastActivityAt: yield* Clock.currentTimeMillis };
        yield* advanceUntil(Deferred.await(restarted), "1 minute");
        assert.strictEqual(world.serverRestarts, 1);
        yield* TestClock.adjust("3 minutes");
        assert.strictEqual(world.serverRestarts, 1);
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
