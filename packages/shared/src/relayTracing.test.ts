import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

import {
  layer,
  nonInterferingTracer,
  RelayClientTracer,
  resolveRelayClientTracingConfig,
  withLocalTracing,
  withRelayClientTracing,
} from "./relayTracing.ts";

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

describe("withRelayClientTracing", () => {
  it.effect("uses the product tracer only for relay operations", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(Effect.withSpan("user.operation"), Effect.withTracer(userTracer));
      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["user.operation"]);
      expect(productSpans).toEqual(["relay.operation"]);
    }),
  );
});

describe("nonInterferingTracer", () => {
  it.effect("exports failure types without messages or frames", () =>
    Effect.gen(function* () {
      const exits: Array<Exit.Exit<unknown, unknown>> = [];
      const delegate = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            exits.push(exit);
          };
          return span;
        },
      });
      const failure = Object.assign(
        new Error("studio-mac could not establish a WebSocket connection.", {
          cause: new Error("connect ECONNREFUSED studio-mac.local"),
        }),
        { name: "ConnectionTransientError" },
      );

      failure.stack = "    at connect (/home/user/private.mjs:12:34)";

      yield* Effect.fail(failure).pipe(
        Effect.withSpan("relay.connection.attempt"),
        Effect.withTracer(nonInterferingTracer(delegate)),
        Effect.ignore,
      );

      const exit = exits[0];
      if (exit === undefined || !Exit.isFailure(exit)) throw new Error("expected a failed span");
      const exported = Cause.prettyErrors(exit.cause);
      expect(exported.map((error) => error.name)).toEqual(["ConnectionTransientError"]);
      const text = exported.map((error) => `${error.message}\n${error.stack}`).join("\n");
      expect(text).toContain("Caused by: Error");
      expect(text).not.toContain("studio-mac");
      expect(text).not.toContain("private.mjs");
    }),
  );
});

it.effect.each([true, false])("filters relay exports at flush (%s)", (enabledAtFlush) => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  let enabled = true;
  return Effect.logWarning("private error detail").pipe(
    Effect.withSpan("relay.request", {
      attributes: {
        "url.full": "http://studio-mac.local:3773/api/threads?cursor=secret",
        "url.path": "/api/threads",
        "url.query": "cursor=secret",
        "server.address": "studio-mac.local",
        "server.port": 3773,
      },
    }),
    withRelayClientTracing,
    Effect.andThen(Effect.sync(() => (enabled = enabledAtFlush))),
    Layer.effectDiscard,
    Layer.provide(
      layer(
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
        { serviceName: "t3code-test", runtime: "node", serviceInstanceId: "id", client: "test" },
        { isEnabled: () => enabled },
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ OTEL_RESOURCE_ATTRIBUTES: "host.name=private-host" }),
      ),
    ),
    Layer.build,
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledTimes(Number(enabledAtFlush));
        if (!enabledAtFlush) return;
        const sent = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
        expect(sent).toContain("/api/threads");
        expect(sent).not.toMatch(
          /studio-mac|cursor=secret|server\.port|private error detail|private-host/,
        );
      }),
    ),
  );
});

