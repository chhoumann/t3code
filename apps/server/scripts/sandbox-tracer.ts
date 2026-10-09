// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - host-side live verifier that packs with Node's filesystem.
/**
 * End-to-end tracer for sandbox environments against real Boat. Run from the
 * repository root with a Boat key in the environment:
 *
 *   node --env-file=.env.local apps/server/scripts/sandbox-tracer.ts [--skip-build]
 *
 * Builds and packs this checkout's server, boots one Boat sandbox from it,
 * launches a seed thread twice, stops and resumes the machine, and destroys it
 * on every exit path. Tokens are never printed.
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
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";

import serverPackageJson from "../package.json" with { type: "json" };
import { stageRuntimeExternals } from "../../../scripts/build-cli-archive.ts";
import * as BoatSandboxProvider from "../src/sandbox/BoatSandboxProvider.ts";
import {
  SANDBOX_BOOT_LOG,
  SANDBOX_ENV_FILE,
  SANDBOX_INPUTS_DIR,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_T3_PORT,
  renderSandboxBootScript,
} from "../src/sandbox/sandboxBootScript.ts";
import * as SandboxGuest from "../src/sandbox/SandboxGuest.ts";
import {
  SandboxProvider,
  type ProviderMachineId,
  type ProviderMachineState,
} from "../src/sandbox/SandboxProvider.ts";

const { values: flags } = NodeUtil.parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    repo: { type: "string", default: "https://github.com/octocat/Hello-World" },
  },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const serverDir = NodePath.join(repoRoot, "apps/server");
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const TARBALL_PATH = `${SANDBOX_INPUTS_DIR}/t3.tgz`;
const FIXTURE_REMOTE = "/home/user/fixtures/remote.git";
const SETUP_PROOF_FILE = ".t3-setup-proof";
const SETUP_FIXTURE_SCRIPT = {
  name: "Setup",
  command: `echo setup-ran > ${SETUP_PROOF_FILE}`,
  runOnWorktreeCreate: true,
};

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
    yield* say(`${name.padEnd(44)} ${seconds(now - startedAt).padStart(6)}s`);
    return result;
  });

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(new TracerError({ reason: `check failed: ${message}` }));

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
    );
    yield* check(exitCode === 0, `${command} ${args.join(" ")} exited ${exitCode}`);
  });

/**
 * This checkout's server laid out like a linux-x64 release archive (bundle,
 * web client, runtime externals staged by the archive build), minus the
 * single-executable: the machine's Node runs the bundle.
 */
const packServer = Effect.gen(function* () {
  if (!flags["skip-build"]) yield* run("vp", ["run", "--filter", "t3", "build"], repoRoot);
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-pack-"));
  const root = NodePath.join(stage, "t3");
  NodeFS.mkdirSync(root);
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: root,
    platform: "linux",
    arch: "x64",
    version: serverPackageJson.version,
  });
  NodeFS.cpSync(NodePath.join(serverDir, "dist"), NodePath.join(root, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  const tarball = NodePath.join(stage, "t3.tgz");
  yield* run("tar", ["--no-mac-metadata", "-czf", tarball, "-C", stage, "t3"], stage);
  return { tarball, bytes: NodeFS.readFileSync(tarball) };
});

