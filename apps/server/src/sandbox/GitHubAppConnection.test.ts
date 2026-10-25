import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, sandboxGitHubCallbackPath } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubAppConnection from "./GitHubAppConnection.ts";

const OWNER = EnvironmentId.make("owner-env");
const CALLBACK_URL = `http://localhost:3000${sandboxGitHubCallbackPath(OWNER)}`;
const CLIENT_ID = "Iv1.client";
const CLIENT_SECRET = "client-secret-shh";
const HOUR = 3_600_000;

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly params: URLSearchParams;
  readonly json: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * GitHub as the connection sees it: one App, one user, and a refresh chain
 * where each refresh token works exactly once.
 */
const makeGitHub = () => {
  const github = {
    requests: [] as Array<Recorded>,
    issued: 0,
    /** Refresh tokens GitHub still honors. */
    liveRefreshTokens: new Set<string>(),
    /** Access tokens GitHub still accepts; a refresh revokes the generation before it. */
    liveAccessTokens: new Set<string>(),
    /** When set, GitHub signals `entered` on the next refresh and answers it once `release` is done. */
    refreshGate: null as {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null,
    /**
     * How the next refresh goes when not plainly with tokens: the request never
     * arrives, GitHub rotates but the answer is lost or unreadable, or GitHub
     * is down.
     */
    nextRefreshAnswer: null as "transport" | "lost" | "garbled" | "unavailable" | null,
    /** The next `GET /user` never arrives. */
    nextUserAnswer: null as "transport" | null,
    revokedGrants: 0,
  };
  const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: "ECONNRESET" }),
      }),
    );
  const issueTokens = (withRefresh = true) => {
    github.issued += 1;
    const access_token = `access-${github.issued}`;
    github.liveAccessTokens.add(access_token);
    if (!withRefresh) return { access_token, token_type: "bearer" };
    const refresh_token = `refresh-${github.issued}`;
    github.liveRefreshTokens.add(refresh_token);
    return {
      access_token,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token,
      refresh_token_expires_in: 15_897_600,
    };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const answer = (request: HttpClientRequest.HttpClientRequest, recorded: Recorded) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.startsWith("/app-manifests/")) {
        const code = path.split("/")[2];
        if (code !== "manifest-code") return json({ message: "Not Found" }, 404);
        return json(
          {
            id: 4242,
            slug: "t3-code-sandboxes-ab12",
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            webhook_secret: "hook-secret",
            pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
            html_url: "https://github.com/apps/t3-code-sandboxes-ab12",
          },
          201,
        );
      }
      if (request.method === "POST" && path === "/login/oauth/access_token") {
        const params = recorded.params;
        if (
          params.get("client_id") !== CLIENT_ID ||
          params.get("client_secret") !== CLIENT_SECRET
        ) {
          return json({ error: "incorrect_client_credentials" });
        }
        if (params.get("grant_type") === "refresh_token") {
          if (github.refreshGate !== null) {
            const gate = github.refreshGate;
            github.refreshGate = null;
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          const pending = github.nextRefreshAnswer;
          github.nextRefreshAnswer = null;
          if (pending === "transport") return yield* transportFailure(request);
          if (pending === "unavailable") return json({ message: "unavailable" }, 503);
          const token = params.get("refresh_token") ?? "";
          if (!github.liveRefreshTokens.delete(token)) return json({ error: "bad_refresh_token" });
          github.liveAccessTokens.clear();
          const tokens = issueTokens();
          if (pending === "lost") return yield* transportFailure(request);
          if (pending === "garbled") {
            return new Response("<!doctype html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          }
          return json(tokens);
        }
        switch (params.get("code")) {
          case "install-code":
            return json(issueTokens());
          case "no-expiry-code":
            return json(issueTokens(false));
          default:
            return json({ error: "bad_verification_code" });
        }
      }
      if (request.method === "GET" && path === "/user") {
        if (github.nextUserAnswer === "transport") {
          github.nextUserAnswer = null;
          return yield* transportFailure(request);
        }
        const token = (recorded.headers["authorization"] ?? "").replace(/^Bearer /, "");
        if (!github.liveAccessTokens.has(token)) return json({}, 401);
        return json({ login: "octocat", name: "The Octocat", email: null });
      }
      if (request.method === "DELETE" && path === `/applications/${CLIENT_ID}/grant`) {
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if (recorded.headers["authorization"] !== expected) return json({}, 401);
        github.revokedGrants += 1;
        github.liveRefreshTokens.clear();
        return new Response(null, { status: 204 });
      }
      return json({ message: `unexpected ${request.method} ${path}` }, 500);
    });
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const contentType = request.headers["content-type"] ?? "";
      const recorded: Recorded = {
        method: request.method,
        url: request.url,
        params: contentType.includes("x-www-form-urlencoded")
          ? new URLSearchParams(body)
          : new URLSearchParams(),
        json: contentType.includes("json") && body.length > 0 ? JSON.parse(body) : null,
        headers: request.headers,
      };
      github.requests.push(recorded);
      return HttpClientResponse.fromWeb(request, yield* answer(request, recorded));
    }),
  );
  return { github, http };
};

