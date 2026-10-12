/**
 * SandboxRegistrations - keeps every client's connections in step with the
 * sandboxes its environments own. Each owner's sandbox list decides which
 * sandbox environments this client is paired with: a ready sandbox is paired
 * through its owner; one whose machine sleeps stays switched on but dormant,
 * so its threads stay listed from cache while nothing redials a dead address;
 * one the user put away is switched off; and a destroyed one is forgotten.
 * The routes are the owner's contributions (`BearerConnectionProfile.managedBy`),
 * so a route the user paired by hand survives.
 *
 * An owner that cannot be reached has said nothing: its sandboxes keep their
 * registrations until it lists them again. A failed subscription or change is
 * retried with backoff for as long as the owner's latest list asks for it.
 *
 * @module SandboxRegistrations
 */
import {
  type EnvironmentId,
  type SandboxConnectResult,
  type SandboxId,
  type SandboxStatus,
  type SandboxView,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionRoutes } from "../connection/routes.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request, subscribe } from "../rpc/client.ts";

/**
 * What a sandbox is to this client, from what its user asked for and what its
 * machine does, so every client of the owner reads the same:
 * - `running`: serving its threads.
 * - `waking`: asked to run again and coming back.
 * - `asleep`: meant to run, but its machine stopped or is stopping. Its
 *   threads stay listed, and work sent to it wakes it.
 * - `put-away`: stopped because the user asked. It leaves the sidebar until
 *   it is resumed.
 * - `launching`: on its way to its first thread.
 * - `failed`: its last step failed while it was meant to run, or its delete
 *   failed.
 * - `gone`: deleted, or being deleted.
 */
export type SandboxPresence =
  | "running"
  | "waking"
  | "asleep"
  | "put-away"
  | "launching"
  | "failed"
  | "gone";

const PRESENCE_BY_STATUS: Record<SandboxStatus["_tag"], SandboxPresence> = {
  creating: "launching",
  booting: "launching",
  launching: "launching",
  ready: "running",
  stopping: "asleep",
  stopped: "asleep",
  resuming: "waking",
  failed: "failed",
  destroying: "gone",
  destroyed: "gone",
};

export function sandboxPresence(view: Pick<SandboxView, "desired" | "status">): SandboxPresence {
  const presence = PRESENCE_BY_STATUS[view.status._tag];
  switch (view.desired) {
    case "running":
      return presence;
    case "stopped":
      return presence === "gone" ? presence : "put-away";
    case "destroyed":
      return presence === "failed" ? presence : "gone";
  }
}

/** One sandbox environment, as its owner last described it. */
export interface SandboxIndexEntry {
  readonly ownerEnvironmentId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly view: SandboxView;
}

/** Sandbox environments by environment id, across every owner. */
export function sandboxIndex(
  owners: ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>,
): ReadonlyMap<EnvironmentId, SandboxIndexEntry> {
  const index = new Map<EnvironmentId, SandboxIndexEntry>();
  for (const [ownerEnvironmentId, views] of owners) {
    for (const view of views) {
      if (view.environmentId === null) continue;
      index.set(view.environmentId, { ownerEnvironmentId, sandboxId: view.id, view });
    }
  }
  return index;
}

/** An environment in this client's registry, as one owner's reconcile sees it. */
export interface RegisteredSandbox {
  /** The owner contributed a route to it. */
  readonly contributed: boolean;
  readonly enabled: boolean;
  readonly dormant: boolean;
}

export type SandboxRegistrationAction =
  | { readonly _tag: "Pair"; readonly sandboxId: SandboxId; readonly environmentId: EnvironmentId }
  | {
      readonly _tag: "SetEnabled";
      readonly environmentId: EnvironmentId;
      readonly enabled: boolean;
    }
  | {
      readonly _tag: "SetDormant";
      readonly environmentId: EnvironmentId;
      readonly dormant: boolean;
    }
  | { readonly _tag: "Remove"; readonly environmentId: EnvironmentId };

/**
 * What one owner's latest list asks of this client's registry. Only routes the
 * owner contributed are switched or removed; an environment the user paired
 * is never touched, and one already registered is never paired again. An
 * environment is made dormant before it is switched on, so switching it on
 * never dials a machine that sleeps.
 */
export function planSandboxRegistrations(input: {
  readonly views: ReadonlyArray<SandboxView>;
  readonly registered: ReadonlyMap<EnvironmentId, RegisteredSandbox>;
}): ReadonlyArray<SandboxRegistrationAction> {
  const actions: Array<SandboxRegistrationAction> = [];
  const listed = new Set<EnvironmentId>();
  for (const view of input.views) {
    const environmentId = view.environmentId;
    if (environmentId === null) continue;
    listed.add(environmentId);
    const registered = input.registered.get(environmentId);
    const presence = sandboxPresence(view);
    if (presence === "running" && registered === undefined) {
      actions.push({ _tag: "Pair", sandboxId: view.id, environmentId });
    }
    if (registered?.contributed !== true) continue;
    // A sandbox whose delete failed stays switched off, like one put away, until it is retried.
    switch (presence === "failed" && view.desired === "destroyed" ? "put-away" : presence) {
      case "gone":
        actions.push({ _tag: "Remove", environmentId });
        break;
      case "put-away":
        if (registered.enabled) actions.push({ _tag: "SetEnabled", environmentId, enabled: false });
        break;
      case "running":
      case "asleep":
      case "waking":
      case "failed": {
        const dormant = presence !== "running";
        if (registered.dormant !== dormant) {
          actions.push({ _tag: "SetDormant", environmentId, dormant });
        }
        if (!registered.enabled) actions.push({ _tag: "SetEnabled", environmentId, enabled: true });
        break;
      }
      case "launching":
        break;
    }
  }
  for (const [environmentId, registered] of input.registered) {
    if (registered.contributed && !listed.has(environmentId)) {
      actions.push({ _tag: "Remove", environmentId });
    }
  }
  return actions;
}

