/**
 * SandboxAccounts - the configured accounts sandboxes are created under, such
 * as a personal and a work Boat account. Every lifecycle call reads its
 * sandbox's own account, so credentials never cross accounts.
 *
 * An account's settings live in the server settings; its API key and env
 * values live only in the secret store.
 *
 * @module SandboxAccounts
 */
import type {
  SandboxAccountConfig,
  SandboxAccountId,
  SandboxAccountSaveInput,
  SandboxMachineSize,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  SandboxProvider,
  type SandboxProviderAccount,
  type SandboxProviderError,
} from "./SandboxProvider.ts";

export interface SandboxAccount extends SandboxProviderAccount {
  readonly id: SandboxAccountId;
  readonly provider: "boat";
  /**
   * Written to the machine's env file on every boot and loaded by T3 and the
   * machine setup. An empty value is kept: `ANTHROPIC_API_KEY=""` matters.
   */
  readonly env: ReadonlyArray<{
    readonly name: string;
    readonly value: Redacted.Redacted<string>;
    /** Loaded only by the machine setup; see `SandboxAccountConfig`. */
    readonly setupOnly: boolean;
  }>;
  /** Run on every boot before T3 starts, with the env loaded. Must be idempotent. */
  readonly machineSetupScript: string | null;
  /** A provider named snapshot to create machines from. */
  readonly template: string | null;
  /** A provider secret bundle. Null creates machines with no provider-side secrets. */
  readonly providerEnvironment: string | null;
  readonly size: SandboxMachineSize;
  /** Null never stops a machine on its own. */
  readonly stopAfterHours: number | null;
}

export class SandboxAccountNotFoundError extends Schema.TaggedError<SandboxAccountNotFoundError>()(
  "SandboxAccountNotFoundError",
  { accountId: Schema.String },
) {
  override get message(): string {
    return "The sandbox account is not configured.";
  }
}

export class SandboxAccountInvalidError extends Schema.TaggedError<SandboxAccountInvalidError>()(
  "SandboxAccountInvalidError",
  {
    accountId: Schema.String,
    reason: Schema.Literals(["api-key-required", "env-value-required", "duplicate-env-name"]),
    envName: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "api-key-required":
        return "A new sandbox account needs an API key.";
      case "env-value-required":
        return `The new env variable ${this.envName} needs a value.`;
      case "duplicate-env-name":
        return `The env variable ${this.envName} is listed twice.`;
    }
  }
}

