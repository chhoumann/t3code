import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  SandboxAccountId,
  SandboxBranchName,
  SandboxRemoteUrl,
} from "@t3tools/contracts";

import { DraftId } from "./composerDraftStore";
import { useSandboxDraftStore } from "./sandboxDraftStore";

describe("sandboxDraftStore", () => {
  it("lets a draft that named another repository follow its project again, keeping its base", () => {
    const draftId = DraftId.make("draft-1");
    const store = useSandboxDraftStore.getState();
    store.choose(draftId, EnvironmentId.make("owner"), SandboxAccountId.make("account"));
    const remoteUrl = SandboxRemoteUrl.make("https://github.com/acme/other.git");
    const base = { _tag: "branch", name: SandboxBranchName.make("dev") } as const;
    store.setSource(draftId, { remoteUrl, base });
    expect(useSandboxDraftStore.getState().targets[draftId]).toMatchObject({ remoteUrl, base });

    store.setSource(draftId, { remoteUrl: null });
    const target = useSandboxDraftStore.getState().targets[draftId]!;
    expect("remoteUrl" in target).toBe(false);
    expect(target.base).toEqual(base);
  });
});
