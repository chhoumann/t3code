import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sandboxFailureMessage } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxDesired, SandboxId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { sandboxes } from "../state/sandboxes";
import { useAtomCommand } from "../state/use-atom-command";

export interface SandboxRef {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly title: string;
}

const DESIRED_FAILURE_TITLE: Record<SandboxDesired, string> = {
  running: "Could not resume the sandbox",
  stopped: "Could not stop the sandbox",
  destroyed: "Could not delete the sandbox",
};

/** Stop, resume, and delete, run on the environment that owns the sandbox. */
export function useSandboxActions() {
  const update = useAtomCommand(sandboxes.update, { reportFailure: false });

  const setDesired = useCallback(
    async (sandbox: SandboxRef, desired: SandboxDesired): Promise<boolean> => {
      const result = await update({
        environmentId: sandbox.ownerEnvironmentId,
        input: { id: sandbox.sandboxId, desired },
      });
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: DESIRED_FAILURE_TITLE[desired],
            description: sandboxFailureMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    },
    [update],
  );

  const confirmAndDelete = useCallback(
    async (sandbox: SandboxRef): Promise<boolean> => {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        [
          `Delete sandbox "${sandbox.title}"?`,
          "This destroys its machine and everything on it, including its threads.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (confirmed !== true) return false;
      return setDesired(sandbox, "destroyed");
    },
    [setDesired],
  );

  return { setDesired, confirmAndDelete };
}
