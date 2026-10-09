/**
 * SandboxService - launches, stops, resumes, and destroys sandbox machines
 * for this owner environment, and keeps each `sandboxes` row converging on
 * what its user last asked for.
 *
 * Commands write only `desired`. One reconcile fiber per unsettled sandbox
 * observes the provider and the guest, asks `planNext` for the next action,
 * runs it, and records the facts it learned. Every provider call is recorded
 * as in flight before it is made, so a restart resolves it by looking before
 * anything else happens. On start, every unsettled row is planned again.
 *
 * @module SandboxService
 */
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  SandboxAccountId,
  SandboxDesired,
  SandboxId,
  SandboxStatus,
  ThreadId,
  type SandboxFailedStep,
  type SandboxLaunchInput,
  type SandboxView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  SANDBOX_T3_PORT,
  renderSandboxBootScript,
  renderSandboxEnvFile,
} from "./sandboxBootScript.ts";
import * as SandboxAccounts from "./SandboxAccounts.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import {
  SandboxInflight,
  SandboxSeedIds,
  SandboxSpec,
  isParked,
  planNext,
  type SandboxAction,
  type SandboxObservation,
  type SandboxRecord,
} from "./sandboxLifecycle.ts";
import { ProviderMachineId, SandboxProvider, SandboxProviderError } from "./SandboxProvider.ts";

/** How often a sandbox in transition is looked at again. */
const POLL_INTERVAL = Duration.seconds(2);
/** How often a ready sandbox is checked for a stop the provider made on its own. */
const WATCH_INTERVAL = Duration.minutes(1);
const SANDBOX_HOME_PROJECTS = "/home/user/projects";

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  { sandboxId: Schema.String },
) {
  override get message(): string {
    return "The sandbox does not exist.";
  }
}

export class SandboxDestroyedError extends Schema.TaggedError<SandboxDestroyedError>()(
  "SandboxDestroyedError",
  { sandboxId: Schema.String },
) {
  override get message(): string {
    return "The sandbox was deleted and cannot be started or stopped.";
  }
}

export class SandboxBuildUnavailableError extends Schema.TaggedError<SandboxBuildUnavailableError>()(
  "SandboxBuildUnavailableError",
  { version: Schema.String },
) {
  override get message(): string {
    return "This owner no longer has the server build the sandbox was created with.";
  }
}

export class SandboxPersistenceError extends Schema.TaggedError<SandboxPersistenceError>()(
  "SandboxPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write sandbox state.";
  }
}

/**
 * The T3 build sandboxes install. A release owner installs its own version
 * from npm; a dev owner uploads its packed server instead.
 */
export type SandboxT3BuildValue =
  | { readonly kind: "npm"; readonly version: string }
  | { readonly kind: "tarball"; readonly version: string; readonly bytes: Uint8Array };

export class SandboxT3Build extends Context.Reference<SandboxT3BuildValue>(
  "t3/sandbox/SandboxT3Build",
  { defaultValue: () => ({ kind: "npm", version: packageJson.version }) },
) {}

export class SandboxService extends Context.Service<
  SandboxService,
  {
    /** Idempotent on `input.id`: a retried launch returns the sandbox the first one made. */
    readonly launch: (
      input: SandboxLaunchInput,
    ) => Effect.Effect<
      SandboxView,
      SandboxAccounts.SandboxAccountNotFoundError | SandboxPersistenceError
    >;
    /** Asking for the current desired state again retries a failed or expired sandbox. */
    readonly update: (input: {
      readonly id: SandboxId;
      readonly desired: SandboxDesired;
    }) => Effect.Effect<
      SandboxView,
      SandboxNotFoundError | SandboxDestroyedError | SandboxPersistenceError
    >;
    readonly list: () => Effect.Effect<ReadonlyArray<SandboxView>, SandboxPersistenceError>;
    /** Every sandbox as it is now, then each view as it changes. */
    readonly subscribe: () => Stream.Stream<SandboxView, SandboxPersistenceError>;
  }
>()("t3/sandbox/SandboxService") {}

