// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Redacted from "effect/Redacted";

import * as ProcessRunner from "../processRunner.ts";
import * as CommandSandboxProvider from "./CommandSandboxProvider.ts";
import { SandboxProvider, type SandboxProviderAccount } from "./SandboxProvider.ts";

describe("CommandSandboxProvider", () => {
  it.effect("drives a real 3-verb shell script (spawn, pause, destroy)", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cmd-provider-"));
      const scriptPath = NodePath.join(tempDir, "driver.sh");
      const logPath = NodePath.join(tempDir, "ops.log");
      NodeFS.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          'op="$1"',
          `echo "$op:$T3_SANDBOX_OP:$T3_IDEMPOTENCY_KEY" >> "${logPath}"`,
          'case "$op" in',
          '  spawn) printf \'{"machineId":"vm-42","state":"running","setup":"done"}\\n\' ;;',
          "  pause) exit 0 ;;",
          "  destroy) exit 0 ;;",
          "  check) exit 64 ;;",
          "  inspect) exit 64 ;;",
          "  *) exit 64 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );

      const account: SandboxProviderAccount = {
        provider: "command",
        apiKey: Redacted.make(""),
        commandProgram: scriptPath,
      };

      const layer = CommandSandboxProvider.layer.pipe(
        Layer.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
      );

      try {
        yield* Effect.gen(function* () {
          const provider = yield* SandboxProvider;
          assert.deepStrictEqual(yield* provider.checkAccess(account), []);
          const machine = yield* provider.create(account, {
            idempotencyKey: "k-cmd-1",
            size: "small",
            ttlSeconds: null,
            template: null,
            providerEnvironment: null,
            setupScript: "",
          });
          assert.strictEqual(machine.id, "vm-42");
          assert.strictEqual(machine.state, "running");

          const inspected = yield* provider.inspect(account, machine.id);
          assert.strictEqual(inspected?.state, "running");

          yield* provider.stop(account, machine.id);
          assert.strictEqual((yield* provider.inspect(account, machine.id))?.state, "stopped");

          yield* provider.resume(account, machine.id, { ttlSeconds: null });
          assert.strictEqual((yield* provider.inspect(account, machine.id))?.state, "running");

          yield* provider.destroy(account, machine.id);
          assert.isNull(yield* provider.inspect(account, machine.id));
        }).pipe(Effect.provide(layer));

        const ops = NodeFS.readFileSync(logPath, "utf8").trim().split("\n");
        assert.include(ops[1]!, "spawn:spawn:k-cmd-1");
        assert.isTrue(ops.some((line) => line.startsWith("pause:pause:")));
        assert.isTrue(ops.some((line) => line.startsWith("destroy:destroy:")));
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("uses ProcessRunner cleanly when mocked for failure handling", () => {
    const fakeRunner = ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "missing permission",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    });
    const layer = CommandSandboxProvider.layer.pipe(
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, fakeRunner)),
    );
    const account: SandboxProviderAccount = {
      provider: "command",
      apiKey: Redacted.make(""),
      commandProgram: "/bin/false",
    };

    return Effect.gen(function* () {
      const provider = yield* SandboxProvider;
      const err = yield* provider
        .create(account, {
          idempotencyKey: "k-fail",
          size: "small",
          ttlSeconds: null,
          template: null,
          providerEnvironment: null,
          setupScript: "",
        })
        .pipe(Effect.flip);
      assert.strictEqual(err._tag, "SandboxProviderError");
      assert.include(err.message, "missing permission");
    }).pipe(Effect.provide(layer));
  });
});
