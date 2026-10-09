import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { SANDBOX_STATUS_LABEL, isSandboxStopped } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxView } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, PlayIcon } from "lucide-react";

import { useSandboxActions } from "../../hooks/useSandboxActions";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { sandboxes } from "../../state/sandboxes";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Sandboxes stopped by archiving their last thread, at their TTL, or by the
 * provider. A stopped machine cannot
 * list its threads, so the sandbox stands in for them: Resume brings the
 * machine and its thread back.
 */
export function StoppedSandboxesSection(props: {
  readonly ownerEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  const owners = useAtomValue(sandboxes.ownersAtom);
  const stopped = props.ownerEnvironmentIds.flatMap((ownerEnvironmentId) =>
    (owners.get(ownerEnvironmentId) ?? [])
      .filter(isSandboxStopped)
      .map((sandbox) => ({ ownerEnvironmentId, sandbox })),
  );
  if (stopped.length === 0) return null;
  return (
    <SettingsSection title="Stopped sandboxes" icon={<BoxIcon className="size-3.5" />}>
      {stopped.map(({ ownerEnvironmentId, sandbox }) => (
        <StoppedSandboxRow
          key={sandbox.id}
          ownerEnvironmentId={ownerEnvironmentId}
          sandbox={sandbox}
        />
      ))}
    </SettingsSection>
  );
}

function StoppedSandboxRow(props: {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandbox: SandboxView;
}) {
  const { sandbox } = props;
  const navigate = useNavigate();
  const { setDesired, confirmAndDelete } = useSandboxActions();
  const { unarchiveThread } = useThreadActions();
  const ref = { ownerEnvironmentId: props.ownerEnvironmentId, view: sandbox };
  const resume = async () => {
    // Unarchiving its thread resumes the sandbox and brings the thread back once it runs.
    if (sandbox.environmentId !== null && sandbox.status._tag === "stopped") {
      void unarchiveThread(scopeThreadRef(sandbox.environmentId, sandbox.threadId));
    } else if (!(await setDesired(ref, "running"))) {
      return;
    }
    await navigate({
      to: "/sandbox/$environmentId/$sandboxId",
      params: { environmentId: props.ownerEnvironmentId, sandboxId: sandbox.id },
    });
  };
  return (
    <SettingsRow
      title={sandbox.title}
      description={SANDBOX_STATUS_LABEL[sandbox.status._tag]}
      onContextMenu={(event) => {
        event.preventDefault();
        void readLocalApi()
          ?.contextMenu.show(
            [
              { id: "resume", label: "Resume" },
              { id: "delete-sandbox", label: "Delete sandbox", destructive: true },
            ],
            { x: event.clientX, y: event.clientY },
          )
          .then((clicked) => {
            if (clicked === "resume") void resume();
            if (clicked === "delete-sandbox") void confirmAndDelete(ref);
          });
      }}
      control={
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={sandbox.status._tag === "stopping"}
          onClick={() => void resume()}
        >
          <PlayIcon className="size-3.5" />
          <span>Resume</span>
        </Button>
      }
    />
  );
}
