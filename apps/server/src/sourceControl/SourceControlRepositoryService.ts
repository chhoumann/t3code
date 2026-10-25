// @effect-diagnostics-next-line nodeBuiltinImport:off -- rmdir(2) has no Effect counterpart. `remove` takes a directory only recursively.
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type GitCommandFailureReason,
  type ProjectCloneBase,
  type ProjectCloneCheckout,
  type SandboxBase,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitCommandError = Schema.is(GitCommandError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneCheckoutOptions,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    /**
     * Clones into a staging directory beside the destination and moves it
     * into place once git is done, so the destination only ever holds a
     * complete clone. Asked to `reuseMatching`, adopts a clone of the same
     * repository already at the destination instead. With a `checkout`, pins
     * the base.
     */
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneResult, SourceControlRepositoryError>;
    /** Removes the staging clone of `destinationPath`; a published destination is never touched. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
  /** The destination already holds a clone of this repository, which `reuseMatching` adopts. */
  readonly adopt: boolean;
}

export interface SourceControlCloneCheckoutOptions {
  readonly checkout?: ProjectCloneCheckout;
  /** Adopt a published clone of the same repository at the destination rather than refuse a non-empty one. */
  readonly reuseMatching?: boolean;
}

export interface SourceControlCloneOptions extends SourceControlCloneCheckoutOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

export interface SourceControlCloneResult extends SourceControlCloneRepositoryResult {
  /** Present when a `checkout` was asked for. */
  readonly base?: ProjectCloneBase;
}

/** Where a clone of `destinationPath` is made before it is moved into place. */
function cloneStagingPath(path: Path.Path, destinationPath: string): string {
  return path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.t3-clone`);
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            (isSourceControlProviderError(cause)
              ? SourceControlProvider.userFacingSourceControlDetail(cause.cause)
              : undefined) ?? "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

/**
 * Explains a failed first push of a published repository. The repository
 * already exists by then, so publishing again cannot help; the user has to
 * fix access and push. Built from fixed text and the provider's URLs only,
 * since git's stderr can carry credentials.
 */
function publishPushFailureDetail(input: {
  readonly urls: SourceControlRepositoryCloneUrls;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly reason: GitCommandFailureReason | undefined;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.url}`;
  const usesSsh = input.remoteUrl === input.urls.sshUrl;
  switch (input.reason) {
    case "authentication_failed":
      return usesSsh
        ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
        : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
    case "host_key_unverified":
      return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
    default:
      return `${created}. Fix the problem, then push again.`;
  }
}