const makeWorld = () => {
  const { github, http } = makeGitHub();
  const secrets = new Map<string, Uint8Array>();
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  const layer = GitHubAppConnection.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(OWNER),
        getDescriptor: Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  /** An App an earlier run registered, for worlds that start from a seeded envelope. */
  let registered = false;
  const seedRegistration = () => {
    registered = true;
    secrets.set("sandbox-github-app-client-secret", new TextEncoder().encode(CLIENT_SECRET));
  };
  /** Builds the connection in its own scope; closing the scope is a crash or a shutdown. */
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const settings = yield* Layer.buildWithScope(ServerSettings.layerTest(), scope);
    if (registered) {
      yield* Context.get(settings, ServerSettings.ServerSettingsService).updateSandboxAccounts(
        (current) =>
          Effect.succeed({
            ...current,
            sandboxGitHubApp: {
              appId: 4242,
              slug: "t3-code-sandboxes-ab12",
              clientId: CLIENT_ID,
              callbackUrls: [CALLBACK_URL],
              connection: {
                _tag: "connected",
                user: { login: "octocat", name: "The Octocat", email: null },
              },
            },
          }),
      );
    }
    const context = yield* Layer.buildWithScope(
      layer.pipe(Layer.provide(Layer.succeedContext(settings))),
      scope,
    );
    return { scope, context: Context.merge(settings, context) };
  });
  const secretText = (name: string) => {
    const bytes = secrets.get(name);
    return bytes === undefined ? null : new TextDecoder().decode(bytes);
  };
  const envelope = () => {
    const text = secretText("sandbox-github-app-user");
    return text === null
      ? null
      : (JSON.parse(text) as {
          generation: number;
          accessToken: string;
          refreshToken: string;
          accessExpiresAt: number;
          state: string;
        });
  };
  const seedEnvelope = (state: string, accessExpiresAt: number) =>
    secrets.set(
      "sandbox-github-app-user",
      new TextEncoder().encode(
        JSON.stringify({
          generation: 3,
          accessToken: "access-seeded",
          accessExpiresAt,
          refreshToken: "refresh-seeded",
          refreshExpiresAt: accessExpiresAt + 100 * HOUR,
          state,
          user: { login: "octocat", name: "The Octocat", email: null },
        }),
      ),
    );
  return { github, secrets, secretText, envelope, seedEnvelope, seedRegistration, start };
};

/** Registers the App and connects its user, the way Settings and the callback route do. */
const connect = Effect.gen(function* () {
  const setup = yield* GitHubAppConnection.GitHubAppConnectionSetup;
  const started = yield* setup.begin({ step: "register", callbackUrl: CALLBACK_URL });
  assert.strictEqual(started._tag, "manifest");
  const next = yield* setup.complete({ state: started.state, code: "manifest-code" });
  if (next._tag !== "install") return yield* Effect.die("expected the install step");
  const installState = new URL(next.url).searchParams.get("state");
  if (installState === null) return yield* Effect.die("expected an install state");
  const done = yield* setup.complete({ state: installState, code: "install-code" });
  assert.strictEqual(done._tag, "connected");
});

