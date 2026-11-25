import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset?: string | undefined;
  readonly tracesToken?: string | undefined;
  readonly tracesHeaders?: Readonly<Record<string, string>> | undefined;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HTTPS anywhere, or plain HTTP to this machine for a local collector. */
export function normalizeTelemetryTracesUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Parses OTLP's `key=percentEncodedValue,...` header format, the same format as
 * `OtlpHeadersFromString` in `observability.ts` (which needs Node and is not imported here).
 * Returns `undefined` when unset and `null` when malformed, so callers can fail closed.
 */
function parseRelayTracingHeaders(
  input: string | null | undefined,
): Readonly<Record<string, string>> | null | undefined {
  if (input === null || input === undefined || input.trim() === "") return undefined;
  const headers: Record<string, string> = {};
  for (const pair of input.split(",")) {
    if (pair.trim() === "") continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? "" : pair.slice(0, separator).trim();
    if (key === "") return null;
    try {
      headers[key] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return headers;
}

function trimOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveRelayClientTracingConfig(input: {
  readonly tracesUrl?: unknown;
  readonly tracesDataset?: unknown;
  readonly tracesToken?: unknown;
  readonly tracesHeaders?: string | Readonly<Record<string, string>> | null | undefined;
}): RelayClientTracingConfig | null {
  const tracesUrl = normalizeTelemetryTracesUrl(input.tracesUrl);
  if (tracesUrl === null) return null;
  const tracesHeaders =
    typeof input.tracesHeaders === "string" || input.tracesHeaders === null
      ? parseRelayTracingHeaders(input.tracesHeaders)
      : input.tracesHeaders;
  if (tracesHeaders === null) return null;
  const tracesDataset = trimOptional(input.tracesDataset);
  const tracesToken = trimOptional(input.tracesToken);
  return {
    tracesUrl,
    ...(tracesDataset ? { tracesDataset } : {}),
    ...(tracesToken ? { tracesToken } : {}),
    ...(tracesHeaders && Object.keys(tracesHeaders).length > 0 ? { tracesHeaders } : {}),
  };
}

/** Explicit headers win over the Axiom-style token and dataset shorthands. */
function buildRelayTracingHeaders(
  config: RelayClientTracingConfig,
): Readonly<Record<string, string>> | undefined {
  const headers: Record<string, string> = { ...config.tracesHeaders };
  const has = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (config.tracesToken && !has("authorization")) {
    headers.Authorization = `Bearer ${config.tracesToken}`;
  }
  if (config.tracesDataset && !has("x-axiom-dataset")) {
    headers["X-Axiom-Dataset"] = config.tracesDataset;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly serviceInstanceId: string;
  readonly client: string;
  readonly component?: string;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
}

export class RelayClientTracer extends Context.Reference(
  "@t3tools/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

class LocalTracer extends Context.Reference("@t3tools/shared/relayTracing/LocalTracer", {
  defaultValue: () => Option.none<Tracer.Tracer>(),
}) {}

/** Export only T3 Connect spans; wrap local work with {@link withLocalTracing}. */
export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) =>
          Tracer.Tracer.pipe(
            Effect.flatMap((local) =>
              effect.pipe(
                Effect.provideService(Tracer.Tracer, tracer),
                Effect.provideService(LocalTracer, Option.some(local)),
              ),
            ),
          ),
      }),
    ),
  );

/** Keep local work in the local trace without exporting machine details through relay spans. */
export const withLocalTracing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  LocalTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (local) => effect.pipe(Effect.provideService(Tracer.Tracer, local)),
      }),
    ),
  );

// Relay exports keep error types. Messages and stacks can contain customer data.
function traceSafeError(value: unknown, seen = new WeakSet<object>()): Error {
  const name =
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
      ? value.name
      : "Error";

  let cause: Error | undefined;
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    if ("cause" in value && value.cause !== undefined) {
      cause = traceSafeError(value.cause, seen);
    }
  }

  const error = new Error(name, cause ? { cause } : undefined);
  error.name = name;
  error.stack = cause ? `${name}\nCaused by: ${cause.stack}` : name;
  return error;
}

function traceSafeExit(exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) {
    return exit;
  }
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) {
          return Cause.makeFailReason(traceSafeError(reason.error));
        }
        if (Cause.isDieReason(reason)) {
          return Cause.makeDieReason(traceSafeError(reason.defect));
        }
        return reason;
      }),
    ),
  );
}

// Relay-traced requests can target a user's machine, including over LAN or Tailscale.
const REQUEST_ADDRESS_ATTRIBUTES = new Set([
  "url.full",
  "url.query",
  "server.address",
  "server.port",
]);

export function nonInterferingTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      const attribute = span.attribute.bind(span);
      span.end = (endTime, exit) => {
        try {
          end(endTime, traceSafeExit(exit));
        } catch {}
      };
      span.attribute = (key, value) => {
        if (!REQUEST_ADDRESS_ATTRIBUTES.has(key)) attribute(key, value);
      };
      // Effect adds raw logs to span events.
      span.event = () => {};
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

/** A batch queued before an opt-out is dropped when its turn to be sent comes. */
const layerSendWhile = (isEnabled: () => boolean) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((send, request) =>
        isEnabled()
          ? send
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 202 })),
            ),
      ),
    ),
  );

/** Spans started while `isEnabled` says no stay local instead of being exported. */
function gatedTracer(delegate: Tracer.Tracer, isEnabled: () => boolean): Tracer.Tracer {
  return Tracer.make({
    span: (options) => (isEnabled() ? delegate.span(options) : Tracer.nativeTracer.span(options)),
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

export function layer(
  config: RelayClientTracingConfig | null,
  resource: RelayClientTracingResource,
  options?: { readonly isEnabled?: () => boolean },
): Layer.Layer<never, never, HttpClient.HttpClient> {
  if (config === null) {
    return Layer.succeed(RelayClientTracer, Option.none());
  }

  const headers = buildRelayTracingHeaders(config);
  const layerTracer = OtlpTracer.layer({
    url: config.tracesUrl,
    ...(headers ? { headers } : {}),
    resource: {
      serviceName: resource.serviceName,
      serviceVersion: resource.serviceVersion,
      attributes: {
        "service.namespace": "t3code",
        "service.instance.id": resource.serviceInstanceId,
        "service.runtime": resource.runtime,
        "t3code.component": resource.component ?? "relay-client",
        "t3code.client.surface": resource.client,
        ...resource.attributes,
      },
    },
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    // An operator's OTEL_RESOURCE_ATTRIBUTES describe their machines for their own receiver.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
    options?.isEnabled ? Layer.provide(layerSendWhile(options.isEnabled)) : identity,
  );

  return Layer.effect(
    RelayClientTracer,
    Tracer.Tracer.pipe(
      Effect.map(nonInterferingTracer),
      Effect.map((tracer) =>
        options?.isEnabled ? gatedTracer(tracer, options.isEnabled) : tracer,
      ),
      Effect.asSome,
    ),
  ).pipe(Layer.provide(layerTracer));
}
