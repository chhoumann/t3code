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
  type EnvironmentId,
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
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_STAGED_ENV_FILE,
  SANDBOX_STAGED_MACHINE_SETUP_SCRIPT,
  SANDBOX_T3_BIN,
  SANDBOX_T3_HOME,
  SANDBOX_T3_TARBALL,
  renderRefreshCredentialsCommand,
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

/** What the owner writes into a machine for its account; contents are secret. */
export interface SandboxMachineCredentials {
  readonly envFile: string;
  readonly machineSetupScript: string;
}

export const SandboxGuestOperation = Schema.Literals([
  "write-inputs",
  "refresh-credentials",
  "mint-session",
  "clone",
  "create-project",
  "launch-thread",
  "issue-pairing",
]);
export type SandboxGuestOperation = typeof SandboxGuestOperation.Type;

const OPERATION_SUMMARY: Record<SandboxGuestOperation, string> = {
  "write-inputs": "write the boot inputs to the sandbox",
  "refresh-credentials": "refresh the sandbox credentials",
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
// Boat's edge can hold a request to a port with no listener yet for minutes.
const READINESS_TIMEOUT = Duration.seconds(5);
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
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
    /**
     * Uploads what the creation script waits for, the ready marker last. A
     * no-op once the marker exists, so a retry never re-uploads the build.
     */
    readonly writeBootInputs: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      inputs: SandboxMachineCredentials & { readonly tarball: Uint8Array | null },
    ) => Effect.Effect<void, SandboxGuestError | SandboxProviderError>;
    /** Rewrites the account credentials after a boot, restarting what they changed. */
    readonly refreshCredentials: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      credentials: SandboxMachineCredentials,
    ) => Effect.Effect<void, SandboxGuestError | SandboxProviderError>;
    /** The guest's environment id, or null when its T3 server does not answer within seconds. */
    readonly readEnvironmentId: (baseUrl: string) => Effect.Effect<EnvironmentId | null>;
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
  const httpApi = (baseUrl: string) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl }).pipe(
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

  const encode = (text: string) => new TextEncoder().encode(text);

  const writeBootInputs: SandboxGuest["Service"]["writeBootInputs"] = (
    account,
    machineId,
    inputs,
  ) =>
    Effect.gen(function* () {
      const marker = yield* provider.exec(account, machineId, {
        command: `test -e ${shellQuote(SANDBOX_INPUTS_READY_FILE)} && echo present || true`,
        timeoutSeconds: 10,
      });
      if (marker.stdout.trim() === "present") return;
      yield* provider.writeFile(account, machineId, {
        path: SANDBOX_ENV_FILE,
        content: encode(inputs.envFile),
      });
      yield* provider.writeFile(account, machineId, {
        path: SANDBOX_MACHINE_SETUP_SCRIPT,
        content: encode(inputs.machineSetupScript),
      });
      const tarball = inputs.tarball;
      if (tarball !== null) {
        const parts = Math.ceil(tarball.length / UPLOAD_CHUNK_BYTES);
        yield* Effect.forEach(
          Array.from({ length: parts }, (_, index) => index),
          (index) =>
            provider.writeFile(account, machineId, {
              path: `${SANDBOX_T3_TARBALL}.part-${String(index).padStart(3, "0")}`,
              content: tarball.subarray(
                index * UPLOAD_CHUNK_BYTES,
                (index + 1) * UPLOAD_CHUNK_BYTES,
              ),
            }),
          { concurrency: 3 },
        );
        yield* execOrFail(
          "write-inputs",
          account,
          machineId,
          `cat ${shellQuote(SANDBOX_T3_TARBALL)}.part-* > ${shellQuote(SANDBOX_T3_TARBALL)} && rm -f ${shellQuote(SANDBOX_T3_TARBALL)}.part-*`,
          60,
        );
      }
      yield* provider.writeFile(account, machineId, {
        path: SANDBOX_INPUTS_READY_FILE,
        content: new Uint8Array(),
      });
    });

  const refreshCredentials: SandboxGuest["Service"]["refreshCredentials"] = (
    account,
    machineId,
    credentials,
  ) =>
    Effect.gen(function* () {
      yield* provider.writeFile(account, machineId, {
        path: SANDBOX_STAGED_ENV_FILE,
        content: encode(credentials.envFile),
      });
      yield* provider.writeFile(account, machineId, {
        path: SANDBOX_STAGED_MACHINE_SETUP_SCRIPT,
        content: encode(credentials.machineSetupScript),
      });
      const outcome = yield* execOrFail(
        "refresh-credentials",
        account,
        machineId,
        renderRefreshCredentialsCommand(),
        // Re-running the machine setup can take as long as its unit allows.
        660,
      );
      yield* Effect.logInfo("sandbox credentials refreshed").pipe(
        Effect.annotateLogs({ machineId, outcome: outcome.trim().split("\n").at(-1) ?? "" }),
      );
    });

  const readEnvironmentId: SandboxGuest["Service"]["readEnvironmentId"] = (baseUrl) =>
    httpApi(baseUrl).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(READINESS_TIMEOUT),
      Effect.map((descriptor): EnvironmentId | null => descriptor.environmentId),
      Effect.orElseSucceed(() => null),
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
      const client = yield* httpApi(target.baseUrl);
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
      const client = yield* httpApi(target.baseUrl);
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
    httpApi(target.baseUrl).pipe(
      Effect.flatMap((client) =>
        client.auth.pairingCredential({ headers: bearer(target), payload: { label } }),
      ),
      Effect.timeout(GUEST_CALL_TIMEOUT),
      Effect.map((result) => Redacted.make(result.credential)),
      Effect.mapError((cause) => new SandboxGuestError({ operation: "issue-pairing", cause })),
    );

  return SandboxGuest.of({
    writeBootInputs,
    refreshCredentials,
    readEnvironmentId,
    mintAdminSession,
    cloneCheckout,
    launchSeedThread,
    issuePairingCredential,
  });
});

export const layer = Layer.effect(SandboxGuest, make);
