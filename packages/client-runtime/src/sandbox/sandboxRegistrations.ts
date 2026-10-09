/**
 * SandboxRegistrations - keeps every client's connections in step with the
 * sandboxes its environments own. Each owner's sandbox list decides which
 * sandbox environments this client is paired with: a ready sandbox is paired
 * through its owner, a stopped one stays saved but switched off so nothing
 * redials a dead address, and a destroyed one is forgotten. The routes are
 * the owner's contributions (`BearerConnectionProfile.managedBy`), so a route
 * the user paired by hand survives.
 *
 * An owner that cannot be reached has said nothing: its sandboxes keep their
 * registrations until it lists them again.
 *
 * @module SandboxRegistrations
 */
import {
  type EnvironmentId,
  type SandboxConnectResult,
  type SandboxId,
  type SandboxView,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
}

export type SandboxRegistrationAction =
  | { readonly _tag: "Pair"; readonly sandboxId: SandboxId; readonly environmentId: EnvironmentId }
  | {
      readonly _tag: "SetEnabled";
      readonly environmentId: EnvironmentId;
      readonly enabled: boolean;
    }
  | { readonly _tag: "Remove"; readonly environmentId: EnvironmentId };

/**
 * What one owner's latest list asks of this client's registry. Only routes the
 * owner contributed are switched or removed; an environment the user paired
 * is never touched, and one already registered is never paired again.
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
    switch (view.status._tag) {
      case "ready":
        if (registered === undefined) {
          actions.push({ _tag: "Pair", sandboxId: view.id, environmentId });
        } else if (registered.contributed && !registered.enabled) {
          actions.push({ _tag: "SetEnabled", environmentId, enabled: true });
        }
        break;
      case "destroying":
      case "destroyed":
        if (registered?.contributed === true) actions.push({ _tag: "Remove", environmentId });
        break;
      default:
        // Not serving: stopping, stopped, resuming, failed, or still starting.
        if (registered?.contributed === true && registered.enabled) {
          actions.push({ _tag: "SetEnabled", environmentId, enabled: false });
        }
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
  readonly sandboxes: (owner: EnvironmentId) => Stream.Stream<ReadonlyArray<SandboxView>>;
  /** Pairs this client with a ready sandbox, as a route the owner contributes. */
  readonly pair: (owner: EnvironmentId, sandboxId: SandboxId) => Effect.Effect<unknown, E>;
}

const PAIR_RETRY = { schedule: Schedule.exponential("1 second"), times: 4 } as const;

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
          yield* access.pair(owner, action.sandboxId).pipe(Effect.retry(PAIR_RETRY));
          return;
        case "SetEnabled":
          return yield* registry.setEnabled(action.environmentId, action.enabled);
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
          { contributed: contributedBy(entry, owner), enabled: entry.enabled },
        ]),
      );
      for (const action of planSandboxRegistrations({ views, registered })) {
        yield* apply(owner, action).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not apply a sandbox registration change.", {
              owner,
              action: action._tag,
              environmentId: action.environmentId,
              error,
            }),
          ),
        );
      }
    });

    const follow = (owner: EnvironmentId) =>
      access.sandboxes(owner).pipe(
        // A list that arrives while the previous one is applied replaces any still waiting.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach((views) => reconcile(owner, views)),
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
).pipe(
  Stream.catch((error) =>
    Stream.fromEffect(Effect.logWarning("Could not follow an owner's sandboxes.", { error })).pipe(
      Stream.drain,
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
