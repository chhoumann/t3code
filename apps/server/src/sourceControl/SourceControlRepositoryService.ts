// @effect-diagnostics-next-line nodeBuiltinImport:off -- rmdir(2) has no Effect counterpart. `remove` takes a directory only recursively.
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
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
  gitLfsDownloadProgressLine,
  isGitFilterProgressLine,
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
     * Clones into a staging directory and renames it into place when complete,
     * or adopts an existing clone of the same repository and optionally pins a base.
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
  /** The origin of the clone of this repository already at the destination, which `adopt` takes; null to clone. */
  readonly adoptedOrigin: string | null;
}

export interface SourceControlCloneCheckoutOptions {
  readonly checkout?: ProjectCloneCheckout;
  /**
   * Takes a clone of the same repository at the destination rather than refuse
   * a non-empty one. A retry keeps the origin of the clone it published, which
   * is the URL git could reach; a template's clone is retargeted to the request.
   */
  readonly adopt?: "keep-origin" | "retarget-origin";
}

export type SourceControlCloneAdoption = NonNullable<SourceControlCloneCheckoutOptions["adopt"]>;

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

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  // English progress without overriding LC_CTYPE, which a global post-checkout hook inherits.
  LANGUAGE: "C",
} satisfies NodeJS.ProcessEnv;
// Well inside the tracker's stall window, at about the pace git itself reports.
const LFS_DOWNLOAD_POLL_INTERVAL = Duration.seconds(2);

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

// Redact credentials from client clone snapshots; git still receives the credentials.
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

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

function redactUrlCredentials(text: string): string {
  return text
    .replace(QUOTED_URL_QUERY, "$1$2$1")
    .replace(URL_QUERY, "$1")
    .replace(URL_WITH_USERINFO, "$1");
}

// The remote already exists after push failure; advise fixing access and pushing.
// Use fixed text and provider URLs because git stderr can expose credentials.
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
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
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

