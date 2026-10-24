import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  parseSandboxBase,
  sandboxRemoteUrlFromInput,
} from "@t3tools/client-runtime/state/sandboxes";
import type {
  EnvironmentId,
  RepositoryIdentity,
  SandboxBase,
  SandboxRemoteUrl,
  SandboxSource,
} from "@t3tools/contracts";
import { sandboxRepositoryIdentity, sandboxSourceForProject } from "@t3tools/shared/sandboxProject";
import { ChevronDownIcon, FolderGit2Icon, GitBranchIcon, type LucideIcon } from "lucide-react";
import { type Ref, useDeferredValue, useImperativeHandle, useState } from "react";

import type { DraftId } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { useSandboxDraftStore, useSandboxDraftTarget } from "../sandboxDraftStore";
import { usePaginatedBranches } from "../state/queries";
import { BranchPicker } from "./BranchPicker";
import {
  resolveSandboxDraftSource,
  sandboxBaseSuggestions,
  sanitizeNewRefName,
} from "./BranchToolbar.logic";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./ui/combobox";
import { MiddleTruncate } from "./ui/middle-truncate";

type DisplayMode = "toolbar" | "panel";

export interface BranchToolbarSandboxSourceHandle {
  openRepository: () => void;
  openBase: () => void;
}

const DEFAULT_BASE: SandboxBase = { _tag: "default" };

/**
 * The repository and base a sandbox draft clones. The repository follows the
 * draft's project unless the project has no remote or the draft names
 * another, so a project without one asks for it here.
 */
export function BranchToolbarSandboxSource({
  ref,
  draftId,
  environmentId,
  project,
  disabled,
  displayMode,
}: {
  ref?: Ref<BranchToolbarSandboxSourceHandle>;
  draftId: DraftId;
  environmentId: EnvironmentId;
  project: {
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  };
  disabled: boolean;
  displayMode: DisplayMode;
}) {
  const target = useSandboxDraftTarget(draftId);
  const [openPicker, setOpenPicker] = useState<"repository" | "base" | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      openRepository: () => setOpenPicker("repository"),
      openBase: () => setOpenPicker("base"),
    }),
    [],
  );
  if (target === null) return null;
  const identity = project.repositoryIdentity ?? null;
  const followsProject =
    target.remoteUrl === undefined && sandboxSourceForProject(identity) !== null;
  const source = resolveSandboxDraftSource(target, identity);
  const setSource = (patch: Partial<SandboxSource>) =>
    useSandboxDraftStore.getState().setSource(draftId, patch);
  const pickerOpenChange = (picker: "repository" | "base") => (open: boolean) =>
    setOpenPicker(open ? picker : null);

  return (
    <div
      className={cn(
        "flex min-w-0",
        displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
      )}
    >
      {followsProject ? null : (
        <SandboxRepositoryPicker
          remoteUrl={source?.remoteUrl ?? null}
          open={openPicker === "repository" && !disabled}
          onOpenChange={pickerOpenChange("repository")}
          onChange={(remoteUrl) => setSource({ remoteUrl })}
          disabled={disabled}
          displayMode={displayMode}
        />
      )}
      <SandboxBasePicker
        base={target.base ?? DEFAULT_BASE}
        open={openPicker === "base" && !disabled}
        onOpenChange={pickerOpenChange("base")}
        onChange={(base) => setSource({ base })}
        suggestionsFrom={
          followsProject && identity !== null
            ? { environmentId, cwd: project.workspaceRoot, identity }
            : null
        }
        disabled={disabled}
        displayMode={displayMode}
      />
    </div>
  );
}

function SandboxSourceTrigger({
  icon: Icon,
  label,
  disabled,
  displayMode,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  displayMode: DisplayMode;
}) {
  return (
    <ComboboxTrigger
      render={
        displayMode === "panel" ? (
          <ThreadDetailsControl part="select" />
        ) : (
          <ComposerControl size="xs" />
        )
      }
      className="min-w-0 max-w-full active:scale-100"
      disabled={disabled}
    >
      <Icon
        className={cn(
          "size-3 shrink-0 opacity-70",
          displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
        )}
      />
      <ComposerContextLabel displayMode={displayMode}>
        <MiddleTruncate
          value={label}
          variant={displayMode === "panel" ? "cap-aligned" : "default"}
          className="w-full"
        />
      </ComposerContextLabel>
      {displayMode !== "panel" ? <ChevronDownIcon className="size-3 shrink-0 opacity-50" /> : null}
    </ComboboxTrigger>
  );
}

function usePickerPopupProps(displayMode: DisplayMode) {
  const composerFloatingLayerProps = useComposerMenuProps();
  return displayMode === "panel"
    ? { align: "start" as const, side: "bottom" as const, className: "w-(--anchor-width)" }
    : {
        align: "end" as const,
        side: "top" as const,
        className: "w-80",
        ...composerFloatingLayerProps,
      };
}

