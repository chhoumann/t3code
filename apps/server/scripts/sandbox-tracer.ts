// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - host-side live verifier that packs with Node's filesystem.
/**
 * End-to-end tracer for sandbox environments against real Boat, through the
 * durable SandboxService. Run from the repository root with a Boat key in the
 * environment:
 *
 *   node --env-file=.env.local apps/server/scripts/sandbox-tracer.ts [--skip-build]
 *
 * Packs this checkout's server, launches one sandbox to ready, stops and
 * resumes it twice (changing the account env between resumes), and destroys
 * it on every exit path. Tokens are never printed.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentHttpApi,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProviderDriverKind,
  SandboxAccountId,
  SandboxId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type SandboxStatus,
  type SandboxView,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { Socket } from "effect/socket";
import * as SqlClient from "effect/sql/SqlClient";

import serverPackageJson from "../package.json" with { type: "json" };
import { packSandboxServer } from "./pack-sandbox-server.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as BoatSandboxProvider from "../src/sandbox/BoatSandboxProvider.ts";
import { SANDBOX_ENV_FILE, SANDBOX_SETUP_ENV_FILE } from "../src/sandbox/sandboxBootScript.ts";
import * as SandboxAccounts from "../src/sandbox/SandboxAccounts.ts";
import * as SandboxGuest from "../src/sandbox/SandboxGuest.ts";
import { ProviderMachineId, SandboxProvider } from "../src/sandbox/SandboxProvider.ts";
import * as SandboxService from "../src/sandbox/SandboxService.ts";

const { values: flags } = NodeUtil.parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    /**
     * Gives the account this shell's Anthropic proxy credentials and a Tailscale
     * auth key, joins the tailnet on every boot, and checks that the seed turn
     * and a follow-up after a resume both get real replies.
     */
    "agent-proxy": { type: "boolean", default: false },
    repo: { type: "string", default: "https://github.com/octocat/Hello-World" },
  },
});

const ACCOUNT_ID = SandboxAccountId.make("tracer");
const SETUP_RUNS_LOG = "/home/user/machine-setup-runs.log";
/** Appends the boot's id and the account env's round on every run of the setup unit. */
const MACHINE_SETUP_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  `echo "$(cat /proc/sys/kernel/random/boot_id) round=$T3_TRACER_ROUND" >> ${SETUP_RUNS_LOG}`,
  "",
].join("\n");
/**
 * Boat drops the Tailscale package and its state on resume, so every boot
 * reinstalls it when missing and logs in again with the reusable ephemeral key.
 * `--reset` lets a re-run on the same boot change nothing but the login.
 */
const TAILSCALE_SETUP_SCRIPT = [
  MACHINE_SETUP_SCRIPT.trimEnd(),
  "command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sudo sh",
  "sudo systemctl enable --now tailscaled",
  'sudo tailscale up --reset --auth-key="$TAILSCALE_AUTH_KEY" --accept-dns=true --hostname="t3-sandbox-$(hostname | tr -cd \'a-z0-9-\' | cut -c1-20)"',
  "",
].join("\n");
const AGENT_REPLY_TIMEOUT = "6 minutes";
const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const LOGIN_FAILURE = /not logged in|\/login|invalid api key|authentication_error/i;
const STEP_TIMEOUT = "10 minutes";
const decodeSeed = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String })),
);

class TracerError extends Schema.TaggedError<TracerError>()("TracerError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const say = (line: string) => Console.log(`[tracer] ${line}`);
const seconds = (ms: number) => (ms / 1000).toFixed(1);

const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* effect;
    const now = yield* Clock.currentTimeMillis;
    yield* say(`${name.padEnd(48)} ${seconds(now - startedAt).padStart(6)}s`);
    return result;
  });

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(new TracerError({ reason: `check failed: ${message}` }));

const packServer = Effect.gen(function* () {
  const out = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-tracer-pack-")),
    "t3.tgz",
  );
  yield* packSandboxServer({ skipBuild: flags["skip-build"], out });
  return new Uint8Array(NodeFS.readFileSync(out));
});

/** The account env's round; bumped before a resume to prove the env file is rewritten. */
let envRound = 1;

type AccountEnv = SandboxAccounts.SandboxAccount["env"];

