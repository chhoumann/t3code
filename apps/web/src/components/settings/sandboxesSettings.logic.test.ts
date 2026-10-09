import { SandboxAccountId, type SandboxAccountConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxAccountDraft, sandboxAccountSaveInput } from "./sandboxesSettings.logic";

const ID = SandboxAccountId.make("work");
let keys = 0;
const makeKey = () => `row-${keys++}`;

const saved: SandboxAccountConfig = {
  label: "Work",
  provider: "boat",
  template: null,
  providerEnvironment: null,
  size: "default",
  stopAfterHours: 4,
  machineSetupScript: "tailscale up",
  env: [
    { name: "ANTHROPIC_BASE_URL", setupOnly: false },
    { name: "TAILSCALE_AUTH_KEY", setupOnly: true },
  ],
};

const ready = (result: ReturnType<typeof sandboxAccountSaveInput>) => {
  if (result._tag !== "Ready") throw new Error(result.message);
  return result.input;
};

describe("sandboxAccountSaveInput", () => {
  it("keeps every saved secret an edit leaves blank", () => {
    const input = ready(sandboxAccountSaveInput(ID, sandboxAccountDraft(saved, makeKey)));
    expect(input).not.toHaveProperty("apiKey");
    expect(input.env).toEqual([
      { name: "ANTHROPIC_BASE_URL", setupOnly: false },
      { name: "TAILSCALE_AUTH_KEY", setupOnly: true },
    ]);
    expect(input).toMatchObject({ stopAfterHours: 4, machineSetupScript: "tailscale up" });
  });

  it("sends an empty value for a new variable and for a renamed one", () => {
    const draft = sandboxAccountDraft(saved, makeKey);
    const input = ready(
      sandboxAccountSaveInput(ID, {
        ...draft,
        apiKey: " bx_key ",
        env: [
          { ...draft.env[0]!, name: "ANTHROPIC_PROXY_URL" },
          { key: "new", name: "ANTHROPIC_API_KEY", value: "", savedName: null, setupOnly: false },
        ],
      }),
    );
    expect(input.apiKey).toBe("bx_key");
    expect(input.env).toEqual([
      { name: "ANTHROPIC_PROXY_URL", value: "", setupOnly: false },
      { name: "ANTHROPIC_API_KEY", value: "", setupOnly: false },
    ]);
  });

  it("reads blank optional fields as unset", () => {
    const input = ready(
      sandboxAccountSaveInput(ID, {
        ...sandboxAccountDraft(null, makeKey),
        label: "Personal",
        stopAfterHours: " ",
        template: "  ",
      }),
    );
    expect(input).toMatchObject({
      stopAfterHours: null,
      template: null,
      providerEnvironment: null,
      machineSetupScript: null,
    });
  });

  it.each([
    ["", "8", "Give the account a label."],
    ["Work", "0", "Stop after must be a number of hours above zero."],
    ["Work", "soon", "Stop after must be a number of hours above zero."],
  ])("refuses label %j with stop after %j", (label, stopAfterHours, message) => {
    expect(
      sandboxAccountSaveInput(ID, {
        ...sandboxAccountDraft(null, makeKey),
        label,
        stopAfterHours,
      }),
    ).toEqual({ _tag: "Invalid", message });
  });
});
