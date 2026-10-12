import { RunId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type HeldOperation,
  type HeldWork,
  heldWorkAtom,
  heldWorkStep,
  holdWork,
  markHeldWorkAwake,
  releaseHeldWork,
} from "./heldSandboxWork";

const RUN = RunId.make("run-queued");
const SEND: HeldWork = {
  kind: "send",
  dispatchMode: "auto",
  submissionIntent: "foreground",
  directAnnotation: undefined,
};
const EDIT: HeldWork = { kind: "edit-queued", runId: RUN };
const RESUME: HeldWork = { kind: "resume" };

const AWAKE_AT = 1_000_000;
const awake = (work: HeldWork): HeldOperation => ({
  id: 1,
  work,
  prompt: "fix the bug",
  awakeAt: AWAKE_AT,
});
const waking = (work: HeldWork): HeldOperation => ({ ...awake(work), awakeAt: null });

/** The thread as it shows once the woken sandbox is connected and loaded. */
const connected = {
  promptChanged: false,
  editingRunId: null,
  editedRunQueued: true,
  delivery: "now",
  loading: false,
  now: AWAKE_AT + 5_000,
} as const;

describe("heldWorkStep", () => {
  it("runs a send once its woken sandbox is connected and the thread loaded", () => {
    expect(heldWorkStep(awake(SEND), connected)).toEqual({ _tag: "run" });
  });

  it("waits, with no deadline, while the sandbox still wakes", () => {
    expect(heldWorkStep(waking(SEND), { ...connected, delivery: "after-wake" })).toEqual({
      _tag: "wait",
      until: null,
    });
  });

  it.each([
    ["the thread still loads", { ...connected, loading: true }],
    ["this device has yet to reach the sandbox", { ...connected, delivery: "offline" }],
  ] as const)("waits up to the reconnect budget while %s", (_case, thread) => {
    expect(heldWorkStep(awake(SEND), thread)).toEqual({
      _tag: "wait",
      until: AWAKE_AT + 120_000,
    });
  });

  it("drops a send that waited out the reconnect budget, saying so", () => {
    expect(
      heldWorkStep(awake(SEND), { ...connected, delivery: "offline", now: AWAKE_AT + 120_000 }),
    ).toEqual({
      _tag: "drop",
      message: "Not sent: this device could not reconnect to the sandbox.",
    });
  });

  it("drops work whose sandbox fell asleep again before it went, saying so", () => {
    expect(heldWorkStep(awake(SEND), { ...connected, delivery: "after-wake" })).toEqual({
      _tag: "drop",
      message: "Not sent: the sandbox fell asleep again.",
    });
    expect(heldWorkStep(awake(RESUME), { ...connected, delivery: "after-wake" })).toEqual({
      _tag: "drop",
      message: "Not resumed: the sandbox fell asleep again.",
    });
  });

  it.each([
    ["its prompt was edited", { ...connected, promptChanged: true }],
    ["the composer turned to editing a queued message", { ...connected, editingRunId: RUN }],
  ] as const)("drops a send, even while it wakes, once %s", (_case, thread) => {
    expect(heldWorkStep(waking(SEND), thread)).toEqual({
      _tag: "drop",
      message: "Not sent: the message changed while the sandbox woke.",
    });
  });

  it("saves a queued edit only as that run's edit", () => {
    expect(heldWorkStep(awake(EDIT), { ...connected, editingRunId: RUN })).toEqual({
      _tag: "run",
    });
  });

  it("never turns a queued edit whose run left the queue into a new message", () => {
    // The composer may already have moved the edit into the thread's own draft.
    expect(
      heldWorkStep(awake(EDIT), { ...connected, editingRunId: null, editedRunQueued: false }),
    ).toEqual({ _tag: "drop", message: "Not saved: the queued message is no longer queued." });
  });

  it("drops a queued edit whose edit was closed while the sandbox woke", () => {
    expect(heldWorkStep(waking(EDIT), { ...connected, editingRunId: null })).toEqual({
      _tag: "drop",
      message: "Not saved: the edit was closed before the sandbox woke.",
    });
  });

  it("resumes whatever the composer holds", () => {
    expect(heldWorkStep(awake(RESUME), { ...connected, promptChanged: true })).toEqual({
      _tag: "run",
    });
  });
});

describe("held work per thread", () => {
  it("holds one operation per thread", () => {
    const registry = AtomRegistry.make();
    const first = holdWork(registry, "env:one-per-thread", SEND, "first");
    expect(holdWork(registry, "env:one-per-thread", RESUME, "second")).toBeNull();
    expect(registry.get(heldWorkAtom("env:one-per-thread"))).toEqual(first);
  });

  it("leaves another thread's held work alone when one thread's wake ends", () => {
    const registry = AtomRegistry.make();
    const a = holdWork(registry, "env:thread-a", SEND, "to a");
    const b = holdWork(registry, "env:thread-b", SEND, "to b");
    if (a === null || b === null) throw new Error("both threads hold their work");

    expect(releaseHeldWork(registry, "env:thread-a", a.id)).toBe(true);
    markHeldWorkAwake(registry, "env:thread-b", b.id, AWAKE_AT);

    expect(registry.get(heldWorkAtom("env:thread-a"))).toBeNull();
    expect(registry.get(heldWorkAtom("env:thread-b"))).toEqual({ ...b, awakeAt: AWAKE_AT });
  });

  it("ignores a finished wake of work the thread no longer holds", () => {
    const registry = AtomRegistry.make();
    const dropped = holdWork(registry, "env:thread-c", SEND, "first");
    if (dropped === null) throw new Error("the thread holds its first work");
    releaseHeldWork(registry, "env:thread-c", dropped.id);
    const next = holdWork(registry, "env:thread-c", SEND, "second");

    markHeldWorkAwake(registry, "env:thread-c", dropped.id, AWAKE_AT);
    expect(releaseHeldWork(registry, "env:thread-c", dropped.id)).toBe(false);
    expect(registry.get(heldWorkAtom("env:thread-c"))).toEqual(next);
  });
});
