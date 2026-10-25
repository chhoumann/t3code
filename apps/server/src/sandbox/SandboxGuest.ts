/**
 * SandboxGuest - what an owner environment does to the T3 server inside one
 * of its sandboxes: mint the owner's admin session, prepare the project
 * through the guest's own clone service, launch the seed thread, read what
 * its agents are doing, and mint client pairing grants.
 *
 * The guest is reached over its public HTTP API and RPC socket with the
 * admin bearer, the same seams any remote client uses. Its MCP endpoint is
 * not one of them: it accepts only MCP client sessions and allocates its own
 * thread ids, so a retried launch would create a second thread.
 *
 * @module SandboxGuest
 */
import {
  type AuthGrantScope,
  type CommandId,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  type EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WsRpcGroup,
  defaultInstanceIdForDriver,
  type MessageId,
  type ProjectCloneActionInput,
  type ProjectCloneActionResult,
  type ProjectCloneListEvent,
  type ProjectCloneStartInput,
  type ProjectCloneSubscribeInput,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type SandboxResolvedBase,
  type SandboxSource,
  SourceControlRepositoryError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import type { GitHubUserToken } from "./GitHubAppConnection.ts";
import {
  type ManagedSandboxMarker,
  SANDBOX_OWNER_SUBJECT,
  encodeManagedSandboxMarker,
} from "./ManagedSandbox.ts";
import {
  SANDBOX_ENV_FILE,
  SANDBOX_GITHUB_TOKEN_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MANAGED_FILE,
  SANDBOX_SETUP_ENV_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_STAGED_ENV_FILE,
  SANDBOX_STAGED_SETUP_ENV_FILE,
  SANDBOX_STAGED_MACHINE_SETUP_SCRIPT,
  SANDBOX_T3_BIN,
  SANDBOX_T3_HOME,
  SANDBOX_T3_TARBALL,
  renderGitHubLoginCommand,
  renderInputsReadyTest,
  renderRefreshCredentialsCommand,
  renderRestartServerCommand,
  shellQuote,
} from "./sandboxBootScript.ts";
import { guestActivity, type SandboxGuestActivity } from "./sandboxActivity.ts";
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

/** The project a sandbox's guest clones its repository into; the ids are allocated once by the owner. */
export interface SandboxSeedProject {
  readonly projectId: ProjectId;
  readonly title: string;
  /** Absolute path in the guest. */
  readonly path: string;
  readonly createdAt: string;
  readonly source: SandboxSource;
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
  /** Loaded by T3 and the machine setup. */
  readonly envFile: string;
  /** Loaded by the machine setup only. */
  readonly setupEnvFile: string;
  readonly machineSetupScript: string;
}

export const SandboxGuestOperation = Schema.Literals([
  "write-inputs",
  "refresh-credentials",
  "restart-server",
  "github-login",
  "mint-session",
  "clone",
  "launch-thread",
  "issue-pairing",
  "read-activity",
]);
export type SandboxGuestOperation = typeof SandboxGuestOperation.Type;

const OPERATION_SUMMARY: Record<SandboxGuestOperation, string> = {
  "write-inputs": "write the boot inputs to the sandbox",
  "refresh-credentials": "refresh the sandbox credentials",
  "restart-server": "restart T3 in the sandbox",
  "github-login": "sign the sandbox in to GitHub",
  "mint-session": "mint the owner session on the sandbox",
  clone: "clone the repository in the sandbox",
  "launch-thread": "launch the sandbox thread",
  "issue-pairing": "issue a pairing grant for the sandbox",
  "read-activity": "read what the agents in the sandbox are doing",
};

export class SandboxGuestError extends Schema.TaggedError<SandboxGuestError>()(
  "SandboxGuestError",
  {
    operation: SandboxGuestOperation,
    exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
    /** The end of the command's stderr, such as git's reason a clone failed. */
    stderrTail: Schema.optional(Schema.String),
    /** The guest no longer accepts the session the call was made with. */
    unauthorized: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const summary = `Could not ${OPERATION_SUMMARY[this.operation]}.`;
    return this.stderrTail === undefined ? summary : `${summary}\n${this.stderrTail}`;
  }
}

const isAuthInvalid = Schema.is(EnvironmentAuthInvalidError);
const isGuestError = Schema.is(SandboxGuestError);
const isRepositoryError = Schema.is(SourceControlRepositoryError);

/** The error of a call made over the guest's HTTP or RPC seams with a session. */
const sessionCallError = (operation: SandboxGuestOperation) => (cause: unknown) =>
  new SandboxGuestError({
    operation,
    cause,
    ...(isAuthInvalid(cause) ? { unauthorized: true } : {}),
  });

const decodeIssuedSession = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);
const GUEST_CALL_TIMEOUT = Duration.seconds(60);
// Boat's edge can hold a request to a port with no listener yet for minutes.
const READINESS_TIMEOUT = Duration.seconds(5);
/** Short, because the sandbox's loop waits on it once a minute. */
const ACTIVITY_TIMEOUT = Duration.seconds(10);
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const CLONE_TIMEOUT = Duration.minutes(10);
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_CHARS = 600;

