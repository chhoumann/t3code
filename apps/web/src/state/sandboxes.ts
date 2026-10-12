import { createSandboxAtoms, wakesForWork } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "./shell";

export const sandboxes = createSandboxAtoms(connectionAtomRuntime);

/** This device's shell of an environment; null when it never registered it. */
const shellStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): EnvironmentShellStatus | null =>
    get(environmentCatalog.catalogValueAtom).entries.has(environmentId)
      ? get(environmentShell.stateValueAtom(environmentId)).status
      : null,
  ).pipe(Atom.withLabel(`sandboxes:shell-status:${environmentId}`)),
);

/**
 * This device's shell of each sandbox environment, which says whether it has
 * loaded that environment's threads (`sandboxLaunchAction`).
 */
export const sandboxShellsAtom = Atom.make((get) => {
  const shells = new Map<EnvironmentId, EnvironmentShellStatus | null>();
  for (const environmentId of get(sandboxes.indexAtom).keys()) {
    shells.set(environmentId, get(shellStatusAtom(environmentId)));
  }
  return shells;
}).pipe(Atom.withLabel("sandboxes:shells"));

/** Whether this client may send work to an environment's threads (`canSendWorkAtom`). */
export function readCanSendWork(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(sandboxes.canSendWorkAtom(environmentId));
}

/** A sandbox whose machine sleeps, so work sent to it wakes it first. */
export function sandboxSleeps(environmentId: EnvironmentId): boolean {
  const sandbox = appAtomRegistry.get(sandboxes.indexAtom).get(environmentId);
  return sandbox !== undefined && wakesForWork(sandbox.view);
}
