/**
 * Variant B dirty-checkout overlay packer and unpacker for fast local-to-sandbox hydration.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { unsetInheritedGitRepositoryEnv } from "@t3tools/shared/testing/gitRepositoryEnv";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export interface OverlayExtraFile {
  readonly path: string;
  readonly executable: boolean;
  readonly symlinkTarget?: string;
  readonly dataBase64?: string;
}

export interface PackedWorktreeOverlay {
  readonly version: 1;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly bundleBase64: string | null;
  readonly trackedPatchBase64: string | null;
  readonly extraFiles: ReadonlyArray<OverlayExtraFile>;
}

const OverlayPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  headSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  bundleBase64: Schema.NullOr(Schema.String),
  trackedPatchBase64: Schema.NullOr(Schema.String),
  extraFiles: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      executable: Schema.Boolean,
      symlinkTarget: Schema.optionalKey(Schema.String),
      dataBase64: Schema.optionalKey(Schema.String),
    }),
  ),
});

export class WorktreeOverlayError extends Schema.TaggedError<WorktreeOverlayError>()(
  "WorktreeOverlayError",
  {
    operation: Schema.Literals(["pack", "apply"]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Worktree overlay ${this.operation} failed: ${this.reason}`;
  }
}

const OVERLAY_GIT_TIMEOUT_MS = 60_000;
const OVERLAY_GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function envWithCleanGit(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...unsetInheritedGitRepositoryEnv(process.env, platform),
  };
}

function makeTempOverlayDir(prefix: string): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
}

const OverlayPayloadJsonSchema = Schema.fromJsonString(OverlayPayloadSchema);
const encodeOverlayPayloadJson = Schema.encodeEffect(OverlayPayloadJsonSchema);
const decodeOverlayPayloadJson = Schema.decodeEffect(OverlayPayloadJsonSchema);
const isWorktreeOverlayError = Schema.is(WorktreeOverlayError);

const sanitizedGitEnv = (platform: NodeJS.Platform): NodeJS.ProcessEnv => envWithCleanGit(platform);

function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new WorktreeOverlayError({
      operation: "apply",
      reason: `Unsafe overlay file path: ${relativePath}`,
    });
  }
  return normalized;
}

function readExtraFilesSync(cwd: string, relativePaths: ReadonlyArray<string>): OverlayExtraFile[] {
  const files: OverlayExtraFile[] = [];
  for (const rel of relativePaths) {
    const safeRel = assertSafeRelativePath(rel);
    const fullPath = NodePath.join(cwd, ...safeRel.split("/"));
    const stat = NodeFS.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      files.push({
        path: safeRel,
        executable: false,
        symlinkTarget: NodeFS.readlinkSync(fullPath),
      });
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = NodeFS.readFileSync(fullPath);
    files.push({
      path: safeRel,
      executable: (stat.mode & 0o111) !== 0,
      dataBase64: bytes.toString("base64"),
    });
  }
  return files;
}

const runGit = (
  runner: ProcessRunner.ProcessRunner["Service"],
  platform: NodeJS.Platform,
  cwd: string,
  args: ReadonlyArray<string>,
  operation: "pack" | "apply",
  options?: { readonly allowNonZeroExit?: boolean },
) =>
  runner
    .run({
      command: "git",
      args,
      cwd,
      env: sanitizedGitEnv(platform),
      timeout: Duration.millis(OVERLAY_GIT_TIMEOUT_MS),
      maxOutputBytes: OVERLAY_GIT_MAX_OUTPUT_BYTES,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeOverlayError({
            operation,
            reason: `git ${args[0] ?? "command"} failed: ${cause.message}`,
            cause,
          }),
      ),
      Effect.flatMap((result) => {
        const normalized = { ...result, exitCode: result.code };
        if (options?.allowNonZeroExit || (!result.timedOut && result.code === 0)) {
          return Effect.succeed(normalized);
        }
        return Effect.fail(
          new WorktreeOverlayError({
            operation,
            reason: `git ${args[0] ?? "command"} exited with ${result.code ?? "signal"}: ${result.stderr.trim()}`,
          }),
        );
      }),
    );

const gitSafeDirectoryArgs = (cwd: string) => ["-c", `safe.directory=${cwd}`] as const;

export const packWorktreeOverlay = Effect.fn("worktreeOverlay.pack")(function* (input: {
  readonly cwd: string;
  readonly includeUncommitted: boolean;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const { cwd, includeUncommitted } = input;
  const safe = gitSafeDirectoryArgs(cwd);

  const headResult = yield* runGit(
    runner,
    platform,
    cwd,
    [...safe, "rev-parse", "--verify", "HEAD"],
    "pack",
    { allowNonZeroExit: true },
  );
  const hasHead = headResult.exitCode === 0;
  const headSha = hasHead ? headResult.stdout.trim() : null;

  const branchResult = yield* runGit(
    runner,
    platform,
    cwd,
    [...safe, "symbolic-ref", "--short", "-q", "HEAD"],
    "pack",
    { allowNonZeroExit: true },
  );
  const branch =
    branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
      ? branchResult.stdout.trim()
      : null;

  const tempDir = yield* Effect.try({
    try: () => makeTempOverlayDir("t3-ovl-"),
    catch: (cause) =>
      new WorktreeOverlayError({
        operation: "pack",
        reason: "Could not allocate temporary directory.",
        cause,
      }),
  });

  return yield* Effect.gen(function* () {
    let bundleBase64: string | null = null;
    if (hasHead) {
      const bundlePath = NodePath.join(tempDir, "head.bundle");
      yield* runGit(
        runner,
        platform,
        cwd,
        [...safe, "bundle", "create", bundlePath, "HEAD"],
        "pack",
      );
      bundleBase64 = NodeFS.readFileSync(bundlePath).toString("base64");
    }

    let trackedPatchBase64: string | null = null;
    let extraFiles: OverlayExtraFile[] = [];

    if (includeUncommitted) {
      if (hasHead) {
        const diffPath = NodePath.join(tempDir, "tracked.patch");
        yield* runGit(
          runner,
          platform,
          cwd,
          [...safe, "diff", "--binary", `--output=${diffPath}`, "HEAD"],
          "pack",
        );
        const diffBytes = NodeFS.readFileSync(diffPath);
        if (diffBytes.byteLength > 0) {
          trackedPatchBase64 = diffBytes.toString("base64");
        }
      }

      const listArgs = hasHead
        ? [...safe, "ls-files", "--others", "--exclude-standard", "-z"]
        : [...safe, "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
      const listResult = yield* runGit(runner, platform, cwd, listArgs, "pack");
      const rawPaths = listResult.stdout.split("\0").filter((entry) => entry.length > 0);
      if (rawPaths.length > 0) {
        extraFiles = yield* Effect.try({
          try: () => readExtraFilesSync(cwd, rawPaths),
          catch: (cause) =>
            new WorktreeOverlayError({
              operation: "pack",
              reason: "Could not read untracked overlay files.",
              cause,
            }),
        });
      }
    }

    const payload: PackedWorktreeOverlay = {
      version: 1,
      headSha,
      branch,
      bundleBase64,
      trackedPatchBase64,
      extraFiles,
    };

    const jsonText = yield* encodeOverlayPayloadJson(payload).pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeOverlayError({
            operation: "pack",
            reason: "Could not encode overlay payload.",
            cause,
          }),
      ),
    );
    return NodeZlib.gzipSync(Buffer.from(jsonText, "utf8"));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
});

export const decodeWorktreeOverlay = (bytes: Uint8Array) =>
  Effect.try({
    try: () => NodeZlib.gunzipSync(bytes).toString("utf8"),
    catch: (cause) =>
      new WorktreeOverlayError({
        operation: "apply",
        reason: "Could not decompress overlay archive.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((jsonText) =>
      decodeOverlayPayloadJson(jsonText).pipe(
        Effect.mapError(
          (cause) =>
            new WorktreeOverlayError({
              operation: "apply",
              reason: "Invalid overlay payload format.",
              cause,
            }),
        ),
      ),
    ),
  );

export const applyWorktreeOverlay = Effect.fn("worktreeOverlay.apply")(function* (input: {
  readonly targetDir: string;
  readonly archiveBytes: Uint8Array;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const payload = yield* decodeWorktreeOverlay(input.archiveBytes);
  const { targetDir } = input;
  const safe = gitSafeDirectoryArgs(targetDir);

  yield* Effect.try({
    try: () => {
      NodeFS.mkdirSync(targetDir, { recursive: true });
    },
    catch: (cause) =>
      new WorktreeOverlayError({
        operation: "apply",
        reason: "Could not create target directory.",
        cause,
      }),
  });

  const tempDir = yield* Effect.try({
    try: () => makeTempOverlayDir("t3-ovl-apply-"),
    catch: (cause) =>
      new WorktreeOverlayError({
        operation: "apply",
        reason: "Could not allocate temporary unpack directory.",
        cause,
      }),
  });

  return yield* Effect.gen(function* () {
    const isGitRepo = NodeFS.existsSync(NodePath.join(targetDir, ".git"));
    if (!isGitRepo) {
      yield* runGit(runner, platform, targetDir, ["init"], "apply");
    }

    const branchName = payload.branch ?? "sandbox-base";
    let resolvedCommit = payload.headSha ?? "";

    if (payload.bundleBase64 !== null) {
      const bundlePath = NodePath.join(tempDir, "head.bundle");
      NodeFS.writeFileSync(bundlePath, Buffer.from(payload.bundleBase64, "base64"));
      yield* runGit(
        runner,
        platform,
        targetDir,
        [...safe, "fetch", "--force", bundlePath, "HEAD:refs/t3/overlay-head"],
        "apply",
      );
      yield* runGit(
        runner,
        platform,
        targetDir,
        [...safe, "checkout", "-f", "-B", branchName, "refs/t3/overlay-head"],
        "apply",
      );
      if (resolvedCommit.length === 0) {
        const rev = yield* runGit(
          runner,
          platform,
          targetDir,
          [...safe, "rev-parse", "HEAD"],
          "apply",
        );
        resolvedCommit = rev.stdout.trim();
      }
    }

    if (payload.trackedPatchBase64 !== null) {
      const patchPath = NodePath.join(tempDir, "tracked.patch");
      NodeFS.writeFileSync(patchPath, Buffer.from(payload.trackedPatchBase64, "base64"));
      yield* runGit(
        runner,
        platform,
        targetDir,
        [...safe, "apply", "--binary", "--whitespace=nowarn", patchPath],
        "apply",
      );
    }

    yield* Effect.try({
      try: () => {
        for (const entry of payload.extraFiles) {
          const safeRel = assertSafeRelativePath(entry.path);
          const dest = NodePath.join(targetDir, ...safeRel.split("/"));
          NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
          if (entry.symlinkTarget !== undefined) {
            if (NodeFS.existsSync(dest)) {
              NodeFS.rmSync(dest, { force: true });
            }
            NodeFS.symlinkSync(entry.symlinkTarget, dest);
            continue;
          }
          const data = Buffer.from(entry.dataBase64 ?? "", "base64");
          NodeFS.writeFileSync(dest, data, { mode: entry.executable ? 0o755 : 0o644 });
        }
      },
      catch: (cause) =>
        isWorktreeOverlayError(cause)
          ? cause
          : new WorktreeOverlayError({
              operation: "apply",
              reason: "Could not extract extra overlay files.",
              cause,
            }),
    });

    return { branch: branchName, commit: resolvedCommit };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
});
