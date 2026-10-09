// @effect-diagnostics nodeBuiltinImport:off - the rendered clone command is run by a real bash and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { FLOCK_SHIM } from "../testUtils/flockShim.ts";
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

/** An origin with a pinned commit and a later one, and a clone command whose guest paths live under `root`. */
const cloneFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-clone-"));
  const origin = NodePath.join(root, "origin");
  NodeFS.mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  commit(origin, "pinned");
  const pinned = git(origin, "rev-parse", "HEAD");
  commit(origin, "later");
  // The guest's home only exists in a sandbox.
  const at = (path: string) => path.replace("/home/user", root);
  NodeFS.mkdirSync(NodePath.join(at(SANDBOX_ENV_FILE), "..", "sandbox"), { recursive: true });
  NodeFS.writeFileSync(at(SANDBOX_ENV_FILE), "");
  const checkout = NodePath.join(root, "project");
  const command = renderCloneCommand({
    remoteUrl: origin,
    commit: pinned,
    branch: "t3/sandbox-0a1b2c3d",
    path: checkout,
  }).replaceAll("/home/user", root);
  return { root, pinned, checkout, script: `${FLOCK_SHIM}\n${command}` };
};

/** Runs `script`; `printed` resolves once its stdout shows `line`. */
const runBash = (script: string, line: string) => {
  const child = NodeChildProcess.spawn("bash", ["-c", script]);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const printed = new Promise<void>((resolve) =>
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(line)) resolve();
    }),
  );
  const done = new Promise<{ readonly status: number | null; readonly stderr: string }>((resolve) =>
    child.on("close", (status) => resolve({ status, stderr })),
  );
  return { printed, done };
};

describe("renderCloneCommand", () => {
  it("starts the clone on a task branch at the pinned commit, and a rerun keeps it", () => {
    const { root, pinned, checkout, script } = cloneFixture();
    for (const run of ["first", "retry"]) {
      const result = NodeChildProcess.spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(result.stderr, run).toBe("");
      expect(result.status, run).toBe(0);
      expect(git(checkout, "symbolic-ref", "--short", "HEAD"), run).toBe("t3/sandbox-0a1b2c3d");
      expect(git(checkout, "rev-parse", "HEAD"), run).toBe(pinned);
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("lets a replay that starts while the first clone runs wait for it and keep its clone", async () => {
    const { root, pinned, checkout, script } = cloneFixture();
    // A slow clone, so the replay starts while the first run is still cloning.
    const slowClone = `git() { if [ "$1" = clone ]; then echo cloning; sleep 2; fi; command git "$@"; }`;
    const first = runBash(`${slowClone}\n${script}`, "cloning");
    await first.printed;
    const replay = runBash(`${slowClone}\n${script}`, "cloning");

    for (const [run, result] of [
      ["first", await first.done],
      ["replay", await replay.done],
    ] as const) {
      expect(result.stderr, run).toBe("");
      expect(result.status, run).toBe(0);
    }
    expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("t3/sandbox-0a1b2c3d");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(pinned);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});
