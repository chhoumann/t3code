import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { sandboxCommandFailure } from "@t3tools/client-runtime/state/sandboxes";
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  SandboxLaunchInput,
  SandboxSource,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { type SandboxDraftTarget, useSandboxDraftStore } from "../sandboxDraftStore";
import { markPendingSandboxLaunch, sandboxes } from "../state/sandboxes";
import { useAtomCommand } from "../state/use-atom-command";

export interface SandboxLaunchRequest {
  readonly draftId: DraftId;
  readonly target: SandboxDraftTarget;
  readonly message: string;
  readonly source: SandboxSource;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly localCheckout?: SandboxLaunchInput["localCheckout"];
  readonly attachments?: SandboxLaunchInput["attachments"];
  readonly context?: SandboxLaunchInput["context"];
}

/**
 * Launches a draft's new sandbox and opens its thread immediately at `/_env/<environmentId>`.
 */
export function useSandboxLaunch() {
  const gt = useGT();
  const navigate = useNavigate();
  const launch = useAtomCommand(sandboxes.launch, { reportFailure: false });

  return async (request: SandboxLaunchRequest): Promise<string | null> => {
    const { target } = request;
    const result = await launch({
      environmentId: target.ownerEnvironmentId,
      input: {
        id: target.sandboxId,
        accountId: target.accountId,
        title: deriveThreadTitleSeed({ text: request.message, attachments: [] }),
        message: request.message,
        source: request.source,
        driver: request.driver,
        model: request.model,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        ...(request.localCheckout === undefined ? {} : { localCheckout: request.localCheckout }),
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        ...(request.context === undefined ? {} : { context: request.context }),
      },
    });
    if (result._tag !== "Success") return sandboxCommandFailure(result);
    if (result.value.environmentId === null) {
      return gt("Sandbox environment was not assigned.");
    }
    markPendingSandboxLaunch(result.value.environmentId);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: result.value.environmentId, threadId: result.value.threadId },
      replace: true,
    });
    useComposerDraftStore.getState().clearDraftThread(request.draftId);
    useSandboxDraftStore.getState().clear(request.draftId);
    return null;
  };
}
