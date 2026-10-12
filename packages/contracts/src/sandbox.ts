import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { GitRemote } from "./git.ts";
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

export const SandboxStopReason = Schema.Literals([
  /** The user asked. */
  "requested",
  /** Its owner stopped it after its stop time passed with no agent activity. */
  "idle",
  /** Stopped by something other than its owner, such as the provider's own deadline. */
  "external",
]);
export type SandboxStopReason = typeof SandboxStopReason.Type;

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
  Schema.TaggedStruct("stopping", { reason: SandboxStopReason }),
  Schema.TaggedStruct("stopped", { reason: SandboxStopReason }),
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
  /**
   * The launching checkout's remotes that its repository identity reads, and
   * the one its branch tracks. The clone gets each under its name, so its
   * project has the checkout's repository identity.
   */
  remotes: Schema.NonEmptyArray(GitRemote),
  /**
   * The remote the launching branch tracks, which has `commit`. The clone is
   * made from it, and the sandbox's task branch pushes there.
   */
  trackedRemote: TrimmedNonEmptyString,
  /** Checked out after cloning; null keeps the tracked remote's default branch. */
  commit: Schema.NullOr(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(({ remotes, trackedRemote }) => {
    const names = new Set(remotes.map((remote) => remote.name));
    if (names.size < remotes.length) return "Each remote needs its own name.";
    return names.has(trackedRemote) || "The tracked remote must be one of the remotes.";
  }),
);
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

/** Boat keeps a machine at most 30 days past its last deadline extension. */
export const SANDBOX_MAX_STOP_AFTER_HOURS = 720;
export const SandboxStopAfterHours = Schema.Number.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(SANDBOX_MAX_STOP_AFTER_HOURS),
);
export const isSandboxStopAfterHours: (hours: number) => boolean = Schema.is(SandboxStopAfterHours);

export const SandboxProjectDefaults = Schema.Struct({
  template: Schema.NullOr(TrimmedNonEmptyString),
  /** Omitted inherits the account's default. */
  size: Schema.optionalKey(SandboxMachineSize),
  /** Hours without agent activity before the sandbox stops. Omitted inherits the account; null never stops it. */
  stopAfterHours: Schema.optionalKey(Schema.NullOr(SandboxStopAfterHours)),
});
export type SandboxProjectDefaults = typeof SandboxProjectDefaults.Type;

/** A shell identifier, since the machine's env file is sourced by bash and systemd. */
export const SandboxEnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export type SandboxEnvName = typeof SandboxEnvName.Type;

const SandboxAccountFields = {
  label: TrimmedNonEmptyString,
  provider: Schema.Literal("boat"),
  /** A provider secret bundle; null creates machines with no provider-side secrets. */
  providerEnvironment: Schema.NullOr(TrimmedNonEmptyString),
  size: SandboxMachineSize,
  /** Hours without agent activity before a machine stops; null never stops it. */
  stopAfterHours: Schema.NullOr(SandboxStopAfterHours),
  /** Run on every boot before T3 starts, with the account env loaded. Must be idempotent. */
  machineSetupScript: Schema.NullOr(Schema.String),
};

/**
 * Set on a value only the machine setup needs, such as a tailnet auth key. It
 * is loaded by the setup and never into T3's environment, so agents do not
 * inherit it. Not a hard boundary: the machine's user has passwordless sudo.
 */
const SandboxEnvSetupOnly = Schema.Boolean;

/**
 * One sandbox account in the owner's server settings. Its API key and env
 * values live only in the owner's secret store, so this is safe to show any
 * client: a listed env name always has a value.
 */
export const SandboxAccountConfig = Schema.Struct({
  ...SandboxAccountFields,
  env: Schema.Array(Schema.Struct({ name: SandboxEnvName, setupOnly: SandboxEnvSetupOnly })),
});
export type SandboxAccountConfig = typeof SandboxAccountConfig.Type;

export const SandboxAccountSaveInput = Schema.Struct({
  id: SandboxAccountId,
  ...SandboxAccountFields,
  /** Omitted keeps the saved key; a new account needs one. */
  apiKey: Schema.optionalKey(TrimmedNonEmptyString),
  /** The account's whole env. An entry without a value keeps its saved value; empty is a value. */
  env: Schema.Array(
    Schema.Struct({
      name: SandboxEnvName,
      value: Schema.optionalKey(Schema.String),
      /** Omitted is false. */
      setupOnly: Schema.optionalKey(SandboxEnvSetupOnly),
    }),
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

/**
 * A sandbox refused to archive its last active top-level thread, or to delete
 * the thread or project it was launched with, either of which would leave its
 * machine running unseen. The owner stops or destroys it.
 */
export class SandboxManagedByOwnerError extends Schema.TaggedError<SandboxManagedByOwnerError>()(
  "SandboxManagedByOwnerError",
  {
    ownerEnvironmentId: EnvironmentId,
    sandboxId: SandboxId,
    operation: Schema.Literals(["archive-thread", "delete-thread", "delete-project"]),
  },
) {
  override get message(): string {
    return "Only the environment that owns this sandbox can remove its last active thread. Stop or delete the sandbox there instead.";
  }
}

export const isSandboxManagedByOwnerError = Schema.is(SandboxManagedByOwnerError);

export const SandboxView = Schema.Struct({
  id: SandboxId,
  accountId: SandboxAccountId,
  title: Schema.String,
  /** The first message, which the seed thread starts with. */
  message: Schema.String,
  repository: SandboxRepository,
  /** The thread the sandbox starts with, in its own environment. */
  threadId: ThreadId,
  desired: SandboxDesired,
  /** Counts the changes of `desired`: each is a request the sandbox works toward. */
  revision: NonNegativeInt,
  status: SandboxStatus,
  /**
   * The latest `revision` whose outcome `status` shows. It trails `revision`
   * while a request is under way.
   */
  settledRevision: NonNegativeInt,
  /** Known once the sandbox's T3 server has answered for the first time. */
  environmentId: Schema.NullOr(EnvironmentId),
  httpBaseUrl: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type SandboxView = typeof SandboxView.Type;
