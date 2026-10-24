import { useAtomValue } from "@effect/atom-react";
import { sandboxCommandFailure } from "@t3tools/client-runtime/state/sandboxes";
import {
  type EnvironmentId,
  type SandboxGitHubFlowStart,
  sandboxGitHubCallbackPath,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi, readLocalApi } from "../../localApi";
import type { EnvironmentPresentation } from "../../state/environments";
import { sandboxes } from "../../state/sandboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Where GitHub sends this client back. The route there relays the callback to the owner it names. */
export const githubCallbackUrl = (ownerEnvironmentId: EnvironmentId): string =>
  `${window.location.origin}${sandboxGitHubCallbackPath(ownerEnvironmentId)}`;

/**
 * Takes a browser to GitHub for a flow the owner began. Creating an App is a
 * form POST, which the desktop window cannot make itself, so the desktop
 * serves the form to the system browser instead.
 */
export async function openGitHubFlow(start: SandboxGitHubFlowStart): Promise<void> {
  if (start._tag === "authorize") return ensureLocalApi().shell.openExternal(start.url);
  const desktop = window.desktopBridge?.openGitHubAppManifest;
  if (desktop) return desktop({ action: start.action, manifest: start.manifest });
  const form = document.createElement("form");
  form.method = "post";
  form.action = start.action;
  form.target = "_blank";
  const manifest = document.createElement("input");
  manifest.type = "hidden";
  manifest.name = "manifest";
  manifest.value = start.manifest;
  form.append(manifest);
  document.body.append(form);
  form.submit();
  form.remove();
}

export function SandboxGitHubSection(props: { readonly owner: EnvironmentPresentation }) {
  const { owner } = props;
  const app = owner.serverConfig?.settings.sandboxGitHubApp ?? null;
  const canWrite = useAtomValue(sandboxes.githubBegin.permissionAtom(owner.environmentId));
  const begin = useAtomCommand(sandboxes.githubBegin, { reportFailure: false });
  const disconnect = useAtomCommand(sandboxes.githubDisconnect, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (step: "register" | "authorize") => {
    setBusy(true);
    setError(null);
    const result = await begin({
      environmentId: owner.environmentId,
      input: { step, callbackUrl: githubCallbackUrl(owner.environmentId) },
    });
    if (result._tag === "Success") {
      await openGitHubFlow(result.value).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not open GitHub."),
      );
    } else {
      setError(sandboxCommandFailure(result));
    }
    setBusy(false);
  };

  const remove = async (forgetApp: boolean) => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      forgetApp
        ? "Remove the GitHub App from this environment? Sandboxes lose GitHub access until you connect again."
        : "Disconnect GitHub? Sandboxes lose GitHub access until you reconnect.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    setError(null);
    const result = await disconnect({ environmentId: owner.environmentId, input: { forgetApp } });
    if (result._tag !== "Success") setError(sandboxCommandFailure(result));
    setBusy(false);
  };

  const connection = app?.connection ?? null;
  const description =
    connection === null || connection._tag === "disconnected"
      ? null
      : connection._tag === "connected"
        ? `Connected as ${connection.user.login}`
        : `Sign in again to keep working as ${connection.user.login}`;
  const connectStep = app === null ? "register" : "authorize";
  const connectLabel = connection?._tag === "reauthorize" ? "Reconnect" : "Connect GitHub";

  return (
    <SettingsSection title="GitHub">
      <SettingsRow
        title="GitHub App"
        description={description}
        status={error ? <span className="block text-destructive">{error}</span> : null}
        control={
          <div className="flex items-center gap-2">
            {connection?._tag === "connected" ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite || busy}
                onClick={() => void start(connectStep)}
              >
                {connectLabel}
              </Button>
            )}
            {app === null ? null : (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      disabled={!canWrite || busy}
                      aria-label="More actions for the GitHub App"
                    />
                  }
                >
                  <EllipsisIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    onClick={() =>
                      void ensureLocalApi().shell.openExternal(
                        `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
                      )
                    }
                  >
                    Manage repositories
                  </MenuItem>
                  {connection?._tag === "disconnected" ? null : (
                    <MenuItem onClick={() => void remove(false)}>Disconnect…</MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => void remove(true)}>
                    Remove App…
                  </MenuItem>
                </MenuPopup>
              </Menu>
            )}
          </div>
        }
      />
    </SettingsSection>
  );
}
