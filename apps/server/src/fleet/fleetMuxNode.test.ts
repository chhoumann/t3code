// @effect-diagnostics nodeBuiltinImport:off
import { createInMemoryMuxPair } from "@t3tools/shared/fleetMux";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  bridgeMuxStreamToTcp,
  createLoopbackForwarder,
  createMuxWsFrameParser,
  encodeMuxWsFrame,
  forwardHttpOverMux,
  mergeFleetHostsContent,
  serveMuxHttpToLocalOrigin,
  syncFleetHostsFile,
  WS_MUX_KIND_BINARY,
  WS_MUX_KIND_TEXT,
} from "./fleetMuxNode.ts";

describe("fleetMuxNode", () => {
  it("streams HTTP requests and SSE chunks over FleetMux to a local origin", async () => {
    const server = NodeHttp.createServer((req, res) => {
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        res.write("data: two\n\n");
        res.end();
        return;
      }
      const parts: Array<Buffer> = [];
      req.on("data", (chunk: Buffer) => parts.push(chunk));
      req.on("end", () => {
        res.writeHead(201, {
          "content-type": "application/json",
          "x-echo-prefix": String(req.headers["x-t3-forwarded-prefix"] ?? ""),
        });
        res.end(JSON.stringify({ received: Buffer.concat(parts).toString("utf8") }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as NodeNet.AddressInfo;
    const localOrigin = `http://127.0.0.1:${addr.port}`;

    try {
      const { client, server: guestMux } = createInMemoryMuxPair();
      guestMux.onOpenStream((stream, target) => {
        if (target.kind === "http") {
          return serveMuxHttpToLocalOrigin(stream, target, localOrigin);
        }
        return { ok: false, error: "unsupported" };
      });

      const postRes = await forwardHttpOverMux(client, {
        method: "POST",
        path: "/api/test",
        headers: {
          "content-type": "text/plain",
          "x-t3-forwarded-prefix": "/_env/env-1",
        },
        body: new TextEncoder().encode("hello mux"),
      });
      assert.strictEqual(postRes.status, 201);
      assert.strictEqual(postRes.headers["x-echo-prefix"], "/_env/env-1");
      const postChunks: Array<Uint8Array> = [];
      for await (const chunk of postRes.chunks) {
        postChunks.push(chunk);
      }
      const postText = Buffer.concat(postChunks.map((c) => Buffer.from(c))).toString("utf8");
      assert.deepStrictEqual(JSON.parse(postText), { received: "hello mux" });

      const sseRes = await forwardHttpOverMux(client, {
        method: "GET",
        path: "/sse",
        headers: {},
      });
      assert.strictEqual(sseRes.status, 200);
      const sseChunks: Array<Uint8Array> = [];
      for await (const chunk of sseRes.chunks) {
        sseChunks.push(chunk);
      }
      const sseText = Buffer.concat(sseChunks.map((c) => Buffer.from(c))).toString("utf8");
      assert.strictEqual(sseText, "data: one\n\ndata: two\n\n");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bridges loopback TCP forwarder through FleetMux to a local server", async () => {
    const echoServer = NodeNet.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("end", () => socket.end());
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    const echoPort = (echoServer.address() as NodeNet.AddressInfo).port;

    const { client, server: guestMux } = createInMemoryMuxPair();
    guestMux.onOpenStream((stream, target) => {
      if (target.kind === "tcp") {
        return bridgeMuxStreamToTcp(stream, { host: target.host, port: target.port });
      }
      return { ok: false, error: "unsupported" };
    });

    const forwarder = await createLoopbackForwarder({
      bindHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: echoPort,
      getEndpoint: () => client,
    });

    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const sock = NodeNet.connect({ host: "127.0.0.1", port: forwarder.port });
        const parts: Array<Buffer> = [];
        sock.on("data", (chunk) => parts.push(chunk));
        sock.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        sock.on("error", reject);
        sock.write("ping-exposed-port");
        sock.end();
      });
      assert.strictEqual(echoed, "ping-exposed-port");
    } finally {
      await forwarder.close();
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it("frames partial and coalesced WS-over-Mux packets losslessly", () => {
    const received: Array<{ readonly kind: number; readonly text: string }> = [];
    const parse = createMuxWsFrameParser((kind, payload) => {
      received.push({ kind, text: new TextDecoder().decode(payload) });
    });
    const f1 = encodeMuxWsFrame(WS_MUX_KIND_TEXT, new TextEncoder().encode("alpha"));
    const f2 = encodeMuxWsFrame(WS_MUX_KIND_BINARY, new TextEncoder().encode("beta-bin"));
    const merged = new Uint8Array(f1.length + f2.length);
    merged.set(f1, 0);
    merged.set(f2, f1.length);

    parse(merged.subarray(0, 3));
    parse(merged.subarray(3, 12));
    parse(merged.subarray(12));

    assert.deepStrictEqual(received, [
      { kind: WS_MUX_KIND_TEXT, text: "alpha" },
      { kind: WS_MUX_KIND_BINARY, text: "beta-bin" },
    ]);
  });

  it("idempotently replaces only the T3 fleet block in hosts files", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosts-"));
    const hostsPath = NodePath.join(tempDir, "hosts");
    try {
      NodeFS.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
      const first = syncFleetHostsFile([{ ip: "127.43.0.1", host: "hub.t3.internal" }], hostsPath);
      assert.isTrue(first);
      const second = syncFleetHostsFile(
        [
          { ip: "127.43.0.1", host: "hub.t3.internal" },
          { ip: "127.43.0.2", host: "box-1.fleet.t3.internal" },
        ],
        hostsPath,
      );
      assert.isTrue(second);
      const text = NodeFS.readFileSync(hostsPath, "utf8");
      assert.include(text, "127.0.0.1 localhost\n");
      assert.strictEqual(text.match(/BEGIN T3 FLEET HOSTS/g)?.length, 1);
      assert.include(text, "127.43.0.2 box-1.fleet.t3.internal");
      assert.strictEqual(mergeFleetHostsContent(text, []), "127.0.0.1 localhost\n");
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
