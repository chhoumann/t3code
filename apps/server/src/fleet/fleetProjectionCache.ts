/**
 * SQLite projection cache helpers for zero-wakeup sandbox reads and Park-and-Splice
 * optimistic command reconciliation on the Fleet Hub.
 */
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellHttpSnapshot,
  type OrchestrationV2ShellThreadStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type MessageId,
} from "@t3tools/contracts";

export interface SeedSandboxProjectionInput {
  readonly environmentId: string;
  readonly title: string;
  readonly serverVersion: string;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly projectPath: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly message: string;
  readonly driver: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection: ModelSelection;
  readonly nowIso: string;
  readonly skipSeedThread?: boolean;
}

export interface SeededSandboxCache {
  readonly descriptorJson: string;
  readonly shellSnapshotJson: string;
  readonly threadProjectionJson: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export function buildSeededSandboxCache(input: SeedSandboxProjectionInput): SeededSandboxCache {
  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId: input.environmentId as ExecutionEnvironmentDescriptor["environmentId"],
    label: input.title,
    platform: { os: "linux", arch: "x64", machine: "cloud" },
    serverVersion: input.serverVersion,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      accessTokenRenewal: true,
      shellThreadFamilies: true,
      shellOlderSettled: true,
      inlineMessageContext: true,
      freshContext: true,
      threadStop: true,
      threadForceStop: true,
      peerLinks: true,
      mcpModeLimitHeader: true,
      linkFence: true,
    },
  };

  const providerInstanceId = input.modelSelection.instanceId;
  const threadShell = {
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "web" as const,
    providerInstanceId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "starting" as OrchestrationV2ShellThreadStatus,
    pendingRuntimeRequest: null,
    latestVisibleMessage: {
      id: input.messageId,
      role: "user" as const,
      text: input.message,
      updatedAt: input.nowIso,
    },
    latestUserMessageAt: input.nowIso,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };

  const projectShell = {
    id: input.projectId,
    title: input.projectTitle,
    workspaceRoot: input.projectPath,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    trackedFolders: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };

  const shellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 1,
    threads: input.skipSeedThread === true ? [] : [threadShell],
    archivedThreads: [],
    projects: [projectShell],
    projectIdentities: "[]",
  };

  const initialMessage = {
    id: input.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    createdBy: "user" as const,
    creationSource: "web" as const,
    role: "user" as const,
    text: input.message,
    attachments: [],
    streaming: false,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };

  const threadProjection = {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      createdBy: "user" as const,
      creationSource: "web" as const,
      providerInstanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [initialMessage],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.nowIso,
  };

  return {
    descriptor,
    descriptorJson: JSON.stringify(descriptor),
    shellSnapshotJson: JSON.stringify(shellSnapshot),
    threadProjectionJson: JSON.stringify(threadProjection),
  };
}

export function safeJsonParse<T = Record<string, unknown>>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function extractCommandThreadId(command: Record<string, unknown>): string | null {
  if (typeof command.threadId === "string") return command.threadId;
  if (typeof command.targetThreadId === "string") return command.targetThreadId;
  return null;
}

export interface OptimisticCacheUpdate {
  readonly nextShellSnapshotJson: string;
  readonly updatedThreadId: string | null;
  readonly nextThreadProjectionJson: string | null;
  readonly nextSequence: number;
  readonly shellUpdates: ReadonlyArray<Record<string, unknown>>;
  readonly threadUpdates: ReadonlyArray<Record<string, unknown>>;
  readonly allTopLevelArchived: boolean;
}

type MutableShellSnapshot = {
  schemaVersion: number;
  snapshotSequence: number;
  threads: Array<Record<string, unknown>>;
  archivedThreads: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  projectIdentities?: string;
};

type MutableThreadProjection = {
  thread: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  updatedAt: string;
  [key: string]: unknown;
};

function isListedTopLevelThread(thread: Record<string, unknown>): boolean {
  if (thread.deletedAt !== null && thread.deletedAt !== undefined) return false;
  const lineage = thread.lineage as
    | { relationshipToParent?: unknown; sideChat?: unknown; workflowStep?: unknown }
    | undefined;
  if (!lineage) return true;
  return (
    lineage.relationshipToParent !== "subagent" &&
    lineage.sideChat !== true &&
    lineage.workflowStep !== true
  );
}

