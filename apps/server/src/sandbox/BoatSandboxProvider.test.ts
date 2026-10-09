import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BoatSandboxProvider from "./BoatSandboxProvider.ts";
import { ProviderMachineId, SandboxProvider } from "./SandboxProvider.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const account = { apiKey: Redacted.make("test-key") };
const machineId = ProviderMachineId.make("bx_23456789");
const sandbox = { id: "bx_23456789", state: "provisioning", setupStatus: "pending" };

const boatError = (status: number, code: string) =>
  new Response(
    JSON.stringify({ ok: false, status, code, message: code, error: { code, status } }),
    {
      status,
    },
  );

/** Serves scripted responses in order and records each request. */
const scripted = (responses: ReadonlyArray<() => Response>) => {
  const seen: Array<Seen> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        seen.push({ method: request.method, url: request.url, headers: request.headers, body });
        const next = responses[seen.length - 1] ?? (() => boatError(500, "unexpected_request"));
        return HttpClientResponse.fromWeb(request, next());
      }),
    ),
  );
  return { seen, layer: BoatSandboxProvider.layer.pipe(Layer.provide(layer)) };
};

const run = <A, E>(
  responses: ReadonlyArray<() => Response>,
  use: (provider: SandboxProvider["Service"]) => Effect.Effect<A, E>,
) => {
  const { seen, layer } = scripted(responses);
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flatMap(Effect.service(SandboxProvider), use));
    yield* TestClock.adjust("1 minute");
    const exit = yield* Fiber.await(fiber);
    return { exit, seen };
  }).pipe(Effect.provide(layer));
};

describe("BoatSandboxProvider", () => {
  it.effect("retries a create through Boat outages with the same idempotency key", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run(
        [
          () => boatError(503, "out_of_capacity"),
          () => boatError(502, "bad_gateway"),
          () => new Response(JSON.stringify({ ok: true, sandbox }), { status: 202 }),
        ],
        (provider) =>
          provider.create(account, {
            idempotencyKey: "sandbox-1",
            size: "small",
            ttlSeconds: 3600,
            env: {},
            template: null,
            providerEnvironment: null,
            setupScript: "true",
          }),
      );
      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value).toEqual({ id: "bx_23456789", state: "starting", setup: "pending" });
      }
      expect(seen.map((request) => request.headers["idempotency-key"])).toEqual([
        "sandbox-1",
        "sandbox-1",
        "sandbox-1",
      ]);
      expect(seen[0]?.body).toMatchObject({ type: "small", noEnv: true });
      expect(seen[0]?.headers["authorization"]).toBe("Bearer test-key");
    }),
  );

  it.effect("never repeats a command Boat may already have started", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run([() => boatError(502, "boat_direct_failed")], (provider) =>
        provider
          .exec(account, machineId, { command: "echo hi", timeoutSeconds: 5 })
          .pipe(Effect.flip),
      );
      expect(seen).toHaveLength(1);
      expect(exit._tag === "Success" && exit.value).toMatchObject({ kind: "transient" });
    }),
  );

  it.effect("reports plan limits as limits without retrying", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run([() => boatError(429, "limit_reached")], (provider) =>
        provider.resume(account, machineId).pipe(Effect.flip),
      );
      expect(seen).toHaveLength(1);
      expect(exit._tag === "Success" && exit.value).toMatchObject({
        kind: "limit",
        code: "limit_reached",
        operation: "resume",
      });
    }),
  );

  it.effect("treats a missing machine as gone for inspect and destroy", () =>
    Effect.gen(function* () {
      const inspected = yield* run([() => boatError(404, "not_found")], (provider) =>
        provider.inspect(account, machineId),
      );
      expect(inspected.exit._tag === "Success" && inspected.exit.value).toBeNull();

      const destroyed = yield* run([() => boatError(404, "not_found")], (provider) =>
        provider.destroy(account, machineId),
      );
      expect(destroyed.exit._tag).toBe("Success");
      expect(destroyed.seen[0]?.headers["x-ascii-confirm-delete"]).toBe("bx_23456789");
    }),
  );

  it.effect("returns a hosted URL without any provider token", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run(
        [
          () =>
            new Response(
              JSON.stringify({ ok: true, url: "https://box-1-3773.on.boat.dev/?_token=secret" }),
            ),
        ],
        (provider) => provider.host(account, machineId, 3773),
      );
      expect(exit._tag === "Success" && exit.value).toBe("https://box-1-3773.on.boat.dev");
      expect(seen[0]?.body).toEqual({ port: 3773, public: true });
    }),
  );
});
