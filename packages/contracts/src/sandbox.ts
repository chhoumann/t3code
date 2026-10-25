import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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

/**
 * The HTTPS clone URL of the repository a sandbox works on, with no
 * credentials in it. HTTPS only: the guest's one git credential is the GitHub
 * CLI's HTTPS helper, so clients rewrite SSH before sending.
 */
export const SandboxRemoteUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    // Host, then at least an owner and a repository.
    (value: string) => /^https:\/\/[^@/\s?#]+\/[^/\s?#]+\/[^\s?#]+$/.test(value),
    { expected: "an https clone URL naming an owner and a repository, without credentials" },
  ),
).pipe(Schema.brand("SandboxRemoteUrl"));
export type SandboxRemoteUrl = typeof SandboxRemoteUrl.Type;

/** `git check-ref-format --branch`: a name under `refs/heads/`, with no revision syntax. */
function isGitBranchName(name: string): boolean {
  if (name.length === 0 || name === "HEAD" || name === "@" || name.startsWith("-")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("//") || name.includes("..") || name.includes("@{")) return false;
  // Control characters, space, and the characters git reserves for revision syntax.
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(char)) return false;
  }
  return name
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export const SandboxBranchName = TrimmedNonEmptyString.check(
  Schema.makeFilter(isGitBranchName, { expected: "a git branch name" }),
).pipe(Schema.brand("SandboxBranchName"));
export type SandboxBranchName = typeof SandboxBranchName.Type;

/** Where the sandbox's task branch starts: the remote's default branch, or a named remote branch. */
export const SandboxBase = Schema.Union([
  Schema.TaggedStruct("default", {}),
  Schema.TaggedStruct("branch", { name: SandboxBranchName }),
]);
export type SandboxBase = typeof SandboxBase.Type;

/** What a launch names. The owner never looks at a local checkout. */
export const SandboxSource = Schema.Struct({
  remoteUrl: SandboxRemoteUrl,
  base: SandboxBase,
});
export type SandboxSource = typeof SandboxSource.Type;

/** The remote branch and commit the guest pinned `SandboxSource.base` to. */
export const SandboxResolvedBase = Schema.Struct({
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type SandboxResolvedBase = typeof SandboxResolvedBase.Type;

export const SandboxLaunchInput = Schema.Struct({
  id: SandboxId,
  accountId: SandboxAccountId,
  title: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  source: SandboxSource,
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

/** The GitHub user who authorized the owner's App, as `GET /user` reports them. */
export const SandboxGitHubUser = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
export type SandboxGitHubUser = typeof SandboxGitHubUser.Type;

/**
 * The owner's GitHub App in its server settings. The App's client secret and
 * the App user's tokens live only in the owner's secret store, so this is safe
 * to show any client.
 */
export const SandboxGitHubAppConfig = Schema.Struct({
  appId: Schema.Int,
  slug: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  /** Where GitHub may send the browser after authorizing; fixed when the App was created. */
  callbackUrls: Schema.Array(TrimmedNonEmptyString),
  connection: Schema.Union([
    Schema.TaggedStruct("disconnected", {}),
    Schema.TaggedStruct("connected", { user: SandboxGitHubUser }),
    /** The refresh chain broke; nothing refreshes until the user authorizes again. */
    Schema.TaggedStruct("reauthorize", { user: SandboxGitHubUser }),
  ]),
});
export type SandboxGitHubAppConfig = typeof SandboxGitHubAppConfig.Type;

/**
 * The client route GitHub sends the browser to after creating, installing, or
 * authorizing the App. The route relays the query to the owner it names.
 */
export const sandboxGitHubCallbackPath = (environmentId: EnvironmentId): string =>
  `/settings/sandboxes/github/callback/${environmentId}`;

export const SandboxGitHubBeginInput = Schema.Struct({
  /** `register` creates the App, then installs it; `authorize` reconnects an existing App. */
  step: Schema.Literals(["register", "authorize"]),
  /** This client's `sandboxGitHubCallbackPath` as an absolute URL. */
  callbackUrl: TrimmedNonEmptyString,
});
export type SandboxGitHubBeginInput = typeof SandboxGitHubBeginInput.Type;

export const SandboxGitHubFlowStart = Schema.Union([
  /** POST `manifest` to `action` from the browser; GitHub creates the App and returns to the callback. */
  Schema.TaggedStruct("manifest", {
    state: TrimmedNonEmptyString,
    action: TrimmedNonEmptyString,
    manifest: Schema.String,
  }),
  /** Open `url`; GitHub asks the user to authorize and returns to the callback. */
  Schema.TaggedStruct("authorize", { state: TrimmedNonEmptyString, url: TrimmedNonEmptyString }),
]);
export type SandboxGitHubFlowStart = typeof SandboxGitHubFlowStart.Type;

/** What the callback route relays. The state is single-use and expires. */
export const SandboxGitHubCompleteInput = Schema.Struct({
  state: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
});
export type SandboxGitHubCompleteInput = typeof SandboxGitHubCompleteInput.Type;

export const SandboxGitHubFlowNext = Schema.Union([
  /** Open `url` to install the App on repositories; GitHub authorizes the user on the way back. */
  Schema.TaggedStruct("install", { url: TrimmedNonEmptyString }),
  Schema.TaggedStruct("connected", {}),
]);
export type SandboxGitHubFlowNext = typeof SandboxGitHubFlowNext.Type;

export const SandboxGitHubDisconnectInput = Schema.Struct({
  /** Also forget the App registration, so the next connect creates a new App. */
  forgetApp: Schema.Boolean,
});
export type SandboxGitHubDisconnectInput = typeof SandboxGitHubDisconnectInput.Type;

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
  /** GitHub refused or could not be reached; the message says which. */
  "github",
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
  source: SandboxSource,
  /** Null until the guest has cloned and pinned the base. */
  resolvedBase: Schema.NullOr(SandboxResolvedBase),
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
