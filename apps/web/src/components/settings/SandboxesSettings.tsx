import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  SANDBOX_STATUS_LABEL,
  sandboxFailureMessage,
} from "@t3tools/client-runtime/state/sandboxes";
import {
  resolveEnvironmentMachineKind,
  SandboxAccountId,
  type EnvironmentId,
  type SandboxAccountConfig,
  type SandboxMachineSize,
  type SandboxView,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, EllipsisIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useSandboxActions } from "../../hooks/useSandboxActions";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import type { EnvironmentPresentation } from "../../state/environments";
import { sandboxes } from "../../state/sandboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SANDBOX_SIZE_LABELS,
  sandboxAccountDraft,
  sandboxAccountSaveInput,
  type SandboxAccountDraft,
  type SandboxEnvDraft,
} from "./sandboxesSettings.logic";

const SANDBOX_SIZES = Object.keys(SANDBOX_SIZE_LABELS) as SandboxMachineSize[];

interface AccountEditor {
  readonly environmentId: EnvironmentId;
  readonly accountId: SandboxAccountId | null;
}

export function SandboxesSettings() {
  const { environments } = useSettingsScope();
  const sandboxIndex = useAtomValue(sandboxes.indexAtom);
  // A sandbox runs T3 too, so it serves sandboxes; it is not where the user keeps accounts.
  const owners = environments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.sandboxes === true &&
      !sandboxIndex.has(environment.environmentId),
  );
  const [editor, setEditor] = useState<AccountEditor | null>(null);
  const defaultOwner = owners[0] ?? null;
  const canSave = useAtomValue(
    sandboxes.saveAccount.permissionAtom(defaultOwner?.environmentId ?? null),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("sandboxes").id}
        title="Sandboxes"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={defaultOwner === null || !canSave}
            onClick={() =>
              defaultOwner &&
              setEditor({ environmentId: defaultOwner.environmentId, accountId: null })
            }
          >
            <PlusIcon className="size-3" />
            New account
          </Button>
        }
      >
        {owners.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BoxIcon />
              </EmptyMedia>
              <EmptyTitle>No environment here can start sandboxes</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {owners.map((owner) => (
              <SandboxOwnerSection
                key={owner.environmentId}
                owner={owner}
                showHeading={owners.length > 1}
                onEdit={(accountId) => setEditor({ environmentId: owner.environmentId, accountId })}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {editor ? (
        <SandboxAccountDialog
          key={`${editor.environmentId}:${editor.accountId ?? "new"}`}
          owner={owners.find((owner) => owner.environmentId === editor.environmentId) ?? null}
          accountId={editor.accountId}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function accountSummary(account: SandboxAccountConfig): string {
  return [
    "Boat",
    SANDBOX_SIZE_LABELS[account.size],
    account.stopAfterHours === null ? "Never stops" : `Stops after ${account.stopAfterHours} h`,
  ].join(" · ");
}

function SandboxOwnerSection(props: {
  readonly owner: EnvironmentPresentation;
  readonly showHeading: boolean;
  readonly onEdit: (accountId: SandboxAccountId) => void;
}) {
  const { owner } = props;
  const accountsById = owner.serverConfig?.settings.sandboxAccounts ?? {};
  const accounts = Object.entries(accountsById).sort(([, left], [, right]) =>
    left.label.localeCompare(right.label),
  );
  const ownerSandboxes = useAtomValue(sandboxes.ownerSandboxesAtom(owner.environmentId)).filter(
    (sandbox) => sandbox.status._tag !== "destroyed",
  );
  const canSave = useAtomValue(sandboxes.saveAccount.permissionAtom(owner.environmentId));
  const removeAccount = useAtomCommand(sandboxes.removeAccount, { reportFailure: false });

  const remove = async (accountId: SandboxAccountId, account: SandboxAccountConfig) => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      `Remove sandbox account "${account.label}"?`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const result = await removeAccount({
      environmentId: owner.environmentId,
      input: { id: accountId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not remove ${account.label}`,
          description: sandboxFailureMessage(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        title={props.showHeading ? owner.label : "Accounts"}
        icon={
          props.showHeading ? (
            <EnvironmentMachineIcon
              kind={resolveEnvironmentMachineKind(owner.serverConfig)}
              className="size-3.5"
            />
          ) : undefined
        }
      >
        {accounts.length === 0 ? (
          <SettingsRow title="No accounts" />
        ) : (
          accounts.map(([id, account]) => {
            const accountId = SandboxAccountId.make(id);
            return (
              <SettingsRow
                key={accountId}
                title={account.label}
                description={accountSummary(account)}
                control={
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost-muted"
                          size="icon-xs"
                          disabled={!canSave}
                          aria-label={`More actions for ${account.label}`}
                        />
                      }
                    >
                      <EllipsisIcon className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => props.onEdit(accountId)}>Edit</MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() => void remove(accountId, account)}
                      >
                        Remove…
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                }
              />
            );
          })
        )}
      </SettingsSection>
      {ownerSandboxes.length > 0 ? (
        <SettingsSection title="Sandboxes">
          {ownerSandboxes.map((sandbox) => (
            <SandboxRow
              key={sandbox.id}
              ownerEnvironmentId={owner.environmentId}
              sandbox={sandbox}
              accountLabel={accountsById[sandbox.accountId]?.label ?? null}
            />
          ))}
        </SettingsSection>
      ) : null}
    </div>
  );
}

function SandboxRow(props: {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandbox: SandboxView;
  readonly accountLabel: string | null;
}) {
  const { sandbox } = props;
  const navigate = useNavigate();
  const { setDesired, confirmAndDelete } = useSandboxActions();
  const ref = {
    ownerEnvironmentId: props.ownerEnvironmentId,
    sandboxId: sandbox.id,
    title: sandbox.title,
  };
  const status = sandbox.status._tag;
  const open = () =>
    status === "ready" && sandbox.environmentId !== null
      ? navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: sandbox.environmentId, threadId: sandbox.threadId },
        })
      : navigate({
          to: "/sandbox/$environmentId/$sandboxId",
          params: { environmentId: props.ownerEnvironmentId, sandboxId: sandbox.id },
        });
  return (
    <SettingsRow
      title={sandbox.title}
      description={[SANDBOX_STATUS_LABEL[status], props.accountLabel]
        .filter((part): part is string => part !== null)
        .join(" · ")}
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                disabled={status === "destroying"}
                aria-label={`More actions for ${sandbox.title}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void open()}>Open</MenuItem>
            {status === "ready" ? (
              <MenuItem onClick={() => void setDesired(ref, "stopped")}>Stop</MenuItem>
            ) : null}
            {status === "stopped" ? (
              <MenuItem onClick={() => void setDesired(ref, "running")}>Resume</MenuItem>
            ) : null}
            {sandbox.status._tag === "failed" && sandbox.status.retryable ? (
              <MenuItem onClick={() => void setDesired(ref, sandbox.desired)}>Retry</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void confirmAndDelete(ref)}>
              Delete sandbox…
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    />
  );
}

function SandboxAccountDialog(props: {
  readonly owner: EnvironmentPresentation | null;
  readonly accountId: SandboxAccountId | null;
  readonly onClose: () => void;
}) {
  const saved =
    props.accountId === null
      ? null
      : (props.owner?.serverConfig?.settings.sandboxAccounts[props.accountId] ?? null);
  const [draft, setDraft] = useState<SandboxAccountDraft>(() =>
    sandboxAccountDraft(saved, randomUUID),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveAccount = useAtomCommand(sandboxes.saveAccount, { reportFailure: false });
  const update = (patch: Partial<SandboxAccountDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateEnv = (key: string, patch: Partial<SandboxEnvDraft>) =>
    setDraft((current) => ({
      ...current,
      env: current.env.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    }));

  const submit = async () => {
    if (props.owner === null) return;
    const request = sandboxAccountSaveInput(
      props.accountId ?? SandboxAccountId.make(randomUUID()),
      draft,
    );
    if (request._tag === "Invalid") {
      setError(request.message);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await saveAccount({
      environmentId: props.owner.environmentId,
      input: request.input,
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(sandboxFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{saved ? `Edit ${saved.label}` : "New sandbox account"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={saving} className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Label" htmlFor="sandbox-account-label">
                  <Input
                    id="sandbox-account-label"
                    value={draft.label}
                    placeholder="Work"
                    onChange={(event) => update({ label: event.target.value })}
                  />
                </Field>
                <Field label="Provider" htmlFor="sandbox-account-provider">
                  <Select value="boat" disabled>
                    <SelectTrigger id="sandbox-account-provider">
                      <SelectValue>Boat</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="boat">Boat</SelectItem>
                    </SelectPopup>
                  </Select>
                </Field>
              </div>
              <Field label="API key" htmlFor="sandbox-account-key">
                <Input
                  id="sandbox-account-key"
                  type="password"
                  autoComplete="off"
                  placeholder={saved ? "Set" : undefined}
                  value={draft.apiKey}
                  onChange={(event) => update({ apiKey: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Size" htmlFor="sandbox-account-size">
                  <Select
                    value={draft.size}
                    onValueChange={(size) => update({ size: size as SandboxMachineSize })}
                  >
                    <SelectTrigger id="sandbox-account-size">
                      <SelectValue>{SANDBOX_SIZE_LABELS[draft.size]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {SANDBOX_SIZES.map((size) => (
                        <SelectItem key={size} value={size}>
                          {SANDBOX_SIZE_LABELS[size]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field label="Stop after (hours)" htmlFor="sandbox-account-stop-after">
                  <Input
                    id="sandbox-account-stop-after"
                    inputMode="decimal"
                    placeholder="Never"
                    value={draft.stopAfterHours}
                    onChange={(event) => update({ stopAfterHours: event.target.value })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Template" htmlFor="sandbox-account-template">
                  <Input
                    id="sandbox-account-template"
                    placeholder="None"
                    value={draft.template}
                    onChange={(event) => update({ template: event.target.value })}
                  />
                </Field>
                <Field label="Provider environment" htmlFor="sandbox-account-provider-env">
                  <Input
                    id="sandbox-account-provider-env"
                    placeholder="None"
                    value={draft.providerEnvironment}
                    onChange={(event) => update({ providerEnvironment: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="Machine setup script" htmlFor="sandbox-account-setup">
                <Textarea
                  id="sandbox-account-setup"
                  spellCheck={false}
                  value={draft.machineSetupScript}
                  onChange={(event) => update({ machineSetupScript: event.target.value })}
                />
              </Field>
              <div className="grid gap-2">
                <Label>Environment variables</Label>
                {draft.env.map((entry) => (
                  <div key={entry.key} className="flex items-center gap-2">
                    <Input
                      aria-label="Name"
                      placeholder="NAME"
                      value={entry.name}
                      onChange={(event) => updateEnv(entry.key, { name: event.target.value })}
                    />
                    <Input
                      aria-label={`Value of ${entry.name || "variable"}`}
                      type="password"
                      autoComplete="off"
                      placeholder={entry.savedName === entry.name.trim() ? "Set" : "Value"}
                      value={entry.value}
                      onChange={(event) => updateEnv(entry.key, { value: event.target.value })}
                    />
                    <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
                      <Switch
                        size="sm"
                        checked={entry.setupOnly}
                        onCheckedChange={(setupOnly) => updateEnv(entry.key, { setupOnly })}
                      />
                      Setup only
                    </label>
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={`Remove ${entry.name || "variable"}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          env: current.env.filter((candidate) => candidate.key !== entry.key),
                        }))
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        env: [
                          ...current.env,
                          {
                            key: randomUUID(),
                            name: "",
                            value: "",
                            savedName: null,
                            setupOnly: false,
                          },
                        ],
                      }))
                    }
                  >
                    <PlusIcon className="size-3" />
                    Add variable
                  </Button>
                </div>
              </div>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving || props.owner === null} onClick={() => void submit()}>
            {saving ? "Checking key…" : saved ? "Save" : "Add account"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}
