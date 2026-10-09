import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  SANDBOX_REPOSITORY_PROBLEM_MESSAGE,
  sandboxFailureMessage,
  sandboxRepositoryFor,
} from "@t3tools/client-runtime/state/sandboxes";
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

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
  readonly remoteUrl: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Launches a draft's new sandbox and opens it in place of the draft. The
 * sandbox clones the pushed commit and starts its own thread from the
 * message, so nothing local travels. Resolves with the reason it did not
 * launch, or null.
 */
export function useSandboxLaunch() {
  const navigate = useNavigate();
  const launch = useAtomCommand(sandboxes.launch, { reportFailure: false });

  return useCallback(
    async (request: SandboxLaunchRequest): Promise<string | null> => {
      if (request.extrasCount > 0) {
        return "A sandbox starts from your message alone. Remove attachments and context to start one.";
      }
      const repository = sandboxRepositoryFor({
        remoteUrl: request.remoteUrl,
        status: request.gitStatus,
      });
      if (repository._tag === "Refused") {
        return SANDBOX_REPOSITORY_PROBLEM_MESSAGE[repository.problem];
      }
      const { target } = request;
      const result = await launch({
        environmentId: target.ownerEnvironmentId,
        input: {
          id: target.sandboxId,
          accountId: target.accountId,
          title: deriveThreadTitleSeed({ text: request.message, attachments: [] }),
          message: request.message,
          repository: repository.repository,
          driver: request.driver,
          model: request.model,
          runtimeMode: request.runtimeMode,
          interactionMode: request.interactionMode,
        },
      });
      if (result._tag !== "Success") {
        return isAtomCommandInterrupted(result)
          ? null
          : sandboxFailureMessage(squashAtomCommandFailure(result));
      }
      await navigate({
        to: "/sandbox/$environmentId/$sandboxId",
        params: { environmentId: target.ownerEnvironmentId, sandboxId: target.sandboxId },
        replace: true,
      });
      useComposerDraftStore.getState().clearDraftThread(request.draftId);
      useSandboxDraftStore.getState().clear(request.draftId);
      return null;
    },
    [launch, navigate],
  );
}
