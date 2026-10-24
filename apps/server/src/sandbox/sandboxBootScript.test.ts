// @effect-diagnostics nodeBuiltinImport:off - the rendered scripts are checked by a real bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { FLOCK_SHIM } from "../testUtils/flockShim.ts";
import {
  SANDBOX_ENV_FILE,
  SANDBOX_GITHUB_TOKEN_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_SETUP_ENV_FILE,
  renderGitHubLoginCommand,
  renderRefreshCredentialsCommand,
  renderRestartServerCommand,
  renderSandboxBootScript,
  renderSandboxEnvFile,
  type SandboxT3Source,
} from "./sandboxBootScript.ts";

const tarball: SandboxT3Source = { kind: "tarball", version: "0.0.45" };
const npm: SandboxT3Source = { kind: "npm", version: "0.0.45" };
const label = "Add hello.txt";
const sandboxId = "sbx-0a1b2c3d";

const bashSyntaxErrors = (script: string) =>
  NodeChildProcess.spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

const lineIndex = (script: string, pattern: RegExp) =>
  script.split("\n").findIndex((line) => pattern.test(line));

describe("renderSandboxBootScript", () => {
  it.each([
    ["tarball", tarball],
    ["npm", npm],
  ])("renders valid bash for %s", (_, source) => {
    const result = bashSyntaxErrors(renderSandboxBootScript({ t3: source, sandboxId, label }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("installs the machine setup as a boot unit with the account env, after the inputs and before T3", () => {
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label });
    const lines = script.split("\n");
    const waitForInputs = lineIndex(script, new RegExp(`cat '${SANDBOX_INPUTS_READY_FILE}'`));
    const unitStart = lineIndex(script, /systemctl restart t3-sandbox-machine-setup\.service/);
    const install = lineIndex(script, /service install/);
    expect(waitForInputs).toBeGreaterThanOrEqual(0);
    expect(waitForInputs).toBeLessThan(unitStart);
    expect(unitStart).toBeLessThan(install);
    expect(lines).toContain(`EnvironmentFile=${SANDBOX_ENV_FILE}`);
    // Setup-only values reach the setup; the T3 drop-in below never loads them.
    expect(lines).toContain(`EnvironmentFile=${SANDBOX_SETUP_ENV_FILE}`);
    expect(lines).toContain(`ExecStart=/bin/bash ${SANDBOX_MACHINE_SETUP_SCRIPT}`);
    expect(lines).toContain("Before=user@$(id -u).service");
    expect(lines).toContain("sudo systemctl enable t3-sandbox-machine-setup.service");
  });

  it("names the machine after the sandbox before T3 starts, hostile titles included", () => {
    const title = `it's "$HOME" \`id\` $(id) \\`;
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label: title });
    const naming = lineIndex(script, /hostnamectl/);
    expect(naming).toBeGreaterThanOrEqual(0);
    expect(naming).toBeLessThan(lineIndex(script, /service install/));
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", `sudo() { printf '%s\\0' "$@"; }\n${script.split("\n")[naming]}`],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\0").slice(0, -1)).toEqual([
      "hostnamectl",
      "set-hostname",
      "--pretty",
      title,
    ]);
  });

  it("writes the service drop-in before the service starts", () => {
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label });
    const userDropIn = script.lastIndexOf("[Service]");
    const dropIn = script.slice(userDropIn, script.indexOf("EOF", userDropIn));
    expect(dropIn.split("\n").filter(Boolean)).toEqual([
      "[Service]",
      "Environment=T3CODE_HOST=0.0.0.0",
      "Environment=T3CODE_PORT=3773",
      "Environment=T3CODE_NO_STARTUP_PAIRING=true",
      `EnvironmentFile=${SANDBOX_ENV_FILE}`,
      "UnsetEnvironment=ASCII_TOKEN",
    ]);
    expect(userDropIn).toBeLessThan(script.indexOf("service install"));
  });

  it("installs an uploaded build without fetching a release", () => {
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label });
    expect(script).not.toContain("npx");
    expect(script).toContain("tar -xzf '/home/user/.t3/sandbox/t3.tgz'");
    expect(script).toContain('"$RUNTIME/t3" service install');
  });

  it("installs a release through npm at the requested version", () => {
    expect(renderSandboxBootScript({ t3: npm, sandboxId, label })).toContain(
      "npx --yes 't3@0.0.45' service install",
    );
  });

  /**
   * A guest home under a temp dir, as a template snapshot of an earlier
   * sandbox leaves it: T3 installed and its data written. Machine commands
   * are logged instead of run, and T3 answers at once.
   */
  const templateFixture = (readyFor: string) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-boot-"));
    const at = (path: string) => path.replace("/home/user", home);
    NodeFS.mkdirSync(NodePath.dirname(at(SANDBOX_SETUP_ENV_FILE)), { recursive: true });
    NodeFS.writeFileSync(at(SANDBOX_ENV_FILE), "");
    NodeFS.writeFileSync(at(SANDBOX_SETUP_ENV_FILE), "");
    NodeFS.writeFileSync(at(SANDBOX_INPUTS_READY_FILE), readyFor);
    const userdata = NodePath.join(home, ".t3", "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(userdata, "environment-id"), "env-earlier-sandbox");
    const runtime = NodePath.join(home, ".t3", "runtime", "versions", "0.0.45");
    NodeFS.mkdirSync(runtime, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(runtime, "t3"), "");
    const log = NodePath.join(home, "commands.log");
    const run = () =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          "-c",
          [
            `sudo() { if [ "$1" = tee ]; then cat >/dev/null; else echo "sudo $*" >> ${JSON.stringify(log)}; fi; }`,
            `systemctl() { echo "systemctl $*" >> ${JSON.stringify(log)}; }`,
            `npx() { echo "npx $*" >> ${JSON.stringify(log)}; }`,
            "curl() { :; }",
            "seq() { echo 1; }",
            "sleep() { :; }",
            renderSandboxBootScript({ t3: npm, sandboxId, label }).replaceAll("/home/user", home),
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    const commands = () =>
      NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
    return { home, userdata, runtime, run, commands };
  };

  it("starts T3 afresh over a template's T3 data and keeps its installed runtime", () => {
    const { home, userdata, runtime, run, commands } = templateFixture(sandboxId);
    const result = run();
    const logged = commands();
    const userdataLeft = NodeFS.existsSync(userdata);
    const runtimeKept = NodeFS.existsSync(NodePath.join(runtime, "t3"));
    NodeFS.rmSync(home, { recursive: true });

    expect(result.status).toBe(0);
    expect(userdataLeft).toBe(false);
    expect(runtimeKept).toBe(true);
    expect(logged[0]).toBe("systemctl --user stop t3code.service");
    expect(logged).toContain("sudo systemctl restart t3-sandbox-machine-setup.service");
    expect(logged.at(-1)).toBe("npx --yes t3@0.0.45 service install");
  });

  it("waits for this sandbox's inputs, not the earlier sandbox's a template carries", () => {
    const { home, run, commands } = templateFixture("sbx-earlier");
    const result = run();
    const logged = commands();
    NodeFS.rmSync(home, { recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Timed out waiting for the sandbox inputs.");
    expect(logged).toEqual(["systemctl --user stop t3code.service"]);
  });

  it("installs the GitHub CLI when the image lacks it, before the machine setup and T3", () => {
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label });
    const install = lineIndex(script, /if ! command -v gh/);
    const aptInstall = lineIndex(script, /apt-get install .* gh$/);
    const unitStart = lineIndex(script, /systemctl restart t3-sandbox-machine-setup\.service/);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(aptInstall).toBeGreaterThan(install);
    expect(aptInstall).toBeLessThan(unitStart);
    expect(unitStart).toBeLessThan(lineIndex(script, /service install/));
    expect(script).toContain("DEBIAN_FRONTEND=noninteractive");
  });

  it("drops the GitHub login a template carries before T3 starts", () => {
    const script = renderSandboxBootScript({ t3: tarball, sandboxId, label });
    const dropLogin = lineIndex(script, /rm -rf '\/home\/user\/\.config\/gh'/);
    expect(dropLogin).toBeGreaterThanOrEqual(0);
    expect(dropLogin).toBeLessThan(lineIndex(script, /service install/));
  });

  it("keeps everything out of paths Boat does not persist", () => {
    for (const script of [
      renderSandboxBootScript({ t3: tarball, sandboxId, label }),
      renderSandboxBootScript({ t3: npm, sandboxId, label }),
      renderRefreshCredentialsCommand(),
    ]) {
      expect(script).not.toMatch(/\/tmp\b/);
      expect(script).not.toContain(".cache");
    }
  });
});

