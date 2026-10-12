// @effect-diagnostics nodeBuiltinImport:off - the rendered clone command is run by a real bash and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { FLOCK_SHIM } from "../testUtils/flockShim.ts";
import { SANDBOX_ENV_FILE } from "./sandboxBootScript.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import { renderCloneCommand } from "./SandboxGuest.ts";
import { ProviderMachineId, SandboxProvider } from "./SandboxProvider.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const commit = (cwd: string, message: string, ...args: ReadonlyArray<string>) =>
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    ...args,
    "-m",
    message,
  );

/** A temp dir standing in for the guest's home, and a repository in it with one commit. */
const guestFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-clone-"));
  // The guest's home only exists in a sandbox.
  const at = (path: string) => path.replace("/home/user", root);
  NodeFS.mkdirSync(NodePath.join(at(SANDBOX_ENV_FILE), "..", "sandbox"), { recursive: true });
  NodeFS.writeFileSync(at(SANDBOX_ENV_FILE), "");
  const origin = NodePath.join(root, "origin");
  NodeFS.mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  commit(origin, "pinned");
  const pinned = git(origin, "rev-parse", "HEAD");
  const checkout = NodePath.join(root, "project");
  const script = (
    checkoutInput: Omit<SandboxGuest.SandboxCheckout, "branch" | "path">,
    branch = "t3/sandbox-0a1b2c3d",
  ) =>
    `${FLOCK_SHIM}\n${renderCloneCommand({ ...checkoutInput, branch, path: checkout }).replaceAll(
      "/home/user",
      root,
    )}`;
  return { root, origin, pinned, checkout, script };
};