/** The last few lines a failed command wrote, enough to name why without flooding a status. */
const stderrTail = (stderr: string) => {
  const tail = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES)
    .join("\n");
  return tail.length === 0 ? undefined : tail.slice(-STDERR_TAIL_CHARS);
};

/** An RPC client on the guest's socket, authenticated as `target`, open for the scope. */
export const connectGuestRpc = Effect.fn("SandboxGuest.connectGuestRpc")(function* (
  target: SandboxGuestTarget,
) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: target.baseUrl });
  const { ticket } = yield* client.auth.webSocketTicket({
    headers: { authorization: `Bearer ${Redacted.value(target.token)}` },
  });
  const socketUrl = new URL("/ws", target.baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  socketUrl.searchParams.set("wsTicket", ticket);
  // Built into the caller's scope: the socket must outlive the client's construction.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(socketUrl.toString())),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
});

type GuestRpc = Effect.Success<ReturnType<typeof connectGuestRpc>>;

/** The guest's clone RPCs that preparing a project drives; `E` is what reading the clone list can fail with. */
export interface ProjectCloneRpc<E> {
  readonly subscribeProjectClones: (
    input: ProjectCloneSubscribeInput,
    options: { readonly asQueue: true },
  ) => Effect.Effect<Queue.Dequeue<ProjectCloneListEvent, E>, never, Scope.Scope>;
  readonly "projectClone.start": (
    input: ProjectCloneStartInput,
  ) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>;
  readonly "projectClone.retry": (
    input: ProjectCloneActionInput,
  ) => Effect.Effect<ProjectCloneActionResult, { readonly _tag: string; readonly message: string }>;
}

const cloneRefused = (error: { readonly _tag: string; readonly message: string }) =>
  new SandboxGuestError({
    operation: "clone",
    stderrTail: isRepositoryError(error) ? error.detail : error.message,
  });

/**
 * Has the guest clone the project, or joins the clone it already runs, or
 * retries the one that failed, and waits for the base it pins. The guest's
 * clone list is read before anything is asked, so the clone's end cannot slip
 * by between the two.
 */