describe("renderSandboxEnvFile", () => {
  it("reads back byte for byte through bash, empty and hostile values included", () => {
    const env = [
      { name: "ANTHROPIC_API_KEY", value: "" },
      { name: "HOSTILE", value: `it's "$HOME" \`touch /pwned\` $(id) \\ \\"\nsecond line\\` },
      { name: "URL", value: "https://proxy.example.ts.net/v1?a=1&b=2" },
    ];
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-env-"));
    const file = NodePath.join(directory, "sandbox.env");
    NodeFS.writeFileSync(file, renderSandboxEnvFile(env));
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -a && . "$1" && printf '%s\\0' "$ANTHROPIC_API_KEY" "$HOSTILE" "$URL"`,
        "-",
        file,
      ],
      { encoding: "utf8" },
    );
    NodeFS.rmSync(directory, { recursive: true });
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\0").slice(0, -1)).toEqual(env.map((entry) => entry.value));
  });
});

/** A guest home under a temp dir, with `systemctl` logged and failing where told. */
const guestFixture = (prefix: string) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  const at = (path: string) => path.replace("/home/user", home);
  const inputs = NodePath.dirname(at(SANDBOX_SETUP_ENV_FILE));
  NodeFS.mkdirSync(inputs, { recursive: true });
  const log = NodePath.join(home, "systemctl.log");
  /**
   * Runs a rendered command against the home. `failing` is a bash test on the
   * systemctl arguments that makes the call fail. `leaveBehind` makes each
   * call leave a process running after it.
   */
  const run = (command: string, failing = "false", leaveBehind = false) =>
    NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        [
          FLOCK_SHIM,
          'sudo() { "$@"; }',
          `systemctl() { echo "$*" >> ${JSON.stringify(log)}; ${
            leaveBehind ? "sleep 10 >/dev/null 2>&1 &" : ""
          } ! ${failing}; }`,
          command.replaceAll("/home/user", home),
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
  const systemctlCalls = () => NodeFS.readFileSync(log, "utf8");
  NodeFS.writeFileSync(log, "");
  return { home, at, inputs, run, systemctlCalls };
};

describe("renderRefreshCredentialsCommand", () => {
  it("renders valid bash", () => {
    const result = bashSyntaxErrors(renderRefreshCredentialsCommand());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  const refreshFixture = () => {
    const fixture = guestFixture("sandbox-refresh-");
    NodeFS.writeFileSync(fixture.at(SANDBOX_ENV_FILE), "OLD=1\n");
    const stage = (env: string, setupEnv = "") => {
      NodeFS.writeFileSync(NodePath.join(fixture.inputs, "sandbox.env.next"), env);
      NodeFS.writeFileSync(NodePath.join(fixture.inputs, "setup.env.next"), setupEnv);
      NodeFS.writeFileSync(NodePath.join(fixture.inputs, "machine-setup.sh.next"), "");
    };
    const refresh = (failing = "false", leaveBehind = false) =>
      fixture.run(renderRefreshCredentialsCommand(), failing, leaveBehind);
    const restart = () => fixture.run(renderRestartServerCommand());
    return { ...fixture, stage, refresh, restart };
  };

  it("swaps a changed env in and leaves T3's restart to the restart command", () => {
    const { home, stage, refresh, restart, systemctlCalls } = refreshFixture();
    stage("NEW=1\n", "TOKEN=new\n");
    const refreshed = refresh();
    const afterRefresh = systemctlCalls();
    const restarted = restart();
    const replayed = restart();
    const calls = systemctlCalls();
    const env = NodeFS.readFileSync(NodePath.join(home, ".t3/sandbox.env"), "utf8");
    NodeFS.rmSync(home, { recursive: true });

    expect(refreshed.status).toBe(0);
    expect(refreshed.stdout.trim()).toBe("setup_restarted=1 t3_restart_pending=1");
    expect(afterRefresh).toBe("restart t3-sandbox-machine-setup.service\n");
    expect(env).toBe("NEW=1\n");
    expect(restarted.status).toBe(0);
    expect(restarted.stdout.trim()).toBe("t3_restarted=1");
    expect(replayed.status).toBe(0);
    expect(replayed.stdout.trim()).toBe("t3_restarted=0");
    expect(calls).toBe(
      ["restart t3-sandbox-machine-setup.service", "--user restart t3code.service", ""].join("\n"),
    );
  });

  it("still reports the restart pending when a refresh died after swapping its env in", () => {
    const { home, stage, refresh, systemctlCalls } = refreshFixture();
    stage("NEW=1\n");
    expect(refresh('[ "$2" = t3-sandbox-machine-setup.service ]').status).not.toBe(0);
    stage("NEW=1\n");
    const second = refresh();
    const calls = systemctlCalls();
    NodeFS.rmSync(home, { recursive: true });

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("setup_restarted=1 t3_restart_pending=1");
    expect(calls).not.toContain("t3code.service");
  });

  it("succeeds again when replayed after the run that consumed the staged files", () => {
    const { home, stage, refresh, systemctlCalls } = refreshFixture();
    stage("NEW=1\n", "TOKEN=new\n");
    const first = refresh();
    const replay = refresh();
    const calls = systemctlCalls();
    NodeFS.rmSync(home, { recursive: true });

    expect(first.status).toBe(0);
    expect(replay.stderr).toBe("");
    expect(replay.status).toBe(0);
    // The restart has not run yet, so the replay still asks for it.
    expect(replay.stdout.trim()).toBe("setup_restarted=0 t3_restart_pending=1");
    expect(calls).toBe("restart t3-sandbox-machine-setup.service\n");
  });

  it("lets the next refresh run while a process a restart left behind is still running", () => {
    const { home, stage, refresh } = refreshFixture();
    stage("NEW=1\n", "TOKEN=new\n");
    expect(refresh("false", true).status).toBe(0);
    const next = refresh();
    NodeFS.rmSync(home, { recursive: true });

    expect(next.signal).toBeNull();
    expect(next.status).toBe(0);
  });

  it("fails a refresh whose machine setup failed and runs the setup on the next", () => {
    const { home, stage, refresh, systemctlCalls } = refreshFixture();
    stage("NEW=1\n", "TOKEN=new\n");
    const first = refresh('[ "$2" = t3-sandbox-machine-setup.service ]');
    expect(first.status).not.toBe(0);
    expect(first.stdout.trim()).toBe("setup_restarted=0 t3_restart_pending=1");
    expect(first.stderr).toContain("machine setup failed");

    stage("NEW=1\n", "TOKEN=new\n");
    const second = refresh();
    const calls = systemctlCalls();
    NodeFS.rmSync(home, { recursive: true });

    expect(second.stdout.trim()).toBe("setup_restarted=1 t3_restart_pending=1");
    expect(calls).toBe(
      [
        "restart t3-sandbox-machine-setup.service",
        "restart t3-sandbox-machine-setup.service",
        "",
      ].join("\n"),
    );
  });
});

describe("renderGitHubLoginCommand", () => {
  const user = { login: "octocat", name: "The Octocat", email: "octocat@github.com" };

  it("renders valid bash, hostile names included", () => {
    const result = bashSyntaxErrors(
      renderGitHubLoginCommand({ login: `it's "$HOME" \`id\``, name: null, email: null }),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  /** A guest whose `gh` and `git` log their arguments and stdin, with `gh` failing where told. */
  const loginFixture = (ghFailing = "false") => {
    const fixture = guestFixture("sandbox-login-");
    const log = NodePath.join(fixture.home, "commands.log");
    const run = (command: string) =>
      fixture.run(
        [
          `gh() { printf 'gh %s\\n' "$*" >> ${JSON.stringify(log)}; if [ "$1" = auth ] && [ "$2" = login ]; then printf 'stdin %s\\n' "$(cat)" >> ${JSON.stringify(log)}; fi; ! ${ghFailing}; }`,
          `git() { printf 'git %s\\n' "$*" >> ${JSON.stringify(log)}; }`,
          command,
        ].join("\n"),
      );
    return { ...fixture, run, commands: () => NodeFS.readFileSync(log, "utf8") };
  };

  it("hands gh the token on stdin, never as an argument, and removes the file", () => {
    const { home, at, run, commands } = loginFixture();
    const tokenFile = at(SANDBOX_GITHUB_TOKEN_FILE);
    NodeFS.writeFileSync(tokenFile, "ghu_secret");
    const command = renderGitHubLoginCommand(user);
    const result = run(command);
    const tokenFileLeft = NodeFS.existsSync(tokenFile);
    const log = commands();
    NodeFS.rmSync(home, { recursive: true });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(command).not.toContain("ghu_secret");
    expect(tokenFileLeft).toBe(false);
    expect(log.split("\n")).toEqual([
      "gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage",
      "stdin ghu_secret",
      "gh auth setup-git --hostname github.com",
      "git config --global user.name The Octocat",
      "git config --global user.email octocat@github.com",
      "",
    ]);
  });

  it("removes the token file when the login fails, and names the user after their login without a name", () => {
    const { home, at, run, commands } = loginFixture('[ "$2" = login ]');
    const tokenFile = at(SANDBOX_GITHUB_TOKEN_FILE);
    NodeFS.writeFileSync(tokenFile, "ghu_secret");
    const result = run(renderGitHubLoginCommand({ login: "octocat", name: null, email: null }));
    const tokenFileLeft = NodeFS.existsSync(tokenFile);
    const log = commands();
    NodeFS.rmSync(home, { recursive: true });

    expect(result.status).not.toBe(0);
    expect(tokenFileLeft).toBe(false);
    expect(log).not.toContain("setup-git");

    const { home: home2, at: at2, run: run2, commands: commands2 } = loginFixture();
    NodeFS.writeFileSync(at2(SANDBOX_GITHUB_TOKEN_FILE), "ghu_secret");
    expect(
      run2(renderGitHubLoginCommand({ login: "octocat", name: null, email: null })).status,
    ).toBe(0);
    const log2 = commands2();
    NodeFS.rmSync(home2, { recursive: true });
    expect(log2).toContain("git config --global user.name octocat\n");
    expect(log2).not.toContain("user.email");
  });
});