function areAllTopLevelThreadsArchived(shellSnapshotJson: string): boolean {
  const shell = safeJsonParse<MutableShellSnapshot>(shellSnapshotJson);
  if (!shell) return false;
  const activeTopLevel = (shell.threads ?? []).filter(
    (thread) =>
      isListedTopLevelThread(thread) &&
      (thread.archivedAt === null || thread.archivedAt === undefined),
  );
  const archivedTopLevel = (shell.archivedThreads ?? []).filter(isListedTopLevelThread);
  return activeTopLevel.length === 0 && archivedTopLevel.length > 0;
}

export function applyOptimisticCommandToCache(input: {
  readonly shellSnapshotJson: string | null;
  readonly threadProjectionJson: string | null;
  readonly command: Record<string, unknown>;
  readonly nowIso: string;
}): OptimisticCacheUpdate | null {
  const shell = input.shellSnapshotJson
    ? safeJsonParse<MutableShellSnapshot>(input.shellSnapshotJson)
    : null;
  if (!shell) return null;

  const commandType = typeof input.command.type === "string" ? input.command.type : "";
  const threadId = extractCommandThreadId(input.command);
  const nextSequence =
    (typeof shell.snapshotSequence === "number" ? shell.snapshotSequence : 1) + 1;
  shell.snapshotSequence = nextSequence;

  const shellUpdates: Array<Record<string, unknown>> = [];
  const threadUpdates: Array<Record<string, unknown>> = [];
  let nextThreadProjectionJson: string | null = null;
  const threadProj = input.threadProjectionJson
    ? safeJsonParse<MutableThreadProjection>(input.threadProjectionJson)
    : null;

  if (
    (commandType === "thread.turn.start" || commandType === "message.dispatch") &&
    threadId !== null
  ) {
    const rawMsg =
      commandType === "thread.turn.start"
        ? typeof input.command.message === "object" && input.command.message !== null
          ? (input.command.message as Record<string, unknown>)
          : null
        : input.command;
    const text = typeof rawMsg?.text === "string" ? rawMsg.text : "";
    const messageId =
      typeof rawMsg?.messageId === "string" ? rawMsg.messageId : `msg-${nextSequence}`;
    const newMsg: Record<string, unknown> = {
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "user",
      creationSource: "web",
      role: "user",
      text,
      attachments: Array.isArray(rawMsg?.attachments) ? rawMsg.attachments : [],
      streaming: false,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };

    const existingIdx = shell.threads.findIndex((t) => t.id === threadId);
    if (existingIdx >= 0) {
      const updated = {
        ...shell.threads[existingIdx]!,
        status: "queued",
        updatedAt: input.nowIso,
        latestUserMessageAt: input.nowIso,
        latestVisibleMessage: { id: messageId, role: "user", text, updatedAt: input.nowIso },
      };
      shell.threads[existingIdx] = updated;
      shellUpdates.push({
        kind: "thread.updated",
        sequence: nextSequence,
        location: "active",
        thread: updated,
      });
    }

    if (threadProj) {
      const alreadyHas = threadProj.messages.some((m) => m.id === messageId);
      if (!alreadyHas) {
        threadProj.messages = [...threadProj.messages, newMsg];
        threadProj.updatedAt = input.nowIso;
        nextThreadProjectionJson = JSON.stringify(threadProj);
        threadUpdates.push({
          kind: "snapshot",
          snapshotSequence: nextSequence,
          projection: threadProj,
        });
      }
    }
  } else if (commandType === "thread.archive" && threadId !== null) {
    const idx = shell.threads.findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      const archived = {
        ...shell.threads[idx]!,
        archivedAt: input.nowIso,
        updatedAt: input.nowIso,
      };
      shell.threads.splice(idx, 1);
      shell.archivedThreads = [...(shell.archivedThreads ?? []), archived];
      shellUpdates.push({
        kind: "thread.removed",
        sequence: nextSequence,
        location: "active",
        threadId,
      });
    }
    if (threadProj) {
      threadProj.thread = {
        ...threadProj.thread,
        archivedAt: input.nowIso,
        updatedAt: input.nowIso,
      };
      threadProj.updatedAt = input.nowIso;
      nextThreadProjectionJson = JSON.stringify(threadProj);
      threadUpdates.push({
        kind: "snapshot",
        snapshotSequence: nextSequence,
        projection: threadProj,
      });
    }
  } else if (commandType === "thread.unarchive" && threadId !== null) {
    const idx = (shell.archivedThreads ?? []).findIndex((t) => t.id === threadId);
    if (idx >= 0) {
      const restored = {
        ...shell.archivedThreads[idx]!,
        archivedAt: null,
        updatedAt: input.nowIso,
      };
      shell.archivedThreads.splice(idx, 1);
      shell.threads.push(restored);
      shellUpdates.push({
        kind: "thread.updated",
        sequence: nextSequence,
        location: "active",
        thread: restored,
      });
    }
    if (threadProj) {
      threadProj.thread = { ...threadProj.thread, archivedAt: null, updatedAt: input.nowIso };
      threadProj.updatedAt = input.nowIso;
      nextThreadProjectionJson = JSON.stringify(threadProj);
    }
  } else if (commandType === "thread.rename" && threadId !== null) {
    const nextTitle = typeof input.command.title === "string" ? input.command.title : null;
    if (nextTitle !== null) {
      const idx = shell.threads.findIndex((t) => t.id === threadId);
      if (idx >= 0) {
        const updated = { ...shell.threads[idx]!, title: nextTitle, updatedAt: input.nowIso };
        shell.threads[idx] = updated;
        shellUpdates.push({
          kind: "thread.updated",
          sequence: nextSequence,
          location: "active",
          thread: updated,
        });
      }
      if (threadProj) {
        threadProj.thread = { ...threadProj.thread, title: nextTitle, updatedAt: input.nowIso };
        threadProj.updatedAt = input.nowIso;
        nextThreadProjectionJson = JSON.stringify(threadProj);
      }
    }
  }

  const nextShellSnapshotJson = JSON.stringify(shell);
  return {
    nextShellSnapshotJson,
    updatedThreadId: threadId,
    nextThreadProjectionJson,
    nextSequence,
    shellUpdates,
    threadUpdates,
    allTopLevelArchived: areAllTopLevelThreadsArchived(nextShellSnapshotJson),
  };
}

