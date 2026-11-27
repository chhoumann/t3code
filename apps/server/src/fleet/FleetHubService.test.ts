// @effect-diagnostics nodeBuiltinImport:off - FleetHubService integration test uses ephemeral HTTP/WS and TCP servers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  DiscoveredLocalServerList,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  ProjectCloneListEvent,
  ProviderDriverKind,
  SandboxId,
  ScheduledTaskListResult,
  ServerConfigStreamEvent,
  WorkflowCounts,
  WorkflowRunsUpdate,
  WS_METHODS,
  type SandboxView,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SandboxAccounts from "../sandbox/SandboxAccounts.ts";
import * as AttachedProviderRegistry from "./AttachedProviderRegistry.ts";
import * as FleetHubHttp from "./FleetHubHttp.ts";
import * as FleetHubService from "./FleetHubService.ts";
import {
  attachMuxToEffectSocket,
  createMuxWsFrameParser,
  encodeMuxWsFrame,
  WS_MUX_KIND_CLOSE,
  WS_MUX_KIND_TEXT,
} from "./fleetMuxNode.ts";
import { GuestFleetRuntime } from "./GuestFleetRuntime.ts";

const decodeWireDescriptor = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ExecutionEnvironmentDescriptor)),
);
const decodeWireShellHttp = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellHttpSnapshot)),
);
const decodeWireBoundedSnapshot = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeWireDetailSnapshot = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);
const decodeWireServerConfigEvent = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ServerConfigStreamEvent)),
);
const decodeWireShellStreamItem = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellStreamItem)),
);
const decodeWireThreadProjection = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadProjection)),
);
const decodeWireThreadStreamItem = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadStreamItem)),
);
const decodeWireLocalServers = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(DiscoveredLocalServerList)),
);
const decodeWireScheduledTasks = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ScheduledTaskListResult)),
);
const decodeWireWorkflowRuns = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(WorkflowRunsUpdate)),
);
const decodeWireWorkflowCounts = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(WorkflowCounts)),
);
const decodeWireProjectClones = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ProjectCloneListEvent)),
);

interface DpopKeyPair {
  readonly publicJwk: {
    readonly kty: "EC";
    readonly crv: "P-256";
    readonly x: string;
    readonly y: string;
  };
  readonly privateKey: NodeCrypto.KeyObject;
}

function generateDpopKeyPair(): DpopKeyPair {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = publicKey.export({ format: "jwk" }) as {
    readonly kty: "EC";
    readonly crv: "P-256";
    readonly x: string;
    readonly y: string;
  };
  return {
    publicJwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
    privateKey,
  };
}

function createSignedDpopProof(input: {
  readonly keyPair: DpopKeyPair;
  readonly method: string;
  readonly url: string;
  readonly nowMs: number;
  readonly accessToken?: string;
}): string {
  const headerJson = JSON.stringify({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: input.keyPair.publicJwk,
  });
  const payloadObj: Record<string, unknown> = {
    htm: input.method.toUpperCase(),
    htu: input.url,
    jti: NodeCrypto.randomUUID(),
    iat: Math.floor(input.nowMs / 1_000),
  };
  if (input.accessToken !== undefined) {
    payloadObj.ath = NodeCrypto.createHash("sha256")
      .update(input.accessToken, "utf8")
      .digest()
      .toString("base64url");
  }
  const signingInput = `${Buffer.from(headerJson, "utf8").toString("base64url")}.${Buffer.from(
    JSON.stringify(payloadObj),
    "utf8",
  ).toString("base64url")}`;
  const sig = NodeCrypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: input.keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

async function fetchJsonOrText(
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      url,
      {
        method: init?.method ?? "GET",
        headers: init?.headers,
      },
      (res) => {
        const chunks: Array<Buffer> = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on("error", reject);
    if (init?.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

async function exchangeGrantToken(input: {
  readonly hubBaseUrl: string;
  readonly environmentId: string;
  readonly pairingCredential: string;
  readonly nowMs?: number;
  readonly dpopKey?: DpopKeyPair;
}): Promise<{ readonly accessToken: string; readonly tokenType: string }> {
  const tokenUrl = `${input.hubBaseUrl}/_env/${input.environmentId}/oauth/token`;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (input.dpopKey !== undefined) {
    headers.dpop = createSignedDpopProof({
      keyPair: input.dpopKey,
      method: "POST",
      url: tokenUrl,
      nowMs: input.nowMs ?? 0,
    });
  }
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: input.pairingCredential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
  }).toString();
  const res = await fetchJsonOrText(tokenUrl, { method: "POST", headers, body });
  if (res.status !== 200) {
    throw new Error(`oauth/token failed (${res.status}): ${res.text}`);
  }
  const parsed = res.json as { readonly access_token: string; readonly token_type: string };
  return { accessToken: parsed.access_token, tokenType: parsed.token_type };
}

interface WsClientHandle {
  readonly sendJson: (payload: unknown) => void;
  readonly nextMatching: (
    predicate: (msg: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
  readonly closed: Promise<{ readonly code: number; readonly elapsedMs?: number }>;
  readonly close: () => void;
}

function connectClientWebSocket(url: string): Promise<WsClientHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffered: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      readonly predicate: (msg: Record<string, unknown>) => boolean;
      readonly resolve: (msg: Record<string, unknown>) => void;
    }> = [];

    let resolveClosed: (info: { readonly code: number }) => void = () => {};
    const closed = new Promise<{ readonly code: number }>((res) => {
      resolveClosed = res;
    });

    ws.addEventListener("open", () => {
      resolve({
        sendJson: (payload) => {
          ws.send(JSON.stringify(payload));
        },
        nextMatching: (predicate) => {
          const existingIdx = buffered.findIndex(predicate);
          if (existingIdx >= 0) {
            const [hit] = buffered.splice(existingIdx, 1);
            return Promise.resolve(hit!);
          }
          return new Promise((res) => {
            waiters.push({ predicate, resolve: res });
          });
        },
        closed,
        close: () => ws.close(),
      });
    });

    ws.addEventListener("error", (event) => {
      reject(new Error(`WebSocket connection error: ${String(event)}`));
    });

    ws.addEventListener("close", (event) => {
      resolveClosed({ code: event.code });
    });

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const messages = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : [parsed as Record<string, unknown>];
      for (const msg of messages) {
        const waiterIdx = waiters.findIndex((w) => w.predicate(msg));
        if (waiterIdx >= 0) {
          const [waiter] = waiters.splice(waiterIdx, 1);
          waiter!.resolve(msg);
        } else {
          buffered.push(msg);
        }
      }
    });
  });
}

