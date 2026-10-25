/**
 * GitHubAppConnection - the owner's GitHub App for its sandboxes. The owner
 * registers a per-user App, keeps the App user's single rotating refresh
 * token, and hands sandboxes 8-hour user tokens, so agents push and open pull
 * requests as the user without a long-lived credential on the machine.
 *
 * The App's id, slug, client id, and connection state live in the server
 * settings, so clients see them. The client secret and one token envelope live
 * in the secret store. GitHub's callbacks land on a client route that relays
 * them here over the client's own connection, so the owner is never reached
 * from the outside.
 *
 * @module GitHubAppConnection
 */
import {
  type SandboxGitHubAppConfig,
  type SandboxGitHubBeginInput,
  type SandboxGitHubCompleteInput,
  type SandboxGitHubDisconnectInput,
  type SandboxGitHubFlowNext,
  type SandboxGitHubFlowStart,
  SandboxGitHubUser,
  sandboxGitHubCallbackPath,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Equal from "effect/Equal";
import * as FiberHandle from "effect/FiberHandle";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as githubApp from "./githubApp.ts";

/** A user token for one generation of the refresh chain. A refresh revokes the previous generation's token. */
export interface GitHubUserToken {
  readonly generation: number;
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
  /** The GitHub user, so git commits in the sandbox carry their name. */
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
}

export class GitHubAppConnectionError extends Schema.TaggedError<GitHubAppConnectionError>()(
  "GitHubAppConnectionError",
  {
    message: Schema.String,
    /** The user must authorize the App again; nothing retries until they do. */
    reauthorize: Schema.Boolean,
  },
) {}

export class GitHubAppConnection extends Context.Service<
  GitHubAppConnection,
  {
    /**
     * The current token, refreshed first when it has less than `minLifetime`
     * left. Concurrent callers share one refresh. Null when no App user is
     * connected.
     */
    readonly current: (
      minLifetime: Duration.Duration,
    ) => Effect.Effect<GitHubUserToken | null, GitHubAppConnectionError>;
    /**
     * The generation `current` hands out now, read without refreshing. Null
     * when there is none to give: no App user, a rotation under way, or a
     * chain that needs the user to sign in again.
     */
    readonly generation: Effect.Effect<number | null, GitHubAppConnectionError>;
    /** The current generation, then each new one: a rotation, a connect, or a disconnect (null). */
    readonly generations: Stream.Stream<number | null>;
  }
>()("t3/sandbox/GitHubAppConnection") {}

/** The owner-side flows Settings drives. Each browser step ends on the client's callback route. */
export class GitHubAppConnectionSetup extends Context.Service<
  GitHubAppConnectionSetup,
  {
    readonly begin: (
      input: SandboxGitHubBeginInput,
    ) => Effect.Effect<SandboxGitHubFlowStart, GitHubAppConnectionError>;
    readonly complete: (
      input: SandboxGitHubCompleteInput,
    ) => Effect.Effect<SandboxGitHubFlowNext, GitHubAppConnectionError>;
    readonly disconnect: (
      input: SandboxGitHubDisconnectInput,
    ) => Effect.Effect<void, GitHubAppConnectionError>;
  }
>()("t3/sandbox/GitHubAppConnection/GitHubAppConnectionSetup") {}

/**
 * The one secret the App user's tokens live in. `rotating` is written before
 * the single refresh request and stays while its answer is unknown. The same
 * refresh is then sent again, at the next attempt or the next start, and
 * GitHub is asked about the old token when that too goes unanswered.
 */
const TokenEnvelope = Schema.Struct({
  generation: Schema.Int,
  accessToken: Schema.String,
  accessExpiresAt: Schema.Number,
  refreshToken: Schema.String,
  refreshExpiresAt: Schema.Number,
  state: Schema.Literals(["ready", "rotating", "reauthorize"]),
  user: SandboxGitHubUser,
});
type TokenEnvelope = typeof TokenEnvelope.Type;
const envelopeJson = Schema.fromJsonString(TokenEnvelope);
const decodeEnvelope = Schema.decodeUnknownEffect(envelopeJson);
const encodeEnvelope = Schema.encodeSync(envelopeJson);

const CLIENT_SECRET_NAME = "sandbox-github-app-client-secret";
const ENVELOPE_SECRET_NAME = "sandbox-github-app-user";
/** How long a browser step may take before its state stops being accepted. */
const STATE_TTL = Duration.minutes(10);
/** Refresh this long before the access token expires. */
const REFRESH_LEAD = Duration.hours(1);
/** How long the timer waits after GitHub answered a refresh with an error before trying again. */
const REFRESH_RETRY_DELAY = Duration.minutes(5);
const CALLBACK_SCHEMES = new Set(["http:", "https:", "t3code:", "t3code-dev:"]);
const REAUTHORIZE_MESSAGE =
  "The GitHub connection needs you to sign in again. Reconnect it in Settings.";

interface PendingFlow {
  readonly step: "register" | "authorize";
  /** The callback URLs the manifest registers, kept for the App record. */
  readonly callbackUrls: ReadonlyArray<string>;
  readonly expiresAt: number;
}

type Registration = Omit<SandboxGitHubAppConfig, "connection">;

/** A token grant from an App that expires user tokens, which the refresh chain needs. */
type ExpiringGrant = githubApp.TokenGrant & {
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly refresh_token_expires_in: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const failure = (message: string, reauthorize = false) =>
  new GitHubAppConnectionError({ message, reauthorize });

const storeFailure = (cause: unknown) =>
  Effect.logWarning("GitHub App connection store failed", { cause }).pipe(
    Effect.flatMap(() => Effect.fail(failure("The GitHub connection could not be read or saved."))),
  );

const apiFailure = (action: string) => (reason: githubApp.GitHubApiFailure) =>
  failure(
    reason._tag === "Transport"
      ? `Could not reach GitHub to ${action}.`
      : reason._tag === "InvalidBody"
        ? `GitHub's answer to ${action} could not be read.`
        : reason._tag === "Status"
          ? `GitHub refused to ${action} (HTTP ${reason.status}).`
          : `GitHub refused to ${action}: ${reason.description ?? reason.error}.`,
  );

const connectionOf = (envelope: TokenEnvelope | null): SandboxGitHubAppConfig["connection"] =>
  envelope === null
    ? { _tag: "disconnected" }
    : envelope.state === "reauthorize"
      ? { _tag: "reauthorize", user: envelope.user }
      : { _tag: "connected", user: envelope.user };

const tokenOf = (envelope: TokenEnvelope): GitHubUserToken => ({
  generation: envelope.generation,
  token: Redacted.make(envelope.accessToken),
  expiresAt: envelope.accessExpiresAt,
  login: envelope.user.login,
  name: envelope.user.name,
  email: envelope.user.email,
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const callbackPath = sandboxGitHubCallbackPath(environmentId);
  // Every envelope write, so a refresh, a connect, and a disconnect never interleave.
  const mutex = yield* Semaphore.make(1);
  const generationsPubSub = yield* PubSub.unbounded<number | null>();
  const refreshTimer = yield* FiberHandle.make();
  const pending = new Map<string, PendingFlow>();
  /**
   * Generations only ever grow, across disconnects and new Apps too, so a
   * guest holding a revoked token never matches the current one by accident.
   * The clock carries that across restarts; this carries it within one.
   */
  let lastGeneration = 0;
  const nextGeneration = (previous: number | null, now: number): number => {
    lastGeneration = Math.max((previous ?? 0) + 1, lastGeneration + 1, now);
    return lastGeneration;
  };

  const clearEnvelope = secrets.remove(ENVELOPE_SECRET_NAME).pipe(Effect.catch(storeFailure));
  /** An envelope that cannot be read is no connection at all. It goes, so the user can connect again. */
  const readEnvelope = Effect.gen(function* () {
    const bytes = yield* secrets.get(ENVELOPE_SECRET_NAME).pipe(Effect.catch(storeFailure));
    if (Option.isNone(bytes)) return null;
    return yield* decodeEnvelope(textDecoder.decode(bytes.value)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("GitHub App connection envelope unreadable; removed", { cause }).pipe(
          Effect.andThen(clearEnvelope),
          Effect.as(null),
        ),
      ),
    );
  });
  const writeEnvelope = (envelope: TokenEnvelope) =>
    secrets
      .set(ENVELOPE_SECRET_NAME, textEncoder.encode(encodeEnvelope(envelope)))
      .pipe(Effect.catch(storeFailure));

  const readRegistration = settings.getSettings.pipe(
    Effect.map((current): Registration | null => current.sandboxGitHubApp),
    Effect.catch(storeFailure),
  );
  const readClientSecret = secrets.get(CLIENT_SECRET_NAME).pipe(
    Effect.catch(storeFailure),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            failure("The GitHub App's client secret is missing. Remove the App and connect again."),
          ),
        onSome: (bytes) => Effect.succeed(textDecoder.decode(bytes)),
      }),
    ),
  );
  const writeApp = (app: SandboxGitHubAppConfig | null) =>
    settings
      .updateSandboxAccounts((current) => Effect.succeed({ ...current, sandboxGitHubApp: app }))
      .pipe(Effect.asVoid, Effect.catch(storeFailure));
  /** The settings record follows the envelope, so every client sees the connection state. */
  const mirror = (envelope: TokenEnvelope | null) =>
    settings
      .updateSandboxAccounts((current) =>
        Effect.succeed(
          current.sandboxGitHubApp === null
            ? current
            : {
                ...current,
                sandboxGitHubApp: {
                  ...current.sandboxGitHubApp,
                  connection: connectionOf(envelope),
                },
              },
        ),
      )
      .pipe(Effect.asVoid, Effect.catch(storeFailure));

  const publish = (generation: number | null) =>
    PubSub.publish(generationsPubSub, generation).pipe(Effect.asVoid);

  const newState = crypto.randomBytes(32).pipe(
    Effect.map(Hex.encode),
    Effect.mapError(() => failure("Could not generate a sign-in state.")),
  );

  const grantedEnvelope = (
    grant: ExpiringGrant,
    generation: number,
    user: TokenEnvelope["user"],
    now: number,
  ): TokenEnvelope => ({
    generation,
    accessToken: grant.access_token,
    accessExpiresAt: now + grant.expires_in * 1000,
    refreshToken: grant.refresh_token,
    refreshExpiresAt: now + grant.refresh_token_expires_in * 1000,
    state: "ready",
    user,
  });

  const expiring = (
    grant: githubApp.TokenGrant,
  ): Effect.Effect<ExpiringGrant, GitHubAppConnectionError> =>
    grant.expires_in !== undefined &&
    grant.refresh_token !== undefined &&
    grant.refresh_token_expires_in !== undefined
      ? Effect.succeed({
          ...grant,
          expires_in: grant.expires_in,
          refresh_token: grant.refresh_token,
          refresh_token_expires_in: grant.refresh_token_expires_in,
        })
      : Effect.fail(
          failure(
            'GitHub issued a token that never expires. Turn on "Expire user authorization tokens" in the App\'s settings on GitHub and connect again.',
          ),
        );

  /** The chain is broken. Nothing refreshes until the user signs in again. */
  const markReauthorize = (envelope: TokenEnvelope) => {
    const broken = { ...envelope, state: "reauthorize" as const };
    return writeEnvelope(broken).pipe(Effect.andThen(mirror(broken)));
  };
  const reauthorize = failure(REAUTHORIZE_MESSAGE, true);

  /**
   * Settles a refresh with no usable answer, after which GitHub may or may
   * not have rotated. Its word on the old access token tells. Still accepted
   * means it did not, and the envelope is ready again. Refused means it did
   * and the new tokens are lost, so the user must sign in again. An expired
   * token is refused either way and an unreachable GitHub says nothing, so
   * the envelope stays `rotating` for the next attempt to send the same
   * refresh again, which GitHub answers one way or the other.
   */
  const settleLostAnswer = Effect.fn("GitHubAppConnection.settleLostAnswer")(function* (
    envelope: TokenEnvelope,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (envelope.accessExpiresAt <= now) return "unknown" as const;
    const probe = yield* Effect.result(githubApp.fetchUser(http, envelope.accessToken));
    if (probe._tag === "Success") {
      yield* writeEnvelope({ ...envelope, state: "ready" });
      return "kept" as const;
    }
    if (probe.failure._tag === "Status" && probe.failure.status === 401) {
      yield* markReauthorize(envelope);
      return "broken" as const;
    }
    return "unknown" as const;
  });

  /**
   * The one refresh. Runs under the mutex. `rotating` goes to disk first, so a
   * crash before the answer lands is told apart from a clean envelope at the
   * next start. An answer that refuses breaks the chain. A refusal to act
   * leaves the envelope as it was. No usable answer is settled by asking
   * GitHub about the old token.
   */
  const rotate = Effect.fn("GitHubAppConnection.rotate")(function* (envelope: TokenEnvelope) {
    const registration = yield* readRegistration;
    if (registration === null) {
      return yield* failure("No GitHub App is registered. Connect GitHub again.", true);
    }
    const clientSecret = yield* readClientSecret;
    yield* writeEnvelope({ ...envelope, state: "rotating" });
    const result = yield* Effect.result(
      githubApp.refreshTokens(http, {
        clientId: registration.clientId,
        clientSecret,
        refreshToken: envelope.refreshToken,
      }),
    );
    if (result._tag === "Failure") {
      const reason = result.failure;
      const refreshFailed = apiFailure("refresh the connection")(reason);
      switch (reason._tag) {
        case "OAuth":
          yield* markReauthorize(envelope);
          return yield* reauthorize;
        case "Status":
          // GitHub did not act, so the envelope goes back to how it came in. A
          // resend of a refresh whose first answer is unknown stays `rotating`.
          yield* writeEnvelope(envelope);
          return yield* refreshFailed;
        case "Transport":
        case "InvalidBody": {
          const settled = yield* settleLostAnswer(envelope);
          return yield* settled === "broken" ? reauthorize : refreshFailed;
        }
      }
    }
    // GitHub rotated, but a grant that never expires cannot carry the chain on.
    const grant = yield* expiring(result.success).pipe(
      Effect.tapError(() => markReauthorize(envelope)),
    );
    const now = yield* Clock.currentTimeMillis;
    const next = grantedEnvelope(
      grant,
      nextGeneration(envelope.generation, now),
      envelope.user,
      now,
    );
    yield* writeEnvelope(next);
    yield* publish(next.generation);
    return next;
  });

  /** Refreshes when less than `lead` remains. Runs under the mutex; the envelope is re-read there. */
  const rotateIfShort = Effect.fn("GitHubAppConnection.rotateIfShort")(function* (
    lead: Duration.Duration,
  ) {
    const envelope = yield* readEnvelope;
    if (envelope === null) return null;
    if (envelope.state === "reauthorize") return yield* failure(REAUTHORIZE_MESSAGE, true);
    const now = yield* Clock.currentTimeMillis;
    if (envelope.state === "ready" && envelope.accessExpiresAt - now >= Duration.toMillis(lead)) {
      return envelope;
    }
    return yield* rotate(envelope);
  });

  /**
   * Sleeps until the token is a lead from expiring, refreshes, and repeats
   * while the chain holds. A refresh whose answer is still unknown is sent
   * again after the retry delay, and one found under way at start at once.
   */
  const refreshLoop = Effect.gen(function* () {
    while (true) {
      const envelope = yield* readEnvelope;
      if (envelope === null || envelope.state === "reauthorize") return;
      const now = yield* Clock.currentTimeMillis;
      if (envelope.state === "ready") {
        yield* Effect.sleep(
          Duration.millis(
            Math.max(0, envelope.accessExpiresAt - Duration.toMillis(REFRESH_LEAD) - now),
          ),
        );
      }
      const outcome = yield* Effect.result(mutex.withPermit(rotateIfShort(REFRESH_LEAD)));
      if (outcome._tag === "Failure") {
        if (outcome.failure.reauthorize) return;
        yield* Effect.logWarning("GitHub token refresh failed; trying again later", {
          message: outcome.failure.message,
        });
        yield* Effect.sleep(REFRESH_RETRY_DELAY);
      }
    }
  });
  const scheduleRefresh = FiberHandle.run(refreshTimer, refreshLoop).pipe(Effect.asVoid);

  const current: GitHubAppConnection["Service"]["current"] = Effect.fn(
    "GitHubAppConnection.current",
  )(function* (minLifetime) {
    const envelope = yield* readEnvelope;
    if (envelope === null) return null;
    if (envelope.state === "reauthorize") return yield* failure(REAUTHORIZE_MESSAGE, true);
    const now = yield* Clock.currentTimeMillis;
    if (
      envelope.state === "ready" &&
      envelope.accessExpiresAt - now >= Duration.toMillis(minLifetime)
    ) {
      return tokenOf(envelope);
    }
    const refreshed = yield* mutex.withPermit(rotateIfShort(minLifetime));
    if (refreshed === null) return null;
    yield* scheduleRefresh;
    return tokenOf(refreshed);
  });

  const generation: GitHubAppConnection["Service"]["generation"] = readEnvelope.pipe(
    Effect.map((envelope) =>
      envelope !== null && envelope.state === "ready" ? envelope.generation : null,
    ),
  );

  const generations: GitHubAppConnection["Service"]["generations"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the read, so a change between the two is buffered, not dropped.
      const subscription = yield* PubSub.subscribe(generationsPubSub);
      const envelope = yield* readEnvelope.pipe(Effect.orElseSucceed(() => null));
      return Stream.concat(
        Stream.make(envelope?.generation ?? null),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const validCallbackUrl = Effect.fn("GitHubAppConnectionSetup.validCallbackUrl")(function* (
    value: string,
  ) {
    const url = URL.canParse(value) ? new URL(value) : null;
    if (
      url === null ||
      !CALLBACK_SCHEMES.has(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== callbackPath
    ) {
      return yield* failure("The callback URL must be this environment's GitHub callback route.");
    }
    return value;
  });

  const begin: GitHubAppConnectionSetup["Service"]["begin"] = Effect.fn(
    "GitHubAppConnectionSetup.begin",
  )(function* (input) {
    const callbackUrl = yield* validCallbackUrl(input.callbackUrl);
    const registration = yield* readRegistration;
    const now = yield* Clock.currentTimeMillis;
    for (const [state, flow] of pending) if (flow.expiresAt <= now) pending.delete(state);
    const state = yield* newState;
    const expiresAt = now + Duration.toMillis(STATE_TTL);
    if (input.step === "register") {
      if (registration !== null) {
        return yield* failure(
          "A GitHub App is already registered. Remove it before creating another.",
        );
      }
      const callbackUrls = githubApp.githubAppCallbackUrls(callbackUrl, callbackPath);
      pending.set(state, { step: "register", callbackUrls, expiresAt });
      // App names are unique across GitHub; the user can still edit it on GitHub's page.
      const suffix = yield* crypto.randomBytes(2).pipe(
        Effect.map(Hex.encode),
        Effect.orElseSucceed(() => state.slice(0, 4)),
      );
      return {
        _tag: "manifest",
        state,
        action: githubApp.manifestFormAction(state),
        manifest: githubApp.encodeManifest(
          githubApp.githubAppManifest({
            name: `T3 Code Sandboxes ${suffix}`,
            redirectUrl: callbackUrl,
            callbackUrls,
          }),
        ),
      };
    }
    if (registration === null) {
      return yield* failure("No GitHub App is registered yet. Connect GitHub first.");
    }
    if (!registration.callbackUrls.includes(callbackUrl)) {
      return yield* failure(
        `GitHub can only send you back to ${registration.callbackUrls.join(", ")}. Reconnect from one of those, or remove the App and connect again.`,
      );
    }
    pending.set(state, { step: "authorize", callbackUrls: registration.callbackUrls, expiresAt });
    return {
      _tag: "authorize",
      state,
      url: githubApp.authorizeUrl(registration.clientId, callbackUrl, state),
    };
  });

  /**
   * Finishes a browser step. Under the mutex with the refresh and the
   * disconnect, so two sign-ins racing each other cannot leave one App's
   * registration beside another App's tokens. The second register step finds
   * the first's App and is refused.
   */
  const complete: GitHubAppConnectionSetup["Service"]["complete"] = Effect.fn(
    "GitHubAppConnectionSetup.complete",
  )(function* (input) {
    const flow = pending.get(input.state);
    pending.delete(input.state);
    const now = yield* Clock.currentTimeMillis;
    if (flow === undefined || flow.expiresAt <= now) {
      return yield* failure(
        "This GitHub sign-in link expired or was already used. Start again from Settings.",
      );
    }
    if (flow.step === "register") {
      if ((yield* readRegistration) !== null) {
        return yield* failure(
          "Another sign-in registered a GitHub App first, so the App this one created is not used. Delete it from your GitHub developer settings, and connect with the registered App.",
        );
      }
      const app = yield* githubApp
        .convertManifest(http, input.code)
        .pipe(Effect.mapError(apiFailure("create the App")));
      // The private key and webhook secret GitHub returns are not kept: user tokens need neither.
      yield* secrets
        .set(CLIENT_SECRET_NAME, textEncoder.encode(app.client_secret))
        .pipe(Effect.catch(storeFailure));
      yield* writeApp({
        appId: app.id,
        slug: app.slug,
        clientId: app.client_id,
        callbackUrls: flow.callbackUrls,
        connection: { _tag: "disconnected" },
      });
      const installState = yield* newState;
      pending.set(installState, {
        step: "authorize",
        callbackUrls: flow.callbackUrls,
        expiresAt: now + Duration.toMillis(STATE_TTL),
      });
      return {
        _tag: "install",
        url: githubApp.installUrl(app.slug, installState),
      } satisfies SandboxGitHubFlowNext;
    }
    const registration = yield* readRegistration;
    if (registration === null) {
      return yield* failure("No GitHub App is registered yet. Connect GitHub first.");
    }
    const clientSecret = yield* readClientSecret;
    const grant = yield* githubApp
      .exchangeCode(http, { clientId: registration.clientId, clientSecret, code: input.code })
      .pipe(Effect.mapError(apiFailure("finish signing in")), Effect.flatMap(expiring));
    const user = yield* githubApp
      .fetchUser(http, grant.access_token)
      .pipe(Effect.mapError(apiFailure("read your GitHub profile")));
    const previous = yield* readEnvelope;
    const envelope = grantedEnvelope(
      grant,
      nextGeneration(previous?.generation ?? null, now),
      { login: user.login, name: user.name ?? null, email: user.email ?? null },
      now,
    );
    yield* writeEnvelope(envelope);
    yield* mirror(envelope);
    yield* publish(envelope.generation);
    yield* scheduleRefresh;
    return { _tag: "connected" } satisfies SandboxGitHubFlowNext;
  }, mutex.withPermit);

  /**
   * Revokes the grant at GitHub when it can, then forgets the connection here
   * whatever GitHub said. A disconnect must not be refused for an offline
   * GitHub or a client secret that is gone.
   */
  const disconnect: GitHubAppConnectionSetup["Service"]["disconnect"] = Effect.fn(
    "GitHubAppConnectionSetup.disconnect",
  )(function* (input) {
    const registration = yield* readRegistration;
    const envelope = yield* readEnvelope;
    if (envelope !== null && registration !== null) {
      yield* readClientSecret.pipe(
        Effect.flatMap((clientSecret) =>
          githubApp
            .revokeGrant(http, {
              clientId: registration.clientId,
              clientSecret,
              accessToken: envelope.accessToken,
            })
            .pipe(Effect.mapError(apiFailure("revoke the authorization"))),
        ),
        Effect.ignore({ log: true }),
      );
    }
    yield* FiberHandle.clear(refreshTimer);
    yield* clearEnvelope;
    if (input.forgetApp) {
      yield* secrets.remove(CLIENT_SECRET_NAME).pipe(Effect.catch(storeFailure));
      yield* writeApp(null);
    } else {
      yield* mirror(null);
    }
    if (envelope !== null) yield* publish(null);
  }, mutex.withPermit);

  // A refresh this process never saw the end of is left to the refresh loop,
  // which sends it again at once. Starting never waits on GitHub.
  const envelope = yield* readEnvelope.pipe(Effect.orElseSucceed(() => null));
  const registration = yield* readRegistration.pipe(Effect.orElseSucceed(() => null));
  if (registration !== null) {
    const recorded = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.sandboxGitHubApp?.connection;
    if (!Equal.equals(recorded, connectionOf(envelope))) {
      yield* mirror(envelope).pipe(Effect.ignore({ log: true }));
    }
  }
  yield* scheduleRefresh;

  return Context.make(
    GitHubAppConnection,
    GitHubAppConnection.of({ current, generation, generations }),
  ).pipe(
    Context.add(
      GitHubAppConnectionSetup,
      GitHubAppConnectionSetup.of({ begin, complete, disconnect }),
    ),
  );
});

/** The connection and its setup flows, over the server settings, the secret store, and GitHub. */
export const layer = Layer.effectContext(make);
