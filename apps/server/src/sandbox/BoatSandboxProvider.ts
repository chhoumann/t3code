/**
 * BoatSandboxProvider - the boat.dev implementation of SandboxProvider over
 * the Boat v1 REST API (https://docs.boat.dev/openapi/boat-v1.yaml). Boat
 * JSON is decoded here and nowhere else.
 *
 * @module BoatSandboxProvider
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ProviderMachineId,
  SandboxProvider,
  SandboxProviderError,
  type ProviderMachine,
  type ProviderMachineState,
  type SandboxProviderAccount,
  type SandboxProviderErrorKind,
  type SandboxProviderOperation,
} from "./SandboxProvider.ts";

const BOAT_API_BASE_URL = "https://boat.dev/api/v1";

const BoatSandboxState = Schema.Literals([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
]);
type BoatSandboxState = typeof BoatSandboxState.Type;

const BoatSandbox = Schema.Struct({
  id: Schema.String,
  state: BoatSandboxState,
  setupStatus: Schema.optional(
    Schema.NullOr(Schema.Literals(["pending", "running", "done", "failed"])),
  ),
});
type BoatSandbox = typeof BoatSandbox.Type;

const BoatSandboxEnvelope = Schema.Struct({ sandbox: BoatSandbox });

const BoatCommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});

const BoatHostResult = Schema.Struct({ url: Schema.String });

const BoatErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  error: Schema.optional(
    Schema.Struct({
      details: Schema.optional(Schema.Struct({ retryable: Schema.optional(Schema.Boolean) })),
    }),
  ),
});

const MACHINE_STATE: Record<BoatSandboxState, ProviderMachineState> = {
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "stopping",
  archived: "stopped",
  error: "failed",
  cancelled: "failed",
};

const LIMIT_CODES = new Set([
  "limit_reached",
  "member_limit_reached",
  "trial_machine_class_not_allowed",
  "machine_class_plan_required",
]);
const TRANSIENT_CODES = new Set([
  "rate_limited",
  "idempotency_in_progress",
  "boat_starting",
  "no_ready_machine",
  "out_of_capacity",
]);

/** Pure mapping from a Boat error response to the provider-neutral error kind. */
export function classifyBoatError(input: {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
}): SandboxProviderErrorKind {
  const code = input.code ?? "";
  if (LIMIT_CODES.has(code) || input.status === 402) return "limit";
  if (input.retryable || TRANSIENT_CODES.has(code) || input.status >= 500) return "transient";
  if (input.status === 401) return "unauthorized";
  if (input.status === 403) return "missing-scope";
  if (input.status === 404) return "not-found";
  return "invalid";
}

/**
 * Exec is the one call Boat never makes safe to repeat: a 5xx can mean the
 * command already ran. It is retried only when Boat says it never started.
 */
const shouldRetry = (error: SandboxProviderError) =>
  error.kind === "transient" && (error.operation !== "exec" || error.code === "boat_starting");

const RETRY_SCHEDULE = Schedule.exponential(Duration.millis(500), 2);
const RETRY_TIMES = 5;