async function startTcpEchoServer(): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  const server = NodeNet.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as NodeNet.AddressInfo;
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function allocateClosedEphemeralPort(): Promise<number> {
  const probe = NodeNet.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (probe.address() as NodeNet.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function encodeMuxHttpResponse(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}): ReadonlyArray<Uint8Array> {
  const headBytes = textEncoder.encode(
    JSON.stringify({ status: input.status, headers: input.headers }),
  );
  const frame = new Uint8Array(4 + headBytes.byteLength);
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(
    0,
    headBytes.byteLength,
    false,
  );
  frame.set(headBytes, 4);
  const bodyBytes = textEncoder.encode(JSON.stringify(input.body));
  return [frame, bodyBytes];
}

function startHarness() {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const secrets = new Map<string, Uint8Array>();
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    });

    const nodeServer = NodeHttp.createServer();
    const baseDeps = Layer.mergeAll(
      Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
      EffectNodeCrypto.layer,
      NodeSocket.layerWebSocketConstructor,
      AttachedProviderRegistry.layer,
      SandboxAccounts.layerStatic([]),
      Layer.succeed(GuestFleetRuntime, {
        enabled: false,
        acceptHubUpgrade: () =>
          Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
      }),
    );

    const hubLayer = FleetHubService.layer.pipe(Layer.provideMerge(baseDeps));
    const httpServerLayer = HttpRouter.serve(FleetHubHttp.routeLayer).pipe(
      Layer.provide(hubLayer),
      Layer.provide(baseDeps),
      Layer.provide(NodeHttpServer.layer(() => nodeServer, { port: 0, host: "127.0.0.1" })),
    );

    const context = yield* Layer.buildWithScope(Layer.mergeAll(hubLayer, httpServerLayer), scope);
    const fleetHub = yield* FleetHubService.FleetHubService.pipe(Effect.provide(context));
    const address = nodeServer.address() as NodeNet.AddressInfo;
    fleetHub.setHubPort(address.port);

    return {
      scope,
      context,
      fleetHub,
      port: address.port,
      hubBaseUrl: `http://127.0.0.1:${address.port}`,
    };
  });
}