export const prepareProjectOver = Effect.fn("SandboxGuest.prepareProjectOver")(
  function* <E>(rpc: ProjectCloneRpc<E>, project: SandboxSeedProject) {
    const clones = yield* rpc.subscribeProjectClones({}, { asQueue: true });
    const snapshotOf = (list: ProjectCloneListEvent) =>
      list.find((snapshot) => snapshot.projectId === project.projectId);
    let snapshot = snapshotOf(yield* Queue.take(clones));
    // Lists from before a start claimed its entry may still lack it. Once the
    // entry has been seen, a list without it means the guest dropped the clone.
    let seen = snapshot !== undefined;
    if (snapshot === undefined) {
      yield* rpc["projectClone.start"]({
        projectId: project.projectId,
        title: project.title,
        createdAt: project.createdAt,
        remoteUrl: project.source.remoteUrl,
        destinationPath: project.path,
        protocol: "https",
        checkout: {
          base: project.source.base,
          reuseMatching: true,
          importProjectScripts: true,
        },
      }).pipe(Effect.mapError(cloneRefused));
    } else if (snapshot.phase === "failed" || snapshot.phase === "cancelled") {
      yield* rpc["projectClone.retry"]({ projectId: project.projectId }).pipe(
        Effect.mapError(cloneRefused),
      );
      snapshot = undefined;
    }
    while (snapshot === undefined || snapshot.phase === "running") {
      const next = snapshotOf(yield* Queue.take(clones));
      if (next === undefined) {
        if (!seen) continue;
        return yield* new SandboxGuestError({
          operation: "clone",
          stderrTail: "The sandbox stopped tracking the clone.",
        });
      }
      seen = true;
      snapshot = next;
    }
    if (snapshot.phase !== "done" || snapshot.base === undefined) {
      return yield* new SandboxGuestError({
        operation: "clone",
        ...(snapshot.error === null ? {} : { stderrTail: snapshot.error }),
      });
    }
    return snapshot.base;
  },
  Effect.mapError((cause) => (isGuestError(cause) ? cause : sessionCallError("clone")(cause))),
);

