/**
 * What an owner needs to know about the agents in a sandbox to decide when
 * to stop it, reduced from the guest's shell snapshot.
 *
 * @module sandboxActivity
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface SandboxGuestActivity {
  /** Some thread has a run that is preparing, starting, running, or waiting on the user. */
  readonly busy: boolean;
  /** The latest change to any thread, in epoch milliseconds; 0 when there are none. */
  readonly lastActivityAt: number;
}

type ActivityThread = Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "updatedAt">;

/**
 * A run waiting on an approval or an answer counts as busy: restarting the
 * guest's server expires those requests, so a stop would lose them.
 */
export function guestActivity(shell: {
  readonly threads: ReadonlyArray<ActivityThread>;
  readonly archivedThreads: ReadonlyArray<ActivityThread>;
}): SandboxGuestActivity {
  let busy = false;
  let lastActivityAt = 0;
  for (const thread of [...shell.threads, ...shell.archivedThreads]) {
    if (thread.activityRunStatus != null) busy = true;
    lastActivityAt = Math.max(lastActivityAt, DateTime.toEpochMillis(thread.updatedAt));
  }
  return { busy, lastActivityAt };
}
