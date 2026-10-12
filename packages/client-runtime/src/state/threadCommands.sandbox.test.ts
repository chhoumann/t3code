import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  SandboxAccountId,
  SandboxId,
  type SandboxStatus,
  type SandboxUpdateInput,
  type SandboxView,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as SandboxRegistrations from "../sandbox/sandboxRegistrations.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

// The owner grants this device `operate`, so its `sandboxes.update` may wake the sandbox.
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => operateGranted }),
}));
const operateGranted = Atom.make(
  AsyncResult.success<AuthSessionState>({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  }),
);

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");

const sandboxView = (status: SandboxStatus, desired: SandboxView["desired"]): SandboxView => ({
  id: SANDBOX_ID,
  accountId: SandboxAccountId.make("work"),
  title: "Fix the bug",
  message: "Fix the bug in hello.txt",
  repository: {
    remotes: [{ name: "origin", url: "https://example.test/repo.git" }],
    trackedRemote: "origin",
    commit: null,
  },
  threadId: ThreadId.make("thread-seed"),
  desired,
  status,
  environmentId: SANDBOX_ENV,
  httpBaseUrl: "https://sbx-1.boat.test",
  createdAt: "2026-10-09T12:00:00.000Z",
});

/**
 * One device's thread commands against a sandbox whose owner it is connected
 * to. The owner records every change it is asked for; the sandbox records
 * every command once the test opens this device's socket to it.
 */
const makeHarness = Effect.fn("TestSandboxThreadCommands.makeHarness")(function* (
  initial: SandboxView,
) {
  const owners = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>
  >(new Map([[OWNER, [initial]]]));
  const showStatus = (status: SandboxStatus) =>
    SubscriptionRef.set(owners, new Map([[OWNER, [sandboxView(status, "running")]]]));
  const asked: Array<SandboxUpdateInput> = [];
  const dispatched: Array<OrchestrationV2Command> = [];
  const ownerSession = {
    client: {
      [WS_METHODS.sandboxesUpdate]: (input: SandboxUpdateInput) =>
        Effect.sync(() => {
          asked.push(input);
          return sandboxView(initial.status, input.desired);
        }),
    },
  } as unknown as RpcSession;
  const sandboxSession = {
    client: {
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () =>
        Effect.succeed({ thread: { archivedAt: "2026-10-09T13:00:00.000Z" } }),
    },
  } as unknown as RpcSession;
  const sessions = new Map([
    [OWNER, yield* SubscriptionRef.make(Option.some(ownerSession))],
    [SANDBOX_ENV, yield* SubscriptionRef.make(Option.none<RpcSession>())],
  ]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: { environmentId },
        session: sessions.get(environmentId)!,
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
    );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        entries: yield* SubscriptionRef.make(new Map()),
        run,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        SandboxRegistrations.SandboxRegistrations,
        SandboxRegistrations.SandboxRegistrations.of({ owners, start: Effect.void }),
      ),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const commands = createThreadEnvironmentAtoms(runtime, () => Atom.make(null));
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    commands,
    registry,
    asked,
    dispatched,
    showStatus,
    connect: SubscriptionRef.set(sessions.get(SANDBOX_ENV)!, Option.some(sandboxSession)),
  };
});

const send = (threadId: string) => ({
  environmentId: SANDBOX_ENV,
  input: {
    threadId: ThreadId.make(threadId),
    message: {
      messageId: MessageId.make(`message-${threadId}`),
      role: "user" as const,
      text: "Carry on",
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    dispatchMode: "start" as const,
  },
});

describe("thread commands in a sandbox", () => {
  it.effect("two sends to an asleep sandbox ask its owner once, then both start", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(sandboxView({ _tag: "stopped", reason: "external" }, "running"));
      const first = h.commands.startTurn.run(h.registry, send("thread-a"));
      const second = h.commands.startTurn.run(h.registry, send("thread-b"));
      yield* Effect.yieldNow;
      expect(h.asked).toEqual([{ id: SANDBOX_ID, desired: "running" }]);

      yield* h.showStatus({ _tag: "resuming" });
      yield* h.showStatus({ _tag: "ready" });
      yield* h.connect;
      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
      expect(h.asked).toHaveLength(1);
      expect(
        h.dispatched.map((command) => [command.type, "threadId" in command && command.threadId]),
      ).toEqual([
        ["message.dispatch", "thread-a"],
        ["message.dispatch", "thread-b"],
      ]);
    }),
  );

  it.effect("unarchiving a thread of a put-away sandbox wakes it, then unarchives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        sandboxView({ _tag: "stopped", reason: "requested" }, "stopped"),
      );
      const result = h.commands.unarchive.run(h.registry, {
        environmentId: SANDBOX_ENV,
        input: { threadId: ThreadId.make("thread-seed") },
      });
      yield* Effect.yieldNow;
      expect(h.asked).toEqual([{ id: SANDBOX_ID, desired: "running" }]);

      yield* h.showStatus({ _tag: "ready" });
      yield* h.connect;
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      expect(h.dispatched.map((command) => command.type)).toEqual(["thread.unarchive"]);
    }),
  );
});
