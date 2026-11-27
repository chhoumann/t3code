// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { unsetInheritedGitRepositoryEnv } from "@t3tools/shared/testing/gitRepositoryEnv";

import * as ProcessRunner from "../processRunner.ts";
import { applyWorktreeOverlay, packWorktreeOverlay } from "./worktreeOverlay.ts";

const runnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

function gitExec(platform: NodeJS.Platform, cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...unsetInheritedGitRepositoryEnv(process.env, platform),
    },
  }).trim();
}

describe("worktreeOverlay", () => {
  it.effect("preserves unpushed commits, binary edits, tracked diffs, and untracked files", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-overlay-test-"));
      const srcDir = NodePath.join(root, "source");
      const dstDir = NodePath.join(root, "sandbox");
      NodeFS.mkdirSync(srcDir, { recursive: true });

      try {
        gitExec(platform, srcDir, ["init", "-b", "feat/local-wip"]);
        gitExec(platform, srcDir, ["config", "user.name", "Test User"]);
        gitExec(platform, srcDir, ["config", "user.email", "test@example.com"]);

        NodeFS.writeFileSync(NodePath.join(srcDir, "README.md"), "base readme\n");
        NodeFS.writeFileSync(NodePath.join(srcDir, "remove-me.txt"), "bye\n");
        NodeFS.writeFileSync(NodePath.join(srcDir, "logo.bin"), Buffer.from([1, 2, 3, 4]));
        gitExec(platform, srcDir, ["add", "."]);
        gitExec(platform, srcDir, ["commit", "-m", "initial commit"]);

        // Create an unpushed local commit on a local branch
        NodeFS.writeFileSync(NodePath.join(srcDir, "committed-local.ts"), "export const x = 42;\n");
        gitExec(platform, srcDir, ["add", "committed-local.ts"]);
        gitExec(platform, srcDir, ["commit", "-m", "unpushed local commit"]);
        const expectedHead = gitExec(platform, srcDir, ["rev-parse", "HEAD"]);

        // Dirty edits: modified tracked text, deleted tracked file, modified binary, new staged file, untracked + ignored
        NodeFS.writeFileSync(NodePath.join(srcDir, "README.md"), "edited readme\n");
        NodeFS.rmSync(NodePath.join(srcDir, "remove-me.txt"));
        NodeFS.writeFileSync(NodePath.join(srcDir, "logo.bin"), Buffer.from([9, 8, 7, 6, 5]));
        NodeFS.writeFileSync(
          NodePath.join(srcDir, "staged-new.ts"),
          "export const staged = true;\n",
        );
        gitExec(platform, srcDir, ["add", "staged-new.ts"]);

        NodeFS.mkdirSync(NodePath.join(srcDir, "scripts"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(srcDir, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", {
          mode: 0o755,
        });
        NodeFS.writeFileSync(NodePath.join(srcDir, ".gitignore"), "ignored.log\n");
        gitExec(platform, srcDir, ["add", ".gitignore"]);
        NodeFS.writeFileSync(NodePath.join(srcDir, "ignored.log"), "should stay excluded\n");

        const archive = yield* packWorktreeOverlay({
          cwd: srcDir,
          includeUncommitted: true,
        });

        const applied = yield* applyWorktreeOverlay({
          targetDir: dstDir,
          archiveBytes: archive,
        });

        assert.strictEqual(applied.branch, "feat/local-wip");
        assert.strictEqual(applied.commit, expectedHead);
        assert.strictEqual(gitExec(platform, dstDir, ["rev-parse", "HEAD"]), expectedHead);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dstDir, "committed-local.ts"), "utf8"),
          "export const x = 42;\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dstDir, "README.md"), "utf8"),
          "edited readme\n",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(dstDir, "remove-me.txt")));
        assert.deepStrictEqual(
          Array.from(NodeFS.readFileSync(NodePath.join(dstDir, "logo.bin"))),
          [9, 8, 7, 6, 5],
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dstDir, "staged-new.ts"), "utf8"),
          "export const staged = true;\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dstDir, "scripts", "run.sh"), "utf8"),
          "#!/bin/sh\necho ok\n",
        );
        if (platform !== "win32") {
          const mode = NodeFS.statSync(NodePath.join(dstDir, "scripts", "run.sh")).mode;
          assert.notStrictEqual(mode & 0o100, 0);
        }
        assert.isFalse(NodeFS.existsSync(NodePath.join(dstDir, "ignored.log")));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(runnerLayer)),
  );

  it.effect("excludes uncommitted edits when includeUncommitted is false", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-overlay-clean-"));
      const srcDir = NodePath.join(root, "source");
      const dstDir = NodePath.join(root, "sandbox");
      NodeFS.mkdirSync(srcDir, { recursive: true });

      try {
        gitExec(platform, srcDir, ["init", "-b", "main"]);
        gitExec(platform, srcDir, ["config", "user.name", "Test User"]);
        gitExec(platform, srcDir, ["config", "user.email", "test@example.com"]);

        NodeFS.writeFileSync(NodePath.join(srcDir, "app.txt"), "committed\n");
        gitExec(platform, srcDir, ["add", "app.txt"]);
        gitExec(platform, srcDir, ["commit", "-m", "base"]);
        const expectedHead = gitExec(platform, srcDir, ["rev-parse", "HEAD"]);

        NodeFS.writeFileSync(NodePath.join(srcDir, "app.txt"), "dirty edit\n");
        NodeFS.writeFileSync(NodePath.join(srcDir, "untracked.txt"), "scratch\n");

        const archive = yield* packWorktreeOverlay({
          cwd: srcDir,
          includeUncommitted: false,
        });
        const applied = yield* applyWorktreeOverlay({
          targetDir: dstDir,
          archiveBytes: archive,
        });

        assert.strictEqual(applied.branch, "main");
        assert.strictEqual(applied.commit, expectedHead);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dstDir, "app.txt"), "utf8"),
          "committed\n",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(dstDir, "untracked.txt")));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(runnerLayer)),
  );
});
