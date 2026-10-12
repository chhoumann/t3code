import { useAtomValue } from "@effect/atom-react";
import {
  SANDBOX_LAUNCH_STAGES,
  SANDBOX_STATUS_LABEL,
  type SandboxLaunchAction,
  sandboxCommandFailure,
  sandboxLandingThreadId,
  sandboxLaunchAction,
  sandboxLaunchStageIndex,
  sandboxLaunchStatusLabel,
} from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxId, SandboxView } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { useSandboxActions } from "../hooks/useSandboxActions";
import { useEnvironmentThreads } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { sandboxes } from "../state/sandboxes";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { cn } from "~/lib/utils";

/**
 * A sandbox on its way to its thread: the message it started with and the
 * stage it is at. Once this device can show the thread, this route is
 * replaced by the thread itself. An asleep sandbox is woken on arrival.
 */
export function SandboxLaunchView(props: {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
}) {
  const owners = useAtomValue(sandboxes.ownersAtom);
  const view =
    owners.get(props.ownerEnvironmentId)?.find((sandbox) => sandbox.id === props.sandboxId) ?? null;
  const listed = owners.has(props.ownerEnvironmentId);
  const ownerPhase = useEnvironment(props.ownerEnvironmentId)?.connection.phase;
  // Until the owner lists its sandboxes there is nothing to show, unless it cannot.
  const ownerUnreachable =
    ownerPhase !== "connecting" && ownerPhase !== "reconnecting" && ownerPhase !== "connected";
  const environmentId = view?.environmentId ?? null;
  const environment = useEnvironment(environmentId);
  const threads = useEnvironmentThreads(environmentId);
  const action =
    view === null
      ? null
      : sandboxLaunchAction({
          view,
          landingThreadId: sandboxLandingThreadId(threads, view.threadId),
          connected: environment?.connection.phase === "connected",
        });
  useOpenThread(action);
  const wake = useWakeOnArrival(action);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {view?.title ?? "Sandbox"}
          </span>
        </WorkspacePageHeader>
        {view === null || action === null ? (
          listed ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>This sandbox no longer exists</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : ownerUnreachable ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>This sandbox's environment is offline</EmptyTitle>
                <EmptyDescription>Reconnect it to follow the sandbox.</EmptyDescription>
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
              <SandboxProgress
                view={view}
                ownerEnvironmentId={props.ownerEnvironmentId}
                action={action}
                wake={wake}
              />
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

/**
 * Replaces this route with the thread the sandbox lands on once this device
 * can show it (`sandboxLaunchAction`), so the thread view never opens on an
 * empty state.
 */
function useOpenThread(action: SandboxLaunchAction | null) {
  const navigate = useNavigate();
  const environmentId = action?._tag === "OpenThread" ? action.environmentId : null;
  const threadId = action?._tag === "OpenThread" ? action.threadId : null;

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
      replace: true,
    });
  }, [navigate, environmentId, threadId]);
}

interface SandboxWake {
  /** Why the last wake failed, until the next one starts. */
  readonly failure: string | null;
  readonly retry: (environmentId: EnvironmentId) => void;
  /** A resume asked for here stands in for this visit's wake. */
  readonly resumed: () => void;
}

/**
 * Wakes an asleep sandbox once per visit, as sending to one of its threads
 * would, so opening it is enough: the owner resumes it and this device
 * connects to it, then `useOpenThread` opens its thread. Unlike a send, it is
 * not checked up front against the owner's grant: a visit can arrive before
 * that loads, and the request to the owner waits for it.
 */
function useWakeOnArrival(action: SandboxLaunchAction | null): SandboxWake {
  const wake = useAtomCommand(threadEnvironment.wake, { reportFailure: false });
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef(false);
  const run = async (environmentId: EnvironmentId) => {
    asked.current = true;
    setFailure(null);
    const result = await wake({ environmentId });
    setFailure(sandboxCommandFailure(result));
  };
  const wakeOnArrival = useEffectEvent((environmentId: EnvironmentId) => {
    if (!asked.current) void run(environmentId);
  });
  const asleep = action?._tag === "Wake" ? action.environmentId : null;

  useEffect(() => {
    if (asleep !== null) wakeOnArrival(asleep);
  }, [asleep]);

  return {
    failure,
    retry: (environmentId) => void run(environmentId),
    resumed: () => {
      asked.current = true;
    },
  };
}

function SandboxProgress(props: {
  readonly view: SandboxView;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly action: SandboxLaunchAction;
  readonly wake: SandboxWake;
}) {
  const { view, wake } = props;
  const { setDesired, confirmAndDelete } = useSandboxActions();
  const sandbox = { ownerEnvironmentId: props.ownerEnvironmentId, view: view };
  const stage = sandboxLaunchStageIndex(view.status);
  const remove = () => void confirmAndDelete(sandbox);

  if (view.status._tag === "failed") {
    return (
      <SandboxFailure
        message={view.status.message}
        onRetry={view.status.retryable ? () => void setDesired(sandbox, view.desired) : null}
        onDelete={remove}
      />
    );
  }

  if (props.action._tag === "OfferResume") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{SANDBOX_STATUS_LABEL[view.status._tag]}</p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={view.status._tag === "stopping"}
            onClick={() => {
              wake.resumed();
              void setDesired(sandbox, "running");
            }}
          >
            <PlayIcon />
            Resume
          </Button>
        </div>
      </div>
    );
  }

  const { environmentId } = view;
  if (wake.failure !== null && environmentId !== null) {
    return (
      <SandboxFailure
        message={wake.failure}
        onRetry={() => wake.retry(environmentId)}
        onDelete={remove}
      />
    );
  }

  if (stage === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {props.action._tag === "Wake"
          ? SANDBOX_STATUS_LABEL.resuming
          : sandboxLaunchStatusLabel(view.status)}
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

function SandboxFailure(props: {
  readonly message: string;
  readonly onRetry: (() => void) | null;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-destructive">{SANDBOX_STATUS_LABEL.failed}</p>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{props.message}</p>
      <div className="flex items-center gap-2">
        {props.onRetry === null ? null : (
          <Button size="sm" variant="outline" onClick={props.onRetry}>
            <RotateCcwIcon />
            Retry
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={props.onDelete}>
          <Trash2Icon />
          Delete sandbox
        </Button>
      </div>
    </div>
  );
}
