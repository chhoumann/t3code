import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { readCanSendWork } from "./sandboxes";
import { readEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const ORCHESTRATION_OPERATE_DENIED_MESSAGE =
  "This connection cannot change threads or projects.";

function useGuardedCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options: string | AtomCommandOptions | undefined,
  allowed: (environmentId: EnvironmentId) => boolean,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  const run = useAtomCommand(command, options);
  return useCallback(
    async (value: W): Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> => {
      if (!allowed(value.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
            }),
          ),
        );
      }
      return run(value);
    },
    [allowed, run],
  );
}

const readOperateScope = (environmentId: EnvironmentId) =>
  readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

/** Recheck the target grant for every step of a thread or project mutation. */
export function useOrchestrationCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  return useGuardedCommand(command, options, readOperateScope);
}

/**
 * `useOrchestrationCommand` for work sent to a thread, which wakes its
 * sandbox first when it sleeps. While it sleeps, its owner's grant is
 * checked instead (`canSendWorkAtom`).
 */
export function useWorkCommand<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>> {
  return useGuardedCommand(command, options, readCanSendWork);
}
