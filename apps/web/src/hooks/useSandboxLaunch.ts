import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { sandboxCommandFailure } from "@t3tools/client-runtime/state/sandboxes";
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  RepositoryIdentity,
  RuntimeMode,
} from "@t3tools/contracts";
import { sandboxSourceForProject } from "@t3tools/shared/sandboxProject";
import { useNavigate } from "@tanstack/react-router";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { type SandboxDraftTarget, useSandboxDraftStore } from "../sandboxDraftStore";
import { sandboxes } from "../state/sandboxes";
import { useAtomCommand } from "../state/use-atom-command";

export interface SandboxLaunchRequest {
  readonly draftId: DraftId;
  readonly target: SandboxDraftTarget;
  readonly message: string;
  /** Attachments and context the composer holds besides the message. */
  readonly extrasCount: number;
  /** The draft's project, whose remote the sandbox clones. */
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Launches a draft's new sandbox and opens it in place of the draft. The
 * sandbox clones the project's remote at its default branch and starts its
 * own thread from the message, so nothing local travels. Resolves with the
 * reason it did not launch, or null.
 */
export function useSandboxLaunch() {
  const navigate = useNavigate();
  const launch = useAtomCommand(sandboxes.launch, { reportFailure: false });

  return async (request: SandboxLaunchRequest): Promise<string | null> => {
    if (request.extrasCount > 0) {
      return "A sandbox starts from your message alone. Remove attachments and context to start one.";
    }
    const source = sandboxSourceForProject(request.repositoryIdentity);
    if (source === null) {
      return "A sandbox clones the project from its remote repository. Add one to start a sandbox.";
    }
    const { target } = request;
    const result = await launch({
      environmentId: target.ownerEnvironmentId,
      input: {
        id: target.sandboxId,
        accountId: target.accountId,
        title: deriveThreadTitleSeed({ text: request.message, attachments: [] }),
        message: request.message,
        source,
        driver: request.driver,
        model: request.model,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
      },
    });
    if (result._tag !== "Success") return sandboxCommandFailure(result);
    await navigate({
      to: "/sandbox/$environmentId/$sandboxId",
      params: { environmentId: target.ownerEnvironmentId, sandboxId: target.sandboxId },
      replace: true,
    });
    useComposerDraftStore.getState().clearDraftThread(request.draftId);
    useSandboxDraftStore.getState().clear(request.draftId);
    return null;
  };
}
