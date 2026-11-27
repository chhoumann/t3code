const FLEET_FRAME_CONTROL = 1;
const FLEET_FRAME_OPEN = 2;
const FLEET_FRAME_OPEN_ACK = 3;
export const FLEET_FRAME_DATA = 4;
const FLEET_FRAME_WINDOW_UPDATE = 5;
const FLEET_FRAME_CLOSE = 6;
const FLEET_FRAME_RESET = 7;

export type FleetFrameType =
  | typeof FLEET_FRAME_CONTROL
  | typeof FLEET_FRAME_OPEN
  | typeof FLEET_FRAME_OPEN_ACK
  | typeof FLEET_FRAME_DATA
  | typeof FLEET_FRAME_WINDOW_UPDATE
  | typeof FLEET_FRAME_CLOSE
  | typeof FLEET_FRAME_RESET;

const FLEET_FRAME_HEADER_BYTES = 9;
export const FLEET_DEFAULT_WINDOW_BYTES = 256 * 1024;
const FLEET_WINDOW_UPDATE_THRESHOLD_BYTES = 128 * 1024;
const FLEET_MAX_CHUNK_BYTES = 32 * 1024;

export interface FleetMuxDecodedFrame {
  readonly type: FleetFrameType;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

export type FleetStreamTarget =
  | {
      readonly kind: "http";
      readonly method: string;
      readonly path: string;
      readonly headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | {
      readonly kind: "ws";
      readonly path: string;
      readonly headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
    };

export interface FleetStreamAck {
  readonly ok: boolean;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly error?: string;
}

export interface FleetControlEnvelope {
  readonly kind: "request" | "response" | "event";
  readonly id?: string;
  readonly method: string;
  readonly payload?: unknown;
  readonly ok?: boolean;
  readonly error?: string;
}

export interface FleetMuxTransport {
  readonly send: (frame: Uint8Array) => void | Promise<void>;
  readonly close: (code?: number, reason?: string) => void;
}

export interface FleetStreamConsumer {
  readonly onData: (chunk: Uint8Array) => void | Promise<void>;
  readonly onClose?: () => void | Promise<void>;
  readonly onReset?: (reason: string) => void;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFleetFrame(
  type: FleetFrameType,
  streamId: number,
  payload?: Uint8Array,
): Uint8Array {
  const payloadLength = payload?.byteLength ?? 0;
  const out = new Uint8Array(FLEET_FRAME_HEADER_BYTES + payloadLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = type;
  view.setUint32(1, streamId >>> 0, false);
  view.setUint32(5, payloadLength >>> 0, false);
  if (payload !== undefined && payloadLength > 0) {
    out.set(payload, FLEET_FRAME_HEADER_BYTES);
  }
  return out;
}

export function decodeFleetFrame(raw: Uint8Array): FleetMuxDecodedFrame {
  if (raw.byteLength < FLEET_FRAME_HEADER_BYTES) {
    throw new Error(`Invalid fleet mux frame header length: ${raw.byteLength}`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const rawType = raw[0]!;
  if (rawType < FLEET_FRAME_CONTROL || rawType > FLEET_FRAME_RESET) {
    throw new Error(`Invalid fleet mux frame type: ${rawType}`);
  }
  const streamId = view.getUint32(1, false);
  const length = view.getUint32(5, false);
  if (raw.byteLength < FLEET_FRAME_HEADER_BYTES + length) {
    throw new Error(
      `Truncated fleet mux frame: expected ${FLEET_FRAME_HEADER_BYTES + length} bytes, got ${raw.byteLength}`,
    );
  }
  return {
    type: rawType as FleetFrameType,
    streamId,
    payload: raw.subarray(FLEET_FRAME_HEADER_BYTES, FLEET_FRAME_HEADER_BYTES + length),
  };
}

function encodeWindowUpdatePayload(delta: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, delta >>> 0, false);
  return bytes;
}

function decodeWindowUpdatePayload(payload: Uint8Array): number {
  if (payload.byteLength < 4) {
    throw new Error(`Invalid window update length: ${payload.byteLength}`);
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
}

interface PendingWrite {
  readonly data: Uint8Array;
  offset: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class FleetMuxStream {
  readonly id: number;
  private sendWindow = FLEET_DEFAULT_WINDOW_BYTES;
  private unackedInboundBytes = 0;
  private localClosed = false;
  private localCloseSent = false;
  private remoteClosed = false;
  private closedError: Error | null = null;
  private readonly writeQueue: Array<PendingWrite> = [];
  private flushing = false;
  private flushWaiters: Array<() => void> = [];
  private consumer: FleetStreamConsumer | null = null;
  private readonly bufferedInbound: Array<Uint8Array> = [];
  private inboundChain: Promise<void> = Promise.resolve();
  private inboundDrainResolved = false;
  private readonly closedDeferred = Promise.withResolvers<void>();
  private readonly onDispose: () => void;
  private readonly sendFrame: (
    type: FleetFrameType,
    streamId: number,
    payload?: Uint8Array,
  ) => Promise<void>;

  constructor(options: {
    readonly id: number;
    readonly sendFrame: (
      type: FleetFrameType,
      streamId: number,
      payload?: Uint8Array,
    ) => Promise<void>;
    readonly onDispose: () => void;
  }) {
    this.id = options.id;
    this.sendFrame = options.sendFrame;
    this.onDispose = options.onDispose;
  }

  get closed(): Promise<void> {
    return this.closedDeferred.promise;
  }

  get isLocalClosed(): boolean {
    return this.localClosed;
  }

  get isRemoteClosed(): boolean {
    return this.remoteClosed;
  }

  setConsumer(consumer: FleetStreamConsumer): void {
    this.consumer = consumer;
    while (this.bufferedInbound.length > 0) {
      const chunk = this.bufferedInbound.shift()!;
      this.enqueueInboundChunk(consumer, chunk);
    }
    if (this.remoteClosed && !this.inboundDrainResolved) {
      this.finalizeInbound(consumer);
    }
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.closedError !== null) {
      return Promise.reject(this.closedError);
    }
    if (this.localClosed) {
      return Promise.reject(new Error(`Stream ${this.id} already closed for writing`));
    }
    if (chunk.byteLength === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ data: chunk, offset: 0, resolve, reject });
      void this.flushWrites();
    });
  }

  async close(): Promise<void> {
    if (this.localCloseSent || this.closedError !== null) {
      return;
    }
    this.localClosed = true;
    await this.waitForWrites();
    if (this.localCloseSent || this.closedError !== null) {
      return;
    }
    this.localCloseSent = true;
    await this.sendFrame(FLEET_FRAME_CLOSE, this.id);
    this.maybeDispose();
  }

  reset(reason = "Stream reset"): void {
    if (this.closedError !== null) {
      return;
    }
    const err = new Error(reason);
    this.failPendingWrites(err);
    this.localClosed = true;
    this.localCloseSent = true;
    this.remoteClosed = true;
    void this.sendFrame(FLEET_FRAME_RESET, this.id, textEncoder.encode(reason)).catch(() => {});
    this.consumer?.onReset?.(reason);
    this.dispose();
  }

  /** @internal */
  handleWindowUpdate(delta: number): void {
    if (delta <= 0) {
      return;
    }
    this.sendWindow += delta;
    void this.flushWrites();
  }

  /** @internal */
  handleInboundData(chunk: Uint8Array): void {
    if (this.remoteClosed || this.closedError !== null) {
      return;
    }
    const copy = new Uint8Array(chunk);
    if (this.consumer === null) {
      this.bufferedInbound.push(copy);
      return;
    }
    this.enqueueInboundChunk(this.consumer, copy);
  }

  /** @internal */
  handleInboundClose(): void {
    if (this.remoteClosed || this.closedError !== null) {
      return;
    }
    this.remoteClosed = true;
    if (this.consumer !== null && !this.inboundDrainResolved) {
      this.finalizeInbound(this.consumer);
    }
  }

  /** @internal */
  handleInboundReset(reason: string): void {
    if (this.closedError !== null) {
      return;
    }
    const err = new Error(reason);
    this.failPendingWrites(err);
    this.localClosed = true;
    this.localCloseSent = true;
    this.remoteClosed = true;
    this.consumer?.onReset?.(reason);
    this.dispose();
  }

  private waitForWrites(): Promise<void> {
    if (this.writeQueue.length === 0 && !this.flushing) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
    });
  }

  private async flushWrites(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0 && this.closedError === null) {
        if (this.sendWindow <= 0) {
          return;
        }
        const entry = this.writeQueue[0]!;
        const remaining = entry.data.byteLength - entry.offset;
        const size = Math.min(remaining, this.sendWindow, FLEET_MAX_CHUNK_BYTES);
        if (size <= 0) {
          return;
        }
        const slice = entry.data.subarray(entry.offset, entry.offset + size);
        entry.offset += size;
        this.sendWindow -= size;
        await this.sendFrame(FLEET_FRAME_DATA, this.id, slice);
        if (entry.offset >= entry.data.byteLength) {
          this.writeQueue.shift();
          entry.resolve();
        }
      }
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      this.failPendingWrites(err);
    } finally {
      this.flushing = false;
      if (this.writeQueue.length === 0 || this.closedError !== null) {
        const waiters = this.flushWaiters.splice(0, this.flushWaiters.length);
        for (const notify of waiters) {
          notify();
        }
      }
    }
  }

  private enqueueInboundChunk(consumer: FleetStreamConsumer, chunk: Uint8Array): void {
    this.inboundChain = this.inboundChain
      .then(async () => {
        if (this.closedError !== null) {
          return;
        }
        await consumer.onData(chunk);
        this.unackedInboundBytes += chunk.byteLength;
        if (this.unackedInboundBytes >= FLEET_WINDOW_UPDATE_THRESHOLD_BYTES) {
          const delta = this.unackedInboundBytes;
          this.unackedInboundBytes = 0;
          await this.sendFrame(
            FLEET_FRAME_WINDOW_UPDATE,
            this.id,
            encodeWindowUpdatePayload(delta),
          );
        }
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.reset(message);
      });
  }

  private finalizeInbound(consumer: FleetStreamConsumer): void {
    this.inboundDrainResolved = true;
    this.inboundChain = this.inboundChain
      .then(async () => {
        if (this.unackedInboundBytes > 0) {
          const delta = this.unackedInboundBytes;
          this.unackedInboundBytes = 0;
          await this.sendFrame(
            FLEET_FRAME_WINDOW_UPDATE,
            this.id,
            encodeWindowUpdatePayload(delta),
          ).catch(() => {});
        }
        await consumer.onClose?.();
        this.maybeDispose();
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.reset(message);
      });
  }

  private failPendingWrites(err: Error): void {
    if (this.closedError === null) {
      this.closedError = err;
    }
    while (this.writeQueue.length > 0) {
      const entry = this.writeQueue.shift()!;
      entry.reject(err);
    }
    const waiters = this.flushWaiters.splice(0, this.flushWaiters.length);
    for (const notify of waiters) {
      notify();
    }
  }

  private dispose(): void {
    this.onDispose();
    this.closedDeferred.resolve();
  }

  private maybeDispose(): void {
    if (this.localCloseSent && this.remoteClosed) {
      this.dispose();
    }
  }
}

