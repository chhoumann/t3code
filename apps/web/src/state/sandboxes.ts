import { createSandboxAtoms, wakesForWork } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const sandboxes = createSandboxAtoms(connectionAtomRuntime);

/** Whether this client may send work to an environment's threads (`canSendWorkAtom`). */
export function readCanSendWork(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(sandboxes.canSendWorkAtom(environmentId));
}

/** A sandbox whose machine sleeps, so work sent to it wakes it first. */
export function sandboxSleeps(environmentId: EnvironmentId): boolean {
  const sandbox = appAtomRegistry.get(sandboxes.indexAtom).get(environmentId);
  return sandbox !== undefined && wakesForWork(sandbox.view);
}