/** Written once by launch; `desired` and `desired_revision` again by every update. */
const SandboxCommandColumns = Schema.Struct({
  sandbox_id: SandboxId,
  account_id: SandboxAccountId,
  provider: Schema.Literal("boat"),
  spec_json: Schema.fromJsonString(SandboxSpec),
  seed_json: Schema.fromJsonString(SandboxSeedIds),
  desired: SandboxDesired,
  desired_revision: Schema.Number,
  created_at: Schema.Number,
});

/** Written only by the sandbox's reconcile fiber after the insert. */
const SandboxReconcilerColumns = Schema.Struct({
  status_json: Schema.fromJsonString(SandboxStatus),
  settled_revision: Schema.Number,
  inflight_json: Schema.NullOr(Schema.fromJsonString(SandboxInflight)),
  create_key: Schema.String,
  create_first_attempt_at: Schema.NullOr(Schema.Number),
  machine_id: Schema.NullOr(ProviderMachineId),
  http_base_url: Schema.NullOr(Schema.String),
  environment_id: Schema.NullOr(EnvironmentId),
  running_since: Schema.NullOr(Schema.Number),
  inputs_written_at: Schema.NullOr(Schema.Number),
  credentials_stale: Schema.BooleanFromBit,
  seed_launched_at: Schema.NullOr(Schema.Number),
});

const decodeRow = Schema.decodeUnknownEffect(
  Schema.Struct({ ...SandboxCommandColumns.fields, ...SandboxReconcilerColumns.fields }),
);
const encodeCommandColumns = Schema.encodeSync(SandboxCommandColumns);
const encodeReconcilerColumns = Schema.encodeSync(SandboxReconcilerColumns);

const commandColumnsOf = (record: SandboxRecord) =>
  encodeCommandColumns({
    sandbox_id: record.id,
    account_id: record.accountId,
    provider: record.provider,
    spec_json: record.spec,
    seed_json: record.seed,
    desired: record.desired,
    desired_revision: record.desiredRevision,
    created_at: record.createdAt,
  });

const reconcilerColumnsOf = (record: SandboxRecord) =>
  encodeReconcilerColumns({
    status_json: record.status,
    settled_revision: record.settledRevision,
    inflight_json: record.inflight,
    create_key: record.createKey,
    create_first_attempt_at: record.createFirstAttemptAt,
    machine_id: record.machineId,
    http_base_url: record.httpBaseUrl,
    environment_id: record.environmentId,
    running_since: record.runningSince,
    inputs_written_at: record.inputsWrittenAt,
    credentials_stale: record.credentialsStale,
    seed_launched_at: record.seedLaunchedAt,
  });

const recordOf = (row: Effect.Success<ReturnType<typeof decodeRow>>): SandboxRecord => ({
  id: row.sandbox_id,
  accountId: row.account_id,
  provider: row.provider,
  spec: row.spec_json,
  seed: row.seed_json,
  desired: row.desired,
  desiredRevision: row.desired_revision,
  status: row.status_json,
  settledRevision: row.settled_revision,
  inflight: row.inflight_json,
  createKey: row.create_key,
  createFirstAttemptAt: row.create_first_attempt_at,
  machineId: row.machine_id,
  httpBaseUrl: row.http_base_url,
  environmentId: row.environment_id,
  runningSince: row.running_since,
  inputsWrittenAt: row.inputs_written_at,
  credentialsStale: row.credentials_stale,
  seedLaunchedAt: row.seed_launched_at,
  createdAt: row.created_at,
});

type ReconcilerFacts = Partial<
  Omit<
    SandboxRecord,
    "id" | "accountId" | "provider" | "spec" | "seed" | "desired" | "desiredRevision" | "createdAt"
  >
>;

const toView = (record: SandboxRecord): SandboxView => ({
  id: record.id,
  accountId: record.accountId,
  title: record.spec.title,
  repository: record.spec.repository,
  status: record.status,
  environmentId: record.environmentId,
  httpBaseUrl: record.httpBaseUrl,
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(record.createdAt)),
});

const adminSecretName = (id: SandboxId) => `sandbox-${id}-admin`;

const checkoutPath = (remoteUrl: string) =>
  `${SANDBOX_HOME_PROJECTS}/${
    remoteUrl
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, "") || "project"
  }`;

