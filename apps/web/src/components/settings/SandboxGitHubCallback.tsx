import { sandboxCommandFailure } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { sandboxes } from "../../state/sandboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer } from "./settingsLayout";

type Outcome =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "installing"; readonly url: string }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Where GitHub sends the browser after creating, installing, or authorizing
 * the sandbox App. Relays the code to the owner over this client's own
 * connection, then takes the user to the next step or back to Settings.
 */
export function SandboxGitHubCallback(props: {
  readonly environmentId: EnvironmentId;
  readonly code: string | null;
  readonly state: string | null;
}) {
  const { environmentId, code, state } = props;
  const navigate = useNavigate();
  const owner = useEnvironment(environmentId);
  // A fresh page load lists its saved environments a moment after the first render.
  const catalogReady = useEnvironments().isReady;
  const phase = owner?.connection.phase ?? null;
  const complete = useAtomCommand(sandboxes.githubComplete, { reportFailure: false });
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "waiting" });
  const relayed = useRef(false);
  const ownerMissing = catalogReady && owner === null;
  const ownerUnreachable =
    owner !== null &&
    phase !== null &&
    phase !== "connecting" &&
    phase !== "reconnecting" &&
    phase !== "connected";

  useEffect(() => {
    if (relayed.current || phase !== "connected" || code === null || state === null) return;
    relayed.current = true;
    void (async () => {
      const result = await complete({ environmentId, input: { state, code } });
      if (result._tag !== "Success") {
        setOutcome({
          _tag: "failed",
          message: sandboxCommandFailure(result) ?? "GitHub sign-in could not finish.",
        });
        return;
      }
      if (result.value._tag === "connected") {
        void navigate({ to: "/settings/sandboxes", replace: true });
        return;
      }
      // The browser that created the App now installs it. The desktop's own
      // window never leaves the app, so its system browser takes the step.
      if (isElectron) {
        await ensureLocalApi().shell.openExternal(result.value.url);
        void navigate({ to: "/settings/sandboxes", replace: true });
        return;
      }
      setOutcome({ _tag: "installing", url: result.value.url });
      window.location.assign(result.value.url);
    })();
  }, [phase, code, state, environmentId, complete, navigate]);

  const title =
    code === null || state === null
      ? "Nothing to finish here"
      : ownerMissing
        ? "This environment is not on this device"
        : ownerUnreachable
          ? `${owner.label} is offline`
          : outcome._tag === "failed"
            ? "GitHub sign-in could not finish"
            : outcome._tag === "installing"
              ? "Choose repositories on GitHub"
              : "Connecting GitHub…";
  const working =
    code !== null &&
    state !== null &&
    !ownerMissing &&
    !ownerUnreachable &&
    outcome._tag !== "failed";

  return (
    <SettingsPageContainer>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{working ? <Spinner /> : <GitBranchIcon />}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          {outcome._tag === "failed" ? (
            <EmptyDescription>{outcome.message}</EmptyDescription>
          ) : null}
        </EmptyHeader>
        {working ? null : (
          <EmptyContent>
            <Button size="sm" variant="outline" render={<Link to="/settings/sandboxes" />}>
              Back to Sandboxes
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </SettingsPageContainer>
  );
}
