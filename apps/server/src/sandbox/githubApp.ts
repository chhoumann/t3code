/**
 * githubApp - the GitHub side of the owner's App: the manifest it is created
 * from, the pages the browser visits, and the five API calls the connection
 * makes. Nothing here keeps state.
 *
 * @module githubApp
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

const GITHUB_WEB = "https://github.com";
const GITHUB_API = "https://api.github.com";

/**
 * Callback origins every App registers besides the creating client's, so the
 * hosted web app and the desktop app can finish a later authorization. GitHub
 * sends OAuth-on-install results to the first callback URL, the creator's.
 */
const SHARED_CALLBACK_ORIGINS = ["https://app.t3.codes", "t3code://app"];

export const githubAppCallbackUrls = (
  clientCallbackUrl: string,
  callbackPath: string,
): ReadonlyArray<string> => [
  ...new Set([
    clientCallbackUrl,
    ...SHARED_CALLBACK_ORIGINS.map((origin) => `${origin}${callbackPath}`),
  ]),
];

/**
 * The manifest GitHub creates the App from. Public, so the user can install it
 * on organizations too. No webhook (GitHub requires a URL for any `hook_attributes`): the owner polls nothing. User tokens expire
 * by default for an App created this way, which the connection relies on.
 */
export const GitHubAppManifest = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  description: Schema.String,
  public: Schema.Boolean,
  default_permissions: Schema.Record(Schema.String, Schema.String),
  default_events: Schema.Array(Schema.String),
  redirect_url: Schema.String,
  callback_urls: Schema.Array(Schema.String),
  request_oauth_on_install: Schema.Boolean,
  setup_on_update: Schema.Boolean,
});
export type GitHubAppManifest = typeof GitHubAppManifest.Type;

export const githubAppManifest = (input: {
  readonly name: string;
  readonly redirectUrl: string;
  readonly callbackUrls: ReadonlyArray<string>;
}): GitHubAppManifest => ({
  name: input.name,
  url: "https://t3.codes",
  description: "Lets T3 Code sandboxes clone, push, and open pull requests as you.",
  public: true,
  default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  default_events: [],
  redirect_url: input.redirectUrl,
  callback_urls: input.callbackUrls,
  request_oauth_on_install: true,
  setup_on_update: false,
});

/** The form field GitHub reads the manifest from is a JSON string. */
export const encodeManifest = Schema.encodeSync(Schema.fromJsonString(GitHubAppManifest));

/** The browser POSTs the manifest here; GitHub returns the creation code to the manifest's redirect URL. */
export const manifestFormAction = (state: string): string =>
  `${GITHUB_WEB}/settings/apps/new?state=${encodeURIComponent(state)}`;

