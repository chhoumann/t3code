// @effect-diagnostics nodeBuiltinImport:off - the rendered guest commands are run by a real bash and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type RepositoryIdentity,
  SandboxId,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import { parseRemoteFetchUrls } from "@t3tools/shared/git";
import { sandboxProject, sandboxRemotes } from "@t3tools/shared/sandboxProject";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { FLOCK_SHIM, TIMEOUT_SHIM } from "../testUtils/flockShim.ts";
import {
  SANDBOX_ENV_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_MANAGED_FILE,
  SANDBOX_SETUP_ENV_FILE,
} from "./sandboxBootScript.ts";
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

const SANDBOX_ID = "0a1b2c3d-0000-4000-8000-000000000001";

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
    checkoutInput: Omit<SandboxGuest.SandboxCheckout, "sandboxId" | "branch" | "path">,
    sandboxId = SANDBOX_ID,
  ) =>
    `${FLOCK_SHIM}\n${TIMEOUT_SHIM}\n${renderCloneCommand({
      ...checkoutInput,
      sandboxId,
      branch: `t3/sandbox-${sandboxId.slice(0, 8)}`,
      path: checkout,
    }).replaceAll("/home/user", root)}`;
  return { root, origin, pinned, checkout, script };
};

/** An origin with a pinned commit and a later one, and the command that clones it at the pinned one. */
const cloneFixture = () => {
  const fixture = guestFixture();
  commit(fixture.origin, "later");
  return {
    ...fixture,
    script: fixture.script({
      remotes: [{ name: "origin", url: fixture.origin }],
      trackedRemote: "origin",
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
      expect(git(checkout, "config", "branch.t3/sandbox-0a1b2c3d.pushRemote"), run).toBe("origin");
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("gives a template's clone the launch's remotes and commit, then never resets the work on it", () => {
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
          remotes: [{ name: "origin", url: project }],
          trackedRemote: "origin",
          commit: git(project, "rev-parse", "HEAD"),
        },
        "9e8d7c6b-0000-4000-8000-000000000002",
      ),
    );
    // What the template's snapshot holds besides the earlier sandbox's commit.
    NodeFS.writeFileSync(hello, "the earlier agent's edit\n");
    NodeFS.mkdirSync(NodePath.join(checkout, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(checkout, "node_modules", "cache"), "");
    git(checkout, "remote", "add", "upstream", NodePath.join(root, "elsewhere"));
    const fork = NodePath.join(root, "fork");
    NodeChildProcess.execFileSync("git", ["clone", "--quiet", project, fork]);
    NodeFS.writeFileSync(NodePath.join(fork, "hello.txt"), "v2\n");
    commit(fork, "v2", "--all");
    const v2 = git(fork, "rev-parse", "HEAD");
    const launch = script({
      remotes: [
        { name: "fork", url: fork },
        { name: "origin", url: project },
      ],
      trackedRemote: "fork",
      commit: v2,
    });

    const first = run(launch);
    const moved = {
      branch: git(checkout, "symbolic-ref", "--short", "HEAD"),
      head: git(checkout, "rev-parse", "HEAD"),
      hello: NodeFS.readFileSync(hello, "utf8"),
      cacheKept: NodeFS.existsSync(NodePath.join(checkout, "node_modules", "cache")),
      remotes: git(checkout, "remote", "-v"),
      pushRemote: git(checkout, "config", "branch.t3/sandbox-0a1b2c3d.pushRemote"),
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
        `fork\t${fork} (fetch)`,
        `fork\t${fork} (push)`,
        `origin\t${project} (fetch)`,
        `origin\t${project} (push)`,
      ].join("\n"),
      pushRemote: "fork",
    });
    expect(afterReplay).toBe("this agent's edit\n");
    expect(agentBranch).toBe("agent/fix");
    expect(afterAgentBranch).toBe("this agent's edit\n");
  });

  it("takes the clone of a sandbox whose id starts the same for a template's, not its own", () => {
    const { root, origin: project, checkout, script } = guestFixture();
    const run = (command: string) =>
      NodeChildProcess.spawnSync("bash", ["-c", command], { encoding: "utf8" });
    const hello = NodePath.join(checkout, "hello.txt");
    NodeFS.writeFileSync(NodePath.join(project, "hello.txt"), "v1\n");
    git(project, "add", "hello.txt");
    commit(project, "v1");
    const remotes = [{ name: "origin", url: project }] as const;
    const earlier = run(
      script(
        { remotes, trackedRemote: "origin", commit: git(project, "rev-parse", "HEAD") },
        "0a1b2c3d-0000-4000-8000-0000000000ee",
      ),
    );
    commit(checkout, "the earlier agent's work");
    NodeFS.writeFileSync(hello, "the earlier agent's edit\n");
    NodeFS.writeFileSync(NodePath.join(project, "hello.txt"), "v2\n");
    commit(project, "v2", "--all");
    const v2 = git(project, "rev-parse", "HEAD");
    const launch = script({ remotes, trackedRemote: "origin", commit: v2 });

    const first = run(launch);
    const moved = {
      branch: git(checkout, "symbolic-ref", "--short", "HEAD"),
      head: git(checkout, "rev-parse", "HEAD"),
      hello: NodeFS.readFileSync(hello, "utf8"),
      sandboxId: git(checkout, "config", "t3.sandboxId"),
    };
    NodeFS.writeFileSync(hello, "this agent's edit\n");
    const replay = run(launch);
    const afterReplay = NodeFS.readFileSync(hello, "utf8");
    NodeFS.rmSync(root, { recursive: true, force: true });

    for (const result of [earlier, first, replay]) {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(moved).toEqual({
      branch: "t3/sandbox-0a1b2c3d",
      head: v2,
      hello: "v2\n",
      sandboxId: SANDBOX_ID,
    });
    expect(afterReplay).toBe("this agent's edit\n");
  });

  it("launches when a remote it does not track cannot be fetched", () => {
    const { root, origin, pinned, checkout, script } = guestFixture();
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        script({
          remotes: [
            { name: "gone", url: NodePath.join(root, "gone") },
            { name: "origin", url: origin },
          ],
          trackedRemote: "origin",
          commit: pinned,
        }),
      ],
      { encoding: "utf8" },
    );
    const head = git(checkout, "rev-parse", "HEAD");
    const remotes = git(checkout, "remote");
    NodeFS.rmSync(root, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(head).toBe(pinned);
    expect(remotes).toBe("gone\norigin");
  });

  const PROJECT_URL = "https://github.com/pingdotgg/t3code.git";
  const FORK_URL = "https://github.com/chhoumann/t3code.git";
  it.effect.each([
    {
      layout: "origin is the project and the branch tracks a fork remote",
      remotes: { origin: PROJECT_URL, fork: FORK_URL },
      trackedRemote: "fork",
      otherRemote: "origin",
      groupingKey: "github.com/pingdotgg/t3code",
    },
    {
      layout: "origin is the fork the branch tracks and upstream is the project",
      remotes: { origin: FORK_URL, upstream: PROJECT_URL },
      trackedRemote: "origin",
      otherRemote: "upstream",
      groupingKey: "github.com/chhoumann/t3code",
    },
  ])(
    "clones the fork a branch tracks into a project with the checkout's identity, and the project's branches, when $layout",
    ({ remotes, trackedRemote, otherRemote, groupingKey }) =>
      Effect.gen(function* () {
        const { root, origin: project, checkout, script } = guestFixture();
        const fork = NodePath.join(root, "fork");
        NodeChildProcess.execFileSync("git", ["clone", "--quiet", project, fork]);
        commit(fork, "only on the fork");
        const forkOnly = git(fork, "rev-parse", "HEAD");
        const local = NodePath.join(root, "local");
        NodeFS.mkdirSync(local);
        git(local, "init", "--quiet");
        for (const [name, url] of Object.entries(remotes)) git(local, "remote", "add", name, url);
        // What the launch reads from the local status: every remote, and the tracked one.
        const localRemotes = parseRemoteFetchUrls(git(local, "remote", "-v"));
        const tracked = localRemotes.find((remote) => remote.name === trackedRemote);
        if (!Arr.isReadonlyArrayNonEmpty(localRemotes) || tracked === undefined) {
          return yield* Effect.die("the local checkout lacks its remotes");
        }
        const repository = {
          remotes: sandboxRemotes(localRemotes, tracked),
          trackedRemote,
          commit: forkOnly,
        };
        // Clones and fetches reach the local repositories; the clone's config keeps the URLs.
        const env = {
          ...process.env,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.${project}.insteadOf`,
          GIT_CONFIG_VALUE_0: PROJECT_URL,
          GIT_CONFIG_KEY_1: `url.${fork}.insteadOf`,
          GIT_CONFIG_VALUE_1: FORK_URL,
        };

        const result = NodeChildProcess.spawnSync("bash", ["-c", script(repository)], {
          encoding: "utf8",
          env,
        });
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const { rootPath: _local, ...localIdentity } = (yield* resolver.resolve(local)) ?? {};
        const { rootPath: _guest, ...guestIdentity } = (yield* resolver.resolve(checkout)) ?? {};
        const pending = sandboxProject(repository).repositoryIdentity;
        const projectMain = git(checkout, "rev-parse", `refs/remotes/${otherRemote}/main`);
        const projectHead = git(project, "rev-parse", "main");
        NodeFS.rmSync(root, { recursive: true, force: true });

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(guestIdentity).toEqual(localIdentity);
        expect(localIdentity).toMatchObject({ canonicalKey: "github.com/pingdotgg/t3code" });
        expect(repositoryGroupingKeyOf(guestIdentity as RepositoryIdentity)).toBe(groupingKey);
        expect(repositoryGroupingKeyOf(pending)).toBe(groupingKey);
        expect(projectMain).toBe(projectHead);
      }).pipe(
        Effect.provide(RepositoryIdentityResolver.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
  );

  it("starts the task branch at the tracked remote's commit and pushes it there", () => {
    const { root, origin: project, checkout, script } = guestFixture();
    const fork = NodePath.join(root, "fork");
    NodeChildProcess.execFileSync("git", ["clone", "--quiet", "--bare", project, fork]);
    const launch = script({
      remotes: [
        { name: "fork", url: fork },
        { name: "origin", url: project },
      ],
      trackedRemote: "fork",
      commit: null,
    });

    const result = NodeChildProcess.spawnSync("bash", ["-c", launch], { encoding: "utf8" });
    commit(checkout, "the agent's work");
    // Git's own push defaults, not the machine's.
    const push = NodeChildProcess.spawnSync("git", ["-C", checkout, "push", "--quiet"], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const pushed = {
      onFork: git(fork, "rev-parse", "refs/heads/t3/sandbox-0a1b2c3d"),
      onProject: NodeChildProcess.spawnSync(
        "git",
        ["-C", project, "rev-parse", "--verify", "--quiet", "refs/heads/t3/sandbox-0a1b2c3d"],
        { encoding: "utf8" },
      ).status,
    };
    const head = git(checkout, "rev-parse", "HEAD");
    NodeFS.rmSync(root, { recursive: true, force: true });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(push.status).toBe(0);
    expect(pushed).toEqual({ onFork: head, onProject: 1 });
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

const unused = () => Effect.die("unused");

/** The guest over a provider whose machine runs only `machine`'s calls. */
const guestLayer = (machine: Pick<SandboxProvider["Service"], "exec" | "writeFile">) =>
  SandboxGuest.layer.pipe(
    Layer.provide(
      Layer.succeed(
        SandboxProvider,
        SandboxProvider.of({
          checkAccess: unused,
          listTemplates: unused,
          create: unused,
          inspect: unused,
          host: unused,
          setDeadline: unused,
          stop: unused,
          resume: unused,
          destroy: unused,
          ...machine,
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(unused))),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

describe("SandboxGuest", () => {
  it.effect("names why a guest command failed with the end of its stderr", () => {
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
    const layer = guestLayer({
      exec: () => Effect.succeed({ exitCode: 128, stdout: "", stderr, timedOut: false }),
      writeFile: unused,
    });
    return Effect.gen(function* () {
      const guest = yield* SandboxGuest.SandboxGuest;
      const failure = yield* guest
        .cloneCheckout({ apiKey: Redacted.make("key") }, ProviderMachineId.make("bx_1"), {
          remotes: [{ name: "origin", url: "https://github.com/acme/app.git" }],
          trackedRemote: "origin",
          commit: null,
          sandboxId: SANDBOX_ID,
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

  it.effect(
    "uploads the inputs of a machine made from a template over the earlier sandbox's, once",
    () => {
      // The machine's home is a temp dir its commands and files are redirected to.
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-inputs-"));
      const at = (path: string) => path.replace("/home/user", home);
      NodeFS.mkdirSync(NodePath.dirname(at(SANDBOX_INPUTS_READY_FILE)), { recursive: true });
      NodeFS.writeFileSync(at(SANDBOX_INPUTS_READY_FILE), "sbx-earlier");
      NodeFS.writeFileSync(
        at(SANDBOX_MANAGED_FILE),
        '{"ownerEnvironmentId":"env-owner","sandboxId":"sbx-earlier"}',
      );
      const written: Array<string> = [];
      const layer = guestLayer({
        exec: (_account, _machineId, { command }) =>
          Effect.sync(() => {
            const result = NodeChildProcess.spawnSync("bash", ["-c", at(command)], {
              encoding: "utf8",
            });
            return {
              exitCode: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: false,
            };
          }),
        writeFile: (_account, _machineId, { path, content }) =>
          Effect.sync(() => {
            written.push(path);
            NodeFS.writeFileSync(at(path), content);
          }),
      });
      return Effect.gen(function* () {
        const guest = yield* SandboxGuest.SandboxGuest;
        const inputs = {
          envFile: 'ANTHROPIC_API_KEY="new"\n',
          setupEnvFile: "",
          machineSetupScript: "",
          tarball: null,
          managed: {
            ownerEnvironmentId: EnvironmentId.make("env-owner"),
            sandboxId: SandboxId.make("sbx-0a1b2c3d"),
          },
        };
        const account = { apiKey: Redacted.make("key") };
        yield* guest.writeBootInputs(account, ProviderMachineId.make("bx_1"), inputs);
        yield* guest.writeBootInputs(account, ProviderMachineId.make("bx_1"), inputs);
        const managed = NodeFS.readFileSync(at(SANDBOX_MANAGED_FILE), "utf8");
        const ready = NodeFS.readFileSync(at(SANDBOX_INPUTS_READY_FILE), "utf8");
        NodeFS.rmSync(home, { recursive: true });

        expect(managed).toBe('{"ownerEnvironmentId":"env-owner","sandboxId":"sbx-0a1b2c3d"}');
        expect(ready).toBe("sbx-0a1b2c3d");
        expect(written).toEqual([
          SANDBOX_ENV_FILE,
          SANDBOX_SETUP_ENV_FILE,
          SANDBOX_MACHINE_SETUP_SCRIPT,
          SANDBOX_MANAGED_FILE,
          SANDBOX_INPUTS_READY_FILE,
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});
