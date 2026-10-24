/**
 * ProjectProvisioning - creates a project from a repository clone. It owns
 * what happens around `ProjectCloneTracker`'s clone: the project row before
 * git starts, and after git is done the repository identity, the clone's
 * `t3.json` scripts when asked for, and the status refresh. The WebSocket
 * RPC and a sandbox owner driving a guest both go through `clone`.
 *
 * @module ProjectProvisioning
 */
import {
  CommandId,
  OrchestrationDispatchCommandError,
  type ProjectCloneBase,
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type ProjectId,
  type ProjectScript,
  type SourceControlRepositoryError,
} from "@t3tools/contracts";
import { parseT3ProjectFile, projectScriptsFromT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export class ProjectProvisioning extends Context.Service<
  ProjectProvisioning,
  {
    /**
     * Creates the project and starts its clone; progress, cancel, and retry
     * stay with `ProjectCloneTracker`. Keyed by the project id, so a replay
     * finds the project and the published clone it made.
     */
    readonly clone: (
      input: ProjectCloneStartInput,
    ) => Effect.Effect<
      ProjectCloneStartResult,
      SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
  }
>()("t3/project/ProjectProvisioning") {}

const T3_PROJECT_FILE = "t3.json";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const projectService = yield* ProjectService.ProjectService;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const git = yield* GitVcsDriver.GitVcsDriver;

  /** The clone's scripts at the pinned base, so a template's checkout cannot supply another branch's. */
  const readProjectScripts = Effect.fn("ProjectProvisioning.readProjectScripts")(function* (
    workspaceRoot: string,
    commit: string,
  ): Effect.fn.Return<ReadonlyArray<ProjectScript>> {
    const shown = yield* git
      .execute({
        operation: "ProjectProvisioning.readProjectScripts",
        cwd: workspaceRoot,
        args: ["show", `${commit}:${T3_PROJECT_FILE}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (shown === null || shown.exitCode !== 0) return [];
    const file = parseT3ProjectFile(shown.stdout);
    return file === null ? [] : projectScriptsFromT3ProjectFile(file);
  });

  const finalize = Effect.fn("ProjectProvisioning.finalize")(function* (
    input: ProjectCloneStartInput,
    project: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly base: ProjectCloneBase | null;
    },
  ) {
    const { projectId, workspaceRoot, base } = project;
    yield* repositoryIdentityResolver.resolve(workspaceRoot, { refresh: true });
    const scripts =
      input.checkout?.importProjectScripts === true && base !== null
        ? yield* readProjectScripts(workspaceRoot, base.commit)
        : [];
    // One fixed command, so a replayed clone neither imports twice nor undoes later edits.
    yield* projectService.update({
      commandId: CommandId.make(`project-clone-done:${projectId}`),
      projectId,
      ...(scripts.length === 0 ? {} : { scripts }),
    });
    yield* vcsStatusBroadcaster
      .refreshStatus(workspaceRoot)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
    // The folder was empty when the project was created, so the cached
    // enrichment says "no repository" and clients cannot group it yet.
    yield* projectEnrichment.invalidate([workspaceRoot]);
    yield* projectEnrichment.request(workspaceRoot);
  });

  const clone: ProjectProvisioning["Service"]["clone"] = (input) =>
    tracker.start(input, {
      createProject: (project) =>
        projectService
          .create({
            commandId: CommandId.make(`project-clone-create:${project.projectId}`),
            projectId: project.projectId,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            createWorkspaceRootIfMissing: true,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to create clone project.",
                  cause,
                }),
            ),
          ),
      finalize: (project) =>
        finalize(input, project).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: `The clone finished, but the project could not be set up: ${cause.message}`,
                cause,
              }),
          ),
        ),
    });

  return ProjectProvisioning.of({ clone });
});

export const layer = Layer.effect(ProjectProvisioning, make);
