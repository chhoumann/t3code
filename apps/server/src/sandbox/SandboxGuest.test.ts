// @effect-diagnostics nodeBuiltinImport:off - the rendered clone command is run by a real bash and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { SANDBOX_ENV_FILE } from "./sandboxBootScript.ts";
import { renderCloneCommand } from "./SandboxGuest.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );

describe("renderCloneCommand", () => {
  it("starts the clone on a task branch at the pinned commit, and a rerun keeps it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-clone-"));
    const origin = NodePath.join(root, "origin");
    NodeFS.mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    commit(origin, "pinned");
    const pinned = git(origin, "rev-parse", "HEAD");
    commit(origin, "later");
    const envFile = NodePath.join(root, "sandbox.env");
    NodeFS.writeFileSync(envFile, "");
    const checkout = NodePath.join(root, "project");
    // The guest's env file path only exists in a sandbox.
    const command = renderCloneCommand({
      remoteUrl: origin,
      commit: pinned,
      branch: "t3/sandbox-0a1b2c3d",
      path: checkout,
    }).replaceAll(SANDBOX_ENV_FILE, envFile);

    for (const run of ["first", "retry"]) {
      const result = NodeChildProcess.spawnSync("bash", ["-c", command], { encoding: "utf8" });
      expect(result.stderr, run).toBe("");
      expect(result.status, run).toBe(0);
      expect(git(checkout, "symbolic-ref", "--short", "HEAD"), run).toBe("t3/sandbox-0a1b2c3d");
      expect(git(checkout, "rev-parse", "HEAD"), run).toBe(pinned);
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});
