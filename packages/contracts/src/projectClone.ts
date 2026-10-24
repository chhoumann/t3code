import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SandboxBase } from "./sandbox.ts";
import {
  SourceControlCloneProtocol,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from "./sourceControl.ts";

export const PROJECT_CLONE_DETAIL_MAX_LENGTH = 200;
export const PROJECT_CLONE_ERROR_MAX_LENGTH = 1000;

export const ProjectCloneStage = Schema.Literals([
  "connecting",
  "counting",
  "receiving",
  "resolving",
  "checkout",
]);
export type ProjectCloneStage = typeof ProjectCloneStage.Type;

export const ProjectClonePhase = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type ProjectClonePhase = typeof ProjectClonePhase.Type;

/** The remote branch a checkout was pinned to, and its commit at that time. */
export const ProjectCloneBase = Schema.Struct({
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type ProjectCloneBase = typeof ProjectCloneBase.Type;

/**
 * Preparation past the plain clone, which sandboxes ask for: the base is
 * fetched and pinned, a template's existing clone of the repository is
 * adopted, and the clone's `t3.json` scripts are imported. Adding a project
 * never asks for it, so its scripts stay an explicit import.
 */
export const ProjectCloneCheckout = Schema.Struct({
  base: SandboxBase,
  /**
   * Adopt a published clone of the same repository at the destination
   * instead of refusing a non-empty one. A clone of another repository is
   * refused, never reset.
   */
  reuseMatching: Schema.Boolean,
  importProjectScripts: Schema.Boolean,
});
export type ProjectCloneCheckout = typeof ProjectCloneCheckout.Type;

export const ProjectCloneSnapshot = Schema.Struct({
  projectId: ProjectId,
  remoteUrl: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
  phase: ProjectClonePhase,
  stage: ProjectCloneStage,
  percent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_CLONE_DETAIL_MAX_LENGTH))),
  /** Git has printed nothing for a while; `detail` is no longer current. Older servers omit it. */
  stalled: Schema.optionalKey(Schema.Boolean),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_CLONE_ERROR_MAX_LENGTH))),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  sequence: NonNegativeInt,
  /** Set once a clone with a `checkout` is done. */
  base: Schema.optionalKey(ProjectCloneBase),
});
export type ProjectCloneSnapshot = typeof ProjectCloneSnapshot.Type;

export const ProjectCloneSubscribeInput = Schema.Struct({});
export type ProjectCloneSubscribeInput = typeof ProjectCloneSubscribeInput.Type;

export const ProjectCloneListEvent = Schema.Array(ProjectCloneSnapshot);
export type ProjectCloneListEvent = typeof ProjectCloneListEvent.Type;

export const ProjectCloneStartInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
  checkout: Schema.optional(ProjectCloneCheckout),
});
export type ProjectCloneStartInput = typeof ProjectCloneStartInput.Type;

export const ProjectCloneStartResult = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type ProjectCloneStartResult = typeof ProjectCloneStartResult.Type;

export const ProjectCloneActionInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCloneActionInput = typeof ProjectCloneActionInput.Type;

export const ProjectCloneActionResult = Schema.Struct({
  applied: Schema.Boolean,
});
export type ProjectCloneActionResult = typeof ProjectCloneActionResult.Type;

function projectCloneStageLabel(stage: ProjectCloneStage): string {
  switch (stage) {
    case "connecting":
      return "Connecting";
    case "counting":
      return "Counting objects";
    case "receiving":
      return "Receiving objects";
    case "resolving":
      return "Resolving deltas";
    case "checkout":
      return "Checking out files";
  }
}

export function projectCloneDisplayName(
  snapshot: Pick<ProjectCloneSnapshot, "repository" | "destinationPath">,
): string {
  if (snapshot.repository) return snapshot.repository.nameWithOwner;
  const segments = snapshot.destinationPath.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? snapshot.destinationPath;
}

export function projectCloneProgressSummary(
  snapshot: Pick<ProjectCloneSnapshot, "stage" | "percent" | "detail" | "stalled">,
): string {
  const parts = [projectCloneStageLabel(snapshot.stage)];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  // The detail carries git's last transfer speed, which a stall makes a lie.
  if (snapshot.stalled) parts.push("Stalled");
  else if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}
