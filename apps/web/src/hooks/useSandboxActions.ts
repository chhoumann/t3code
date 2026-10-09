import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sandboxFailureMessage } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxDesired, SandboxView } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { sandboxes } from "../state/sandboxes";
import { useAtomCommand } from "../state/use-atom-command";

/** A sandbox as its owner lists it. A sandbox index entry is one. */
export interface SandboxRef {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly view: SandboxView;
}

const DESIRED_FAILURE_TITLE: Record<SandboxDesired, string> = {
  running: "Could not resume the sandbox",
  stopped: "Could not stop the sandbox",
  destroyed: "Could not delete the sandbox",
};

/** Stop, resume, and delete, run on the environment that owns the sandbox. */
export function useSandboxActions() {
  const router = useRouter();
  const update = useAtomCommand(sandboxes.update, { reportFailure: false });

  const setDesired = useCallback(
    async (sandbox: SandboxRef, desired: SandboxDesired): Promise<boolean> => {
      const result = await update({
        environmentId: sandbox.ownerEnvironmentId,
        input: { id: sandbox.view.id, desired },
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
          `Delete sandbox "${sandbox.view.title}"?`,
          "This destroys its machine and everything on it, including its threads.",
        ].join("\n"),
        { variant: "destructive" },
      );
      if (confirmed !== true) return false;
      if (!(await setDesired(sandbox, "destroyed"))) return false;
      // The sandbox's threads go with it, so leave one that is open, or its launch view.
      const params = router.state.matches.at(-1)?.params as
        | { environmentId?: string; sandboxId?: string }
        | undefined;
      if (
        (sandbox.view.environmentId !== null &&
          params?.environmentId === sandbox.view.environmentId) ||
        params?.sandboxId === sandbox.view.id
      ) {
        await router.navigate({ to: "/", replace: true });
      }
      return true;
    },
    [router, setDesired],
  );

  return { setDesired, confirmAndDelete };
}