/**
 * Adding a project clones over SSH for most hosts, and a machine with no SSH
 * key there would fail every time, while the host's HTTPS credential helper
 * may be set up. A clone whose SSH login was refused is retried once over
 * HTTPS, unless the caller asked for SSH. A looked-up repository has the
 * provider's own HTTPS URL; any other URL is rewritten, which is refused
 * where it would have to guess.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(
    function* (input: SourceControlRepositoryLookupInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "lookupRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.getRepositoryCloneUrls({
        cwd: input.cwd ?? config.cwd,
        repository: input.repository.trim(),
      });
      return toRepositoryInfo(providerKind, urls);
    },
    // Someone adding or cloning a repository is waiting, so a background rate-limit pause must not
    // refuse the lookup.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const cloneError = (detail: string, cause?: unknown) =>
    new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: SourceControlProviderKind.make("unknown"),
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const inspectDestination = Effect.fn("SourceControlRepositoryService.inspectDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      const parentPath = path.dirname(normalizedDestination);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError((cause) =>
              cloneError("Destination path already exists and is not a directory.", cause),
            ),
          );
        return { destinationPath: normalizedDestination, parentPath, entries };
      }
      // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
      if (!(yield* fileSystem.exists(parentPath))) {
        yield* fileSystem.makeDirectory(parentPath, { recursive: true });
      }
      return {
        destinationPath: normalizedDestination,
        parentPath,
        entries: [] as ReadonlyArray<string>,
      };
    },
  );

  /**
   * Whether a non-empty destination is a clone of `remoteUrl` to adopt. Only a
   * caller that asked to reuse one may; a clone of another repository is
   * refused and left as it is.
   */
  const adoptsDestination = Effect.fn("SourceControlRepositoryService.adoptsDestination")(
    function* (
      destination: { readonly destinationPath: string; readonly entries: ReadonlyArray<string> },
      remoteUrl: string,
      reuseMatching: boolean,
    ) {
      if (destination.entries.length === 0) return false;
      if (!reuseMatching || !destination.entries.includes(".git")) {
        return yield* cloneError("Destination path already exists and is not empty.");
      }
      const origin = yield* git
        .execute({
          operation: "SourceControlRepositoryService.adoptsDestination",
          cwd: destination.destinationPath,
          args: ["remote", "get-url", "origin"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError((cause) => cloneError("The existing clone could not be read.", cause)),
        );
      const key = sourceControlDefinitions.repositoryKeyFromRemote;
      if (origin.exitCode !== 0 || key(origin.stdout.trim()) !== key(remoteUrl)) {
        return yield* cloneError("Destination path holds a clone of another repository.");
      }
      return true;
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneCheckoutOptions,
  ) {
    const destination = yield* inspectDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: destination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    const redactedUrl = redactRemoteUrl(remoteUrl);
    return {
      destinationPath: destination.destinationPath,
      remoteUrl: redactedUrl,
      cloneUrl: remoteUrl,
      repository,
      adopt: yield* adoptsDestination(destination, redactedUrl, options?.reuseMatching === true),
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", cloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
  });

  const removeStaging = (stagingPath: string) =>
    fileSystem.remove(stagingPath, { recursive: true, force: true }).pipe(
      // An interrupted git may still be closing files, so removal retries briefly.
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError((cause) => cloneError("The partial clone could not be removed.", cause)),
    );

  /**
   * Moves the staged clone to the destination. The destination may exist as
   * the empty directory the project was created with; rename(2) replaces an
   * empty directory on POSIX but not on Windows, so it goes first. Only
   * rmdir(2) removes it. A file that landed there since the clone started
   * makes it refuse, and the publish fails instead of taking the file.
   */
  const publishClone = Effect.fn("SourceControlRepositoryService.publishClone")(function* (
    stagingPath: string,
    destinationPath: string,
  ) {
    yield* Effect.tryPromise({
      try: () => NodeFSP.rmdir(destinationPath),
      catch: (cause) => ({ code: (cause as NodeJS.ErrnoException | null)?.code, cause }),
    }).pipe(
      Effect.catch(({ code, cause }) =>
        code === "ENOENT"
          ? Effect.void
          : Effect.fail(
              code === "ENOTEMPTY" || code === "EEXIST"
                ? cloneError("Destination path already exists and is not empty.")
                : cloneError("The clone could not be moved into place.", cause),
            ),
      ),
    );
    yield* fileSystem
      .rename(stagingPath, destinationPath)
      .pipe(
        Effect.mapError((cause) => cloneError("The clone could not be moved into place.", cause)),
      );
  });

  const gitStep = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number | null },
  ) =>
    git
      .execute({
        operation: `SourceControlRepositoryService.${operation}`,
        cwd,
        args,
        env: CLONE_ENV,
        allowNonZeroExit: true,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      .pipe(Effect.mapError((cause) => cloneError("The repository could not be prepared.", cause)));

  /** The branch the remote's HEAD names, read live rather than from the clone's `origin/HEAD`. */
  const remoteDefaultBranch = Effect.fn("SourceControlRepositoryService.remoteDefaultBranch")(
    function* (cwd: string) {
      const result = yield* gitStep("remoteDefaultBranch", cwd, [
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
      ]);
      const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(result.stdout)?.[1];
      if (result.exitCode !== 0 || branch === undefined) {
        return yield* cloneError(
          result.exitCode === 0
            ? "The remote has no default branch."
            : redactUrlCredentials(result.stderr.trim()) || "The remote could not be reached.",
        );
      }
      return branch;
    },
  );

  /** Fetches the base branch once into `origin/<branch>` and pins its commit. */
  const resolveBase = Effect.fn("SourceControlRepositoryService.resolveBase")(function* (
    cwd: string,
    base: SandboxBase,
    options?: SourceControlCloneOptions,
  ) {
    const branch = base._tag === "branch" ? base.name : yield* remoteDefaultBranch(cwd);
    const fetched = yield* gitStep(
      "fetchBase",
      cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs },
    );
    if (fetched.exitCode !== 0) {
      return yield* cloneError(
        /couldn't find remote ref/i.test(fetched.stderr)
          ? `The remote has no branch "${branch}".`
          : redactUrlCredentials(fetched.stderr.trim()) ||
              `Branch "${branch}" could not be fetched.`,
      );
    }
    const resolved = yield* gitStep("resolveBase", cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}^{commit}`,
    ]);
    if (resolved.exitCode !== 0) {
      return yield* cloneError(`Branch "${branch}" has no commit.`);
    }
    return { branch, commit: resolved.stdout.trim() } satisfies ProjectCloneBase;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input, options);
    let remoteUrl = prepared.remoteUrl;
    if (prepared.adopt) {
      const set = yield* gitStep("adoptClone", prepared.destinationPath, [
        "remote",
        "set-url",
        "origin",
        prepared.cloneUrl,
      ]);
      if (set.exitCode !== 0) {
        return yield* cloneError("The existing clone's remote could not be updated.");
      }
    } else {
      const stagingPath = cloneStagingPath(path, prepared.destinationPath);
      const httpsUrl = httpsFallbackUrl(input, prepared);
      const cloneInto = (cloneUrl: string) =>
        removeStaging(stagingPath).pipe(
          Effect.andThen(runClone(input, stagingPath, cloneUrl, options)),
        );
      remoteUrl = yield* cloneInto(prepared.cloneUrl).pipe(
        Effect.as(prepared.remoteUrl),
        Effect.catch((sshError) =>
          httpsUrl === null || !isSshRejection(sshError)
            ? Effect.fail(sshError)
            : cloneInto(httpsUrl).pipe(
                Effect.as(redactRemoteUrl(httpsUrl)),
                Effect.mapError(
                  (httpsError) =>
                    new SourceControlRepositoryError({
                      operation: "cloneRepository",
                      provider: sshError.provider,
                      detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                      cause: httpsError.cause,
                    }),
                ),
              ),
        ),
      );
      yield* publishClone(stagingPath, prepared.destinationPath);
    }
    const base =
      options?.checkout === undefined
        ? undefined
        : yield* resolveBase(prepared.destinationPath, options.checkout.base, options);

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
      ...(base === undefined ? {} : { base }),
    } satisfies SourceControlCloneResult;
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    yield* removeStaging(cloneStagingPath(path, normalized));
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName }).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "publishRepository",
              provider: providerKind,
              detail: publishPushFailureDetail({
                urls,
                remoteName,
                remoteUrl,
                reason: cause.reason,
              }),
              cause,
            }),
        ),
      );

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input, options) =>
      prepareClone(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