/** @public */
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
      adopt: boolean,
    ) {
      if (destination.entries.length === 0) return null;
      if (!adopt || !destination.entries.includes(".git")) {
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
      return redactRemoteUrl(origin.stdout.trim());
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
      adoptedOrigin: yield* adoptsDestination(
        destination,
        redactedUrl,
        options?.adopt !== undefined,
      ),
    } satisfies SourceControlPreparedClone;
  });

  // Git and git-lfs print nothing while one object downloads, so a healthy transfer reads as a
  // stall. Its partial files growing are the only sign of life a plain clone gives.
  const watchLfsDownload = (
    destinationPath: string,
    onChange: (partialBytes: number) => Effect.Effect<void>,
  ) => {
    const incomplete = path.join(destinationPath, ".git", "lfs", "incomplete");
    const partialBytes = fileSystem.readDirectory(incomplete).pipe(
      Effect.flatMap(
        Effect.forEach((name) =>
          fileSystem
            .stat(path.join(incomplete, name))
            .pipe(Effect.map((info) => Number(info.size))),
        ),
      ),
      Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)),
      // No directory means no LFS download; a part that landed mid-read counts on the next poll.
      Effect.orElseSucceed(() => 0),
    );
    return Effect.gen(function* () {
      let previous = 0;
      while (true) {
        yield* Effect.sleep(LFS_DOWNLOAD_POLL_INTERVAL);
        const current = yield* partialBytes;
        if (current > 0 && current !== previous) yield* onChange(current);
        previous = current;
      }
    });
  };

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git mixes progress and diagnostics on stderr; retain non-progress tail lines for failure details.
    const stderrTail: Array<string> = [];
    let filterPercent: number | null = null;
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed && isGitFilterProgressLine(line)) filterPercent = parsed.percent;
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    // Git misreads @ in a pathless URL's query as userinfo and echoes its suffix as the host.
    const normalizedCloneUrl = cloneUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
    const provider = input.provider ?? SourceControlProviderKind.make("unknown");
    const timeoutMs = options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs;
    const clone = git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", normalizedCloneUrl, path.basename(destinationPath)],
        // The deadline is applied below so a timeout is reported as one, not as git's last line.
        timeoutMs: null,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
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
              provider,
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
    const watchedClone = onProgress
      ? clone.pipe(
          Effect.raceFirst(
            watchLfsDownload(destinationPath, (partialBytes) =>
              onProgress(gitLfsDownloadProgressLine(partialBytes, filterPercent)),
            ),
          ),
        )
      : clone;
    if (timeoutMs === null) return yield* watchedClone;
    // Interrupting the clone closes the scope that owns git, which kills it.
    return yield* watchedClone.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider,
              detail: `The clone timed out after ${Duration.format(Duration.millis(timeoutMs))}.`,
            }),
          ),
      }),
    );
  });

  const removeStaging = (stagingPath: string) =>
    fileSystem.remove(stagingPath, { recursive: true, force: true }).pipe(
      // An interrupted git may still be closing files, so removal retries briefly.
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError((cause) => cloneError("The partial clone could not be removed.", cause)),
    );

  /**
   * Moves the staged clone to the destination, removing an empty placeholder dir first
   * because rename(2) does not replace one on Windows; rmdir refuses non-empty dirs.
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
    if (prepared.adoptedOrigin !== null && options?.adopt === "keep-origin") {
      remoteUrl = prepared.adoptedOrigin;
    } else if (prepared.adoptedOrigin !== null) {
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
        // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - The condition also narrows httpsUrl for the fallback closure.
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

    // A ref list read while the clone ran saw an unborn HEAD and no refs.
    yield* git.invalidateRefs(prepared.destinationPath);
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

      // Empty repos cannot push HEAD; report partial success because the remote already exists.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.as(true),
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

      const push = (pushUrl: string) =>
        git.pushCurrentBranch(input.cwd, null, { remoteName }).pipe(
          Effect.map((result) => ({ branch: result.branch, remoteUrl: pushUrl })),
          Effect.mapError(
            (cause) =>
              new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: publishPushFailureDetail({
                  urls,
                  remoteName,
                  remoteUrl: pushUrl,
                  reason: cause.reason,
                }),
                cause,
              }),
          ),
        );

      // Like clone, an auto-selected SSH remote switches to HTTPS when SSH is refused;
      // otherwise the remote keeps failing every later fetch and push.
      const canSwitchToHttps = input.protocol !== "ssh" && remoteUrl === urls.sshUrl;
      const pushed = yield* push(remoteUrl).pipe(
        Effect.catchIf(
          (error) => canSwitchToHttps && isSshRejection(error),
          (sshError) =>
            git
              .execute({
                operation: "SourceControlRepositoryService.publishRepository.switchToHttps",
                cwd: input.cwd,
                args: ["remote", "set-url", remoteName, urls.url],
              })
              .pipe(
                Effect.mapError(() => sshError),
                Effect.andThen(push(urls.url)),
              ),
        ),
      );

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl: pushed.remoteUrl,
        branch: pushed.branch,
        status: "pushed" as const,
      };
    },
  );

  // Forwarders retain the underlying operation spans.
  return SourceControlRepositoryService.of({
    lookupRepository: Effect.fnUntraced(function* (input) {
      return yield* lookupRepository(input).pipe(
        mapRepositoryError("lookupRepository", input.provider),
      );
    }),
    prepareClone: Effect.fnUntraced(function* (input, options) {
      return yield* prepareClone(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    cloneRepository: Effect.fnUntraced(function* (input, options) {
      return yield* cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    discardClone: Effect.fnUntraced(function* (destinationPath) {
      return yield* discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      );
    }),
    publishRepository: Effect.fnUntraced(function* (input) {
      return yield* publishRepository(input).pipe(
        mapRepositoryError("publishRepository", input.provider),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