/** Each generation the stream reports, the current one first. Returns once that first one is in. */
const observeGenerations = Effect.gen(function* () {
  const connection = yield* GitHubAppConnection.GitHubAppConnection;
  const seen = yield* Queue.unbounded<number | null>();
  yield* connection.generations.pipe(
    Stream.runForEach((generation) => Queue.offer(seen, generation)),
    Effect.forkChild,
  );
  const initial = yield* Queue.take(seen);
  return { initial, next: Queue.take(seen) };
});

const refreshesSent = (github: ReturnType<typeof makeGitHub>["github"]) =>
  github.requests.filter((request) => request.params.get("grant_type") === "refresh_token").length;
const probesSent = (github: ReturnType<typeof makeGitHub>["github"]) =>
  github.requests.filter((request) => request.method === "GET" && request.url.endsWith("/user"))
    .length;

/** Moves the test clock on until `awaited` resolves, for timers set between steps. */
const advanceUntil = <A, E, R>(awaited: Effect.Effect<A, E, R>, step: Duration.Input) =>
  Effect.gen(function* () {
    const seen = yield* Effect.forkChild(awaited);
    yield* TestClock.adjust(step).pipe(
      Effect.repeat({ until: () => seen.pollUnsafe() !== undefined }),
    );
    return yield* Fiber.join(seen);
  });

