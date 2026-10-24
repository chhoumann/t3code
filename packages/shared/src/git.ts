import type {
  BranchNamingOptions,
  GitRemote,
  RepositoryIdentity,
  SourceControlProviderInfo,
  VcsRef,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

export const WORKTREE_BRANCH_PREFIX = "t3";
const TEMP_WORKTREE_HEX_TOKEN = "[0-9a-f]{8}";
const TEMP_WORKTREE_UUID_V4_TOKEN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^(?:${WORKTREE_BRANCH_PREFIX}[-/]${TEMP_WORKTREE_HEX_TOKEN}|t3code(?:[-/]${TEMP_WORKTREE_HEX_TOKEN}|\\/${TEMP_WORKTREE_UUID_V4_TOKEN}))$`,
);

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export function formatGeneratedBranchName(raw: string, naming?: BranchNamingOptions): string {
  if (naming?.mode === "custom") return raw.trim();
  const branch = sanitizeBranchFragment(raw);
  if (naming?.mode !== "static") return branch;
  const prefix = naming.prefix
    .split("/")
    .map((part) =>
      part
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
  return prefix ? `${prefix}/${branch}` : branch;
}

export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  return sanitized.includes("/") ? sanitized : `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = existingBranchNames.map((refName) => refName.toLowerCase());
  const existingRefs = new Set(existingNames);
  const parts = resolvedBase.split("/");
  let resolved = "";

  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    let suffix = 2;
    while (
      existingRefs.has(candidate) ||
      (index === parts.length - 1 &&
        existingNames.some((refName) => refName.startsWith(`${candidate}/`)))
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }

  return resolved;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
): string {
  const token = randomHex(4)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 8);
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

/**
 * Git stores refs as paths, so a plain `t3` branch makes every `t3/<hex>`
 * ref impossible. This moves a temporary name to the flat `t3-<hex>` sibling.
 */
export function flattenTemporaryWorktreeBranchName(refName: string): string {
  const normalized = refName.trim().toLowerCase();
  const tokenStart = normalized.search(/[-/]/) + 1;
  const token = normalized.slice(tokenStart, tokenStart + 8);
  return `${WORKTREE_BRANCH_PREFIX}-${token}`;
}

export function isTemporaryWorktreeBranch(refName: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(refName.trim().toLowerCase());
}

function lowerCaseRemote(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * The host and repository path a remote names, lower case and without a port, or null for a
 * remote that names no host, such as a local path.
 */
export function parseGitRemoteRepository(
  value: string,
): { readonly host: string; readonly path: string } | null {
  const normalized = lowerCaseRemote(value);

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositorySegments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (url.hostname && repositorySegments.length > 1) {
        return { host: url.hostname, path: repositorySegments.join("/") };
      }
    } catch {
      return null;
    }
  }

  // A userless one-letter prefix is a Windows drive, not an SCP host.
  const scpStyleHostAndPath = /^[a-z]:/i.test(normalized)
    ? null
    : /^(?:[a-zA-Z0-9._-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  const scpHost = scpStyleHostAndPath?.[1];
  const scpPath = scpStyleHostAndPath?.[2];
  return scpHost && scpPath ? { host: scpHost, path: scpPath } : null;
}

/**
 * `host/path` for a remote that names a host, otherwise the remote itself, lower case. A host that
 * spells repositories differently over SSH has its source control registry's
 * `repositoryKeyFromRemote` rewrite this, so persisted keys come from that, not from here.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const repository = parseGitRemoteRepository(value);
  return repository === null ? lowerCaseRemote(value) : `${repository.host}/${repository.path}`;
}

function parseGitConfigValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      out += raw[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    out += char;
  }
  return out.trim();
}

export function isBareGitConfig(configText: string): boolean {
  let inCore = false;
  let bare = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    let line = rawLine.trim();
    // Git accepts the first setting on the section header's own line.
    const header = /^\[\s*([^\]]*?)\s*\](.*)$/.exec(line);
    if (header !== null) {
      inCore = header[1]!.toLowerCase() === "core";
      line = header[2]!.trim();
    }
    if (!inCore) continue;
    const match = /^bare\s*(?:=(.*)|[#;].*)?$/i.exec(line);
    if (match === null) continue;
    const value = match[1] === undefined ? "true" : parseGitConfigValue(match[1]).toLowerCase();
    bare = value === "true" || value === "yes" || value === "on" || value === "1";
  }
  return bare;
}

export function parseOriginUrlFromGitConfig(configText: string): string | null {
  let section: string | null = null;
  let originUrl: string | null = null;
  let firstRemoteUrl: string | null = null;
  // A trailing backslash continues the value on the next line.
  const joined = configText.replace(/\\\r?\n[ \t]*/g, "");
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    // Both `[remote "origin"]` and the legacy `[remote.origin]` form, with an
    // optional trailing comment. Git keeps quoted subsections case-sensitive
    // but folds the dotted form to lowercase.
    const header = /^\[\s*remote(?:\s+"([^"]+)"|\.([^\]\s]+))\s*\](?:\s*[#;].*)?$/i.exec(line);
    if (header) {
      section = header[1] ?? header[2]?.toLowerCase() ?? null;
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    if (section === null) continue;
    const match = /^url\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const url = parseGitConfigValue(match[1] ?? "");
    if (url.length === 0) continue;
    if (section === "origin") {
      originUrl ??= url;
    } else {
      firstRemoteUrl ??= url;
    }
  }
  return originUrl ?? firstRemoteUrl;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