const FAILED_STEP: Record<SandboxAction["_tag"], SandboxFailedStep> = {
  Create: "create",
  WriteInputs: "boot",
  Host: "boot",
  RecordEnvironment: "boot",
  LaunchSeed: "launch",
  RefreshCredentials: "resume",
  Stop: "stop",
  Resume: "resume",
  Destroy: "destroy",
  ClearInflight: "observe",
  Wait: "observe",
  Watch: "observe",
  Settle: "observe",
};

type StepError =
  | SandboxBuildUnavailableError
  | SandboxProviderError
  | SandboxGuest.SandboxGuestError
  | SandboxAccounts.SandboxAccountNotFoundError
  | ServerSecretStore.SecretStoreError;

const isProviderError = Schema.is(SandboxProviderError);

/** A provider refusal that proves the request had no effect. */
const isDefinitiveRefusal = (error: StepError) =>
  isProviderError(error) && error.kind !== "transient" && error.kind !== "not-found";

const failedStatus = (step: SandboxFailedStep, error: StepError): SandboxStatus => ({
  _tag: "failed",
  step,
  message: error.message,
  retryable: !(isProviderError(error) && error.kind === "invalid"),
});

const statusKey = Schema.encodeSync(Schema.fromJsonString(SandboxStatus));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const provider = yield* SandboxProvider;
  const guest = yield* SandboxGuest.SandboxGuest;
  const accounts = yield* SandboxAccounts.SandboxAccounts;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const build = yield* SandboxT3Build;
  const changesPubSub = yield* PubSub.unbounded<SandboxView>();
  const fibers = yield* FiberMap.make<SandboxId>();
  const lifecycleLock = yield* Semaphore.make(1);
  /** The wake signal of each live reconcile fiber, for the iteration it is in. */
  const wakers = new Map<SandboxId, Deferred.Deferred<void>>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const persistence = Effect.mapError((cause: unknown) => new SandboxPersistenceError({ cause }));

  const readRecord = (id: SandboxId) =>
    sql`SELECT * FROM sandboxes WHERE sandbox_id = ${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<SandboxRecord>())
          : decodeRow(rows[0]).pipe(Effect.map((row) => Option.some(recordOf(row)))),
      ),
      persistence,
    );

  const writeFacts = (record: SandboxRecord, facts: ReconcilerFacts) =>
    Effect.gen(function* () {
      const next: SandboxRecord = { ...record, ...facts };
      const columns = reconcilerColumnsOf(next);
      const unchanged = Object.entries(columns).every(
        ([column, value]) => reconcilerColumnsOf(record)[column as keyof typeof columns] === value,
      );
      if (unchanged) return next;
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE sandboxes SET ${sql.update({ ...columns, updated_at: updatedAt })} WHERE sandbox_id = ${record.id}`.pipe(
        persistence,
      );
      if (
        statusKey(next.status) !== statusKey(record.status) ||
        next.environmentId !== record.environmentId ||
        next.httpBaseUrl !== record.httpBaseUrl
      ) {
        yield* PubSub.publish(changesPubSub, toView(next));
      }
      return next;
    });

  const getAdminToken = (
    record: SandboxRecord,
    account: SandboxAccounts.SandboxAccount,
    machineId: ProviderMachineId,
  ) =>
    secrets.get(adminSecretName(record.id)).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (bytes) => Effect.succeed(Redacted.make(new TextDecoder().decode(bytes))),
          onNone: () =>
            guest
              .mintAdminSession(account, machineId)
              .pipe(
                Effect.tap((token) =>
                  secrets.set(
                    adminSecretName(record.id),
                    new TextEncoder().encode(Redacted.value(token)),
                  ),
                ),
              ),
        }),
      ),
    );

  const machineCredentials = (account: SandboxAccounts.SandboxAccount) => ({
    envFile: renderSandboxEnvFile(
      account.env.map((entry) => ({ name: entry.name, value: Redacted.value(entry.value) })),
    ),
    machineSetupScript: account.machineSetupScript ?? "",
  });

  const observe = (record: SandboxRecord) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const machineId = record.machineId;
      const machine =
        machineId === null
          ? null
          : yield* accounts
              .get(record.accountId)
              .pipe(Effect.flatMap((account) => provider.inspect(account, machineId)));
      // A ready sandbox stays ready while its server restarts; only the machine state matters then.
      const environmentId =
        machine?.state === "running" &&
        record.httpBaseUrl !== null &&
        record.status._tag !== "ready"
          ? yield* guest.readEnvironmentId(record.httpBaseUrl)
          : null;
      return { now, machine, environmentId } satisfies SandboxObservation;
    });

  /** Runs one action. Returns the record as the action left it. */
  const runAction = (record: SandboxRecord, status: SandboxStatus, action: SandboxAction) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // The planner only picks a machine action once the machine id is stored.
      const machineId = Effect.suspend(() =>
        record.machineId === null
          ? Effect.die(new Error(`${action._tag} planned without a machine id.`))
          : Effect.succeed(record.machineId),
      );
      const account = () => accounts.get(record.accountId);
      switch (action._tag) {
        case "Create": {
          const resolved = yield* account();
          const started = yield* writeFacts(record, {
            status,
            inflight: { op: "create", startedAt: now },
            createFirstAttemptAt: record.createFirstAttemptAt ?? now,
            runningSince: now,
          });
          const created = yield* provider
            .create(resolved, {
              idempotencyKey: record.createKey,
              size: record.spec.machine.size,
              ttlSeconds: record.spec.machine.ttlSeconds,
              env: {},
              template: record.spec.machine.template,
              providerEnvironment: record.spec.machine.providerEnvironment,
              setupScript: renderSandboxBootScript(record.spec.t3),
            })
            .pipe(
              Effect.tapError((error) =>
                isDefinitiveRefusal(error)
                  ? // Nothing was created, so the next attempt must not replay this refusal.
                    uuid.pipe(
                      Effect.flatMap((key) =>
                        writeFacts(started, {
                          inflight: null,
                          createFirstAttemptAt: null,
                          createKey: `t3-sandbox-${record.id}-${key}`,
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            );
          return yield* writeFacts(started, { machineId: created.id, inflight: null });
        }
        case "WriteInputs": {
          const resolved = yield* account();
          const tarball =
            record.spec.t3.kind === "npm"
              ? null
              : build.kind === "tarball" && build.version === record.spec.t3.version
                ? build.bytes
                : yield* new SandboxBuildUnavailableError({ version: record.spec.t3.version });
          yield* guest.writeBootInputs(resolved, yield* machineId, {
            ...machineCredentials(resolved),
            tarball,
          });
          return yield* writeFacts(record, {
            status,
            inputsWrittenAt: now,
          });
        }
        case "Host": {
          const baseUrl = yield* provider.host(yield* account(), yield* machineId, SANDBOX_T3_PORT);
          return yield* writeFacts(record, { status, httpBaseUrl: baseUrl });
        }
        case "RecordEnvironment":
          return yield* writeFacts(record, { status, environmentId: action.environmentId });
        case "LaunchSeed": {
          const resolved = yield* account();
          const token = yield* getAdminToken(record, resolved, yield* machineId);
          const checkout = {
            remoteUrl: record.spec.repository.remoteUrl,
            commit: record.spec.repository.commit,
            path: checkoutPath(record.spec.repository.remoteUrl),
          };
          const scripts = yield* guest.cloneCheckout(resolved, yield* machineId, checkout);
          yield* guest.launchSeedThread(
            {
              baseUrl:
                record.httpBaseUrl ??
                (yield* Effect.die(new Error("LaunchSeed planned without a base URL."))),
              token,
            },
            {
              checkout,
              scripts,
              seed: {
                ...record.seed,
                title: record.spec.title,
                message: record.spec.message,
                driver: record.spec.driver,
                model: record.spec.model,
                runtimeMode: record.spec.runtimeMode,
                interactionMode: record.spec.interactionMode,
              },
            },
          );
          return yield* writeFacts(record, { status, seedLaunchedAt: now });
        }
        case "RefreshCredentials": {
          const resolved = yield* account();
          yield* guest.refreshCredentials(resolved, yield* machineId, machineCredentials(resolved));
          return yield* writeFacts(record, { status, credentialsStale: false });
        }
        case "Stop": {
          const resolved = yield* account();
          const next = yield* writeFacts(record, {
            status,
            inflight: { op: "stop", startedAt: now },
          });
          yield* provider.stop(resolved, yield* machineId);
          return next;
        }
        case "Resume": {
          const resolved = yield* account();
          const next = yield* writeFacts(record, {
            status,
            inflight: { op: "resume", startedAt: now },
            runningSince: now,
            credentialsStale: true,
          });
          yield* provider.resume(resolved, yield* machineId);
          return next;
        }
        case "Destroy": {
          const resolved = yield* account();
          const next = yield* writeFacts(record, {
            status,
            inflight: { op: "destroy", startedAt: now },
          });
          yield* provider.destroy(resolved, yield* machineId);
          return next;
        }
        case "ClearInflight":
          return yield* writeFacts(record, { status, inflight: null });
        case "Wait":
          return yield* writeFacts(record, { status });
        case "Watch":
        case "Settle": {
          if (status._tag === "destroyed") {
            yield* secrets.remove(adminSecretName(record.id)).pipe(Effect.ignore({ log: true }));
          }
          return yield* writeFacts(record, { status, settledRevision: record.desiredRevision });
        }
      }
    });

  /** Plans and runs one step; returns how the loop goes on. */
  const step = (id: SandboxId) =>
    Effect.gen(function* () {
      const found = yield* readRecord(id);
      if (Option.isNone(found) || isParked(found.value)) return "exit" as const;
      const record = found.value;
      const observation = yield* observe(record).pipe(Effect.result);
      // A provider hiccup while looking changes nothing; look again later.
      if (
        observation._tag === "Failure" &&
        isProviderError(observation.failure) &&
        observation.failure.kind === "transient"
      ) {
        return record.status._tag === "ready" ? ("watch" as const) : ("wait" as const);
      }
      const next =
        observation._tag === "Failure"
          ? {
              status: failedStatus("observe", observation.failure),
              action: { _tag: "Settle" } as const,
            }
          : planNext(record, observation.success);
      yield* Effect.logDebug("sandbox step").pipe(
        Effect.annotateLogs({ sandboxId: id, status: next.status._tag, action: next.action._tag }),
      );
      const outcome = yield* runAction(record, next.status, next.action).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        const error = outcome.failure;
        if (error._tag === "SandboxPersistenceError") return yield* error;
        // A machine that vanished under a call is seen as gone by the next look.
        if (isProviderError(error) && error.kind === "not-found") return "continue" as const;
        const current = yield* readRecord(id);
        if (Option.isSome(current)) {
          yield* writeFacts(current.value, {
            status: failedStatus(FAILED_STEP[next.action._tag], error),
            settledRevision: record.desiredRevision,
          });
        }
        return "exit" as const;
      }
      switch (next.action._tag) {
        case "Wait":
          return "wait" as const;
        case "Watch":
          return "watch" as const;
        case "Settle":
          return "exit" as const;
        default:
          return "continue" as const;
      }
    });

  const reconcile = (id: SandboxId) => {
    let wake: Deferred.Deferred<void> | undefined;
    return Effect.gen(function* () {
      while (true) {
        const current = yield* Deferred.make<void>();
        wake = current;
        yield* lifecycleLock.withPermits(1)(Effect.sync(() => wakers.set(id, current)));
        const outcome = yield* step(id);
        if (outcome === "wait" || outcome === "watch") {
          yield* Deferred.await(current).pipe(
            Effect.timeoutOrElse({
              duration: outcome === "wait" ? POLL_INTERVAL : WATCH_INTERVAL,
              orElse: () => Effect.void,
            }),
          );
        } else if (outcome === "exit") {
          // A request that arrived during this step is picked up here rather than lost.
          const requested = yield* lifecycleLock.withPermits(1)(
            Effect.gen(function* () {
              if (yield* Deferred.isDone(current)) return true;
              wakers.delete(id);
              return false;
            }),
          );
          if (!requested) return;
        }
      }
    }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("sandbox reconcile stopped").pipe(
              Effect.annotateLogs({ sandboxId: id, cause }),
            ),
      ),
      Effect.ensuring(
        lifecycleLock.withPermits(1)(
          Effect.sync(() => {
            if (wake !== undefined && wakers.get(id) === wake) wakers.delete(id);
          }),
        ),
      ),
    );
  };

  /** Wakes the sandbox's reconcile fiber, starting one when none is live. */
  const kick = (id: SandboxId) =>
    lifecycleLock.withPermits(1)(
      Effect.suspend(() => {
        const waker = wakers.get(id);
        return waker === undefined
          ? FiberMap.run(fibers, id, reconcile(id)).pipe(Effect.asVoid)
          : Deferred.succeed(waker, undefined).pipe(Effect.asVoid);
      }),
    );

  const launch: SandboxService["Service"]["launch"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* readRecord(input.id);
      if (Option.isSome(existing)) {
        yield* kick(input.id);
        return toView(existing.value);
      }
      const account = yield* accounts.get(input.accountId);
      const now = yield* Clock.currentTimeMillis;
      const record: SandboxRecord = {
        id: input.id,
        accountId: input.accountId,
        provider: account.provider,
        spec: {
          title: input.title,
          message: input.message,
          repository: input.repository,
          driver: input.driver,
          model: input.model,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          machine: {
            size: account.size,
            ttlSeconds:
              account.stopAfterHours === null ? null : Math.round(account.stopAfterHours * 3600),
            template: account.template,
            providerEnvironment: account.providerEnvironment,
          },
          t3: { kind: build.kind, version: build.version },
        },
        seed: {
          projectId: ProjectId.make(yield* uuid),
          threadId: ThreadId.make(yield* uuid),
          commandId: CommandId.make(yield* uuid),
          messageId: MessageId.make(yield* uuid),
        },
        desired: "running",
        desiredRevision: 1,
        status: { _tag: "creating" },
        settledRevision: 0,
        inflight: null,
        createKey: `t3-sandbox-${input.id}-${yield* uuid}`,
        createFirstAttemptAt: null,
        machineId: null,
        httpBaseUrl: null,
        environmentId: null,
        runningSince: null,
        inputsWrittenAt: null,
        credentialsStale: false,
        seedLaunchedAt: null,
        createdAt: now,
      };
      yield* sql`INSERT INTO sandboxes ${sql.insert({ ...commandColumnsOf(record), ...reconcilerColumnsOf(record), updated_at: now })} ON CONFLICT (sandbox_id) DO NOTHING`.pipe(
        persistence,
      );
      const stored = yield* readRecord(input.id);
      if (Option.isNone(stored))
        return yield* new SandboxPersistenceError({ cause: "missing after insert" });
      yield* PubSub.publish(changesPubSub, toView(stored.value));
      yield* kick(input.id);
      return toView(stored.value);
    });

  const update: SandboxService["Service"]["update"] = ({ id, desired }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Leaving `destroyed` is refused in the same statement, so a racing resume cannot undo a delete.
      const updated = yield* sql`
        UPDATE sandboxes
        SET desired = ${desired}, desired_revision = desired_revision + 1, updated_at = ${now}
        WHERE sandbox_id = ${id} AND (desired <> 'destroyed' OR ${desired} = 'destroyed')
        RETURNING sandbox_id`.pipe(persistence);
      const record = yield* readRecord(id);
      if (Option.isNone(record)) return yield* new SandboxNotFoundError({ sandboxId: id });
      if (updated.length === 0) return yield* new SandboxDestroyedError({ sandboxId: id });
      yield* kick(id);
      return toView(record.value);
    });

  const list: SandboxService["Service"]["list"] = () =>
    sql`SELECT * FROM sandboxes ORDER BY created_at`.pipe(
      persistence,
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRow(row).pipe(persistence, Effect.map(recordOf))),
      ),
      Effect.map((records) => records.map(toView)),
    );

  const records = yield* sql`SELECT * FROM sandboxes`.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeRow(row).pipe(Effect.map(recordOf))),
    ),
    persistence,
  );
  yield* Effect.forEach(
    records.filter((record) => !isParked(record)),
    (record) => kick(record.id),
    { discard: true },
  );

  const subscribe: SandboxService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the snapshot, so a change between the two is buffered, not dropped.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        return Stream.concat(
          Stream.fromIterableEffect(list()),
          Stream.fromSubscription(subscription),
        );
      }),
    );

  return SandboxService.of({ launch, update, list, subscribe });
});

export const layer = Layer.effect(SandboxService, make);