/** Installing on repositories, then authorizing the user on the way back to the first callback URL. */
export const installUrl = (slug: string, state: string): string =>
  `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;

/** GitHub's own page for adding and removing the repositories the App may reach. */
export const installationsUrl = (slug: string): string =>
  `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new`;

export const authorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
};

/**
 * How a GitHub call failed. `Transport` means no answer arrived, so GitHub may
 * or may not have acted on the request; the other two mean it answered.
 */
export type GitHubApiFailure =
  | { readonly _tag: "Transport"; readonly cause: unknown }
  | { readonly _tag: "Status"; readonly status: number }
  | { readonly _tag: "OAuth"; readonly error: string; readonly description: string | undefined };

export const ManifestConversion = Schema.Struct({
  id: Schema.Int,
  slug: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.String,
});
export type ManifestConversion = typeof ManifestConversion.Type;

/** Without `expires_in` and `refresh_token`, the App does not expire user tokens. */
export const TokenGrant = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
});
export type TokenGrant = typeof TokenGrant.Type;

/** GitHub's token endpoint answers 200 with this body when it refuses. */
const OAuthRefusal = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

export const GitHubUser = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});
export type GitHubUser = typeof GitHubUser.Type;

const decodeManifestConversion = Schema.decodeUnknownEffect(ManifestConversion);
const decodeTokenGrant = Schema.decodeUnknownEffect(TokenGrant);
const decodeGitHubUser = Schema.decodeUnknownEffect(GitHubUser);
const isOAuthRefusal = Schema.is(OAuthRefusal);

const isOk = (status: number) => status >= 200 && status < 300;

const transport = (cause: unknown): GitHubApiFailure => ({ _tag: "Transport", cause });
const status = (response: HttpClientResponse.HttpClientResponse): GitHubApiFailure => ({
  _tag: "Status",
  status: response.status,
});

const send = (http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest) =>
  http
    .execute(
      request.pipe(
        HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
      ),
    )
    .pipe(Effect.mapError(transport));

/** The answer's JSON, or a `Status` failure when the answer is not OK or has no readable body. */
const okJson = <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.fn("githubApp.okJson")(function* (response: HttpClientResponse.HttpClientResponse) {
    if (!isOk(response.status)) return yield* Effect.fail(status(response));
    const json = yield* response.json.pipe(Effect.mapError(() => status(response)));
    return yield* decode(json).pipe(Effect.mapError(() => status(response)));
  });

/** `POST /app-manifests/{code}/conversions`: the App GitHub just created from the manifest. */
export const convertManifest = (http: HttpClient.HttpClient, code: string) =>
  send(
    http,
    HttpClientRequest.post(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`),
  ).pipe(Effect.flatMap(okJson(decodeManifestConversion)));

const tokenEndpoint = Effect.fn("githubApp.tokenEndpoint")(function* (
  http: HttpClient.HttpClient,
  params: Record<string, string>,
) {
  const response = yield* send(
    http,
    HttpClientRequest.post(`${GITHUB_WEB}/login/oauth/access_token`).pipe(
      HttpClientRequest.bodyUrlParams(params),
    ),
  );
  const json = yield* response.json.pipe(Effect.mapError(() => status(response)));
  if (isOAuthRefusal(json)) {
    return yield* Effect.fail<GitHubApiFailure>({
      _tag: "OAuth",
      error: json.error,
      description: json.error_description,
    });
  }
  if (!isOk(response.status)) return yield* Effect.fail(status(response));
  return yield* decodeTokenGrant(json).pipe(Effect.mapError(() => status(response)));
});

export const exchangeCode = (
  http: HttpClient.HttpClient,
  input: { readonly clientId: string; readonly clientSecret: string; readonly code: string },
) =>
  tokenEndpoint(http, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
  });

/** One refresh. GitHub revokes the previous access and refresh tokens when it answers. */
export const refreshTokens = (
  http: HttpClient.HttpClient,
  input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
) =>
  tokenEndpoint(http, {
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });

export const fetchUser = (http: HttpClient.HttpClient, accessToken: string) =>
  send(
    http,
    HttpClientRequest.get(`${GITHUB_API}/user`).pipe(HttpClientRequest.bearerToken(accessToken)),
  ).pipe(Effect.flatMap(okJson(decodeGitHubUser)));

/**
 * `DELETE /applications/{client_id}/grant`: revokes the user's authorization
 * of the App, every token with it. A grant GitHub no longer knows counts as
 * revoked.
 */
export const revokeGrant = (
  http: HttpClient.HttpClient,
  input: { readonly clientId: string; readonly clientSecret: string; readonly accessToken: string },
) =>
  send(
    http,
    HttpClientRequest.delete(
      `${GITHUB_API}/applications/${encodeURIComponent(input.clientId)}/grant`,
    ).pipe(
      HttpClientRequest.basicAuth(input.clientId, input.clientSecret),
      HttpClientRequest.bodyJsonUnsafe({ access_token: input.accessToken }),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      isOk(response.status) || response.status === 404 || response.status === 422
        ? Effect.void
        : Effect.fail(status(response)),
    ),
  );
