/**
 * GitHubAppConnection - the owner's GitHub App for its sandboxes. The owner
 * registers a per-user App, keeps the App user's single rotating refresh
 * token, and hands sandboxes 8-hour user tokens, so agents push and open pull
 * requests as the user without a long-lived credential on the machine.
 *
 * @module GitHubAppConnection
 */
import type * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

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
    /** The current generation, then each new one: a rotation, a connect, or a disconnect (null). */
    readonly generations: Stream.Stream<number | null>;
  }
>()("t3/sandbox/GitHubAppConnection") {}
