import { describe, expect, it } from "@effect/vitest";
import { SandboxMachineSize } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
const isMachineSize = Schema.is(SandboxMachineSize);
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
  it.effect("lists only ready templates in name order using the selected account", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run(
        [
          () =>
            new Response(
              JSON.stringify({
                snapshots: [
                  { name: "zeta", status: "ready" },
                  { name: "saving-template", status: "saving" },
                  { name: "alpha", status: "ready" },
                  { name: "failed-template", status: "failed" },
                ],
              }),
            ),
        ],
        (provider) => provider.listTemplates({ apiKey: Redacted.make("selected-account-key") }),
      );
      expect(exit._tag === "Success" && exit.value).toEqual(["alpha", "zeta"]);
      expect(seen[0]).toMatchObject({
        method: "GET",
        url: "https://boat.dev/api/v1/named-snapshots",
        headers: { authorization: "Bearer selected-account-key" },
      });
    }),
  );

  it.effect("reports a template permission failure instead of an empty list", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run([() => boatError(403, "action_not_allowed")], (provider) =>
        provider.listTemplates(account).pipe(Effect.flip),
      );
      expect(exit._tag === "Success" && exit.value).toMatchObject({
        operation: "list-templates",
        kind: "missing-scope",
      });
      expect(seen).toHaveLength(1);
    }),
  );

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
            template: null,
            providerEnvironment: null,
            setupScript: "true",
          }),
      );
      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value).toEqual({
          id: "bx_23456789",
          state: "starting",
          setup: "pending",
          archiveAfter: null,
        });
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

  it.effect("treats an accepted create whose reply cannot be read as unknown, not refused", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run(
        [
          () => new Response("<html>gateway</html>", { status: 202 }),
          () => new Response(JSON.stringify({ ok: true, sandbox }), { status: 202 }),
        ],
        (provider) =>
          provider.create(account, {
            idempotencyKey: "sandbox-1",
            size: "small",
            ttlSeconds: 3600,
            template: null,
            providerEnvironment: null,
            setupScript: "true",
          }),
      );
      expect(exit._tag === "Success" && exit.value.id).toBe("bx_23456789");
      expect(seen.map((request) => request.headers["idempotency-key"])).toEqual([
        "sandbox-1",
        "sandbox-1",
      ]);
    }),
  );

  it.effect("reads a machine state Boat added later as starting", () =>
    Effect.gen(function* () {
      const { exit } = yield* run(
        [
          () =>
            new Response(JSON.stringify({ ok: true, sandbox: { ...sandbox, state: "migrating" } })),
        ],
        (provider) => provider.inspect(account, machineId),
      );
      expect(exit._tag === "Success" && exit.value).toEqual({
        id: "bx_23456789",
        state: "starting",
        setup: "pending",
        archiveAfter: null,
      });
    }),
  );

  it.effect("reads when Boat will stop a machine on its own", () =>
    Effect.gen(function* () {
      const { exit } = yield* run(
        [
          () =>
            new Response(
              JSON.stringify({
                ok: true,
                sandbox: { ...sandbox, state: "idle", archiveAfter: "2026-05-31T13:00:00Z" },
              }),
            ),
        ],
        (provider) => provider.inspect(account, machineId),
      );
      expect(exit._tag === "Success" && exit.value).toEqual({
        id: "bx_23456789",
        state: "running",
        setup: "pending",
        archiveAfter: 1_780_232_400_000,
      });
    }),
  );

  it.effect("moves Boat's own stop in whole seconds within Boat's bounds, never earlier", () =>
    Effect.gen(function* () {
      const ok = () => new Response(JSON.stringify({ ok: true, sandbox }));
      const { exit, seen } = yield* run([ok, ok, ok], (provider) =>
        Effect.forEach([4200.2, 0.2, 40 * 24 * 60 * 60], (ttlSeconds) =>
          provider.setDeadline(account, machineId, ttlSeconds),
        ),
      );
      expect(exit._tag).toBe("Success");
      expect(seen.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
        {
          method: "PATCH",
          url: "https://boat.dev/api/v1/sandboxes/bx_23456789",
          body: { ttlSeconds: 4201 },
        },
        {
          method: "PATCH",
          url: "https://boat.dev/api/v1/sandboxes/bx_23456789",
          body: { ttlSeconds: 1 },
        },
        {
          method: "PATCH",
          url: "https://boat.dev/api/v1/sandboxes/bx_23456789",
          body: { ttlSeconds: 2_592_000 },
        },
      ]);
    }),
  );

  it.effect("gives a resumed machine a fresh auto-stop, or none", () =>
    Effect.gen(function* () {
      const ok = () => new Response(JSON.stringify({ ok: true }));
      const { exit, seen } = yield* run([ok, ok], (provider) =>
        Effect.forEach([4200, null], (ttlSeconds) =>
          provider.resume(account, machineId, { ttlSeconds }),
        ),
      );
      expect(exit._tag).toBe("Success");
      expect(seen.map(({ url, body }) => ({ url, body }))).toEqual([
        { url: "https://boat.dev/api/v1/sandboxes/bx_23456789/resume", body: { ttlSeconds: 4200 } },
        { url: "https://boat.dev/api/v1/sandboxes/bx_23456789/resume", body: { ttlSeconds: null } },
      ]);
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

  it.effect("retries a conflict, such as a resume while a stop is still landing", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run(
        [() => boatError(409, "sandbox_busy"), () => new Response(JSON.stringify({ ok: true }))],
        (provider) => provider.resume(account, machineId, { ttlSeconds: 3600 }),
      );
      expect(exit._tag).toBe("Success");
      expect(seen).toHaveLength(2);
    }),
  );

  it.effect("reports plan limits as limits without retrying", () =>
    Effect.gen(function* () {
      const { exit, seen } = yield* run([() => boatError(429, "limit_reached")], (provider) =>
        provider.resume(account, machineId, { ttlSeconds: 3600 }).pipe(Effect.flip),
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

  it.effect("names the actions a scoped key lacks, without touching any real machine", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const refused = new Set([
        "POST /api/v1/sandboxes/t3-preflight-probe/resume",
        "POST /api/v1/sandboxes/t3-preflight-probe/host",
      ]);
      const layer = BoatSandboxProvider.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                const body =
                  request.body._tag === "Uint8Array"
                    ? JSON.parse(new TextDecoder().decode(request.body.body))
                    : undefined;
                seen.push({
                  method: request.method,
                  url: request.url,
                  headers: request.headers,
                  body,
                });
                const route = `${request.method} ${new URL(request.url).pathname}`;
                return HttpClientResponse.fromWeb(
                  request,
                  refused.has(route)
                    ? boatError(403, "forbidden")
                    : route === "POST /api/v1/sandboxes"
                      ? boatError(400, "invalid_setup_script")
                      : boatError(404, "not_found"),
                );
              }),
            ),
          ),
        ),
      );
      const missing = yield* Effect.flatMap(Effect.service(SandboxProvider), (provider) =>
        provider.checkAccess(account),
      ).pipe(Effect.provide(layer));

      expect(missing).toEqual(["sandbox.resume", "host"]);
      expect(seen).toHaveLength(8);
      for (const request of seen) {
        expect(new URL(request.url).pathname).toMatch(
          /^\/api\/v1\/sandboxes(\/t3-preflight-probe(\/[a-z]+)?)?$/,
        );
      }
      const create = seen.find((request) => new URL(request.url).pathname === "/api/v1/sandboxes");
      const body = create?.body as Record<string, unknown> | undefined;
      // Each alone keeps Boat from provisioning a machine.
      expect(isMachineSize(body?.["type"])).toBe(false);
      expect(typeof body?.["setupScript"]).not.toBe("string");
      expect(body?.["ttlSeconds"]).toBe(60);
    }),
  );

  it.effect("fails the access check for a key Boat does not recognize", () =>
    Effect.gen(function* () {
      const { exit } = yield* run(
        Array.from({ length: 8 }, () => () => boatError(401, "unauthorized")),
        (provider) => provider.checkAccess(account).pipe(Effect.flip),
      );
      expect(exit._tag === "Success" && exit.value).toMatchObject({
        kind: "unauthorized",
        operation: "check-access",
      });
    }),
  );

  it.effect("carries Boat's explanation of a plan limit into the error message", () =>
    Effect.gen(function* () {
      const { exit } = yield* run(
        [
          () =>
            new Response(
              JSON.stringify({
                ok: false,
                status: 403,
                code: "trial_machine_class_not_allowed",
                message: "Trial accounts can only create small and default sandboxes.",
              }),
              { status: 403 },
            ),
        ],
        (provider) =>
          provider
            .create(account, {
              idempotencyKey: "sandbox-1",
              size: "large",
              ttlSeconds: 3600,
              template: null,
              providerEnvironment: null,
              setupScript: "true",
            })
            .pipe(Effect.flip),
      );
      expect(exit._tag === "Success" && exit.value.message).toBe(
        "Sandbox create failed: an account limit was reached (trial_machine_class_not_allowed). Trial accounts can only create small and default sandboxes.",
      );
    }),
  );
});