export class SandboxGuest extends Context.Service<
  SandboxGuest,
  {
    /**
     * Uploads what the creation script waits for, the ready marker last. A
     * no-op once the marker names this sandbox, so a retry never re-uploads
     * the build.
     */
    readonly writeBootInputs: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      inputs: SandboxMachineCredentials & {
        readonly tarball: Uint8Array | null;
        readonly managed: ManagedSandboxMarker;
      },
    ) => Effect.Effect<void, SandboxGuestError | SandboxProviderError>;
    /**
     * Rewrites the account credentials after a resume and re-runs the machine
     * setup when they changed. Reports whether T3 must restart to load them,
     * which `restartServer` does once the agents are idle.
     */
    readonly refreshCredentials: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      credentials: SandboxMachineCredentials,
    ) => Effect.Effect<
      { readonly restartPending: boolean },
      SandboxGuestError | SandboxProviderError
    >;
    /** Restarts the guest's T3 if a refresh left that pending; a no-op otherwise. */
    readonly restartServer: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
    ) => Effect.Effect<void, SandboxGuestError | SandboxProviderError>;
    /**
     * Signs the guest in to GitHub as the token's user, for git and `gh`
     * alike. The token travels as a file the login reads and removes; it
     * never appears in a command line or a log.
     */
    readonly deliverGitHubToken: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
      token: GitHubUserToken,
    ) => Effect.Effect<void, SandboxGuestError | SandboxProviderError>;
    /** The guest's environment id, or null when its T3 server does not answer within seconds. */
    readonly readEnvironmentId: (baseUrl: string) => Effect.Effect<EnvironmentId | null>;
    /** Mints an admin session inside the machine; the token never appears in logs. */
    readonly mintAdminSession: (
      account: SandboxProviderAccount,
      machineId: ProviderMachineId,
    ) => Effect.Effect<Redacted.Redacted<string>, SandboxGuestError | SandboxProviderError>;
    /**
     * Has the guest create the project and clone the source into it, or
     * adopt a template's clone, then pin the base. Keyed by the project id,
     * so a retry joins a clone still running or finds the one already made.
     */
    readonly prepareProject: (
      target: SandboxGuestTarget,
      project: SandboxSeedProject,
    ) => Effect.Effect<SandboxResolvedBase, SandboxGuestError>;
    /**
     * Launches the seed thread on a worktree cut from `baseRef`. Keyed by
     * the seed's ids, so a retry replays the first result instead of
     * duplicating.
     */
    readonly launchSeedThread: (
      target: SandboxGuestTarget,
      input: { readonly seed: SandboxSeedThread; readonly baseRef: string },
    ) => Effect.Effect<void, SandboxGuestError>;
    /** Whether the guest's agents are working, from its shell snapshot. */
    readonly readActivity: (
      target: SandboxGuestTarget,
    ) => Effect.Effect<SandboxGuestActivity, SandboxGuestError>;
    /** A one-time grant a client exchanges for its own session on the guest. */
    readonly issuePairingCredential: (
      target: SandboxGuestTarget,
      grant: {
        readonly label: string;
        /** Omitted grants the guest's default pairing scopes. */
        readonly scopes?: ReadonlyArray<AuthGrantScope>;
      },
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
    provider.exec(account, machineId, { command, timeoutSeconds }).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) return Effect.succeed(result.stdout);
        const tail = stderrTail(result.stderr);
        return Effect.fail(
          new SandboxGuestError({
            operation,
            exitCode: result.exitCode,
            ...(tail === undefined ? {} : { stderrTail: tail }),
          }),
        );
      }),
    );

  const encode = (text: string) => new TextEncoder().encode(text);

  const writeBootInputs: SandboxGuest["Service"]["writeBootInputs"] = Effect.fn(
    "SandboxGuest.writeBootInputs",
  )(function* (account, machineId, inputs) {
    const marker = yield* provider.exec(account, machineId, {
      command: `${renderInputsReadyTest(inputs.managed.sandboxId)} && echo present || true`,
      timeoutSeconds: 10,
    });
    if (marker.stdout.trim() === "present") return;
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_ENV_FILE,
      content: encode(inputs.envFile),
    });
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_SETUP_ENV_FILE,
      content: encode(inputs.setupEnvFile),
    });
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_MACHINE_SETUP_SCRIPT,
      content: encode(inputs.machineSetupScript),
    });
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_MANAGED_FILE,
      content: encode(encodeManagedSandboxMarker(inputs.managed)),
    });
    const tarball = inputs.tarball;
    if (tarball !== null) {
      const parts = Math.ceil(tarball.length / UPLOAD_CHUNK_BYTES);
      yield* Effect.forEach(
        Array.from({ length: parts }, (_, index) => index),
        (index) =>
          provider.writeFile(account, machineId, {
            path: `${SANDBOX_T3_TARBALL}.part-${String(index).padStart(3, "0")}`,
            content: tarball.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES),
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
      content: encode(inputs.managed.sandboxId),
    });
  });

  const refreshCredentials: SandboxGuest["Service"]["refreshCredentials"] = Effect.fn(
    "SandboxGuest.refreshCredentials",
  )(function* (account, machineId, credentials) {
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_STAGED_ENV_FILE,
      content: encode(credentials.envFile),
    });
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_STAGED_SETUP_ENV_FILE,
      content: encode(credentials.setupEnvFile),
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
      // Boat's longest exec; the setup unit's own timeout is shorter.
      600,
    );
    yield* Effect.logInfo("sandbox credentials refreshed").pipe(
      Effect.annotateLogs({ machineId, outcome: outcome.trim().split("\n").at(-1) ?? "" }),
    );
    return { restartPending: /\bt3_restart_pending=1\b/.test(outcome) };
  });

  const restartServer: SandboxGuest["Service"]["restartServer"] = Effect.fn(
    "SandboxGuest.restartServer",
  )(function* (account, machineId) {
    const outcome = yield* execOrFail(
      "restart-server",
      account,
      machineId,
      renderRestartServerCommand(),
      120,
    );
    yield* Effect.logInfo("sandbox server restart").pipe(
      Effect.annotateLogs({ machineId, outcome: outcome.trim() }),
    );
  });

  const deliverGitHubToken: SandboxGuest["Service"]["deliverGitHubToken"] = Effect.fn(
    "SandboxGuest.deliverGitHubToken",
  )(function* (account, machineId, token) {
    yield* provider.writeFile(account, machineId, {
      path: SANDBOX_GITHUB_TOKEN_FILE,
      content: encode(Redacted.value(token.token)),
    });
    yield* execOrFail(
      "github-login",
      account,
      machineId,
      renderGitHubLoginCommand({ login: token.login, name: token.name, email: token.email }),
      60,
    ).pipe(
      // The login removes the file itself; a call that never ran it leaves the token behind.
      Effect.tapError(() =>
        provider
          .exec(account, machineId, {
            command: `rm -f ${shellQuote(SANDBOX_GITHUB_TOKEN_FILE)}`,
            timeoutSeconds: 10,
          })
          .pipe(Effect.ignore({ log: true })),
      ),
    );
    yield* Effect.logInfo("sandbox signed in to GitHub").pipe(
      Effect.annotateLogs({ machineId, login: token.login, generation: token.generation }),
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
      `T3CODE_HOME=${shellQuote(SANDBOX_T3_HOME)} ${shellQuote(SANDBOX_T3_BIN)} auth session issue --json --label sandbox-owner --subject ${SANDBOX_OWNER_SUBJECT}`,
      60,
    ).pipe(
      Effect.flatMap((stdout) =>
        decodeIssuedSession(stdout.trim()).pipe(
          Effect.mapError((cause) => new SandboxGuestError({ operation: "mint-session", cause })),
        ),
      ),
      Effect.map((issued) => Redacted.make(issued.token)),
    );

  /** Runs `call` over the guest's RPC socket as `target`, within `timeout`. */
  const guestRpc = <A, E>(
    operation: SandboxGuestOperation,
    timeout: Duration.Duration,
    target: SandboxGuestTarget,
    call: (rpc: GuestRpc) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    connectGuestRpc(target).pipe(
      Effect.flatMap(call),
      Effect.scoped,
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
      Effect.timeout(timeout),
      Effect.mapError((cause) =>
        isGuestError(cause) ? cause : sessionCallError(operation)(cause),
      ),
    );

  const prepareProject: SandboxGuest["Service"]["prepareProject"] = (target, project) =>
    guestRpc("clone", CLONE_TIMEOUT, target, (rpc) => prepareProjectOver(rpc, project));

  const launchSeedThread: SandboxGuest["Service"]["launchSeedThread"] = (
    target,
    { seed, baseRef },
  ) =>
    guestRpc("launch-thread", GUEST_CALL_TIMEOUT, target, (rpc) =>
      rpc["orchestration.launchThread"]({
        commandId: seed.commandId,
        threadId: seed.threadId,
        projectId: seed.projectId,
        title: seed.title,
        modelSelection: { instanceId: defaultInstanceIdForDriver(seed.driver), model: seed.model },
        runtimeMode: seed.runtimeMode,
        interactionMode: seed.interactionMode,
        // The preparation fetched the base once; starting from it again could move the base.
        workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        initialMessage: { messageId: seed.messageId, text: seed.message, attachments: [] },
      }),
    );

  const readActivity: SandboxGuest["Service"]["readActivity"] = (target) =>
    httpApi(target.baseUrl).pipe(
      Effect.flatMap((client) =>
        client.orchestration.shellSnapshot({
          headers: {
            ...bearer(target),
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
        }),
      ),
      Effect.timeout(ACTIVITY_TIMEOUT),
      Effect.map(guestActivity),
      Effect.mapError(sessionCallError("read-activity")),
    );

  const issuePairingCredential: SandboxGuest["Service"]["issuePairingCredential"] = (
    target,
    grant,
  ) =>
    httpApi(target.baseUrl).pipe(
      Effect.flatMap((client) =>
        client.auth.pairingCredential({
          headers: bearer(target),
          payload: {
            label: grant.label,
            ...(grant.scopes === undefined ? {} : { scopes: grant.scopes }),
          },
        }),
      ),
      Effect.timeout(GUEST_CALL_TIMEOUT),
      Effect.map((result) => Redacted.make(result.credential)),
      Effect.mapError(sessionCallError("issue-pairing")),
    );

  return SandboxGuest.of({
    writeBootInputs,
    refreshCredentials,
    restartServer,
    deliverGitHubToken,
    readEnvironmentId,
    mintAdminSession,
    prepareProject,
    launchSeedThread,
    readActivity,
    issuePairingCredential,
  });
});

export const layer = Layer.effect(SandboxGuest, make);
