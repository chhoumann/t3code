/**
 * SandboxGuest - what an owner environment does to the T3 server inside one
 * of its sandboxes: mint the owner's admin session, prepare the checkout,
 * launch the seed thread, and mint client pairing grants.
 *
 * The guest is reached over its public HTTP API and RPC socket with the
 * admin bearer, the same seams any remote client uses. Its MCP endpoint is
 * not one of them: it accepts only MCP client sessions and allocates its own
 * thread ids, so a retried launch would create a second thread.
 *
 * @module SandboxGuest
 */
import {
  CommandId,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
  defaultInstanceIdForDriver,
  type MessageId,
  type ProjectId,
  type ProjectScript,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import {
  SANDBOX_ENV_FILE,
  SANDBOX_T3_BIN,
  SANDBOX_T3_HOME,
  shellQuote,
} from "./sandboxBootScript.ts";
import {
  SandboxProvider,
  type ProviderMachineId,
  type SandboxProviderAccount,
  type SandboxProviderError,
} from "./SandboxProvider.ts";

/** An authenticated route to a guest T3 server. */
export interface SandboxGuestTarget {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string>;
}

export interface SandboxCheckout {
  readonly remoteUrl: string;
  /** Checked out after cloning; null keeps the remote's default branch. */
  readonly commit: string | null;
  /** Absolute path in the guest. */
  readonly path: string;
}

/** Ids are allocated once by the owner and reused on every retry. */
export interface SandboxSeedThread {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly title: string;
  readonly message: string;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const SandboxGuestOperation = Schema.Literals([
  "mint-session",
  "clone",
  "create-project",
  "launch-thread",
  "issue-pairing",
]);
export type SandboxGuestOperation = typeof SandboxGuestOperation.Type;

const OPERATION_SUMMARY: Record<SandboxGuestOperation, string> = {
  "mint-session": "mint the owner session on the sandbox",
  clone: "clone the repository in the sandbox",
  "create-project": "create the sandbox project",
  "launch-thread": "launch the sandbox thread",
  "issue-pairing": "issue a pairing grant for the sandbox",
};

export class SandboxGuestError extends Schema.TaggedError<SandboxGuestError>()(
  "SandboxGuestError",
  {
    operation: SandboxGuestOperation,
    exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not ${OPERATION_SUMMARY[this.operation]}.`;
  }
}

const decodeIssuedSession = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);
const GUEST_CALL_TIMEOUT = Duration.seconds(60);
const CLONE_TIMEOUT_SECONDS = 600;
const T3_PROJECT_FILE_MARKER = "--- t3.json ---";

/** The command the owner runs in the guest to clone idempotently and read `t3.json`. */
function renderCloneCommand(checkout: SandboxCheckout): string {
  const path = shellQuote(checkout.path);
  const partial = shellQuote(`${checkout.path}.partial`);
  return [
    "set -euo pipefail",
    // The account env carries any Git credentials the account provides.
    `set -a && . ${shellQuote(SANDBOX_ENV_FILE)} && set +a`,
    `if [ ! -d ${path}/.git ]; then`,
    `  rm -rf ${partial}`,
    `  git clone --quiet -- ${shellQuote(checkout.remoteUrl)} ${partial}`,
    ...(checkout.commit === null
      ? []
      : [`  git -C ${partial} checkout --quiet --detach ${shellQuote(checkout.commit)}`]),
    `  mv ${partial} ${path}`,
    "fi",
    `echo ${shellQuote(T3_PROJECT_FILE_MARKER)}`,
    `cat ${path}/t3.json 2>/dev/null || true`,
  ].join("\n");
}

/** Maps the clone's checked-in scripts the way the web app imports them. */
function projectScriptsFromT3File(contents: string): ReadonlyArray<ProjectScript> {
  const file = parseT3ProjectFile(contents);
  return (file?.scripts ?? []).map((script, index) => ({
    id: `t3json-${index + 1}`,
    name: script.name,
    command: script.command,
    icon: script.icon ?? "play",
    runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
    ...(script.runOnSettle ? { runOnSettle: true } : {}),
    ...(script.runOnWorktreeCreate && script.async === false ? { async: false } : {}),
    ...(script.previewUrl
      ? { previewUrl: script.previewUrl, autoOpenPreview: script.autoOpenPreview ?? false }
      : {}),
  }));
}

export class SandboxGuest extends Context.Service<
  SandboxGuest,
  {
    /** Mints an admin session inside the machine; the token never appears in logs. */
    readonly mintAdminSession: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
    ) => Effect.Effect<Redacted.Redacted<string>, SandboxGuestError | SandboxProviderError>;
    /** Clones once, however often it is called, and returns the clone's `t3.json` scripts. */
    readonly cloneCheckout: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      checkout: SandboxCheckout,
    ) => Effect.Effect<ReadonlyArray<ProjectScript>, SandboxGuestError | SandboxProviderError>;
    /**
     * Creates the project and launches the seed thread. Both are keyed by the
     * seed's ids, so a retry replays the first result instead of duplicating.
     */
    readonly launchSeedThread: (
      target: SandboxGuestTarget,
      input: {
        readonly checkout: SandboxCheckout;
        readonly scripts: ReadonlyArray<ProjectScript>;
        readonly seed: SandboxSeedThread;
      },
    ) => Effect.Effect<{ readonly resumed: boolean }, SandboxGuestError>;
    /** A one-time grant a client exchanges for its own session on the guest. */
    readonly issuePairingCredential: (
      target: SandboxGuestTarget,
      label: string,
    ) => Effect.Effect<Redacted.Redacted<string>, SandboxGuestError>;
  }
>()("t3/sandbox/SandboxGuest") {}

const make = Effect.gen(function* () {
  const provider = yield* SandboxProvider;
  const httpClient = yield* HttpClient.HttpClient;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const bearer = (target: SandboxGuestTarget) => ({
    authorization: `Bearer ${Redacted.value(target.token)}`,
  });
  const httpApi = (target: SandboxGuestTarget) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: target.baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const execOrFail = (
    operation: SandboxGuestOperation,
    account: SandboxProviderAccount,
    machineId: ProviderMachineId,
    command: string,
    timeoutSeconds: number,
  ) =>
    provider
      .exec(account, machineId, { command, timeoutSeconds })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(new SandboxGuestError({ operation, exitCode: result.exitCode })),
        ),
      );

  const mintAdminSession: SandboxGuest["Service"]["mintAdminSession"] = (account, machineId) =>
    execOrFail(
      "mint-session",
      account,
      machineId,
      `T3CODE_HOME=${shellQuote(SANDBOX_T3_HOME)} ${shellQuote(SANDBOX_T3_BIN)} auth session issue --json --label sandbox-owner`,
      60,
    ).pipe(
      Effect.flatMap((stdout) =>
        decodeIssuedSession(stdout.trim()).pipe(
          Effect.mapError((cause) => new SandboxGuestError({ operation: "mint-session", cause })),
        ),
      ),
      Effect.map((issued) => Redacted.make(issued.token)),
    );

  const cloneCheckout: SandboxGuest["Service"]["cloneCheckout"] = (account, machineId, checkout) =>
    execOrFail(
      "clone",
      account,
      machineId,
      renderCloneCommand(checkout),
      CLONE_TIMEOUT_SECONDS,
    ).pipe(
      Effect.map((stdout) =>
        projectScriptsFromT3File(
          stdout.slice(stdout.indexOf(T3_PROJECT_FILE_MARKER) + T3_PROJECT_FILE_MARKER.length),
        ),
      ),
    );

  const launchThread = (target: SandboxGuestTarget, seed: SandboxSeedThread) =>
    Effect.gen(function* () {
      const client = yield* httpApi(target);
      const { ticket } = yield* client.auth.webSocketTicket({ headers: bearer(target) });
      const socketUrl = new URL("/ws", target.baseUrl);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      socketUrl.searchParams.set("wsTicket", ticket);
      // Built into this call's scope: the socket must outlive the client's construction.
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(socketUrl.toString())),
          Layer.provide(RpcSerialization.layerJson),
        ),
      );
      const rpc = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
      return yield* rpc["orchestration.launchThread"]({
        commandId: seed.commandId,
        threadId: seed.threadId,
        projectId: seed.projectId,
        title: seed.title,
        modelSelection: { instanceId: defaultInstanceIdForDriver(seed.driver), model: seed.model },
        runtimeMode: seed.runtimeMode,
        interactionMode: seed.interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: seed.messageId, text: seed.message, attachments: [] },
      });
    }).pipe(
      Effect.scoped,
      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
      Effect.timeout(GUEST_CALL_TIMEOUT),
      Effect.mapError((cause) => new SandboxGuestError({ operation: "launch-thread", cause })),
    );

  const launchSeedThread: SandboxGuest["Service"]["launchSeedThread"] = (target, input) =>
    Effect.gen(function* () {
      const client = yield* httpApi(target);
      yield* client.projects
        .mutate({
          headers: bearer(target),
          payload: {
            type: "project.create",
            commandId: CommandId.make(`sandbox-project:${input.seed.projectId}`),
            projectId: input.seed.projectId,
            title: input.checkout.path.split("/").at(-1) ?? "project",
            workspaceRoot: input.checkout.path,
            scripts: input.scripts,
          },
        })
        .pipe(
          Effect.timeout(GUEST_CALL_TIMEOUT),
          Effect.mapError((cause) => new SandboxGuestError({ operation: "create-project", cause })),
        );
      const launched = yield* launchThread(target, input.seed);
      return { resumed: launched.resumed };
    });

  const issuePairingCredential: SandboxGuest["Service"]["issuePairingCredential"] = (
    target,
    label,
  ) =>
    httpApi(target).pipe(
      Effect.flatMap((client) =>
        client.auth.pairingCredential({ headers: bearer(target), payload: { label } }),
      ),
      Effect.timeout(GUEST_CALL_TIMEOUT),
      Effect.map((result) => Redacted.make(result.credential)),
      Effect.mapError((cause) => new SandboxGuestError({ operation: "issue-pairing", cause })),
    );

  return SandboxGuest.of({
    mintAdminSession,
    cloneCheckout,
    launchSeedThread,
    issuePairingCredential,
  });
});

export const layer = Layer.effect(SandboxGuest, make);