export class FleetMuxEndpoint {
  private nextStreamId: number;
  private nextControlId = 1;
  private closed = false;
  private readonly transport: FleetMuxTransport;
  private readonly streams = new Map<number, FleetMuxStream>();
  private readonly pendingOpens = new Map<
    number,
    {
      readonly resolve: (result: {
        readonly stream: FleetMuxStream;
        readonly ack: FleetStreamAck;
      }) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  private readonly pendingControlRequests = new Map<
    string,
    {
      readonly resolve: (payload: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  private readonly controlHandlers = new Map<
    string,
    (payload: unknown, envelope: FleetControlEnvelope) => Promise<unknown> | unknown
  >();
  private openStreamHandler:
    | ((
        stream: FleetMuxStream,
        target: FleetStreamTarget,
      ) => Promise<FleetStreamAck> | FleetStreamAck)
    | null = null;
  private readonly closeListeners = new Set<(reason?: string) => void>();

  constructor(options: { readonly transport: FleetMuxTransport; readonly initiator: boolean }) {
    this.transport = options.transport;
    this.nextStreamId = options.initiator ? 1 : 2;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  onOpenStream(
    handler: (
      stream: FleetMuxStream,
      target: FleetStreamTarget,
    ) => Promise<FleetStreamAck> | FleetStreamAck,
  ): void {
    this.openStreamHandler = handler;
  }

  onControl(
    method: string,
    handler: (payload: unknown, envelope: FleetControlEnvelope) => Promise<unknown> | unknown,
  ): () => void {
    this.controlHandlers.set(method, handler);
    return () => {
      this.controlHandlers.delete(method);
    };
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  async sendControlEvent(method: string, payload?: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("FleetMux endpoint is closed");
    }
    const envelope: FleetControlEnvelope = {
      kind: "event",
      method,
      ...(payload === undefined ? {} : { payload }),
    };
    await this.sendJsonFrame(FLEET_FRAME_CONTROL, 0, envelope);
  }

  requestControl<T = unknown>(method: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("FleetMux endpoint is closed"));
    }
    const id = `ctl_${this.nextControlId++}`;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (this.pendingControlRequests.delete(id)) {
          cleanup();
          reject(new Error(`Fleet control request ${method} aborted`));
        }
      };
      if (signal?.aborted) {
        reject(new Error(`Fleet control request ${method} aborted`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingControlRequests.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      const envelope: FleetControlEnvelope = {
        kind: "request",
        id,
        method,
        ...(payload === undefined ? {} : { payload }),
      };
      this.sendJsonFrame(FLEET_FRAME_CONTROL, 0, envelope).catch((cause) => {
        if (this.pendingControlRequests.delete(id)) {
          cleanup();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    });
  }

  openStream(
    target: FleetStreamTarget,
    signal?: AbortSignal,
  ): Promise<{ readonly stream: FleetMuxStream; readonly ack: FleetStreamAck }> {
    if (this.closed) {
      return Promise.reject(new Error("FleetMux endpoint is closed"));
    }
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = this.createStream(streamId);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (this.pendingOpens.delete(streamId)) {
          cleanup();
          stream.reset("Open aborted");
          reject(new Error("Fleet stream open aborted"));
        }
      };
      if (signal?.aborted) {
        this.streams.delete(streamId);
        reject(new Error("Fleet stream open aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingOpens.set(streamId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      this.sendJsonFrame(FLEET_FRAME_OPEN, streamId, target).catch((cause) => {
        if (this.pendingOpens.delete(streamId)) {
          cleanup();
          stream.handleInboundReset("Send open failed");
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    });
  }

  handleFrame(raw: Uint8Array): void {
    const frame = decodeFleetFrame(raw);
    switch (frame.type) {
      case FLEET_FRAME_CONTROL: {
        const envelope = JSON.parse(textDecoder.decode(frame.payload)) as FleetControlEnvelope;
        this.handleControlEnvelope(envelope);
        return;
      }
      case FLEET_FRAME_OPEN: {
        const target = JSON.parse(textDecoder.decode(frame.payload)) as FleetStreamTarget;
        this.handleInboundOpen(frame.streamId, target);
        return;
      }
      case FLEET_FRAME_OPEN_ACK: {
        const ack = JSON.parse(textDecoder.decode(frame.payload)) as FleetStreamAck;
        const pending = this.pendingOpens.get(frame.streamId);
        if (pending === undefined) {
          return;
        }
        this.pendingOpens.delete(frame.streamId);
        const stream = this.streams.get(frame.streamId);
        if (stream === undefined || !ack.ok) {
          this.streams.delete(frame.streamId);
          pending.reject(new Error(ack.error ?? "Fleet stream rejected"));
          return;
        }
        pending.resolve({ stream, ack });
        return;
      }
      case FLEET_FRAME_DATA: {
        this.streams.get(frame.streamId)?.handleInboundData(frame.payload);
        return;
      }
      case FLEET_FRAME_WINDOW_UPDATE: {
        const delta = decodeWindowUpdatePayload(frame.payload);
        this.streams.get(frame.streamId)?.handleWindowUpdate(delta);
        return;
      }
      case FLEET_FRAME_CLOSE: {
        this.streams.get(frame.streamId)?.handleInboundClose();
        return;
      }
      case FLEET_FRAME_RESET: {
        const reason = textDecoder.decode(frame.payload) || "Stream reset";
        const pending = this.pendingOpens.get(frame.streamId);
        if (pending !== undefined) {
          this.pendingOpens.delete(frame.streamId);
          pending.reject(new Error(reason));
        }
        this.streams.get(frame.streamId)?.handleInboundReset(reason);
        return;
      }
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const message = reason ?? "FleetMux endpoint closed";
    for (const [, pending] of this.pendingOpens) {
      pending.reject(new Error(message));
    }
    this.pendingOpens.clear();
    for (const [, pending] of this.pendingControlRequests) {
      pending.reject(new Error(message));
    }
    this.pendingControlRequests.clear();
    for (const stream of Array.from(this.streams.values())) {
      stream.handleInboundReset(message);
    }
    this.streams.clear();
    this.transport.close(code, reason);
    for (const listener of this.closeListeners) {
      listener(reason);
    }
  }

  private createStream(streamId: number): FleetMuxStream {
    const stream = new FleetMuxStream({
      id: streamId,
      sendFrame: (type, id, payload) => this.sendFrame(type, id, payload),
      onDispose: () => {
        this.streams.delete(streamId);
      },
    });
    this.streams.set(streamId, stream);
    return stream;
  }

  private handleControlEnvelope(envelope: FleetControlEnvelope): void {
    if (envelope.kind === "response" && envelope.id !== undefined) {
      const pending = this.pendingControlRequests.get(envelope.id);
      if (pending === undefined) {
        return;
      }
      this.pendingControlRequests.delete(envelope.id);
      if (envelope.ok === false) {
        pending.reject(new Error(envelope.error ?? `Control request ${envelope.method} failed`));
      } else {
        pending.resolve(envelope.payload);
      }
      return;
    }
    const handler = this.controlHandlers.get(envelope.method);
    if (envelope.kind === "event") {
      if (handler !== undefined) {
        void Promise.resolve(handler(envelope.payload, envelope)).catch(() => {});
      }
      return;
    }
    const id = envelope.id;
    if (id === undefined) {
      return;
    }
    if (handler === undefined) {
      void this.sendJsonFrame(FLEET_FRAME_CONTROL, 0, {
        kind: "response",
        id,
        method: envelope.method,
        ok: false,
        error: `Unhandled control method: ${envelope.method}`,
      } satisfies FleetControlEnvelope).catch(() => {});
      return;
    }
    void Promise.resolve()
      .then(() => handler(envelope.payload, envelope))
      .then((result) =>
        this.sendJsonFrame(FLEET_FRAME_CONTROL, 0, {
          kind: "response",
          id,
          method: envelope.method,
          ok: true,
          ...(result === undefined ? {} : { payload: result }),
        } satisfies FleetControlEnvelope),
      )
      .catch((cause) =>
        this.sendJsonFrame(FLEET_FRAME_CONTROL, 0, {
          kind: "response",
          id,
          method: envelope.method,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies FleetControlEnvelope),
      )
      .catch(() => {});
  }

  private handleInboundOpen(streamId: number, target: FleetStreamTarget): void {
    if (this.openStreamHandler === null) {
      void this.sendJsonFrame(FLEET_FRAME_OPEN_ACK, streamId, {
        ok: false,
        error: "No stream handler registered",
      } satisfies FleetStreamAck).catch(() => {});
      return;
    }
    const stream = this.createStream(streamId);
    const handler = this.openStreamHandler;
    void Promise.resolve()
      .then(() => handler(stream, target))
      .then((ack) => {
        if (!ack.ok) {
          this.streams.delete(streamId);
        }
        return this.sendJsonFrame(FLEET_FRAME_OPEN_ACK, streamId, ack);
      })
      .catch((cause) => {
        this.streams.delete(streamId);
        return this.sendJsonFrame(FLEET_FRAME_OPEN_ACK, streamId, {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies FleetStreamAck);
      })
      .catch(() => {});
  }

  private async sendJsonFrame(
    type: FleetFrameType,
    streamId: number,
    value: unknown,
  ): Promise<void> {
    await this.sendFrame(type, streamId, textEncoder.encode(JSON.stringify(value)));
  }

  private async sendFrame(
    type: FleetFrameType,
    streamId: number,
    payload?: Uint8Array,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("FleetMux endpoint is closed");
    }
    await this.transport.send(encodeFleetFrame(type, streamId, payload));
  }
}

export function createInMemoryMuxPair(): {
  readonly client: FleetMuxEndpoint;
  readonly server: FleetMuxEndpoint;
} {
  let client!: FleetMuxEndpoint;
  let server!: FleetMuxEndpoint;
  client = new FleetMuxEndpoint({
    initiator: true,
    transport: {
      send: (frame) => {
        queueMicrotask(() => {
          if (!server.isClosed) {
            server.handleFrame(frame);
          }
        });
      },
      close: (_code, reason) => {
        queueMicrotask(() => server.close(undefined, reason));
      },
    },
  });
  server = new FleetMuxEndpoint({
    initiator: false,
    transport: {
      send: (frame) => {
        queueMicrotask(() => {
          if (!client.isClosed) {
            client.handleFrame(frame);
          }
        });
      },
      close: (_code, reason) => {
        queueMicrotask(() => client.close(undefined, reason));
      },
    },
  });
  return { client, server };
}