function contributedBy(entry: ConnectionCatalogEntry, owner: EnvironmentId): boolean {
  return connectionRoutes(entry).some((route) => {
    const profile = Option.getOrNull(route.profile);
    return profile?._tag === "BearerConnectionProfile" && profile.managedBy === owner;
  });
}

export class SandboxRegistrations extends Context.Service<
  SandboxRegistrations,
  {
    /**
     * Each owner's last sandbox list. An owner that went offline keeps its
     * last list; read it through `sandboxIndex`.
     */
    readonly owners: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>
    >;
    /** Starts following owners; run once, after the registry has started. */
    readonly start: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/sandbox/sandboxRegistrations") {}

/** What the reconcile needs from an owner, over the network. */
export interface SandboxOwnerAccess<E> {
  /** The owner's sandbox list, then the whole list again after each change. */
  readonly sandboxes: (owner: EnvironmentId) => Stream.Stream<ReadonlyArray<SandboxView>, E>;
  /** Pairs this client with a ready sandbox, as a route the owner contributes. */
  readonly pair: (owner: EnvironmentId, sandboxId: SandboxId) => Effect.Effect<unknown, E>;
}

const RETRY = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")]);

/** Once started, follows every registered environment's sandboxes for as long as the scope lives. */
export const makeReconciler = <E>(access: SandboxOwnerAccess<E>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const owners = yield* SubscriptionRef.make<
      ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxView>>
    >(new Map());
    const followers = yield* FiberMap.make<EnvironmentId>();
    const followed = new Set<EnvironmentId>();

    const apply = Effect.fn("SandboxRegistrations.apply")(function* (
      owner: EnvironmentId,
      action: SandboxRegistrationAction,
    ) {
      switch (action._tag) {
        case "Pair":
          yield* access.pair(owner, action.sandboxId);
          return;
        case "SetEnabled":
          return yield* registry.setEnabled(action.environmentId, action.enabled);
        case "SetDormant":
          return yield* registry.setDormant(action.environmentId, action.dormant);
        case "Remove":
          return yield* registry.removeContributed(owner, action.environmentId);
      }
    });

    const reconcile = Effect.fn("SandboxRegistrations.reconcile")(function* (
      owner: EnvironmentId,
      views: ReadonlyArray<SandboxView>,
    ) {
      yield* SubscriptionRef.update(owners, (current) => new Map(current).set(owner, views));
      const entries = yield* SubscriptionRef.get(registry.entries);
      const registered = new Map(
        [...entries].map(([environmentId, entry]) => [
          environmentId,
          {
            contributed: contributedBy(entry, owner),
            enabled: entry.enabled,
            dormant: entry.dormant === true,
          },
        ]),
      );
      // Every change is tried; the first failure fails the reconcile so it is retried.
      const results = yield* Effect.forEach(
        planSandboxRegistrations({ views, registered }),
        (action) =>
          apply(owner, action).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not apply a sandbox registration change.", {
                owner,
                action: action._tag,
                environmentId: action.environmentId,
                error,
              }),
            ),
            Effect.result,
          ),
      );
      const failure = results.find(Result.isFailure);
      if (failure !== undefined) return yield* Effect.fail(failure.failure);
    });

    const follow = (owner: EnvironmentId) =>
      access.sandboxes(owner).pipe(
        Stream.tapError((error) =>
          Effect.logWarning("Could not follow an owner's sandboxes.", { owner, error }),
        ),
        Stream.retry(RETRY),
        // A newer list replaces a reconcile still retrying an older one.
        Stream.switchMap((views) =>
          Stream.fromEffect(reconcile(owner, views).pipe(Effect.retry(RETRY))),
        ),
        Stream.runDrain,
      );

    const start = SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          for (const environmentId of entries.keys()) {
            if (followed.has(environmentId)) continue;
            followed.add(environmentId);
            yield* FiberMap.run(followers, environmentId, follow(environmentId));
          }
          for (const environmentId of followed) {
            if (entries.has(environmentId)) continue;
            followed.delete(environmentId);
            yield* FiberMap.remove(followers, environmentId);
            yield* SubscriptionRef.update(owners, (current) => {
              const next = new Map(current);
              next.delete(environmentId);
              return next;
            });
          }
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

    return SandboxRegistrations.of({ owners, start });
  }).pipe(Effect.withSpan("SandboxRegistrations.makeReconciler"));

/** Every list the owner sends while it advertises sandboxes, across reconnects. */
const ownerSandboxes = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config) =>
                    config.environment.capabilities.sandboxes === true
                      ? subscribe(WS_METHODS.sandboxesSubscribe, {})
                      : Stream.empty,
                  ),
                ),
              ),
          }),
        ),
      ),
    ),
  ),
);

export const layer = Layer.effect(
  SandboxRegistrations,
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const connect = (owner: EnvironmentId, sandboxId: SandboxId) =>
      registry.run(owner, request(WS_METHODS.sandboxesConnect, { id: sandboxId }));
    return yield* makeReconciler({
      sandboxes: (owner) => registry.followStream(owner, ownerSandboxes),
      pair: (owner, sandboxId) =>
        connect(owner, sandboxId).pipe(
          Effect.flatMap((grant: SandboxConnectResult) =>
            onboarding.registerPairing({
              host: grant.httpBaseUrl,
              pairingCode: grant.pairingCredential,
              expectedEnvironmentId: grant.environmentId,
              managedBy: owner,
            }),
          ),
        ),
    });
  }),
);
