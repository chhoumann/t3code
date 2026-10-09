import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SandboxAccountId,
  SandboxId,
  type SandboxStatus,
  type SandboxView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget, type NetworkStatus } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  type RegisteredSandbox,
  type SandboxRegistrationAction,
  makeReconciler,
  planSandboxRegistrations,
  sandboxIndex,
} from "./sandboxRegistrations.ts";

const OWNER = EnvironmentId.make("environment-owner");
const SANDBOX_ENV = EnvironmentId.make("environment-sandbox");
const SANDBOX_ID = SandboxId.make("sbx-1");

const view = (status: SandboxStatus, environmentId: EnvironmentId | null = SANDBOX_ENV) =>
  ({
    id: SANDBOX_ID,
    accountId: SandboxAccountId.make("work"),
    title: "Fix the bug",
    repository: { remoteUrl: "https://github.com/octocat/Hello-World.git", commit: null },
    status,
    environmentId,
    httpBaseUrl: environmentId === null ? null : "https://sbx-1.boat.test",
    createdAt: "2026-10-09T12:00:00.000Z",
  }) as SandboxView;

const ready: SandboxStatus = { _tag: "ready" };
const stopped: SandboxStatus = { _tag: "stopped", reason: "requested" };

describe("planSandboxRegistrations", () => {
  const contributed = (enabled: boolean): RegisteredSandbox => ({ contributed: true, enabled });
  const userSaved = (enabled: boolean): RegisteredSandbox => ({ contributed: false, enabled });
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly views: ReadonlyArray<SandboxView>;
    readonly registered?: RegisteredSandbox;
    readonly actions: ReadonlyArray<SandboxRegistrationAction>;
  }> = [
    {
      name: "pairs a ready sandbox it does not know",
      views: [view(ready)],
      actions: [{ _tag: "Pair", sandboxId: SANDBOX_ID, environmentId: SANDBOX_ENV }],
    },
    {
      name: "switches a resumed sandbox back on",
      views: [view(ready)],
      registered: contributed(false),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: true }],
    },
    {
      name: "leaves a ready, connected sandbox",
      views: [view(ready)],
      registered: contributed(true),
      actions: [],
    },
    {
      name: "never touches an environment the user paired",
      views: [view(ready)],
      registered: userSaved(false),
      actions: [],
    },
    {
      name: "switches a stopped sandbox off",
      views: [view(stopped)],
      registered: contributed(true),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: false }],
    },
    {
      name: "keeps a failed sandbox off",
      views: [view({ _tag: "failed", step: "resume", message: "Boat refused", retryable: true })],
      registered: contributed(true),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: false }],
    },
    {
      name: "does not switch on a sandbox still resuming",
      views: [view({ _tag: "resuming" })],
      registered: contributed(false),
      actions: [],
    },
    { name: "does not pair a stopped sandbox", views: [view(stopped)], actions: [] },
    {
      name: "leaves a stopped sandbox the user paired alone",
      views: [view(stopped)],
      registered: userSaved(true),
      actions: [],
    },
    {
      name: "waits for a sandbox without an environment yet",
      views: [view({ _tag: "creating" }, null)],
      actions: [],
    },
    {
      name: "forgets a destroyed sandbox",
      views: [view({ _tag: "destroyed" })],
      registered: contributed(false),
      actions: [{ _tag: "Remove", environmentId: SANDBOX_ENV }],
    },
    {
      name: "forgets a sandbox the owner no longer lists",
      views: [],
      registered: contributed(true),
      actions: [{ _tag: "Remove", environmentId: SANDBOX_ENV }],
    },
    {
      name: "keeps a user's environment the owner does not list",
      views: [],
      registered: userSaved(true),
      actions: [],
    },
  ];

  it.each(rows)("$name", ({ views, registered, actions }) => {
    expect(
      planSandboxRegistrations({
        views,
        registered: new Map(registered === undefined ? [] : [[SANDBOX_ENV, registered]]),
      }),
    ).toEqual(actions);
  });
});

const entry = (environmentId: EnvironmentId, managedBy?: EnvironmentId): ConnectionCatalogEntry => {
  const connectionId = `bearer:${environmentId}`;
  return {
    target: new BearerConnectionTarget({ environmentId, label: environmentId, connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: environmentId,
        httpBaseUrl: `https://${environmentId}.test`,
        wsBaseUrl: `wss://${environmentId}.test`,
        ...(managedBy === undefined ? {} : { managedBy }),
      }),
    ),
    enabled: true,
  };
};

describe("SandboxRegistrations", () => {
  it.effect("follows one owner's sandbox through ready, stop, resume, and removal", () =>
    Effect.gen(function* () {
      const USER_ENV = EnvironmentId.make("environment-user");
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(
        new Map([
          [OWNER, entry(OWNER)],
          [USER_ENV, entry(USER_ENV)],
        ]),
      );
      const update = (f: (current: Map<EnvironmentId, ConnectionCatalogEntry>) => void) =>
        SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          f(next);
          return next;
        });
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        setEnabled: (environmentId, enabled) =>
          update((next) => {
            const current = next.get(environmentId);
            if (current !== undefined) next.set(environmentId, { ...current, enabled });
          }),
        removeContributed: (_source, environmentId) =>
          update((next) => void next.delete(environmentId)),
      });
      const lists = yield* Queue.unbounded<ReadonlyArray<SandboxView>>();
      const paired: Array<string> = [];

      yield* Effect.gen(function* () {
        const service = yield* makeReconciler({
          sandboxes: (owner) => (owner === OWNER ? Stream.fromQueue(lists) : Stream.never),
          pair: (owner, sandboxId) =>
            Effect.gen(function* () {
              paired.push(`${owner} ${sandboxId}`);
              yield* update((next) => void next.set(SANDBOX_ENV, entry(SANDBOX_ENV, owner)));
            }),
        });
        yield* service.start;
        const sandboxEntry = (predicate: (entry: ConnectionCatalogEntry | undefined) => boolean) =>
          SubscriptionRef.changes(entries).pipe(
            Stream.map((current) => current.get(SANDBOX_ENV)),
            Stream.filter(predicate),
            Stream.runHead,
          );

        yield* Queue.offer(lists, [view(ready)]);
        yield* sandboxEntry((current) => current?.enabled === true);
        expect(paired).toEqual([`${OWNER} ${SANDBOX_ID}`]);
        expect(
          sandboxIndex(yield* SubscriptionRef.get(service.owners)).get(SANDBOX_ENV),
        ).toMatchObject({ ownerEnvironmentId: OWNER, sandboxId: SANDBOX_ID });

        yield* Queue.offer(lists, [view(stopped)]);
        yield* sandboxEntry((current) => current?.enabled === false);

        yield* Queue.offer(lists, [view(ready)]);
        yield* sandboxEntry((current) => current?.enabled === true);
        expect(paired).toHaveLength(1);

        yield* Queue.offer(lists, []);
        yield* sandboxEntry((current) => current === undefined);
        expect((yield* SubscriptionRef.get(entries)).get(USER_ENV)?.enabled).toBe(true);
      }).pipe(Effect.provide(registry), Effect.scoped);
    }),
  );
});