/** The proxy credentials and tailnet key from this shell, read without printing them. */
const agentProxyEnv = Effect.gen(function* () {
  const optional = (name: string) =>
    Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));
  const agentEnv = (name: string, value: Redacted.Redacted<string>) => ({
    name,
    value,
    setupOnly: false,
  });
  return [
    agentEnv("ANTHROPIC_BASE_URL", yield* Config.Redacted("ANTHROPIC_BASE_URL")),
    agentEnv("ANTHROPIC_AUTH_TOKEN", yield* Config.Redacted("ANTHROPIC_AUTH_TOKEN")),
    agentEnv("ANTHROPIC_API_KEY", yield* optional("ANTHROPIC_API_KEY")),
    // Only the machine setup needs it to join the tailnet.
    {
      name: "TAILSCALE_AUTH_KEY",
      value: yield* Config.Redacted("TAILSCALE_AUTH_KEY"),
      setupOnly: true,
    },
  ] satisfies AccountEnv;
});

const accountsLayer = (apiKey: Redacted.Redacted<string>, proxyEnv: AccountEnv | null) => {
  const get = (accountId: SandboxAccountId) =>
    accountId !== ACCOUNT_ID
      ? Effect.fail(new SandboxAccounts.SandboxAccountNotFoundError({ accountId }))
      : Effect.sync(() => ({
          id: ACCOUNT_ID,
          provider: "boat" as const,
          apiKey,
          env: [
            ...(proxyEnv ?? [
              { name: "ANTHROPIC_API_KEY", value: Redacted.make(""), setupOnly: false },
            ]),
            {
              name: "T3_TRACER_ROUND",
              value: Redacted.make(String(envRound)),
              setupOnly: false,
            },
          ],
          machineSetupScript: proxyEnv === null ? MACHINE_SETUP_SCRIPT : TAILSCALE_SETUP_SCRIPT,
          template: null,
          providerEnvironment: null,
          size: "small" as const,
          stopAfterHours: 1,
        }));
  return Layer.succeed(
    SandboxAccounts.SandboxAccounts,
    SandboxAccounts.SandboxAccounts.of({
      get,
      withAccount: (accountId, use) => get(accountId).pipe(Effect.flatMap(use)),
      save: () => Effect.die("The tracer's account is fixed."),
      remove: () => Effect.die("The tracer's account is fixed."),
    }),
  );
};

const secrets = new Map<string, Uint8Array>();
const secretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  }),
);

