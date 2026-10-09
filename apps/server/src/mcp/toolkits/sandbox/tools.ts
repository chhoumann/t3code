import {
  OrchestratorMcpFailure,
  SandboxAccountConfig,
  SandboxAccountId,
  SandboxLaunchInput,
  SandboxUpdateInput,
  SandboxView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SandboxService from "../../../sandbox/SandboxService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SandboxService.SandboxService,
    Settings.ServerSettingsService,
  ],
};

const SandboxLaunchTool = Tool.make("sandbox_launch", {
  ...shared,
  description:
    "Create a sandbox machine under one of this environment's sandbox accounts (see sandbox_list), clone repository.remoteUrl into it, and start a thread there with message. Returns at once with status creating; call sandbox_list to follow it to ready. Pass the same id again to retry without creating a second machine. runtimeMode and interactionMode default to, and may not exceed, the caller's own.",
  parameters: Schema.Struct({
    id: Schema.optionalKey(SandboxLaunchInput.fields.id),
    accountId: SandboxLaunchInput.fields.accountId,
    title: SandboxLaunchInput.fields.title,
    message: SandboxLaunchInput.fields.message,
    repository: SandboxLaunchInput.fields.repository,
    driver: SandboxLaunchInput.fields.driver,
    model: SandboxLaunchInput.fields.model,
    runtimeMode: Schema.optionalKey(SandboxLaunchInput.fields.runtimeMode),
    interactionMode: Schema.optionalKey(SandboxLaunchInput.fields.interactionMode),
  }),
  success: SandboxView,
}).annotate(Tool.Destructive, false);

const SandboxUpdateTool = Tool.make("sandbox_update", {
  ...shared,
  description:
    "Ask for a sandbox machine to be running, stopped (kept, free while stopped), or destroyed (deleted for good). Asking again for the current state retries a failed sandbox.",
  parameters: SandboxUpdateInput,
  success: SandboxView,
}).annotate(Tool.Destructive, true);

const SandboxListTool = Tool.make("sandbox_list", {
  ...shared,
  description:
    "List the sandbox accounts this environment can launch sandboxes under, and every sandbox it owns with its status.",
  success: Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        id: SandboxAccountId,
        label: SandboxAccountConfig.fields.label,
        provider: SandboxAccountConfig.fields.provider,
      }),
    ),
    sandboxes: Schema.Array(SandboxView),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const SandboxToolkit = Toolkit.make(SandboxLaunchTool, SandboxUpdateTool, SandboxListTool);
