import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SANDBOX_LAUNCH_STAGES,
  SANDBOX_STATUS_LABEL,
  sandboxLaunchStageIndex,
} from "@t3tools/client-runtime/state/sandboxes";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SandboxId, SandboxView } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { isElectron } from "../env";
import { useSandboxActions } from "../hooks/useSandboxActions";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { sandboxes } from "../state/sandboxes";
import { Button } from "./ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { cn } from "~/lib/utils";

/**
 * A sandbox on its way to its first thread: the message it starts with and
 * the stage it is at. Once the sandbox's environment lists the thread, this
 * route is replaced by the thread itself.
 */
export function SandboxLaunchView(props: {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  /** Set when resuming from Archived: the thread comes back with the sandbox. */
  readonly unarchive: boolean;
}) {
  const owners = useAtomValue(sandboxes.ownersAtom);
  const view =
    owners.get(props.ownerEnvironmentId)?.find((sandbox) => sandbox.id === props.sandboxId) ?? null;
  const listed = owners.has(props.ownerEnvironmentId);
  useHandOffToThread(view, props.unarchive);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {view?.title ?? "Sandbox"}
          </span>
        </WorkspacePageHeader>
        {view === null ? (
          listed ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>This sandbox no longer exists</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both px-3 sm:px-5">
            <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-6 py-6">
              <div className="flex flex-col items-end">
                <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-message p-3 text-message-foreground text-sm">
                  {view.message}
                </div>
              </div>
              <SandboxProgress view={view} ownerEnvironmentId={props.ownerEnvironmentId} />
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

/**
 * Replaces this route with the sandbox's thread once its environment knows
 * the thread, so the thread view never opens on an empty state.
 */
function useHandOffToThread(view: SandboxView | null, unarchive: boolean) {
  const navigate = useNavigate();
  const { unarchiveThread } = useThreadActions();
  const environmentId = view?.environmentId ?? null;
  const threadId = view?.threadId ?? null;
  const environment = useEnvironment(environmentId);
  const threadRef = useMemo(
    () =>
      environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const ready = view?.status._tag === "ready" && environment?.connection.phase === "connected";
  const unarchiveStartedRef = useRef(false);

  useEffect(() => {
    if (!ready || threadRef === null) return;
    if (thread !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        replace: true,
      });
      return;
    }
    if (!unarchive || unarchiveStartedRef.current) return;
    unarchiveStartedRef.current = true;
    void unarchiveThread(threadRef).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        unarchiveStartedRef.current = false;
      }
    });
  }, [navigate, ready, thread, threadRef, unarchive, unarchiveThread]);
}

function SandboxProgress(props: {
  readonly view: SandboxView;
  readonly ownerEnvironmentId: EnvironmentId;
}) {
  const { view } = props;
  const { setDesired, confirmAndDelete } = useSandboxActions();
  const sandbox = { ownerEnvironmentId: props.ownerEnvironmentId, view: view };
  const stage = sandboxLaunchStageIndex(view.status);

  if (view.status._tag === "failed") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="font-medium text-destructive">{SANDBOX_STATUS_LABEL.failed}</p>
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {view.status.message}
        </p>
        <div className="flex items-center gap-2">
          {view.status.retryable ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void setDesired(sandbox, view.desired)}
            >
              <RotateCcwIcon />
              Retry
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void confirmAndDelete(sandbox)}>
            <Trash2Icon />
            Delete sandbox
          </Button>
        </div>
      </div>
    );
  }

  if (stage === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {view.status._tag === "ready" ? "Opening thread" : SANDBOX_STATUS_LABEL[view.status._tag]}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2 text-sm" aria-label="Sandbox progress">
      {SANDBOX_LAUNCH_STAGES.map((step, index) => (
        <li
          key={step}
          aria-current={index === stage ? "step" : undefined}
          className={cn(
            "flex items-center gap-2",
            index === stage ? "text-foreground" : "text-muted-foreground",
            index > stage && "text-muted-foreground/60",
          )}
        >
          {index < stage ? (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <CircleIcon
              className={cn("size-3.5 shrink-0", index === stage && "fill-current")}
              aria-hidden
            />
          )}
          {SANDBOX_STATUS_LABEL[step]}
        </li>
      ))}
    </ol>
  );
}