// Only the whitespace git actually rejects is replaced — git accepts U+00A0 and
// friends, and rewriting those would silently create a ref the user never asked
// for.
export function sanitizeNewRefName(rawName: string): string {
  return rawName.trim().replace(/[ \t\n\r\f\v]+/g, "-");
}

export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    Arr.filterMap(refs, (refName) =>
      refName.isRemote ? Result.failVoid : Result.succeed(refName.name),
    ),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

/**
 * How a source control registry reads remotes. Its `repositoryKeyFromRemote` is the persisted
 * spelling of a repository, so helpers here that key repositories take one.
 */
export interface RemoteRecognizer {
  readonly recognizeRemote: (remoteUrl: string) => SourceControlProviderInfo | null;
  readonly repositoryKeyFromRemote: (remoteUrl: string) => string;
}

/** Each remote and its fetch URL, from `git remote -v`. */
export function parseRemoteFetchUrls(stdout: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of stdout.split("\n")) {
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const [, name, url] = /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]+\])?$/.exec(line.trim()) ?? [];
    if (name && url) remotes.push({ name, url });
  }
  return remotes;
}

/**
 * Local remotes (GitButler's `gb-local` is `.`) name a path on this machine,
 * not a repository, so unrelated repos would share one identity.
 */
export function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true;
  // Git treats `host:path` as scp-style only when the colon precedes any slash.
  const colonIndex = url.indexOf(":");
  const slashIndex = url.search(/[\\/]/);
  return colonIndex === -1 || (slashIndex !== -1 && slashIndex < colonIndex);
}

/** The `owner/name` path in a remote URL, as the URL spells it. */
export function repositoryPathFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:[^@/\s]+@[^:/\s]+:|(?:ssh|https?|git):\/\/[^/]+\/)((?:[^/\s]+\/)+[^/\s]+?)(?:\.git)?\/?$/iu.exec(
      trimmed,
    );
  const path = match?.[1]?.trim() ?? "";
  return path.length > 0 ? path : null;
}

/** The remote a checkout's repository identity names: `upstream`, then `origin`, then the first by name. */
export function pickPrimaryRemote<R extends GitRemote>(remotes: Arr.NonEmptyReadonlyArray<R>): R {
  return (
    remotes.find((remote) => remote.name === "upstream") ??
    remotes.find((remote) => remote.name === "origin") ??
    remotes.reduce((first, remote) => (remote.name.localeCompare(first.name) < 0 ? remote : first))
  );
}

function repositoryPathOf(canonicalKey: string, remoteUrl: string): string {
  const canonicalPath = canonicalKey.split("/").slice(1).join("/");
  const displayPath = repositoryPathFromRemoteUrl(remoteUrl);
  return displayPath?.toLowerCase() === canonicalPath ? displayPath : canonicalPath;
}

/**
 * A checkout's repository identity, read from its remotes: the one
 * `pickPrimaryRemote` names, and `origin` when that is another repository.
 */
export function repositoryIdentityFromRemotes(
  remotes: Arr.NonEmptyReadonlyArray<GitRemote>,
  recognizer: RemoteRecognizer,
): RepositoryIdentity {
  const primary = pickPrimaryRemote(remotes);
  const canonicalKey = recognizer.repositoryKeyFromRemote(primary.url);
  const sourceControlProvider = recognizer.recognizeRemote(primary.url);
  const repositoryPath = repositoryPathOf(canonicalKey, primary.url);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const originUrl = remotes.find((remote) => remote.name === "origin")?.url;
  const originKey =
    originUrl === undefined ? canonicalKey : recognizer.repositoryKeyFromRemote(originUrl);
  const originPath = originUrl === undefined ? "" : repositoryPathOf(originKey, originUrl);

  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName: primary.name, remoteUrl: primary.url },
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    ...(originUrl === undefined || originKey === canonicalKey
      ? {}
      : {
          origin: {
            canonicalKey: originKey,
            remoteUrl: originUrl,
            ...(originPath ? { displayName: originPath } : {}),
          },
        }),
  };
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    ...(status.remotes === undefined ? {} : { remotes: status.remotes }),
    ...(status.trackedRemote === undefined ? {} : { trackedRemote: status.trackedRemote }),
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    ...(status.headCommit === undefined ? {} : { headCommit: status.headCommit }),
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    ...(status.hasTrackedChanges === undefined
      ? {}
      : { hasTrackedChanges: status.hasTrackedChanges }),
    workingTree: status.workingTree,
    ...(status.branchChanges ? { branchChanges: status.branchChanges } : {}),
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
