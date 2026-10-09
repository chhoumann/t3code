import {
  type SandboxAccountConfig,
  type SandboxAccountId,
  type SandboxAccountSaveInput,
  SandboxEnvName,
  type SandboxMachineSize,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SANDBOX_SIZE_LABELS: Record<SandboxMachineSize, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  xlarge: "Extra large",
};

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
  /** Empty keeps a saved key. */
  readonly apiKey: string;
  readonly size: SandboxMachineSize;
  /** Empty never stops a machine on its own. */
  readonly stopAfterHours: string;
  readonly template: string;
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
    apiKey: "",
    size: account?.size ?? "small",
    stopAfterHours:
      account === null ? "8" : account.stopAfterHours === null ? "" : `${account.stopAfterHours}`,
    template: account?.template ?? "",
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

/**
 * The save request for a draft, or what is wrong with it. A saved env value
 * or key left blank is kept; a new env value may be empty on purpose.
 */
export function sandboxAccountSaveInput(
  id: SandboxAccountId,
  draft: SandboxAccountDraft,
):
  | { readonly _tag: "Ready"; readonly input: SandboxAccountSaveInput }
  | { readonly _tag: "Invalid"; readonly message: string } {
  const label = draft.label.trim();
  if (label.length === 0) return { _tag: "Invalid", message: "Give the account a label." };
  const hours = draft.stopAfterHours.trim();
  const stopAfterHours = hours.length === 0 ? null : Number(hours);
  if (stopAfterHours !== null && !(Number.isFinite(stopAfterHours) && stopAfterHours > 0)) {
    return { _tag: "Invalid", message: "Stop after must be a number of hours above zero." };
  }
  const badName = draft.env.find((entry) => !isEnvName(entry.name.trim()));
  if (badName !== undefined) {
    return {
      _tag: "Invalid",
      message: `${badName.name.trim() || "An env variable"} is not a valid env variable name. Use letters, digits, and underscores, not starting with a digit.`,
    };
  }
  const apiKey = draft.apiKey.trim();
  return {
    _tag: "Ready",
    input: {
      id,
      label,
      provider: "boat",
      template: nullIfBlank(draft.template),
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