describe("FleetHubService", () => {
  it.live(
    "serves cached descriptor, shellSnapshot, and threadProjection with zero wakeSandbox calls",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        let wakeCalls = 0;
        const envId = EnvironmentId.make("env-cached-reads");

        yield* Effect.gen(function* () {
          harness.fleetHub.registerSandboxCallbacks({
            wakeSandbox: () => Effect.sync(() => void (wakeCalls += 1)),
            pauseSandbox: () => Effect.void,
            getGuestAdminToken: () => Effect.succeed(null),
            listSandboxes: () => Effect.succeed([] as ReadonlyArray<SandboxView>),
          });

          yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId: SandboxId.make("sbx-cached"),
            title: "Seeded Sandbox Thread",
            serverVersion: "0.0.0-test",
            projectId: "proj-1",
            projectTitle: "Hello-World",
            projectPath: "/home/user/projects/Hello-World",
            threadId: "thread-seed-1",
            messageId: "msg-seed-1",
            message: "Fix the failing spec",
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [],
          });

          const pairing = yield* harness.fleetHub.issuePairingCredential(envId, [
            "orchestration:read",
            "orchestration:operate",
          ]);

          const tokenRes = yield* Effect.promise(() =>
            exchangeGrantToken({
              hubBaseUrl: harness.hubBaseUrl,
              environmentId: envId,
              pairingCredential: pairing,
            }),
          );

          const descRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/.well-known/t3/environment`),
          );
          assert.strictEqual(descRes.status, 200);
          const desc = descRes.json as { readonly environmentId: string; readonly label: string };
          assert.strictEqual(desc.environmentId, envId);
          assert.strictEqual(desc.label, "Seeded Sandbox Thread");

          const ticketRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/api/auth/websocket-ticket/rpc`, {
              method: "POST",
              headers: { authorization: `Bearer ${tokenRes.accessToken}` },
            }),
          );
          assert.strictEqual(ticketRes.status, 200);
          const { ticket } = ticketRes.json as { readonly ticket: string };

          const ws = yield* Effect.promise(() =>
            connectClientWebSocket(
              `ws://127.0.0.1:${harness.port}/_env/${envId}/ws?wsTicket=${encodeURIComponent(ticket)}`,
            ),
          );

          ws.sendJson({
            _tag: "Request",
            id: 1,
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
            payload: {},
            headers: [],
          });
          const shellChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 1),
          );
          const shellValues = shellChunk.values as ReadonlyArray<{
            readonly kind: string;
            readonly snapshot?: {
              readonly threads: ReadonlyArray<{ readonly id: string; readonly title: string }>;
            };
          }>;
          assert.strictEqual(shellValues[0]?.kind, "snapshot");
          assert.strictEqual(shellValues[0]?.snapshot?.threads[0]?.id, "thread-seed-1");
          assert.strictEqual(shellValues[0]?.snapshot?.threads[0]?.title, "Seeded Sandbox Thread");

          ws.sendJson({
            _tag: "Request",
            id: 2,
            tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            payload: { threadId: "thread-seed-1" },
            headers: [],
          });
          const projExit = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Exit" && m.requestId === 2),
          );
          const projValue = projExit.exit as {
            readonly _tag: string;
            readonly value: { readonly messages: ReadonlyArray<{ readonly text: string }> };
          };
          assert.strictEqual(projValue._tag, "Success");
          assert.strictEqual(projValue.value.messages[0]?.text, "Fix the failing spec");

          ws.sendJson({
            _tag: "Request",
            id: 3,
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
            payload: { threadId: "thread-seed-1" },
            headers: [],
          });
          const threadChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 3),
          );
          const threadValues = threadChunk.values as ReadonlyArray<{ readonly kind: string }>;
          assert.strictEqual(threadValues[0]?.kind, "snapshot");
          assert.strictEqual(wakeCalls, 0);

          ws.close();
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "enforces DPoP binding, terminates open WS immediately on revokeSession, and returns 404 after revokeNode",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const envId = EnvironmentId.make("env-auth-revoke");
        const keyPair = generateDpopKeyPair();

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId: SandboxId.make("sbx-auth"),
            title: "Auth Sandbox",
            serverVersion: "0.0.0-test",
            projectId: "proj-auth",
            projectTitle: "AuthRepo",
            projectPath: "/home/user/projects/AuthRepo",
            threadId: "thread-auth-1",
            messageId: "msg-auth-1",
            message: "Check auth",
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [],
          });

          const pairing = yield* harness.fleetHub.issuePairingCredential(envId, [
            "orchestration:read",
            "orchestration:operate",
          ]);
          const nowMs = yield* Clock.currentTimeMillis;
          const { accessToken, tokenType } = yield* Effect.promise(() =>
            exchangeGrantToken({
              hubBaseUrl: harness.hubBaseUrl,
              environmentId: envId,
              pairingCredential: pairing,
              nowMs,
              dpopKey: keyPair,
            }),
          );
          assert.strictEqual(tokenType, "DPoP");

          const ticketUrl = `${harness.hubBaseUrl}/_env/${envId}/api/auth/websocket-ticket/rpc`;
          // DPoP-bound tokens must reject plain Bearer presentation.
          const bearerRejected = yield* Effect.promise(() =>
            fetchJsonOrText(ticketUrl, {
              method: "POST",
              headers: { authorization: `Bearer ${accessToken}` },
            }),
          );
          assert.strictEqual(bearerRejected.status, 401);

          // Also prove Bearer session token renewal fails without DPoP proof.
          const wrongRefresh = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                subject_token: accessToken,
                subject_token_type: AuthAccessTokenType,
              }).toString(),
            }),
          );
          assert.strictEqual(wrongRefresh.status, 401);

          const ticketRes = yield* Effect.promise(() =>
            fetchJsonOrText(ticketUrl, {
              method: "POST",
              headers: {
                authorization: `DPoP ${accessToken}`,
                dpop: createSignedDpopProof({
                  keyPair,
                  method: "POST",
                  url: ticketUrl,
                  nowMs,
                  accessToken,
                }),
              },
            }),
          );
          assert.strictEqual(ticketRes.status, 200);
          const { ticket } = ticketRes.json as { readonly ticket: string };

          const wsHttpUrl = `${harness.hubBaseUrl}/_env/${envId}/ws`;
          const wsProof = createSignedDpopProof({
            keyPair,
            method: "GET",
            url: wsHttpUrl,
            nowMs,
            accessToken: ticket,
          });
          const ws = yield* Effect.promise(() =>
            connectClientWebSocket(
              `ws://127.0.0.1:${harness.port}/_env/${envId}/ws?wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(wsProof)}`,
            ),
          );

          const sessionRows = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM sandbox_fleet_sessions WHERE environment_id = ${envId}
          `;
          const sessionId = sessionRows[0]?.session_id ?? "";
          assert.isTrue(sessionId.length > 0);

          const revoked = yield* harness.fleetHub.revokeSession(envId, sessionId);
          assert.isTrue(revoked);
          yield* Effect.promise(() => ws.closed);

          const postRevokeTicket = yield* Effect.promise(() =>
            fetchJsonOrText(ticketUrl, {
              method: "POST",
              headers: {
                authorization: `DPoP ${accessToken}`,
                dpop: createSignedDpopProof({
                  keyPair,
                  method: "POST",
                  url: ticketUrl,
                  nowMs,
                  accessToken,
                }),
              },
            }),
          );
          assert.strictEqual(postRevokeTicket.status, 401);

          yield* harness.fleetHub.revokeNode(envId);
          const postNodeRevoke = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/.well-known/t3/environment`),
          );
          assert.strictEqual(postNodeRevoke.status, 404);
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "parks client WS, deduplicates queued inbox writes with single wakeSandbox, drains inbox, and splices live guest stream without dropping WS",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const envId = EnvironmentId.make("env-park-splice");
        let wakeCalls = 0;
        const guestDeliveredCommands: Array<{
          readonly method: string;
          readonly commandId: string;
        }> = [];

        yield* Effect.gen(function* () {
          harness.fleetHub.registerSandboxCallbacks({
            wakeSandbox: () => Effect.sync(() => void (wakeCalls += 1)),
            pauseSandbox: () => Effect.void,
            getGuestAdminToken: () => Effect.succeed("guest-admin-tok"),
            listSandboxes: () => Effect.succeed([] as ReadonlyArray<SandboxView>),
          });

          const { nodeSecret } = yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId: SandboxId.make("sbx-splice"),
            title: "Original Title",
            serverVersion: "0.0.0-test",
            projectId: "proj-splice",
            projectTitle: "SpliceRepo",
            projectPath: "/home/user/projects/SpliceRepo",
            threadId: "thread-splice-1",
            messageId: "msg-splice-1",
            message: "Initial message",
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [],
          });

          const pairing = yield* harness.fleetHub.issuePairingCredential(envId, [
            "orchestration:read",
            "orchestration:operate",
          ]);
          const { accessToken } = yield* Effect.promise(() =>
            exchangeGrantToken({
              hubBaseUrl: harness.hubBaseUrl,
              environmentId: envId,
              pairingCredential: pairing,
            }),
          );
          const ticketRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/api/auth/websocket-ticket/rpc`, {
              method: "POST",
              headers: { authorization: `Bearer ${accessToken}` },
            }),
          );
          const { ticket } = ticketRes.json as { readonly ticket: string };

          const clientWs = yield* Effect.promise(() =>
            connectClientWebSocket(
              `ws://127.0.0.1:${harness.port}/_env/${envId}/ws?wsTicket=${encodeURIComponent(ticket)}`,
            ),
          );

          // 1. Open parked subscription before guest exists.
          clientWs.sendJson({
            _tag: "Request",
            id: 101,
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
            payload: {},
            headers: [],
          });
          yield* Effect.promise(() =>
            clientWs.nextMatching((m) => m._tag === "Chunk" && m.requestId === 101),
          );

          // 2. Dispatch same commandId twice while offline.
          const commandPayload = {
            type: "thread.turn.start",
            commandId: "cmd-parked-dedup-1",
            threadId: "thread-splice-1",
            message: {
              messageId: "msg-queued-1",
              text: "Queued follow-up",
              attachments: [],
            },
          };
          clientWs.sendJson({
            _tag: "Request",
            id: 102,
            tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
            payload: commandPayload,
            headers: [],
          });
          clientWs.sendJson({
            _tag: "Request",
            id: 103,
            tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
            payload: commandPayload,
            headers: [],
          });

          const [exit1, exit2, optimisticShellChunk] = yield* Effect.promise(() =>
            Promise.all([
              clientWs.nextMatching((m) => m._tag === "Exit" && m.requestId === 102),
              clientWs.nextMatching((m) => m._tag === "Exit" && m.requestId === 103),
              clientWs.nextMatching(
                (m) =>
                  m._tag === "Chunk" &&
                  m.requestId === 101 &&
                  Array.isArray(m.values) &&
                  (m.values as Array<{ readonly kind?: string }>)[0]?.kind === "thread.updated",
              ),
            ]),
          );
          assert.strictEqual((exit1.exit as { readonly _tag: string })._tag, "Success");
          assert.strictEqual((exit2.exit as { readonly _tag: string })._tag, "Success");
          const optimisticThread = (
            optimisticShellChunk.values as Array<{
              readonly thread: { readonly latestVisibleMessage?: { readonly text: string } };
            }>
          )[0]?.thread;
          assert.strictEqual(optimisticThread?.latestVisibleMessage?.text, "Queued follow-up");
          assert.strictEqual(wakeCalls, 1);
          assert.strictEqual(yield* harness.fleetHub.listCachedPendingInboxCount(envId), 1);

          // 3. Connect simulated guest mux tunnel and handle both drained inbox RPC and spliced stream.
          const guestScope = yield* Scope.make();
          const guestWsUrl = `ws://127.0.0.1:${harness.port}/_fleet/connect?environmentId=${encodeURIComponent(
            envId,
          )}&secret=${encodeURIComponent(nodeSecret)}&role=sandbox`;
          const guestSocket = yield* Socket.makeWebSocket(guestWsUrl, {
            openTimeout: "5 seconds",
          }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
          const { run } = yield* attachMuxToEffectSocket(guestSocket, {
            initiator: true,
            onStream: (stream, target) => {
              if (target.kind === "http") {
                for (const chunk of encodeMuxHttpResponse({
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: { environmentId: envId },
                })) {
                  void stream.write(chunk);
                }
                void stream.close();
                return { ok: true };
              }
              if (target.kind === "ws") {
                const parser = createMuxWsFrameParser((kind, bytes) => {
                  if (kind === WS_MUX_KIND_CLOSE) {
                    void stream.close();
                    return;
                  }
                  const parsed = JSON.parse(textDecoder.decode(bytes)) as Record<string, unknown>;
                  if (parsed._tag !== "Request") return;
                  const tag = String(parsed.tag ?? "");
                  if (tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
                    const p = parsed.payload as { readonly commandId: string };
                    guestDeliveredCommands.push({ method: tag, commandId: p.commandId });
                    const reply = JSON.stringify({
                      _tag: "Exit",
                      requestId: parsed.id,
                      exit: { _tag: "Success", value: { sequence: 99 } },
                    });
                    void stream.write(
                      encodeMuxWsFrame(WS_MUX_KIND_TEXT, textEncoder.encode(reply)),
                    );
                  } else if (
                    tag === ORCHESTRATION_V2_WS_METHODS.subscribeShell &&
                    parsed.id === 101
                  ) {
                    const liveChunk = JSON.stringify({
                      _tag: "Chunk",
                      requestId: 101,
                      values: [
                        {
                          kind: "snapshot",
                          snapshot: {
                            schemaVersion: 1,
                            snapshotSequence: 55,
                            projects: [],
                            archivedThreads: [],
                            threads: [
                              {
                                id: "thread-splice-1",
                                projectId: "proj-splice",
                                title: "Live Guest Authoritative Title",
                                updatedAt: "2026-11-27T12:00:00.000Z",
                              },
                            ],
                          },
                        },
                        { kind: "synchronized" },
                      ],
                    });
                    void stream.write(
                      encodeMuxWsFrame(WS_MUX_KIND_TEXT, textEncoder.encode(liveChunk)),
                    );
                  }
                });
                stream.setConsumer({
                  onData: parser,
                  onClose: () => {},
                  onReset: () => {},
                });
                return { ok: true };
              }
              return { ok: false, error: "unsupported" };
            },
          });
          const guestFiber = yield* run.pipe(Effect.forkIn(guestScope));

          // 4. Verify the SAME clientWs receives the spliced live guest snapshot without disconnecting!
          const liveSplicedChunk = yield* Effect.promise(() =>
            clientWs.nextMatching(
              (m) =>
                m._tag === "Chunk" &&
                m.requestId === 101 &&
                Array.isArray(m.values) &&
                (
                  m.values as Array<{
                    readonly kind?: string;
                    readonly snapshot?: { readonly snapshotSequence?: number };
                  }>
                )[0]?.snapshot?.snapshotSequence === 55,
            ),
          );
          const splicedSnap = (
            liveSplicedChunk.values as Array<{
              readonly snapshot: { readonly threads: ReadonlyArray<{ readonly title: string }> };
            }>
          )[0]?.snapshot;
          assert.strictEqual(splicedSnap?.threads[0]?.title, "Live Guest Authoritative Title");
          assert.deepStrictEqual(guestDeliveredCommands, [
            {
              method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
              commandId: "cmd-parked-dedup-1",
            },
          ]);
          assert.strictEqual(yield* harness.fleetHub.listCachedPendingInboxCount(envId), 0);

          clientWs.close();
          yield* Fiber.interrupt(guestFiber);
          yield* Scope.close(guestScope, Exit.void);
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "allows exposed host ports and refuses unexposed host ports over guest mux TCP streams",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const echoServer = yield* Effect.promise(() => startTcpEchoServer());
        const closedPort = yield* Effect.promise(() => allocateClosedEphemeralPort());
        const envId = EnvironmentId.make("env-exposed-ports");

        yield* Effect.gen(function* () {
          const { nodeSecret } = yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId: SandboxId.make("sbx-ports"),
            title: "Exposed Ports",
            serverVersion: "0.0.0-test",
            projectId: "proj-ports",
            projectTitle: "PortsRepo",
            projectPath: "/home/user/projects/PortsRepo",
            threadId: "thread-ports-1",
            messageId: "msg-ports-1",
            message: "Check ports",
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [echoServer.port],
          });

          const guestScope = yield* Scope.make();
          const guestWsUrl = `ws://127.0.0.1:${harness.port}/_fleet/connect?environmentId=${encodeURIComponent(
            envId,
          )}&secret=${encodeURIComponent(nodeSecret)}&role=sandbox`;
          const guestSocket = yield* Socket.makeWebSocket(guestWsUrl, {
            openTimeout: "5 seconds",
          }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
          const { endpoint, run } = yield* attachMuxToEffectSocket(guestSocket, {
            initiator: true,
          });
          const guestFiber = yield* run.pipe(Effect.forkIn(guestScope));
          yield* Effect.promise(() => endpoint.requestControl("fleet.peers", {}));

          // Disallowed host port must be refused cleanly by the Hub allowlist.
          const refusedResult = yield* Effect.tryPromise({
            try: () =>
              endpoint.openStream({
                kind: "tcp",
                host: "127.0.0.1",
                port: closedPort,
              }),
            catch: (err) => new FleetHubService.FleetHubError({ message: String(err), cause: err }),
          }).pipe(Effect.flip);
          assert.isTrue(String(refusedResult).includes("not exposed"));

          // Exposed host port succeeds and bridges TCP bytes.
          const opened = yield* Effect.promise(() =>
            endpoint.openStream({
              kind: "tcp",
              host: "127.0.0.1",
              port: echoServer.port,
            }),
          );
          const echoed = yield* Effect.promise(
            () =>
              new Promise<string>((resolve) => {
                let acc = "";
                opened.stream.setConsumer({
                  onData: (chunk) => {
                    acc += textDecoder.decode(chunk);
                    if (acc === "echo:ping") {
                      void opened.stream.close();
                      resolve(acc);
                    }
                  },
                  onClose: () => resolve(acc),
                  onReset: () => resolve(acc),
                });
                void opened.stream.write(textEncoder.encode("ping"));
              }),
          );
          assert.strictEqual(echoed, "echo:ping");

          yield* Fiber.interrupt(guestFiber);
          yield* Scope.close(guestScope, Exit.void);
        }).pipe(Effect.provide(harness.context));

        yield* Effect.promise(() => echoServer.close());
        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "forwards runner_passthrough HTTP and WebSocket directly over FleetMux without Hub session enforcement",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const runnerEnvId = EnvironmentId.make("env-runner-passthrough");
        const runnerSecret = "runner-secret-value";

        yield* Effect.gen(function* () {
          const runnerScope = yield* Scope.make();
          const runnerWsUrl = `ws://127.0.0.1:${harness.port}/_fleet/connect?environmentId=${encodeURIComponent(
            runnerEnvId,
          )}&secret=${encodeURIComponent(runnerSecret)}&role=runner&label=BuildRunner`;
          const runnerSocket = yield* Socket.makeWebSocket(runnerWsUrl, {
            openTimeout: "5 seconds",
          }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));

          const { endpoint: runnerEndpoint, run } = yield* attachMuxToEffectSocket(runnerSocket, {
            initiator: true,
            onStream: (stream, target) => {
              if (target.kind === "http") {
                for (const chunk of encodeMuxHttpResponse({
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: { runnerPath: target.path },
                })) {
                  void stream.write(chunk);
                }
                void stream.close();
                return { ok: true };
              }
              if (target.kind === "ws") {
                const parser = createMuxWsFrameParser((kind, bytes) => {
                  if (kind === WS_MUX_KIND_CLOSE) {
                    void stream.close();
                    return;
                  }
                  const msg = JSON.parse(textDecoder.decode(bytes)) as unknown;
                  void stream.write(
                    encodeMuxWsFrame(
                      WS_MUX_KIND_TEXT,
                      textEncoder.encode(JSON.stringify({ echoed: msg })),
                    ),
                  );
                });
                stream.setConsumer({
                  onData: parser,
                  onClose: () => {},
                  onReset: () => {},
                });
                return { ok: true };
              }
              return { ok: false, error: "unsupported" };
            },
          });
          const runnerFiber = yield* run.pipe(Effect.forkIn(runnerScope));
          yield* Effect.promise(() => runnerEndpoint.requestControl("fleet.peers", {}));

          // No Hub Authorization header: runner_passthrough must forward straight to runner!
          const httpRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${runnerEnvId}/api/ping?x=1`),
          );
          assert.strictEqual(httpRes.status, 200);
          assert.deepStrictEqual(httpRes.json, { runnerPath: "/api/ping?x=1" });

          const clientWs = yield* Effect.promise(() =>
            connectClientWebSocket(`ws://127.0.0.1:${harness.port}/_env/${runnerEnvId}/ws`),
          );
          clientWs.sendJson({ hello: "runner" });
          const echoed = yield* Effect.promise(() =>
            clientWs.nextMatching(
              (m) => (m.echoed as { readonly hello?: string } | undefined)?.hello === "runner",
            ),
          );
          assert.deepStrictEqual(echoed, { echoed: { hello: "runner" } });
          clientWs.close();

          yield* Fiber.interrupt(runnerFiber);
          yield* Scope.close(runnerScope, Exit.void);
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "forwards MCP and OAuth routes with x-t3-forwarded-prefix and intact Authorization while waking sleeping sandboxes",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const envId = EnvironmentId.make("env-mcp-pass");
        const sandboxId = SandboxId.make("sbx-mcp-pass");
        const captured: Array<{
          readonly path: string;
          readonly auth: unknown;
          readonly prefix: unknown;
        }> = [];
        let wakes = 0;

        yield* Effect.gen(function* () {
          const guestScope = yield* Scope.make();
          harness.fleetHub.registerSandboxCallbacks({
            wakeSandbox: () =>
              Effect.sync(() => {
                wakes += 1;
              }),
            pauseSandbox: () => Effect.void,
            getGuestAdminToken: () => Effect.succeed("internal-admin-token"),
            listSandboxes: () => Effect.succeed([] as ReadonlyArray<SandboxView>),
          });

          const { nodeSecret } = yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId,
            title: "MCP Sandbox",
            serverVersion: "0.0.0-test",
            projectId: "proj-mcp",
            projectTitle: "App",
            projectPath: "/home/user/projects/App",
            threadId: "thread-mcp",
            messageId: "msg-mcp",
            message: "seed",
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [],
            skipSeedThread: true,
          });

          // Simulate sandbox waking on demand right after wakeSandbox fires by attaching guest mux.
          harness.fleetHub.registerSandboxCallbacks({
            wakeSandbox: () =>
              Effect.gen(function* () {
                wakes += 1;
                const guestWsUrl = `ws://127.0.0.1:${harness.port}/_fleet/connect?environmentId=${encodeURIComponent(
                  envId,
                )}&secret=${encodeURIComponent(nodeSecret)}&role=sandbox`;
                const guestSocket = yield* Socket.makeWebSocket(guestWsUrl, {
                  openTimeout: "5 seconds",
                }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
                const { run } = yield* attachMuxToEffectSocket(guestSocket, {
                  initiator: true,
                  onStream: (stream, target) => {
                    if (target.kind === "http") {
                      captured.push({
                        path: target.path,
                        auth: target.headers.authorization,
                        prefix: target.headers["x-t3-forwarded-prefix"],
                      });
                      for (const chunk of encodeMuxHttpResponse({
                        status: 200,
                        headers: { "content-type": "application/json" },
                        body: { ok: true, path: target.path },
                      })) {
                        void stream.write(chunk);
                      }
                      void stream.close();
                      return { ok: true };
                    }
                    return { ok: false, error: "unsupported" };
                  },
                });
                yield* run.pipe(Effect.forkIn(guestScope));
              }).pipe(Effect.ignore),
            pauseSandbox: () => Effect.void,
            getGuestAdminToken: () => Effect.succeed("internal-admin-token"),
            listSandboxes: () => Effect.succeed([] as ReadonlyArray<SandboxView>),
          });

          const mcpRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/mcp?foo=bar`, {
              method: "POST",
              headers: {
                authorization: "Bearer mcp-oauth-token-123",
                "content-type": "application/json",
              },
              body: "{}",
            }),
          );
          assert.strictEqual(mcpRes.status, 200);
          assert.strictEqual(wakes, 1);
          assert.deepStrictEqual(
            captured.find((entry) => entry.path === "/mcp?foo=bar"),
            {
              path: "/mcp?foo=bar",
              auth: "Bearer mcp-oauth-token-123",
              prefix: `/_env/${envId}`,
            },
          );

          const oauthRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/oauth/mcp/register`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }),
          );
          assert.strictEqual(oauthRes.status, 200);
          assert.strictEqual(wakes, 1);
          assert.strictEqual(
            captured.find((entry) => entry.path === "/oauth/mcp/register")?.prefix,
            `/_env/${envId}`,
          );

          yield* Scope.close(guestScope, Exit.void);
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.live(
    "encodes parked ServerConfig and seeded projection payloads cleanly against wire contract schemas",
    () =>
      Effect.gen(function* () {
        const harness = yield* startHarness();
        const envId = EnvironmentId.make("env-contract-decode");

        yield* Effect.gen(function* () {
          harness.fleetHub.registerSandboxCallbacks({
            wakeSandbox: () => Effect.void,
            pauseSandbox: () => Effect.void,
            getGuestAdminToken: () => Effect.succeed(null),
            listSandboxes: () => Effect.succeed([] as ReadonlyArray<SandboxView>),
          });

          yield* harness.fleetHub.registerSandboxNode({
            environmentId: envId,
            sandboxId: SandboxId.make("sbx-contract"),
            title: "Contract Check",
            serverVersion: "0.0.0-test",
            projectId: "proj-contract-1",
            projectTitle: "demo-repo",
            projectPath: "/home/user/projects/demo-repo",
            threadId: "thread-contract-1",
            messageId: "msg-contract-1",
            message: "Initial contract check message",
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5",
            runtimeMode: "full-access",
            interactionMode: "default",
            exposedPorts: [],
          });

          const pairing = yield* harness.fleetHub.issuePairingCredential(envId, [
            "orchestration:read",
            "orchestration:operate",
          ]);
          const { accessToken } = yield* Effect.promise(() =>
            exchangeGrantToken({
              hubBaseUrl: harness.hubBaseUrl,
              environmentId: envId,
              pairingCredential: pairing,
            }),
          );

          const descRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/.well-known/t3/environment`),
          );
          assert.strictEqual(descRes.status, 200);
          const decodedDesc = decodeWireDescriptor(JSON.stringify(descRes.json));
          assert.strictEqual(decodedDesc.environmentId, envId);

          const shellRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/api/orchestration/shell`, {
              headers: {
                authorization: `Bearer ${accessToken}`,
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              },
            }),
          );
          assert.strictEqual(shellRes.status, 200);
          const decodedHttpShell = decodeWireShellHttp(JSON.stringify(shellRes.json));
          assert.strictEqual(decodedHttpShell.threads[0]?.id, "thread-contract-1");

          const boundedThreadRes = yield* Effect.promise(() =>
            fetchJsonOrText(
              `${harness.hubBaseUrl}/_env/${envId}/api/orchestration/threads/thread-contract-1/bounded`,
              {
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                },
              },
            ),
          );
          assert.strictEqual(boundedThreadRes.status, 200);
          const decodedBounded = decodeWireBoundedSnapshot(JSON.stringify(boundedThreadRes.json));
          assert.strictEqual(decodedBounded.projection.thread.id, "thread-contract-1");
          assert.strictEqual(decodedBounded.hasMoreHistory, false);

          const detailThreadRes = yield* Effect.promise(() =>
            fetchJsonOrText(
              `${harness.hubBaseUrl}/_env/${envId}/api/orchestration/threads/thread-contract-1`,
              {
                headers: {
                  authorization: `Bearer ${accessToken}`,
                  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                },
              },
            ),
          );
          assert.strictEqual(detailThreadRes.status, 200);
          const decodedDetail = decodeWireDetailSnapshot(JSON.stringify(detailThreadRes.json));
          assert.strictEqual(decodedDetail.projection.thread.id, "thread-contract-1");

          const ticketRes = yield* Effect.promise(() =>
            fetchJsonOrText(`${harness.hubBaseUrl}/_env/${envId}/api/auth/websocket-ticket/rpc`, {
              method: "POST",
              headers: { authorization: `Bearer ${accessToken}` },
            }),
          );
          assert.strictEqual(ticketRes.status, 200);
          const { ticket } = ticketRes.json as { readonly ticket: string };

          const ws = yield* Effect.promise(() =>
            connectClientWebSocket(
              `ws://127.0.0.1:${harness.port}/_env/${envId}/ws?wsTicket=${encodeURIComponent(ticket)}`,
            ),
          );

          ws.sendJson({
            _tag: "Request",
            id: 1,
            tag: WS_METHODS.subscribeServerConfig,
            payload: {},
            headers: [],
          });
          const configChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 1),
          );
          const configEvent = decodeWireServerConfigEvent(
            JSON.stringify((configChunk.values as ReadonlyArray<unknown>)[0]),
          );
          assert.strictEqual(configEvent.type, "snapshot");

          ws.sendJson({
            _tag: "Request",
            id: 2,
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
            payload: {},
            headers: [],
          });
          const shellChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 2),
          );
          for (const item of shellChunk.values as ReadonlyArray<unknown>) {
            decodeWireShellStreamItem(JSON.stringify(item));
          }

          ws.sendJson({
            _tag: "Request",
            id: 3,
            tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            payload: { threadId: "thread-contract-1" },
            headers: [],
          });
          const projExit = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Exit" && m.requestId === 3),
          );
          const projValue = (projExit.exit as { readonly _tag: string; readonly value: unknown })
            .value;
          const decodedProj = decodeWireThreadProjection(JSON.stringify(projValue));
          assert.strictEqual(decodedProj.thread.id, "thread-contract-1");

          ws.sendJson({
            _tag: "Request",
            id: 4,
            tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
            payload: { threadId: "thread-contract-1" },
            headers: [],
          });
          const threadChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 4),
          );
          for (const item of threadChunk.values as ReadonlyArray<unknown>) {
            decodeWireThreadStreamItem(JSON.stringify(item));
          }

          ws.sendJson({
            _tag: "Request",
            id: 5,
            tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
            payload: {
              type: "message.dispatch",
              commandId: "cmd-contract-msg-2",
              threadId: "thread-contract-1",
              messageId: "msg-contract-2",
              text: "Follow-up optimistic message",
              attachments: [],
            },
            headers: [],
          });
          const dispatchExit = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Exit" && m.requestId === 5),
          );
          assert.strictEqual((dispatchExit.exit as { readonly _tag: string })._tag, "Success");

          const shellUpdateChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 2),
          );
          for (const item of shellUpdateChunk.values as ReadonlyArray<unknown>) {
            decodeWireShellStreamItem(JSON.stringify(item));
          }

          const threadUpdateChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 4),
          );
          for (const item of threadUpdateChunk.values as ReadonlyArray<unknown>) {
            decodeWireThreadStreamItem(JSON.stringify(item));
          }

          ws.sendJson({
            _tag: "Request",
            id: 6,
            tag: WS_METHODS.subscribeDiscoveredLocalServers,
            payload: {},
            headers: [],
          });
          const localServersChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 6),
          );
          decodeWireLocalServers(
            JSON.stringify((localServersChunk.values as ReadonlyArray<unknown>)[0]),
          );

          ws.sendJson({
            _tag: "Request",
            id: 7,
            tag: WS_METHODS.scheduledTasksSubscribe,
            payload: {},
            headers: [],
          });
          const scheduledTasksChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 7),
          );
          decodeWireScheduledTasks(
            JSON.stringify((scheduledTasksChunk.values as ReadonlyArray<unknown>)[0]),
          );

          ws.sendJson({
            _tag: "Request",
            id: 8,
            tag: WS_METHODS.workflowsSubscribe,
            payload: {},
            headers: [],
          });
          const workflowsChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 8),
          );
          decodeWireWorkflowRuns(
            JSON.stringify((workflowsChunk.values as ReadonlyArray<unknown>)[0]),
          );

          ws.sendJson({
            _tag: "Request",
            id: 9,
            tag: WS_METHODS.workflowsCounts,
            payload: {},
            headers: [],
          });
          const workflowCountsChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 9),
          );
          decodeWireWorkflowCounts(
            JSON.stringify((workflowCountsChunk.values as ReadonlyArray<unknown>)[0]),
          );

          ws.sendJson({
            _tag: "Request",
            id: 10,
            tag: WS_METHODS.subscribeProjectClones,
            payload: {},
            headers: [],
          });
          const clonesChunk = yield* Effect.promise(() =>
            ws.nextMatching((m) => m._tag === "Chunk" && m.requestId === 10),
          );
          decodeWireProjectClones(
            JSON.stringify((clonesChunk.values as ReadonlyArray<unknown>)[0]),
          );

          ws.close();
        }).pipe(Effect.provide(harness.context));

        yield* Scope.close(harness.scope, Exit.void);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
