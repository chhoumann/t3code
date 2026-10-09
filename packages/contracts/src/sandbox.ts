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
