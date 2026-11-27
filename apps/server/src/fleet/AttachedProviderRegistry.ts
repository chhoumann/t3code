/**
 * Tracks live remote `t3 sandbox provider` daemons attached to the Hub over Mux.
 */
import type { SandboxAccountId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type AttachedProviderOp =
  | "check"
  | "spawn"
  | "inspect"
  | "exec"
  | "write_file"
  | "host"
  | "set_deadline"
  | "pause"
  | "resume"
  | "destroy";

export interface AttachedProviderHandler {
  readonly call: (
    op: AttachedProviderOp,
    payload: unknown,
  ) => Effect.Effect<unknown, AttachedProviderError>;
}

export class AttachedProviderError {
  readonly _tag = "AttachedProviderError";
  readonly kind: "transient" | "invalid" | "not-found" | "unsupported";
  readonly message: string;
  constructor(input: {
    readonly kind: "transient" | "invalid" | "not-found" | "unsupported";
    readonly message: string;
  }) {
    this.kind = input.kind;
    this.message = input.message;
  }
}

export class AttachedProviderRegistry extends Context.Service<
  AttachedProviderRegistry,
  {
    readonly register: (
      accountId: SandboxAccountId,
      handler: AttachedProviderHandler,
    ) => () => void;
    readonly get: (accountId: SandboxAccountId) => AttachedProviderHandler | undefined;
  }
>()("t3/fleet/AttachedProviderRegistry") {}

export const layer = Layer.sync(AttachedProviderRegistry, () => {
  const handlers = new Map<SandboxAccountId, AttachedProviderHandler>();
  return AttachedProviderRegistry.of({
    register: (accountId, handler) => {
      handlers.set(accountId, handler);
      return () => {
        if (handlers.get(accountId) === handler) {
          handlers.delete(accountId);
        }
      };
    },
    get: (accountId) => handlers.get(accountId),
  });
});