export class SandboxAccountKeyScopeError extends Schema.TaggedError<SandboxAccountKeyScopeError>()(
  "SandboxAccountKeyScopeError",
  { accountId: Schema.String, missingActions: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The API key cannot ${this.missingActions.join(", ")}, which sandboxes need. Add these actions to the key and save again.`;
  }
}

export class SandboxAccountInUseError extends Schema.TaggedError<SandboxAccountInUseError>()(
  "SandboxAccountInUseError",
  { accountId: Schema.String, sandboxes: Schema.Int },
) {
  override get message(): string {
    return `The account still owns ${this.sandboxes} sandbox${this.sandboxes === 1 ? "" : "es"}. Delete them before removing the account.`;
  }
}

export class SandboxAccountStoreError extends Schema.TaggedError<SandboxAccountStoreError>()(
  "SandboxAccountStoreError",
  { accountId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write the sandbox account.";
  }
}

export class SandboxAccounts extends Context.Service<
  SandboxAccounts,
  {
    readonly get: (
      accountId: SandboxAccountId,
    ) => Effect.Effect<SandboxAccount, SandboxAccountNotFoundError>;
    /**
     * Runs `use` with the account while no removal can run, so a sandbox
     * recorded by `use` is counted by any removal that follows.
     */
    readonly withAccount: <A, E, R>(
      accountId: SandboxAccountId,
      use: (account: SandboxAccount) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SandboxAccountNotFoundError, R>;
    /** Checks the key can run sandboxes before anything is stored. */
    readonly save: (
      input: SandboxAccountSaveInput,
    ) => Effect.Effect<
      SandboxAccountConfig,
      | SandboxAccountInvalidError
      | SandboxAccountKeyScopeError
      | SandboxAccountStoreError
      | SandboxProviderError
    >;
    /** Succeeds when the account is already gone. */
    readonly remove: (
      accountId: SandboxAccountId,
    ) => Effect.Effect<void, SandboxAccountInUseError | SandboxAccountStoreError>;
  }
>()("t3/sandbox/SandboxAccounts") {}

const encodeName = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const apiKeySecretName = (id: SandboxAccountId) => `sandbox-account-${encodeName(id)}-api-key`;
const envSecretName = (id: SandboxAccountId, name: string) =>
  `sandbox-account-${encodeName(id)}-env-${encodeName(name)}`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* SandboxProvider;
  const removalLock = yield* Semaphore.make(1);

  const readSecret = (name: string) =>
    secrets.get(name).pipe(Effect.map(Option.map((bytes) => textDecoder.decode(bytes))));

  // A settings or secret store that cannot be read is not a missing account.
  const get: SandboxAccounts["Service"]["get"] = (accountId) =>
    Effect.gen(function* () {
      const notFound = new SandboxAccountNotFoundError({ accountId });
      const config = (yield* settings.getSettings.pipe(Effect.orDie)).sandboxAccounts[accountId];
      if (config === undefined) return yield* notFound;
      const apiKey = yield* readSecret(apiKeySecretName(accountId)).pipe(Effect.orDie);
      if (Option.isNone(apiKey)) return yield* notFound;
      const env = [];
      for (const { name, setupOnly } of config.env) {
        const value = yield* readSecret(envSecretName(accountId, name)).pipe(Effect.orDie);
        // Only a hand-edited settings file lists a name without a value.
        if (Option.isNone(value)) return yield* notFound;
        env.push({ name, value: Redacted.make(value.value), setupOnly });
      }
      return {
        id: accountId,
        provider: config.provider,
        apiKey: Redacted.make(apiKey.value),
        env,
        machineSetupScript: config.machineSetupScript,
        template: config.template,
        providerEnvironment: config.providerEnvironment,
        size: config.size,
        stopAfterHours: config.stopAfterHours,
      } satisfies SandboxAccount;
    });

  const save: SandboxAccounts["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const { id } = input;
      const store = Effect.mapError(
        (cause: unknown) => new SandboxAccountStoreError({ accountId: id, cause }),
      );
      const apiKey =
        input.apiKey ?? Option.getOrUndefined(yield* readSecret(apiKeySecretName(id)).pipe(store));
      if (apiKey === undefined) {
        return yield* new SandboxAccountInvalidError({ accountId: id, reason: "api-key-required" });
      }
      const env: Array<{
        readonly name: string;
        readonly value: string;
        readonly setupOnly: boolean;
      }> = [];
      for (const entry of input.env) {
        if (env.some((existing) => existing.name === entry.name)) {
          return yield* new SandboxAccountInvalidError({
            accountId: id,
            reason: "duplicate-env-name",
            envName: entry.name,
          });
        }
        const value =
          entry.value ??
          Option.getOrUndefined(yield* readSecret(envSecretName(id, entry.name)).pipe(store));
        if (value === undefined) {
          return yield* new SandboxAccountInvalidError({
            accountId: id,
            reason: "env-value-required",
            envName: entry.name,
          });
        }
        env.push({ name: entry.name, value, setupOnly: entry.setupOnly ?? false });
      }

      const missingActions = yield* provider.checkAccess({ apiKey: Redacted.make(apiKey) });
      if (missingActions.length > 0) {
        return yield* new SandboxAccountKeyScopeError({ accountId: id, missingActions });
      }

      const config: SandboxAccountConfig = {
        label: input.label,
        provider: input.provider,
        template: input.template,
        providerEnvironment: input.providerEnvironment,
        size: input.size,
        stopAfterHours: input.stopAfterHours,
        machineSetupScript: input.machineSetupScript,
        env: env.map(({ name, setupOnly }) => ({ name, setupOnly })),
      };
      let dropped: ReadonlyArray<string> = [];
      yield* settings
        .updateSandboxAccounts((accounts) =>
          Effect.gen(function* () {
            yield* secrets.set(apiKeySecretName(id), textEncoder.encode(apiKey));
            for (const entry of env) {
              yield* secrets.set(envSecretName(id, entry.name), textEncoder.encode(entry.value));
            }
            dropped = (accounts[id]?.env ?? [])
              .map(({ name }) => name)
              .filter((name) => !env.some((entry) => entry.name === name));
            return { ...accounts, [id]: config };
          }),
        )
        .pipe(store);
      // Only once the settings no longer name them, or a failed write leaves names without values.
      for (const name of dropped) {
        yield* secrets.remove(envSecretName(id, name)).pipe(store);
      }
      return config;
    });

  const remove: SandboxAccounts["Service"]["remove"] = (accountId) => {
    const store = Effect.mapError(
      (cause: unknown) => new SandboxAccountStoreError({ accountId, cause }),
    );
    return Effect.gen(function* () {
      let removed: SandboxAccountConfig | undefined;
      yield* settings
        .updateSandboxAccounts((accounts) =>
          Effect.gen(function* () {
            const config = accounts[accountId];
            if (config === undefined) return accounts;
            // A sandbox still being destroyed needs its account's key to finish.
            const [row] = yield* sql<{ readonly live: number }>`
              SELECT COUNT(*) AS live FROM sandboxes
              WHERE account_id = ${accountId} AND json_extract(status_json, '$._tag') <> 'destroyed'`.pipe(
              store,
            );
            const live = row?.live ?? 0;
            if (live > 0)
              return yield* new SandboxAccountInUseError({ accountId, sandboxes: live });
            removed = config;
            const { [accountId]: _removed, ...rest } = accounts;
            return rest;
          }),
        )
        .pipe(
          Effect.catchTags({
            ServerSettingsError: (cause) =>
              Effect.fail(new SandboxAccountStoreError({ accountId, cause })),
          }),
        );
      if (removed === undefined) return;
      yield* secrets.remove(apiKeySecretName(accountId)).pipe(store);
      for (const { name } of removed.env) {
        yield* secrets.remove(envSecretName(accountId, name)).pipe(store);
      }
    }).pipe(removalLock.withPermits(1));
  };

  const withAccount: SandboxAccounts["Service"]["withAccount"] = (accountId, use) =>
    get(accountId).pipe(Effect.flatMap(use), removalLock.withPermits(1));

  return SandboxAccounts.of({ get, withAccount, save, remove });
});

/** Accounts kept in the server settings, with their secrets in the secret store. */
export const layer = Layer.effect(SandboxAccounts, make);

/** Accounts fixed at construction, for tests that never edit them. */
export const layerStatic = (accounts: ReadonlyArray<SandboxAccount>) => {
  const get = (accountId: SandboxAccountId) => {
    const account = accounts.find((candidate) => candidate.id === accountId);
    return account === undefined
      ? Effect.fail(new SandboxAccountNotFoundError({ accountId }))
      : Effect.succeed(account);
  };
  return Layer.succeed(
    SandboxAccounts,
    SandboxAccounts.of({
      get,
      withAccount: (accountId, use) => get(accountId).pipe(Effect.flatMap(use)),
      save: () => Effect.die("layerStatic accounts cannot be edited."),
      remove: () => Effect.die("layerStatic accounts cannot be edited."),
    }),
  );
};