const trace = (apiKey: Redacted.Redacted<string>, runStartedAt: number) =>
  Effect.gen(function* () {
    const sandboxes = yield* SandboxService.SandboxService;
    const provider = yield* SandboxProvider;
    const guest = yield* SandboxGuest.SandboxGuest;
    const sql = yield* SqlClient.SqlClient;
    const httpClient = yield* HttpClient.HttpClient;
    const account = { apiKey };
    const api = (baseUrl: string) =>
      HttpApiClient.make(EnvironmentHttpApi, { baseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    const id = SandboxId.make(`tracer-${NodeCrypto.randomUUID().slice(0, 8)}`);
    yield* say(`sandbox ${id}`);

    const storedColumn = (column: "machine_id" | "seed_json") =>
      sql<Record<string, string | null>>`
        SELECT ${sql(column)} AS value FROM sandboxes WHERE sandbox_id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.["value"] ?? null),
      );
    const machineId = storedColumn("machine_id");

    /** Resolves when the sandbox shows `tag`; fails as soon as it shows failed instead, unless told to wait past it. */
    const awaitStatus = (tag: SandboxStatus["_tag"], options = { failFast: true }) =>
      Effect.gen(function* () {
        const seen = yield* sandboxes.subscribe().pipe(
          Stream.map((views: ReadonlyArray<SandboxView>) =>
            views.find(
              (view) =>
                view.id === id &&
                (view.status._tag === tag || (options.failFast && view.status._tag === "failed")),
            ),
          ),
          Stream.filter((view) => view !== undefined),
          Stream.runHead,
          Effect.timeoutOrElse({ duration: STEP_TIMEOUT, orElse: () => Effect.succeedNone }),
        );
        if (Option.isNone(seen)) {
          return yield* new TracerError({ reason: `timed out waiting for ${tag}` });
        }
        if (seen.value.status._tag !== tag) {
          return yield* new TracerError({
            reason: `sandbox failed: ${JSON.stringify(seen.value.status)}`,
          });
        }
        return seen.value;
      });

    yield* sandboxes.subscribe().pipe(
      Stream.map((views: ReadonlyArray<SandboxView>) => views.find((view) => view.id === id)),
      Stream.filter((view) => view !== undefined),
      Stream.changesWith((a, b) => JSON.stringify(a.status) === JSON.stringify(b.status)),
      Stream.runForEach((view) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            say(`  status ${JSON.stringify(view.status)} at +${seconds(now - runStartedAt)}s`),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const exec = (command: string) =>
      Effect.gen(function* () {
        const machine = yield* machineId;
        if (machine === null) return yield* new TracerError({ reason: "no machine id" });
        const result = yield* provider.exec(account, ProviderMachineId.make(machine), {
          command,
          timeoutSeconds: 30,
        });
        return result.stdout.trim();
      });

    const confirmGone = Effect.gen(function* () {
      const machine = yield* machineId;
      if (machine === null) return yield* say(`no machine was stored for ${id}`);
      const seen = yield* provider.inspect(account, ProviderMachineId.make(machine));
      yield* check(seen === null, `Boat still has ${machine}`);
      yield* say(`destroyed ${machine} (inspect -> 404)`);
    });
    const cleanUp = Effect.gen(function* () {
      yield* say("cleaning up after a failure");
      yield* sandboxes.update({ id, desired: "destroyed" }).pipe(Effect.ignore);
      yield* awaitStatus("destroyed", { failFast: false });
      yield* confirmGone;
    }).pipe(
      Effect.catch((error) =>
        Console.error(`[tracer] cleanup through the service failed: ${error.message}`).pipe(
          Effect.andThen(machineId),
          Effect.flatMap((machine) =>
            machine === null
              ? Effect.void
              : provider.destroy(account, ProviderMachineId.make(machine)).pipe(
                  Effect.andThen(
                    provider.inspect(account, ProviderMachineId.make(machine)).pipe(
                      Effect.filterOrFail(
                        (found) => found === null,
                        () => new TracerError({ reason: "still present" }),
                      ),
                      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
                    ),
                  ),
                  Effect.andThen(say(`destroyed ${machine} directly (inspect -> 404)`)),
                ),
          ),
        ),
      ),
      Effect.catch((error) => Console.error(`[tracer] DESTROY FAILED for ${id}: ${error.message}`)),
    );
    yield* Effect.addFinalizer((exit) => (exit._tag === "Success" ? Effect.void : cleanUp));

    yield* sandboxes.launch({
      id,
      accountId: ACCOUNT_ID,
      title: "Sandbox tracer",
      message: "Add hello.txt containing 'hello from a sandbox'.",
      repository: { remoteUrl: flags.repo, commit: null },
      driver: ProviderDriverKind.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const ready = yield* step("launch -> ready", awaitStatus("ready"));
    const baseUrl = ready.httpBaseUrl ?? "";
    yield* say(`Boat sandbox ${yield* machineId}, environment ${ready.environmentId}`);

    const token = Redacted.make(new TextDecoder().decode(secrets.get(`sandbox-${id}-admin`)));
    const seed = yield* decodeSeed((yield* storedColumn("seed_json")) ?? "");
    const readBack = (label: string) =>
      step(
        label,
        Effect.gen(function* () {
          const client = yield* api(baseUrl);
          const shell = yield* client.orchestration.shellSnapshot({
            headers: {
              authorization: `Bearer ${Redacted.value(token)}`,
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
            },
          });
          yield* check(shell.projects.length === 1, `one project (saw ${shell.projects.length})`);
          yield* check(
            shell.threads.length === 1 && shell.threads[0]?.id === seed.threadId,
            `exactly the seed thread (saw ${shell.threads.length})`,
          );
        }),
      );
    yield* readBack("read back: 1 project, the seed thread once");

    const threadId = ThreadId.make(seed.threadId);
    /** One line naming where the route from the machine to the proxy breaks; no secrets. */
    const diagnoseProxy = (label: string) =>
      exec(
        [
          `set -a && . ${SANDBOX_ENV_FILE} && set +a`,
          `host=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed -E 's#^https?://([^/:]+).*#\\1#')`,
          `backend=$(tailscale status --json 2>/dev/null | grep -o '"BackendState": *"[A-Za-z]*"' | head -n 1 | grep -o '[A-Za-z]*"$' | tr -d '"')`,
          `dns=$(getent hosts "$host" >/dev/null && echo ok || echo fail)`,
          `tcp=$(timeout 5 bash -c "</dev/tcp/$host/443" 2>/dev/null && echo ok || echo fail)`,
          `http=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'anthropic-version: 2023-06-01' "$ANTHROPIC_BASE_URL/v1/models" 2>/dev/null || true)`,
          `echo "tailnet=\${backend:-none} dns=$dns tcp443=$tcp http=\${http:-000}"`,
        ].join("\n"),
      ).pipe(Effect.tap((line) => say(`${label}: ${line}`)));

    /** Waits for the thread's `runCount`th run to end, then returns its status and reply. */
    const awaitReply = (runCount: number) =>
      Effect.gen(function* () {
        const client = yield* api(baseUrl);
        const detail = yield* client.orchestration.threadSnapshot({
          params: { threadId },
          headers: {
            authorization: `Bearer ${Redacted.value(token)}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
        });
        const run = detail.projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)[runCount - 1];
        if (run === undefined || !TERMINAL_RUN_STATUSES.has(run.status)) {
          return yield* new TracerError({ reason: `run ${runCount} has not ended` });
        }
        const reply = detail.projection.messages
          .filter((message) => message.role === "assistant" && message.runId === run.id)
          .map((message) => message.text)
          .join("\n")
          .trim();
        return { status: run.status, reply };
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "TracerError",
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.timeoutOrElse({
          duration: AGENT_REPLY_TIMEOUT,
          orElse: () => Effect.fail(new TracerError({ reason: `run ${runCount} did not end` })),
        }),
      );

    const checkReply = (label: string, outcome: { status: string; reply: string }) =>
      Effect.gen(function* () {
        yield* say(`${label}: run ${outcome.status}, reply ${outcome.reply.length} chars`);
        yield* say(`  reply: ${JSON.stringify(outcome.reply.slice(0, 160))}`);
        yield* check(outcome.status === "completed", `${label}: the run completed`);
        yield* check(outcome.reply.length > 0, `${label}: the agent replied`);
        yield* check(!LOGIN_FAILURE.test(outcome.reply), `${label}: the agent was logged in`);
      });

    if (flags["agent-proxy"]) {
      yield* diagnoseProxy("proxy route after launch");
      yield* checkReply("seed turn", yield* step("seed turn -> reply", awaitReply(1)));
    }
    let followUps = 0;
    const sendFollowUp = (text: string) =>
      Effect.gen(function* () {
        const rpc = yield* SandboxGuest.connectGuestRpc({ baseUrl, token });
        yield* rpc["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        followUps += 1;
      }).pipe(Effect.scoped);

    yield* step(
      "pairing grant exchanges for a session",
      Effect.gen(function* () {
        const credential = yield* guest.issuePairingCredential(
          { baseUrl, token },
          { label: "tracer" },
        );
        const client = yield* api(baseUrl);
        const issued = yield* client.auth.token({
          headers: {},
          payload: {
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: Redacted.value(credential),
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          },
        });
        const session = yield* client.auth.session({
          headers: { authorization: `Bearer ${issued.access_token}` },
        });
        yield* check(session.authenticated, "the paired client session authenticates");

        const refused = yield* Effect.scoped(
          Effect.gen(function* () {
            const rpc = yield* SandboxGuest.connectGuestRpc({
              baseUrl,
              token: Redacted.make(issued.access_token),
            });
            return yield* rpc["orchestration.dispatchCommand"]({
              type: "thread.archive",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId,
            }).pipe(Effect.flip);
          }),
        );
        yield* say(`a paired client archiving the seed thread: ${refused._tag}`);
        yield* check(
          refused._tag === "SandboxManagedByOwnerError" &&
            refused.sandboxId === id &&
            refused.ownerEnvironmentId === "sandbox-tracer-owner",
          "the sandbox refuses to archive its seed thread for anyone but its owner",
        );
      }),
    );

    const pairingLines = yield* exec(
      "grep -c 'Token:\\|pair#token' /home/user/.t3/userdata/logs/boot-service.log || true",
    );
    yield* say(`startup pairing lines in the guest service log: ${pairingLines}`);
    yield* check(pairingLines === "0", "the guest logs no startup pairing token");

    const distinctBoots = exec(`cut -d' ' -f1 ${SETUP_RUNS_LOG} | sort -u | wc -l`).pipe(
      Effect.map(Number),
    );
    yield* check((yield* distinctBoots) === 1, "the machine setup ran on the first boot");

    for (const round of [1, 2]) {
      yield* sandboxes.update({ id, desired: "stopped" });
      const stopped = yield* step(`round ${round}: stopped`, awaitStatus("stopped"));
      yield* check(
        stopped.status._tag === "stopped" && stopped.status.reason === "requested",
        "stopped as requested",
      );
      envRound = round + 1;
      yield* sandboxes.update({ id, desired: "running" });
      const resumed = yield* step(`round ${round}: resumed to ready`, awaitStatus("ready"));
      yield* check(
        resumed.environmentId === ready.environmentId,
        "the environment id survived stop and resume",
      );
      yield* readBack(`round ${round}: read back: the same seed thread`);
      const boots = yield* distinctBoots;
      const lastRun = yield* exec(`tail -n 1 ${SETUP_RUNS_LOG}`);
      const envFileRound = yield* exec(
        `grep -c '^T3_TRACER_ROUND="${envRound}"$' ${SANDBOX_ENV_FILE} || true`,
      );
      yield* say(
        `round ${round}: setup ran on ${boots} boots; last run ${lastRun.split(" ").at(-1)}; sandbox.env round ${envRound}: ${envFileRound === "1" ? "yes" : "no"}`,
      );
      yield* check(boots === round + 1, `the machine setup ran on boot ${round + 1}`);
      yield* check(envFileRound === "1", `sandbox.env carries round ${envRound}`);
      yield* check(lastRun.endsWith(`round=${envRound}`), "the setup re-ran with the new env");
      if (flags["agent-proxy"]) {
        yield* diagnoseProxy(`round ${round}: proxy route after resume`);
        const envNames = yield* exec(
          [
            'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
            "pid=$(systemctl --user show -p MainPID --value t3code.service)",
            `count() { tr '\\0' '\\n' < "$1" | grep -c "^$2=" || true; }`,
            `echo "service_tailscale=$(count /proc/$pid/environ TAILSCALE_AUTH_KEY)" \\`,
            `"service_anthropic=$(count /proc/$pid/environ ANTHROPIC_BASE_URL)" \\`,
            `"sandbox_env_tailscale=$(grep -c '^TAILSCALE_AUTH_KEY=' ${SANDBOX_ENV_FILE} || true)" \\`,
            `"setup_env_tailscale=$(grep -c '^TAILSCALE_AUTH_KEY=' ${SANDBOX_SETUP_ENV_FILE} || true)"`,
          ].join("\n"),
        );
        yield* say(`round ${round}: env names: ${envNames}`);
        yield* check(
          envNames ===
            "service_tailscale=0 service_anthropic=1 sandbox_env_tailscale=0 setup_env_tailscale=1",
          "the setup-only key reaches the machine setup but not T3",
        );
        yield* sendFollowUp(
          "Run `printenv TAILSCALE_AUTH_KEY >/dev/null && echo SET || echo UNSET` in a shell and answer with its output only.",
        );
        const outcome = yield* step(
          `round ${round}: follow-up -> reply`,
          awaitReply(1 + followUps),
        );
        yield* checkReply(`round ${round}: follow-up`, outcome);
        yield* check(
          /\bUNSET\b/.test(outcome.reply) && !/\bSET\b/.test(outcome.reply),
          "the agent's process env lacks the setup-only key",
        );
      }
    }

    yield* sandboxes.update({ id, desired: "destroyed" });
    yield* step("destroyed", awaitStatus("destroyed"));
    yield* confirmGone;
  });

