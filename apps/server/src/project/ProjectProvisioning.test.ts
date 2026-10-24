import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectProvisioning from "./ProjectProvisioning.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const projectId = ProjectId.make("project-1");
const base = { branch: "main", commit: "abc123" };
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "https://github.com/octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};
const T3_JSON = `{ "scripts": [{ "name": "Dev", "command": "pnpm dev", "runOnWorktreeCreate": true }] }`;

function makeHarness() {
  const commands: Array<{ commandId: string; scripts?: ReadonlyArray<ProjectScript> }> = [];
  const shown: Array<string> = [];
  const layer = ProjectProvisioning.layer.pipe(
    Layer.provideMerge(
      ProjectCloneTracker.layer.pipe(
        Layer.provide(
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
            prepareClone: (input) =>
              Effect.succeed({
                destinationPath: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                cloneUrl: input.remoteUrl ?? "",
                repository: null,
                adopt: false,
              }),
            cloneRepository: (input, options) =>
              Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
                ...(options?.checkout === undefined ? {} : { base }),
              }),
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            commands.push({ commandId: input.commandId });
            return {} as never;
          }),
        update: (input) =>
          Effect.sync(() => {
            commands.push({
              commandId: input.commandId,
              ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
            });
            return {} as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        invalidate: () => Effect.void,
        request: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: () => Effect.succeed({} as never),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: (input) =>
          Effect.sync(() => {
            shown.push(input.args.join(" "));
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: T3_JSON,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
  return { layer, commands, shown };
}

const importing = {
  base: { _tag: "default" as const },
  reuseMatching: true,
  importProjectScripts: true,
};

describe("ProjectProvisioning", () => {
  it.effect(
    "creates the project before the clone and imports t3.json at the pinned base, once per project",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const provisioning = yield* ProjectProvisioning.ProjectProvisioning;
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        yield* provisioning.clone({ ...startInput, checkout: importing });
        yield* Effect.yieldNow;
        expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done", base });
        expect(harness.shown).toEqual(["show abc123:t3.json"]);
        expect(harness.commands).toEqual([
          { commandId: "project-clone-create:project-1" },
          {
            commandId: "project-clone-done:project-1",
            scripts: [
              {
                id: "t3json-1",
                name: "Dev",
                command: "pnpm dev",
                icon: "play",
                runOnWorktreeCreate: true,
              },
            ],
          },
        ]);

        // A replay after the tracker forgot the done clone issues the same commands again.
        yield* TestClock.adjust("31 seconds");
        yield* provisioning.clone({ ...startInput, checkout: importing });
        yield* Effect.yieldNow;
        expect(harness.commands.map((command) => command.commandId)).toEqual([
          "project-clone-create:project-1",
          "project-clone-done:project-1",
          "project-clone-create:project-1",
          "project-clone-done:project-1",
        ]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("an ordinary clone imports no scripts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const provisioning = yield* ProjectProvisioning.ProjectProvisioning;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* provisioning.clone(startInput);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(harness.shown).toEqual([]);
      expect(harness.commands).toEqual([
        { commandId: "project-clone-create:project-1" },
        { commandId: "project-clone-done:project-1" },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});
