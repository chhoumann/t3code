import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type PendingSandboxThread,
  SANDBOX_STATUS_LABEL,
  sandboxLaunchStatusLabel,
} from "@t3tools/client-runtime/state/sandboxes";
import { CircleAlertIcon, CircleDashedIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
} from "react";

import { cn } from "~/lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import { animateSidebarLayoutChanges, resolveSidebarRowAccessibility } from "../Sidebar.logic";

/**
 * A launching sandbox, shaped like the thread card that replaces it once the
 * sandbox's environment lists its thread. Opens the sandbox's launch view.
 * Its icon is the monogram a new project shows until its favicon loads.
 * It sits in the sortable list so dragged rows move around it, but it cannot
 * be picked up.
 */
export const SidebarPendingSandboxRow = memo(function SidebarPendingSandboxRow(props: {
  sortableId: string;
  pending: PendingSandboxThread;
  /** The title the sandbox's project will have, which its icon is drawn from. */
  projectTitle: string;
  projectDisplayName: string;
  isActive: boolean;
  onNavigate: (pending: PendingSandboxThread) => void;
  onContextMenu: (pending: PendingSandboxThread, position: { x: number; y: number }) => void;
}) {
  const { pending, onContextMenu, onNavigate } = props;
  const { setNodeRef, transform, transition } = useSortable({
    id: props.sortableId,
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const projectIdentity = deriveProjectIdentity(props.projectTitle);
  const failed = pending.view.status._tag === "failed";
  const statusLabel = failed
    ? SANDBOX_STATUS_LABEL.failed
    : sandboxLaunchStatusLabel(pending.view.status);
  // Mirrors a working thread: background progress recedes until it needs the user.
  const recede = !failed && !props.isActive;
  const accessibility = resolveSidebarRowAccessibility({
    title: pending.view.title,
    statusLabel,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onContextMenu(pending, { x: rect.left, y: rect.bottom });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(pending);
      }
    },
    [onContextMenu, onNavigate, pending],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(pending, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, pending],
  );

  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      className="list-none py-0.5"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-pending-sandbox-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          recede &&
            "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        )}
        onClick={() => onNavigate(pending)}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{pending.view.title}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectMonogram
              text={projectIdentity.monogram}
              color={projectIdentity.color}
              className="size-4 shrink-0"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-secondary-label text-xs",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {props.projectDisplayName}
            </span>
            <span
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium",
                failed ? "text-error" : "text-info",
              )}
            >
              {failed ? (
                <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
              ) : (
                <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
              )}
              <span role="status">{statusLabel}</span>
            </span>
          </div>
          <div
            aria-hidden
            className={cn(
              "mt-1 truncate text-sm",
              recede ? "font-normal text-secondary-label" : "font-medium text-foreground/95",
            )}
          >
            {pending.view.title}
          </div>
        </div>
      </div>
    </li>
  );
});
