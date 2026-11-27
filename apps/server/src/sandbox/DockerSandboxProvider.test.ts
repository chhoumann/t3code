import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as ProcessRunner from "../processRunner.ts";
import * as DockerSandboxProvider from "./DockerSandboxProvider.ts";
import { SandboxProvider, type SandboxProviderAccount } from "./SandboxProvider.ts";

const account: SandboxProviderAccount = {
  provider: "docker",
  apiKey: Redacted.make(""),
  dockerImage: "node:22-bookworm",
};

describe("DockerSandboxProvider", () => {
  it.effect("runs idempotent create, writeFile, host, stop, resume, and destroy commands", () => {
    const calls: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
    let containerCreated = false;
    let state = "running";

    const fakeRunner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push({
            args: input.args,
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          });
          const sub = input.args[0];
          if (sub === "inspect") {
            if (!containerCreated) {
              return {
                stdout: "",
                stderr: "Error: No such object",
                code: ChildProcessSpawner.ExitCode(1),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }
            if (input.args.includes("{{.State.Status}}")) {
              return {
                stdout: `${state}\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }
            return {
              stdout: "t3-sbx-home\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }
          if (sub === "run") containerCreated = true;
          if (sub === "stop") state = "exited";
          if (sub === "start") state = "running";
          if (sub === "rm") containerCreated = false;
          if (sub === "port") {
            return {
              stdout: "127.0.0.1:49201\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }
          if (sub === "exec" && input.args.some((a) => a.includes("setup.status"))) {
            return {
              stdout: "done\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }
          return {
            stdout: "27.0.0\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });

    const layer = DockerSandboxProvider.layer.pipe(
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, fakeRunner)),
    );

    return Effect.gen(function* () {
      const provider = yield* SandboxProvider;
      assert.deepStrictEqual(yield* provider.checkAccess(account), []);
      assert.deepStrictEqual(yield* provider.listTemplates(account), ["node:22-bookworm"]);

      const created = yield* provider.create(account, {
        idempotencyKey: "key-1",
        size: "default",
        ttlSeconds: 3600,
        template: null,
        providerEnvironment: null,
        setupScript: "echo hi",
      });
      assert.strictEqual(created.state, "running");

      const replayed = yield* provider.create(account, {
        idempotencyKey: "key-1",
        size: "default",
        ttlSeconds: 3600,
        template: null,
        providerEnvironment: null,
        setupScript: "echo hi",
      });
      assert.strictEqual(replayed.id, created.id);
      assert.strictEqual(calls.filter((c) => c.args[0] === "run").length, 1);

      const url = yield* provider.host(account, created.id, 3773);
      assert.strictEqual(url, "http://127.0.0.1:49201");

      yield* provider.stop(account, created.id);
      const stopped = yield* provider.inspect(account, created.id);
      assert.strictEqual(stopped?.state, "stopped");

      yield* provider.resume(account, created.id, { ttlSeconds: 3600 });
      const resumed = yield* provider.inspect(account, created.id);
      assert.strictEqual(resumed?.state, "running");

      yield* provider.destroy(account, created.id);
      assert.isNull(yield* provider.inspect(account, created.id));
    }).pipe(Effect.provide(layer));
  });
});
