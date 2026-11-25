import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import { setConnectionTracesEnabled } from "./diagnosticsSetting";
import * as Tracing from "./tracing";

const expoConstants = vi.hoisted(() => ({
  expoConfig: { extra: {} as Record<string, unknown> },
}));
vi.mock("expo-constants", () => ({ default: expoConstants }));

it("leaves mobile tracing off when no receiver is configured", () => {
  expoConstants.expoConfig.extra = { observability: { tracesUrl: null, tracesDataset: null } };
  expect(Tracing.resolveTracingConfig()).toBeNull();
});

it.effect("sends spans to a generic OTLP receiver with only its own headers", () =>
  Effect.gen(function* () {
    setConnectionTracesEnabled(true);
    expoConstants.expoConfig.extra = {
      observability: {
        tracesUrl: "https://otel.example.test/v1/traces",
        tracesHeaders: "x-api-key=mobile%20key",
      },
    };
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const layerTracing = Tracing.layerFromConfig(Tracing.resolveTracingConfig(), {
      appVariant: "test",
      serviceInstanceId: "test-instance",
    }).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));

    // Closing the layer's scope flushes the exporter.
    yield* Effect.void.pipe(
      Effect.withSpan("mobile.test.span"),
      withRelayClientTracing,
      Effect.provide(layerTracing),
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://otel.example.test/v1/traces");
    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("mobile key");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-axiom-dataset")).toBe(false);
  }),
);

const layerTracingTo = (fetchFn: typeof fetch) =>
  Tracing.layerFromConfig(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceInstanceId: "test-instance",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));

it.effect.each([false, true])("gates relay sends and preserves typed failures (%s)", (enabled) => {
  setConnectionTracesEnabled(enabled);
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = layerTracingTo(fetchFn);
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
    Effect.fail(failure).pipe(
      Effect.withSpan("mobile.test.failed-span"),
      withRelayClientTracing,
      Effect.exit,
      Effect.flatMap((exit) => {
        const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
        return reason && Cause.isFailReason(reason)
          ? Effect.sync(() => {
              expect(reason.error).toBe(failure);
            })
          : Effect.die(new Error("Expected the original typed failure."));
      }),
    ),
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledTimes(Number(enabled));
        if (!enabled) return;
        expect(new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array)).toContain(
          "mobile.test.failed-span",
        );
      }),
    ),
  );
});
