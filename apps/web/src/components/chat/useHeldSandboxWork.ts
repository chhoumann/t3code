import { type WorkDelivery, sandboxCommandFailure } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { waitForThreadDetail } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useWorkCommand } from "../../state/use-orchestration-command";
import {
  type HeldOperation,
  type HeldWake,
  type HeldWork,
  type HeldWorkStep,
  heldWorkFailure,
  heldWorkStep,
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
  /** Shows on a thread why its held work did not go, or clears that. */
  readonly setError: (threadKey: string, message: string | null) => void;
  /** Sends the work again, now that its sandbox is awake; false when the thread is busy. */
  readonly run: (work: HeldWork) => boolean;
}

/**
 * Delivers work to the thread on screen while its sandbox sleeps: `hold`
 * wakes the sandbox and waits for the thread to load from it, then `run`
 * sends the work on the render that shows it connected, so it goes as it
 * would to any running environment, uploads included. The draft stays in
 * the composer meanwhile, and leaving the thread drops the work.
 */
export function useHeldSandboxWork(input: HeldSandboxWorkInput) {
  const wake = useWorkCommand(threadEnvironment.wake, { reportFailure: false });
  const { threadKey, composerDraftTarget, editingRunId, delivery, threadLoading } = input;
  const [held, setHeld] = useState<HeldOperation | null>(null);
  // The hold as it is now, for a wake that ends or a step that settles between renders.
  const heldRef = useRef<HeldOperation | null>(null);
  /** Replaces hold `from` with `to`; false, changing nothing, once `from` is not the hold. */
  const replaceHeld = (from: HeldOperation | null, to: HeldOperation | null) => {
    if (heldRef.current !== from) return false;
    heldRef.current = to;
    setHeld(to);
    return true;
  };
  const promptChanged = useComposerDraftStore(
    (store) =>
      held !== null && (store.getComposerDraft(composerDraftTarget)?.prompt ?? "") !== held.prompt,
  );
  const editedRunQueued =
    held?.work.kind === "edit-queued" ? input.isRunQueued(held.work.runId) : true;

  const settle = useEffectEvent(
    (operation: HeldOperation, step: Exclude<HeldWorkStep, { _tag: "wait" }>) => {
      if (!replaceHeld(operation, null)) return;
      if (step._tag === "drop") {
        if (step.message !== null) input.setError(operation.threadKey, step.message);
      } else if (!input.run(operation.work)) {
        const busy = heldWorkFailure(operation.work, "the thread was busy once the sandbox woke.");
        input.setError(operation.threadKey, busy);
      }
    },
  );

  useEffect(() => {
    if (held === null) return;
    let timer: number | undefined;
    // Runs again when a wait's deadline passes.
    const check = () => {
      const step = heldWorkStep(held, {
        threadKey,
        promptChanged,
        editingRunId,
        editedRunQueued,
        delivery,
        loading: threadLoading,
        now: Date.now(),
      });
      if (step._tag !== "wait") settle(held, step);
      else if (step.until !== null) timer = window.setTimeout(check, step.until - Date.now());
    };
    check();
    return () => window.clearTimeout(timer);
  }, [delivery, editedRunQueued, editingRunId, held, promptChanged, threadKey, threadLoading]);

  const hold = (work: HeldWork) => {
    const { environmentId, threadRef, isServerThread } = input;
    const operation: HeldOperation = {
      threadKey,
      work,
      prompt: useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "",
      wake: { _tag: "waking" },
    };
    if (!replaceHeld(null, operation)) return;
    input.setError(threadKey, null);
    const wakeSandbox = async (): Promise<HeldWake> => {
      const woke = await wake({ environmentId });
      if (woke._tag === "Failure") return { _tag: "failed", message: sandboxCommandFailure(woke) };
      if (isServerThread && !(await waitForThreadDetail(threadRef, THREAD_LOAD_AFTER_WAKE_MS))) {
        return {
          _tag: "failed",
          message: heldWorkFailure(work, "the sandbox woke, but this thread did not load."),
        };
      }
      return { _tag: "awake", at: Date.now() };
    };
    void wakeSandbox().then((outcome) => replaceHeld(operation, { ...operation, wake: outcome }));
  };

  return {
    /** Whether the thread on screen holds work, for the composer to show busy. */
    holding: held !== null && held.threadKey === threadKey,
    /** Whether work is held right now, which turns other sends and resumes away. */
    isHolding: () => heldRef.current !== null,
    hold,
  };
}
