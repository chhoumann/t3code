// @effect-diagnostics nodeBuiltinImport:off - the rendered scripts are checked by a real bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { FLOCK_SHIM } from "../testUtils/flockShim.ts";
import {
  SANDBOX_ENV_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_SETUP_ENV_FILE,
  renderRefreshCredentialsCommand,
  renderSandboxBootScript,
  renderSandboxEnvFile,
  type SandboxT3Source,
} from "./sandboxBootScript.ts";

const tarball: SandboxT3Source = { kind: "tarball", version: "0.0.45" };
const npm: SandboxT3Source = { kind: "npm", version: "0.0.45" };
const label = "Add hello.txt";

const bashSyntaxErrors = (script: string) =>
  NodeChildProcess.spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

const lineIndex = (script: string, pattern: RegExp) =>
  script.split("\n").findIndex((line) => pattern.test(line));

describe("renderSandboxBootScript", () => {
  it.each([
    ["tarball", tarball],
    ["npm", npm],
  ])("renders valid bash for %s", (_, source) => {
    const result = bashSyntaxErrors(renderSandboxBootScript({ t3: source, label }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("installs the machine setup as a boot unit with the account env, after the inputs and before T3", () => {
    const script = renderSandboxBootScript({ t3: tarball, label });
    const lines = script.split("\n");
    const waitForInputs = lineIndex(
      script,
      new RegExp(`\\[ -f '${SANDBOX_INPUTS_READY_FILE}' \\]`),
    );
    const unitStart = lineIndex(script, /systemctl start t3-sandbox-machine-setup\.service/);
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
    const script = renderSandboxBootScript({ t3: tarball, label: title });
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
    const script = renderSandboxBootScript({ t3: tarball, label });
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
    const script = renderSandboxBootScript({ t3: tarball, label });
    expect(script).not.toContain("npx");
    expect(script).toContain("tar -xzf '/home/user/.t3/sandbox/t3.tgz'");
    expect(script).toContain('"$RUNTIME/t3" service install');
  });

  it("installs a release through npm at the requested version", () => {
    expect(renderSandboxBootScript({ t3: npm, label })).toContain(
      "npx --yes 't3@0.0.45' service install",
    );
  });

  it("keeps everything out of paths Boat does not persist", () => {
    for (const script of [
      renderSandboxBootScript({ t3: tarball, label }),
      renderSandboxBootScript({ t3: npm, label }),
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

describe("renderRefreshCredentialsCommand", () => {
  it("renders valid bash", () => {
    const result = bashSyntaxErrors(renderRefreshCredentialsCommand());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  /** A guest home under a temp dir, with `systemctl` logged and failing where told. */
  const refreshFixture = () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-refresh-"));
    const at = (path: string) => path.replace("/home/user", home);
    const inputs = NodePath.dirname(at(SANDBOX_SETUP_ENV_FILE));
    NodeFS.mkdirSync(inputs, { recursive: true });
    const script = renderRefreshCredentialsCommand().replaceAll("/home/user", home);
    NodeFS.writeFileSync(at(SANDBOX_ENV_FILE), "OLD=1\n");
    const stage = (env: string, setupEnv = "") => {
      NodeFS.writeFileSync(NodePath.join(inputs, "sandbox.env.next"), env);
      NodeFS.writeFileSync(NodePath.join(inputs, "setup.env.next"), setupEnv);
      NodeFS.writeFileSync(NodePath.join(inputs, "machine-setup.sh.next"), "");
    };
    const log = NodePath.join(home, "systemctl.log");
    /** `failing` is a bash test on the systemctl arguments that makes the call fail. */
    const refresh = (failing = "false") =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          "-c",
          [
            FLOCK_SHIM,
            'sudo() { "$@"; }',
            `systemctl() { echo "$*" >> ${JSON.stringify(log)}; ! ${failing}; }`,
            script,
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );
    return { home, stage, log, refresh };
  };

  it("restarts T3 on the next refresh when a refresh died after swapping its env in", () => {
    const { home, stage, log, refresh } = refreshFixture();
    stage("NEW=1\n");
    expect(refresh('[ "$1" = --user ]').status).not.toBe(0);
    NodeFS.writeFileSync(log, "");
    stage("NEW=1\n");
    const second = refresh();
    const restarts = NodeFS.readFileSync(log, "utf8");
    NodeFS.rmSync(home, { recursive: true });

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("setup_restarted=0 t3_restarted=1");
    expect(restarts).toBe("--user restart t3code.service\n");
  });
});
