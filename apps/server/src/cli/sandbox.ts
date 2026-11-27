/**
 * Sandbox guest bootstrap daemon, git credential helper, and remote provider bridge CLI.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  FleetMuxEndpoint,
  FleetMuxStream,
  FleetStreamAck,
  FleetStreamTarget,
} from "@t3tools/shared/fleetMux";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import {
  attachMuxToEffectSocket,
  bridgeMuxStreamToTcp,
  createLoopbackForwarder,
  serveMuxHttpToLocalOrigin,
  serveMuxWsToLocalOrigin,
  syncFleetHostsFile,
} from "../fleet/fleetMuxNode.ts";

const FleetBootstrapManifestSchema = Schema.Struct({
  environmentId: Schema.String,
  sandboxId: Schema.String,
  ownerEnvironmentId: Schema.String,
  hubConnectUrl: Schema.NullOr(Schema.String),
  nodeSecret: Schema.String,
  exposedHostPorts: Schema.Array(Schema.Int),
  peers: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      meshIp: Schema.String,
      slug: Schema.String,
      ports: Schema.Array(Schema.Int),
    }),
  ),
});
export type FleetBootstrapManifest = typeof FleetBootstrapManifestSchema.Type;

function buildBootstrapHostsEntries(manifest: FleetBootstrapManifest) {
  return [
    { ip: "127.43.0.1", host: "hub.t3.internal" },
    ...manifest.peers.map((peer) => ({
      ip: peer.meshIp,
      host: `${peer.slug}.fleet.t3.internal`,
    })),
  ];
}

let atomicCounter = 0;

function writeAtomic(filePath: string, content: string, mode = 0o600): void {
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true });
  atomicCounter += 1;
  const tmp = `${filePath}.tmp-${process.pid}-${atomicCounter}`;
  NodeFS.writeFileSync(tmp, content, { mode });
  NodeFS.renameSync(tmp, filePath);
}

const hubUrlFlag = Flag.String("hub-url").pipe(
  Flag.withDescription("Hub bootstrap HTTP URL (or set T3_BOOTSTRAP_URL)."),
  Flag.optional,
);
const nodeSecretFlag = Flag.String("secret").pipe(
  Flag.withDescription("Node secret (or set T3_NODE_SECRET)."),
  Flag.optional,
);
const stateDirFlag = Flag.String("state-dir").pipe(
  Flag.withDescription("T3 userdata state directory inside sandbox."),
  Flag.withDefault(NodePath.join(NodeOS.homedir(), ".t3", "userdata")),
);
const t3BinFlag = Flag.String("t3-bin").pipe(
  Flag.withDescription("Path to t3 executable inside sandbox."),
  Flag.withDefault(NodePath.join(NodeOS.homedir(), ".t3", "bin", "t3")),
);
const t3InternalPortFlag = Flag.Int("t3-port").pipe(
  Flag.withDescription("Loopback port where guest t3 listens."),
  Flag.withDefault(3774),
);
const acceptPortFlag = Flag.Int("accept-port").pipe(
  Flag.withDescription("Optional port for reverse-dial /_fleet/accept and guest proxy."),
  Flag.withDefault(3773),
);
const startT3Flag = Flag.Boolean("start-t3").pipe(
  Flag.withDescription("Supervise the guest t3 server process from this bootstrap daemon."),
  Flag.withDefault(true),
);

async function createPeerForwarders(
  manifest: FleetBootstrapManifest,
  getEndpoint: () => FleetMuxEndpoint | null,
): Promise<() => Promise<void>> {
  const closers: Array<() => Promise<void>> = [];

  for (const port of manifest.exposedHostPorts) {
    try {
      const fwd = await createLoopbackForwarder({
        bindHost: "127.43.0.1",
        listenPort: port,
        targetHost: "127.0.0.1",
        targetPort: port,
        getEndpoint,
      });
      closers.push(fwd.close);
    } catch {
      // macOS non-root or unconfigured 127.43.x alias skips non-127.0.0.1 bind gracefully; Linux supports 127.0.0.0/8.
    }
  }

  for (const peer of manifest.peers) {
    for (const port of peer.ports) {
      try {
        const fwd = await createLoopbackForwarder({
          bindHost: peer.meshIp,
          listenPort: port,
          targetHost: `peer://${peer.environmentId}`,
          targetPort: port,
          getEndpoint,
        });
        closers.push(fwd.close);
      } catch {
        // Ignore bind errors when non-127.0.0.1 loopback aliases aren't available.
      }
    }
  }

  return async () => {
    for (const close of closers) {
      await close();
    }
  };
}

function handleGuestMuxStream(
  stream: FleetMuxStream,
  target: FleetStreamTarget,
  t3Origin: string,
): Promise<FleetStreamAck> | FleetStreamAck {
  if (target.kind === "http") {
    return serveMuxHttpToLocalOrigin(stream, target, t3Origin);
  }
  if (target.kind === "ws") {
    return serveMuxWsToLocalOrigin(stream, target, t3Origin);
  }
  if (target.kind === "tcp") {
    return bridgeMuxStreamToTcp(stream, { host: target.host, port: target.port });
  }
  return { ok: false, error: "Unsupported mux stream target" };
}

function constantTimeBearerMatch(header: string | undefined, expectedSecret: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");
  if (candidate.byteLength !== expected.byteLength) return false;
  return NodeCrypto.timingSafeEqual(candidate, expected);
}

function readSandboxBootstrapEnv() {
  return {
    bootstrapUrl: process.env.T3_BOOTSTRAP_URL,
    secretArg: process.env.T3_NODE_SECRET,
    manifestFile: process.env.T3_BOOTSTRAP_FILE,
    providerSecret: process.env.T3_PROVIDER_SECRET,
    tokenUrl: process.env.T3_FLEET_TOKEN_URL,
  };
}

const decodeFleetBootstrapManifest = Schema.decodeUnknownSync(FleetBootstrapManifestSchema);

function loadManifestFromFile(filePath: string): FleetBootstrapManifest {
  return decodeFleetBootstrapManifest(JSON.parse(NodeFS.readFileSync(filePath, "utf8")));
}

const fetchManifestOverHttpClient = Effect.fn("sandbox.fetchBootstrapManifest")(function* (
  bootstrapUrl: string,
  secretArg: string | undefined,
) {
  const { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } =
    yield* Effect.promise(() => import("effect/http"));
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let req = HttpClientRequest.get(bootstrapUrl);
    if (secretArg) {
      req = HttpClientRequest.bearerToken(req, secretArg);
    }
    const res = yield* client.execute(req);
    return yield* HttpClientResponse.schemaBodyJson(FleetBootstrapManifestSchema)(res);
  }).pipe(Effect.provide(FetchHttpClient.layer));
});

function buildGuestServerEnv(t3Port: number, gitHelperPort: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3CODE_HOST: "127.0.0.1",
    T3CODE_PORT: String(t3Port),
    T3CODE_NO_STARTUP_PAIRING: "true",
    T3_FLEET_TOKEN_URL: `http://127.0.0.1:${gitHelperPort}/github-token`,
  };
}

const TokenHelperResponseSchema = Schema.Struct({
  token: Schema.NullOr(Schema.String),
});

const fetchTokenOverHttpClient = Effect.fn("sandbox.fetchTokenHelper")(function* (
  tokenUrl: string,
) {
  const { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } =
    yield* Effect.promise(() => import("effect/http"));
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(HttpClientRequest.get(tokenUrl));
    const parsed = yield* HttpClientResponse.schemaBodyJson(TokenHelperResponseSchema)(res);
    return parsed.token !== null && parsed.token.length > 0 ? parsed.token : null;
  }).pipe(Effect.provide(FetchHttpClient.layer));
});

const sandboxBootstrapCommand = Command.make("bootstrap", {
  hubUrl: hubUrlFlag,
  secret: nodeSecretFlag,
  stateDir: stateDirFlag,
  t3Bin: t3BinFlag,
  t3Port: t3InternalPortFlag,
  acceptPort: acceptPortFlag,
  startT3: startT3Flag,
}).pipe(
  Command.withDescription(
    "Bootstrap and supervise the guest T3 server inside a sandbox with Hub FleetMux and /_fleet/accept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const envValues = readSandboxBootstrapEnv();
      const bootstrapUrl = Option.getOrUndefined(flags.hubUrl) ?? envValues.bootstrapUrl;
      const secretArg = Option.getOrUndefined(flags.secret) ?? envValues.secretArg;
      const manifestFile = envValues.manifestFile;

      let manifest: FleetBootstrapManifest;
      if (manifestFile && NodeFS.existsSync(manifestFile)) {
        manifest = yield* Effect.try({
          try: () => loadManifestFromFile(manifestFile),
          catch: (cause) =>
            new CliError.UserError({
              cause,
              userMessage: `Could not read bootstrap manifest ${manifestFile}.`,
            }),
        });
      } else if (bootstrapUrl) {
        manifest = yield* fetchManifestOverHttpClient(bootstrapUrl, secretArg).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage: `Bootstrap manifest fetch from ${bootstrapUrl} failed.`,
              }),
          ),
        );
      } else {
        return yield* new CliError.UserError({
          cause: "missing bootstrap source",
          userMessage: "Pass --hub-url / T3_BOOTSTRAP_URL or T3_BOOTSTRAP_FILE.",
        });
      }

      writeAtomic(NodePath.join(flags.stateDir, "environment-id"), `${manifest.environmentId}\n`);
      syncFleetHostsFile(buildBootstrapHostsEntries(manifest));

      const t3Origin = `http://127.0.0.1:${flags.t3Port}`;
      let activeEndpoint: FleetMuxEndpoint | null = null;
      const stopForwarders = yield* Effect.promise(() =>
        createPeerForwarders(manifest, () => activeEndpoint),
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => stopForwarders()));

      const gitHelperServer = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<{ readonly server: NodeHttp.Server; readonly port: number }>((resolve) => {
              const server = NodeHttp.createServer((req, res) => {
                if (req.url === "/github-token" && activeEndpoint !== null) {
                  void activeEndpoint
                    .requestControl<{ readonly token: string | null }>("github.token", {
                      environmentId: manifest.environmentId,
                    })
                    .then((out) => {
                      res.writeHead(200, { "content-type": "application/json" });
                      res.end(JSON.stringify(out));
                    })
                    .catch((err) => {
                      res.writeHead(502);
                      res.end(String(err));
                    });
                  return;
                }
                res.writeHead(404);
                res.end();
              });
              server.listen(0, "127.0.0.1", () => {
                resolve({ server, port: (server.address() as { port: number }).port });
              });
            }),
        ),
        ({ server }) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      let child: NodeChildProcess.ChildProcess | null = null;
      if (flags.startT3) {
        const baseDir = NodePath.dirname(flags.stateDir);
        child = NodeChildProcess.spawn(
          flags.t3Bin,
          ["serve", "--base-dir", baseDir, "--host", "127.0.0.1", "--port", String(flags.t3Port)],
          {
            stdio: "inherit",
            env: buildGuestServerEnv(flags.t3Port, gitHelperServer.port),
          },
        );
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (child !== null && !child.killed) {
            child.kill("SIGTERM");
          }
        }),
      );

      if (flags.acceptPort > 0 && flags.acceptPort !== flags.t3Port) {
        const [
          {
            FetchHttpClient,
            HttpRouter,
            HttpServerRequest,
            HttpServerResponse,
            HttpClient,
            HttpClientRequest,
            HttpMethod,
          },
          NodeHttpServer,
          Layer,
        ] = yield* Effect.all([
          Effect.promise(() => import("effect/http")),
          Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
          Effect.promise(() => import("effect/Layer")),
        ]);

        const acceptRouter = HttpRouter.addAll([
          HttpRouter.route(
            "GET",
            "/_fleet/accept",
            Effect.gen(function* () {
              const req = yield* HttpServerRequest.HttpServerRequest;
              const reqUrl = new URL(req.url, `http://127.0.0.1:${flags.acceptPort}`);
              const querySecret = reqUrl.searchParams.get("secret");
              const bearerOk = constantTimeBearerMatch(
                req.headers.authorization,
                manifest.nodeSecret,
              );
              const queryOk =
                querySecret !== null &&
                constantTimeBearerMatch(`Bearer ${querySecret}`, manifest.nodeSecret);
              if (!bearerOk && !queryOk) {
                return HttpServerResponse.text("Unauthorized", { status: 401 });
              }
              if (req.headers.upgrade?.toLowerCase() !== "websocket") {
                return HttpServerResponse.text("Upgrade Required", { status: 426 });
              }
              const socket = yield* req.upgrade;
              const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
                initiator: false,
                onStream: (stream, target) => handleGuestMuxStream(stream, target, t3Origin),
              });
              activeEndpoint = endpoint;
              yield* run.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (activeEndpoint === endpoint) activeEndpoint = null;
                  }),
                ),
              );
              return HttpServerResponse.empty();
            }),
          ),
          HttpRouter.route(
            "*",
            "/*",
            Effect.gen(function* () {
              const req = yield* HttpServerRequest.HttpServerRequest;
              const parsed = new URL(req.url, t3Origin);
              const upstreamUrl = `${t3Origin}${parsed.pathname}${parsed.search}`;
              if (req.headers.upgrade?.toLowerCase() === "websocket") {
                const client = yield* req.upgrade;
                const upstream = yield* Socket.makeWebSocket(upstreamUrl.replace(/^http/i, "ws"), {
                  openTimeout: "10 seconds",
                  ...(req.headers["sec-websocket-protocol"]
                    ? {
                        protocols: req.headers["sec-websocket-protocol"]
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }
                    : {}),
                }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const cw = yield* client.writer;
                    const uw = yield* upstream.writer;
                    const cr = yield* client.reader;
                    const ur = yield* upstream.reader;
                    const pump = Effect.fn("sandbox.proxyWsPump")(function* (
                      src: Socket.Reader,
                      dst: Socket.Writer,
                    ) {
                      while (true) {
                        yield* dst.writeAll(yield* src.pull);
                      }
                    });
                    return yield* Effect.raceFirst(pump(ur, cw), pump(cr, uw));
                  }),
                ).pipe(Effect.ignoreCause);
                return HttpServerResponse.empty();
              }
              const httpClient = yield* HttpClient.HttpClient;
              const method = req.method;
              if (!HttpMethod.isHttpMethod(method)) {
                return HttpServerResponse.text("Method Not Allowed", { status: 405 });
              }
              const upstreamReq = HttpClientRequest.make(method)(upstreamUrl).pipe(
                method === "GET" || method === "HEAD"
                  ? (r) => r
                  : HttpClientRequest.bodyStream(
                      req.stream,
                      req.headers["content-type"]
                        ? { contentType: req.headers["content-type"] }
                        : {},
                    ),
              );
              const res = yield* httpClient.execute(upstreamReq);
              const resHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (v !== undefined && k !== "transfer-encoding" && k !== "connection") {
                  resHeaders[k] = v;
                }
              }
              return HttpServerResponse.stream(res.stream, {
                status: res.status,
                headers: resHeaders,
              });
            }),
          ),
        ]);

        const acceptLayer = HttpRouter.serve(acceptRouter).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            NodeHttpServer.layer(() => NodeHttp.createServer(), {
              port: flags.acceptPort,
              host: "0.0.0.0",
            }),
          ),
        );
        yield* Layer.build(acceptLayer);
      }

      if (manifest.hubConnectUrl) {
        while (true) {
          syncFleetHostsFile(buildBootstrapHostsEntries(manifest));
          const dialUrl = new URL(manifest.hubConnectUrl);
          dialUrl.searchParams.set("environmentId", manifest.environmentId);
          dialUrl.searchParams.set("secret", manifest.nodeSecret);
          dialUrl.searchParams.set("role", "sandbox");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* Socket.makeWebSocket(dialUrl.toString(), {
                openTimeout: "15 seconds",
              }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
              const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
                initiator: true,
                onStream: (stream, target) => handleGuestMuxStream(stream, target, t3Origin),
              });
              activeEndpoint = endpoint;
              yield* run.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (activeEndpoint === endpoint) activeEndpoint = null;
                  }),
                ),
              );
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Console.error(`Sandbox mux tunnel closed; retrying: ${String(cause)}`),
            ),
          );
          yield* Effect.sleep("2 seconds");
        }
      } else {
        yield* Console.log(
          `Sandbox bootstrap ready (${manifest.environmentId}); awaiting Hub connection.`,
        );
        return yield* Effect.never;
      }
    }).pipe(Effect.scoped),
  ),
);

const providerHubFlag = Flag.String("hub").pipe(
  Flag.withDescription("Hub URL for attaching a remote 3-verb compute provider."),
);
const providerAccountFlag = Flag.String("account").pipe(
  Flag.withDescription("Sandbox account id this provider serves."),
);
const providerCmdFlag = Flag.String("cmd").pipe(
  Flag.withDescription("3-verb compute script/executable (spawn | pause | destroy)."),
);
const providerSecretFlag = Flag.String("secret").pipe(
  Flag.withDescription("Provider attach secret (or set T3_PROVIDER_SECRET)."),
  Flag.optional,
);

const sandboxProviderCommand = Command.make("provider", {
  hub: providerHubFlag,
  account: providerAccountFlag,
  cmd: providerCmdFlag,
  secret: providerSecretFlag,
}).pipe(
  Command.withDescription(
    "Attach a remote 3-verb sandbox provider script to a Hub without exposing public SSH/HTTP ports.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const secret =
        Option.getOrUndefined(flags.secret) ?? readSandboxBootstrapEnv().providerSecret ?? "";
      const url = new URL(flags.hub);
      if (!url.pathname.endsWith("/_fleet/provider")) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/_fleet/provider`;
      }
      url.protocol =
        url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
      url.searchParams.set("accountId", flags.account);
      if (secret.length > 0) url.searchParams.set("secret", secret);

      const providerControlHandler = (payload: unknown, envelope: { readonly method: string }) => {
        const body = (payload ?? {}) as Record<string, unknown>;
        const op = envelope.method;
        return new Promise<unknown>((resolve, reject) => {
          const child = NodeChildProcess.spawn(flags.cmd, [op], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              T3_SANDBOX_OP: op,
              ...(typeof body.sandboxId === "string" ? { T3_SANDBOX_ID: body.sandboxId } : {}),
              ...(typeof body.idempotencyKey === "string"
                ? { T3_IDEMPOTENCY_KEY: body.idempotencyKey }
                : {}),
              ...(typeof body.bootstrapUrl === "string"
                ? { T3_BOOTSTRAP_URL: body.bootstrapUrl }
                : {}),
            },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += String(d);
          });
          child.stderr.on("data", (d) => {
            stderr += String(d);
          });
          child.stdin.end(JSON.stringify(body));
          child.on("close", (code) => {
            if (code === 64 || code === 69) {
              resolve({ unsupported: true });
              return;
            }
            if (code !== 0) {
              reject(new Error(stderr.trim() || `${flags.cmd} exited with ${code}`));
              return;
            }
            try {
              resolve(stdout.trim() ? JSON.parse(stdout) : {});
            } catch {
              resolve({ machineId: stdout.trim().split("\n").at(-1) });
            }
          });
        });
      };

      const ops = [
        "check",
        "spawn",
        "inspect",
        "exec",
        "write_file",
        "host",
        "set_deadline",
        "pause",
        "resume",
        "destroy",
      ] as const;

      yield* Console.log(`Attaching sandbox provider ${flags.account} -> ${flags.cmd}`);
      while (true) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* Socket.makeWebSocket(url.toString(), {
              openTimeout: "15 seconds",
            }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
            const { run } = yield* attachMuxToEffectSocket(socket, {
              initiator: true,
              onControl: Object.fromEntries(ops.map((op) => [op, providerControlHandler] as const)),
            });
            yield* run;
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Console.error(`Provider tunnel closed; reconnecting: ${String(cause)}`),
          ),
        );
        yield* Effect.sleep("2 seconds");
      }
    }).pipe(Effect.scoped),
  ),
);

function readTokenHelperUrlFromFile(): string | undefined {
  const home = process.env.T3CODE_HOME || NodePath.join(NodeOS.homedir(), ".t3");
  const candidate = NodePath.join(home, "sandbox", "token-helper-url");
  if (!NodeFS.existsSync(candidate)) return undefined;
  const value = NodeFS.readFileSync(candidate, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

const sandboxTokenHelperCommand = Command.make("token-helper", {}).pipe(
  Command.withDescription("Git credential helper that requests fresh GitHub tokens on demand."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const tokenUrl = readSandboxBootstrapEnv().tokenUrl ?? readTokenHelperUrlFromFile();
      if (!tokenUrl) return;
      const token = yield* fetchTokenOverHttpClient(tokenUrl).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (token !== null) {
        yield* Console.log(`username=x-access-token\npassword=${token}`);
      }
    }),
  ),
);

const overlayDirFlag = Flag.String("dir").pipe(Flag.withDescription("Target project directory."));
const overlayArchiveFlag = Flag.String("archive").pipe(
  Flag.withDescription("Path to gzipped overlay archive."),
);

const formatOverlayResult = (result: { readonly branch: string; readonly commit: string }) =>
  JSON.stringify(result);

const sandboxApplyOverlayCommand = Command.make("apply-overlay", {
  dir: overlayDirFlag,
  archive: overlayArchiveFlag,
}).pipe(
  Command.withDescription("Unpack a dirty checkout overlay archive into a project folder."),
  Command.unlisted,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const archiveBytes = NodeFS.readFileSync(flags.archive);
      const [{ applyWorktreeOverlay }, ProcessRunner] = yield* Effect.all([
        Effect.promise(() => import("../sandbox/worktreeOverlay.ts")),
        Effect.promise(() => import("../processRunner.ts")),
      ]);
      const result = yield* applyWorktreeOverlay({
        targetDir: flags.dir,
        archiveBytes,
      }).pipe(Effect.provide(ProcessRunner.layer));
      yield* Console.log(formatOverlayResult(result));
    }),
  ),
);

export const sandboxCommand = Command.make("sandbox").pipe(
  Command.withDescription("Sandbox guest runtime, credential helper, and remote provider bridge."),
  Command.withSubcommands([
    sandboxBootstrapCommand,
    sandboxProviderCommand,
    sandboxTokenHelperCommand,
    sandboxApplyOverlayCommand,
  ]),
);
