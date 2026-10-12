import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SandboxAccountId,
  SandboxId,
  type SandboxStatus,
  type SandboxView,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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

const view = (
  status: SandboxStatus,
  environmentId: EnvironmentId | null = SANDBOX_ENV,
  desired: SandboxView["desired"] = "running",
) =>
  ({
    id: SANDBOX_ID,
    accountId: SandboxAccountId.make("work"),
    title: "Fix the bug",
    message: "Fix the bug in hello.txt",
    repository: {
      remotes: [{ name: "origin", url: "https://github.com/octocat/Hello-World.git" }],
      trackedRemote: "origin",
      commit: null,
    },
    threadId: ThreadId.make("thread-seed"),
    desired,
    revision: 1,
    settledRevision: 1,
    status,
    environmentId,
    httpBaseUrl: environmentId === null ? null : "https://sbx-1.boat.test",
    createdAt: "2026-10-09T12:00:00.000Z",
  }) as SandboxView;

const ready: SandboxStatus = { _tag: "ready" };
const stopped: SandboxStatus = { _tag: "stopped", reason: "external" };
const putAway = view({ _tag: "stopped", reason: "requested" }, SANDBOX_ENV, "stopped");
const asleep = view(stopped);

describe("planSandboxRegistrations", () => {
  const contributed = (enabled: boolean, dormant = false): RegisteredSandbox => ({
    contributed: true,
    enabled,
    dormant,
  });
  const userSaved = (enabled: boolean): RegisteredSandbox => ({
    contributed: false,
    enabled,
    dormant: false,
  });
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
      name: "keeps an asleep sandbox's environment on but dormant",
      views: [asleep],
      registered: contributed(true),
      actions: [{ _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: true }],
    },
    {
      name: "keeps a sandbox dormant while its machine stops",
      views: [view({ _tag: "stopping", reason: "idle" })],
      registered: contributed(true),
      actions: [{ _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: true }],
    },
    {
      name: "leaves an asleep sandbox that is already dormant",
      views: [asleep],
      registered: contributed(true, true),
      actions: [],
    },
    {
      name: "wakes a dormant environment once the sandbox is ready",
      views: [view(ready)],
      registered: contributed(true, true),
      actions: [{ _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: false }],
    },
    {
      name: "keeps a sandbox that failed on its way back dormant",
      views: [view({ _tag: "failed", step: "resume", message: "Boat refused", retryable: true })],
      registered: contributed(true),
      actions: [{ _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: true }],
    },
    {
      name: "switches a put-away sandbox off",
      views: [putAway],
      registered: contributed(true),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: false }],
    },
    {
      name: "switches a put-away sandbox off while its machine is still up",
      views: [view(ready, SANDBOX_ENV, "stopped")],
      registered: contributed(true, false),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: false }],
    },
    {
      name: "switches a resumed put-away sandbox on dormant first, so nothing dials it",
      views: [asleep],
      registered: contributed(false),
      actions: [
        { _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: true },
        { _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: true },
      ],
    },
    {
      name: "switches a resuming put-away sandbox on dormant first",
      views: [view({ _tag: "resuming" })],
      registered: contributed(false),
      actions: [
        { _tag: "SetDormant", environmentId: SANDBOX_ENV, dormant: true },
        { _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: true },
      ],
    },
    {
      name: "keeps a sandbox whose delete failed off",
      views: [
        view(
          { _tag: "failed", step: "destroy", message: "Boat refused", retryable: true },
          SANDBOX_ENV,
          "destroyed",
        ),
      ],
      registered: contributed(true),
      actions: [{ _tag: "SetEnabled", environmentId: SANDBOX_ENV, enabled: false }],
    },
    { name: "does not pair an asleep sandbox", views: [asleep], actions: [] },
    {
      name: "leaves an asleep sandbox the user paired alone",
      views: [asleep],
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
  it.effect("follows one owner's sandbox through ready, sleep, put away, resume, and removal", () =>
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
      /** Every switch the reconcile flips, in order, as the registry saw it. */
      const switches: Array<string> = [];
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        setEnabled: (environmentId, enabled) =>
          update((next) => {
            switches.push(`enabled:${enabled}`);
            const current = next.get(environmentId);
            if (current !== undefined) next.set(environmentId, { ...current, enabled });
          }),
        setDormant: (environmentId, dormant) =>
          update((next) => {
            switches.push(`dormant:${dormant}`);
            const current = next.get(environmentId);
            if (current === undefined) return;
            const { dormant: _previous, ...rest } = current;
            next.set(environmentId, dormant ? { ...rest, dormant: true } : rest);
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
        const switched = (enabled: boolean, dormant: boolean) =>
          sandboxEntry(
            (current) => current?.enabled === enabled && (current.dormant === true) === dormant,
          );

        yield* Queue.offer(lists, [view(ready)]);
        yield* switched(true, false);
        expect(paired).toEqual([`${OWNER} ${SANDBOX_ID}`]);
        expect(
          sandboxIndex(yield* SubscriptionRef.get(service.owners)).get(SANDBOX_ENV),
        ).toMatchObject({ ownerEnvironmentId: OWNER, sandboxId: SANDBOX_ID });

        yield* Queue.offer(lists, [asleep]);
        yield* switched(true, true);

        yield* Queue.offer(lists, [view(ready)]);
        yield* switched(true, false);

        yield* Queue.offer(lists, [putAway]);
        yield* switched(false, false);

        yield* Queue.offer(lists, [view({ _tag: "resuming" })]);
        yield* switched(true, true);
        expect(switches).toEqual([
          "dormant:true",
          "dormant:false",
          "enabled:false",
          "dormant:true",
          "enabled:true",
        ]);
        expect(paired).toHaveLength(1);

        yield* Queue.offer(lists, []);
        yield* sandboxEntry((current) => current === undefined);
        expect((yield* SubscriptionRef.get(entries)).get(USER_ENV)?.enabled).toBe(true);
      }).pipe(Effect.provide(registry), Effect.scoped);
    }),
  );

  /** A reconciler over one owner whose sandbox list and pairing the test scripts. */
  const harness = <E>(access: Parameters<typeof makeReconciler<E>>[0]) =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[OWNER, entry(OWNER)]]));
      const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        setEnabled: () => Effect.void,
        setDormant: () => Effect.void,
        removeContributed: () => Effect.void,
      });
      const service = yield* makeReconciler(access).pipe(Effect.provide(registry));
      yield* service.start;
      return entries;
    });

  /** Moves the test clock on until `done` holds, for retries that wait between tries. */
  const advanceUntil = (done: () => boolean) =>
    TestClock.adjust("1 second").pipe(Effect.repeat({ until: done }));

  it.effect("follows an owner again after its sandbox list fails", () =>
    Effect.gen(function* () {
      const lists = yield* Queue.unbounded<ReadonlyArray<SandboxView>>();
      let subscriptions = 0;
      const paired: Array<string> = [];
      yield* harness({
        sandboxes: () =>
          Stream.suspend(() =>
            subscriptions++ === 0 ? Stream.fail("connection dropped") : Stream.fromQueue(lists),
          ),
        pair: (_owner, sandboxId) => Effect.sync(() => void paired.push(sandboxId)),
      });
      yield* Queue.offer(lists, [view(ready)]);
      yield* advanceUntil(() => paired.length > 0);
      expect(subscriptions).toBe(2);
      expect(paired).toEqual([SANDBOX_ID]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps pairing a ready sandbox until it works, without a new list", () =>
    Effect.gen(function* () {
      const lists = yield* Queue.unbounded<ReadonlyArray<SandboxView>>();
      let attempts = 0;
      yield* harness({
        sandboxes: () => Stream.fromQueue(lists),
        pair: () =>
          Effect.suspend(() =>
            ++attempts <= 6 ? Effect.fail("guest not answering") : Effect.void,
          ),
      });
      yield* Queue.offer(lists, [view(ready)]);
      yield* advanceUntil(() => attempts === 7);
      yield* TestClock.adjust("10 minutes");
      expect(attempts).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("stops pairing a sandbox the owner no longer lists as ready", () =>
    Effect.gen(function* () {
      const lists = yield* Queue.unbounded<ReadonlyArray<SandboxView>>();
      let attempts = 0;
      yield* harness({
        sandboxes: () => Stream.fromQueue(lists),
        pair: () => Effect.suspend(() => Effect.fail(`guest not answering ${++attempts}`)),
      });
      yield* Queue.offer(lists, [view(ready)]);
      yield* advanceUntil(() => attempts >= 2);
      yield* Queue.offer(lists, [view(stopped)]);
      yield* TestClock.adjust("1 second");
      const settled = attempts;
      yield* TestClock.adjust("10 minutes");
      expect(attempts).toBe(settled);
    }).pipe(Effect.scoped),
  );
});