/** An origin with a pinned commit and a later one, and the command that clones it at the pinned one. */
const cloneFixture = () => {
  const fixture = guestFixture();
  commit(fixture.origin, "later");
  return {
    ...fixture,
    script: fixture.script({
      remoteUrl: fixture.origin,
      projectRemoteUrl: fixture.origin,
      commit: fixture.pinned,
    }),
  };
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
      expect(git(checkout, "remote"), run).toBe("origin");
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("moves a template's clone to the launch's commit, then never resets the work on it", () => {
    const { root, origin: project, checkout, script } = guestFixture();
    const run = (command: string) =>
      NodeChildProcess.spawnSync("bash", ["-c", command], { encoding: "utf8" });
    const hello = NodePath.join(checkout, "hello.txt");
    NodeFS.writeFileSync(NodePath.join(project, "hello.txt"), "v1\n");
    git(project, "add", "hello.txt");
    commit(project, "v1");
    const earlier = run(
      script(
        {
          remoteUrl: project,
          projectRemoteUrl: project,
          commit: git(project, "rev-parse", "HEAD"),
        },
        "t3/sandbox-earlier",
      ),
    );
    // What the template's snapshot holds besides the earlier sandbox's commit.
    NodeFS.writeFileSync(hello, "the earlier agent's edit\n");
    NodeFS.mkdirSync(NodePath.join(checkout, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(checkout, "node_modules", "cache"), "");
    const fork = NodePath.join(root, "fork");
    NodeChildProcess.execFileSync("git", ["clone", "--quiet", project, fork]);
    NodeFS.writeFileSync(NodePath.join(fork, "hello.txt"), "v2\n");
    commit(fork, "v2", "--all");
    const v2 = git(fork, "rev-parse", "HEAD");
    const launch = script({ remoteUrl: fork, projectRemoteUrl: project, commit: v2 });

    const first = run(launch);
    const moved = {
      branch: git(checkout, "symbolic-ref", "--short", "HEAD"),
      head: git(checkout, "rev-parse", "HEAD"),
      hello: NodeFS.readFileSync(hello, "utf8"),
      cacheKept: NodeFS.existsSync(NodePath.join(checkout, "node_modules", "cache")),
      remotes: git(checkout, "remote", "-v"),
    };
    NodeFS.writeFileSync(hello, "this agent's edit\n");
    const replay = run(launch);
    const afterReplay = NodeFS.readFileSync(hello, "utf8");
    git(checkout, "checkout", "--quiet", "-b", "agent/fix");
    const replayOnAgentBranch = run(launch);
    const agentBranch = git(checkout, "symbolic-ref", "--short", "HEAD");
    const afterAgentBranch = NodeFS.readFileSync(hello, "utf8");
    NodeFS.rmSync(root, { recursive: true, force: true });

    for (const result of [earlier, first, replay, replayOnAgentBranch]) {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(moved).toEqual({
      branch: "t3/sandbox-0a1b2c3d",
      head: v2,
      hello: "v2\n",
      cacheKept: true,
      remotes: [
        `origin\t${fork} (fetch)`,
        `origin\t${fork} (push)`,
        `upstream\t${project} (fetch)`,
        `upstream\t${project} (push)`,
      ].join("\n"),
    });
    expect(afterReplay).toBe("this agent's edit\n");
    expect(agentBranch).toBe("agent/fix");
    expect(afterAgentBranch).toBe("this agent's edit\n");
  });

  it.effect(
    "clones the fork a branch tracks at its commit, so the clone has the project's identity",
    () =>
      Effect.gen(function* () {
        const { root, origin: project, checkout, script } = guestFixture();
        const fork = NodePath.join(root, "fork");
        NodeChildProcess.execFileSync("git", ["clone", "--quiet", project, fork]);
        commit(fork, "only on the fork");
        const forkOnly = git(fork, "rev-parse", "HEAD");
        const projectUrl = "https://github.com/pingdotgg/t3code.git";
        const forkUrl = "https://github.com/chhoumann/t3code.git";
        // Clones and fetches reach the local repositories; the clone's config keeps the URLs.
        const env = {
          ...process.env,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.${project}.insteadOf`,
          GIT_CONFIG_VALUE_0: projectUrl,
          GIT_CONFIG_KEY_1: `url.${fork}.insteadOf`,
          GIT_CONFIG_VALUE_1: forkUrl,
        };

        const result = NodeChildProcess.spawnSync(
          "bash",
          ["-c", script({ remoteUrl: forkUrl, projectRemoteUrl: projectUrl, commit: forkOnly })],
          { encoding: "utf8", env },
        );
        const identity = yield* RepositoryIdentityResolver.RepositoryIdentityResolver.pipe(
          Effect.flatMap((resolver) => resolver.resolve(checkout)),
          Effect.provide(RepositoryIdentityResolver.layer),
        );

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(git(checkout, "symbolic-ref", "--short", "HEAD")).toBe("t3/sandbox-0a1b2c3d");
        expect(git(checkout, "rev-parse", "HEAD")).toBe(forkOnly);
        expect(identity).toMatchObject({
          canonicalKey: "github.com/pingdotgg/t3code",
          locator: { source: "git-remote", remoteName: "upstream", remoteUrl: projectUrl },
          origin: { canonicalKey: "github.com/chhoumann/t3code", displayName: "chhoumann/t3code" },
        });
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

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

describe("SandboxGuest", () => {
  it.effect("names why a guest command failed with the end of its stderr", () => {
    const unused = () => Effect.die("unused");
    const stderr = [
      "Cloning into '/home/user/projects/app.partial'...",
      "remote: Repository not found.",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
      "",
    ].join("\n");
    const layer = SandboxGuest.layer.pipe(
      Layer.provide(
        Layer.succeed(
          SandboxProvider,
          SandboxProvider.of({
            checkAccess: unused,
            listTemplates: unused,
            create: unused,
            inspect: unused,
            exec: () => Effect.succeed({ exitCode: 128, stdout: "", stderr, timedOut: false }),
            writeFile: unused,
            host: unused,
            stop: unused,
            resume: unused,
            destroy: unused,
          }),
        ),
      ),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(unused))),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    return Effect.gen(function* () {
      const guest = yield* SandboxGuest.SandboxGuest;
      const failure = yield* guest
        .cloneCheckout({ apiKey: Redacted.make("key") }, ProviderMachineId.make("bx_1"), {
          remoteUrl: "https://github.com/acme/app.git",
          projectRemoteUrl: "https://github.com/acme/app.git",
          commit: null,
          branch: "t3/sandbox-0a1b2c3d",
          path: "/home/user/projects/app",
        })
        .pipe(Effect.flip);
      expect(failure.message).toBe(
        [
          "Could not clone the repository in the sandbox.",
          "line 3",
          "line 4",
          "line 5",
          "line 6",
          "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
        ].join("\n"),
      );
    }).pipe(Effect.provide(layer));
  });
});
