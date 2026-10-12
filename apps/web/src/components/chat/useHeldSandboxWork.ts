import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { WorkDelivery } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForThreadDetail } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useWorkCommand } from "../../state/use-orchestration-command";
import {
  type HeldOperation,
  type HeldWork,
  type HeldWorkStep,
  heldWorkAtom,
  heldWorkFailure,
  heldWorkStep,
  holdWork,
  markHeldWorkAwake,
  releaseHeldWork,
} from "./heldSandboxWork";

/** How long a thread may take to load from its sandbox once the sandbox is awake. */
const THREAD_LOAD_AFTER_WAKE_MS = 30_000;

interface HeldSandboxWorkInput {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  /** Whether the thread exists on its environment, so it loads from the sandbox once awake. */
  readonly isServerThread: boolean;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly editingRunId: RunId | null;
  readonly isRunQueued: (runId: RunId) => boolean;
  readonly delivery: WorkDelivery;
  readonly threadLoading: boolean;
  /** Shows on the thread why its held work did not go, or clears that. */
  readonly setError: (message: string | null) => void;
  /** Sends the work again, now that its sandbox is awake. */
  readonly run: (work: HeldWork) => void;
}

/**
 * Delivers work to a thread whose sandbox sleeps: `hold` wakes the sandbox
 * and waits for the thread to load from it, then `run` sends the work on the
 * render that shows it connected, so it goes as it would to any running
 * environment, uploads included. The draft stays in the composer meanwhile.
 * Returns the thread's held work, for the composer to show busy.
 */
export function useHeldSandboxWork(input: HeldSandboxWorkInput) {
  const wake = useWorkCommand(threadEnvironment.wake, { reportFailure: false });
  const { threadKey, composerDraftTarget, editingRunId, delivery, threadLoading } = input;
  const held = useAtomValue(heldWorkAtom(threadKey));
  const promptChanged = useComposerDraftStore(
    (store) =>
      held !== null && (store.getComposerDraft(composerDraftTarget)?.prompt ?? "") !== held.prompt,
  );
  const editedRunQueued =
    held?.work.kind === "edit-queued" ? input.isRunQueued(held.work.runId) : true;
  // Set again when a wait's deadline passes, so the step runs again.
  const [checkedAt, setCheckedAt] = useState(Date.now);

  const settle = useEffectEvent(
    (operation: HeldOperation, step: Exclude<HeldWorkStep, { _tag: "wait" }>) => {
      if (!releaseHeldWork(appAtomRegistry, threadKey, operation.id)) return;
      if (step._tag === "drop") input.setError(step.message);
      else input.run(operation.work);
    },
  );

  useEffect(() => {
    if (held === null) return;
    const step = heldWorkStep(held, {
      promptChanged,
      editingRunId,
      editedRunQueued,
      delivery,
      loading: threadLoading,
      now: checkedAt,
    });
    if (step._tag !== "wait") {
      settle(held, step);
      return;
    }
    if (step.until === null) return;
    const timer = window.setTimeout(() => setCheckedAt(Date.now()), step.until - Date.now());
    return () => window.clearTimeout(timer);
  }, [checkedAt, delivery, editedRunQueued, editingRunId, held, promptChanged, threadLoading]);

  const hold = (work: HeldWork) => {
    const { environmentId, threadRef, isServerThread, setError } = input;
    const prompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const operation = holdWork(appAtomRegistry, threadKey, work, prompt);
    if (operation === null) return;
    setError(null);
    void (async () => {
      const woke = await wake({ environmentId, input: undefined });
      if (woke._tag === "Failure") {
        if (!releaseHeldWork(appAtomRegistry, threadKey, operation.id)) return;
        if (isAtomCommandInterrupted(woke)) return;
        const error = squashAtomCommandFailure(woke);
        setError(error instanceof Error ? error.message : "The sandbox could not wake.");
        return;
      }
      if (isServerThread && !(await waitForThreadDetail(threadRef, THREAD_LOAD_AFTER_WAKE_MS))) {
        if (releaseHeldWork(appAtomRegistry, threadKey, operation.id)) {
          setError(heldWorkFailure(work, "the sandbox woke, but this thread did not load."));
        }
        return;
      }
      markHeldWorkAwake(appAtomRegistry, threadKey, operation.id, Date.now());
    })();
  };

  return { held, hold };
}
