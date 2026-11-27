/**
 * Dispatches SandboxProvider operations to the driver matching `account.provider`.
 */
import type { SandboxProviderKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BoatSandboxProvider from "./BoatSandboxProvider.ts";
import * as CommandSandboxProvider from "./CommandSandboxProvider.ts";
import * as DockerSandboxProvider from "./DockerSandboxProvider.ts";
import { SandboxProvider, type SandboxProviderAccount } from "./SandboxProvider.ts";

export interface ProviderMap {
  readonly docker: SandboxProvider["Service"];
  readonly command: SandboxProvider["Service"];
  readonly boat: SandboxProvider["Service"];
}

function makeCompositeSandboxProvider(providers: ProviderMap): SandboxProvider["Service"] {
  const select = (account: SandboxProviderAccount): SandboxProvider["Service"] => {
    const kind: SandboxProviderKind = account.provider ?? "boat";
    return providers[kind];
  };

  return SandboxProvider.of({
    checkAccess: Effect.fn("CompositeSandboxProvider.checkAccess")((account) =>
      select(account).checkAccess(account),
    ),
    listTemplates: Effect.fn("CompositeSandboxProvider.listTemplates")((account) =>
      select(account).listTemplates(account),
    ),
    create: Effect.fn("CompositeSandboxProvider.create")((account, input) =>
      select(account).create(account, input),
    ),
    inspect: Effect.fn("CompositeSandboxProvider.inspect")((account, id) =>
      select(account).inspect(account, id),
    ),
    exec: Effect.fn("CompositeSandboxProvider.exec")((account, id, input) =>
      select(account).exec(account, id, input),
    ),
    writeFile: Effect.fn("CompositeSandboxProvider.writeFile")((account, id, input) =>
      select(account).writeFile(account, id, input),
    ),
    host: Effect.fn("CompositeSandboxProvider.host")((account, id, port) =>
      select(account).host(account, id, port),
    ),
    setDeadline: Effect.fn("CompositeSandboxProvider.setDeadline")((account, id, ttlSeconds) =>
      select(account).setDeadline(account, id, ttlSeconds),
    ),
    stop: Effect.fn("CompositeSandboxProvider.stop")((account, id) =>
      select(account).stop(account, id),
    ),
    resume: Effect.fn("CompositeSandboxProvider.resume")((account, id, input) =>
      select(account).resume(account, id, input),
    ),
    destroy: Effect.fn("CompositeSandboxProvider.destroy")((account, id) =>
      select(account).destroy(account, id),
    ),
  });
}

const buildDriver = Effect.fn("CompositeSandboxProvider.buildDriver")(function* <R, E>(
  providerLayer: Layer.Layer<SandboxProvider, E, R>,
) {
  const ctx = yield* Layer.build(providerLayer);
  return Context.get(ctx, SandboxProvider);
}, Effect.scoped);

export const layer = Layer.effect(
  SandboxProvider,
  Effect.gen(function* () {
    const [docker, command, boat] = yield* Effect.all([
      buildDriver(DockerSandboxProvider.layer),
      buildDriver(CommandSandboxProvider.layer),
      buildDriver(BoatSandboxProvider.layer),
    ]);
    return makeCompositeSandboxProvider({ docker, command, boat });
  }),
);
