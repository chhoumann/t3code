// @effect-diagnostics nodeBuiltinImport:off - packs a build tree with Node's filesystem.
/**
 * Packs this checkout's server the way a sandbox installs it, for an owner
 * whose own version is not published on npm. Run from the repository root:
 *
 *   vp run pack-sandbox-server [--skip-build] [--out <path>]
 *
 * then start the owner with `T3CODE_SANDBOX_SERVER_TARBALL=<path>`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import serverPackageJson from "../package.json" with { type: "json" };
import { stageRuntimeExternals } from "../../../scripts/build-cli-archive.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const serverDir = NodePath.join(repoRoot, "apps/server");

class PackSandboxServerError extends Schema.TaggedError<PackSandboxServerError>()(
  "PackSandboxServerError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited ${this.exitCode}.`;
  }
}

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
    );
    if (exitCode !== 0) {
      return yield* new PackSandboxServerError({ command: `${command} ${args[0]}`, exitCode });
    }
  });

/**
 * Writes this checkout's server to `out`, laid out like a linux-x64 release
 * archive (bundle, web client, runtime externals staged by the archive build)
 * minus the single executable: the machine's Node runs the bundle.
 */
export const packSandboxServer = (options: { readonly skipBuild: boolean; readonly out: string }) =>
  Effect.gen(function* () {
    if (!options.skipBuild) yield* run("vp", ["run", "--filter", "t3", "build"], repoRoot);
    const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-pack-"));
    const root = NodePath.join(stage, "t3");
    NodeFS.mkdirSync(root);
    yield* stageRuntimeExternals({
      repoRoot,
      stageDir: root,
      platform: "linux",
      arch: "x64",
      version: serverPackageJson.version,
    });
    NodeFS.cpSync(NodePath.join(serverDir, "dist"), NodePath.join(root, "dist"), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
    NodeFS.mkdirSync(NodePath.dirname(options.out), { recursive: true });
    yield* run("tar", ["--no-mac-metadata", "-czf", options.out, "-C", stage, "t3"], stage);
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }).pipe(Effect.scoped);

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "skip-build": { type: "boolean", default: false },
      out: { type: "string", default: NodePath.join(repoRoot, ".t3/sandbox-server.tgz") },
    },
  });
  const out = NodePath.resolve(values.out);
  packSandboxServer({ skipBuild: values["skip-build"], out }).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        Console.log(
          `Packed t3 ${serverPackageJson.version} for sandboxes (${(NodeFS.statSync(out).size / 1024 / 1024).toFixed(1)} MiB). Start the owner with:\n  T3CODE_SANDBOX_SERVER_TARBALL=${out}`,
        ),
      ),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