describe("withLocalTracing", () => {
  it.effect("keeps local work inside a relay span off the product tracer", () =>
    Effect.gen(function* () {
      const localSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const localTracer = collectingTracer(localSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.connection.nested"),
        Effect.andThen(
          Effect.void.pipe(
            Effect.withSpan("sql.execute"),
            Effect.withSpan("ServerSecretStore.get"),
            withLocalTracing,
          ),
        ),
        Effect.withSpan("environment.orchestration.threadSnapshot"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(localTracer),
      );

      expect(productSpans).toEqual([
        "relay.connection.nested",
        "environment.orchestration.threadSnapshot",
      ]);
      expect(localSpans).toEqual(["sql.execute", "ServerSecretStore.get"]);
    }),
  );
});

describe("resolveRelayClientTracingConfig", () => {
  it("accepts a generic OTLP receiver with only a URL", () => {
    expect(
      resolveRelayClientTracingConfig({ tracesUrl: " https://otel.example.com/v1/traces " }),
    ).toEqual({ tracesUrl: "https://otel.example.com/v1/traces" });
  });

  it("parses OTLP header strings", () => {
    expect(
      resolveRelayClientTracingConfig({
        tracesUrl: "https://otel.example.com/v1/traces",
        tracesHeaders: "x-honeycomb-team=abc%3D,x-scope=relay",
      }),
    ).toEqual({
      tracesUrl: "https://otel.example.com/v1/traces",
      tracesHeaders: { "x-honeycomb-team": "abc=", "x-scope": "relay" },
    });
  });

  it("keeps the Axiom dataset and token", () => {
    expect(
      resolveRelayClientTracingConfig({
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "relay",
        tracesToken: "xaat-token",
        tracesHeaders: "",
      }),
    ).toEqual({
      tracesUrl: "https://api.axiom.co/v1/traces",
      tracesDataset: "relay",
      tracesToken: "xaat-token",
    });
  });

  it.each(["no-separator", "=value", "key=%E0%A4%A"])(
    "turns tracing off for malformed headers %j",
    (tracesHeaders) => {
      expect(
        resolveRelayClientTracingConfig({
          tracesUrl: "https://otel.example.com/v1/traces",
          tracesHeaders,
        }),
      ).toBeNull();
    },
  );

  it("allows plain HTTP only to a loopback collector", () => {
    expect(
      resolveRelayClientTracingConfig({ tracesUrl: "http://localhost:4318/v1/traces" }),
    ).toEqual({ tracesUrl: "http://localhost:4318/v1/traces" });
    expect(resolveRelayClientTracingConfig({ tracesUrl: "http://[::1]:4318/v1/traces" })).toEqual({
      tracesUrl: "http://[::1]:4318/v1/traces",
    });
    expect(
      resolveRelayClientTracingConfig({ tracesUrl: "http://example.com/v1/traces" }),
    ).toBeNull();
    expect(resolveRelayClientTracingConfig({ tracesUrl: "" })).toBeNull();
    expect(resolveRelayClientTracingConfig({ tracesUrl: "not a url" })).toBeNull();
  });
});

describe("layer", () => {
  const EXPORTER_TRANSPORT_HEADERS = new Set(["content-type", "content-length", "user-agent"]);
  const exportedHeaders = (config: Parameters<typeof resolveRelayClientTracingConfig>[0]) =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: Record<string, string> }> = [];
      const client = HttpClient.make((request) => {
        requests.push({ url: request.url, headers: { ...request.headers } });
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
        );
      });
      const relayLayer = layer(resolveRelayClientTracingConfig(config), {
        serviceName: "t3code-test",
        runtime: "node",
        serviceInstanceId: "instance",
        client: "test",
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

      // Closing the layer's scope flushes the exporter.
      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.provide(relayLayer),
      );

      expect(requests.map((request) => request.url)).toEqual([config.tracesUrl]);
      return Object.fromEntries(
        Object.entries(requests[0]?.headers ?? {}).filter(
          ([name]) => !EXPORTER_TRANSPORT_HEADERS.has(name),
        ),
      );
    });

  it.effect("sends no auth headers to a generic OTLP receiver", () =>
    Effect.gen(function* () {
      expect(yield* exportedHeaders({ tracesUrl: "http://127.0.0.1:4318/v1/traces" })).toEqual({});
    }),
  );

  it.effect("sends custom OTLP headers", () =>
    Effect.gen(function* () {
      expect(
        yield* exportedHeaders({
          tracesUrl: "https://otel.example.com/v1/traces",
          tracesHeaders: "x-api-key=secret,x-tenant=t3",
        }),
      ).toEqual({ "x-api-key": "secret", "x-tenant": "t3" });
    }),
  );

  it.effect("sends Axiom headers, letting explicit headers override them", () =>
    Effect.gen(function* () {
      expect(
        yield* exportedHeaders({
          tracesUrl: "https://api.axiom.co/v1/traces",
          tracesDataset: "relay",
          tracesToken: "xaat-token",
        }),
      ).toEqual({ authorization: "Bearer xaat-token", "x-axiom-dataset": "relay" });
      expect(
        yield* exportedHeaders({
          tracesUrl: "https://api.axiom.co/v1/traces",
          tracesDataset: "relay",
          tracesToken: "xaat-token",
          tracesHeaders: "Authorization=Basic%20abc",
        }),
      ).toEqual({ authorization: "Basic abc", "x-axiom-dataset": "relay" });
    }),
  );
});
