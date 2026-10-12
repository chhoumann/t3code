import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];

export type FakeEntries = ReadonlyMap<
  EnvironmentId,
  { readonly target: { readonly label: string } }
>;

/**
 * A registry of the environments in `entries`, each connected while its
 * session holds one. Like the real registry, `run` fails for an environment
 * that is not registered, and `followStream` waits for it to register.
 */
export const fakeEnvironmentRegistry = (
  entries: SubscriptionRef.SubscriptionRef<FakeEntries>,
  sessions: ReadonlyMap<EnvironmentId, SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>>,
) => {
  const supervisor = (environmentId: EnvironmentId) =>
    EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: { environmentId },
      session: sessions.get(environmentId)!,
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: Registry["run"] = (environmentId, effect) =>
    Effect.gen(function* () {
      if (!(yield* SubscriptionRef.get(entries)).has(environmentId)) {
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId });
      }
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor(environmentId),
      );
    });
  const followStream: Registry["followStream"] = (environmentId, stream) =>
    SubscriptionRef.changes(entries).pipe(
      Stream.map((current) => current.has(environmentId)),
      Stream.changes,
      Stream.switchMap((registered) =>
        registered
          ? Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            )
          : Stream.empty,
      ),
    );
  return { entries, run, followStream } as unknown as Registry;
};
