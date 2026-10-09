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

const BoatSandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
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
  message: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  error: Schema.optional(
    Schema.Struct({
      details: Schema.optional(Schema.Struct({ retryable: Schema.optional(Schema.Boolean) })),
    }),
  ),
});

/** A state Boat adds later reads as starting, so the lifecycle waits on it instead of failing. */
const MACHINE_STATE = new Map<string, ProviderMachineState>([
  ["init", "starting"],
  ["provisioning", "starting"],
  ["provisioned", "starting"],
  ["cloning", "starting"],
  ["ready", "running"],
  ["idle", "running"],
  ["running", "running"],
  ["archiving", "stopping"],
  ["archived", "stopped"],
  ["error", "failed"],
  ["cancelled", "failed"],
]);

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
function classifyBoatError(input: {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
}): SandboxProviderErrorKind {
  const code = input.code ?? "";
  if (LIMIT_CODES.has(code) || input.status === 402) return "limit";
  // A conflict is the machine's state for now, such as a stop still landing; asking again later succeeds.
  if (input.retryable || TRANSIENT_CODES.has(code) || input.status === 409 || input.status >= 500) {
    return "transient";
  }
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
/** Long enough for any plan-limit sentence, short enough to show as a status. */
const PROVIDER_MESSAGE_MAX = 300;

/** Boat machine ids start with `bx_`, so no machine ever has this one. */
const PROBE_MACHINE = "t3-preflight-probe";
const probePath = `/sandboxes/${PROBE_MACHINE}`;

/**
 * One request per Boat action sandboxes take. Boat refuses a scoped key's
 * missing action with 403 before looking any further, so every allowed probe
 * ends at the missing probe machine or, for create, at a body Boat rejects
 * before creating anything: no machine type has the probe's name, and the
 * setup script is not a string. Were one ever made, it would stop within a
 * minute.
 */
const ACCESS_PROBES: ReadonlyArray<{
  readonly action: string;
  readonly request: HttpClientRequest.HttpClientRequest;
}> = [
  {
    action: "sandbox.create",
    request: HttpClientRequest.post("/sandboxes").pipe(
      HttpClientRequest.setHeader("Idempotency-Key", PROBE_MACHINE),
      HttpClientRequest.bodyJsonUnsafe({
        type: PROBE_MACHINE,
        setupScript: 0,
        ttlSeconds: 60,
        noEnv: true,
      }),
    ),
  },
  { action: "sandbox.read", request: HttpClientRequest.get(probePath) },
  {
    action: "sandbox.stop",
    request: HttpClientRequest.post(`${probePath}/stop`).pipe(HttpClientRequest.bodyJsonUnsafe({})),
  },
  {
    action: "sandbox.resume",
    request: HttpClientRequest.post(`${probePath}/resume`).pipe(
      HttpClientRequest.bodyJsonUnsafe({}),
    ),
  },
  {
    action: "sandbox.delete",
    request: HttpClientRequest.make("DELETE")(probePath).pipe(
      HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", PROBE_MACHINE),
    ),
  },
  {
    action: "exec",
    request: HttpClientRequest.post(`${probePath}/commands`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ command: "true", timeoutSeconds: 1 }),
    ),
  },
  {
    action: "file.write",
    request: HttpClientRequest.put(`${probePath}/files`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        path: "/home/user/probe",
        content: "",
        encoding: "base64",
      }),
    ),
  },
  {
    action: "host",
    request: HttpClientRequest.post(`${probePath}/host`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ port: 3773, public: true }),
    ),
  },
];

const toMachine = (sandbox: BoatSandbox): ProviderMachine => ({
  id: ProviderMachineId.make(sandbox.id),
  state: MACHINE_STATE.get(sandbox.state) ?? "starting",
  setup: sandbox.setupStatus ?? null,
});

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const execute = (account: SandboxProviderAccount, request: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(
      request.pipe(
        HttpClientRequest.prependUrl(BOAT_API_BASE_URL),
        HttpClientRequest.bearerToken(Redacted.value(account.apiKey)),
        HttpClientRequest.acceptJson,
      ),
    );

  const send = <A, I>(
    operation: SandboxProviderOperation,
    account: SandboxProviderAccount,
    request: HttpClientRequest.HttpClientRequest,
    success: Schema.Codec<A, I>,
    options: { readonly notFound?: A } = {},
  ): Effect.Effect<A, SandboxProviderError> =>
    execute(account, request).pipe(
      Effect.mapError((cause) => new SandboxProviderError({ operation, kind: "transient", cause })),
      Effect.flatMap((response) => {
        if (response.status >= 200 && response.status < 300) {
          // Boat acted, but what it did is unknown: asking again with the same key finds out.
          return HttpClientResponse.schemaBodyJson(success)(response).pipe(
            Effect.mapError(
              (cause) =>
                new SandboxProviderError({
                  operation,
                  kind: "transient",
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
            message: undefined,
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
                ...(body.message === undefined || body.message === body.code
                  ? {}
                  : { providerMessage: body.message.slice(0, PROVIDER_MESSAGE_MAX) }),
              }),
            ),
          ),
        );
      }),
      Effect.retry({ while: shouldRetry, schedule: RETRY_SCHEDULE, times: RETRY_TIMES }),
      Effect.withSpan(`sandbox.boat.${operation}`),
    );

  const checkAccess: SandboxProvider["Service"]["checkAccess"] = (account) =>
    Effect.forEach(
      ACCESS_PROBES,
      ({ action, request }) =>
        execute(account, request).pipe(
          Effect.mapError(
            (cause) =>
              new SandboxProviderError({ operation: "check-access", kind: "transient", cause }),
          ),
          Effect.flatMap((response) =>
            response.status === 401
              ? Effect.fail(
                  new SandboxProviderError({
                    operation: "check-access",
                    kind: "unauthorized",
                    status: response.status,
                  }),
                )
              : response.status >= 500
                ? Effect.fail(
                    new SandboxProviderError({
                      operation: "check-access",
                      kind: "transient",
                      status: response.status,
                    }),
                  )
                : Effect.succeed(response.status === 403 ? [action] : []),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((missing) => missing.flat()),
      Effect.retry({ while: shouldRetry, schedule: RETRY_SCHEDULE, times: RETRY_TIMES }),
      Effect.withSpan("sandbox.boat.check-access"),
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

  return SandboxProvider.of({
    checkAccess,
    create,
    inspect,
    exec,
    writeFile,
    host,
    stop,
    resume,
    destroy,
  });
});

export const layer = Layer.effect(SandboxProvider, make);
