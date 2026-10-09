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
import { routeSandboxThreadLifecycle, type SandboxOwnerChange } from "./sandboxCommands.ts";

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");
const run = (
  input: {
    readonly action: "archive" | "unarchive";
    readonly status?: SandboxStatus;
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
                    message: "Fix the bug in hello.txt",
                    repository: { remoteUrl: "https://example.test/repo.git", commit: null },
                    threadId: ThreadId.make("thread-seed"),
                    desired: "running",
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
  it.effect("an archive the sandbox refuses as its last active thread stops the sandbox", () =>
    Effect.gen(function* () {
      const refused = new SandboxManagedByOwnerError({
        ownerEnvironmentId: OWNER,
        sandboxId: SANDBOX_ID,
        operation: "archive-thread",
      });
      let asked = 0;
      const guest = Effect.suspend(() => {
        asked += 1;
        return Effect.fail(refused);
      });
      expect(yield* run({ action: "archive", status: ready }, guest)).toEqual({
        result: "owner",
        changes: ownerChange("stopped"),
      });
      // Not in the index: the client has not heard from the owner since it started.
      expect(yield* run({ action: "archive" }, guest)).toEqual({
        result: "owner",
        changes: ownerChange("stopped"),
      });
      expect(asked).toBe(2);
    }),
  );

  it.effect("an archive the sandbox accepts stays in the sandbox", () =>
    Effect.gen(function* () {
      const routed = yield* run({ action: "archive", status: ready }, guestOk);
      expect(routed).toEqual({ result: "guest", changes: [] });
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
