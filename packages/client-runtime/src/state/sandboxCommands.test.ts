import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  SandboxAccountId,
  SandboxId,
  SandboxManagedByOwnerError,
  type SandboxStatus,
  type SandboxView,
  ThreadId,
  CommandId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { routeSandboxThreadLifecycle, type SandboxOwnerChange } from "./sandboxCommands.ts";

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");
const SEED = v2ThreadShell.id;
const OTHER = ThreadId.make("thread-other");

const snapshotWith = (...extra: ReadonlyArray<typeof v2ThreadShell>) => ({
  ...v2ShellSnapshot,
  threads: [v2ThreadShell, ...extra],
});
const child = {
  ...v2ThreadShell,
  id: ThreadId.make("thread-child"),
  lineage: { rootThreadId: SEED, parentThreadId: SEED, relationshipToParent: "subagent" as const },
};

const run = (
  input: {
    readonly action: "archive" | "unarchive";
    readonly status?: SandboxStatus;
    readonly threadId?: ThreadId;
    readonly snapshot?: typeof v2ShellSnapshot | null;
  },
  guest: Effect.Effect<string, SandboxManagedByOwnerError | OrchestrationV2DispatchCommandError>,
) =>
  Effect.gen(function* () {
    const owners = yield* SubscriptionRef.make<
      ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>
    >(
      new Map(
        input.status === undefined
          ? []
          : [
              [
                OWNER,
                [
                  {
                    id: SANDBOX_ID,
                    accountId: SandboxAccountId.make("work"),
                    title: "Fix the bug",
                    repository: { remoteUrl: "https://example.test/repo.git", commit: null },
                    status: input.status,
                    environmentId: SANDBOX_ENV,
                    httpBaseUrl: "https://sbx-1.boat.test",
                    createdAt: "2026-10-09T12:00:00.000Z",
                  },
                ],
              ],
            ],
      ),
    );
    const changes: Array<SandboxOwnerChange> = [];
    const result = yield* routeSandboxThreadLifecycle({
      action: input.action,
      environmentId: SANDBOX_ENV,
      threadId: input.threadId ?? SEED,
      snapshot: input.snapshot === undefined ? snapshotWith(child) : input.snapshot,
      run: guest,
      toOwner: (change) => Effect.sync(() => changes.push(change)).pipe(Effect.as("owner")),
    }).pipe(
      Effect.provideService(
        SandboxRegistrations.SandboxRegistrations,
        SandboxRegistrations.SandboxRegistrations.of({ owners, start: Effect.void }),
      ),
    );
    return { result, changes };
  });

const guestOk = Effect.succeed("guest");
const ready: SandboxStatus = { _tag: "ready" };
const stopped: SandboxStatus = { _tag: "stopped", reason: "requested" };
const ownerChange = (desired: SandboxOwnerChange["desired"]) => [
  { ownerEnvironmentId: OWNER, sandboxId: SANDBOX_ID, desired },
];

describe("routeSandboxThreadLifecycle", () => {
  it.effect("archiving a sandbox's last active top-level thread stops the sandbox", () =>
    Effect.gen(function* () {
      // A subagent child does not keep the sandbox running.
      const routed = yield* run({ action: "archive", status: ready }, guestOk);
      expect(routed).toEqual({ result: "owner", changes: ownerChange("stopped") });
    }),
  );

  it.effect("archiving one of several active threads archives it in the sandbox", () =>
    Effect.gen(function* () {
      const other = {
        ...v2ThreadShell,
        id: OTHER,
        lineage: { ...v2ThreadShell.lineage, rootThreadId: OTHER },
      };
      const routed = yield* run(
        { action: "archive", status: ready, threadId: OTHER, snapshot: snapshotWith(other) },
        guestOk,
      );
      expect(routed).toEqual({ result: "guest", changes: [] });
    }),
  );

  it.effect("a sandbox that refuses to archive its seed thread is stopped by its owner", () =>
    Effect.gen(function* () {
      const refused = new SandboxManagedByOwnerError({
        ownerEnvironmentId: OWNER,
        sandboxId: SANDBOX_ID,
        operation: "archive-thread",
      });
      // Not in the index: the client has not heard from the owner since it started.
      const routed = yield* run({ action: "archive", snapshot: null }, Effect.fail(refused));
      expect(routed).toEqual({ result: "owner", changes: ownerChange("stopped") });
    }),
  );

  it.effect("unarchiving a thread of a stopped sandbox resumes it", () =>
    Effect.gen(function* () {
      const routed = yield* run({ action: "unarchive", status: stopped }, guestOk);
      expect(routed).toEqual({ result: "owner", changes: ownerChange("running") });
    }),
  );

  it.effect("unarchiving in a running sandbox, or outside one, stays in the environment", () =>
    Effect.gen(function* () {
      expect(yield* run({ action: "unarchive", status: ready }, guestOk)).toEqual({
        result: "guest",
        changes: [],
      });
      const failure = new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make("unarchive"),
        commandType: "thread.unarchive",
        message: "Failed",
      });
      const error = yield* Effect.flip(run({ action: "unarchive" }, Effect.fail(failure)));
      expect(error).toBe(failure);
    }),
  );
});
