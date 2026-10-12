import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  SANDBOX_RECONNECT_TIMEOUT,
  type WorkDelivery,
} from "@t3tools/client-runtime/state/sandboxes";
import type { PreviewAnnotationPayload, RunId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { ComposerImageAttachment } from "../../composerDraftStore";

/**
 * Work the composer sent to a thread whose sandbox sleeps (`WorkDelivery`
 * "after-wake"). It is held while the sandbox wakes, then sent as it would
 * go to any running environment.
 */
export type HeldWork =
  | {
      readonly kind: "send";
      readonly dispatchMode: ComposerDispatchMode;
      readonly submissionIntent: ComposerSubmissionIntent;
      readonly directAnnotation:
        | {
            readonly annotation: PreviewAnnotationPayload;
            readonly image: ComposerImageAttachment | null;
          }
        | undefined;
    }
  /** Saving the composer's edit of a queued message, which only ever saves to that run. */
  | { readonly kind: "edit-queued"; readonly runId: RunId }
  | { readonly kind: "resume" };

/** How the wake for held work went. */
export type HeldWake =
  | { readonly _tag: "waking" }
  /** The sandbox woke and the thread loaded from it. */
  | { readonly _tag: "awake"; readonly at: number }
  /** `message`: why not, as the thread shows it; null when the wake was called off. */
  | { readonly _tag: "failed"; readonly message: string | null };

/** Work held for the thread on screen. It ends when the user leaves the thread. */
export interface HeldOperation {
  readonly threadKey: string;
  readonly work: HeldWork;
  /** The composer's prompt when the work was sent; editing it drops a send or an edit. */
  readonly prompt: string;
  readonly wake: HeldWake;
}

export type HeldWorkStep =
  /** `until`: when the wait gives up; null while the sandbox wakes, which the wake itself bounds. */
  | { readonly _tag: "wait"; readonly until: number | null }
  | { readonly _tag: "run" }
  /** `message`: why, for the held work's thread; null when something else already said so. */
  | { readonly _tag: "drop"; readonly message: string | null };

const RECONNECT_MS = Duration.toMillis(SANDBOX_RECONNECT_TIMEOUT);

const NOT_DONE: Record<HeldWork["kind"], string> = {
  send: "Not sent",
  "edit-queued": "Not saved",
  resume: "Not resumed",
};

/** Why held work did not go, as its thread shows it. The draft stays in the composer. */
export function heldWorkFailure(work: HeldWork, reason: string): string {
  return `${NOT_DONE[work.kind]}: ${reason}`;
}

const drop = (work: HeldWork, reason: string): HeldWorkStep => ({
  _tag: "drop",
  message: heldWorkFailure(work, reason),
});

/**
 * What held work does on a render of the thread on screen. It runs once its
 * woken sandbox is connected and the thread loaded, as long as the composer
 * still shows what was sent. Anything else that ends it is dropped with why:
 * the user left the thread, the message changed, the sandbox could not wake
 * or fell asleep again, or this device did not reach the woken sandbox within
 * the reconnect budget.
 */
export function heldWorkStep(
  held: HeldOperation,
  thread: {
    readonly threadKey: string;
    readonly promptChanged: boolean;
    /** The queued run the composer edits, if any. */
    readonly editingRunId: RunId | null;
    /** Whether the run an `edit-queued` hold saves to is still queued. */
    readonly editedRunQueued: boolean;
    readonly delivery: WorkDelivery;
    readonly loading: boolean;
    readonly now: number;
  },
): HeldWorkStep {
  const { work, wake } = held;
  if (held.threadKey !== thread.threadKey) {
    return drop(work, "you left the thread while the sandbox woke.");
  }
  switch (work.kind) {
    case "edit-queued":
      // The composer tells the user itself when the queued message it edits leaves the queue.
      if (!thread.editedRunQueued) return { _tag: "drop", message: null };
      if (thread.editingRunId !== work.runId) {
        return drop(work, "the edit was closed before the sandbox woke.");
      }
      if (thread.promptChanged) return drop(work, "the message changed while the sandbox woke.");
      break;
    case "send":
      if (thread.editingRunId !== null || thread.promptChanged) {
        return drop(work, "the message changed while the sandbox woke.");
      }
      break;
    case "resume":
      break;
  }
  switch (wake._tag) {
    case "waking":
      return { _tag: "wait", until: null };
    case "failed":
      return { _tag: "drop", message: wake.message };
    case "awake":
      break;
  }
  if (thread.delivery === "after-wake") return drop(work, "the sandbox fell asleep again.");
  if (thread.delivery === "now" && !thread.loading) return { _tag: "run" };
  const until = wake.at + RECONNECT_MS;
  return thread.now < until
    ? { _tag: "wait", until }
    : drop(work, "this device could not reconnect to the sandbox.");
}
