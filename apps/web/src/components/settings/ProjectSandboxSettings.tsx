import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sandboxAccountChoices } from "@t3tools/client-runtime/state/sandboxes";
import {
  type EnvironmentId,
  type SandboxAccountConfig,
  type SandboxAccountId,
  type SandboxProjectDefaults,
  SandboxMachineSize,
  isSandboxStopAfterHours,
  SANDBOX_MAX_STOP_AFTER_HOURS,
} from "@t3tools/contracts";
import { sandboxProjectKey } from "@t3tools/shared/sandboxProject";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sandboxes } from "../../state/sandboxes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SANDBOX_SIZE_LABELS } from "./sandboxesSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isSize = Schema.is(SandboxMachineSize);

export function ProjectSandboxSettings({ repository }: { repository: string | null }) {
  const { environments } = useEnvironments();
  const choices = environments.flatMap((owner) =>
    sandboxAccountChoices(owner.environmentId, owner.serverConfig).map((account) => ({
      ...account,
      owner,
      key: `${owner.environmentId}:${account.accountId}`,
    })),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const choice =
    choices.find((candidate) => candidate.key === selected) ??
    choices.find(
      (candidate) =>
        repository !== null &&
        candidate.owner.serverConfig?.settings.sandboxProjectDefaults[
          sandboxProjectKey(candidate.accountId, repository)
        ] !== undefined,
    ) ??
    choices[0];
  if (repository === null || choice === undefined || choice.owner.serverConfig === null)
    return null;
  const account = choice.owner.serverConfig.settings.sandboxAccounts[choice.accountId];
  if (account === undefined) return null;
  const projectKey = sandboxProjectKey(choice.accountId, repository);
  const saved = choice.owner.serverConfig.settings.sandboxProjectDefaults[projectKey];
  return (
    <SettingsSection title="Sandboxes">
      <SettingsRow
        title="Account"
        control={
          <Select value={choice.key} onValueChange={setSelected}>
            <SelectTrigger size="sm" aria-label="Sandbox account">
              <SelectValue>
                {choice.label} · {choice.owner.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>
                  {entry.label} · {entry.owner.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <ProjectSandboxForm
        key={`${choice.key}:${projectKey}:${JSON.stringify(saved)}`}
        environmentId={choice.ownerEnvironmentId}
        accountId={choice.accountId}
        projectKey={projectKey}
        account={account}
        saved={saved}
        onSelectAccount={() => setSelected(choice.key)}
      />
    </SettingsSection>
  );
}

function ProjectSandboxForm({
  environmentId,
  accountId,
  projectKey,
  account,
  saved,
  onSelectAccount,
}: {
  environmentId: EnvironmentId;
  accountId: SandboxAccountId;
  projectKey: string;
  account: SandboxAccountConfig;
  saved: SandboxProjectDefaults | undefined;
  onSelectAccount: () => void;
}) {
  const templates = useEnvironmentQuery(
    sandboxes.templates({ environmentId, input: { accountId } }),
  );
  const [template, setTemplate] = useState(saved?.template ?? "");
  const [size, setSize] = useState(saved?.size ?? "account");
  const [stop, setStop] = useState(
    saved?.stopAfterHours === undefined
      ? "account"
      : saved.stopAfterHours === null
        ? "never"
        : "custom",
  );
  const [hours, setHours] = useState(
    saved?.stopAfterHours == null ? "2" : String(saved.stopAfterHours),
  );
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));

  const save = async (reset: boolean) => {
    onSelectAccount();
    const stopAfterHours = Number(hours);
    if (!reset && stop === "custom" && !isSandboxStopAfterHours(stopAfterHours)) {
      toastManager.add({
        type: "error",
        title: `Stop after inactivity must be above zero and at most ${SANDBOX_MAX_STOP_AFTER_HOURS} hours.`,
      });
      return;
    }
    setSaving(true);
    const result = await update({
      environmentId,
      input: {
        patch: {
          sandboxProjectDefaults: {
            [projectKey]: reset
              ? null
              : {
                  template: template.trim() || null,
                  ...(isSize(size) ? { size } : {}),
                  ...(stop === "account"
                    ? {}
                    : { stopAfterHours: stop === "never" ? null : stopAfterHours }),
                },
          },
        },
      },
    });
    setSaving(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Sandbox defaults not saved",
        description: error instanceof Error ? error.message : "Could not save sandbox defaults.",
      });
    }
  };

  return (
    <fieldset disabled={!allowed || saving}>
      <SettingsRow
        title="Template"
        control={
          <div className="flex items-center gap-2">
            <Select
              value={template}
              onValueChange={(value) => {
                if (value !== null) setTemplate(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Sandbox template"
                disabled={templates.isPending && templates.data === null}
              >
                <SelectValue>
                  {template || (templates.isPending ? "Loading templates…" : "None")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">None</SelectItem>
                {template && !templates.data?.includes(template) ? (
                  <SelectItem value={template} disabled>
                    {template} (unavailable)
                  </SelectItem>
                ) : null}
                {templates.data?.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              disabled={templates.isPending}
              onClick={templates.refresh}
            >
              Refresh
            </Button>
          </div>
        }
      />
      {templates.error !== null ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          Could not load templates: {templates.error}
        </p>
      ) : null}
      <SettingsRow
        title="Size"
        control={
          <Select
            value={size}
            onValueChange={(value) => {
              if (value !== null) setSize(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Sandbox size">
              <SelectValue>
                {isSize(size)
                  ? SANDBOX_SIZE_LABELS[size]
                  : `Account default · ${SANDBOX_SIZE_LABELS[account.size]}`}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="account">Account default</SelectItem>
              {SandboxMachineSize.literals.map((value) => (
                <SelectItem key={value} value={value}>
                  {SANDBOX_SIZE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Stop after inactivity"
        control={
          <div className="flex items-center gap-2">
            <Select
              value={stop}
              onValueChange={(value) => {
                if (value !== null) setStop(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="Sandbox stop after inactivity">
                <SelectValue>
                  {stop === "account"
                    ? `Account default · ${account.stopAfterHours === null ? "Never" : `${account.stopAfterHours}h`}`
                    : stop === "never"
                      ? "Never"
                      : "Custom"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="account">Account default</SelectItem>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectPopup>
            </Select>
            {stop === "custom" ? (
              <Input
                size="sm"
                type="number"
                min="0"
                step="any"
                aria-label="Sandbox stop after inactivity, in hours"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            ) : null}
          </div>
        }
      />
      <div className="flex justify-end gap-2 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={saved === undefined}
          onClick={() => void save(true)}
        >
          Reset
        </Button>
        <Button size="sm" onClick={() => void save(false)}>
          Save
        </Button>
      </div>
    </fieldset>
  );
}
