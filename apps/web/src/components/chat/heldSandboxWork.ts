import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  SANDBOX_RECONNECT_TIMEOUT,
  type WorkDelivery,
} from "@t3tools/client-runtime/state/sandboxes";
import type { PreviewAnnotationPayload, RunId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { Atom, type AtomRegistry } from "effect/reactivity";

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

/** One thread's held work. A thread holds at most one. */
export interface HeldOperation {
  /** Tells this hold from a later one for the same thread. */
  readonly id: number;
  readonly work: HeldWork;
  /** The composer's prompt when the work was sent; editing it drops a send or an edit. */
  readonly prompt: string;
  /** When the sandbox woke and the thread loaded; null while it wakes. */
  readonly awakeAt: number | null;
}

export type HeldWorkStep =
  /** `until`: when the wait gives up; null while the sandbox wakes, which the wake itself bounds. */
  | { readonly _tag: "wait"; readonly until: number | null }
  | { readonly _tag: "run" }
  | { readonly _tag: "drop"; readonly message: string };

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
 * What held work does on a render of its thread. It runs once its woken
 * sandbox is connected and the thread loaded, as long as the composer still
 * shows what was sent. Anything else that ends it is dropped with why: the
 * message changed, the queued message it edits left the queue, the sandbox
 * fell asleep again, or this device did not reach the woken sandbox within
 * the reconnect budget.
 */
export function heldWorkStep(
  held: HeldOperation,
  thread: {
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
  const { work } = held;
  switch (work.kind) {
    case "edit-queued":
      if (!thread.editedRunQueued) return drop(work, "the queued message is no longer queued.");
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
  if (held.awakeAt === null) return { _tag: "wait", until: null };
  if (thread.delivery === "after-wake") return drop(work, "the sandbox fell asleep again.");
  if (thread.delivery === "now" && !thread.loading) return { _tag: "run" };
  const until = held.awakeAt + RECONNECT_MS;
  return thread.now < until
    ? { _tag: "wait", until }
    : drop(work, "this device could not reconnect to the sandbox.");
}

/** Each thread's held work, by thread key. */
export const heldWorkAtom = Atom.family((_threadKey: string) =>
  Atom.make<HeldOperation | null>(null).pipe(Atom.keepAlive),
);

let lastHeldWorkId = 0;

/** Holds `work` for the thread, unless it already holds some; returns the hold, or null. */
export function holdWork(
  registry: AtomRegistry.AtomRegistry,
  threadKey: string,
  work: HeldWork,
  prompt: string,
): HeldOperation | null {
  const atom = heldWorkAtom(threadKey);
  if (registry.get(atom) !== null) return null;
  const held: HeldOperation = { id: ++lastHeldWorkId, work, prompt, awakeAt: null };
  registry.set(atom, held);
  return held;
}

/** Marks hold `id` awake, unless the thread no longer holds it. */
export function markHeldWorkAwake(
  registry: AtomRegistry.AtomRegistry,
  threadKey: string,
  id: number,
  now: number,
): void {
  registry.update(heldWorkAtom(threadKey), (current) =>
    current?.id === id ? { ...current, awakeAt: now } : current,
  );
}

/**
 * Releases hold `id`. False when the thread no longer holds it, so how it
 * ended was already reported and is not the caller's to report.
 */
export function releaseHeldWork(
  registry: AtomRegistry.AtomRegistry,
  threadKey: string,
  id: number,
): boolean {
  const atom = heldWorkAtom(threadKey);
  if (registry.get(atom)?.id !== id) return false;
  registry.set(atom, null);
  return true;
}
