/**
 * In-process guest fleet tunnel & loopback mesh client started inside sandboxed
 * T3 servers when `<baseDir>/sandbox/fleet-bootstrap.json` is present.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import type {
  FleetMuxEndpoint,
  FleetMuxStream,
  FleetStreamAck,
  FleetStreamTarget,
} from "@t3tools/shared/fleetMux";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  attachMuxToEffectSocket,
  bridgeMuxStreamToTcp,
  createLoopbackForwarder,
  serveMuxHttpToLocalOrigin,
  serveMuxWsToLocalOrigin,
  syncFleetHostsFile,
} from "./fleetMuxNode.ts";

export const FleetPeerEntrySchema = Schema.Struct({
  environmentId: Schema.String,
  meshIp: Schema.String,
  slug: Schema.String,
  ports: Schema.Array(Schema.Int),
});
export type FleetPeerEntry = typeof FleetPeerEntrySchema.Type;

export const FleetBootstrapManifestSchema = Schema.Struct({
  environmentId: Schema.String,
  sandboxId: Schema.String,
  ownerEnvironmentId: Schema.String,
  hubConnectUrl: Schema.NullOr(Schema.String),
  nodeSecret: Schema.String,
  exposedHostPorts: Schema.Array(Schema.Int),
  peers: Schema.Array(FleetPeerEntrySchema),
});
export type FleetBootstrapManifest = typeof FleetBootstrapManifestSchema.Type;

export const FleetPeersControlSchema = Schema.Struct({
  peers: Schema.Array(FleetPeerEntrySchema),
});

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(FleetBootstrapManifestSchema),
);
const decodePeersControl = Schema.decodeUnknownOption(FleetPeersControlSchema);

export class GuestFleetBootstrapError extends Schema.TaggedError<GuestFleetBootstrapError>()(
  "GuestFleetBootstrapError",
  { cause: Schema.Defect() },
) {}

function constantTimeSecretMatch(
  candidateValue: string | null | undefined,
  expected: string,
): boolean {
  if (!candidateValue || expected.length === 0) return false;
  const candidate = Buffer.from(candidateValue, "utf8");
  const target = Buffer.from(expected, "utf8");
  if (candidate.byteLength !== target.byteLength) return false;
  return NodeCrypto.timingSafeEqual(candidate, target);
}

function bearerSecret(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function hostsEntriesForManifest(manifest: FleetBootstrapManifest) {
  return [
    { ip: "127.43.0.1", host: "hub.t3.internal" },
    ...manifest.peers.map((peer) => ({
      ip: peer.meshIp,
      host: `${peer.slug}.fleet.t3.internal`,
    })),
  ];
}

export class GuestFleetRuntime extends Context.Service<
  GuestFleetRuntime,
  {
    readonly enabled: boolean;
    readonly acceptHubUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3/fleet/GuestFleetRuntime") {}

function resolveBootstrapPath(baseDir: string): string {
  return NodePath.join(baseDir, "sandbox", "fleet-bootstrap.json");
}

function resolveTokenHelperUrlPath(baseDir: string): string {
  return NodePath.join(baseDir, "sandbox", "token-helper-url");
}

export const layer = Layer.effect(
  GuestFleetRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const webSocketConstructor = yield* Socket.WebSocketConstructor;
    const manifestPath = resolveBootstrapPath(config.baseDir);

    if (!NodeFS.existsSync(manifestPath)) {
      const acceptDisabled = Effect.fn("GuestFleetRuntime.acceptHubUpgrade")(
        (_request: HttpServerRequest.HttpServerRequest) =>
          Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
      );
      return GuestFleetRuntime.of({
        enabled: false,
        acceptHubUpgrade: acceptDisabled,
      });
    }

    let manifest = yield* Effect.try({
      try: () => decodeManifest(NodeFS.readFileSync(manifestPath, "utf8")),
      catch: (cause) => new GuestFleetBootstrapError({ cause }),
    }).pipe(Effect.orDie);

    const t3Origin = `http://127.0.0.1:${config.port}`;
    let activeEndpoint: FleetMuxEndpoint | null = null;
    const endpoints = new Set<FleetMuxEndpoint>();
    let stopForwarders: (() => Promise<void>) | null = null;

    const rebuildMesh = async (nextManifest: FleetBootstrapManifest) => {
      manifest = nextManifest;
      syncFleetHostsFile(hostsEntriesForManifest(manifest));
      if (stopForwarders !== null) {
        await stopForwarders();
        stopForwarders = null;
      }
      const closers: Array<() => Promise<void>> = [];
      for (const port of manifest.exposedHostPorts) {
        try {
          const fwd = await createLoopbackForwarder({
            bindHost: "127.43.0.1",
            listenPort: port,
            targetHost: "127.0.0.1",
            targetPort: port,
            getEndpoint: () => activeEndpoint,
          });
          closers.push(fwd.close);
        } catch {
          // Skip ports whose loopback bind fails on macOS or when already bound.
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
              getEndpoint: () => activeEndpoint,
            });
            closers.push(fwd.close);
          } catch {
            // Skip peer forwarders on hosts without 127.43.x.y loopback support.
          }
        }
      }
      stopForwarders = async () => {
        for (const close of closers) {
          await close();
        }
      };
    };

    yield* Effect.promise(() => rebuildMesh(manifest));
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (stopForwarders !== null) {
          await stopForwarders();
          stopForwarders = null;
        }
        for (const endpoint of endpoints) {
          endpoint.close(1001, "guest shutting down");
        }
        endpoints.clear();
      }),
    );

    const tokenHelper = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<{ readonly server: NodeHttp.Server; readonly url: string }>((resolve) => {
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
              const addr = server.address() as { port: number };
              const url = `http://127.0.0.1:${addr.port}/github-token`;
              const helperFile = resolveTokenHelperUrlPath(config.baseDir);
              NodeFS.mkdirSync(NodePath.dirname(helperFile), { recursive: true });
              NodeFS.writeFileSync(helperFile, `${url}\n`, { mode: 0o600 });
              resolve({ server, url });
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
    void tokenHelper;

    const handleStream = (
      stream: FleetMuxStream,
      target: FleetStreamTarget,
    ): Promise<FleetStreamAck> | FleetStreamAck => {
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
    };

    const handleControl = {
      "fleet.peers": async (payload: unknown) => {
        const parsed = decodePeersControl(payload);
        if (parsed._tag === "None") return { ok: false };
        await rebuildMesh({
          ...manifest,
          peers: parsed.value.peers,
        });
        return { ok: true };
      },
    } as const;

    const runEndpoint = Effect.fn("GuestFleetRuntime.runEndpoint")(function* (
      socket: Socket.Socket,
      initiator: boolean,
    ) {
      const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
        initiator,
        onStream: handleStream,
        onControl: handleControl,
      });
      endpoints.add(endpoint);
      activeEndpoint = endpoint;
      yield* run.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            endpoints.delete(endpoint);
            if (activeEndpoint === endpoint) {
              activeEndpoint = endpoints.values().next().value ?? null;
            }
          }),
        ),
      );
    });

    if (manifest.hubConnectUrl) {
      const hubConnectUrl = manifest.hubConnectUrl;
      yield* Effect.gen(function* () {
        while (true) {
          const dialUrl = new URL(hubConnectUrl);
          dialUrl.searchParams.set("environmentId", manifest.environmentId);
          dialUrl.searchParams.set("secret", manifest.nodeSecret);
          dialUrl.searchParams.set("role", "sandbox");
          yield* Effect.scoped(
            Socket.makeWebSocket(dialUrl.toString(), {
              openTimeout: "15 seconds",
            }).pipe(
              Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
              Effect.flatMap((socket) => runEndpoint(socket, true)),
            ),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("Guest fleet mux connection closed; retrying").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
              ),
            ),
          );
          yield* Effect.sleep("2 seconds");
        }
      }).pipe(Effect.forkScoped);
    }

    const acceptHubUpgrade: GuestFleetRuntime["Service"]["acceptHubUpgrade"] = Effect.fn(
      "GuestFleetRuntime.acceptHubUpgrade",
    )(function* (request) {
      const parsedUrl = requestUrl(request);
      const querySecret =
        parsedUrl._tag === "Some" ? parsedUrl.value.searchParams.get("secret") : null;
      const headerSecret = bearerSecret(request.headers.authorization);
      if (
        !constantTimeSecretMatch(headerSecret, manifest.nodeSecret) &&
        !constantTimeSecretMatch(querySecret, manifest.nodeSecret)
      ) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      if (request.headers.upgrade?.toLowerCase() !== "websocket") {
        return HttpServerResponse.text("Upgrade Required", { status: 426 });
      }
      const socket = yield* request.upgrade.pipe(Effect.orDie);
      yield* runEndpoint(socket, false).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    });

    return GuestFleetRuntime.of({
      enabled: true,
      acceptHubUpgrade,
    });
  }),
);
