// @effect-diagnostics nodeBuiltinImport:off - the rendered script is checked by a real bash.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import {
  SANDBOX_ENV_FILE,
  SANDBOX_INPUTS_READY_FILE,
  renderSandboxBootScript,
  type SandboxBootSpec,
} from "./sandboxBootScript.ts";

const tarball: SandboxBootSpec = {
  source: { kind: "tarball", version: "0.0.45", path: "/home/user/.t3/sandbox/t3.tgz" },
  machineSetupScript: null,
};
const npm: SandboxBootSpec = {
  source: { kind: "npm", version: "0.0.45" },
  machineSetupScript: null,
};
const hostileSetup = `#!/usr/bin/env bash\necho 'it'"'"'s' "$HOME"\ncat <<'EOF'\nEOF\n$(touch /pwned)\n`;

const lineIndex = (script: string, pattern: RegExp) =>
  script.split("\n").findIndex((line) => pattern.test(line));

describe("renderSandboxBootScript", () => {
  it.each([
    ["tarball", tarball],
    ["npm", npm],
    ["tarball with machine setup", { ...tarball, machineSetupScript: hostileSetup }],
  ])("renders valid bash for %s", (_, spec) => {
    const result = NodeChildProcess.spawnSync("bash", ["-n"], {
      input: renderSandboxBootScript(spec),
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("carries the machine setup script byte for byte", () => {
    const script = renderSandboxBootScript({ ...tarball, machineSetupScript: hostileSetup });
    const writeLine = script.split("\n")[lineIndex(script, /\| base64 -d >/)] ?? "";
    const decoded = NodeChildProcess.spawnSync("bash", ["-c", writeLine.replace(/ > .*$/, "")], {
      encoding: "utf8",
    });
    expect(decoded.stdout).toBe(hostileSetup);
  });

  it("runs the machine setup with the account env, after the inputs arrive and before T3 installs", () => {
    const script = renderSandboxBootScript({ ...tarball, machineSetupScript: "true" });
    const waitForInputs = lineIndex(
      script,
      new RegExp(`\\[ -f '${SANDBOX_INPUTS_READY_FILE}' \\]`),
    );
    const setup = lineIndex(script, /bash '.*machine-setup\.sh'/);
    const install = lineIndex(script, /service install/);
    expect(script.split("\n")[setup]).toMatch(
      new RegExp(`^\\(set \\+x && set -a && \\. '${SANDBOX_ENV_FILE}'`),
    );
    expect(waitForInputs).toBeGreaterThanOrEqual(0);
    expect(waitForInputs).toBeLessThan(setup);
    expect(setup).toBeLessThan(install);
  });

  it("writes the service drop-in before the service starts", () => {
    const script = renderSandboxBootScript(tarball);
    const dropIn = script.slice(
      script.indexOf("[Service]"),
      script.indexOf("EOF", script.indexOf("[Service]")),
    );
    expect(dropIn.split("\n").filter(Boolean)).toEqual([
      "[Service]",
      "Environment=T3CODE_HOST=0.0.0.0",
      "Environment=T3CODE_PORT=3773",
      `EnvironmentFile=${SANDBOX_ENV_FILE}`,
      "UnsetEnvironment=ASCII_TOKEN",
    ]);
    expect(script.indexOf("[Service]")).toBeLessThan(script.indexOf("service install"));
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
    for (const spec of [tarball, npm]) {
      const script = renderSandboxBootScript(spec);
      expect(script).not.toMatch(/\/tmp\b/);
      expect(script).not.toContain(".cache");
    }
  });
});
