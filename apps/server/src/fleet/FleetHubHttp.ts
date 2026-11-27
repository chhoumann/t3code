/**
 * HttpRouter routes for the Fleet Hub (`/_fleet/*` and `/_env/:environmentId/*`)
 * and guest reverse-dial accept (`/_fleet/accept`). Mounted BEFORE static routes.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { EnvironmentId, SandboxAccountId } from "@t3tools/contracts";
import { FleetMuxEndpoint } from "@t3tools/shared/fleetMux";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { requestUrl } from "../requestUrl.ts";
import {
  AttachedProviderError,
  AttachedProviderRegistry,
  type AttachedProviderOp,
} from "./AttachedProviderRegistry.ts";
import { attachMuxToEffectSocket } from "./fleetMuxNode.ts";
import { FleetHubService } from "./FleetHubService.ts";
import { GuestFleetRuntime } from "./GuestFleetRuntime.ts";
import * as SandboxAccounts from "../sandbox/SandboxAccounts.ts";

class FleetProviderDecodeError extends Schema.TaggedError<FleetProviderDecodeError>()(
  "FleetProviderDecodeError",
  { cause: Schema.Defect() },
) {}

function constantTimeMatch(candidate: string | null, expected: string): boolean {
  if (!candidate || expected.length === 0) return false;
  const bufA = Buffer.from(candidate, "utf8");
  const bufB = Buffer.from(expected, "utf8");
  if (bufA.byteLength !== bufB.byteLength) return false;
  return NodeCrypto.timingSafeEqual(bufA, bufB);
}

export const routeLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/_fleet/bootstrap/:token",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleBootstrapHttp(req, params.token ?? "");
    }),
  ),
  HttpRouter.add(
    "GET",
    "/_fleet/connect",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleConnectWs(req);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/_fleet/accept",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const guestRuntime = yield* GuestFleetRuntime;
      return yield* guestRuntime.acceptHubUpgrade(req);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/_fleet/provider",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const parsed = requestUrl(req);
      if (Option.isNone(parsed)) {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }
      const accountIdParam = parsed.value.searchParams.get("accountId");
      if (!accountIdParam) {
        return HttpServerResponse.text("Missing accountId", { status: 400 });
      }
      const accountId = SandboxAccountId.make(accountIdParam);
      const accounts = yield* SandboxAccounts.SandboxAccounts;
      const account = yield* accounts.get(accountId).pipe(Effect.orElseSucceed(() => null));
      const secretParam = parsed.value.searchParams.get("secret");
      if (account !== null) {
        const storedSecret = account.apiKey ? Redacted.value(account.apiKey) : "";
        if (storedSecret.length > 0 && !constantTimeMatch(secretParam, storedSecret)) {
          // Allow matching against node/provider attach token if configured; otherwise verify bearer/secret.
          const authHeader = req.headers.authorization;
          const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
          if (!constantTimeMatch(bearer, storedSecret)) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
        }
      }

      const registry = yield* AttachedProviderRegistry;
      const socket = yield* req.upgrade.pipe(Effect.orDie);
      let activeEndpoint: FleetMuxEndpoint | null = null;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { endpoint, run } = yield* attachMuxToEffectSocket(socket, {
            initiator: false,
          });
          activeEndpoint = endpoint;
          const unregister = registry.register(accountId, {
            call: (op: AttachedProviderOp, payload: unknown) =>
              Effect.tryPromise({
                try: () => endpoint.requestControl(op, payload),
                catch: (cause) =>
                  new AttachedProviderError({
                    kind: "transient",
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
          });
          yield* run.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                unregister();
                if (activeEndpoint === endpoint) activeEndpoint = null;
              }),
            ),
          );
        }),
      ).pipe(Effect.ignore);
      return HttpServerResponse.empty();
    }),
  ),
  HttpRouter.add(
    "*",
    "/_fleet/internal/:secret/:environmentId/*",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleInternalMuxRequest(
        req,
        params.secret ?? "",
        EnvironmentId.make(params.environmentId ?? ""),
        `/${params["*"] ?? ""}`,
      );
    }),
  ),
  HttpRouter.add(
    "*",
    "/_fleet/internal/:secret/:environmentId",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleInternalMuxRequest(
        req,
        params.secret ?? "",
        EnvironmentId.make(params.environmentId ?? ""),
        "/",
      );
    }),
  ),
  HttpRouter.add(
    "*",
    "/_env/:environmentId/*",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleEnvRequest(
        req,
        EnvironmentId.make(params.environmentId ?? ""),
        `/${params["*"] ?? ""}`,
      );
    }),
  ),
  HttpRouter.add(
    "*",
    "/_env/:environmentId",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const fleetHub = yield* FleetHubService;
      return yield* fleetHub.handleEnvRequest(
        req,
        EnvironmentId.make(params.environmentId ?? ""),
        "/",
      );
    }),
  ),
);

void Schema.is(FleetProviderDecodeError);
