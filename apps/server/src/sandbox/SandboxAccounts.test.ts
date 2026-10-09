import { assert, describe, it } from "@effect/vitest";
import { SandboxAccountId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
  const layer = SandboxAccounts.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest()),
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
        ],
      });
      assert.deepStrictEqual(saved.envNames, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.deepStrictEqual(settings.sandboxAccounts[ID], saved);
      const settingsText = JSON.stringify(settings);
      assert.notInclude(settingsText, "boat-secret-key");
      assert.notInclude(settingsText, "proxy-secret-token");
      assert.includeMembers(storedText(world), ["boat-secret-key", "proxy-secret-token", ""]);

      const account = yield* accounts.get(ID);
      assert.strictEqual(Redacted.value(account.apiKey), "boat-secret-key");
      assert.deepStrictEqual(
        account.env.map((entry) => [entry.name, Redacted.value(entry.value)]),
        [
          ["ANTHROPIC_API_KEY", ""],
          ["ANTHROPIC_AUTH_TOKEN", "proxy-secret-token"],
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
});
