import { OrchestratorMcpFailure, SandboxAccountId, SandboxId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { toSandboxError, type SandboxFailure } from "../../../sandbox/sandboxErrors.ts";
import * as SandboxService from "../../../sandbox/SandboxService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { SandboxToolkit } from "./tools.ts";

const toFailure = (error: SandboxFailure) => {
  const { code, message } = toSandboxError(error);
  return new OrchestratorMcpFailure({
    code: code === "provider" || code === "unavailable" ? "orchestration_error" : "invalid_request",
    message,
  });
};

export const layer = McpToolAccess.toLayer(
  SandboxToolkit,
  Effect.gen(function* () {
    const sandboxes = yield* SandboxService.SandboxService;
    const settings = yield* Settings.ServerSettingsService;
    const crypto = yield* Crypto.Crypto;
    return {
      sandbox_launch: McpToolAccess.startsThreads(
        (params) => params,
        (params, modes) =>
          Effect.gen(function* () {
            const id = params.id ?? SandboxId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
            return yield* sandboxes
              .launch({ ...params, ...modes, id })
              .pipe(Effect.mapError(toFailure));
          }),
      ),
      sandbox_update: McpToolAccess.writes((params) =>
        sandboxes.update(params).pipe(Effect.mapError(toFailure)),
      ),
      sandbox_list: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          const views = yield* sandboxes.list().pipe(Effect.mapError(toFailure));
          return {
            accounts: Object.entries(current.sandboxAccounts).map(([id, account]) => ({
              id: SandboxAccountId.make(id),
              label: account.label,
              provider: account.provider,
            })),
            sandboxes: views,
          };
        }),
      ),
    };
  }),
);
