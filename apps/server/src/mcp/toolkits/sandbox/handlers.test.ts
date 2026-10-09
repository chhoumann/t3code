import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SandboxAccountId,
  SandboxId,
  ThreadId,
  type SandboxLaunchInput,
} from "@t3tools/contracts";
import { McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedSandbox from "../../../sandbox/ManagedSandbox.ts";
import * as SandboxService from "../../../sandbox/SandboxService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as SandboxHandlers from "./handlers.ts";
import { SandboxToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:sandbox");
const threadId = ThreadId.make("thread:sandbox");
const accountId = SandboxAccountId.make("boat-work");

it.effect("launches a sandbox within the calling thread's modes", () =>
  Effect.gen(function* () {
    const launched: Array<SandboxLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:sandbox",
        thread: {
          threadId,
          providerSessionId: "provider:sandbox",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            liveThreadShell(threadId, {
              runtimeMode: "approval-required",
              interactionMode: "default",
            }),
          ),
      }),
      Layer.mock(SandboxService.SandboxService)({
        launch: (input) =>
          Effect.sync(() => {
            launched.push(input);
            return {
              id: input.id,
              accountId: input.accountId,
              title: input.title,
              message: input.message,
              repository: input.repository,
              threadId: ThreadId.make("thread-seed"),
              desired: "running" as const,
              status: { _tag: "creating" as const },
              environmentId: null,
              httpBaseUrl: null,
              createdAt: "2026-10-09T12:00:00.000Z",
            };
          }),
      }),
      Settings.layerTest(),
      NodeCrypto.layer,
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* SandboxToolkit;
      const launch = (modes: { readonly runtimeMode?: "full-access" }) =>
        toolkit
          .handle("sandbox_launch", {
            accountId,
            title: "Fix the bug",
            message: "Fix the bug in hello.txt",
            repository: { remoteUrl: "https://github.com/octocat/Hello-World", commit: null },
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
            ...modes,
          })
          .pipe(Stream.unwrap, Stream.runCollect);

      const escalated = yield* launch({ runtimeMode: "full-access" });
      expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(launched).toHaveLength(0);

      yield* launch({});
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        accountId,
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      expect(launched[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SandboxHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect("offers sandbox tools on an owner and none inside a sandbox", () =>
  Effect.gen(function* () {
    const toolNames = (managed: ManagedSandbox.ManagedSandboxGuest | null) =>
      McpServer.McpServer.pipe(
        Effect.map((server) => server.tools.map((tool) => tool.tool.name)),
        Effect.provide(
          McpHttpServer.layerSandboxToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ThreadManagement.ThreadManagementService)({}),
                Layer.mock(SandboxService.SandboxService)({}),
                Settings.layerTest(),
                NodeCrypto.layer,
              ),
            ),
            Layer.provide(Layer.succeed(ManagedSandbox.ManagedSandbox, managed)),
          ),
        ),
      );

    expect(yield* toolNames(null)).toContain("sandbox_launch");
    const guest = ManagedSandbox.makeManagedSandboxGuest({
      ownerEnvironmentId: environmentId,
      sandboxId: SandboxId.make("sbx-1"),
    });
    expect((yield* toolNames(guest)).filter((name) => name.startsWith("sandbox_"))).toEqual([]);
  }),
);