export function mergeGuestShellChunkIntoCache(
  currentShellJson: string | null,
  chunkValue: Record<string, unknown>,
): string | null {
  const kind = chunkValue.kind;
  if (
    kind === "snapshot" &&
    typeof chunkValue.snapshot === "object" &&
    chunkValue.snapshot !== null
  ) {
    return JSON.stringify(chunkValue.snapshot);
  }
  const current = currentShellJson ? safeJsonParse<MutableShellSnapshot>(currentShellJson) : null;
  if (!current) return currentShellJson;

  const seq =
    typeof chunkValue.sequence === "number" ? chunkValue.sequence : current.snapshotSequence;
  current.snapshotSequence = Math.max(current.snapshotSequence, seq);

  if (
    kind === "project.updated" &&
    typeof chunkValue.project === "object" &&
    chunkValue.project !== null
  ) {
    const project = chunkValue.project as Record<string, unknown>;
    const idx = current.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) current.projects[idx] = project;
    else current.projects.push(project);
    return JSON.stringify(current);
  }
  if (kind === "project.removed" && typeof chunkValue.projectId === "string") {
    current.projects = current.projects.filter((p) => p.id !== chunkValue.projectId);
    return JSON.stringify(current);
  }
  if (
    kind === "thread.updated" &&
    typeof chunkValue.thread === "object" &&
    chunkValue.thread !== null
  ) {
    const thread = chunkValue.thread as Record<string, unknown>;
    const list = chunkValue.location === "archive" ? current.archivedThreads : current.threads;
    const other = chunkValue.location === "archive" ? current.threads : current.archivedThreads;
    const otherIdx = other.findIndex((t) => t.id === thread.id);
    if (otherIdx >= 0) other.splice(otherIdx, 1);
    const idx = list.findIndex((t) => t.id === thread.id);
    if (idx >= 0) list[idx] = thread;
    else list.push(thread);
    return JSON.stringify(current);
  }
  if (kind === "thread.removed" && typeof chunkValue.threadId === "string") {
    current.threads = current.threads.filter((t) => t.id !== chunkValue.threadId);
    current.archivedThreads = current.archivedThreads.filter((t) => t.id !== chunkValue.threadId);
    return JSON.stringify(current);
  }
  return currentShellJson;
}

export type CacheThreadProjection = OrchestrationV2ThreadProjection;
export type CacheShellSnapshot = OrchestrationV2ShellHttpSnapshot;
export type CacheThreadShell = OrchestrationV2ThreadShell;
export type CacheMessage = OrchestrationV2ConversationMessage;
