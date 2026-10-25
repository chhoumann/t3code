import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SandboxBranchName, type ProjectCloneCheckout } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-clone-checkout-" });
const layerGit = GitVcsDriver.layer.pipe(Layer.provide(layerConfig));
const layer = SourceControlRepositoryService.layer.pipe(
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
    }),
  ),
  Layer.provide(layerGit),
  Layer.provide(layerConfig),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(NodeServices.layer),
);

const checkout = (
  base: ProjectCloneCheckout["base"] = { _tag: "default" },
): ProjectCloneCheckout => ({
  base,
  reuseMatching: true,
  importProjectScripts: false,
});

/** A bare remote with one commit on `main`, and the work clone that pushes to it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-checkout-" });
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "test.git",
        cwd,
        args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  yield* run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  yield* run(root, "clone", "--quiet", remote, work);
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(work, `${message}.txt`), `${message}\n`);
      yield* run(work, "add", "--all");
      yield* run(work, "commit", "--quiet", "-m", message);
      yield* run(work, "push", "--quiet", "origin", "HEAD");
      return yield* run(work, "rev-parse", "HEAD");
    });
  const first = yield* commit("first");
  const destination = path.join(root, "project");
  // The project's workspace root exists, empty, before its clone starts.
  yield* fs.makeDirectory(destination);
  const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const clone = (input?: {
    readonly checkout?: ProjectCloneCheckout;
    readonly remoteUrl?: string;
    readonly onProgress?: () => Effect.Effect<void>;
  }) =>
    service.cloneRepository(
      { remoteUrl: input?.remoteUrl ?? remote, destinationPath: destination },
      {
        ...(input?.checkout === undefined ? {} : { checkout: input.checkout }),
        ...(input?.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      },
    );
  return { fs, path, git: run, root, remote, work, first, destination, service, clone, commit };
});

/**
 * The real file system, except that a file lands in a project folder right
 * after its entries are listed while a staged clone waits beside it: the user
 * saving into the folder at the moment the clone is published.
 */
const fileAppearsAfterListing = (dropped: { count: number }) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stagingOf = (directory: string) =>
        path.join(path.dirname(directory), `.${path.basename(directory)}.t3-clone`);
      return FileSystem.FileSystem.of({
        ...fs,
        readDirectory: (directory, options) =>
          fs
            .readDirectory(directory, options)
            .pipe(
              Effect.tap(() =>
                path.basename(directory) !== "project"
                  ? Effect.void
                  : fs
                      .exists(stagingOf(directory))
                      .pipe(
                        Effect.flatMap((publishing) =>
                          publishing
                            ? fs
                                .writeFileString(path.join(directory, "notes.txt"), "mine")
                                .pipe(
                                  Effect.tap(() => Effect.sync(() => void (dropped.count += 1))),
                                )
                            : Effect.void,
                        ),
                      ),
              ),
            ),
      });
    }),
  );

/** The service over `fileSystem`; the test itself keeps the real one. */
const layerOver = (
  fileSystem: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem | Path.Path>,
) =>
  SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
      }),
    ),
    Layer.provide(layerGit),
    Layer.provide(layerConfig),
    Layer.provide(fileSystem),
    Layer.provideMerge(layerGit),
    Layer.provideMerge(NodeServices.layer),
  );

