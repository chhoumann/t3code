import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { guestActivity } from "./sandboxActivity.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const thread = (
  activityRunStatus: "preparing" | "starting" | "running" | "waiting" | null,
  updatedAt: number,
) => ({ activityRunStatus, updatedAt: DateTime.makeUnsafe(updatedAt) });

describe("guestActivity", () => {
  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "a thread whose run is %s keeps the sandbox busy",
    (status) => {
      expect(
        guestActivity({
          threads: [thread(null, NOW - 2 * MINUTE), thread(status, NOW - 5 * MINUTE)],
          archivedThreads: [],
        }),
      ).toEqual({ busy: true, lastActivityAt: NOW - 2 * MINUTE });
    },
  );

  it("is idle since the latest change to any thread, archived ones included", () => {
    expect(
      guestActivity({
        threads: [thread(null, NOW - 30 * MINUTE)],
        archivedThreads: [thread(null, NOW - 10 * MINUTE)],
      }),
    ).toEqual({ busy: false, lastActivityAt: NOW - 10 * MINUTE });
  });

  it("has no activity at all without threads", () => {
    expect(guestActivity({ threads: [], archivedThreads: [] })).toEqual({
      busy: false,
      lastActivityAt: 0,
    });
  });
});
