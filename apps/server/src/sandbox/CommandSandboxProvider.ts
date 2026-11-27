/**
 * 3-verb custom command & attached-provider (`t3 sandbox provider`) SandboxProvider.
 * Supports arbitrary external compute scripts implementing `spawn | pause | destroy`
 * as well as full-verb JSON drivers.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AttachedProviderRegistry from "../fleet/AttachedProviderRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ProviderMachineId,
  SandboxProvider,
  SandboxProviderError,
  type ProviderMachine,
  type ProviderMachineSetup,
  type ProviderMachineState,
  type SandboxProviderAccount,
  type SandboxProviderOperation,
} from "./SandboxProvider.ts";

const EX_UNAVAILABLE = 69;
const EX_USAGE = 64;
const COMMAND_TIMEOUT = Duration.seconds(120);
const COMMAND_MAX_OUTPUT = 8 * 1024 * 1024;

const CommandResponseSchema = Schema.Struct({
  unsupported: Schema.optional(Schema.Boolean),
  machineId: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literals(["starting", "running", "stopping", "stopped", "failed"])),
  setup: Schema.optional(Schema.NullOr(Schema.Literals(["pending", "running", "done", "failed"]))),
  httpBaseUrl: Schema.optional(Schema.NullOr(Schema.String)),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Boolean),
  templates: Schema.optional(Schema.Array(Schema.String)),
  missingActions: Schema.optional(Schema.Array(Schema.String)),
});

const decodeCommandResponseSync = Schema.decodeUnknownSync(CommandResponseSchema);
const decodeCommandResponseOption = Schema.decodeUnknownOption(CommandResponseSchema);

interface TrackedCommandMachine {
  state: ProviderMachineState;
  setup: ProviderMachineSetup;
  httpBaseUrl: string | null;
}

function buildCommandEnv(
  providerOp: AttachedProviderRegistry.AttachedProviderOp,
  payload: Record<string, unknown>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3_SANDBOX_OP: providerOp,
    ...(typeof payload.sandboxId === "string" ? { T3_SANDBOX_ID: payload.sandboxId } : {}),
    ...(typeof payload.environmentId === "string"
      ? { T3_ENVIRONMENT_ID: payload.environmentId }
      : {}),
    ...(typeof payload.idempotencyKey === "string"
      ? { T3_IDEMPOTENCY_KEY: payload.idempotencyKey }
      : {}),
    ...(typeof payload.bootstrapUrl === "string" ? { T3_BOOTSTRAP_URL: payload.bootstrapUrl } : {}),
    ...(typeof payload.nodeSecret === "string" ? { T3_NODE_SECRET: payload.nodeSecret } : {}),
    ...(typeof payload.machineId === "string" ? { T3_MACHINE_ID: payload.machineId } : {}),
  };
}

function encodeCommandJson(value: unknown): string {
  return JSON.stringify(value);
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const attachedOption = yield* Effect.serviceOption(
    AttachedProviderRegistry.AttachedProviderRegistry,
  );
  const trackedMachines = new Map<string, TrackedCommandMachine>();

  const parseJsonResponse = (stdout: string) => {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return decodeCommandResponseSync(parsed);
    } catch {
      return null;
    }
  };

  const invoke = Effect.fn("CommandSandboxProvider.invoke")(function* (
    operation: SandboxProviderOperation,
    providerOp: AttachedProviderRegistry.AttachedProviderOp,
    account: SandboxProviderAccount,
    payload: Record<string, unknown>,
  ): Effect.fn.Return<
    {
      readonly unsupported: boolean;
      readonly json: typeof CommandResponseSchema.Type | null;
      readonly rawStdout: string;
    },
    SandboxProviderError
  > {
    const attached =
      Option.isSome(attachedOption) && account.id !== undefined
        ? attachedOption.value.get(account.id)
        : undefined;

    if (attached !== undefined) {
      const result = yield* attached.call(providerOp, payload).pipe(
        Effect.catchTags({
          AttachedProviderError: (error) =>
            error.kind === "unsupported"
              ? Effect.succeed({ unsupported: true } as unknown)
              : Effect.fail(
                  new SandboxProviderError({
                    operation,
                    kind: error.kind,
                    providerMessage: error.message,
                  }),
                ),
        }),
      );
      const decoded = decodeCommandResponseOption(result);
      const json = Option.getOrNull(decoded);
      return {
        unsupported: json?.unsupported === true,
        json,
        rawStdout: typeof result === "string" ? result : encodeCommandJson(result),
      };
    }

    const program = account.commandProgram;
    if (program === undefined || program === null || program.trim().length === 0) {
      if (operation === "check-access" || operation === "list-templates") {
        return { unsupported: true, json: null, rawStdout: "" };
      }
      return yield* new SandboxProviderError({
        operation,
        kind: "invalid",
        providerMessage:
          "No commandProgram configured and no remote `t3 sandbox provider` daemon is attached for this account.",
      });
    }

    const result = yield* runner
      .run({
        command: program,
        args: [providerOp],
        env: buildCommandEnv(providerOp, payload),
        stdin: encodeCommandJson(payload),
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes: COMMAND_MAX_OUTPUT,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SandboxProviderError({
              operation,
              kind: cause._tag === "ProcessSpawnError" ? "invalid" : "transient",
              providerMessage: cause.message,
              cause,
            }),
        ),
      );

    if (result.code === EX_USAGE || result.code === EX_UNAVAILABLE) {
      return { unsupported: true, json: null, rawStdout: result.stdout };
    }

    const parsed = parseJsonResponse(result.stdout);
    if (parsed?.unsupported === true) {
      return { unsupported: true, json: parsed, rawStdout: result.stdout };
    }

    if (result.timedOut || result.code !== 0) {
      const stderr = result.stderr.trim();
      const notFound = /not found|no such/i.test(stderr);
      return yield* new SandboxProviderError({
        operation,
        kind: notFound ? "not-found" : "transient",
        providerMessage:
          stderr.length > 0 ? stderr.slice(0, 300) : `${program} exited with ${result.code}`,
      });
    }

    return { unsupported: false, json: parsed, rawStdout: result.stdout };
  });

  const checkAccess: SandboxProvider["Service"]["checkAccess"] = (account) =>
    invoke("check-access", "check", account, { accountId: account.id ?? null }).pipe(
      Effect.map((res) => (res.unsupported ? [] : (res.json?.missingActions ?? []))),
    );

  const listTemplates: SandboxProvider["Service"]["listTemplates"] = (account) =>
    invoke("list-templates", "check", account, { listTemplates: true }).pipe(
      Effect.map((res) => (res.unsupported ? [] : (res.json?.templates ?? []))),
    );

  const create: SandboxProvider["Service"]["create"] = Effect.fn("CommandSandboxProvider.create")(
    function* (account, input) {
      const res = yield* invoke("create", "spawn", account, {
        idempotencyKey: input.idempotencyKey,
        sandboxId: input.sandboxId ?? null,
        environmentId: input.environmentId ?? null,
        bootstrapUrl: input.bootstrapUrl ?? null,
        nodeSecret: input.nodeSecret ?? null,
        size: input.size,
        ttlSeconds: input.ttlSeconds,
        template: input.template,
        providerEnvironment: input.providerEnvironment,
        setupScript: input.setupScript,
      });

      const lastLine = res.rawStdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      const rawId = res.json?.machineId ?? lastLine ?? input.idempotencyKey;
      const state: ProviderMachineState = res.json?.state ?? "running";
      const setup: ProviderMachineSetup =
        res.json?.setup === undefined ? "running" : res.json.setup;
      const httpBaseUrl = res.json?.httpBaseUrl ?? null;

      trackedMachines.set(rawId, { state, setup, httpBaseUrl });
      return {
        id: ProviderMachineId.make(rawId),
        state,
        setup,
        archiveAfter: null,
      };
    },
  );

  const inspect: SandboxProvider["Service"]["inspect"] = (account, id) =>
    invoke("inspect", "inspect", account, { machineId: id }).pipe(
      Effect.map((res): ProviderMachine | null => {
        if (res.unsupported) {
          const tracked = trackedMachines.get(id);
          return tracked === undefined
            ? null
            : { id, state: tracked.state, setup: tracked.setup, archiveAfter: null };
        }
        const state = res.json?.state ?? trackedMachines.get(id)?.state ?? "running";
        const setup =
          res.json?.setup !== undefined
            ? res.json.setup
            : (trackedMachines.get(id)?.setup ?? "done");
        const httpBaseUrl =
          res.json?.httpBaseUrl !== undefined
            ? res.json.httpBaseUrl
            : (trackedMachines.get(id)?.httpBaseUrl ?? null);
        trackedMachines.set(id, { state, setup, httpBaseUrl });
        return { id, state, setup, archiveAfter: null };
      }),
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => {
          trackedMachines.delete(id);
          return Effect.succeed(null);
        },
      ),
    );

  const exec: SandboxProvider["Service"]["exec"] = (account, id, input) =>
    invoke("exec", "exec", account, {
      machineId: id,
      command: input.command,
      timeoutSeconds: input.timeoutSeconds,
    }).pipe(
      Effect.flatMap((res) => {
        if (res.unsupported) {
          return Effect.fail(
            new SandboxProviderError({
              operation: "exec",
              kind: "transient",
              providerMessage:
                "3-verb command providers rely on guest FleetMux connection for exec calls.",
            }),
          );
        }
        return Effect.succeed({
          exitCode: res.json?.exitCode ?? 0,
          stdout: res.json?.stdout ?? res.rawStdout,
          stderr: res.json?.stderr ?? "",
          timedOut: res.json?.timedOut ?? false,
        });
      }),
    );

  const writeFile: SandboxProvider["Service"]["writeFile"] = (account, id, input) =>
    invoke("writeFile", "write_file", account, {
      machineId: id,
      path: input.path,
      contentBase64: Buffer.from(input.content).toString("base64"),
    }).pipe(
      Effect.flatMap((res) =>
        res.unsupported
          ? Effect.fail(
              new SandboxProviderError({
                operation: "writeFile",
                kind: "transient",
                providerMessage:
                  "3-verb command providers rely on guest FleetMux connection for file writes.",
              }),
            )
          : Effect.void,
      ),
    );

  const host: SandboxProvider["Service"]["host"] = (account, id, port) =>
    invoke("host", "host", account, { machineId: id, port }).pipe(
      Effect.flatMap((res) => {
        const url = res.json?.httpBaseUrl ?? trackedMachines.get(id)?.httpBaseUrl ?? null;
        if (url !== null) return Effect.succeed(url);
        return Effect.fail(
          new SandboxProviderError({
            operation: "host",
            kind: "transient",
            providerMessage: "Command provider did not report a direct host URL.",
          }),
        );
      }),
    );

  const setDeadline: SandboxProvider["Service"]["setDeadline"] = () => Effect.void;

  const stop: SandboxProvider["Service"]["stop"] = (account, id) =>
    invoke("stop", "pause", account, { machineId: id }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const tracked = trackedMachines.get(id);
          if (tracked !== undefined) tracked.state = "stopped";
        }),
      ),
      Effect.asVoid,
    );

  const resume: SandboxProvider["Service"]["resume"] = Effect.fn("CommandSandboxProvider.resume")(
    function* (account, id, input) {
      const res = yield* invoke("resume", "resume", account, {
        machineId: id,
        ttlSeconds: input.ttlSeconds,
      });
      if (res.unsupported) {
        yield* invoke("resume", "spawn", account, {
          machineId: id,
          ttlSeconds: input.ttlSeconds,
        });
      }
      const tracked = trackedMachines.get(id);
      if (tracked !== undefined) tracked.state = "running";
    },
  );

  const destroy: SandboxProvider["Service"]["destroy"] = (account, id) =>
    invoke("destroy", "destroy", account, { machineId: id }).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.void,
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          trackedMachines.delete(id);
        }),
      ),
      Effect.asVoid,
    );

  return SandboxProvider.of({
    checkAccess,
    listTemplates,
    create,
    inspect,
    exec,
    writeFile,
    host,
    setDeadline,
    stop,
    resume,
    destroy,
  });
});

export const layer = Layer.effect(SandboxProvider, make);