const program = Effect.gen(function* () {
  const provider = yield* SandboxProvider;
  const guest = yield* SandboxGuest.SandboxGuest;
  const httpClient = yield* HttpClient.HttpClient;
  const runStartedAt = yield* Clock.currentTimeMillis;
  const account = { apiKey: yield* Config.Redacted("BOAT_DEV_API_KEY") };
  const api = (baseUrl: string) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const packed = yield* step("pack server", packServer);
  yield* say(`tarball ${(packed.bytes.length / 1024 / 1024).toFixed(1)} MiB`);

  const idempotencyKey = `t3-sandbox-tracer-${NodeCrypto.randomUUID()}`;
  yield* say(`create idempotency key ${idempotencyKey}`);
  const machine = yield* step(
    "create sandbox",
    Effect.acquireRelease(
      provider.create(account, {
        idempotencyKey,
        size: "small",
        ttlSeconds: 3600,
        env: {},
        template: null,
        providerEnvironment: null,
        setupScript: renderSandboxBootScript({
          source: { kind: "tarball", version: serverPackageJson.version, path: TARBALL_PATH },
          machineSetupScript: null,
        }),
      }),
      (created) =>
        step(
          "destroy sandbox",
          provider.destroy(account, created.id).pipe(
            Effect.andThen(
              provider.inspect(account, created.id).pipe(
                Effect.flatMap((seen) =>
                  seen === null
                    ? Effect.void
                    : Effect.fail(new TracerError({ reason: "still present" })),
                ),
                Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
              ),
            ),
          ),
        ).pipe(
          Effect.andThen(say(`destroyed ${created.id} (inspect -> 404)`)),
          Effect.catch((error) =>
            Console.error(`[tracer] DESTROY FAILED for ${created.id}: ${error.message}`),
          ),
        ),
    ),
  );
  const id: ProviderMachineId = machine.id;
  yield* say(`created Boat sandbox ${id}`);

  const awaitState = (want: ProviderMachineState) =>
    provider.inspect(account, id).pipe(
      Effect.filterOrFail(
        (seen) => seen?.state === want,
        (seen) => new TracerError({ reason: `state ${seen?.state}` }),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 180 }),
    );
  yield* step("machine running", awaitState("running"));

  yield* step(
    "upload inputs",
    Effect.gen(function* () {
      yield* provider.writeFile(account, id, {
        path: SANDBOX_ENV_FILE,
        content: new TextEncoder().encode("# The tracer passes no account env.\n"),
      });
      const parts = Math.ceil(packed.bytes.length / UPLOAD_CHUNK_BYTES);
      yield* Effect.forEach(
        Array.from({ length: parts }, (_, index) => index),
        (index) =>
          provider.writeFile(account, id, {
            path: `${TARBALL_PATH}.part-${String(index).padStart(3, "0")}`,
            content: packed.bytes.subarray(
              index * UPLOAD_CHUNK_BYTES,
              (index + 1) * UPLOAD_CHUNK_BYTES,
            ),
          }),
        { concurrency: 3 },
      );
      const joined = yield* provider.exec(account, id, {
        command: `cat '${TARBALL_PATH}'.part-* > '${TARBALL_PATH}' && rm -f '${TARBALL_PATH}'.part-* && sha256sum '${TARBALL_PATH}'`,
        timeoutSeconds: 60,
      });
      const expected = NodeCrypto.createHash("sha256").update(packed.bytes).digest("hex");
      yield* check(
        joined.stdout.startsWith(expected),
        `tarball sha256 matches after ${parts} parts`,
      );
      yield* provider.writeFile(account, id, {
        path: SANDBOX_INPUTS_READY_FILE,
        content: new Uint8Array(),
      });
    }),
  );

  const baseUrl = yield* step(
    "host port 3773 publicly",
    provider.host(account, id, SANDBOX_T3_PORT),
  );
  yield* say(`guest ${baseUrl}`);
  // Boat reports the setup script as failed after a resume, so only the first boot checks it.
  const descriptor = (label: string, watchBootScript: boolean) =>
    step(
      label,
      api(baseUrl).pipe(
        Effect.flatMap((client) => client.metadata.descriptor()),
        // Boat's edge can hold a request to a port with no listener yet for minutes.
        Effect.timeout("5 seconds"),
        Effect.tapError(() =>
          provider.inspect(account, id).pipe(
            Effect.tap((seen) =>
              watchBootScript
                ? Effect.void
                : say(`  waiting: machine ${seen?.state}, setup ${seen?.setup}`),
            ),
            Effect.flatMap((seen) =>
              watchBootScript && seen?.setup === "failed"
                ? provider
                    .exec(account, id, {
                      command: `tail -n 40 '${SANDBOX_BOOT_LOG}'`,
                      timeoutSeconds: 10,
                    })
                    .pipe(
                      Effect.flatMap((log) =>
                        Effect.die(
                          new TracerError({ reason: `the boot script failed:\n${log.stdout}` }),
                        ),
                      ),
                    )
                : Effect.void,
            ),
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 450 }),
      ),
    );
  const environment = yield* descriptor("T3 serves /.well-known/t3/environment", true);
  yield* say(
    `environment ${environment.environmentId} server ${environment.serverVersion} on ${environment.platform.os}`,
  );

  const dumpServerLog = provider
    .exec(account, id, {
      // The startup banner carries a pairing token and its QR code.
      command:
        "grep -avE 'Token:|Pairing URL|pair#token|[█▀▄]' /home/user/.t3/userdata/logs/boot-service.log | tail -n 40",
      timeoutSeconds: 10,
    })
    .pipe(
      Effect.flatMap((log) => Console.error(`[tracer] guest server log tail:\n${log.stdout}`)),
      Effect.ignore,
    );
  yield* Effect.gen(function* () {
    const token = yield* step("mint admin session (exec)", guest.mintAdminSession(account, id));
    const target = { baseUrl, token };

    yield* step(
      "pairing grant exchanges for a session",
      Effect.gen(function* () {
        const credential = yield* guest.issuePairingCredential(target, "sandbox tracer client");
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
      }),
    );

    // The project clones from a copy of the public repo that adds a t3.json,
    // so the run proves the clone's own setup script runs in the guest.
    yield* step(
      "prepare remote: public repo + t3.json commit",
      provider.exec(account, id, {
        command: [
          "set -euo pipefail",
          "rm -rf /home/user/fixtures && mkdir -p /home/user/fixtures && cd /home/user/fixtures",
          `git clone --quiet '${flags.repo}' work`,
          `printf '%s' '${JSON.stringify({ scripts: [SETUP_FIXTURE_SCRIPT] })}' > work/t3.json`,
          "git -C work add t3.json",
          "git -C work -c user.name=tracer -c user.email=tracer@example.invalid commit --quiet -m 'Add t3.json'",
          `git clone --quiet --bare work '${FIXTURE_REMOTE}'`,
        ].join("\n"),
        timeoutSeconds: 120,
      }),
    );
    const checkout = {
      remoteUrl: FIXTURE_REMOTE,
      commit: null,
      path: `/home/user/projects/${flags.repo.split("/").at(-1)}`,
    };
    const scripts = yield* step(
      "clone checkout (exec)",
      guest.cloneCheckout(account, id, checkout),
    );
    yield* step("clone checkout again (no-op)", guest.cloneCheckout(account, id, checkout));
    yield* say(`t3.json scripts imported: ${scripts.length}`);

    const seed = {
      projectId: ProjectId.make(NodeCrypto.randomUUID()),
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      title: "Sandbox tracer",
      message: "Add hello.txt containing 'hello from a sandbox'.",
      driver: ProviderDriverKind.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    };
    const first = yield* step(
      "launch seed thread",
      guest.launchSeedThread(target, { checkout, scripts, seed }),
    );
    const second = yield* step(
      "launch seed thread again (retry)",
      guest.launchSeedThread(target, { checkout, scripts, seed }),
    );
    yield* check(!first.resumed && second.resumed, "the retry replayed the first launch");

    const orchestrationHeaders = {
      authorization: `Bearer ${Redacted.value(token)}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    } as const;
    const threadSnapshot = api(baseUrl).pipe(
      Effect.flatMap((client) =>
        client.orchestration.threadSnapshot({
          headers: orchestrationHeaders,
          params: { threadId: seed.threadId },
        }),
      ),
    );
    const readBack = (label: string) =>
      step(
        label,
        Effect.gen(function* () {
          const client = yield* api(baseUrl);
          const shell = yield* client.orchestration.shellSnapshot({
            headers: orchestrationHeaders,
          });
          const { projection } = yield* threadSnapshot;
          const userMessages = projection.messages.filter((message) => message.role === "user");
          yield* check(shell.projects.length === 1, `one project (saw ${shell.projects.length})`);
          yield* check(
            shell.threads.length === 1 && shell.threads[0]?.id === seed.threadId,
            `one thread with the chosen id (saw ${shell.threads.length})`,
          );
          yield* check(
            userMessages.length === 1 && userMessages[0]?.id === seed.messageId,
            `one initial message with the chosen id (saw ${userMessages.length})`,
          );
        }),
      );
    yield* readBack("read back: 1 project, 1 thread, 1 message");
    yield* check(
      scripts.length === 1,
      `the t3.json setup script was imported (saw ${scripts.length})`,
    );
    yield* step(
      "clone's t3.json setup script ran",
      provider
        .exec(account, id, {
          command: `cat '${checkout.path}/${SETUP_PROOF_FILE}'`,
          timeoutSeconds: 10,
        })
        .pipe(
          Effect.filterOrFail(
            (result) => result.stdout.trim() === "setup-ran",
            () => new TracerError({ reason: "no setup proof yet" }),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
        ),
    );

    const terminalRuns = new Set(["completed", "failed", "interrupted", "cancelled"]);
    const settled = yield* step(
      "first run reaches a terminal state",
      threadSnapshot.pipe(
        Effect.flatMap(({ projection }) =>
          terminalRuns.has(projection.runs[0]?.status ?? "")
            ? Effect.succeed(projection)
            : Effect.fail(new TracerError({ reason: `run ${projection.runs[0]?.status}` })),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
      ),
    );
    yield* say(
      `run ${settled.runs[0]?.status}; instance ${settled.runs[0]?.providerInstanceId}; attempts ${settled.attempts.map((attempt) => attempt.status).join(",")}`,
    );
    for (const message of settled.messages.filter((entry) => entry.role !== "user")) {
      yield* say(`  ${message.role}: ${message.text.slice(0, 300).replaceAll("\n", " ")}`);
    }

    yield* step(
      "stop sandbox",
      provider.stop(account, id).pipe(Effect.andThen(awaitState("stopped"))),
    );
    yield* step(
      "resume sandbox",
      provider.resume(account, id).pipe(Effect.andThen(awaitState("running"))),
    );
    const resumed = yield* descriptor("T3 back on its own after resume", false);
    yield* check(
      resumed.environmentId === environment.environmentId,
      "the environment id survived stop and resume",
    );
    yield* readBack("read back after resume: thread still there");
    const bootRuns = yield* provider.exec(account, id, {
      command: `grep -c '^+ touch ' '${SANDBOX_BOOT_LOG}'`,
      timeoutSeconds: 10,
    });
    yield* say(`boot script runs recorded in the boot log: ${bootRuns.stdout.trim()}`);
    yield* say(`OK in ${seconds((yield* Clock.currentTimeMillis) - runStartedAt)}s`);
  }).pipe(Effect.tapError(() => dumpServerLog));
});

program.pipe(
  Effect.scoped,
  Effect.provide(
    SandboxGuest.layer.pipe(
      Layer.provideMerge(BoatSandboxProvider.layer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  NodeRuntime.runMain,
);
