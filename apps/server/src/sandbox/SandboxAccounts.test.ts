import { assert, describe, it } from "@effect/vitest";
import { SandboxAccountId, ServerSettingsError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxAccounts from "./SandboxAccounts.ts";
import { SandboxProvider } from "./SandboxProvider.ts";

const ID = SandboxAccountId.make("boat-work");

const makeWorld = () => {
  const world = {
    secrets: new Map<string, Uint8Array>(),
    missingActions: [] as ReadonlyArray<string>,
    checkedKeys: [] as Array<string>,
    /** Fails the next settings write after its update has run, as a failed file write would. */
    failSettingsWrite: false,
  };
  const unused = () => Effect.die("unused");
  const provider = SandboxProvider.of({
    checkAccess: (account) =>
      Effect.sync(() => {
        world.checkedKeys.push(Redacted.value(account.apiKey));
        return world.missingActions;
      }),
    create: unused,
    inspect: unused,
    exec: unused,
    writeFile: unused,
    host: unused,
    stop: unused,
    resume: unused,
    destroy: unused,
  });
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(world.secrets.get(name))),
    set: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
    getOrCreateRandom: unused,
    remove: (name) => Effect.sync(() => void world.secrets.delete(name)),
  });
  const settingsLayer = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      return ServerSettings.ServerSettingsService.of({
        ...settings,
        updateSandboxAccounts: (update) =>
          settings.updateSandboxAccounts((accounts) =>
            update(accounts).pipe(
              Effect.tap(() => {
                if (!world.failSettingsWrite) return Effect.void;
                world.failSettingsWrite = false;
                return Effect.fail(
                  new ServerSettingsError({
                    settingsPath: "settings.json",
                    operation: "write-file",
                  }),
                );
              }),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest()));
  const layer = SandboxAccounts.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provide(Layer.succeed(SandboxProvider, provider)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { world, layer };
};

const input = {
  id: ID,
  label: "Work",
  provider: "boat" as const,
  template: null,
  providerEnvironment: null,
  size: "small" as const,
  stopAfterHours: 8,
  machineSetupScript: "tailscale up",
};

const storedText = (world: ReturnType<typeof makeWorld>["world"]) =>
  [...world.secrets.values()].map((bytes) => new TextDecoder().decode(bytes));

describe("SandboxAccounts", () => {
  it.effect("keeps the key and env values out of the settings and reads them back", () => {
    const { world, layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const saved = yield* accounts.save({
        ...input,
        apiKey: "boat-secret-key",
        env: [
          { name: "ANTHROPIC_API_KEY", value: "" },
          { name: "ANTHROPIC_AUTH_TOKEN", value: "proxy-secret-token" },
          { name: "TAILSCALE_AUTH_KEY", value: "tskey-secret", setupOnly: true },
        ],
      });
      assert.deepStrictEqual(saved.env, [
        { name: "ANTHROPIC_API_KEY", setupOnly: false },
        { name: "ANTHROPIC_AUTH_TOKEN", setupOnly: false },
        { name: "TAILSCALE_AUTH_KEY", setupOnly: true },
      ]);

      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.deepStrictEqual(settings.sandboxAccounts[ID], saved);
      const settingsText = JSON.stringify(settings);
      assert.notInclude(settingsText, "boat-secret-key");
      assert.notInclude(settingsText, "proxy-secret-token");
      assert.notInclude(settingsText, "tskey-secret");
      assert.includeMembers(storedText(world), [
        "boat-secret-key",
        "proxy-secret-token",
        "tskey-secret",
        "",
      ]);

      const account = yield* accounts.get(ID);
      assert.strictEqual(Redacted.value(account.apiKey), "boat-secret-key");
      assert.deepStrictEqual(
        account.env.map((entry) => [entry.name, Redacted.value(entry.value), entry.setupOnly]),
        [
          ["ANTHROPIC_API_KEY", "", false],
          ["ANTHROPIC_AUTH_TOKEN", "proxy-secret-token", false],
          ["TAILSCALE_AUTH_KEY", "tskey-secret", true],
        ],
      );
      assert.strictEqual(account.machineSetupScript, "tailscale up");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a key that lacks actions sandboxes need, storing nothing", () => {
    const { world, layer } = makeWorld();
    world.missingActions = ["sandbox.resume", "host"];
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const refused = yield* accounts
        .save({ ...input, apiKey: "scoped-key", env: [{ name: "TOKEN", value: "x" }] })
        .pipe(Effect.flip);
      assert.deepInclude(refused, {
        _tag: "SandboxAccountKeyScopeError",
        missingActions: ["sandbox.resume", "host"],
      });
      assert.strictEqual(world.secrets.size, 0);
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.deepStrictEqual(settings.sandboxAccounts, {});
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps saved values for entries sent without one and drops removed names", () => {
    const { world, layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      yield* accounts.save({
        ...input,
        apiKey: "first-key",
        env: [
          { name: "TOKEN", value: "first-token" },
          { name: "DROPPED", value: "dropped-value" },
        ],
      });
      yield* accounts.save({ ...input, label: "Work (renamed)", env: [{ name: "TOKEN" }] });

      const account = yield* accounts.get(ID);
      assert.strictEqual(Redacted.value(account.apiKey), "first-key");
      assert.deepStrictEqual(
        account.env.map((entry) => [entry.name, Redacted.value(entry.value)]),
        [["TOKEN", "first-token"]],
      );
      assert.notInclude(storedText(world), "dropped-value");
      assert.deepStrictEqual(world.checkedKeys, ["first-key", "first-key"]);

      const missing = yield* accounts
        .save({ ...input, env: [{ name: "TOKEN" }, { name: "NEW_NAME" }] })
        .pipe(Effect.flip);
      assert.deepInclude(missing, { reason: "env-value-required", envName: "NEW_NAME" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a new account without a key", () => {
    const { layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const refused = yield* accounts.save({ ...input, env: [] }).pipe(Effect.flip);
      assert.deepInclude(refused, { reason: "api-key-required" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to remove an account until its last sandbox is destroyed", () => {
    const { world, layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const sql = yield* SqlClient.SqlClient;
      yield* accounts.save({ ...input, apiKey: "key", env: [{ name: "TOKEN", value: "t" }] });
      const status = (tag: string) => JSON.stringify({ _tag: tag });
      yield* sql`
        INSERT INTO sandboxes ${sql.insert({
          sandbox_id: "sbx-1",
          account_id: ID,
          provider: "boat",
          spec_json: "{}",
          seed_json: "{}",
          desired: "destroyed",
          desired_revision: 2,
          status_json: status("destroying"),
          settled_revision: 1,
          create_key: "key",
          credentials_stale: 0,
          created_at: 0,
          updated_at: 0,
        })}`;

      const refused = yield* accounts.remove(ID).pipe(Effect.flip);
      assert.deepInclude(refused, { _tag: "SandboxAccountInUseError", sandboxes: 1 });
      assert.isOk((yield* accounts.get(ID)).apiKey);

      yield* sql`UPDATE sandboxes SET status_json = ${status("destroyed")}`;
      yield* accounts.remove(ID);
      const gone = yield* accounts.get(ID).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "SandboxAccountNotFoundError");
      assert.strictEqual(world.secrets.size, 0);
      yield* accounts.remove(ID);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a dropped env value until the settings that drop it are written", () => {
    const { world, layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      yield* accounts.save({
        ...input,
        apiKey: "key",
        env: [
          { name: "TOKEN", value: "token" },
          { name: "DROPPED", value: "dropped-value" },
        ],
      });
      world.failSettingsWrite = true;
      const failed = yield* accounts.save({ ...input, env: [{ name: "TOKEN" }] }).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "SandboxAccountStoreError");

      const account = yield* accounts.get(ID);
      assert.deepStrictEqual(
        account.env.map((entry) => [entry.name, Redacted.value(entry.value)]),
        [
          ["TOKEN", "token"],
          ["DROPPED", "dropped-value"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes an account only before or after a sandbox is recorded under it", () => {
    const { layer } = makeWorld();
    return Effect.gen(function* () {
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const sql = yield* SqlClient.SqlClient;
      yield* accounts.save({ ...input, apiKey: "key", env: [] });
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const launching = yield* Effect.forkChild(
        accounts.withAccount(ID, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(reading, undefined);
            yield* Deferred.await(release);
            yield* sql`
              INSERT INTO sandboxes ${sql.insert({
                sandbox_id: "sbx-1",
                account_id: ID,
                provider: "boat",
                spec_json: "{}",
                seed_json: "{}",
                desired: "running",
                desired_revision: 1,
                status_json: JSON.stringify({ _tag: "creating" }),
                settled_revision: 0,
                create_key: "key",
                credentials_stale: 0,
                created_at: 0,
                updated_at: 0,
              })}`;
          }),
        ),
      );
      yield* Deferred.await(reading);
      const removing = yield* Effect.forkChild(accounts.remove(ID).pipe(Effect.flip));
      for (let turn = 0; turn < 100 && removing.pollUnsafe() === undefined; turn++) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(launching);

      const refused = yield* Fiber.join(removing);
      assert.deepInclude(refused, { _tag: "SandboxAccountInUseError", sandboxes: 1 });
      assert.isOk((yield* accounts.get(ID)).apiKey);
    }).pipe(Effect.provide(layer));
  });
});
