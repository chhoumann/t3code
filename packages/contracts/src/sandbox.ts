import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Client-generated per draft, so a retried launch finds the same sandbox. It
 * also names the sandbox's secrets and keys its provider requests, hence the
 * narrow alphabet.
 */
export const SandboxId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/),
).pipe(Schema.brand("SandboxId"));
export type SandboxId = typeof SandboxId.Type;

export const SandboxAccountId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxAccountId"));
export type SandboxAccountId = typeof SandboxAccountId.Type;

/** What the user asked for. Every sandbox action is a change of this value. */
export const SandboxDesired = Schema.Literals(["running", "stopped", "destroyed"]);
export type SandboxDesired = typeof SandboxDesired.Type;

export const SandboxStoppedReason = Schema.Literals([
  /** Stopped because the user asked. */
  "requested",
  /** The provider stopped it when its run time ran out. */
  "expired",
  /** Stopped outside T3 before its run time ran out. */
  "external",
]);
export type SandboxStoppedReason = typeof SandboxStoppedReason.Type;

export const SandboxFailedStep = Schema.Literals([
  "create",
  "boot",
  "launch",
  "stop",
  "resume",
  "destroy",
  "observe",
]);
export type SandboxFailedStep = typeof SandboxFailedStep.Type;

export const SandboxStatus = Schema.Union([
  Schema.TaggedStruct("creating", {}),
  Schema.TaggedStruct("booting", {}),
  Schema.TaggedStruct("launching", {}),
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("stopping", {}),
  Schema.TaggedStruct("stopped", { reason: SandboxStoppedReason }),
  Schema.TaggedStruct("resuming", {}),
  Schema.TaggedStruct("destroying", {}),
  Schema.TaggedStruct("destroyed", {}),
  Schema.TaggedStruct("failed", {
    step: SandboxFailedStep,
    message: Schema.String,
    /** Whether asking for the same desired state again can make progress. */
    retryable: Schema.Boolean,
  }),
]);
export type SandboxStatus = typeof SandboxStatus.Type;

export const SandboxRepository = Schema.Struct({
  remoteUrl: TrimmedNonEmptyString,
  /** Checked out after cloning; null keeps the remote's default branch. */
  commit: Schema.NullOr(TrimmedNonEmptyString),
});
export type SandboxRepository = typeof SandboxRepository.Type;

export const SandboxLaunchInput = Schema.Struct({
  id: SandboxId,
  accountId: SandboxAccountId,
  title: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  repository: SandboxRepository,
  /** The guest resolves its own provider instance for this driver. */
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type SandboxLaunchInput = typeof SandboxLaunchInput.Type;

export const SandboxMachineSize = Schema.Literals(["small", "default", "large", "xlarge"]);
export type SandboxMachineSize = typeof SandboxMachineSize.Type;

/** A shell identifier, since the machine's env file is sourced by bash and systemd. */
export const SandboxEnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export type SandboxEnvName = typeof SandboxEnvName.Type;

const SandboxAccountFields = {
  label: TrimmedNonEmptyString,
  provider: Schema.Literal("boat"),
  /** A provider named snapshot machines start from. */
  template: Schema.NullOr(TrimmedNonEmptyString),
  /** A provider secret bundle; null creates machines with no provider-side secrets. */
  providerEnvironment: Schema.NullOr(TrimmedNonEmptyString),
  size: SandboxMachineSize,
  /** Null never stops a machine on its own. */
  stopAfterHours: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Run on every boot before T3 starts, with the account env loaded. Must be idempotent. */
  machineSetupScript: Schema.NullOr(Schema.String),
};

/**
 * One sandbox account in the owner's server settings. Its API key and env
 * values live only in the owner's secret store, so this is safe to show any
 * client: a listed env name always has a value.
 */
export const SandboxAccountConfig = Schema.Struct({
  ...SandboxAccountFields,
  envNames: Schema.Array(SandboxEnvName),
});
export type SandboxAccountConfig = typeof SandboxAccountConfig.Type;

export const SandboxAccountSaveInput = Schema.Struct({
  id: SandboxAccountId,
  ...SandboxAccountFields,
  /** Omitted keeps the saved key; a new account needs one. */
  apiKey: Schema.optionalKey(TrimmedNonEmptyString),
  /** The account's whole env. An entry without a value keeps its saved value; empty is a value. */
  env: Schema.Array(
    Schema.Struct({ name: SandboxEnvName, value: Schema.optionalKey(Schema.String) }),
  ),
});
export type SandboxAccountSaveInput = typeof SandboxAccountSaveInput.Type;

export const SandboxAccountRemoveInput = Schema.Struct({ id: SandboxAccountId });
export type SandboxAccountRemoveInput = typeof SandboxAccountRemoveInput.Type;

export const SandboxUpdateInput = Schema.Struct({ id: SandboxId, desired: SandboxDesired });
export type SandboxUpdateInput = typeof SandboxUpdateInput.Type;

export const SandboxConnectInput = Schema.Struct({ id: SandboxId });
export type SandboxConnectInput = typeof SandboxConnectInput.Type;

/** What a client needs to pair itself with a ready sandbox's T3 server. */
export const SandboxConnectResult = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: TrimmedNonEmptyString,
  /** A one-time grant, no wider than the caller's own session on the owner. */
  pairingCredential: TrimmedNonEmptyString,
});
export type SandboxConnectResult = typeof SandboxConnectResult.Type;

export const SandboxErrorCode = Schema.Literals([
  "not-found",
  "destroyed",
  "not-ready",
  "account-not-found",
  "account-in-use",
  "account-invalid",
  /** The account's API key lacks provider actions sandboxes need; see `missingActions`. */
  "key-missing-actions",
  "provider",
  "unavailable",
]);
export type SandboxErrorCode = typeof SandboxErrorCode.Type;

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  code: SandboxErrorCode,
  message: Schema.String,
  /** The provider's own action names, as its API key settings list them. */
  missingActions: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export const SandboxView = Schema.Struct({
  id: SandboxId,
  accountId: SandboxAccountId,
  title: Schema.String,
  repository: SandboxRepository,
  status: SandboxStatus,
  /** Known once the sandbox's T3 server has answered for the first time. */
  environmentId: Schema.NullOr(EnvironmentId),
  httpBaseUrl: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type SandboxView = typeof SandboxView.Type;
