import {
  EnvironmentId,
  SandboxAccountId,
  SandboxBase,
  SandboxId,
  SandboxRemoteUrl,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

/**
 * A draft that will launch a new sandbox instead of a thread. Its id is made
 * once per draft, so sending twice finds the same sandbox.
 */
const SandboxDraftTarget = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  accountId: SandboxAccountId,
  sandboxId: SandboxId,
  /** The repository to clone in place of the draft's project's. */
  remoteUrl: Schema.optionalKey(SandboxRemoteUrl),
  /** Omitted starts from the remote's default branch. */
  base: Schema.optionalKey(SandboxBase),
});
export type SandboxDraftTarget = typeof SandboxDraftTarget.Type;

const PersistedTargets = Schema.Record(Schema.String, SandboxDraftTarget);
const decodeTargets = Schema.decodeUnknownOption(PersistedTargets);

interface SandboxDraftStoreState {
  readonly targets: Readonly<Record<string, SandboxDraftTarget>>;
  /** Keeps the draft's repository and base across a change of account. */
  readonly choose: (
    draftId: DraftId,
    ownerEnvironmentId: EnvironmentId,
    accountId: SandboxAccountId,
  ) => void;
  /** A `remoteUrl` of null lets the draft follow its project's repository again. */
  readonly setSource: (
    draftId: DraftId,
    source: { readonly remoteUrl?: SandboxRemoteUrl | null; readonly base?: SandboxBase },
  ) => void;
  readonly clear: (draftId: DraftId) => void;
}

export type SandboxDraftStoreSetSource = SandboxDraftStoreState["setSource"];

export const useSandboxDraftStore = create<SandboxDraftStoreState>()(
  persist(
    (set) => ({
      targets: {},
      choose: (draftId, ownerEnvironmentId, accountId) =>
        set((state) => {
          const current = state.targets[draftId];
          if (current?.ownerEnvironmentId === ownerEnvironmentId && current.accountId === accountId)
            return state;
          return {
            targets: {
              ...state.targets,
              [draftId]: {
                ...current,
                ownerEnvironmentId,
                accountId,
                sandboxId: SandboxId.make(randomUUID()),
              },
            },
          };
        }),
      setSource: (draftId, { remoteUrl, base }) =>
        set((state) => {
          const current = state.targets[draftId];
          if (current === undefined) return state;
          const { remoteUrl: kept, ...rest } = current;
          const nextRemoteUrl =
            remoteUrl === undefined ? kept : remoteUrl === null ? undefined : remoteUrl;
          return {
            targets: {
              ...state.targets,
              [draftId]: {
                ...rest,
                ...(nextRemoteUrl === undefined ? {} : { remoteUrl: nextRemoteUrl }),
                ...(base === undefined ? {} : { base }),
              },
            },
          };
        }),
      clear: (draftId) =>
        set((state) => {
          if (state.targets[draftId] === undefined) return state;
          const { [draftId]: _cleared, ...targets } = state.targets;
          return { targets };
        }),
    }),
    {
      name: "t3code:sandbox-draft-targets:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ targets }) => ({ targets }),
      merge: (persisted, current) => ({
        ...current,
        targets: Option.getOrElse(
          decodeTargets((persisted as { targets?: unknown } | null)?.targets),
          () => ({}),
        ),
      }),
    },
  ),
);

export function useSandboxDraftTarget(draftId: DraftId | null): SandboxDraftTarget | null {
  return useSandboxDraftStore((state) =>
    draftId === null ? null : (state.targets[draftId] ?? null),
  );
}
