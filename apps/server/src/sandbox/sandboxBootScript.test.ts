// @effect-diagnostics nodeBuiltinImport:off - the rendered scripts are checked by a real bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  SANDBOX_ENV_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  renderRefreshCredentialsCommand,
  renderSandboxBootScript,
  renderSandboxEnvFile,
  type SandboxT3Source,
} from "./sandboxBootScript.ts";

const tarball: SandboxT3Source = { kind: "tarball", version: "0.0.45" };
const npm: SandboxT3Source = { kind: "npm", version: "0.0.45" };

const bashSyntaxErrors = (script: string) =>
  NodeChildProcess.spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

const lineIndex = (script: string, pattern: RegExp) =>
  script.split("\n").findIndex((line) => pattern.test(line));

describe("renderSandboxBootScript", () => {
  it.each([
    ["tarball", tarball],
    ["npm", npm],
  ])("renders valid bash for %s", (_, source) => {
    const result = bashSyntaxErrors(renderSandboxBootScript(source));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("installs the machine setup as a boot unit with the account env, after the inputs and before T3", () => {
    const script = renderSandboxBootScript(tarball);
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
    expect(lines).toContain(`ExecStart=/bin/bash ${SANDBOX_MACHINE_SETUP_SCRIPT}`);
    expect(lines).toContain("Before=user@$(id -u).service");
    expect(lines).toContain("sudo systemctl enable t3-sandbox-machine-setup.service");
  });

  it("writes the service drop-in before the service starts", () => {
    const script = renderSandboxBootScript(tarball);
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
    const script = renderSandboxBootScript(tarball);
    expect(script).not.toContain("npx");
    expect(script).toContain("tar -xzf '/home/user/.t3/sandbox/t3.tgz'");
    expect(script).toContain('"$RUNTIME/t3" service install');
  });

  it("installs a release through npm at the requested version", () => {
    expect(renderSandboxBootScript(npm)).toContain("npx --yes 't3@0.0.45' service install");
  });

  it("keeps everything out of paths Boat does not persist", () => {
    for (const script of [
      renderSandboxBootScript(tarball),
      renderSandboxBootScript(npm),
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
});
