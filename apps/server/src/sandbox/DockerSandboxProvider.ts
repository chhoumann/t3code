/**
 * Local Docker / OrbStack implementation of SandboxProvider using `ProcessRunner`.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic SHA-256 slug for Docker container names.
import * as NodeCrypto from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import { SANDBOX_T3_PORT, shellQuote } from "./sandboxBootScript.ts";

const DEFAULT_DOCKER_IMAGE = "node:22-bookworm";
const CONTAINER_HOME_MOUNT = "/home/user";
const SANDBOX_VAR_DIR = "/var/lib/t3-sandbox";
const DOCKER_TIMEOUT = Duration.seconds(60);
const DOCKER_EXEC_MAX_BYTES = 16 * 1024 * 1024;

function containerSlug(idempotencyKey: string): string {
  const digest = NodeCrypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16);
  return `t3-sbx-${digest}`;
}

function volumeSlug(containerName: string): string {
  return `${containerName}-home`;
}

function mapDockerState(raw: string): ProviderMachineState {
  switch (raw.trim().toLowerCase()) {
    case "running":
      return "running";
    case "created":
    case "restarting":
      return "starting";
    case "removing":
      return "stopping";
    case "exited":
    case "paused":
      return "stopped";
    case "dead":
      return "failed";
    default:
      return "starting";
  }
}

function parseSetupStatus(raw: string): ProviderMachineSetup {
  const trimmed = raw.trim().toLowerCase();
  if (
    trimmed === "pending" ||
    trimmed === "running" ||
    trimmed === "done" ||
    trimmed === "failed"
  ) {
    return trimmed;
  }
  return null;
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  const runDocker = (
    operation: SandboxProviderOperation,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly timeout?: Duration.Input;
      readonly allowNonZero?: boolean;
    },
  ) =>
    runner
      .run({
        command: "docker",
        args,
        timeout: options?.timeout ?? DOCKER_TIMEOUT,
        maxOutputBytes: DOCKER_EXEC_MAX_BYTES,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
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
        Effect.flatMap((result) => {
          if (options?.allowNonZero || (!result.timedOut && result.code === 0)) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          const notFound = /No such (?:container|object)/i.test(stderr);
          return Effect.fail(
            new SandboxProviderError({
              operation,
              kind: notFound ? "not-found" : "transient",
              providerMessage:
                stderr.length > 0 ? stderr.slice(0, 300) : `docker exited with ${result.code}`,
            }),
          );
        }),
      );

  const inspectContainer = Effect.fn("DockerSandboxProvider.inspectContainer")(function* (
    operation: SandboxProviderOperation,
    containerName: string,
  ) {
    const result = yield* runDocker(
      operation,
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { allowNonZero: true },
    );
    if (result.code !== 0) {
      if (/No such (?:container|object)/i.test(result.stderr)) {
        return null;
      }
      return yield* new SandboxProviderError({
        operation,
        kind: "transient",
        providerMessage: result.stderr.trim().slice(0, 300),
      });
    }
    const state = mapDockerState(result.stdout);
    if (state !== "running") {
      return {
        id: ProviderMachineId.make(containerName),
        state,
        setup: null,
        archiveAfter: null,
      } satisfies ProviderMachine;
    }
    const setupOut = yield* runDocker(
      operation,
      [
        "exec",
        containerName,
        "/bin/sh",
        "-lc",
        `cat ${SANDBOX_VAR_DIR}/setup.status 2>/dev/null || echo done`,
      ],
      { allowNonZero: true },
    );
    return {
      id: ProviderMachineId.make(containerName),
      state,
      setup: setupOut.code === 0 ? parseSetupStatus(setupOut.stdout) : "done",
      archiveAfter: null,
    } satisfies ProviderMachine;
  });

  const checkAccess: SandboxProvider["Service"]["checkAccess"] = () =>
    runDocker("check-access", ["version", "--format", "{{.Server.Version}}"]).pipe(
      Effect.as([] as ReadonlyArray<string>),
    );

  const listTemplates: SandboxProvider["Service"]["listTemplates"] = (account) =>
    Effect.succeed([account.dockerImage ?? DEFAULT_DOCKER_IMAGE]);

  const create: SandboxProvider["Service"]["create"] = Effect.fn("DockerSandboxProvider.create")(
    function* (account: SandboxProviderAccount, input) {
      const name = containerSlug(input.idempotencyKey);
      const existing = yield* inspectContainer("create", name);
      if (existing !== null) {
        return existing;
      }

      const image = account.dockerImage ?? input.template ?? DEFAULT_DOCKER_IMAGE;
      const vol = volumeSlug(name);

      yield* runDocker("create", [
        "volume",
        "create",
        "--label",
        `t3.sandbox.idempotency_key=${input.idempotencyKey}`,
        vol,
      ]);

      yield* runDocker("create", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `t3.sandbox.idempotency_key=${input.idempotencyKey}`,
        "--label",
        `t3.sandbox.volume=${vol}`,
        "--add-host=host.docker.internal:host-gateway",
        "-v",
        `${vol}:${CONTAINER_HOME_MOUNT}`,
        "-p",
        `127.0.0.1::${SANDBOX_T3_PORT}`,
        "-w",
        CONTAINER_HOME_MOUNT,
        image,
        "/bin/sh",
        "-lc",
        `mkdir -p ${CONTAINER_HOME_MOUNT}/.t3/sandbox ${SANDBOX_VAR_DIR} && trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done`,
      ]);

      yield* writeFile(account, ProviderMachineId.make(name), {
        path: `${SANDBOX_VAR_DIR}/setup.sh`,
        content: new TextEncoder().encode(input.setupScript),
      });

      const launchSetupCmd = [
        `mkdir -p ${SANDBOX_VAR_DIR}`,
        `chmod 755 ${shellQuote(`${SANDBOX_VAR_DIR}/setup.sh`)}`,
        `echo running > ${shellQuote(`${SANDBOX_VAR_DIR}/setup.status`)}`,
        `nohup /bin/sh -lc 'if command -v bash >/dev/null 2>&1; then bash ${SANDBOX_VAR_DIR}/setup.sh; else sh ${SANDBOX_VAR_DIR}/setup.sh; fi > ${SANDBOX_VAR_DIR}/setup.log 2>&1 && echo done > ${SANDBOX_VAR_DIR}/setup.status || echo failed > ${SANDBOX_VAR_DIR}/setup.status' >/dev/null 2>&1 &`,
      ].join(" && ");

      yield* runDocker("create", ["exec", name, "/bin/sh", "-lc", launchSetupCmd]);

      return {
        id: ProviderMachineId.make(name),
        state: "running" as const,
        setup: "running" as const,
        archiveAfter: null,
      };
    },
  );

  const inspect: SandboxProvider["Service"]["inspect"] = (_account, id) =>
    inspectContainer("inspect", id);

  const exec: SandboxProvider["Service"]["exec"] = (_account, id, input) =>
    runDocker(
      "exec",
      [
        "exec",
        id,
        "/bin/sh",
        "-c",
        'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; else exec sh -c "$1"; fi',
        "_",
        input.command,
      ],
      {
        allowNonZero: true,
        timeout: Duration.seconds(Math.max(5, input.timeoutSeconds + 5)),
      },
    ).pipe(
      Effect.flatMap((result) => {
        if (result.code !== 0 && /No such (?:container|object)/i.test(result.stderr)) {
          return Effect.fail(
            new SandboxProviderError({
              operation: "exec",
              kind: "not-found",
              providerMessage: result.stderr.trim().slice(0, 300),
            }),
          );
        }
        return Effect.succeed({
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        });
      }),
    );

  const writeFile: SandboxProvider["Service"]["writeFile"] = (_account, id, input) => {
    const encoded = Buffer.from(input.content).toString("base64");
    const targetDir = input.path.slice(0, Math.max(0, input.path.lastIndexOf("/"))) || "/";
    return runDocker(
      "writeFile",
      [
        "exec",
        "-i",
        id,
        "/bin/sh",
        "-lc",
        `mkdir -p ${shellQuote(targetDir)} && base64 -d > ${shellQuote(input.path)}`,
      ],
      { stdin: encoded },
    ).pipe(Effect.asVoid);
  };

  const host: SandboxProvider["Service"]["host"] = (_account, id, port) =>
    runDocker("host", ["port", id, `${port}/tcp`]).pipe(
      Effect.flatMap((result) => {
        const lines = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const ipv4 = lines.find((line) => line.startsWith("127.0.0.1:")) ?? lines[0];
        const portPart = ipv4?.split(":").at(-1);
        const mapped = portPart === undefined ? Number.NaN : Number(portPart);
        if (!Number.isInteger(mapped) || mapped <= 0) {
          return Effect.fail(
            new SandboxProviderError({
              operation: "host",
              kind: "transient",
              providerMessage: `Could not resolve Docker published port for ${port}/tcp: ${result.stdout}`,
            }),
          );
        }
        return Effect.succeed(`http://127.0.0.1:${mapped}`);
      }),
    );

  const setDeadline: SandboxProvider["Service"]["setDeadline"] = () => Effect.void;

  const stop: SandboxProvider["Service"]["stop"] = (_account, id) =>
    runDocker("stop", ["stop", "-t", "5", id]).pipe(Effect.asVoid);

  const resume: SandboxProvider["Service"]["resume"] = (_account, id) =>
    runDocker("resume", ["start", id]).pipe(
      Effect.andThen(
        runDocker(
          "resume",
          [
            "exec",
            "-d",
            id,
            "/bin/sh",
            "-lc",
            `if [ -x ${shellQuote(`${CONTAINER_HOME_MOUNT}/.t3/sandbox/start-guest.sh`)} ]; then exec ${shellQuote(`${CONTAINER_HOME_MOUNT}/.t3/sandbox/start-guest.sh`)}; fi`,
          ],
          { allowNonZero: true },
        ),
      ),
      Effect.asVoid,
    );

  const destroy: SandboxProvider["Service"]["destroy"] = Effect.fn("DockerSandboxProvider.destroy")(
    function* (_account, id) {
      const volResult = yield* runDocker(
        "destroy",
        ["inspect", "--format", '{{index .Config.Labels "t3.sandbox.volume"}}', id],
        { allowNonZero: true },
      );
      const labeledVol = volResult.code === 0 ? volResult.stdout.trim() : "";
      yield* runDocker("destroy", ["rm", "-f", "-v", id], { allowNonZero: true });
      const volName = labeledVol.length > 0 ? labeledVol : volumeSlug(id);
      yield* runDocker("destroy", ["volume", "rm", "-f", volName], { allowNonZero: true });
    },
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
