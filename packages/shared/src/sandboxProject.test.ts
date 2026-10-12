import { SandboxAccountId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSandboxProjectDefaults, sandboxProjectKey } from "./sandboxProject.ts";

const account = { size: "small" as const, stopAfterHours: 2 };

describe("sandbox project defaults", () => {
  it("shares a repository binding across SSH and HTTPS without crossing accounts", () => {
    const personal = SandboxAccountId.make("personal");
    const work = SandboxAccountId.make("work");
    const key = sandboxProjectKey(personal, "https://github.com/chhoumann/quickadd.git");
    expect(sandboxProjectKey(personal, "git@github.com:chhoumann/quickadd.git")).toBe(key);
    expect(sandboxProjectKey(work, "https://github.com/chhoumann/quickadd.git")).not.toBe(key);
  });

  it("inherits account defaults while allowing an explicit unlimited lifetime", () => {
    expect(resolveSandboxProjectDefaults(account, undefined)).toEqual({
      template: null,
      size: "small",
      stopAfterHours: 2,
    });
    expect(
      resolveSandboxProjectDefaults(account, { template: "quickadd", stopAfterHours: null }),
    ).toEqual({
      template: "quickadd",
      size: "small",
      stopAfterHours: null,
    });
  });
});
