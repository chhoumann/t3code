/**
 * SSRF IP validation and `t3 runner` CLI command implementation.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { type FleetStreamAck, type FleetStreamTarget } from "@t3tools/shared/fleetMux";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import {
  attachMuxToEffectSocket,
  bridgeMuxStreamToTcp,
  serveMuxHttpToLocalOrigin,
  serveMuxWsToLocalOrigin,
} from "../fleet/fleetMuxNode.ts";

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    value = (value << 8) | byte;
  }
  return value >>> 0;
}

function inCidr4(ip: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

// Reject private, loopback, link-local, CGNAT/Tailscale, and reserved/multicast IPv4 ranges.
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
];

export function isBlockedPrivateAddress(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase().split("%")[0] ?? "";
  if (ip.length === 0) return true;

  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inCidr4(v4, base, prefix));
  }

  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    return isBlockedPrivateAddress(mapped);
  }

  if (ip === "::" || ip === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true; // ff00::/8 multicast
  return false;
}

async function resolvePublicTargetAddress(
  host: string,
): Promise<{ readonly address: string; readonly family: 4 | 6 }> {
  const literalFamily = NodeNet.isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedPrivateAddress(host)) {
      throw new Error(`Blocked private or reserved destination IP: ${host}`);
    }
    return { address: host, family: literalFamily };
  }

  const records = await NodeDnsPromises.lookup(host, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`Could not resolve hostname: ${host}`);
  }
  for (const record of records) {
    if (isBlockedPrivateAddress(record.address)) {
      throw new Error(`Resolved address ${record.address} for ${host} is blocked.`);
    }
  }
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

export function startSsrfSafeHttpProxyServer(listenHost = "127.0.0.1", listenPort = 0) {
  const server = NodeHttp.createServer((req, res) => {
    const rawUrl = req.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.writeHead(400);
      res.end("Bad proxy target URL");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      res.writeHead(403);
      res.end("Unsupported protocol");
      return;
    }
    void resolvePublicTargetAddress(parsed.hostname)
      .then(({ address }) => {
        const port = parsed.port ? Number(parsed.port) : 80;
        const headers: NodeHttp.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || k.toLowerCase() === "proxy-connection") continue;
          headers[k] = v;
        }
        headers.host = parsed.host;
        const upstream = NodeHttp.request(
          {
            hostname: address,
            port,
            path: `${parsed.pathname}${parsed.search}`,
            method: req.method,
            headers,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", (err) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(err.message);
        });
        req.pipe(upstream);
      })
      .catch((err) => {
        res.writeHead(403);
        res.end(err instanceof Error ? err.message : "Forbidden");
      });
  });

  server.on("connect", (req, clientSocket, head) => {
    const rawTarget = req.url ?? "";
    const lastColon = rawTarget.lastIndexOf(":");
    const host =
      lastColon === -1 ? rawTarget : rawTarget.slice(0, lastColon).replace(/^\[|\]$/g, "");
    const port = lastColon === -1 ? 443 : Number(rawTarget.slice(lastColon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    void resolvePublicTargetAddress(host)
      .then(({ address, family }) => {
        const upstream = NodeNet.connect({ host: address, port, family }, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.byteLength > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => {
          if (!clientSocket.destroyed) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.destroy();
          }
        });
      })
      .catch(() => {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
      });
  });

  return new Promise<{ readonly port: number; readonly close: () => Promise<void> }>(
    (resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, listenHost, () => {
        server.off("error", reject);
        const addr = server.address() as NodeNet.AddressInfo;
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      });
    },
  );
}

const hubUrlFlag = Flag.String("hub").pipe(
  Flag.withDescription("Hub base URL or /_fleet/connect WebSocket URL."),
);
const environmentIdFlag = Flag.String("environment-id").pipe(
  Flag.withDescription(
    "Runner environment id registered on the Hub (defaults to local server id).",
  ),
  Flag.optional,
);
const secretFlag = Flag.String("secret").pipe(
  Flag.withDescription("Node secret issued when enrolling this runner on the Hub."),
  Flag.optional,
);
const localOriginFlag = Flag.String("local-origin").pipe(
  Flag.withDescription("Local T3 server origin to expose through the runner tunnel."),
  Flag.withDefault("http://127.0.0.1:3773"),
);
const shareNetworkFlag = Flag.Boolean("share-network").pipe(
  Flag.withDescription("Expose an SSRF-safe outbound HTTP CONNECT proxy over the runner mux."),
  Flag.withDefault(false),
);

function buildHubWsConnectUrl(input: {
  readonly hub: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly role: "sandbox" | "runner";
}): string {
  const url = new URL(input.hub);
  if (!url.pathname.endsWith("/_fleet/connect")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/_fleet/connect`;
  }
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.searchParams.set("environmentId", input.environmentId);
  url.searchParams.set("secret", input.secret);
  url.searchParams.set("role", input.role);
  return url.toString();
}

function readRunnerEnvSecret(): string | undefined {
  return process.env.T3_NODE_SECRET;
}

const DescriptorEnvironmentSchema = Schema.Struct({
  environmentId: Schema.String,
});

const fetchDescriptorOverHttpClient = Effect.fn("runner.fetchDescriptorEnvironmentId")(function* (
  localOrigin: string,
) {
  const client = yield* HttpClient.HttpClient;
  const req = HttpClientRequest.get(
    `${localOrigin.replace(/\/+$/, "")}/.well-known/t3/environment`,
  );
  const res = yield* client.execute(req);
  const body = yield* HttpClientResponse.schemaBodyJson(DescriptorEnvironmentSchema)(res);
  return body.environmentId;
});

const runnerStartCommand = Command.make("start", {
  hub: hubUrlFlag,
  environmentId: environmentIdFlag,
  secret: secretFlag,
  localOrigin: localOriginFlag,
  shareNetwork: shareNetworkFlag,
}).pipe(
  Command.withDescription(
    "Attach this machine as a self-hosted persistent T3 runner keeping its own local session authority.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const secret = Option.getOrUndefined(flags.secret) ?? readRunnerEnvSecret();
      if (secret === undefined || secret.trim().length === 0) {
        return yield* new CliError.UserError({
          cause: "missing runner secret",
          userMessage: "Pass --secret <token> or set T3_NODE_SECRET to attach a runner.",
        });
      }

      let environmentId = Option.getOrUndefined(flags.environmentId);
      if (environmentId === undefined) {
        environmentId = yield* fetchDescriptorOverHttpClient(flags.localOrigin).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage: `Could not reach local T3 server at ${flags.localOrigin}. Pass --environment-id or start T3 first.`,
              }),
          ),
        );
      }

      const proxy = flags.shareNetwork
        ? yield* Effect.acquireRelease(
            Effect.promise(() => startSsrfSafeHttpProxyServer("127.0.0.1", 0)),
            (started) => Effect.promise(() => started.close()),
          )
        : null;

      const wsUrl = buildHubWsConnectUrl({
        hub: flags.hub,
        environmentId,
        secret: secret.trim(),
        role: "runner",
      });

      yield* Console.log(
        `Connecting runner ${environmentId} to ${wsUrl} -> ${flags.localOrigin}${proxy ? ` (network proxy 127.0.0.1:${proxy.port})` : ""}`,
      );

      while (true) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* Socket.makeWebSocket(wsUrl, { openTimeout: "15 seconds" }).pipe(
              Effect.provide(NodeSocket.layerWebSocketConstructor),
            );
            const { run } = yield* attachMuxToEffectSocket(socket, {
              initiator: true,
              onStream: (
                stream,
                target: FleetStreamTarget,
              ): Promise<FleetStreamAck> | FleetStreamAck => {
                if (target.kind === "http") {
                  return serveMuxHttpToLocalOrigin(stream, target, flags.localOrigin);
                }
                if (target.kind === "ws") {
                  return serveMuxWsToLocalOrigin(stream, target, flags.localOrigin);
                }
                if (target.kind === "tcp") {
                  if (proxy !== null && target.host === "127.43.0.10" && target.port === 3128) {
                    return bridgeMuxStreamToTcp(stream, { host: "127.0.0.1", port: proxy.port });
                  }
                  return bridgeMuxStreamToTcp(stream, { host: target.host, port: target.port });
                }
                return { ok: false, error: "Unsupported runner stream target" };
              },
            });
            yield* run;
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Console.error(`Runner tunnel disconnected; reconnecting: ${String(cause)}`),
          ),
        );
        yield* Effect.sleep("2 seconds");
      }
    }).pipe(Effect.scoped),
  ),
);

export const runnerCommand = Command.make("runner").pipe(
  Command.withDescription("Run a persistent self-hosted compute runner connected to a Hub."),
  Command.withSubcommands([runnerStartCommand]),
);
