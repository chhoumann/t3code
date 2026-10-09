/**
 * SandboxAccounts - the configured accounts sandboxes are created under, such
 * as a personal and a work Boat account. Every lifecycle call reads its
 * sandbox's own account, so credentials never cross accounts.
 *
 * @module SandboxAccounts
 */
import type { SandboxAccountId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { ProviderMachineSize, SandboxProviderAccount } from "./SandboxProvider.ts";

export interface SandboxAccount extends SandboxProviderAccount {
  readonly id: SandboxAccountId;
  readonly provider: "boat";
  /**
   * Written to the machine's env file on every boot and loaded by T3 and the
   * machine setup. An empty value is kept: `ANTHROPIC_API_KEY=""` matters.
   */
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>;
  /** Run on every boot before T3 starts, with the env loaded. Must be idempotent. */
  readonly machineSetupScript: string | null;
  /** A provider named snapshot to create machines from. */
  readonly template: string | null;
  /** A provider secret bundle. Null creates machines with no provider-side secrets. */
  readonly providerEnvironment: string | null;
  readonly size: ProviderMachineSize;
  /** Null never stops a machine on its own. */
  readonly stopAfterHours: number | null;
}

export class SandboxAccountNotFoundError extends Schema.TaggedError<SandboxAccountNotFoundError>()(
  "SandboxAccountNotFoundError",
  { accountId: Schema.String },
) {
  override get message(): string {
    return "The sandbox account is not configured.";
  }
}

export class SandboxAccounts extends Context.Service<
  SandboxAccounts,
  {
    readonly get: (
      accountId: SandboxAccountId,
    ) => Effect.Effect<SandboxAccount, SandboxAccountNotFoundError>;
  }
>()("t3/sandbox/SandboxAccounts") {}

/** Accounts fixed at construction, for the tracer and tests. */
export const layerStatic = (accounts: ReadonlyArray<SandboxAccount>) =>
  Layer.succeed(
    SandboxAccounts,
    SandboxAccounts.of({
      get: (accountId) => {
        const account = accounts.find((candidate) => candidate.id === accountId);
        return account === undefined
          ? Effect.fail(new SandboxAccountNotFoundError({ accountId }))
          : Effect.succeed(account);
      },
    }),
  );
