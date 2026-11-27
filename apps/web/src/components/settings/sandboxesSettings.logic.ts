import {
  type SandboxAccountConfig,
  type SandboxAccountId,
  type SandboxAccountSaveInput,
  SandboxEnvName,
  SandboxExposedPort,
  type SandboxMachineSize,
  type SandboxProviderKind,
  isSandboxStopAfterHours,
  SANDBOX_MAX_STOP_AFTER_HOURS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const SANDBOX_SIZE_LABELS: Record<SandboxMachineSize, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  xlarge: "Extra large",
};

export const SANDBOX_PROVIDER_LABELS: Record<SandboxProviderKind, string> = {
  docker: "Local Docker",
  command: "Custom Command",
  boat: "Boat",
};

export const SANDBOX_PROVIDERS: ReadonlyArray<SandboxProviderKind> = ["docker", "command", "boat"];

export interface SandboxEnvDraft {
  /** Stable row key; names can be edited. */
  readonly key: string;
  readonly name: string;
  /** Empty keeps a saved value. */
  readonly value: string;
  /** The name the account stores a value under, while this row still uses it. */
  readonly savedName: string | null;
  readonly setupOnly: boolean;
}

export interface SandboxAccountDraft {
  readonly label: string;
  readonly provider: SandboxProviderKind;
  /** Empty keeps a saved key. */
  readonly apiKey: string;
  readonly dockerImage: string;
  readonly commandProgram: string;
  readonly exposedHostPorts: string;
  readonly size: SandboxMachineSize;
  /** Empty never stops a machine on its own. */
  readonly stopAfterHours: string;
  readonly providerEnvironment: string;
  readonly machineSetupScript: string;
  readonly env: ReadonlyArray<SandboxEnvDraft>;
}

export function sandboxAccountDraft(
  account: SandboxAccountConfig | null,
  makeKey: () => string,
): SandboxAccountDraft {
  return {
    label: account?.label ?? "",
    provider: account?.provider ?? "docker",
    apiKey: "",
    dockerImage: account?.dockerImage ?? "",
    commandProgram: account?.commandProgram ?? "",
    exposedHostPorts: (account?.exposedHostPorts ?? []).join(", "),
    size: account?.size ?? "small",
    stopAfterHours:
      account === null ? "8" : account.stopAfterHours === null ? "" : `${account.stopAfterHours}`,
    providerEnvironment: account?.providerEnvironment ?? "",
    machineSetupScript: account?.machineSetupScript ?? "",
    env: (account?.env ?? []).map((entry) => ({
      key: makeKey(),
      name: entry.name,
      value: "",
      savedName: entry.name,
      setupOnly: entry.setupOnly,
    })),
  };
}

const nullIfBlank = (value: string) => (value.trim().length === 0 ? null : value.trim());
const isEnvName = Schema.is(SandboxEnvName);
const isExposedPort = Schema.is(SandboxExposedPort);

/**
 * The save request for a draft, or what is wrong with it. A saved env value
 * or key left blank is kept; a new env value may be empty on purpose.
 */
export function sandboxAccountSaveInput(
  id: SandboxAccountId,
  draft: SandboxAccountDraft,
  resolve: MessageResolver = m,
):
  | { readonly _tag: "Ready"; readonly input: SandboxAccountSaveInput }
  | { readonly _tag: "Invalid"; readonly message: string } {
  const label = draft.label.trim();
  if (label.length === 0)
    return { _tag: "Invalid", message: resolve(msg("Give the account a label.")) };
  const hours = draft.stopAfterHours.trim();
  const stopAfterHours = hours.length === 0 ? null : Number(hours);
  if (stopAfterHours !== null && !isSandboxStopAfterHours(stopAfterHours)) {
    return {
      _tag: "Invalid",
      message: resolve(
        msg("Stop after inactivity must be above zero and at most {maxHours} hours.", {
          maxHours: SANDBOX_MAX_STOP_AFTER_HOURS,
        }),
      ),
    };
  }
  const exposedHostPorts: Array<SandboxExposedPort> = [];
  for (const token of draft.exposedHostPorts.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    if (!/^\d+$/.test(trimmed)) {
      return {
        _tag: "Invalid",
        message: resolve(msg("Exposed host ports must be integers between 1 and 65535.")),
      };
    }
    const parsedPort = Number(trimmed);
    if (!isExposedPort(parsedPort)) {
      return {
        _tag: "Invalid",
        message: resolve(msg("Exposed host ports must be integers between 1 and 65535.")),
      };
    }
    if (!exposedHostPorts.includes(parsedPort)) {
      exposedHostPorts.push(parsedPort);
    }
  }
  const badName = draft.env.find((entry) => !isEnvName(entry.name.trim()));
  if (badName !== undefined) {
    return {
      _tag: "Invalid",
      message: resolve(
        msg(
          "{name} is not a valid env variable name. Use letters, digits, and underscores, not starting with a digit.",
          { name: badName.name.trim() || resolve(msg("An env variable")) },
        ),
      ),
    };
  }
  const apiKey = draft.apiKey.trim();
  const dockerImage = draft.provider === "docker" ? nullIfBlank(draft.dockerImage) : null;
  const commandProgram = draft.provider === "command" ? nullIfBlank(draft.commandProgram) : null;
  return {
    _tag: "Ready",
    input: {
      id,
      label,
      provider: draft.provider,
      dockerImage,
      commandProgram,
      exposedHostPorts,
      providerEnvironment: nullIfBlank(draft.providerEnvironment),
      size: draft.size,
      stopAfterHours,
      machineSetupScript:
        draft.machineSetupScript.trim().length === 0 ? null : draft.machineSetupScript,
      ...(apiKey.length === 0 ? {} : { apiKey }),
      env: draft.env.map((entry) => {
        const name = entry.name.trim();
        const keepsSaved = entry.savedName === name && entry.value.length === 0;
        return { name, ...(keepsSaved ? {} : { value: entry.value }), setupOnly: entry.setupOnly };
      }),
    },
  };
}
