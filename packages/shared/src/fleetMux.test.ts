import { describe, expect, it } from "vite-plus/test";

import {
  FLEET_DEFAULT_WINDOW_BYTES,
  createInMemoryMuxPair,
  decodeFleetFrame,
  encodeFleetFrame,
  FLEET_FRAME_DATA,
} from "./fleetMux.ts";

describe("fleetMux", () => {
  it("encodes and decodes binary frames without copying corrupted headers", () => {
    const payload = new TextEncoder().encode("hello-mux");
    const encoded = encodeFleetFrame(FLEET_FRAME_DATA, 42, payload);
    const decoded = decodeFleetFrame(encoded);
    expect(decoded.type).toBe(FLEET_FRAME_DATA);
    expect(decoded.streamId).toBe(42);
    expect(new TextDecoder().decode(decoded.payload)).toBe("hello-mux");
  });

  it("transfers payloads larger than the credit window across interleaved streams with zero corruption", async () => {
    const { client, server } = createInMemoryMuxPair();
    const receivedBulk: Array<Uint8Array> = [];
    let receivedEcho = "";
    const bulkDone = Promise.withResolvers<void>();
    const echoDone = Promise.withResolvers<void>();

    server.onOpenStream((stream, target) => {
      if (target.kind === "http" && target.path === "/bulk") {
        stream.setConsumer({
          onData: (chunk) => {
            receivedBulk.push(chunk);
          },
          onClose: async () => {
            await stream.close();
            bulkDone.resolve();
          },
        });
        return { ok: true, status: 200 };
      }
      if (target.kind === "tcp") {
        stream.setConsumer({
          onData: async (chunk) => {
            receivedEcho += new TextDecoder().decode(chunk);
            await stream.write(chunk);
          },
          onClose: async () => {
            await stream.close();
            echoDone.resolve();
          },
        });
        return { ok: true };
      }
      return { ok: false, error: "unexpected target" };
    });

    const bulkSize = FLEET_DEFAULT_WINDOW_BYTES * 3 + 137;
    const bulkBytes = new Uint8Array(bulkSize);
    for (let i = 0; i < bulkSize; i++) {
      bulkBytes[i] = (i * 31) & 0xff;
    }

    const [{ stream: bulkStream }, { stream: echoStream }] = await Promise.all([
      client.openStream({ kind: "http", method: "POST", path: "/bulk", headers: {} }),
      client.openStream({ kind: "tcp", host: "127.43.0.1", port: 8317 }),
    ]);

    const bulkClientClosed = Promise.withResolvers<void>();
    bulkStream.setConsumer({
      onData: () => {},
      onClose: () => {
        bulkClientClosed.resolve();
      },
    });
    const echoedClient = Promise.withResolvers<string>();
    let echoed = "";
    echoStream.setConsumer({
      onData: (chunk) => {
        echoed += new TextDecoder().decode(chunk);
      },
      onClose: () => {
        echoedClient.resolve(echoed);
      },
    });

    await Promise.all([
      bulkStream.write(bulkBytes).then(() => bulkStream.close()),
      echoStream.write(new TextEncoder().encode("ping-over-mux")).then(() => echoStream.close()),
    ]);

    await Promise.all([
      bulkDone.promise,
      echoDone.promise,
      echoedClient.promise,
      bulkClientClosed.promise,
      bulkStream.closed,
      echoStream.closed,
    ]);
    const totalBytes = receivedBulk.reduce((acc, part) => acc + part.byteLength, 0);
    expect(totalBytes).toBe(bulkSize);

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of receivedBulk) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    expect(combined).toEqual(bulkBytes);
    expect(receivedEcho).toBe("ping-over-mux");
    expect(echoed).toBe("ping-over-mux");
    expect(client.activeStreamCount).toBe(0);
    expect(server.activeStreamCount).toBe(0);
    client.close();
  });

  it("correlates bidirectional control RPCs and surfaces handler errors", async () => {
    const { client, server } = createInMemoryMuxPair();
    server.onControl("ping", (payload) => ({ pong: payload }));
    server.onControl("boom", () => {
      throw new Error("controlled failure");
    });

    const okResult = await client.requestControl("ping", { hello: 1 });
    expect(okResult).toEqual({ pong: { hello: 1 } });
    await expect(client.requestControl("boom")).rejects.toThrow("controlled failure");
    client.close();
  });
});
