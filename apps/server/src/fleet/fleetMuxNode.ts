/**
 * Node bindings for @t3tools/shared/fleetMux: Effect Socket, Node HTTP,
 * WebSocket frame bridging, TCP forwarding, and /etc/hosts mesh sync.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import { WebSocket as UndiciWebSocket } from "undici";
import {
  FleetMuxEndpoint,
  type FleetControlEnvelope,
  type FleetMuxStream,
  type FleetStreamAck,
  type FleetStreamConsumer,
  type FleetStreamTarget,
} from "@t3tools/shared/fleetMux";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

class FleetMuxWriteError extends Schema.TaggedError<FleetMuxWriteError>()("FleetMuxWriteError", {
  cause: Schema.Defect(),
}) {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const WS_MUX_KIND_TEXT = 1;
export const WS_MUX_KIND_BINARY = 2;
export const WS_MUX_KIND_CLOSE = 8;

const DROP_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DROP_WS_HEADERS = new Set([
  ...DROP_HOP_HEADERS,
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

function normalizeHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): Record<string, string | Array<string>> {
  const out: Record<string, string | Array<string>> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (DROP_HOP_HEADERS.has(lower)) continue;
    out[lower] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

export interface AttachMuxOptions {
  readonly initiator: boolean;
  readonly onStream?: (
    stream: FleetMuxStream,
    target: FleetStreamTarget,
  ) => Promise<FleetStreamAck> | FleetStreamAck;
  readonly onControl?: Readonly<
    Record<string, (payload: unknown, envelope: FleetControlEnvelope) => Promise<unknown> | unknown>
  >;
}

export function attachMuxToEffectSocket(
  socket: Socket.Socket,
  options: AttachMuxOptions,
): Effect.Effect<{ readonly endpoint: FleetMuxEndpoint; readonly run: Effect.Effect<void> }> {
  return Effect.sync(() => {
    const outboundQueue: Array<Uint8Array | null> = [];
    let closed = false;
    let notifyWriter: (() => void) | null = null;

    const pushOutbound = (item: Uint8Array | null) => {
      if (closed && item !== null) return;
      outboundQueue.push(item);
      if (notifyWriter !== null) {
        const wake = notifyWriter;
        notifyWriter = null;
        wake();
      }
    };

    const endpoint = new FleetMuxEndpoint({
      initiator: options.initiator,
      transport: {
        send: (frame) => {
          pushOutbound(frame);
        },
        close: () => {
          if (closed) return;
          closed = true;
          pushOutbound(null);
        },
      },
    });

    if (options.onStream !== undefined) {
      endpoint.onOpenStream(options.onStream);
    }
    if (options.onControl !== undefined) {
      for (const [method, handler] of Object.entries(options.onControl)) {
        endpoint.onControl(method, handler);
      }
    }

    const awaitOutboundReady = Effect.callback<void>((resume) => {
      if (outboundQueue.length > 0 || closed) {
        resume(Effect.void);
        return;
      }
      notifyWriter = () => resume(Effect.void);
      return Effect.sync(() => {
        notifyWriter = null;
      });
    });

    const run: Effect.Effect<void> = Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;

        const outboundFiber = Effect.gen(function* () {
          while (true) {
            while (outboundQueue.length > 0) {
              const next = outboundQueue.shift();
              if (next === undefined) continue;
              if (next === null) return;
              yield* writer.write(next);
            }
            if (closed) return;
            yield* awaitOutboundReady;
          }
        });

        const inboundFiber = Effect.gen(function* () {
          while (true) {
            const frames = yield* reader.pull;
            for (const frame of frames) {
              const bytes = typeof frame === "string" ? textEncoder.encode(frame) : frame;
              endpoint.handleFrame(bytes);
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!closed) {
                closed = true;
                pushOutbound(null);
              }
              endpoint.close(undefined, "socket closed");
            }),
          ),
        );

        yield* Effect.raceFirst(outboundFiber, inboundFiber).pipe(
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              closed = true;
              endpoint.close(undefined, "socket finished");
            }),
          ),
        );
      }).pipe(Effect.ignore),
    );

    return { endpoint, run };
  });
}

export function encodeMuxWsFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = kind & 0xff;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, payload.byteLength, false);
  if (payload.byteLength > 0) {
    out.set(payload, 5);
  }
  return out;
}

export function createMuxWsFrameParser(onFrame: (kind: number, payload: Uint8Array) => void) {
  let buffer = new Uint8Array(0);

  return (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return;
    if (buffer.byteLength === 0) {
      buffer = new Uint8Array(chunk);
    } else {
      const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.byteLength);
      buffer = merged;
    }

    while (buffer.byteLength >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const kind = buffer[0]!;
      const len = view.getUint32(1, false);
      if (buffer.byteLength < 5 + len) break;
      const payload = buffer.slice(5, 5 + len);
      buffer = buffer.slice(5 + len);
      onFrame(kind, payload);
    }
  };
}

export function bridgeEffectSocketToMuxWs(
  socket: Socket.Socket,
  stream: FleetMuxStream,
  options?: { readonly defaultText?: boolean },
): Effect.Effect<void> {
  const defaultKind = options?.defaultText === false ? WS_MUX_KIND_BINARY : WS_MUX_KIND_TEXT;
  return Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* socket.writer;
      const reader = yield* socket.reader;
      const inboundFrames: Array<{ readonly kind: number; readonly payload: Uint8Array } | null> =
        [];
      let notify: (() => void) | null = null;
      let done = false;

      const pushFrame = (frame: { readonly kind: number; readonly payload: Uint8Array } | null) => {
        inboundFrames.push(frame);
        if (notify !== null) {
          const wake = notify;
          notify = null;
          wake();
        }
      };

      const parse = createMuxWsFrameParser((kind, payload) => {
        if (kind === WS_MUX_KIND_CLOSE) {
          done = true;
          pushFrame(null);
          return;
        }
        pushFrame({ kind, payload });
      });

      stream.setConsumer({
        onData: (chunk) => {
          parse(chunk);
        },
        onClose: () => {
          done = true;
          pushFrame(null);
        },
        onReset: () => {
          done = true;
          pushFrame(null);
        },
      });

      const awaitInboundReady = Effect.callback<void>((resume) => {
        if (inboundFrames.length > 0 || done) {
          resume(Effect.void);
          return;
        }
        notify = () => resume(Effect.void);
        return Effect.sync(() => {
          notify = null;
        });
      });

      const muxToSocket = Effect.gen(function* () {
        while (true) {
          while (inboundFrames.length > 0) {
            const frame = inboundFrames.shift();
            if (frame === undefined) continue;
            if (frame === null) return;
            if (frame.kind === WS_MUX_KIND_TEXT) {
              yield* writer.write(textDecoder.decode(frame.payload));
            } else {
              yield* writer.write(frame.payload);
            }
          }
          if (done) return;
          yield* awaitInboundReady;
        }
      });

      const socketToMux = Effect.gen(function* () {
        while (true) {
          const frames = yield* reader.pull;
          for (const frame of frames) {
            if (typeof frame === "string") {
              yield* Effect.tryPromise({
                try: () =>
                  stream.write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, textEncoder.encode(frame))),
                catch: (cause) => new FleetMuxWriteError({ cause }),
              });
            } else {
              yield* Effect.tryPromise({
                try: () => stream.write(encodeMuxWsFrame(defaultKind, frame)),
                catch: (cause) => new FleetMuxWriteError({ cause }),
              });
            }
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            done = true;
            void stream.close();
          }),
        ),
      );

      yield* Effect.raceFirst(muxToSocket, socketToMux).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            done = true;
            void stream.close();
          }),
        ),
      );
    }).pipe(Effect.ignore),
  );
}

function attachConsumerToStream(stream: FleetMuxStream, consumer: FleetStreamConsumer): void {
  stream.setConsumer(consumer);
}

export function createMuxStreamDuplex(stream: FleetMuxStream): NodeStream.Duplex {
  const duplex = new NodeStream.Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      void stream.write(data).then(
        () => callback(),
        (err) => callback(err instanceof Error ? err : new Error(String(err))),
      );
    },
    final(callback) {
      void stream.close().then(
        () => callback(),
        (err) => callback(err instanceof Error ? err : new Error(String(err))),
      );
    },
    destroy(err, callback) {
      if (err) {
        stream.reset(err.message);
      } else {
        void stream.close().catch(() => {});
      }
      callback(err);
    },
  });

  attachConsumerToStream(stream, {
    onData: (chunk) => {
      if (!duplex.destroyed) duplex.push(Buffer.from(chunk));
    },
    onClose: () => {
      if (!duplex.destroyed) duplex.push(null);
    },
    onReset: (reason) => {
      if (!duplex.destroyed) duplex.destroy(new Error(reason));
    },
  });

  return duplex;
}

export function serveMuxWsToLocalOrigin(
  stream: FleetMuxStream,
  target: Extract<FleetStreamTarget, { readonly kind: "ws" }>,
  localOrigin: string,
): Promise<FleetStreamAck> {
  return new Promise<FleetStreamAck>((resolve) => {
    const wsUrl = new URL(target.path, localOrigin.replace(/^http/i, "ws")).toString();
    const protocolsHeader = target.headers["sec-websocket-protocol"];
    const protocols =
      typeof protocolsHeader === "string"
        ? protocolsHeader
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : Array.isArray(protocolsHeader)
          ? protocolsHeader
          : undefined;

    const wsHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(target.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (DROP_WS_HEADERS.has(lower)) continue;
      wsHeaders[key] = Array.isArray(value)
        ? value.map(String).join(lower === "cookie" ? "; " : ", ")
        : String(value);
    }

    const ws = new UndiciWebSocket(wsUrl, {
      ...(Object.keys(wsHeaders).length > 0 ? { headers: wsHeaders } : {}),
      ...(protocols && protocols.length > 0 ? { protocols } : {}),
    });
    ws.binaryType = "arraybuffer";

    let settledOpen = false;
    const parse = createMuxWsFrameParser((kind, payload) => {
      if (ws.readyState !== UndiciWebSocket.OPEN) return;
      if (kind === WS_MUX_KIND_CLOSE) {
        ws.close();
        return;
      }
      if (kind === WS_MUX_KIND_TEXT) {
        ws.send(textDecoder.decode(payload));
      } else {
        ws.send(payload);
      }
    });

    attachConsumerToStream(stream, {
      onData: (chunk) => {
        parse(chunk);
      },
      onClose: () => {
        if (
          ws.readyState === UndiciWebSocket.OPEN ||
          ws.readyState === UndiciWebSocket.CONNECTING
        ) {
          ws.close();
        }
      },
      onReset: () => {
        if (
          ws.readyState === UndiciWebSocket.OPEN ||
          ws.readyState === UndiciWebSocket.CONNECTING
        ) {
          ws.close();
        }
      },
    });

    ws.addEventListener("open", () => {
      settledOpen = true;
      resolve({
        ok: true,
        status: 101,
        ...(ws.protocol ? { headers: { "sec-websocket-protocol": ws.protocol } } : {}),
      });
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void stream
          .write(encodeMuxWsFrame(WS_MUX_KIND_TEXT, textEncoder.encode(event.data)))
          .catch(() => {});
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        void stream
          .write(encodeMuxWsFrame(WS_MUX_KIND_BINARY, new Uint8Array(event.data)))
          .catch(() => {});
      }
    });

    ws.addEventListener("close", () => {
      if (!settledOpen) {
        settledOpen = true;
        resolve({ ok: false, status: 502, error: "Upstream WebSocket closed before open" });
      }
      void stream.close();
    });

    ws.addEventListener("error", () => {
      if (!settledOpen) {
        settledOpen = true;
        resolve({ ok: false, status: 502, error: "Upstream WebSocket connection error" });
      }
      void stream.reset("Upstream WebSocket error");
    });
  });
}

export interface MuxHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly stream: FleetMuxStream;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export async function forwardHttpOverMux(
  endpoint: FleetMuxEndpoint,
  input: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
    readonly body?: Uint8Array | AsyncIterable<Uint8Array> | null;
  },
): Promise<MuxHttpResponse> {
  const cleanedHeaders = normalizeHeaders(input.headers);
  delete cleanedHeaders["content-length"];

  const opened = await endpoint.openStream({
    kind: "http",
    method: input.method,
    path: input.path,
    headers: cleanedHeaders,
  });

  const queue: Array<Uint8Array> = [];
  let headBuffer = new Uint8Array(0);
  let headerParsed = false;
  let finished = false;
  let failure: Error | null = null;
  let notifyBody: (() => void) | null = null;
  const headDeferred = Promise.withResolvers<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
  }>();

  const wakeBody = () => {
    if (notifyBody !== null) {
      const fn = notifyBody;
      notifyBody = null;
      fn();
    }
  };

  attachConsumerToStream(opened.stream, {
    onData: (chunk) => {
      if (chunk.byteLength === 0) return;
      if (headerParsed) {
        queue.push(chunk);
        wakeBody();
        return;
      }
      const merged = new Uint8Array(headBuffer.byteLength + chunk.byteLength);
      merged.set(headBuffer, 0);
      merged.set(chunk, headBuffer.byteLength);
      headBuffer = merged;
      if (headBuffer.byteLength < 4) return;
      const headLen = new DataView(
        headBuffer.buffer,
        headBuffer.byteOffset,
        headBuffer.byteLength,
      ).getUint32(0, false);
      if (headBuffer.byteLength < 4 + headLen) return;
      try {
        const meta = JSON.parse(textDecoder.decode(headBuffer.subarray(4, 4 + headLen))) as {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
          readonly error?: string;
        };
        const rest = headBuffer.slice(4 + headLen);
        headBuffer = new Uint8Array(0);
        headerParsed = true;
        if (meta.error !== undefined && meta.status === undefined) {
          const err = new Error(meta.error);
          failure = err;
          headDeferred.reject(err);
          wakeBody();
          return;
        }
        headDeferred.resolve({
          status: meta.status ?? 200,
          headers: meta.headers ?? {},
        });
        if (rest.byteLength > 0) {
          queue.push(rest);
          wakeBody();
        }
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        failure = err;
        headerParsed = true;
        headDeferred.reject(err);
        wakeBody();
      }
    },
    onClose: () => {
      finished = true;
      if (!headerParsed) {
        const err = new Error("Mux HTTP stream closed before response headers");
        failure = err;
        headDeferred.reject(err);
      }
      wakeBody();
    },
    onReset: (reason) => {
      const err = new Error(`Mux HTTP stream reset: ${reason}`);
      failure = err;
      finished = true;
      if (!headerParsed) {
        headDeferred.reject(err);
      }
      wakeBody();
    },
  });

  if (input.body instanceof Uint8Array) {
    if (input.body.byteLength > 0) {
      await opened.stream.write(input.body);
    }
    await opened.stream.close();
  } else if (input.body !== undefined && input.body !== null) {
    const bodyIterable: AsyncIterable<Uint8Array> = input.body;
    void (async () => {
      try {
        for await (const part of bodyIterable) {
          if (part.byteLength > 0) {
            await opened.stream.write(part);
          }
        }
        await opened.stream.close();
      } catch (err) {
        await opened.stream.reset(err instanceof Error ? err.message : "request body failed");
      }
    })();
  } else {
    await opened.stream.close();
  }

  const head = await headDeferred.promise;

  async function* iterateChunks(): AsyncIterable<Uint8Array> {
    while (true) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) yield next;
      }
      if (failure !== null) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => {
        notifyBody = resolve;
      });
    }
  }

  return {
    status: head.status,
    headers: head.headers,
    stream: opened.stream,
    chunks: iterateChunks(),
  };
}

export function serveMuxHttpToLocalOrigin(
  stream: FleetMuxStream,
  target: Extract<FleetStreamTarget, { readonly kind: "http" }>,
  localOrigin: string,
): Promise<FleetStreamAck> {
  const url = new URL(target.path, localOrigin);
  const reqHeaders = normalizeHeaders(target.headers);
  delete reqHeaders.host;
  delete reqHeaders["accept-encoding"];

  let headSent = false;
  let sendChain: Promise<void> = Promise.resolve();
  const enqueueWrite = (bytes: Uint8Array) => {
    sendChain = sendChain.then(() => stream.write(bytes));
    return sendChain;
  };

  const req = NodeHttp.request(
    url,
    {
      method: target.method,
      headers: reqHeaders,
    },
    (res) => {
      headSent = true;
      const resHeaders = normalizeHeaders(res.headers);
      delete resHeaders["content-encoding"];
      const metaBytes = textEncoder.encode(
        JSON.stringify({ status: res.statusCode ?? 200, headers: resHeaders }),
      );
      const frame = new Uint8Array(4 + metaBytes.byteLength);
      new DataView(frame.buffer).setUint32(0, metaBytes.byteLength, false);
      frame.set(metaBytes, 4);
      void enqueueWrite(frame).catch(() => res.destroy());

      res.on("data", (chunk: Buffer) => {
        res.pause();
        void enqueueWrite(new Uint8Array(chunk))
          .then(() => {
            if (!res.destroyed) res.resume();
          })
          .catch(() => {
            res.destroy();
          });
      });

      res.on("end", () => {
        void sendChain.then(() => stream.close()).catch(() => {});
      });

      res.on("error", (err) => {
        stream.reset(err.message);
      });
    },
  );

  attachConsumerToStream(stream, {
    onData: (chunk) => {
      if (!req.writableEnded && !req.destroyed) {
        req.write(chunk);
      }
    },
    onClose: () => {
      if (!req.writableEnded && !req.destroyed) {
        req.end();
      }
    },
    onReset: (reason) => {
      req.destroy(new Error(reason));
    },
  });

  req.on("error", (err) => {
    if (!headSent) {
      headSent = true;
      const metaBytes = textEncoder.encode(
        JSON.stringify({
          status: 502,
          headers: { "content-type": "text/plain" },
          error: err.message,
        }),
      );
      const frame = new Uint8Array(4 + metaBytes.byteLength);
      new DataView(frame.buffer).setUint32(0, metaBytes.byteLength, false);
      frame.set(metaBytes, 4);
      void enqueueWrite(frame)
        .then(() => stream.close())
        .catch(() => stream.reset(err.message));
      return;
    }
    stream.reset(err.message);
  });

  return Promise.resolve({ ok: true });
}

export function bridgeMuxStreamToTcp(
  stream: FleetMuxStream,
  target: { readonly host: string; readonly port: number },
): Promise<FleetStreamAck> {
  return new Promise<FleetStreamAck>((resolve) => {
    const tcp = NodeNet.connect({
      host: target.host,
      port: target.port,
      allowHalfOpen: true,
    });
    let settledAck = false;

    const pendingWrites: Array<Uint8Array> = [];
    let connected = false;

    tcp.on("connect", () => {
      connected = true;
      if (!settledAck) {
        settledAck = true;
        resolve({ ok: true });
      }
      while (pendingWrites.length > 0) {
        const next = pendingWrites.shift();
        if (next) tcp.write(next);
      }
    });

    tcp.on("data", (chunk: Buffer) => {
      tcp.pause();
      void stream
        .write(new Uint8Array(chunk))
        .then(() => {
          if (!tcp.destroyed) tcp.resume();
        })
        .catch(() => {
          tcp.destroy();
        });
    });

    tcp.on("end", () => {
      if (!tcp.writableEnded) tcp.end();
      void stream.close();
    });

    tcp.on("error", (err) => {
      if (!settledAck) {
        settledAck = true;
        resolve({ ok: false, status: 502, error: err.message });
      }
      void stream.reset(err.message);
    });

    attachConsumerToStream(stream, {
      onData: (chunk) => {
        if (tcp.destroyed) return;
        if (!connected) {
          pendingWrites.push(chunk);
        } else {
          tcp.write(chunk);
        }
      },
      onClose: () => {
        if (!tcp.destroyed) tcp.end();
      },
      onReset: () => {
        if (!tcp.destroyed) tcp.destroy();
      },
    });
  });
}

export async function createLoopbackForwarder(input: {
  readonly bindHost: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly getEndpoint: () => FleetMuxEndpoint | null;
}): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const server = NodeNet.createServer({ allowHalfOpen: true }, (client) => {
    const endpoint = input.getEndpoint();
    if (endpoint === null) {
      client.destroy();
      return;
    }

    const pendingToStream: Array<Uint8Array> = [];
    let openedStream: FleetMuxStream | null = null;
    let clientEnded = false;

    client.on("data", (chunk: Buffer) => {
      const data = new Uint8Array(chunk);
      if (openedStream === null) {
        pendingToStream.push(data);
        return;
      }
      client.pause();
      void openedStream
        .write(data)
        .then(() => {
          if (!client.destroyed) client.resume();
        })
        .catch(() => {
          client.destroy();
        });
    });

    client.on("end", () => {
      clientEnded = true;
      void openedStream?.close();
    });

    client.on("error", () => {
      void openedStream?.reset("local tcp error");
    });

    void endpoint
      .openStream({
        kind: "tcp",
        host: input.targetHost,
        port: input.targetPort,
      })
      .then(async ({ stream }) => {
        openedStream = stream;
        attachConsumerToStream(stream, {
          onData: (chunk) => {
            if (!client.destroyed) client.write(chunk);
          },
          onClose: () => {
            if (!client.destroyed) client.end();
          },
          onReset: () => {
            if (!client.destroyed) client.destroy();
          },
        });
        while (pendingToStream.length > 0) {
          const next = pendingToStream.shift();
          if (next) await stream.write(next);
        }
        if (clientEnded) await stream.close();
      })
      .catch(() => {
        client.destroy();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.listenPort, input.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : input.listenPort;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function renderFleetHostsBlock(
  entries: ReadonlyArray<{ readonly ip: string; readonly host: string }>,
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `${entry.ip} ${entry.host}`);
  return `# BEGIN T3 FLEET HOSTS\n${lines.join("\n")}\n# END T3 FLEET HOSTS\n`;
}

export function mergeFleetHostsContent(
  existing: string,
  entries: ReadonlyArray<{ readonly ip: string; readonly host: string }>,
): string {
  const withoutOld = existing.replace(/# BEGIN T3 FLEET HOSTS[\s\S]*?# END T3 FLEET HOSTS\n?/g, "");
  const block = renderFleetHostsBlock(entries);
  if (block.length === 0) return withoutOld;
  const separator = withoutOld.length === 0 || withoutOld.endsWith("\n") ? "" : "\n";
  return `${withoutOld}${separator}${block}`;
}

export function syncFleetHostsFile(
  entries: ReadonlyArray<{ readonly ip: string; readonly host: string }>,
  hostsPath = "/etc/hosts",
): boolean {
  try {
    const existing = NodeFS.existsSync(hostsPath) ? NodeFS.readFileSync(hostsPath, "utf8") : "";
    const updated = mergeFleetHostsContent(existing, entries);
    if (updated === existing) return true;
    NodeFS.writeFileSync(hostsPath, updated, "utf8");
    return true;
  } catch {
    return false;
  }
}
