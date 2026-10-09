/**
 * SandboxProvider - the provider-neutral seam for machines that run a T3
 * server. Implementations translate their native API into this model, so no
 * provider JSON reaches the sandbox lifecycle.
 *
 * Every call names the account it acts for. Two accounts of one provider are
 * two configs passed to the same layer, never two layers.
 *
 * @module SandboxProvider
 */
import type { SandboxMachineSize } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ProviderMachineId = Schema.String.pipe(Schema.brand("ProviderMachineId"));
export type ProviderMachineId = typeof ProviderMachineId.Type;

export type ProviderMachineState = "starting" | "running" | "stopping" | "stopped" | "failed";

/** Outcome of the create-time setup script; null when the machine has none. */
export type ProviderMachineSetup = "pending" | "running" | "done" | "failed" | null;

export interface ProviderMachine {
  readonly id: ProviderMachineId;
  readonly state: ProviderMachineState;
  readonly setup: ProviderMachineSetup;
}

export interface SandboxProviderAccount {
  readonly apiKey: Redacted.Redacted<string>;
}

export interface CreateMachineInput {
  /** Stable across retries of one logical create; the provider dedupes on it. */
  readonly idempotencyKey: string;
  readonly size: SandboxMachineSize;
  /** Null disables the provider's auto-stop. */
  readonly ttlSeconds: number | null;
  /** A provider named snapshot to start from. */
  readonly template: string | null;
  /** A provider secret bundle. Null creates the machine with no account secrets at all. */
  readonly providerEnvironment: string | null;
  readonly setupScript: string;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export const SandboxProviderOperation = Schema.Literals([
  "check-access",
  "create",
  "inspect",
  "exec",
  "writeFile",
  "host",
  "stop",
  "resume",
  "destroy",
]);
export type SandboxProviderOperation = typeof SandboxProviderOperation.Type;

export const SandboxProviderErrorKind = Schema.Literals([
  "unauthorized",
  "missing-scope",
  "limit",
  "not-found",
  "transient",
  "invalid",
]);
export type SandboxProviderErrorKind = typeof SandboxProviderErrorKind.Type;

const KIND_SUMMARY: Record<SandboxProviderErrorKind, string> = {
  unauthorized: "the API key was rejected",
  "missing-scope": "the API key is not allowed to do this",
  limit: "an account limit was reached",
  "not-found": "the machine does not exist",
  transient: "the provider is temporarily unavailable",
  invalid: "the provider rejected the request",
};

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    operation: SandboxProviderOperation,
    kind: SandboxProviderErrorKind,
    /** The provider's own error code, such as `limit_reached`. */
    code: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Int),
    /** The provider's own explanation, such as which plan limit refused the request. */
    providerMessage: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const code = this.code === undefined ? "" : ` (${this.code})`;
    const reason = this.providerMessage === undefined ? "" : ` ${this.providerMessage}`;
    return `Sandbox ${this.operation} failed: ${KIND_SUMMARY[this.kind]}${code}.${reason}`;
  }
}

export class SandboxProvider extends Context.Service<
  SandboxProvider,
  {
    /**
     * The provider actions sandboxes need that the account's key may not
     * take, in the provider's own names. Changes nothing on the account.
     */
    readonly checkAccess: (
      account: SandboxProviderAccount,
    ) => Effect.Effect<ReadonlyArray<string>, SandboxProviderError>;
    readonly create: (
      account: SandboxProviderAccount,
      input: CreateMachineInput,
    ) => Effect.Effect<ProviderMachine, SandboxProviderError>;
    /** Null when the machine no longer exists. */
    readonly inspect: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
    ) => Effect.Effect<ProviderMachine | null, SandboxProviderError>;
    readonly exec: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
      input: { readonly command: string; readonly timeoutSeconds: number },
    ) => Effect.Effect<ExecResult, SandboxProviderError>;
    readonly writeFile: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
      input: { readonly path: string; readonly content: Uint8Array },
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Exposes a machine port without a provider-side gate and returns its https base URL. */
    readonly host: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
      port: number,
    ) => Effect.Effect<string, SandboxProviderError>;
    readonly stop: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
    ) => Effect.Effect<void, SandboxProviderError>;
    readonly resume: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Succeeds when the machine is already gone. */
    readonly destroy: (
      account: SandboxProviderAccount,
      id: ProviderMachineId,
    ) => Effect.Effect<void, SandboxProviderError>;
  }
>()("t3/sandbox/SandboxProvider") {}