const toMachine = (sandbox: BoatSandbox): ProviderMachine => ({
  id: ProviderMachineId.make(sandbox.id),
  state: MACHINE_STATE[sandbox.state],
  setup: sandbox.setupStatus ?? null,
});

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const send = <A, I>(
    operation: SandboxProviderOperation,
    account: SandboxProviderAccount,
    request: HttpClientRequest.HttpClientRequest,
    success: Schema.Codec<A, I>,
    options: { readonly notFound?: A } = {},
  ): Effect.Effect<A, SandboxProviderError> =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(BOAT_API_BASE_URL),
          HttpClientRequest.bearerToken(Redacted.value(account.apiKey)),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) => new SandboxProviderError({ operation, kind: "transient", cause }),
        ),
        Effect.flatMap((response) => {
          if (response.status >= 200 && response.status < 300) {
            return HttpClientResponse.schemaBodyJson(success)(response).pipe(
              Effect.mapError(
                (cause) =>
                  new SandboxProviderError({
                    operation,
                    kind: "invalid",
                    status: response.status,
                    cause,
                  }),
              ),
            );
          }
          if (response.status === 404 && "notFound" in options) {
            return Effect.succeed(options.notFound as A);
          }
          return HttpClientResponse.schemaBodyJson(BoatErrorBody)(response).pipe(
            Effect.orElseSucceed(() => ({
              code: undefined,
              retryable: undefined,
              error: undefined,
            })),
            Effect.flatMap((body) =>
              Effect.fail(
                new SandboxProviderError({
                  operation,
                  kind: classifyBoatError({
                    status: response.status,
                    code: body.code,
                    retryable: body.retryable === true || body.error?.details?.retryable === true,
                  }),
                  status: response.status,
                  ...(body.code === undefined ? {} : { code: body.code }),
                }),
              ),
            ),
          );
        }),
        Effect.retry({ while: shouldRetry, schedule: RETRY_SCHEDULE, times: RETRY_TIMES }),
        Effect.withSpan(`sandbox.boat.${operation}`),
      );

  const sandboxPath = (id: ProviderMachineId, suffix = "") =>
    `/sandboxes/${encodeURIComponent(id)}${suffix}`;

  const create: SandboxProvider["Service"]["create"] = (account, input) =>
    send(
      "create",
      account,
      HttpClientRequest.post("/sandboxes").pipe(
        HttpClientRequest.setHeader("Idempotency-Key", input.idempotencyKey),
        HttpClientRequest.bodyJsonUnsafe({
          type: input.size,
          ttlSeconds: input.ttlSeconds,
          env: input.env,
          setupScript: input.setupScript,
          ...(input.template === null ? {} : { from: input.template }),
          ...(input.providerEnvironment === null
            ? { noEnv: true }
            : { environment: input.providerEnvironment }),
        }),
      ),
      BoatSandboxEnvelope,
    ).pipe(Effect.map((body) => toMachine(body.sandbox)));

  const inspect: SandboxProvider["Service"]["inspect"] = (account, id) =>
    send("inspect", account, HttpClientRequest.get(sandboxPath(id)), BoatSandboxEnvelope, {
      notFound: null,
    }).pipe(Effect.map((body) => (body === null ? null : toMachine(body.sandbox))));

  const exec: SandboxProvider["Service"]["exec"] = (account, id, input) =>
    send(
      "exec",
      account,
      HttpClientRequest.post(sandboxPath(id, "/commands")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          command: input.command,
          timeoutSeconds: input.timeoutSeconds,
        }),
      ),
      BoatCommandResult,
    );

  const writeFile: SandboxProvider["Service"]["writeFile"] = (account, id, input) =>
    send(
      "writeFile",
      account,
      HttpClientRequest.put(sandboxPath(id, "/files")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          path: input.path,
          content: Base64.encode(input.content),
          encoding: "base64",
        }),
      ),
      Schema.Unknown,
    ).pipe(Effect.asVoid);

  const host: SandboxProvider["Service"]["host"] = (account, id, port) =>
    send(
      "host",
      account,
      HttpClientRequest.post(sandboxPath(id, "/host")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ port, public: true }),
      ),
      BoatHostResult,
    ).pipe(Effect.map((body) => new URL(body.url).origin));

  const stop: SandboxProvider["Service"]["stop"] = (account, id) =>
    send(
      "stop",
      account,
      HttpClientRequest.post(sandboxPath(id, "/stop")).pipe(HttpClientRequest.bodyJsonUnsafe({})),
      Schema.Unknown,
    ).pipe(Effect.asVoid);

  const resume: SandboxProvider["Service"]["resume"] = (account, id) =>
    send(
      "resume",
      account,
      HttpClientRequest.post(sandboxPath(id, "/resume")).pipe(HttpClientRequest.bodyJsonUnsafe({})),
      Schema.Unknown,
    ).pipe(Effect.asVoid);

  const destroy: SandboxProvider["Service"]["destroy"] = (account, id) =>
    send(
      "destroy",
      account,
      HttpClientRequest.make("DELETE")(sandboxPath(id)).pipe(
        HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
      ),
      Schema.Unknown,
      { notFound: undefined },
    ).pipe(Effect.asVoid);

  return SandboxProvider.of({ create, inspect, exec, writeFile, host, stop, resume, destroy });
});

export const layer = Layer.effect(SandboxProvider, make);