describe("GitHubAppConnection", () => {
  it.effect("creates the App from a manifest and keeps only what user tokens need", () =>
    Effect.gen(function* () {
      const { github, secretText, secrets, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const setup = yield* GitHubAppConnection.GitHubAppConnectionSetup;
        const started = yield* setup.begin({ step: "register", callbackUrl: CALLBACK_URL });
        assert.strictEqual(started._tag, "manifest");
        if (started._tag !== "manifest") return;
        assert.strictEqual(
          started.action,
          `https://github.com/settings/apps/new?state=${started.state}`,
        );
        const manifest = JSON.parse(started.manifest) as Record<string, unknown>;
        assert.strictEqual(manifest.public, true);
        assert.strictEqual(manifest.request_oauth_on_install, true);
        assert.deepStrictEqual(manifest.default_permissions, {
          contents: "write",
          pull_requests: "write",
          metadata: "read",
        });
        // GitHub refuses a manifest whose hook_attributes has no url.
        assert.notProperty(manifest, "hook_attributes");
        assert.strictEqual(manifest.redirect_url, CALLBACK_URL);
        assert.deepStrictEqual(manifest.callback_urls, [
          CALLBACK_URL,
          `https://app.t3.codes${sandboxGitHubCallbackPath(OWNER)}`,
          `t3code://app${sandboxGitHubCallbackPath(OWNER)}`,
        ]);

        const next = yield* setup.complete({ state: started.state, code: "manifest-code" });
        assert.strictEqual(next._tag, "install");
        if (next._tag !== "install") return;
        const installUrl = new URL(next.url);
        assert.strictEqual(
          installUrl.origin + installUrl.pathname,
          "https://github.com/apps/t3-code-sandboxes-ab12/installations/new",
        );
        assert.isString(installUrl.searchParams.get("state"));
        assert.notStrictEqual(installUrl.searchParams.get("state"), started.state);

        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.deepStrictEqual(settings.sandboxGitHubApp, {
          appId: 4242,
          slug: "t3-code-sandboxes-ab12",
          clientId: CLIENT_ID,
          callbackUrls: manifest.callback_urls as ReadonlyArray<string>,
          connection: { _tag: "disconnected" },
        });
        assert.strictEqual(secretText("sandbox-github-app-client-secret"), CLIENT_SECRET);
        const stored = [...secrets.values()].map((bytes) => new TextDecoder().decode(bytes));
        assert.isFalse(stored.some((value) => value.includes("hook-secret")));
        assert.isFalse(stored.some((value) => value.includes("PRIVATE KEY")));
        assert.notInclude(JSON.stringify(settings), CLIENT_SECRET);
        assert.strictEqual(github.requests.length, 1);
        assert.strictEqual(
          github.requests[0]!.url,
          "https://api.github.com/app-manifests/manifest-code/conversions",
        );
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("connects the user after install and hands out the token with its generation", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        const generations = yield* observeGenerations;
        assert.isNull(generations.initial);
        assert.isNull(yield* connection.current(Duration.hours(1)));
        yield* connect;
        const token = yield* connection.current(Duration.hours(1));
        assert.isNotNull(token);
        assert.strictEqual(Redacted.value(token!.token), "access-1");
        assert.strictEqual(yield* generations.next, token!.generation);
        assert.strictEqual(token!.login, "octocat");
        assert.strictEqual(token!.name, "The Octocat");
        assert.isNull(token!.email);
        assert.strictEqual(token!.expiresAt, 8 * HOUR);

        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.deepStrictEqual(settings.sandboxGitHubApp?.connection, {
          _tag: "connected",
          user: { login: "octocat", name: "The Octocat", email: null },
        });
        assert.notInclude(JSON.stringify(settings), "access-1");
        assert.notInclude(JSON.stringify(settings), "refresh-1");
        assert.strictEqual(envelope()?.state, "ready");
        const exchange = github.requests.find(
          (request) => request.params.get("code") === "install-code",
        );
        assert.strictEqual(exchange?.params.get("client_secret"), CLIENT_SECRET);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("refuses a grant whose tokens never expire and stays disconnected", () =>
    Effect.gen(function* () {
      const { envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const setup = yield* GitHubAppConnection.GitHubAppConnectionSetup;
        const started = yield* setup.begin({ step: "register", callbackUrl: CALLBACK_URL });
        const next = yield* setup.complete({ state: started.state, code: "manifest-code" });
        if (next._tag !== "install") return assert.fail("expected the install step");
        const installState = new URL(next.url).searchParams.get("state")!;
        const error = yield* setup
          .complete({ state: installState, code: "no-expiry-code" })
          .pipe(Effect.flip);
        assert.include(error.message, "never expires");
        assert.isFalse(error.reauthorize);
        assert.isNull(envelope());
        assert.isNull(
          yield* (yield* GitHubAppConnection.GitHubAppConnection).current(Duration.zero),
        );
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("refreshes once for concurrent callers and moves to the next generation", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        // Two hours left, before the timer's own refresh: callers wanting three must share one refresh.
        yield* TestClock.adjust(Duration.hours(6));
        const gate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        github.refreshGate = gate;
        const first = yield* Effect.forkChild(connection.current(Duration.hours(3)));
        const second = yield* Effect.forkChild(connection.current(Duration.hours(3)));
        yield* Deferred.await(gate.entered);
        assert.strictEqual(envelope()?.state, "rotating");
        yield* Deferred.succeed(gate.release, undefined);
        const tokens = [yield* Fiber.join(first), yield* Fiber.join(second)];
        const refreshes = github.requests.filter(
          (request) => request.params.get("grant_type") === "refresh_token",
        );
        assert.strictEqual(refreshes.length, 1);
        assert.strictEqual(refreshes[0]!.params.get("refresh_token"), "refresh-1");
        assert.strictEqual(Redacted.value(tokens[0]!.token), "access-2");
        assert.strictEqual(Redacted.value(tokens[1]!.token), "access-2");
        assert.strictEqual(tokens[0]!.generation, tokens[1]!.generation);
        assert.isAbove(tokens[0]!.generation, 1);
        assert.strictEqual(envelope()?.state, "ready");
        assert.strictEqual(envelope()?.refreshToken, "refresh-2");
        // GitHub revoked generation 1 with the refresh; nothing here can hand it out again.
        assert.isFalse(github.liveRefreshTokens.has("refresh-1"));
        const latest = yield* connection.generations.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual([...latest], [tokens[0]!.generation]);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("reads the current generation without refreshing a token that is running short", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        assert.isNull(yield* connection.generation);
        yield* connect;
        // Two hours left: a caller wanting three would refresh, a look must not.
        yield* TestClock.adjust(Duration.hours(6));
        assert.strictEqual(yield* connection.generation, envelope()?.generation);
        assert.isFalse(
          github.requests.some((request) => request.params.get("grant_type") === "refresh_token"),
        );
        assert.strictEqual(envelope()?.accessToken, "access-1");
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("refreshes on its own an hour before the token expires", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        const first = envelope()?.generation ?? 0;
        const rotated = connection.generations.pipe(
          Stream.filter((generation) => generation !== null && generation > first),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* advanceUntil(rotated, Duration.hours(1));
        assert.isAbove(envelope()?.generation ?? 0, first);
        assert.strictEqual(envelope()?.accessToken, "access-2");
        // The timer fired at expiry minus the lead, not earlier.
        const refresh = github.requests.find(
          (request) => request.params.get("grant_type") === "refresh_token",
        );
        assert.isDefined(refresh);
        assert.isAtLeast(yield* Clock.currentTimeMillis, 7 * HOUR);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("settles a refresh under way at startup by asking GitHub about the old token", () =>
    Effect.gen(function* () {
      // GitHub still takes the old token: the refresh never happened, the chain is whole.
      const kept = makeWorld();
      kept.seedEnvelope("rotating", 8 * HOUR);
      kept.github.liveAccessTokens.add("access-seeded");
      const keptStarted = yield* kept.start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        assert.strictEqual(kept.envelope()?.state, "ready");
        const token = yield* connection.current(Duration.hours(1));
        assert.strictEqual(Redacted.value(token!.token), "access-seeded");
        assert.strictEqual(refreshesSent(kept.github), 0);
      }).pipe(Effect.provide(keptStarted.context));

      // GitHub refuses the old token: it rotated, and the new tokens went down with the process.
      const broken = makeWorld();
      broken.seedEnvelope("rotating", 8 * HOUR);
      const brokenStarted = yield* broken.start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        assert.strictEqual(broken.envelope()?.state, "reauthorize");
        const error = yield* connection.current(Duration.hours(1)).pipe(Effect.flip);
        assert.isTrue(error.reauthorize);
        assert.strictEqual(refreshesSent(broken.github), 0);
      }).pipe(Effect.provide(brokenStarted.context));

      // GitHub cannot be asked: the refresh stays under way and is sent again.
      const unknown = makeWorld();
      unknown.seedRegistration();
      unknown.seedEnvelope("rotating", 8 * HOUR);
      unknown.github.nextUserAnswer = "transport";
      unknown.github.liveRefreshTokens.add("refresh-seeded");
      const unknownStarted = yield* unknown.start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        assert.strictEqual(unknown.envelope()?.state, "rotating");
        assert.isNull(yield* connection.generation);
        const token = yield* connection.current(Duration.hours(1));
        assert.strictEqual(Redacted.value(token!.token), "access-1");
        assert.strictEqual(unknown.envelope()?.state, "ready");
      }).pipe(Effect.provide(unknownStarted.context));
    }),
  );

  it.effect("does not ask GitHub about an old token that has expired, and refreshes again", () =>
    Effect.gen(function* () {
      const { github, envelope, seedEnvelope, seedRegistration, start } = makeWorld();
      seedRegistration();
      seedEnvelope("rotating", -HOUR);
      github.liveRefreshTokens.add("refresh-seeded");
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        assert.strictEqual(probesSent(github), 0);
        // The timer sends the refresh again at once; GitHub answers it plainly this time.
        const refreshed = connection.generations.pipe(
          Stream.filter((generation) => generation !== null && generation > 3),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* advanceUntil(refreshed, Duration.minutes(1));
        assert.strictEqual(envelope()?.state, "ready");
        assert.strictEqual(envelope()?.accessToken, "access-1");
        assert.strictEqual(probesSent(github), 0);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("stops the chain when GitHub rejects the refresh token", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        yield* TestClock.adjust(Duration.hours(6));
        github.liveRefreshTokens.clear();
        const rejected = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
        assert.isTrue(rejected.reauthorize);
        assert.strictEqual(envelope()?.state, "reauthorize");
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.strictEqual(settings.sandboxGitHubApp?.connection._tag, "reauthorize");
        // Nothing retries the consumed token on its own.
        const again = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
        assert.isTrue(again.reauthorize);
        assert.strictEqual(refreshesSent(github), 1);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect(
    "keeps the chain when a refresh never reaches GitHub, and refreshes on the next try",
    () =>
      Effect.gen(function* () {
        const { github, envelope, start } = makeWorld();
        const { context } = yield* start;
        yield* Effect.gen(function* () {
          const connection = yield* GitHubAppConnection.GitHubAppConnection;
          yield* connect;
          yield* TestClock.adjust(Duration.hours(6));
          const probesBefore = probesSent(github);
          github.nextRefreshAnswer = "transport";
          const error = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
          assert.isFalse(error.reauthorize);
          assert.include(error.message, "Could not reach GitHub");
          // GitHub still took the old token, so it never rotated and the old tokens stand.
          assert.strictEqual(probesSent(github) - probesBefore, 1);
          assert.strictEqual(envelope()?.state, "ready");
          assert.strictEqual(envelope()?.accessToken, "access-1");
          const token = yield* connection.current(Duration.hours(3));
          assert.strictEqual(Redacted.value(token!.token), "access-2");
        }).pipe(Effect.provide(context));
      }),
  );

  it.effect("needs sign-in again when GitHub rotated but its answer was lost or unreadable", () =>
    Effect.gen(function* () {
      for (const answer of ["lost", "garbled"] as const) {
        const { github, envelope, start } = makeWorld();
        const { context } = yield* start;
        yield* Effect.gen(function* () {
          const connection = yield* GitHubAppConnection.GitHubAppConnection;
          yield* connect;
          yield* TestClock.adjust(Duration.hours(6));
          github.nextRefreshAnswer = answer;
          const error = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
          assert.isTrue(error.reauthorize, answer);
          assert.strictEqual(envelope()?.state, "reauthorize", answer);
          const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
          assert.strictEqual(settings.sandboxGitHubApp?.connection._tag, "reauthorize", answer);
          assert.strictEqual(refreshesSent(github), 1, answer);
        }).pipe(Effect.provide(context));
      }
    }),
  );

  it.effect("keeps a refresh under way while GitHub cannot be asked, and sends it again", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        yield* TestClock.adjust(Duration.hours(6));
        github.nextRefreshAnswer = "transport";
        github.nextUserAnswer = "transport";
        const error = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
        assert.isFalse(error.reauthorize);
        assert.strictEqual(envelope()?.state, "rotating");
        // Nothing is handed out until GitHub has said which way it went.
        assert.isNull(yield* connection.generation);
        const token = yield* connection.current(Duration.hours(3));
        assert.strictEqual(Redacted.value(token!.token), "access-2");
        assert.strictEqual(envelope()?.state, "ready");
        assert.strictEqual(refreshesSent(github), 2);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("the timer sends a refresh whose answer is unknown again after its retry delay", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        const first = envelope()?.generation ?? 0;
        github.nextRefreshAnswer = "transport";
        github.nextUserAnswer = "transport";
        const rotated = connection.generations.pipe(
          Stream.filter((generation) => generation !== null && generation > first),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* advanceUntil(rotated, Duration.minutes(5));
        assert.strictEqual(envelope()?.state, "ready");
        assert.strictEqual(envelope()?.accessToken, "access-2");
        assert.strictEqual(refreshesSent(github), 2);
        assert.isAtLeast(yield* Clock.currentTimeMillis, 7 * HOUR + 5 * 60_000);
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("keeps the chain when GitHub answers a refresh with a server error", () =>
    Effect.gen(function* () {
      const { github, envelope, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        yield* connect;
        yield* TestClock.adjust(Duration.hours(6));
        github.nextRefreshAnswer = "unavailable";
        const error = yield* connection.current(Duration.hours(3)).pipe(Effect.flip);
        assert.isFalse(error.reauthorize);
        assert.include(error.message, "503");
        assert.strictEqual(envelope()?.state, "ready");
        const token = yield* connection.current(Duration.hours(3));
        assert.strictEqual(Redacted.value(token!.token), "access-2");
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect("disconnect revokes the grant, forgets the tokens, and tells the stream", () =>
    Effect.gen(function* () {
      const { github, envelope, secretText, start } = makeWorld();
      const { context } = yield* start;
      yield* Effect.gen(function* () {
        const connection = yield* GitHubAppConnection.GitHubAppConnection;
        const setup = yield* GitHubAppConnection.GitHubAppConnectionSetup;
        yield* connect;
        const generations = yield* observeGenerations;
        const connected = generations.initial;
        assert.isNotNull(connected);
        yield* setup.disconnect({ forgetApp: false });
        assert.isNull(yield* generations.next);
        assert.strictEqual(github.revokedGrants, 1);
        const revoke = github.requests.find((request) => request.method === "DELETE");
        assert.deepStrictEqual(revoke?.json, { access_token: "access-1" });
        assert.isNull(envelope());
        assert.isNull(yield* connection.current(Duration.hours(1)));
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.deepStrictEqual(settings.sandboxGitHubApp?.connection, { _tag: "disconnected" });
        assert.strictEqual(settings.sandboxGitHubApp?.clientId, CLIENT_ID);
        assert.strictEqual(secretText("sandbox-github-app-client-secret"), CLIENT_SECRET);

        // Reconnecting reuses the App through the authorize step.
        const again = yield* setup.begin({ step: "authorize", callbackUrl: CALLBACK_URL });
        assert.strictEqual(again._tag, "authorize");
        if (again._tag !== "authorize") return;
        const url = new URL(again.url);
        assert.strictEqual(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
        assert.strictEqual(url.searchParams.get("client_id"), CLIENT_ID);
        assert.strictEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL);
        assert.strictEqual(url.searchParams.get("state"), again.state);
        const done = yield* setup.complete({ state: again.state, code: "install-code" });
        assert.strictEqual(done._tag, "connected");
        // A guest still holding the revoked token must not match the new generation.
        assert.isAbove((yield* connection.current(Duration.hours(1)))!.generation, connected!);

        yield* setup.disconnect({ forgetApp: true });
        assert.isNull(
          (yield* (yield* ServerSettings.ServerSettingsService).getSettings).sandboxGitHubApp,
        );
        assert.isNull(secretText("sandbox-github-app-client-secret"));
      }).pipe(Effect.provide(context));
    }),
  );

  it.effect(
    "accepts a callback state once, within ten minutes, for the client route it was issued to",
    () =>
      Effect.gen(function* () {
        const { start } = makeWorld();
        const { context } = yield* start;
        yield* Effect.gen(function* () {
          const setup = yield* GitHubAppConnection.GitHubAppConnectionSetup;
          const foreign = yield* setup
            .begin({
              step: "register",
              callbackUrl: `https://10.0.0.5:3000${sandboxGitHubCallbackPath(OWNER)}`,
            })
            .pipe(Effect.result);
          assert.strictEqual(foreign._tag, "Success");
          const wrongPath = yield* setup
            .begin({ step: "register", callbackUrl: "http://localhost:3000/settings/sandboxes" })
            .pipe(Effect.flip);
          assert.include(wrongPath.message, "callback route");

          const started = yield* setup.begin({ step: "register", callbackUrl: CALLBACK_URL });
          const unknown = yield* setup
            .complete({ state: "not-issued", code: "manifest-code" })
            .pipe(Effect.flip);
          assert.include(unknown.message, "expired or was already used");
          const next = yield* setup.complete({ state: started.state, code: "manifest-code" });
          assert.strictEqual(next._tag, "install");
          const replay = yield* setup
            .complete({ state: started.state, code: "manifest-code" })
            .pipe(Effect.flip);
          assert.include(replay.message, "expired or was already used");

          const stale = yield* setup.begin({ step: "authorize", callbackUrl: CALLBACK_URL });
          yield* TestClock.adjust(Duration.minutes(11));
          const expired = yield* setup
            .complete({ state: stale.state, code: "install-code" })
            .pipe(Effect.flip);
          assert.include(expired.message, "expired or was already used");

          const elsewhere = yield* setup
            .begin({
              step: "authorize",
              callbackUrl: `http://10.0.0.5:3000${sandboxGitHubCallbackPath(OWNER)}`,
            })
            .pipe(Effect.flip);
          assert.include(elsewhere.message, CALLBACK_URL);
        }).pipe(Effect.provide(context));
      }),
  );
});
