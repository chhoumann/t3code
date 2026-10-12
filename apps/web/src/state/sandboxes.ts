import { createSandboxAtoms } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const sandboxes = createSandboxAtoms(connectionAtomRuntime);

/** Whether this client may send work to an environment's threads (`canSendWorkAtom`). */
export function readCanSendWork(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(sandboxes.canSendWorkAtom(environmentId));
}
