/**
 * Self-hosted Fleet Hub service: manages sandbox/runner node identities, Hub-side
 * session & DPoP authority for managed sandboxes, passthrough tunnels for self-hosted
 * runners, SQLite projection cache reads (0 VM wakeups), idempotent inbox draining,
 * Park-and-Splice WebSocket bridging, exposed host port allowlists, and Boat NAT reverse-dial.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthGrantScope,
  AuthStandardClientScopes,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  SandboxId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  defaultInstanceIdForDriver,
  ServerSettings,
  type AuthAccessTokenResult,
  type AuthEnvironmentScope,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type SandboxView,
} from "@t3tools/contracts";
import { stripVirtualEnvironmentPrefix } from "@t3tools/shared/environmentPath";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import {
  FleetMuxEndpoint,
  type FleetMuxStream,
  type FleetStreamAck,
  type FleetStreamTarget,
} from "@t3tools/shared/fleetMux";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { T3_FORWARDED_PREFIX_HEADER, requestUrl } from "../requestUrl.ts";
import { GitHubAppConnection } from "../sandbox/GitHubAppConnection.ts";
import {
  WS_MUX_KIND_CLOSE,
  WS_MUX_KIND_TEXT,
  attachMuxToEffectSocket,
  bridgeEffectSocketToMuxWs,
  bridgeMuxStreamToTcp,
  createMuxStreamDuplex,
  createMuxWsFrameParser,
  encodeMuxWsFrame,
  forwardHttpOverMux,
} from "./fleetMuxNode.ts";
import {
  applyOptimisticCommandToCache,
  buildSeededSandboxCache,
  mergeGuestShellChunkIntoCache,
  safeJsonParse,
  stringifyJson,
} from "./fleetProjectionCache.ts";

export class FleetHubError extends Schema.TaggedError<FleetHubError>()("FleetHubError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.cause ? `${super.message}` : super.message;
  }
}

export type FleetNodeKind = "sandbox" | "runner";
export type FleetAuthMode = "hub_authority" | "runner_passthrough";

export interface FleetPeerInfo {
  readonly environmentId: string;
  readonly meshIp: string;
  readonly slug: string;
  readonly ports: ReadonlyArray<number>;
}

export interface FleetNodeRecord {
  readonly environmentId: EnvironmentId;
  readonly sandboxId: SandboxId | null;
  readonly nodeKind: FleetNodeKind;
  readonly authMode: FleetAuthMode;
  readonly nodeSecretPlain: string | null;
  readonly nodeSecretHash: string;
  readonly meshIp: string;
  readonly slug: string;
  readonly exposedPorts: ReadonlyArray<number>;
  readonly descriptorJson: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
}

export interface FleetSessionRecord {
  readonly sessionId: string;
  readonly environmentId: EnvironmentId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofThumbprint: string;
  readonly method: "bearer-access-token" | "dpop-access-token" | "browser-session-cookie";
  readonly expiresAt: number;
}

export interface RegisterSandboxNodeInput {
  readonly environmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly title: string;
  readonly serverVersion: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectPath: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly message: string;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly exposedPorts: ReadonlyArray<number>;
  readonly skipSeedThread?: boolean;
}

export interface FleetSandboxCallbacks {
  readonly wakeSandbox: (sandboxId: SandboxId) => Effect.Effect<void>;
  readonly pauseSandbox: (sandboxId: SandboxId) => Effect.Effect<void>;
  readonly getGuestAdminToken: (sandboxId: SandboxId) => Effect.Effect<string | null>;
  readonly listSandboxes: () => Effect.Effect<ReadonlyArray<SandboxView>>;
}

interface WsTicketEntry {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofThumbprint: string;
  readonly method: FleetSessionRecord["method"];
  readonly expiresAt: number;
}

interface ParkedSubscription {
  readonly requestId: string | number;
  readonly tag: string;
  readonly payload: Record<string, unknown>;
  readonly headers: ReadonlyArray<[string, string]>;
}

interface LiveClientSocketHandle {
  readonly sessionId: string;
  readonly subscriptions: Map<string | number, ParkedSubscription>;
  readonly sendMessage: (encoded: unknown) => void;
  readonly notifyUpstreamChange: () => void;
  readonly closeImmediate: () => void;
}

function sha256Hex(value: string): string {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function randomBase64Url(bytes = 24): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function constantTimeHexMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.byteLength !== bufB.byteLength) return false;
  return NodeCrypto.timingSafeEqual(bufA, bufB);
}

function slugifyTitle(title: string, fallbackId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base.length > 0 ? base : `node-${fallbackId.slice(0, 8).toLowerCase()}`;
}

function meshIpForIndex(index: number): string {
  const n = index + 2;
  const third = (n >> 8) & 0xff;
  const fourth = n & 0xff;
  return `127.43.${third}.${fourth}`;
}

function encodeBootstrapCookieName(environmentId: string): string {
  return `t3_fleet_${environmentId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function isThreadArchivedOrNotFoundError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("thread") &&
    (lower.includes("not found") || lower.includes("missing") || lower.includes("not ready"))
  );
}

const ENCODED_DEFAULT_SERVER_SETTINGS: unknown = JSON.parse(
  Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(ServerSettings)))(
    DEFAULT_SERVER_SETTINGS,
  ),
);

function buildParkedServerConfig(
  descriptorJson: string | null,
  baseUrlCwd: string,
  serverTimeIso: string,
): Record<string, unknown> {
  const descriptor = (descriptorJson
    ? safeJsonParse<Record<string, unknown>>(descriptorJson)
    : null) ?? {
    environmentId: "unknown",
    label: "Sandbox",
    platform: { os: "linux", arch: "x64", machine: "cloud" },
    serverVersion: "0.0.0",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      accessTokenRenewal: true,
      shellThreadFamilies: true,
      shellOlderSettled: true,
      inlineMessageContext: true,
      freshContext: true,
      threadStop: true,
      threadForceStop: true,
    },
  };

  const envId = typeof descriptor.environmentId === "string" ? descriptor.environmentId : "unknown";
  return {
    environment: descriptor,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token", "dpop-access-token", "browser-session-cookie"],
      sessionCookieName: encodeBootstrapCookieName(envId),
    },
    cwd: baseUrlCwd,
    hostname: "sandbox",
    keybindingsConfigPath: "/home/user/.t3/userdata/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/home/user/.t3/userdata/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
      relayTracingAllowed: false,
    },
    settings: ENCODED_DEFAULT_SERVER_SETTINGS,
    shellThreadFamilies: true,
    shellOlderSettled: true,
    inlineMessageContext: true,
    serverTime: serverTimeIso,
  };
}

function parseTokenBody(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = safeJsonParse<Record<string, unknown>>(trimmed) ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

function stripAfterSequencePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!("afterSequence" in payload)) return payload;
  const { afterSequence: _, ...rest } = payload;
  return rest;
}

function toArrayHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string | Array<string>> {
  const out: Record<string, string | Array<string>> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      out[k] = Array.isArray(v) ? v.map(String) : String(v);
    }
  }
  return out;
}

function formatIsoUtc(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function encodeRpcWireObject(value: unknown): Uint8Array {
  return textEncoder.encode(stringifyJson(value));
}

export class FleetHubService extends Context.Service<
  FleetHubService,
  {
    readonly internalSecret: string;
    readonly setHubPort: (port: number) => void;
    readonly getHubPort: () => number | null;
    readonly registerSandboxCallbacks: (callbacks: FleetSandboxCallbacks) => void;
    readonly registerSandboxNode: (
      input: RegisterSandboxNodeInput,
    ) => Effect.Effect<{ readonly nodeSecret: string; readonly meshIp: string }, FleetHubError>;
    readonly registerRunnerNode: (input: {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly nodeSecret: string;
      readonly exposedPorts?: ReadonlyArray<number>;
    }) => Effect.Effect<void, FleetHubError>;
    readonly getNode: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<FleetNodeRecord | null, FleetHubError>;
    readonly buildBootstrapManifestJson: (
      environmentId: EnvironmentId,
      hubConnectUrl: string | null,
    ) => Effect.Effect<string | null, FleetHubError>;
    readonly handleBootstrapHttp: (
      request: HttpServerRequest.HttpServerRequest,
      token: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly handleConnectWs: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly handleInternalMuxRequest: (
      request: HttpServerRequest.HttpServerRequest,
      secret: string,
      environmentId: EnvironmentId,
      subPath: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly handleEnvRequest: (
      request: HttpServerRequest.HttpServerRequest,
      environmentId: EnvironmentId,
      subPath: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly attachTunnel: (
      environmentId: EnvironmentId,
      endpoint: FleetMuxEndpoint,
    ) => Effect.Effect<void>;
    readonly ensureBoatReverseTunnel: (
      environmentId: EnvironmentId,
      providerHttpUrl: string,
    ) => Effect.Effect<void>;
    readonly hasActiveTunnel: (environmentId: EnvironmentId) => boolean;
    readonly getInternalBridgeUrl: (environmentId: EnvironmentId) => string | null;
    readonly probeGuestEnvironmentId: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<EnvironmentId | null>;
    readonly notifyGuestReadyForInbox: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly issuePairingCredential: (
      environmentId: EnvironmentId,
      scopes: ReadonlyArray<AuthGrantScope>,
    ) => Effect.Effect<string, FleetHubError>;
    readonly revokeSession: (
      environmentId: EnvironmentId,
      sessionId: string,
    ) => Effect.Effect<boolean, FleetHubError>;
    readonly revokeNode: (environmentId: EnvironmentId) => Effect.Effect<void, FleetHubError>;
    readonly listPeers: () => Effect.Effect<ReadonlyArray<FleetPeerInfo>, FleetHubError>;
    readonly listCachedPendingInboxCount: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<number, FleetHubError>;
  }
>()("t3/fleet/FleetHubService") {}

const NodeRowSchema = Schema.Struct({
  environment_id: EnvironmentId,
  sandbox_id: Schema.NullOr(SandboxId),
  node_kind: Schema.Literals(["sandbox", "runner"]),
  auth_mode: Schema.Literals(["hub_authority", "runner_passthrough"]),
  node_secret_hash: Schema.String,
  node_secret_plain: Schema.NullOr(Schema.String),
  mesh_ip: Schema.String,
  slug: Schema.String,
  exposed_ports_json: Schema.String,
  descriptor_json: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  last_seen_at: Schema.NullOr(Schema.Number),
});

const decodeNodeRow = Schema.decodeUnknownEffect(NodeRowSchema);

function rowToNode(row: Schema.Schema.Type<typeof NodeRowSchema>): FleetNodeRecord {
  const ports = safeJsonParse<Array<number>>(row.exposed_ports_json) ?? [];
  return {
    environmentId: row.environment_id,
    sandboxId: row.sandbox_id,
    nodeKind: row.node_kind,
    authMode: row.auth_mode,
    nodeSecretPlain: row.node_secret_plain,
    nodeSecretHash: row.node_secret_hash,
    meshIp: row.mesh_ip,
    slug: row.slug,
    exposedPorts: ports.filter((p) => Number.isInteger(p) && p > 0 && p <= 65535),
    descriptorJson: row.descriptor_json,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maybeGithub = yield* Effect.serviceOption(GitHubAppConnection);
  const maybeWsCtor = yield* Effect.serviceOption(Socket.WebSocketConstructor);
  const serviceContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(serviceContext);
  const internalSecret = randomBase64Url(24);
  const scope = yield* Scope.Scope;

  let hubPort: number | null = null;
  let sandboxCallbacks: FleetSandboxCallbacks | null = null;

  const activeTunnels = new Map<EnvironmentId, FleetMuxEndpoint>();
  const liveClientSockets = new Map<EnvironmentId, Set<LiveClientSocketHandle>>();
  const wsTickets = new Map<string, WsTicketEntry>();
  const dpopReplayKeys = new Set<string>();
  const boatReverseDials = new Set<EnvironmentId>();
  const inboxDrainRunning = new Set<EnvironmentId>();
  const waitingTunnelWaiters = new Map<EnvironmentId, Set<() => void>>();

  const dbError = (message: string) =>
    Effect.mapError((cause: unknown) => new FleetHubError({ message, cause }));

  const wakeTunnelWaiters = (environmentId: EnvironmentId) => {
    const waiters = waitingTunnelWaiters.get(environmentId);
    if (!waiters) return;
    waitingTunnelWaiters.delete(environmentId);
    for (const wake of waiters) {
      wake();
    }
  };

  const waitForActiveTunnel = Effect.fn("FleetHubService.waitForActiveTunnel")(function* (
    environmentId: EnvironmentId,
    timeoutMs = 45_000,
  ) {
    const existing = activeTunnels.get(environmentId);
    if (existing) return existing;
    yield* Effect.callback<void>((resume) => {
      const set = waitingTunnelWaiters.get(environmentId) ?? new Set<() => void>();
      const onWake = () => {
        resume(Effect.void);
      };
      set.add(onWake);
      waitingTunnelWaiters.set(environmentId, set);
      return Effect.sync(() => {
        const current = waitingTunnelWaiters.get(environmentId);
        if (current) {
          current.delete(onWake);
          if (current.size === 0) waitingTunnelWaiters.delete(environmentId);
        }
      });
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
    return activeTunnels.get(environmentId) ?? null;
  });

  const getNode: FleetHubService["Service"]["getNode"] = Effect.fn("FleetHubService.getNode")(
    function* (environmentId) {
      const rows =
        yield* sql`SELECT * FROM sandbox_fleet_nodes WHERE environment_id = ${environmentId}`.pipe(
          dbError("Failed to query fleet node."),
        );
      if (rows.length === 0) return null;
      const decoded = yield* decodeNodeRow(rows[0]).pipe(dbError("Failed to decode fleet node."));
      return rowToNode(decoded);
    },
  );

  const listPeers: FleetHubService["Service"]["listPeers"] = Effect.fn("FleetHubService.listPeers")(
    function* () {
      const rows = yield* sql`SELECT * FROM sandbox_fleet_nodes ORDER BY created_at ASC`.pipe(
        dbError("Failed to list fleet peers."),
      );
      const nodes = yield* Effect.forEach(rows, (r) =>
        decodeNodeRow(r).pipe(dbError("Invalid fleet node row."), Effect.map(rowToNode)),
      );
      return nodes.map((node): FleetPeerInfo => ({
        environmentId: node.environmentId,
        meshIp: node.meshIp,
        slug: node.slug,
        ports: node.exposedPorts,
      }));
    },
  );

  const broadcastPeers = Effect.fn("FleetHubService.broadcastPeers")(function* () {
    const peers = yield* listPeers().pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<FleetPeerInfo>),
    );
    for (const [envId, endpoint] of activeTunnels.entries()) {
      const siblingPeers = peers.filter((p) => p.environmentId !== envId);
      void endpoint.requestControl("fleet.peers", { peers: siblingPeers }).catch(() => {});
    }
  });

  const allocateMeshSlot = Effect.fn("FleetHubService.allocateMeshSlot")(function* (
    title: string,
    environmentId: string,
  ) {
    const rows = yield* sql<{ readonly mesh_ip: string; readonly slug: string }>`
      SELECT mesh_ip, slug FROM sandbox_fleet_nodes
    `.pipe(dbError("Failed to inspect fleet mesh assignments."));
    const usedIps = new Set(rows.map((r) => r.mesh_ip));
    const usedSlugs = new Set(rows.map((r) => r.slug));
    let meshIp = meshIpForIndex(rows.length);
    for (let idx = rows.length; usedIps.has(meshIp); idx += 1) {
      meshIp = meshIpForIndex(idx);
    }
    const baseSlug = slugifyTitle(title, environmentId);
    const slug = usedSlugs.has(baseSlug) ? `${baseSlug}-${environmentId.slice(0, 4)}` : baseSlug;
    return { meshIp, slug };
  });

  const writeCacheEntry = Effect.fn("FleetHubService.writeCacheEntry")(function* (
    environmentId: EnvironmentId,
    cacheKey: string,
    payloadJson: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO sandbox_projection_cache (environment_id, cache_key, payload_json, updated_at)
      VALUES (${environmentId}, ${cacheKey}, ${payloadJson}, ${now})
      ON CONFLICT (environment_id, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `.pipe(dbError("Failed to write projection cache."));
  });

  const readCacheEntry = Effect.fn("FleetHubService.readCacheEntry")(function* (
    environmentId: EnvironmentId,
    cacheKey: string,
  ) {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM sandbox_projection_cache
      WHERE environment_id = ${environmentId} AND cache_key = ${cacheKey}
    `.pipe(dbError("Failed to read projection cache."));
    return rows[0]?.payload_json ?? null;
  });

  const registerSandboxNode: FleetHubService["Service"]["registerSandboxNode"] = Effect.fn(
    "FleetHubService.registerSandboxNode",
  )(function* (input) {
    const existing = yield* getNode(input.environmentId);
    if (existing !== null && existing.nodeSecretPlain !== null) {
      return { nodeSecret: existing.nodeSecretPlain, meshIp: existing.meshIp };
    }
    const now = yield* Clock.currentTimeMillis;
    const nowIso = formatIsoUtc(now);
    const nodeSecret = randomBase64Url(24);
    const { meshIp, slug } = yield* allocateMeshSlot(input.title, input.environmentId);
    const modelSelection: ModelSelection = {
      instanceId: defaultInstanceIdForDriver(input.driver),
      model: input.model,
    };
    const seeded = buildSeededSandboxCache({
      environmentId: input.environmentId,
      title: input.title,
      serverVersion: input.serverVersion,
      projectId: input.projectId as RegisterSandboxNodeInput["projectId"] & never,
      projectTitle: input.projectTitle,
      projectPath: input.projectPath,
      threadId: input.threadId as RegisterSandboxNodeInput["threadId"] & never,
      messageId: input.messageId as RegisterSandboxNodeInput["messageId"] & never,
      message: input.message,
      driver: input.driver,
      model: input.model,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      modelSelection,
      nowIso,
      ...(input.skipSeedThread === undefined ? {} : { skipSeedThread: input.skipSeedThread }),
    });

    yield* sql`
      INSERT INTO sandbox_fleet_nodes (
        environment_id, sandbox_id, node_kind, auth_mode,
        node_secret_hash, node_secret_plain, mesh_ip, slug,
        exposed_ports_json, descriptor_json, created_at, last_seen_at
      )
      VALUES (
        ${input.environmentId}, ${input.sandboxId}, 'sandbox', 'hub_authority',
        ${sha256Hex(nodeSecret)}, ${nodeSecret}, ${meshIp}, ${slug},
        ${stringifyJson(input.exposedPorts)}, ${seeded.descriptorJson}, ${now}, ${null}
      )
      ON CONFLICT (environment_id) DO NOTHING
    `.pipe(dbError("Failed to register sandbox node."));

    yield* writeCacheEntry(input.environmentId, "descriptor", seeded.descriptorJson);
    yield* writeCacheEntry(input.environmentId, "shellSnapshot", seeded.shellSnapshotJson);
    if (input.skipSeedThread !== true) {
      yield* writeCacheEntry(
        input.environmentId,
        `thread:${input.threadId}`,
        seeded.threadProjectionJson,
      );
    }
    yield* broadcastPeers();
    return { nodeSecret, meshIp };
  });

  const registerRunnerNode: FleetHubService["Service"]["registerRunnerNode"] = Effect.fn(
    "FleetHubService.registerRunnerNode",
  )(function* (input) {
    const existing = yield* getNode(input.environmentId);
    const now = yield* Clock.currentTimeMillis;
    const { meshIp, slug } =
      existing !== null
        ? { meshIp: existing.meshIp, slug: existing.slug }
        : yield* allocateMeshSlot(input.label, input.environmentId);

    yield* sql`
      INSERT INTO sandbox_fleet_nodes (
        environment_id, sandbox_id, node_kind, auth_mode,
        node_secret_hash, node_secret_plain, mesh_ip, slug,
        exposed_ports_json, descriptor_json, created_at, last_seen_at
      )
      VALUES (
        ${input.environmentId}, ${null}, 'runner', 'runner_passthrough',
        ${sha256Hex(input.nodeSecret)}, ${null}, ${meshIp}, ${slug},
        ${stringifyJson(input.exposedPorts ?? [])}, ${null}, ${now}, ${now}
      )
      ON CONFLICT (environment_id) DO UPDATE SET
        node_secret_hash = excluded.node_secret_hash,
        exposed_ports_json = excluded.exposed_ports_json,
        last_seen_at = excluded.last_seen_at
    `.pipe(dbError("Failed to register runner node."));
    yield* broadcastPeers();
  });

  const buildBootstrapManifestJson: FleetHubService["Service"]["buildBootstrapManifestJson"] =
    Effect.fn("FleetHubService.buildBootstrapManifestJson")(
      function* (environmentId, hubConnectUrl) {
        const node = yield* getNode(environmentId);
        if (node === null || node.nodeSecretPlain === null) return null;
        const peers = yield* listPeers();
        const ownerPeers = peers.filter((p) => p.environmentId !== environmentId);
        return stringifyJson({
          environmentId: node.environmentId,
          sandboxId: node.sandboxId ?? node.environmentId,
          ownerEnvironmentId: "hub",
          hubConnectUrl,
          nodeSecret: node.nodeSecretPlain,
          exposedHostPorts: node.exposedPorts,
          peers: ownerPeers,
        });
      },
    );

  const issuePairingCredential: FleetHubService["Service"]["issuePairingCredential"] = Effect.fn(
    "FleetHubService.issuePairingCredential",
  )(function* (environmentId, scopes) {
    const node = yield* getNode(environmentId);
    if (node === null) {
      return yield* new FleetHubError({ message: `Unknown fleet node ${environmentId}.` });
    }
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + 15 * 60_000;
    const grantId = `gr_${randomBase64Url(12)}`;
    const credential = `t3fg_${randomBase64Url(24)}`;
    yield* sql`
      INSERT INTO sandbox_fleet_grants (
        grant_id, environment_id, credential_hash, scopes_json, expires_at, consumed_at, created_at
      )
      VALUES (
        ${grantId}, ${environmentId}, ${sha256Hex(credential)}, ${stringifyJson(scopes)},
        ${expiresAt}, ${null}, ${now}
      )
    `.pipe(dbError("Failed to store pairing grant."));
    return credential;
  });

  const revokeSession: FleetHubService["Service"]["revokeSession"] = Effect.fn(
    "FleetHubService.revokeSession",
  )(function* (environmentId, sessionId) {
    const now = yield* Clock.currentTimeMillis;
    const updated = yield* sql<{ readonly session_id: string }>`
      UPDATE sandbox_fleet_sessions
      SET revoked_at = ${now}
      WHERE environment_id = ${environmentId} AND session_id = ${sessionId} AND revoked_at IS NULL
      RETURNING session_id
    `.pipe(dbError("Failed to revoke session."));

    for (const [ticket, entry] of wsTickets.entries()) {
      if (entry.environmentId === environmentId && entry.sessionId === sessionId) {
        wsTickets.delete(ticket);
      }
    }

    const sockets = liveClientSockets.get(environmentId);
    if (sockets) {
      for (const handle of sockets) {
        if (handle.sessionId === sessionId) {
          handle.closeImmediate();
          sockets.delete(handle);
        }
      }
    }
    return updated.length > 0;
  });

  const revokeNode: FleetHubService["Service"]["revokeNode"] = Effect.fn(
    "FleetHubService.revokeNode",
  )(function* (environmentId) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      UPDATE sandbox_fleet_sessions
      SET revoked_at = ${now}
      WHERE environment_id = ${environmentId} AND revoked_at IS NULL
    `.pipe(dbError("Failed to revoke node sessions."));

    for (const [ticket, entry] of wsTickets.entries()) {
      if (entry.environmentId === environmentId) {
        wsTickets.delete(ticket);
      }
    }

    const sockets = liveClientSockets.get(environmentId);
    if (sockets) {
      for (const handle of sockets) {
        handle.closeImmediate();
      }
      liveClientSockets.delete(environmentId);
    }

    const endpoint = activeTunnels.get(environmentId);
    if (endpoint) {
      activeTunnels.delete(environmentId);
      endpoint.close(1001, "node revoked");
    }

    yield* sql`DELETE FROM sandbox_fleet_nodes WHERE environment_id = ${environmentId}`.pipe(
      dbError("Failed to remove fleet node."),
    );
    yield* sql`DELETE FROM sandbox_projection_cache WHERE environment_id = ${environmentId}`.pipe(
      dbError("Failed to clear projection cache."),
    );
    yield* sql`DELETE FROM sandbox_inbox WHERE environment_id = ${environmentId}`.pipe(
      dbError("Failed to clear inbox."),
    );
    yield* broadcastPeers();
  });

  const handleInboundMuxStream = (
    callerEnvId: EnvironmentId,
    stream: FleetMuxStream,
    target: FleetStreamTarget,
  ): Promise<FleetStreamAck> | FleetStreamAck => {
    if (target.kind !== "tcp") {
      return { ok: false, error: "Hub mux only accepts outbound TCP streams." };
    }

    if (target.host === "127.0.0.1" || target.host === "localhost") {
      return runPromise(
        getNode(callerEnvId).pipe(
          Effect.map((node) => node?.exposedPorts ?? ([] as ReadonlyArray<number>)),
          Effect.orElseSucceed(() => [] as ReadonlyArray<number>),
        ),
      ).then((allowedPorts) => {
        if (!allowedPorts.includes(target.port)) {
          return {
            ok: false,
            error: `Host port ${target.port} is not exposed to sandbox ${callerEnvId}.`,
          };
        }
        return bridgeMuxStreamToTcp(stream, { host: "127.0.0.1", port: target.port });
      });
    }

    if (target.host.startsWith("peer://")) {
      const peerEnvId = EnvironmentId.make(target.host.slice("peer://".length));
      return runPromise(
        Effect.gen(function* () {
          const peerNode = yield* getNode(peerEnvId).pipe(Effect.orElseSucceed(() => null));
          if (peerNode === null) {
            return {
              ok: false,
              error: `Unknown sibling peer ${peerEnvId}.`,
            } satisfies FleetStreamAck;
          }
          let peerEndpoint = activeTunnels.get(peerEnvId) ?? null;
          if (peerEndpoint === null && peerNode.sandboxId !== null && sandboxCallbacks !== null) {
            yield* sandboxCallbacks.wakeSandbox(peerNode.sandboxId);
            peerEndpoint = yield* waitForActiveTunnel(peerEnvId, 45_000);
          }
          if (peerEndpoint === null) {
            return {
              ok: false,
              error: `Sibling peer ${peerEnvId} is offline.`,
            } satisfies FleetStreamAck;
          }
          const opened = yield* Effect.tryPromise({
            try: () =>
              peerEndpoint.openStream({
                kind: "tcp",
                host: "127.0.0.1",
                port: target.port,
              }),
            catch: (cause) =>
              new FleetHubError({ message: `Peer dial failed: ${String(cause)}`, cause }),
          }).pipe(Effect.result);

          if (opened._tag === "Failure") {
            return { ok: false, error: opened.failure.message } satisfies FleetStreamAck;
          }
          const remoteStream = opened.success.stream;
          stream.setConsumer({
            onData: (chunk) => {
              void remoteStream.write(chunk).catch(() => {});
            },
            onClose: () => {
              void remoteStream.close();
            },
            onReset: (reason) => {
              void remoteStream.reset(reason);
            },
          });
          remoteStream.setConsumer({
            onData: (chunk) => {
              void stream.write(chunk).catch(() => {});
            },
            onClose: () => {
              void stream.close();
            },
            onReset: (reason) => {
              void stream.reset(reason);
            },
          });
          return { ok: true } satisfies FleetStreamAck;
        }),
      );
    }

    return { ok: false, error: `Refusing disallowed target host ${target.host}` };
  };

  const getGuestBearerHeaders = Effect.fn("FleetHubService.getGuestBearerHeaders")(function* (
    environmentId: EnvironmentId,
  ) {
    const node = yield* getNode(environmentId);
    if (node === null || node.sandboxId === null || sandboxCallbacks === null) {
      return {} as Readonly<Record<string, string>>;
    }
    const token = yield* sandboxCallbacks.getGuestAdminToken(node.sandboxId);
    return token ? ({ authorization: `Bearer ${token}` } as const) : ({} as const);
  });

  const sendSingleRpcOverMux = Effect.fn("FleetHubService.sendSingleRpcOverMux")(function* (
    endpoint: FleetMuxEndpoint,
    environmentId: EnvironmentId,
    method: string,
    payload: unknown,
  ) {
    const authHeaders = yield* getGuestBearerHeaders(environmentId);
    const opened = yield* Effect.tryPromise({
      try: () =>
        endpoint.openStream({
          kind: "ws",
          path: `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
          headers: authHeaders,
        }),
      catch: (cause) =>
        new FleetHubError({ message: `Mux RPC open failed: ${String(cause)}`, cause }),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const reqId = `inbox-${nowMs}-${randomBase64Url(6)}`;
    const outcome = yield* Effect.callback<
      | { readonly ok: true; readonly result: unknown }
      | { readonly ok: false; readonly error: string }
    >((resume) => {
      let settled = false;
      const finish = (
        result:
          | { readonly ok: true; readonly result: unknown }
          | { readonly ok: false; readonly error: string },
      ) => {
        if (settled) return;
        settled = true;
        void opened.stream.close();
        resume(Effect.succeed(result));
      };

      const parse = createMuxWsFrameParser((kind, bytes) => {
        if (kind === WS_MUX_KIND_CLOSE) {
          finish({ ok: false, error: "Guest WS closed before reply" });
          return;
        }
        const parsed = safeJsonParse<Record<string, unknown>>(decodeUtf8(bytes));
        if (!parsed) return;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of items) {
          if (msg._tag === "Exit" && msg.requestId === reqId) {
            const exit = msg.exit as {
              readonly _tag?: string;
              readonly value?: unknown;
              readonly cause?: ReadonlyArray<{ readonly error?: { readonly message?: string } }>;
            };
            if (exit._tag === "Success") {
              finish({ ok: true, result: exit.value });
            } else {
              const errMsg = exit.cause?.[0]?.error?.message ?? "Guest RPC returned Failure";
              finish({ ok: false, error: errMsg });
            }
          }
        }
      });

      opened.stream.setConsumer({
        onData: parse,
        onClose: () => finish({ ok: false, error: "Guest mux WS closed" }),
        onReset: (reason) => finish({ ok: false, error: `Guest mux WS reset: ${reason}` }),
      });

      const reqBytes = encodeRpcWireObject({
        _tag: "Request",
        id: reqId,
        tag: method,
        payload,
        headers: [],
      });
      void opened.stream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, reqBytes));

      return Effect.sync(() => {
        settled = true;
        void opened.stream.close();
      });
    }).pipe(
      Effect.timeoutOption("30 seconds"),
      Effect.map(
        Option.getOrElse(() => ({
          ok: false as const,
          error: "Timed out waiting for guest RPC reply",
        })),
      ),
    );
    return outcome;
  });

  const refreshCacheFromLiveGuest = Effect.fn("FleetHubService.refreshCacheFromLiveGuest")(
    function* (environmentId: EnvironmentId, endpoint: FleetMuxEndpoint) {
      const authHeaders = yield* getGuestBearerHeaders(environmentId);
      const descriptorRes = yield* Effect.tryPromise({
        try: () =>
          forwardHttpOverMux(endpoint, {
            method: "GET",
            path: "/.well-known/t3/environment",
            headers: authHeaders,
          }),
        catch: (cause) => new FleetHubError({ message: String(cause), cause }),
      }).pipe(Effect.orElseSucceed(() => null));

      if (descriptorRes !== null && descriptorRes.status === 200) {
        const chunks: Array<Uint8Array> = [];
        yield* Effect.tryPromise({
          try: async () => {
            for await (const c of descriptorRes.chunks) chunks.push(c);
          },
          catch: (cause) => new FleetHubError({ message: String(cause), cause }),
        }).pipe(Effect.ignore);
        const text = Buffer.concat(chunks).toString("utf8");
        if (safeJsonParse(text)) {
          yield* writeCacheEntry(environmentId, "descriptor", text);
        }
      }

      const shellRes = yield* Effect.tryPromise({
        try: () =>
          forwardHttpOverMux(endpoint, {
            method: "GET",
            path: "/api/orchestration/shell",
            headers: {
              ...authHeaders,
              "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          }),
        catch: (cause) => new FleetHubError({ message: String(cause), cause }),
      }).pipe(Effect.orElseSucceed(() => null));

      if (shellRes !== null && shellRes.status === 200) {
        const chunks: Array<Uint8Array> = [];
        yield* Effect.tryPromise({
          try: async () => {
            for await (const c of shellRes.chunks) chunks.push(c);
          },
          catch: (cause) => new FleetHubError({ message: String(cause), cause }),
        }).pipe(Effect.ignore);
        const text = Buffer.concat(chunks).toString("utf8");
        if (safeJsonParse(text)) {
          yield* writeCacheEntry(environmentId, "shellSnapshot", text);
        }
      }
    },
  );

  const drainInbox = Effect.fn("FleetHubService.drainInbox")(function* (
    environmentId: EnvironmentId,
  ) {
    if (inboxDrainRunning.has(environmentId)) return;
    inboxDrainRunning.add(environmentId);
    try {
      while (true) {
        const endpoint = activeTunnels.get(environmentId);
        if (!endpoint) break;
        const rows = yield* sql<{
          readonly seq: number;
          readonly method: string;
          readonly payload_json: string;
        }>`
          SELECT seq, method, payload_json
          FROM sandbox_inbox
          WHERE environment_id = ${environmentId} AND delivered_at IS NULL
          ORDER BY seq ASC
          LIMIT 25
        `.pipe(dbError("Failed to read pending inbox items."));
        if (rows.length === 0) break;

        let pausedDrain = false;
        for (const row of rows) {
          const payload = safeJsonParse(row.payload_json);
          if (payload === null) {
            const now = yield* Clock.currentTimeMillis;
            yield* sql`
              UPDATE sandbox_inbox SET delivered_at = ${now} WHERE seq = ${row.seq}
            `.pipe(dbError("Failed to mark malformed inbox row delivered."));
            continue;
          }
          const outcome = yield* sendSingleRpcOverMux(
            endpoint,
            environmentId,
            row.method,
            payload,
          ).pipe(Effect.orElseSucceed(() => ({ ok: false as const, error: "transient" })));
          if (!outcome.ok) {
            if (isThreadArchivedOrNotFoundError(outcome.error)) {
              // Seed thread or project is still booting on first run; keep queued for next retry.
              pausedDrain = true;
              break;
            }
            pausedDrain = true;
            break;
          }
          const now = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE sandbox_inbox SET delivered_at = ${now} WHERE seq = ${row.seq}
          `.pipe(dbError("Failed to mark inbox row delivered."));
        }
        if (pausedDrain) break;
      }
    } finally {
      inboxDrainRunning.delete(environmentId);
    }
  });

  const attachTunnel: FleetHubService["Service"]["attachTunnel"] = Effect.fn(
    "FleetHubService.attachTunnel",
  )(function* (environmentId, endpoint) {
    const previous = activeTunnels.get(environmentId);
    if (previous && previous !== endpoint) {
      previous.close(1001, "replaced by newer tunnel");
    }
    activeTunnels.set(environmentId, endpoint);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      UPDATE sandbox_fleet_nodes SET last_seen_at = ${now} WHERE environment_id = ${environmentId}
    `.pipe(Effect.ignore);

    wakeTunnelWaiters(environmentId);
    yield* drainInbox(environmentId).pipe(Effect.ignore);
    yield* refreshCacheFromLiveGuest(environmentId, endpoint).pipe(Effect.forkIn(scope));

    const sockets = liveClientSockets.get(environmentId);
    if (sockets) {
      for (const handle of sockets) {
        handle.notifyUpstreamChange();
      }
    }
  });

  const notifyGuestReadyForInbox: FleetHubService["Service"]["notifyGuestReadyForInbox"] =
    Effect.fn("FleetHubService.notifyGuestReadyForInbox")(function* (environmentId) {
      yield* drainInbox(environmentId).pipe(Effect.ignore);
      const endpoint = activeTunnels.get(environmentId);
      if (endpoint) {
        yield* refreshCacheFromLiveGuest(environmentId, endpoint).pipe(Effect.ignore);
        const sockets = liveClientSockets.get(environmentId);
        if (sockets) {
          for (const handle of sockets) {
            handle.notifyUpstreamChange();
          }
        }
      }
    });

  const handleControlMap = (environmentId: EnvironmentId) => ({
    "github.token": async () => {
      if (Option.isNone(maybeGithub)) return { token: null };
      const token = await runPromise(
        maybeGithub.value.current(Duration.hours(1)).pipe(Effect.orElseSucceed(() => null)),
      );
      return { token: token ? Redacted.value(token.token) : null };
    },
    "fleet.peers": async () => {
      const peers = await runPromise(
        listPeers().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<FleetPeerInfo>)),
      );
      return { peers: peers.filter((p) => p.environmentId !== environmentId) };
    },
  });

  const ensureBoatReverseTunnel: FleetHubService["Service"]["ensureBoatReverseTunnel"] = Effect.fn(
    "FleetHubService.ensureBoatReverseTunnel",
  )(function* (environmentId, providerHttpUrl) {
    if (activeTunnels.has(environmentId) || boatReverseDials.has(environmentId)) return;
    if (Option.isNone(maybeWsCtor)) return;
    const node = yield* getNode(environmentId).pipe(Effect.orElseSucceed(() => null));
    if (node === null || node.nodeSecretPlain === null) return;
    if (!/^https?:\/\//i.test(providerHttpUrl)) return;

    boatReverseDials.add(environmentId);
    const wsCtor = maybeWsCtor.value;
    const dialUrl = new URL("/_fleet/accept", providerHttpUrl.replace(/^http/i, "ws"));
    dialUrl.searchParams.set("secret", node.nodeSecretPlain);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* Socket.makeWebSocket(dialUrl.toString(), {
          openTimeout: "15 seconds",
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, wsCtor));
        const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
          initiator: true,
          onStream: (stream, target) => handleInboundMuxStream(environmentId, stream, target),
          onControl: handleControlMap(environmentId),
        });
        const runFiber = yield* run.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeTunnels.get(environmentId) === endpoint) {
                activeTunnels.delete(environmentId);
              }
              const sockets = liveClientSockets.get(environmentId);
              if (sockets) {
                for (const handle of sockets) handle.notifyUpstreamChange();
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* attachTunnel(environmentId, endpoint);
        yield* Fiber.join(runFiber);
      }),
    ).pipe(
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.sync(() => {
          boatReverseDials.delete(environmentId);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const probeGuestEnvironmentId: FleetHubService["Service"]["probeGuestEnvironmentId"] = Effect.fn(
    "FleetHubService.probeGuestEnvironmentId",
  )(function* (environmentId) {
    const endpoint = activeTunnels.get(environmentId);
    if (!endpoint) return null;
    const res = yield* Effect.tryPromise({
      try: () =>
        forwardHttpOverMux(endpoint, {
          method: "GET",
          path: "/.well-known/t3/environment",
          headers: {},
        }),
      catch: (cause) => new FleetHubError({ message: String(cause), cause }),
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    );

    if (res === null || res.status !== 200) return null;
    const chunks: Array<Uint8Array> = [];
    yield* Effect.tryPromise({
      try: async () => {
        for await (const chunk of res.chunks) chunks.push(chunk);
      },
      catch: (cause) => new FleetHubError({ message: String(cause), cause }),
    }).pipe(Effect.ignore);
    const parsed = safeJsonParse<{ readonly environmentId?: string }>(
      Buffer.concat(chunks).toString("utf8"),
    );
    return parsed?.environmentId ? EnvironmentId.make(parsed.environmentId) : null;
  });

  const verifyClientAuth = Effect.fn("FleetHubService.verifyClientAuth")(function* (
    environmentId: EnvironmentId,
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    options?: { readonly allowWsTicket?: boolean },
  ): Effect.fn.Return<FleetSessionRecord | null> {
    const now = yield* Clock.currentTimeMillis;

    if (options?.allowWsTicket === true) {
      const wsTicket = url.searchParams.get("wsTicket");
      if (wsTicket) {
        const entry = wsTickets.get(wsTicket);
        wsTickets.delete(wsTicket);
        if (!entry || entry.environmentId !== environmentId || entry.expiresAt <= now) {
          return null;
        }
        if (entry.proofThumbprint.length > 0) {
          const dpopHeader = request.headers.dpop ?? url.searchParams.get("dpop") ?? undefined;
          const proof = verifyDpopProof({
            proof: dpopHeader,
            method: request.method,
            url: url.href,
            nowEpochSeconds: Math.floor(now / 1_000),
            expectedThumbprint: entry.proofThumbprint,
            expectedAccessToken: wsTicket,
          });
          if (!proof.ok) return null;
          const replayKey = `${entry.sessionId}:${proof.jti}`;
          if (dpopReplayKeys.has(replayKey)) return null;
          dpopReplayKeys.add(replayKey);
        }
        const activeSession = yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM sandbox_fleet_sessions
          WHERE session_id = ${entry.sessionId} AND revoked_at IS NULL AND expires_at > ${now}
        `.pipe(Effect.orElseSucceed(() => []));
        if (activeSession.length === 0) return null;
        return {
          sessionId: entry.sessionId,
          environmentId: entry.environmentId,
          scopes: entry.scopes,
          proofThumbprint: entry.proofThumbprint,
          method: entry.method,
          expiresAt: entry.expiresAt,
        };
      }
    }

    const authHeader = request.headers.authorization;
    let presentedToken: string | null = null;
    let dpopPresented = false;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      presentedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    } else if (authHeader && /^DPoP\s+/i.test(authHeader)) {
      presentedToken = authHeader.replace(/^DPoP\s+/i, "").trim();
      dpopPresented = true;
    } else {
      const cookieToken = request.cookies[encodeBootstrapCookieName(environmentId)];
      if (cookieToken) presentedToken = cookieToken;
    }

    if (!presentedToken) return null;
    const rows = yield* sql<{
      readonly session_id: string;
      readonly environment_id: EnvironmentId;
      readonly proof_thumbprint: string;
      readonly scopes_json: string;
      readonly expires_at: number;
    }>`
      SELECT session_id, environment_id, proof_thumbprint, scopes_json, expires_at
      FROM sandbox_fleet_sessions
      WHERE token_hash = ${sha256Hex(presentedToken)}
        AND environment_id = ${environmentId}
        AND revoked_at IS NULL
        AND expires_at > ${now}
    `.pipe(Effect.orElseSucceed(() => []));
    const row = rows[0];
    if (!row) return null;

    if (row.proof_thumbprint.length > 0 && authHeader !== undefined) {
      if (!dpopPresented) return null;
      const proof = verifyDpopProof({
        proof: request.headers.dpop,
        method: request.method,
        url: url.href,
        nowEpochSeconds: Math.floor(now / 1_000),
        expectedThumbprint: row.proof_thumbprint,
        expectedAccessToken: presentedToken,
      });
      if (!proof.ok) return null;
      const replayKey = `${row.session_id}:${proof.jti}`;
      if (dpopReplayKeys.has(replayKey)) return null;
      dpopReplayKeys.add(replayKey);
    }

    const scopes = (safeJsonParse<Array<AuthEnvironmentScope>>(row.scopes_json) ??
      []) as ReadonlyArray<AuthEnvironmentScope>;
    return {
      sessionId: row.session_id,
      environmentId: row.environment_id,
      scopes,
      proofThumbprint: row.proof_thumbprint,
      method:
        row.proof_thumbprint.length > 0
          ? "dpop-access-token"
          : authHeader
            ? "bearer-access-token"
            : "browser-session-cookie",
      expiresAt: row.expires_at,
    };
  });

  const handleHubAuthorityAuth = Effect.fn("FleetHubService.handleHubAuthorityAuth")(function* (
    node: FleetNodeRecord,
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    subPath: string,
  ): Effect.fn.Return<HttpServerResponse.HttpServerResponse | null> {
    const now = yield* Clock.currentTimeMillis;

    if (request.method === "GET" && subPath === "/api/auth/session") {
      const session = yield* verifyClientAuth(node.environmentId, request, url);
      const authDescriptor = {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token", "dpop-access-token", "browser-session-cookie"],
        sessionCookieName: encodeBootstrapCookieName(node.environmentId),
      };
      if (session === null) {
        return HttpServerResponse.jsonUnsafe({
          authenticated: false,
          auth: authDescriptor,
        });
      }
      return HttpServerResponse.jsonUnsafe({
        authenticated: true,
        auth: authDescriptor,
        scopes: session.scopes,
        permissions: session.scopes,
        sessionMethod: session.method,
        sessionId: session.sessionId,
        expiresAt: formatIsoUtc(session.expiresAt),
      });
    }

    if (request.method === "POST" && subPath === "/api/auth/browser-session") {
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => "{}"));
      const body = safeJsonParse<{ readonly credential?: string }>(raw) ?? {};
      if (!body.credential) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const grantRows = yield* sql<{
        readonly grant_id: string;
        readonly scopes_json: string;
      }>`
        UPDATE sandbox_fleet_grants
        SET consumed_at = ${now}
        WHERE credential_hash = ${sha256Hex(body.credential)}
          AND environment_id = ${node.environmentId}
          AND consumed_at IS NULL
          AND expires_at > ${now}
        RETURNING grant_id, scopes_json
      `.pipe(Effect.orElseSucceed(() => []));
      const grant = grantRows[0];
      if (!grant) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const sessionId = `fs_${randomBase64Url(12)}`;
      const token = `t3fs_${randomBase64Url(24)}`;
      const expiresAt = now + 30 * 24 * 60 * 60_000;
      const scopes = safeJsonParse<Array<AuthEnvironmentScope>>(grant.scopes_json) ?? [
        ...AuthStandardClientScopes,
      ];
      yield* sql`
        INSERT INTO sandbox_fleet_sessions (
          session_id, environment_id, token_hash, jwk_json, proof_thumbprint,
          scopes_json, client_json, created_at, expires_at, revoked_at
        )
        VALUES (
          ${sessionId}, ${node.environmentId}, ${sha256Hex(token)}, '{}', '',
          ${stringifyJson(scopes)}, ${null}, ${now}, ${expiresAt}, ${null}
        )
      `.pipe(Effect.orDie);
      const cookieName = encodeBootstrapCookieName(node.environmentId);
      return HttpServerResponse.jsonUnsafe(
        {
          authenticated: true,
          scopes,
          permissions: scopes,
          sessionMethod: "browser-session-cookie",
          expiresAt: formatIsoUtc(expiresAt),
        },
        {
          headers: {
            "set-cookie": `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
          },
        },
      );
    }

    if (request.method === "POST" && subPath === "/oauth/token") {
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const fields = parseTokenBody(raw);
      const subjectToken = fields.subject_token ?? "";
      const subjectTokenType = fields.subject_token_type ?? "";
      const dpopProof = request.headers.dpop;

      if (subjectTokenType === AuthAccessTokenType) {
        const rows = yield* sql<{
          readonly session_id: string;
          readonly proof_thumbprint: string;
          readonly scopes_json: string;
        }>`
          SELECT session_id, proof_thumbprint, scopes_json
          FROM sandbox_fleet_sessions
          WHERE token_hash = ${sha256Hex(subjectToken)}
            AND environment_id = ${node.environmentId}
            AND revoked_at IS NULL
            AND expires_at > ${now}
        `.pipe(Effect.orElseSucceed(() => []));
        const existing = rows[0];
        if (!existing) {
          return HttpServerResponse.jsonUnsafe(
            { code: "auth_invalid", reason: "invalid_credential" },
            { status: 401 },
          );
        }
        if (existing.proof_thumbprint.length > 0) {
          const proof = verifyDpopProof({
            proof: dpopProof,
            method: "POST",
            url: url.href,
            nowEpochSeconds: Math.floor(now / 1_000),
            expectedThumbprint: existing.proof_thumbprint,
            expectedAccessToken: subjectToken,
          });
          if (!proof.ok) {
            return HttpServerResponse.jsonUnsafe(
              { code: "auth_invalid", reason: "invalid_credential" },
              { status: 401 },
            );
          }
        }
        const nextToken = `t3fs_${randomBase64Url(24)}`;
        const nextExpires = now + 3600 * 1000;
        yield* sql`
          UPDATE sandbox_fleet_sessions
          SET token_hash = ${sha256Hex(nextToken)}, expires_at = ${nextExpires}
          WHERE session_id = ${existing.session_id}
        `.pipe(Effect.orDie);
        const scopes = safeJsonParse<Array<string>>(existing.scopes_json) ?? [];
        const result: AuthAccessTokenResult = {
          access_token: nextToken,
          issued_token_type: AuthAccessTokenType,
          token_type: existing.proof_thumbprint.length > 0 ? "DPoP" : "Bearer",
          expires_in: 3600,
          scope: scopes.join(" "),
        };
        return HttpServerResponse.jsonUnsafe(result);
      }

      if (subjectTokenType !== AuthEnvironmentBootstrapTokenType) {
        return HttpServerResponse.jsonUnsafe(
          { code: "invalid_request", reason: "unsupported_grant" },
          { status: 400 },
        );
      }

      let thumbprint = "";
      if (dpopProof) {
        const checked = verifyDpopProof({
          proof: dpopProof,
          method: "POST",
          url: url.href,
          nowEpochSeconds: Math.floor(now / 1_000),
        });
        if (!checked.ok) {
          return HttpServerResponse.jsonUnsafe(
            { code: "auth_invalid", reason: "invalid_credential" },
            { status: 401 },
          );
        }
        thumbprint = checked.thumbprint;
      }

      const grants = yield* sql<{
        readonly grant_id: string;
        readonly scopes_json: string;
      }>`
        UPDATE sandbox_fleet_grants
        SET consumed_at = ${now}
        WHERE credential_hash = ${sha256Hex(subjectToken)}
          AND environment_id = ${node.environmentId}
          AND consumed_at IS NULL
          AND expires_at > ${now}
        RETURNING grant_id, scopes_json
      `.pipe(Effect.orElseSucceed(() => []));
      const grant = grants[0];
      if (!grant) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }

      const grantedScopes = safeJsonParse<Array<AuthEnvironmentScope>>(grant.scopes_json) ?? [
        ...AuthStandardClientScopes,
      ];
      const requested = fields.scope
        ? (parseOAuthScope(fields.scope)?.filter(Schema.is(AuthGrantScope)) ?? grantedScopes)
        : grantedScopes;
      const finalScopes = requested.filter((s) => grantedScopes.includes(s));

      const sessionId = `fs_${randomBase64Url(12)}`;
      const accessToken = `t3fs_${randomBase64Url(24)}`;
      const expiresAt = now + 3600 * 1000;
      yield* sql`
        INSERT INTO sandbox_fleet_sessions (
          session_id, environment_id, token_hash, jwk_json, proof_thumbprint,
          scopes_json, client_json, created_at, expires_at, revoked_at
        )
        VALUES (
          ${sessionId}, ${node.environmentId}, ${sha256Hex(accessToken)}, '{}', ${thumbprint},
          ${stringifyJson(finalScopes)}, ${null}, ${now}, ${expiresAt}, ${null}
        )
      `.pipe(Effect.orDie);

      const result: AuthAccessTokenResult = {
        access_token: accessToken,
        issued_token_type: AuthAccessTokenType,
        token_type: thumbprint.length > 0 ? "DPoP" : "Bearer",
        expires_in: 3600,
        scope: finalScopes.join(" "),
      };
      return HttpServerResponse.jsonUnsafe(result);
    }

    if (
      request.method === "POST" &&
      (subPath === "/api/auth/websocket-ticket" ||
        subPath === "/api/auth/websocket-ticket/rpc" ||
        subPath === "/api/auth/websocket-ticket/media")
    ) {
      const session = yield* verifyClientAuth(node.environmentId, request, url);
      if (session === null) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const ticket = `wst_${randomBase64Url(24)}`;
      const expiresAt = now + 60_000;
      wsTickets.set(ticket, {
        environmentId: node.environmentId,
        sessionId: session.sessionId,
        scopes: session.scopes,
        proofThumbprint: session.proofThumbprint,
        method: session.method,
        expiresAt,
      });
      return HttpServerResponse.jsonUnsafe({
        ticket,
        expiresAt: formatIsoUtc(expiresAt),
      });
    }

    if (request.method === "POST" && subPath === "/api/auth/pairing-token") {
      const session = yield* verifyClientAuth(node.environmentId, request, url);
      if (session === null) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => "{}"));
      const body = safeJsonParse<{ readonly scopes?: ReadonlyArray<AuthGrantScope> }>(raw) ?? {};
      const scopes = (body.scopes ?? [...AuthStandardClientScopes]).filter((s) =>
        session.scopes.includes(s),
      );
      const cred = yield* issuePairingCredential(node.environmentId, scopes).pipe(Effect.orDie);
      return HttpServerResponse.jsonUnsafe({
        id: `gr_${randomBase64Url(6)}`,
        credential: cred,
        expiresAt: formatIsoUtc(now + 15 * 60_000),
      });
    }

    if (request.method === "POST" && subPath === "/api/auth/clients/revoke") {
      const session = yield* verifyClientAuth(node.environmentId, request, url);
      if (session === null) {
        return HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", reason: "invalid_credential" },
          { status: 401 },
        );
      }
      const raw = yield* request.text.pipe(Effect.orElseSucceed(() => "{}"));
      const body = safeJsonParse<{ readonly sessionId?: string }>(raw) ?? {};
      const revoked = body.sessionId
        ? yield* revokeSession(node.environmentId, body.sessionId).pipe(Effect.orDie)
        : false;
      return HttpServerResponse.jsonUnsafe({ revoked });
    }

    return null;
  });

  const enqueueAndApplyCommand = Effect.fn("FleetHubService.enqueueAndApplyCommand")(function* (
    node: FleetNodeRecord,
    method: string,
    payload: Record<string, unknown>,
  ) {
    const commandId =
      typeof payload.commandId === "string" ? payload.commandId : `cmd-${randomBase64Url(8)}`;
    const now = yield* Clock.currentTimeMillis;
    const nowIso = formatIsoUtc(now);
    const serialized = stringifyJson(payload);

    const existing = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM sandbox_inbox
      WHERE environment_id = ${node.environmentId} AND idempotency_key = ${commandId}
    `.pipe(Effect.orElseSucceed(() => []));

    let seq = existing[0]?.seq;
    if (seq === undefined) {
      const inserted = yield* sql<{ readonly seq: number }>`
        INSERT INTO sandbox_inbox (
          environment_id, idempotency_key, kind, method, payload_json, created_at, delivered_at
        )
        VALUES (
          ${node.environmentId}, ${commandId}, 'ws_rpc', ${method}, ${serialized}, ${now}, ${null}
        )
        ON CONFLICT (environment_id, idempotency_key) DO NOTHING
        RETURNING seq
      `.pipe(Effect.orDie);
      seq = inserted[0]?.seq ?? 1;

      const currentShell = yield* readCacheEntry(node.environmentId, "shellSnapshot").pipe(
        Effect.orElseSucceed(() => null),
      );
      const threadId =
        typeof payload.threadId === "string"
          ? payload.threadId
          : typeof payload.targetThreadId === "string"
            ? payload.targetThreadId
            : null;
      const currentThread =
        threadId !== null
          ? yield* readCacheEntry(node.environmentId, `thread:${threadId}`).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;

      const optimistic = applyOptimisticCommandToCache({
        shellSnapshotJson: currentShell,
        threadProjectionJson: currentThread,
        command: payload,
        nowIso,
      });

      if (optimistic !== null) {
        yield* writeCacheEntry(
          node.environmentId,
          "shellSnapshot",
          optimistic.nextShellSnapshotJson,
        ).pipe(Effect.ignore);
        if (optimistic.updatedThreadId !== null && optimistic.nextThreadProjectionJson !== null) {
          yield* writeCacheEntry(
            node.environmentId,
            `thread:${optimistic.updatedThreadId}`,
            optimistic.nextThreadProjectionJson,
          ).pipe(Effect.ignore);
        }

        const sockets = liveClientSockets.get(node.environmentId);
        if (sockets) {
          for (const handle of sockets) {
            for (const sub of handle.subscriptions.values()) {
              if (
                sub.tag === ORCHESTRATION_V2_WS_METHODS.subscribeShell &&
                optimistic.shellUpdates.length > 0
              ) {
                handle.sendMessage({
                  _tag: "Chunk",
                  requestId: sub.requestId,
                  values: optimistic.shellUpdates,
                });
              }
              if (
                sub.tag === ORCHESTRATION_V2_WS_METHODS.subscribeThread &&
                sub.payload.threadId === optimistic.updatedThreadId &&
                optimistic.threadUpdates.length > 0
              ) {
                handle.sendMessage({
                  _tag: "Chunk",
                  requestId: sub.requestId,
                  values: optimistic.threadUpdates,
                });
              }
            }
          }
        }

        if (
          payload.type === "thread.archive" &&
          optimistic.allTopLevelArchived &&
          node.sandboxId &&
          sandboxCallbacks
        ) {
          yield* sandboxCallbacks.pauseSandbox(node.sandboxId);
          return { sequence: optimistic.nextSequence };
        }
      }

      if (node.sandboxId && sandboxCallbacks) {
        yield* sandboxCallbacks.wakeSandbox(node.sandboxId);
      }
    }

    return { sequence: seq };
  });

  const handleParkedWsRequest = Effect.fn("FleetHubService.handleParkedWsRequest")(function* (
    node: FleetNodeRecord,
    session: FleetSessionRecord,
    handle: LiveClientSocketHandle,
    req: {
      readonly id: string | number;
      readonly tag: string;
      readonly payload: Record<string, unknown>;
      readonly headers: ReadonlyArray<[string, string]>;
    },
  ) {
    const tag = req.tag;
    const reqId = req.id;

    if (tag === WS_METHODS.serverProbe) {
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: {
          _tag: "Success",
          value: { serverTime: formatIsoUtc(yield* Clock.currentTimeMillis) },
        },
      });
      return;
    }

    if (tag === WS_METHODS.serverGetConfig) {
      const serverTimeIso = formatIsoUtc(yield* Clock.currentTimeMillis);
      const desc = yield* readCacheEntry(node.environmentId, "descriptor").pipe(
        Effect.orElseSucceed(() => node.descriptorJson),
      );
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: {
          _tag: "Success",
          value: buildParkedServerConfig(desc, "/home/user/projects", serverTimeIso),
        },
      });
      return;
    }

    if (tag === WS_METHODS.subscribeServerConfig) {
      const serverTimeIso = formatIsoUtc(yield* Clock.currentTimeMillis);
      handle.subscriptions.set(reqId, {
        requestId: reqId,
        tag,
        payload: req.payload,
        headers: req.headers,
      });
      const desc = yield* readCacheEntry(node.environmentId, "descriptor").pipe(
        Effect.orElseSucceed(() => node.descriptorJson),
      );
      handle.sendMessage({
        _tag: "Chunk",
        requestId: reqId,
        values: [
          {
            version: 1,
            type: "snapshot",
            config: buildParkedServerConfig(desc, "/home/user/projects", serverTimeIso),
          },
        ],
      });
      return;
    }

    if (tag === WS_METHODS.subscribeAuthAccess) {
      handle.subscriptions.set(reqId, {
        requestId: reqId,
        tag,
        payload: req.payload,
        headers: req.headers,
      });
      handle.sendMessage({
        _tag: "Chunk",
        requestId: reqId,
        values: [
          {
            version: 1,
            revision: 0,
            type: "snapshot",
            payload: { pairingLinks: [], clientSessions: [], connectDevices: [] },
          },
        ],
      });
      return;
    }

    if (tag === ORCHESTRATION_V2_WS_METHODS.subscribeShell) {
      handle.subscriptions.set(reqId, {
        requestId: reqId,
        tag,
        payload: req.payload,
        headers: req.headers,
      });
      const raw = yield* readCacheEntry(node.environmentId, "shellSnapshot").pipe(
        Effect.orElseSucceed(() => null),
      );
      const snapshot = (raw ? safeJsonParse(raw) : null) ?? {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      };
      handle.sendMessage({
        _tag: "Chunk",
        requestId: reqId,
        values: [{ kind: "snapshot", snapshot }, { kind: "synchronized" }],
      });
      return;
    }

    if (tag === ORCHESTRATION_V2_WS_METHODS.subscribeThread) {
      handle.subscriptions.set(reqId, {
        requestId: reqId,
        tag,
        payload: req.payload,
        headers: req.headers,
      });
      const threadId = typeof req.payload.threadId === "string" ? req.payload.threadId : "";
      const raw = yield* readCacheEntry(node.environmentId, `thread:${threadId}`).pipe(
        Effect.orElseSucceed(() => null),
      );
      const projection = raw ? safeJsonParse(raw) : null;
      if (projection !== null) {
        handle.sendMessage({
          _tag: "Chunk",
          requestId: reqId,
          values: [{ kind: "snapshot", snapshotSequence: 1, projection }, { kind: "synchronized" }],
        });
      }
      return;
    }

    if (tag === ORCHESTRATION_V2_WS_METHODS.getThreadProjection) {
      const threadId = typeof req.payload.threadId === "string" ? req.payload.threadId : "";
      const raw = yield* readCacheEntry(node.environmentId, `thread:${threadId}`).pipe(
        Effect.orElseSucceed(() => null),
      );
      const projection = raw ? safeJsonParse(raw) : null;
      if (projection === null) {
        handle.sendMessage({
          _tag: "Exit",
          requestId: reqId,
          exit: {
            _tag: "Failure",
            cause: [
              {
                _tag: "Fail",
                error: {
                  _tag: "OrchestrationV2GetThreadProjectionError",
                  threadId,
                  message: `Thread ${threadId} not yet cached.`,
                },
              },
            ],
          },
        });
      } else {
        handle.sendMessage({
          _tag: "Exit",
          requestId: reqId,
          exit: { _tag: "Success", value: projection },
        });
      }
      return;
    }

    if (tag === ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot) {
      const raw = yield* readCacheEntry(node.environmentId, "shellSnapshot").pipe(
        Effect.orElseSucceed(() => null),
      );
      const parsed = (raw ? safeJsonParse<Record<string, unknown>>(raw) : null) ?? {};
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: {
          _tag: "Success",
          value: {
            schemaVersion: 1,
            snapshotSequence: parsed.snapshotSequence ?? 1,
            projects: parsed.projects ?? [],
            threads: parsed.archivedThreads ?? [],
          },
        },
      });
      return;
    }

    if (tag === ORCHESTRATION_V2_WS_METHODS.getThreadFamily) {
      const raw = yield* readCacheEntry(node.environmentId, "shellSnapshot").pipe(
        Effect.orElseSucceed(() => null),
      );
      const parsed =
        (raw
          ? safeJsonParse<{
              readonly snapshotSequence?: number;
              readonly threads?: Array<Record<string, unknown>>;
            }>(raw)
          : null) ?? {};
      const threadId = typeof req.payload.threadId === "string" ? req.payload.threadId : "";
      const matching = (parsed.threads ?? []).filter(
        (t) =>
          t.id === threadId ||
          (t.lineage as { readonly rootThreadId?: string } | undefined)?.rootThreadId === threadId,
      );
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: {
          _tag: "Success",
          value: { snapshotSequence: parsed.snapshotSequence ?? 1, threads: matching },
        },
      });
      return;
    }

    if (
      tag === WS_METHODS.subscribeDiscoveredLocalServers ||
      tag === WS_METHODS.subscribeProjectClones ||
      tag === WS_METHODS.subscribeVcsStatus ||
      tag === WS_METHODS.subscribeVcsBranch ||
      tag === WS_METHODS.subscribeTerminalMetadata ||
      tag === WS_METHODS.subscribePreviewEvents ||
      tag === WS_METHODS.subscribeDeviceState ||
      tag === WS_METHODS.subscribeServerLifecycle ||
      tag === WS_METHODS.subscribeResourceTelemetry ||
      tag === WS_METHODS.workflowsSubscribe ||
      tag === WS_METHODS.workflowsCounts ||
      tag === WS_METHODS.scheduledTasksSubscribe ||
      tag === WS_METHODS.pullRequestsSubscribeRefreshes ||
      tag === WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes ||
      tag === WS_METHODS.sandboxesSubscribe
    ) {
      handle.subscriptions.set(reqId, {
        requestId: reqId,
        tag,
        payload: req.payload,
        headers: req.headers,
      });
      if (tag === WS_METHODS.subscribeDiscoveredLocalServers) {
        handle.sendMessage({
          _tag: "Chunk",
          requestId: reqId,
          values: [
            {
              servers: [],
              scannedAt: formatIsoUtc(yield* Clock.currentTimeMillis),
            },
          ],
        });
      } else if (tag === WS_METHODS.subscribeProjectClones) {
        handle.sendMessage({ _tag: "Chunk", requestId: reqId, values: [[]] });
      } else if (tag === WS_METHODS.workflowsSubscribe) {
        handle.sendMessage({
          _tag: "Chunk",
          requestId: reqId,
          values: [{ workflows: [], runs: [], questions: [] }],
        });
      } else if (tag === WS_METHODS.workflowsCounts) {
        handle.sendMessage({
          _tag: "Chunk",
          requestId: reqId,
          values: [{ needsYou: 0, active: 0, total: 0 }],
        });
      } else if (tag === WS_METHODS.scheduledTasksSubscribe) {
        handle.sendMessage({
          _tag: "Chunk",
          requestId: reqId,
          values: [{ tasks: [] }],
        });
      }
      return;
    }

    if (
      tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand ||
      tag === ORCHESTRATION_V2_WS_METHODS.launchThread ||
      tag === WS_METHODS.projectsMutate
    ) {
      const result = yield* enqueueAndApplyCommand(node, tag, req.payload);
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: { _tag: "Success", value: result },
      });
      return;
    }

    if (
      tag === WS_METHODS.serverReportClientActivity ||
      tag === WS_METHODS.peerLinksList ||
      tag === WS_METHODS.peerLinksNames
    ) {
      handle.sendMessage({
        _tag: "Exit",
        requestId: reqId,
        exit: {
          _tag: "Success",
          value: tag.startsWith("peerLinks.") ? { links: [] } : undefined,
        },
      });
      return;
    }

    void session;
    handle.sendMessage({
      _tag: "Exit",
      requestId: reqId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "SandboxParkedMethodUnavailable",
              message: `${tag} waits for the sandbox to wake.`,
            },
          },
        ],
      },
    });
  });

  const handleHubAuthorityWs = Effect.fn("FleetHubService.handleHubAuthorityWs")(function* (
    node: FleetNodeRecord,
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
  ) {
    const session = yield* verifyClientAuth(node.environmentId, request, url, {
      allowWsTicket: true,
    });
    if (session === null) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
    const clientSocket = yield* request.upgrade.pipe(Effect.orDie);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* clientSocket.writer;
        const reader = yield* clientSocket.reader;
        const outboundQueue = yield* Queue.unbounded<string>();
        const subscriptions = new Map<string | number, ParkedSubscription>();
        let closed = false;
        let upstreamStream: FleetMuxStream | null = null;
        let upstreamEndpoint: FleetMuxEndpoint | null = null;
        let connectingUpstream = false;

        const queueEncoded = (encoded: unknown) => {
          if (closed) return;
          Queue.offerUnsafe(outboundQueue, stringifyJson(encoded));
        };

        const openAndSpliceUpstream = Effect.fn("FleetHubService.spliceUpstream")(function* () {
          const endpoint = activeTunnels.get(node.environmentId);
          if (upstreamStream !== null && upstreamEndpoint !== endpoint) {
            upstreamStream = null;
            upstreamEndpoint = null;
          }
          if (closed || upstreamStream !== null || connectingUpstream) return;
          if (!endpoint) return;
          connectingUpstream = true;
          try {
            yield* drainInbox(node.environmentId).pipe(Effect.ignore);
            const authHeaders = yield* getGuestBearerHeaders(node.environmentId);
            const opened = yield* Effect.tryPromise({
              try: () =>
                endpoint.openStream({
                  kind: "ws",
                  path: `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
                  headers: authHeaders,
                }),
              catch: (cause) => new FleetHubError({ message: String(cause), cause }),
            }).pipe(Effect.orElseSucceed(() => null));
            if (opened === null || closed) {
              if (opened !== null) void opened.stream.close();
              return;
            }
            const stream = opened.stream;
            upstreamStream = stream;
            upstreamEndpoint = endpoint;

            const parseGuest = createMuxWsFrameParser((kind, bytes) => {
              if (kind === WS_MUX_KIND_CLOSE) {
                if (upstreamStream === stream) {
                  upstreamStream = null;
                  upstreamEndpoint = null;
                }
                return;
              }
              const text = decodeUtf8(bytes);
              if (!closed) {
                Queue.offerUnsafe(outboundQueue, text);
              }
              const parsed = safeJsonParse<Record<string, unknown>>(text);
              if (parsed !== null) {
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                  if (item._tag === "Chunk" && Array.isArray(item.values)) {
                    const sub = subscriptions.get(item.requestId as string | number);
                    if (sub?.tag === ORCHESTRATION_V2_WS_METHODS.subscribeShell) {
                      void runPromise(
                        Effect.gen(function* () {
                          let shellJson = yield* readCacheEntry(
                            node.environmentId,
                            "shellSnapshot",
                          ).pipe(Effect.orElseSucceed(() => null));
                          for (const v of item.values as Array<Record<string, unknown>>) {
                            shellJson = mergeGuestShellChunkIntoCache(shellJson, v);
                          }
                          if (shellJson !== null) {
                            yield* writeCacheEntry(
                              node.environmentId,
                              "shellSnapshot",
                              shellJson,
                            ).pipe(Effect.ignore);
                          }
                        }),
                      );
                    } else if (sub?.tag === ORCHESTRATION_V2_WS_METHODS.subscribeThread) {
                      const tId =
                        typeof sub.payload.threadId === "string" ? sub.payload.threadId : "";
                      for (const v of item.values as Array<Record<string, unknown>>) {
                        if (
                          v.kind === "snapshot" &&
                          typeof v.projection === "object" &&
                          v.projection !== null &&
                          tId
                        ) {
                          void runPromise(
                            writeCacheEntry(
                              node.environmentId,
                              `thread:${tId}`,
                              stringifyJson(v.projection),
                            ).pipe(Effect.ignore),
                          );
                        }
                      }
                    }
                  }
                }
              }
            });

            stream.setConsumer({
              onData: parseGuest,
              onClose: () => {
                if (upstreamStream === stream) {
                  upstreamStream = null;
                  upstreamEndpoint = null;
                }
              },
              onReset: () => {
                if (upstreamStream === stream) {
                  upstreamStream = null;
                  upstreamEndpoint = null;
                }
              },
            });

            // Re-issue every open stream subscription so guest emits authoritative snapshots.
            for (const sub of subscriptions.values()) {
              const payload = stripAfterSequencePayload(sub.payload);
              const bytes = encodeRpcWireObject({
                _tag: "Request",
                id: sub.requestId,
                tag: sub.tag,
                payload,
                headers: sub.headers,
              });
              void stream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, bytes));
            }
          } finally {
            connectingUpstream = false;
          }
        });

        const handle: LiveClientSocketHandle = {
          sessionId: session.sessionId,
          subscriptions,
          sendMessage: queueEncoded,
          notifyUpstreamChange: () => {
            const currentEndpoint = activeTunnels.get(node.environmentId) ?? null;
            if (currentEndpoint === null) {
              upstreamStream = null;
              upstreamEndpoint = null;
              return;
            }
            if (!closed && (upstreamStream === null || upstreamEndpoint !== currentEndpoint)) {
              void runPromise(openAndSpliceUpstream().pipe(Effect.ignore));
            }
          },
          closeImmediate: () => {
            closed = true;
            if (upstreamStream) {
              void upstreamStream.close();
              upstreamStream = null;
              upstreamEndpoint = null;
            }
            transport.destroy();
          },
        };

        const set = liveClientSockets.get(node.environmentId) ?? new Set<LiveClientSocketHandle>();
        set.add(handle);
        liveClientSockets.set(node.environmentId, set);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
            const currentSet = liveClientSockets.get(node.environmentId);
            if (currentSet) {
              currentSet.delete(handle);
              if (currentSet.size === 0) liveClientSockets.delete(node.environmentId);
            }
            if (upstreamStream) {
              void upstreamStream.close();
              upstreamStream = null;
              upstreamEndpoint = null;
            }
          }),
        );

        if (activeTunnels.has(node.environmentId)) {
          yield* openAndSpliceUpstream();
        }

        const writerFiber = Effect.gen(function* () {
          while (true) {
            if (closed) return;
            const msg = yield* Queue.take(outboundQueue);
            yield* writer.write(msg);
          }
        });

        const readerFiber = Effect.gen(function* () {
          while (true) {
            if (closed) return;
            const frames = yield* reader.pull;
            for (const frame of frames) {
              const text = typeof frame === "string" ? frame : decodeUtf8(frame);
              const decoded = safeJsonParse<unknown>(text);
              if (!decoded) continue;
              const msgs = Array.isArray(decoded) ? decoded : [decoded];
              for (const rawMsg of msgs) {
                const msg = rawMsg as Record<string, unknown>;
                if (msg._tag === "Request") {
                  const id = msg.id as string | number;
                  const tag = String(msg.tag ?? "");
                  const payload =
                    typeof msg.payload === "object" && msg.payload !== null
                      ? (msg.payload as Record<string, unknown>)
                      : {};
                  const headers = Array.isArray(msg.headers)
                    ? (msg.headers as ReadonlyArray<[string, string]>)
                    : [];

                  if (tag.includes("subscribe") || tag.includes("Subscribe")) {
                    subscriptions.set(id, { requestId: id, tag, payload, headers });
                  }

                  const canSendUpstream =
                    upstreamStream !== null &&
                    upstreamEndpoint !== null &&
                    upstreamEndpoint === activeTunnels.get(node.environmentId);
                  if (canSendUpstream && upstreamStream !== null) {
                    const bytes = encodeRpcWireObject(msg);
                    void upstreamStream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, bytes));
                    continue;
                  }

                  yield* handleParkedWsRequest(node, session, handle, {
                    id,
                    tag,
                    payload,
                    headers,
                  });
                } else if (msg._tag === "Interrupt") {
                  const requestId = msg.requestId as string | number;
                  subscriptions.delete(requestId);
                  if (
                    upstreamStream !== null &&
                    upstreamEndpoint !== null &&
                    upstreamEndpoint === activeTunnels.get(node.environmentId)
                  ) {
                    const bytes = encodeRpcWireObject(msg);
                    void upstreamStream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, bytes));
                  } else {
                    queueEncoded({
                      _tag: "Exit",
                      requestId,
                      exit: { _tag: "Success", value: undefined },
                    });
                  }
                } else if (msg._tag === "Ping") {
                  if (
                    upstreamStream !== null &&
                    upstreamEndpoint !== null &&
                    upstreamEndpoint === activeTunnels.get(node.environmentId)
                  ) {
                    const bytes = encodeRpcWireObject(msg);
                    void upstreamStream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, bytes));
                  } else {
                    queueEncoded({ _tag: "Pong" });
                  }
                } else if (
                  msg._tag === "Ack" &&
                  upstreamStream !== null &&
                  upstreamEndpoint !== null &&
                  upstreamEndpoint === activeTunnels.get(node.environmentId)
                ) {
                  const bytes = encodeRpcWireObject(msg);
                  void upstreamStream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, bytes));
                }
              }
            }
          }
        });

        yield* Effect.raceFirst(writerFiber, readerFiber).pipe(Effect.ignore);
      }),
    ).pipe(Effect.ignore);

    return HttpServerResponse.empty();
  });

  const handlePortalHttpOrWs = Effect.fn("FleetHubService.handlePortalHttpOrWs")(function* (
    node: FleetNodeRecord,
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    portalRest: string,
  ) {
    const match = /^\/(\d+)(\/.*)?$/.exec(portalRest);
    if (!match) {
      return HttpServerResponse.text("Invalid portal path", { status: 400 });
    }
    const port = Number(match[1]);
    const forwardPath = `${match[2] || "/"}${url.search}`;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return HttpServerResponse.text("Invalid portal port", { status: 400 });
    }

    let endpoint = activeTunnels.get(node.environmentId) ?? null;
    if (endpoint === null && node.sandboxId !== null && sandboxCallbacks !== null) {
      yield* sandboxCallbacks.wakeSandbox(node.sandboxId);
      endpoint = yield* waitForActiveTunnel(node.environmentId, 45_000);
    }
    if (endpoint === null) {
      return HttpServerResponse.text("Sandbox unavailable for portal", { status: 503 });
    }

    const tcpOpened = yield* Effect.tryPromise({
      try: () => endpoint.openStream({ kind: "tcp", host: "127.0.0.1", port }),
      catch: (cause) => new FleetHubError({ message: String(cause), cause }),
    }).pipe(Effect.orElseSucceed(() => null));

    if (tcpOpened === null) {
      return HttpServerResponse.text(`Portal target port ${port} refused connection`, {
        status: 502,
      });
    }

    const bodyBytes =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : yield* request.arrayBuffer.pipe(
            Effect.map((buf) => new Uint8Array(buf)),
            Effect.orElseSucceed(() => new Uint8Array(0)),
          );

    const duplex = createMuxStreamDuplex(tcpOpened.stream);
    const reqHeaders = toArrayHeaders(request.headers);
    delete reqHeaders.host;
    delete reqHeaders.authorization;
    delete reqHeaders.dpop;
    delete reqHeaders.cookie;
    delete reqHeaders["accept-encoding"];

    const portalRes = yield* Effect.tryPromise({
      try: () =>
        new Promise<{
          readonly status: number;
          readonly headers: Readonly<Record<string, string>>;
          readonly body: Uint8Array;
        }>((resolve, reject) => {
          const upstreamReq = NodeHttp.request(
            {
              createConnection: () => duplex as unknown as NodeNet.Socket,
              host: "127.0.0.1",
              port,
              path: forwardPath,
              method: request.method,
              headers: {
                ...reqHeaders,
                connection: "close",
              },
            },
            (res) => {
              const chunks: Array<Buffer> = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                const outHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                  if (v === undefined || k === "transfer-encoding" || k === "connection") continue;
                  outHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
                }
                resolve({
                  status: res.statusCode ?? 200,
                  headers: outHeaders,
                  body: Buffer.concat(chunks),
                });
              });
            },
          );
          upstreamReq.on("error", reject);
          if (bodyBytes && bodyBytes.byteLength > 0) {
            upstreamReq.write(bodyBytes);
          }
          upstreamReq.end();
        }),
      catch: (cause) => new FleetHubError({ message: String(cause), cause }),
    }).pipe(Effect.orElseSucceed(() => null));

    if (portalRes === null) {
      return HttpServerResponse.text("Bad Gateway", { status: 502 });
    }
    return HttpServerResponse.uint8Array(portalRes.body, {
      status: portalRes.status,
      headers: portalRes.headers,
    });
  });

  const forwardHttpRequestThroughEndpoint = Effect.fn("FleetHubService.forwardHttp")(function* (
    endpoint: FleetMuxEndpoint,
    request: HttpServerRequest.HttpServerRequest,
    pathWithQuery: string,
    overrideHeaders?: Readonly<Record<string, string>>,
    extraHeaders?: Readonly<Record<string, string>>,
  ) {
    const bodyBytes =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : yield* request.arrayBuffer.pipe(
            Effect.map((buf) => new Uint8Array(buf)),
            Effect.orElseSucceed(() => null),
          );
    const reqHeaders = toArrayHeaders(request.headers);
    if (overrideHeaders) {
      delete reqHeaders.authorization;
      delete reqHeaders.cookie;
      delete reqHeaders.dpop;
      Object.assign(reqHeaders, overrideHeaders);
    }
    if (extraHeaders) {
      Object.assign(reqHeaders, extraHeaders);
    }

    const res = yield* Effect.tryPromise({
      try: () =>
        forwardHttpOverMux(endpoint, {
          method: request.method,
          path: pathWithQuery,
          headers: reqHeaders,
          body: bodyBytes,
        }),
      catch: (cause) => new FleetHubError({ message: String(cause), cause }),
    }).pipe(Effect.orElseSucceed(() => null));

    if (res === null) {
      return HttpServerResponse.text("Guest Mux Error", { status: 502 });
    }

    const streamBody = Stream.fromAsyncIterable(
      res.chunks,
      (cause) => new FleetHubError({ message: String(cause), cause }),
    );
    const flatHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (k === "transfer-encoding" || k === "connection") continue;
      flatHeaders[k] = typeof v === "string" ? v : v.join(", ");
    }
    return HttpServerResponse.stream(streamBody, {
      status: res.status,
      headers: flatHeaders,
    });
  });

  const handleEnvRequestInner = Effect.fn("FleetHubService.handleEnvRequest")(function* (
    request: HttpServerRequest.HttpServerRequest,
    environmentId: EnvironmentId,
    rawSubPath: string,
  ) {
    const node = yield* getNode(environmentId).pipe(Effect.orElseSucceed(() => null));
    if (node === null) {
      return HttpServerResponse.jsonUnsafe(
        { code: "not_found", reason: "environment_not_found" },
        { status: 404 },
      );
    }
    const parsedUrl = requestUrl(request);
    if (Option.isNone(parsedUrl)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const url = parsedUrl.value;
    const subPath =
      rawSubPath.length === 0 ? "/" : rawSubPath.startsWith("/") ? rawSubPath : `/${rawSubPath}`;
    const innerPath = stripVirtualEnvironmentPrefix(url.pathname)?.innerPath ?? url.pathname;
    const strippedPathAndQuery = `${innerPath}${url.search}`;
    const forwardedPrefixHeaders: Readonly<Record<string, string>> = {
      [T3_FORWARDED_PREFIX_HEADER]: `/_env/${environmentId}`,
      "x-forwarded-host": url.host,
      ...(url.protocol === "https:" ? { "x-forwarded-proto": "https" } : {}),
    };

    if (node.authMode === "runner_passthrough") {
      const endpoint = activeTunnels.get(environmentId);
      if (!endpoint) {
        return HttpServerResponse.text("Runner offline", { status: 503 });
      }
      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        const opened = yield* Effect.tryPromise({
          try: () =>
            endpoint.openStream({
              kind: "ws",
              path: strippedPathAndQuery,
              headers: { ...toArrayHeaders(request.headers), ...forwardedPrefixHeaders },
            }),
          catch: (cause) => new FleetHubError({ message: String(cause), cause }),
        }).pipe(Effect.orElseSucceed(() => null));
        if (opened === null) {
          return HttpServerResponse.text("Upstream WebSocket failed", { status: 502 });
        }
        const socket = yield* request.upgrade.pipe(Effect.orDie);
        yield* bridgeEffectSocketToMuxWs(socket, opened.stream);
        return HttpServerResponse.empty();
      }
      return yield* forwardHttpRequestThroughEndpoint(
        endpoint,
        request,
        strippedPathAndQuery,
        undefined,
        forwardedPrefixHeaders,
      );
    }

    if (request.method === "GET" && subPath === "/.well-known/t3/environment") {
      const cached = yield* readCacheEntry(environmentId, "descriptor").pipe(
        Effect.orElseSucceed(() => node.descriptorJson),
      );
      if (cached !== null) {
        return HttpServerResponse.text(cached, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const endpoint = activeTunnels.get(environmentId);
      if (!endpoint) {
        return HttpServerResponse.text("Descriptor unavailable", { status: 503 });
      }
      return yield* forwardHttpRequestThroughEndpoint(
        endpoint,
        request,
        "/.well-known/t3/environment",
        undefined,
        forwardedPrefixHeaders,
      );
    }

    const authHandled = yield* handleHubAuthorityAuth(node, request, url, subPath);
    if (authHandled !== null) {
      return authHandled;
    }

    if (subPath === "/ws" && request.headers.upgrade?.toLowerCase() === "websocket") {
      return yield* handleHubAuthorityWs(node, request, url);
    }

    if (
      subPath === "/mcp" ||
      subPath.startsWith("/mcp/") ||
      subPath.startsWith("/oauth/mcp") ||
      subPath.startsWith("/.well-known/oauth-")
    ) {
      let endpoint = activeTunnels.get(environmentId) ?? null;
      if (endpoint === null && node.sandboxId !== null && sandboxCallbacks !== null) {
        yield* sandboxCallbacks.wakeSandbox(node.sandboxId);
        endpoint = yield* waitForActiveTunnel(environmentId, 45_000);
      }
      if (endpoint === null) {
        return HttpServerResponse.text("Sandbox offline", { status: 503 });
      }
      return yield* forwardHttpRequestThroughEndpoint(
        endpoint,
        request,
        strippedPathAndQuery,
        undefined,
        forwardedPrefixHeaders,
      );
    }

    const session = yield* verifyClientAuth(environmentId, request, url, {
      allowWsTicket: subPath === "/api/preview/tunnel" || subPath.startsWith("/portal/"),
    });
    if (session === null) {
      return HttpServerResponse.jsonUnsafe(
        { code: "auth_invalid", reason: "invalid_credential" },
        { status: 401 },
      );
    }

    if (subPath.startsWith("/portal/")) {
      return yield* handlePortalHttpOrWs(node, request, url, subPath.slice("/portal".length));
    }

    if (
      subPath === "/api/preview/tunnel" &&
      request.headers.upgrade?.toLowerCase() === "websocket"
    ) {
      const port = Number(url.searchParams.get("port"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return HttpServerResponse.text("Missing valid port", { status: 400 });
      }
      let endpoint = activeTunnels.get(environmentId) ?? null;
      if (endpoint === null && node.sandboxId !== null && sandboxCallbacks !== null) {
        yield* sandboxCallbacks.wakeSandbox(node.sandboxId);
        endpoint = yield* waitForActiveTunnel(environmentId, 45_000);
      }
      if (!endpoint) return HttpServerResponse.text("Sandbox offline", { status: 503 });
      const opened = yield* Effect.tryPromise({
        try: () => endpoint.openStream({ kind: "tcp", host: "127.0.0.1", port }),
        catch: (cause) => new FleetHubError({ message: String(cause), cause }),
      }).pipe(Effect.orElseSucceed(() => null));
      if (!opened)
        return HttpServerResponse.text("Preview target refused connection", { status: 502 });
      const clientSocket = yield* request.upgrade.pipe(Effect.orDie);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* clientSocket.writer;
          const reader = yield* clientSocket.reader;
          const inboundQueue = yield* Queue.unbounded<Uint8Array | null>();
          opened.stream.setConsumer({
            onData: (chunk) => {
              Queue.offerUnsafe(inboundQueue, chunk);
            },
            onClose: () => {
              Queue.offerUnsafe(inboundQueue, null);
            },
            onReset: () => {
              Queue.offerUnsafe(inboundQueue, null);
            },
          });
          const pumpIn = Effect.gen(function* () {
            while (true) {
              const chunk = yield* Queue.take(inboundQueue);
              if (chunk === null) return;
              yield* writer.write(chunk);
            }
          });
          const pumpOut = Effect.gen(function* () {
            while (true) {
              const frames = yield* reader.pull;
              for (const frame of frames) {
                const bytes = typeof frame === "string" ? encodeUtf8(frame) : frame;
                void opened.stream.write(bytes);
              }
            }
          });
          yield* Effect.raceFirst(pumpIn, pumpOut).pipe(Effect.ignore);
          void opened.stream.close();
        }),
      );
      return HttpServerResponse.empty();
    }

    if (request.method === "GET" && subPath === "/api/orchestration/shell") {
      const cached = yield* readCacheEntry(environmentId, "shellSnapshot").pipe(
        Effect.orElseSucceed(() => null),
      );
      const endpoint = activeTunnels.get(environmentId);
      if (endpoint === undefined && cached !== null) {
        return HttpServerResponse.text(cached, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (endpoint !== undefined) {
        const guestHeaders = yield* getGuestBearerHeaders(environmentId);
        return yield* forwardHttpRequestThroughEndpoint(
          endpoint,
          request,
          strippedPathAndQuery,
          guestHeaders,
          forwardedPrefixHeaders,
        );
      }
      if (cached !== null) {
        return HttpServerResponse.text(cached, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (request.method === "GET" && subPath.startsWith("/api/orchestration/threads/")) {
      const endpoint = activeTunnels.get(environmentId);
      if (endpoint === undefined) {
        const rest = subPath.slice("/api/orchestration/threads/".length);
        const parts = rest.split("/");
        const threadId = parts[0] ?? "";
        const cached = yield* readCacheEntry(environmentId, `thread:${threadId}`).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (cached !== null) {
          const proj = safeJsonParse<Record<string, unknown>>(cached);
          if (parts[1] === "bounded" && proj !== null) {
            return HttpServerResponse.jsonUnsafe({
              snapshotSequence: 1,
              projection: proj,
              historyCursor: null,
              hasMoreHistory: false,
              latestLocalTurnOrdinal: null,
            });
          }
          if (parts.length === 1 && proj !== null) {
            return HttpServerResponse.jsonUnsafe({
              snapshotSequence: 1,
              projection: proj,
            });
          }
        }
      }
    }

    if (request.method === "GET" && subPath === "/api/projects") {
      const endpoint = activeTunnels.get(environmentId);
      if (endpoint === undefined) {
        const cached = yield* readCacheEntry(environmentId, "shellSnapshot").pipe(
          Effect.orElseSucceed(() => null),
        );
        const shell = cached
          ? safeJsonParse<{ readonly projects?: Array<Record<string, unknown>> }>(cached)
          : null;
        if (shell !== null) {
          return HttpServerResponse.jsonUnsafe({
            projects: shell.projects ?? [],
            updatedAt: formatIsoUtc(yield* Clock.currentTimeMillis),
          });
        }
      }
    }

    let endpoint = activeTunnels.get(environmentId) ?? null;
    if (endpoint === null && node.sandboxId !== null && sandboxCallbacks !== null) {
      yield* sandboxCallbacks.wakeSandbox(node.sandboxId);
      endpoint = yield* waitForActiveTunnel(environmentId, 45_000);
    }
    if (endpoint === null) {
      return HttpServerResponse.text("Sandbox did not connect in time", { status: 503 });
    }
    const guestHeaders = yield* getGuestBearerHeaders(environmentId);
    if (request.headers.upgrade?.toLowerCase() === "websocket") {
      const opened = yield* Effect.tryPromise({
        try: () =>
          endpoint.openStream({
            kind: "ws",
            path: strippedPathAndQuery,
            headers: guestHeaders,
          }),
        catch: (cause) => new FleetHubError({ message: String(cause), cause }),
      }).pipe(Effect.orElseSucceed(() => null));
      if (opened === null) return HttpServerResponse.text("Bad Gateway", { status: 502 });
      const socket = yield* request.upgrade.pipe(Effect.orDie);
      yield* bridgeEffectSocketToMuxWs(socket, opened.stream);
      return HttpServerResponse.empty();
    }

    return yield* forwardHttpRequestThroughEndpoint(
      endpoint,
      request,
      strippedPathAndQuery,
      guestHeaders,
      forwardedPrefixHeaders,
    );
  });

  const handleEnvRequest: FleetHubService["Service"]["handleEnvRequest"] = Effect.fn(
    "FleetHubService.handleEnvRequest",
  )(function* (request, environmentId, subPath) {
    return yield* handleEnvRequestInner(request, environmentId, subPath).pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  });

  const handleBootstrapHttp: FleetHubService["Service"]["handleBootstrapHttp"] = Effect.fn(
    "FleetHubService.handleBootstrapHttp",
  )(function* (request, token) {
    const authHeader = request.headers.authorization;
    const secret = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
    const rows = yield* sql`
      SELECT * FROM sandbox_fleet_nodes
      WHERE environment_id = ${token} OR sandbox_id = ${token}
    `.pipe(Effect.orElseSucceed(() => []));
    const decoded = rows[0]
      ? yield* decodeNodeRow(rows[0]).pipe(Effect.orElseSucceed(() => null))
      : null;
    if (decoded === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const node = rowToNode(decoded);
    if (!secret || !constantTimeHexMatch(sha256Hex(secret), node.nodeSecretHash)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const url = requestUrl(request);
    const connectOrigin =
      url._tag === "Some"
        ? `${url.value.protocol === "https:" ? "wss:" : "ws:"}//${url.value.host}/_fleet/connect`
        : null;
    const manifest = yield* buildBootstrapManifestJson(node.environmentId, connectOrigin).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (manifest === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return HttpServerResponse.text(manifest, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });

  const handleConnectWs: FleetHubService["Service"]["handleConnectWs"] = Effect.fn(
    "FleetHubService.handleConnectWs",
  )(function* (request) {
    const parsed = requestUrl(request);
    if (Option.isNone(parsed)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const url = parsed.value;
    const envIdRaw = url.searchParams.get("environmentId");
    const secret =
      url.searchParams.get("secret") ??
      (request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length).trim()
        : null);
    const role = url.searchParams.get("role") === "runner" ? "runner" : "sandbox";
    const label = url.searchParams.get("label") ?? "Runner";

    if (!envIdRaw || !secret) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const environmentId = EnvironmentId.make(envIdRaw);
    const existing = yield* getNode(environmentId).pipe(Effect.orElseSucceed(() => null));

    if (role === "runner") {
      if (existing !== null) {
        if (!constantTimeHexMatch(sha256Hex(secret), existing.nodeSecretHash)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
      } else {
        yield* registerRunnerNode({ environmentId, label, nodeSecret: secret }).pipe(Effect.orDie);
      }
    } else {
      if (existing === null || !constantTimeHexMatch(sha256Hex(secret), existing.nodeSecretHash)) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
    }

    const socket = yield* request.upgrade.pipe(Effect.orDie);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
          initiator: false,
          onStream: (stream, target) => handleInboundMuxStream(environmentId, stream, target),
          onControl: handleControlMap(environmentId),
        });
        const runFiber = yield* run.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeTunnels.get(environmentId) === endpoint) {
                activeTunnels.delete(environmentId);
              }
              const sockets = liveClientSockets.get(environmentId);
              if (sockets) {
                for (const handle of sockets) handle.notifyUpstreamChange();
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* attachTunnel(environmentId, endpoint);
        yield* Fiber.join(runFiber);
      }),
    ).pipe(Effect.ignore);

    return HttpServerResponse.empty();
  });

  const handleInternalMuxRequest: FleetHubService["Service"]["handleInternalMuxRequest"] =
    Effect.fn("FleetHubService.handleInternalMuxRequest")(
      function* (request, secret, environmentId, subPath) {
        if (!constantTimeHexMatch(sha256Hex(secret), sha256Hex(internalSecret))) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const endpoint = activeTunnels.get(environmentId);
        if (!endpoint) {
          return HttpServerResponse.text("No active mux tunnel", { status: 503 });
        }
        const parsed = requestUrl(request);
        const search = parsed._tag === "Some" ? parsed.value.search : "";
        const guestPath = `${subPath.length === 0 ? "/" : subPath.startsWith("/") ? subPath : `/${subPath}`}${search}`;
        if (request.headers.upgrade?.toLowerCase() === "websocket") {
          const opened = yield* Effect.tryPromise({
            try: () =>
              endpoint.openStream({
                kind: "ws",
                path: guestPath,
                headers: toArrayHeaders(request.headers),
              }),
            catch: (cause) => new FleetHubError({ message: String(cause), cause }),
          }).pipe(Effect.orElseSucceed(() => null));
          if (opened === null) return HttpServerResponse.text("Bad Gateway", { status: 502 });
          const socket = yield* request.upgrade.pipe(Effect.orDie);
          yield* bridgeEffectSocketToMuxWs(socket, opened.stream);
          return HttpServerResponse.empty();
        }
        return yield* forwardHttpRequestThroughEndpoint(endpoint, request, guestPath);
      },
    );

  const listCachedPendingInboxCount: FleetHubService["Service"]["listCachedPendingInboxCount"] =
    Effect.fn("FleetHubService.listCachedPendingInboxCount")(function* (environmentId) {
      const rows = yield* sql<{ readonly cnt: number }>`
        SELECT count(*) AS cnt FROM sandbox_inbox
        WHERE environment_id = ${environmentId} AND delivered_at IS NULL
      `.pipe(dbError("Failed to count pending inbox rows."));
      return rows[0]?.cnt ?? 0;
    });

  return FleetHubService.of({
    internalSecret,
    setHubPort: (port) => {
      hubPort = port;
    },
    getHubPort: () => hubPort,
    registerSandboxCallbacks: (callbacks) => {
      sandboxCallbacks = callbacks;
    },
    registerSandboxNode,
    registerRunnerNode,
    getNode,
    buildBootstrapManifestJson,
    handleBootstrapHttp,
    handleConnectWs,
    handleInternalMuxRequest,
    handleEnvRequest,
    attachTunnel,
    ensureBoatReverseTunnel,
    hasActiveTunnel: (environmentId) => activeTunnels.has(environmentId),
    getInternalBridgeUrl: (environmentId) =>
      hubPort !== null && activeTunnels.has(environmentId)
        ? `http://127.0.0.1:${hubPort}/_fleet/internal/${internalSecret}/${environmentId}`
        : null,
    probeGuestEnvironmentId,
    notifyGuestReadyForInbox,
    issuePairingCredential,
    revokeSession,
    revokeNode,
    listPeers,
    listCachedPendingInboxCount,
  });
});

export const layer = Layer.effect(FleetHubService, make);