describe("cloneRepository with a checkout", () => {
  it.effect("publishes a complete clone at the destination and pins the default branch", () =>
    Effect.gen(function* () {
      const { fs, path, git, root, first, destination, clone } = yield* fixture;
      const result = yield* clone({ checkout: checkout() });
      assert.deepStrictEqual(result.base, { branch: "main", commit: first });
      assert.strictEqual(yield* git(destination, "rev-parse", "HEAD"), first);
      assert.isTrue(yield* fs.exists(path.join(destination, "first.txt")));
      assert.isFalse(yield* fs.exists(path.join(root, ".project.t3-clone")));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "leaves the destination empty when the clone fails, so nothing partial is published",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, destination, clone, service } = yield* fixture;
        const error = yield* Effect.flip(
          clone({ remoteUrl: path.join(root, "nowhere.git"), checkout: checkout() }),
        );
        assert.include(error.detail, "nowhere.git");
        assert.deepStrictEqual(yield* fs.readDirectory(destination), []);
        yield* service.discardClone(destination);
        assert.isFalse(yield* fs.exists(path.join(root, ".project.t3-clone")));
        assert.isTrue(yield* fs.exists(destination));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses to publish over a file that appeared while git transferred, and keeps it",
    () =>
      Effect.gen(function* () {
        const { fs, path, remote, destination, clone } = yield* fixture;
        const error = yield* Effect.flip(
          clone({
            // A file:// remote goes through the transfer protocol, which reports progress.
            remoteUrl: `file://${remote}`,
            onProgress: () =>
              fs.writeFileString(path.join(destination, "notes.txt"), "mine").pipe(Effect.orDie),
          }),
        );
        assert.include(error.detail, "not empty");
        assert.deepStrictEqual(yield* fs.readDirectory(destination), ["notes.txt"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("never deletes a file that lands in the destination as the clone is published", () => {
    const dropped = { count: 0 };
    return Effect.gen(function* () {
      const { fs, path, destination, clone } = yield* fixture;
      yield* clone().pipe(Effect.result);
      if (dropped.count > 0) {
        assert.isTrue(yield* fs.exists(path.join(destination, "notes.txt")));
      }
    }).pipe(Effect.provide(layerOver(fileAppearsAfterListing(dropped))));
  });

  it.effect("never adopts a partial clone a crash left behind", () =>
    Effect.gen(function* () {
      const { fs, path, root, first, destination, clone } = yield* fixture;
      const stale = path.join(root, ".project.t3-clone");
      yield* fs.makeDirectory(path.join(stale, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(stale, "half.txt"), "half");
      const result = yield* clone({ checkout: checkout() });
      assert.strictEqual(result.base?.commit, first);
      assert.isFalse(yield* fs.exists(path.join(destination, "half.txt")));
      assert.isFalse(yield* fs.exists(stale));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses a destination holding files that are not a clone, even when asked to reuse",
    () =>
      Effect.gen(function* () {
        const { fs, path, destination, clone } = yield* fixture;
        yield* fs.writeFileString(path.join(destination, "notes.txt"), "mine");
        const error = yield* Effect.flip(clone({ checkout: checkout() }));
        assert.include(error.detail, "not empty");
        assert.deepStrictEqual(yield* fs.readDirectory(destination), ["notes.txt"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("adopts a template's clone of the repository and fetches instead of recloning", () =>
    Effect.gen(function* () {
      const { fs, path, git, remote, destination, clone, commit } = yield* fixture;
      // The template's clone: made under another spelling of the remote, with an agent's leftovers.
      yield* fs.remove(destination, { recursive: true });
      yield* git(path.dirname(destination), "clone", "--quiet", `${remote}/`, destination);
      yield* fs.makeDirectory(path.join(destination, "node_modules"));
      yield* fs.writeFileString(path.join(destination, "node_modules", "cache"), "");
      const second = yield* commit("second");

      const result = yield* clone({ checkout: checkout() });
      assert.deepStrictEqual(result.base, { branch: "main", commit: second });
      assert.isTrue(yield* fs.exists(path.join(destination, "node_modules", "cache")));
      assert.strictEqual(yield* git(destination, "remote", "get-url", "origin"), remote);
      assert.strictEqual(yield* git(destination, "rev-parse", "refs/remotes/origin/main"), second);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a template's clone of another repository without touching it", () =>
    Effect.gen(function* () {
      const { fs, path, git, root, destination, clone } = yield* fixture;
      const other = path.join(root, "other.git");
      yield* git(root, "init", "--quiet", "--bare", "--initial-branch=main", other);
      yield* fs.remove(destination, { recursive: true });
      yield* git(root, "clone", "--quiet", other, destination);
      const before = yield* git(destination, "remote", "get-url", "origin");

      const error = yield* Effect.flip(clone({ checkout: checkout() }));
      assert.include(error.detail, "another repository");
      assert.strictEqual(yield* git(destination, "remote", "get-url", "origin"), before);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "resolves the default branch from the remote, not from a template's stale origin/HEAD",
    () =>
      Effect.gen(function* () {
        const { fs, git, remote, work, destination, clone, commit } = yield* fixture;
        yield* fs.remove(destination, { recursive: true });
        yield* git(work, "clone", "--quiet", remote, destination);
        // The remote's default branch moves to develop after the template was taken.
        yield* git(work, "checkout", "--quiet", "-b", "develop");
        const tip = yield* commit("develop");
        // T3's git opens a bare repository only when named explicitly.
        yield* git(work, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/develop");
        assert.strictEqual(
          yield* git(destination, "symbolic-ref", "refs/remotes/origin/HEAD"),
          "refs/remotes/origin/main",
        );

        const result = yield* clone({ checkout: checkout() });
        assert.deepStrictEqual(result.base, { branch: "develop", commit: tip });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("fails on a branch the remote lacks, leaving the clone for a retry to adopt", () =>
    Effect.gen(function* () {
      const { fs, path, first, destination, clone } = yield* fixture;
      const error = yield* Effect.flip(
        clone({ checkout: checkout({ _tag: "branch", name: SandboxBranchName.make("nope") }) }),
      );
      assert.include(error.detail, 'no branch "nope"');
      assert.isTrue(yield* fs.exists(path.join(destination, ".git")));

      const retried = yield* clone({ checkout: checkout() });
      assert.strictEqual(retried.base?.commit, first);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pins a named branch at its remote tip", () =>
    Effect.gen(function* () {
      const { git, work, clone, commit } = yield* fixture;
      yield* git(work, "checkout", "--quiet", "-b", "release/2.x");
      const tip = yield* commit("release");
      const result = yield* clone({
        checkout: checkout({ _tag: "branch", name: SandboxBranchName.make("release/2.x") }),
      });
      assert.deepStrictEqual(result.base, { branch: "release/2.x", commit: tip });
    }).pipe(Effect.provide(layer)),
  );
});