function repositoryLabel(remoteUrl: SandboxRemoteUrl): string {
  return (
    sandboxRepositoryIdentity({ remoteUrl, base: DEFAULT_BASE }, sourceControlClients)
      .displayName ?? remoteUrl
  );
}

const USE_REPOSITORY_ITEM = "use-repository";

function SandboxRepositoryPicker({
  remoteUrl,
  open,
  onOpenChange,
  onChange,
  disabled,
  displayMode,
}: {
  remoteUrl: SandboxRemoteUrl | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (remoteUrl: SandboxRemoteUrl) => void;
  disabled: boolean;
  displayMode: DisplayMode;
}) {
  const [query, setQuery] = useState("");
  const popupProps = usePickerPopupProps(displayMode);
  const typed = query.trim().length === 0 ? null : sandboxRemoteUrlFromInput(query);
  const items = typed === null ? [] : [USE_REPOSITORY_ITEM];
  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      filter={null}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={handleOpenChange}
      onValueChange={(item) => {
        if (item !== USE_REPOSITORY_ITEM || typed === null) return;
        onChange(typed);
        handleOpenChange(false);
      }}
    >
      <SandboxSourceTrigger
        icon={FolderGit2Icon}
        label={remoteUrl === null ? "Choose repository" : repositoryLabel(remoteUrl)}
        disabled={disabled}
        displayMode={displayMode}
      />
      <ComboboxPopup {...popupProps}>
        <ComboboxSearchInput
          aria-label="Repository"
          placeholder="Git URL or owner/repo"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxList>
          {typed !== null ? (
            <ComboboxItem hideIndicator index={0} value={USE_REPOSITORY_ITEM}>
              <span className="truncate">Use {repositoryLabel(typed)}</span>
            </ComboboxItem>
          ) : query.trim().length > 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              Enter an HTTPS or SSH URL, or owner/repo.
            </p>
          ) : null}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

const DEFAULT_BASE_ITEM = "__default_branch__";
const USE_BASE_ITEM_PREFIX = "__use_branch__:";

function SandboxBasePicker({
  base,
  open,
  onOpenChange,
  onChange,
  suggestionsFrom,
  disabled,
  displayMode,
}: {
  base: SandboxBase;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (base: SandboxBase) => void;
  /** The project checkout whose remote branches are offered; null offers none. */
  suggestionsFrom: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly identity: RepositoryIdentity;
  } | null;
  disabled: boolean;
  displayMode: DisplayMode;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const popupProps = usePickerPopupProps(displayMode);
  // Listed only while open, so a draft that never opens the picker reads no refs.
  const branches = usePaginatedBranches({
    environmentId: suggestionsFrom?.environmentId ?? null,
    cwd: open ? (suggestionsFrom?.cwd ?? null) : null,
    query: sanitizeNewRefName(deferredQuery),
  });
  const suggestions =
    suggestionsFrom === null ? [] : sandboxBaseSuggestions(branches.refs, suggestionsFrom.identity);
  const typed = deferredQuery.length === 0 ? null : parseSandboxBase(deferredQuery);
  const baseByItem = new Map<string, SandboxBase>();
  if (deferredQuery.length === 0) baseByItem.set(DEFAULT_BASE_ITEM, DEFAULT_BASE);
  for (const name of suggestions) baseByItem.set(name, { _tag: "branch", name });
  if (typed?._tag === "branch" && !baseByItem.has(typed.name)) {
    baseByItem.set(`${USE_BASE_ITEM_PREFIX}${typed.name}`, typed);
  }
  const items = [...baseByItem.keys()];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    deferredQuery.length > 0 && typed === null
      ? `"${deferredQuery}" is not a valid branch name`
      : suggestionsFrom === null
        ? null
        : (branches.error ??
          (branches.isPending && branches.data === null ? "Loading branches..." : null));
  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };
  const select = (item: string) => {
    const picked = baseByItem.get(item);
    if (picked === undefined) return;
    onChange(picked);
    handleOpenChange(false);
  };

  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={base._tag === "default" ? DEFAULT_BASE_ITEM : base.name}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={handleOpenChange}
      onSelectItem={select}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      searchPlaceholder="Branch name"
      popupProps={{ ...popupProps, className: cn("flex flex-col", popupProps.className) }}
      renderItem={(item, index) => (
        <ComboboxItem
          hideIndicator
          key={item}
          index={index}
          value={item}
          onClick={() => select(item)}
        >
          {item === DEFAULT_BASE_ITEM ? (
            <span className="truncate">Default branch</span>
          ) : item.startsWith(USE_BASE_ITEM_PREFIX) ? (
            <span className="truncate">
              Use &quot;{item.slice(USE_BASE_ITEM_PREFIX.length)}&quot;
            </span>
          ) : (
            <MiddleTruncate value={item} className="flex-1" />
          )}
        </ComboboxItem>
      )}
    >
      <SandboxSourceTrigger
        icon={GitBranchIcon}
        label={base._tag === "default" ? "From default branch" : `From ${base.name}`}
        disabled={disabled}
        displayMode={displayMode}
      />
    </BranchPicker>
  );
}
