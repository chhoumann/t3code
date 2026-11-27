import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderDriverKind } from "./providerInstance.ts";
import {
  SandboxAccountId,
  SandboxAccountSaveInput,
  SandboxBranchName,
  SandboxId,
  SandboxLaunchInput,
  SandboxRemoteUrl,
  SandboxSource,
} from "./sandbox.ts";

const isRemoteUrl = Schema.is(SandboxRemoteUrl);
const isBranchName = Schema.is(SandboxBranchName);
const decodeSource = Schema.decodeUnknownExit(SandboxSource);

describe("SandboxRemoteUrl", () => {
  it.each([
    "https://github.com/pingdotgg/t3code.git",
    "https://github.com/pingdotgg/t3code",
    "https://gitlab.example.com:8443/group/sub/project",
  ])("accepts %s", (url) => {
    expect(isRemoteUrl(url)).toBe(true);
  });

  it.each([
    ["an SSH remote", "git@github.com:pingdotgg/t3code.git"],
    ["an ssh:// remote", "ssh://git@github.com/pingdotgg/t3code.git"],
    ["a plain http remote", "http://github.com/pingdotgg/t3code"],
    ["a local path", "/home/user/projects/t3code"],
    ["a URL carrying credentials", "https://user:token@github.com/pingdotgg/t3code"],
    ["a URL with a query token", "https://github.com/pingdotgg/t3code?access_token=x"],
    ["a host alone", "https://github.com"],
    ["a host and owner alone", "https://github.com/pingdotgg"],
    ["an owner with an empty repository", "https://github.com/pingdotgg/"],
  ])("refuses %s", (_, url) => {
    expect(isRemoteUrl(url)).toBe(false);
  });
});

describe("SandboxBranchName", () => {
  it.each(["main", "release/2.x", "feat/issue-12_fix", "v1.0", "a/b/c"])("accepts %s", (name) => {
    expect(isBranchName(name)).toBe(true);
  });

  it.each([
    ["HEAD", "HEAD"],
    ["an option-looking name", "-x"],
    ["a revision range", "main..dev"],
    ["reflog syntax", "main@{1}"],
    ["a parent selector", "main^"],
    ["an ancestor selector", "main~2"],
    ["a refspec", "main:dev"],
    ["a lock file", "main.lock"],
    ["a hidden component", "feat/.hidden"],
    ["a trailing slash", "main/"],
    ["a space", "my branch"],
    ["a wildcard", "release/*"],
    ["a trailing dot", "main."],
  ])("refuses %s", (_, name) => {
    expect(isBranchName(name)).toBe(false);
  });
});

describe("SandboxSource", () => {
  it("names a repository at its default branch or at a branch", () => {
    const remoteUrl = "https://github.com/pingdotgg/t3code.git";
    expect(decodeSource({ remoteUrl, base: { _tag: "default" } })._tag).toBe("Success");
    expect(decodeSource({ remoteUrl, base: { _tag: "branch", name: "release/2.x" } })._tag).toBe(
      "Success",
    );
    expect(decodeSource({ remoteUrl, base: { _tag: "branch", name: "HEAD" } })._tag).toBe(
      "Failure",
    );
  });
});

describe("multi-provider accounts and local checkout launch", () => {
  it("decodes docker, command, and boat accounts with exposed ports", () => {
    const decodeAccount = Schema.decodeUnknownExit(SandboxAccountSaveInput);
    const base = {
      id: SandboxAccountId.make("acc-1"),
      label: "Local Docker",
      providerEnvironment: null,
      size: "default" as const,
      stopAfterHours: 4,
      machineSetupScript: null,
      env: [],
    };
    expect(
      decodeAccount({
        ...base,
        provider: "docker",
        dockerImage: "node:22-bookworm",
        exposedHostPorts: [8317],
      })._tag,
    ).toBe("Success");
    expect(
      decodeAccount({
        ...base,
        provider: "command",
        commandProgram: "/usr/local/bin/my-sandbox-driver",
        exposedHostPorts: [8317, 3000],
      })._tag,
    ).toBe("Success");
    expect(
      decodeAccount({
        ...base,
        provider: "docker",
        exposedHostPorts: [70_000],
      })._tag,
    ).toBe("Failure");
  });

  it("decodes SandboxLaunchInput with localCheckout and attachments", () => {
    const decodeLaunch = Schema.decodeUnknownExit(SandboxLaunchInput);
    const decoded = decodeLaunch({
      id: SandboxId.make("sbx_1"),
      accountId: SandboxAccountId.make("acc-1"),
      title: "Fix tests",
      message: "Run tests with my uncommitted fix",
      source: {
        remoteUrl: SandboxRemoteUrl.make("https://github.com/pingdotgg/t3code.git"),
        base: { _tag: "default" },
      },
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "default",
      localCheckout: { cwd: "/tmp/repo", includeUncommitted: true },
      attachments: [
        {
          id: "att-1",
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 128,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
    });
    expect(decoded._tag).toBe("Success");
  });
});
