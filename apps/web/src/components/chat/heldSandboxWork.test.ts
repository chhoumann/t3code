import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type HeldOperation, type HeldWork, heldWorkStep } from "./heldSandboxWork";

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
  threadKey: "env:thread",
  work,
  prompt: "fix the bug",
  wake: { _tag: "awake", at: AWAKE_AT },
});
const waking = (work: HeldWork): HeldOperation => ({ ...awake(work), wake: { _tag: "waking" } });

/** The thread as it shows once the woken sandbox is connected and loaded. */
const connected = {
  threadKey: "env:thread",
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

  it("drops work whose sandbox could not wake with why, and silently when the wake was called off", () => {
    const failed = (message: string | null): HeldOperation => ({
      ...awake(SEND),
      wake: { _tag: "failed", message },
    });
    expect(heldWorkStep(failed("The machine did not start in time."), connected)).toEqual({
      _tag: "drop",
      message: "The machine did not start in time.",
    });
    expect(heldWorkStep(failed(null), connected)).toEqual({ _tag: "drop", message: null });
  });

  it("drops work for the thread the user left, saying so on that thread", () => {
    const elsewhere = { ...connected, threadKey: "env:other-thread" };
    expect(heldWorkStep(waking(SEND), elsewhere)).toEqual({
      _tag: "drop",
      message: "Not sent: you left the thread while the sandbox woke.",
    });
    // Even work that could go now, so it never sends to a thread that is no longer on screen.
    expect(heldWorkStep(awake(EDIT), { ...elsewhere, editingRunId: RUN })).toEqual({
      _tag: "drop",
      message: "Not saved: you left the thread while the sandbox woke.",
    });
    expect(heldWorkStep(awake(RESUME), elsewhere)).toEqual({
      _tag: "drop",
      message: "Not resumed: you left the thread while the sandbox woke.",
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
    // The composer may already have moved the edit into the thread's own draft, and tells the
    // user about it itself.
    expect(
      heldWorkStep(awake(EDIT), { ...connected, editingRunId: null, editedRunQueued: false }),
    ).toEqual({ _tag: "drop", message: null });
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