const program = Effect.gen(function* () {
  const runStartedAt = yield* Clock.currentTimeMillis;
  const apiKey = yield* Config.Redacted("BOAT_DEV_API_KEY");
  const proxyEnv = flags["agent-proxy"] ? yield* agentProxyEnv : null;
  const tarball = yield* step("pack server", packServer);
  yield* say(`tarball ${(tarball.length / 1024 / 1024).toFixed(1)} MiB`);
  const databaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-tracer-"));

  yield* trace(apiKey, runStartedAt).pipe(
    Effect.scoped,
    Effect.provide(
      SandboxService.layer.pipe(
        Layer.provide(
          Layer.succeed(SandboxService.SandboxT3Build, {
            kind: "tarball",
            version: serverPackageJson.version,
            bytes: tarball,
          }),
        ),
        Layer.provideMerge(SandboxGuest.layer),
        Layer.provideMerge(BoatSandboxProvider.layer),
        Layer.provideMerge(accountsLayer(apiKey, proxyEnv)),
        Layer.provideMerge(secretStoreLayer),
        Layer.provideMerge(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("sandbox-tracer-owner")),
            getDescriptor: Effect.die("The tracer has no environment descriptor."),
          }),
        ),
        Layer.provideMerge(
          SqlitePersistence.layerFromPath(NodePath.join(databaseDir, "state.sqlite")),
        ),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(Socket.layerWebSocketConstructorGlobal),
      ),
    ),
  );
  yield* say(`OK in ${seconds((yield* Clock.currentTimeMillis) - runStartedAt)}s`);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
