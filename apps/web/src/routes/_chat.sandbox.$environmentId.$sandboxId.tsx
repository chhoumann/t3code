import type { EnvironmentId, SandboxId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxLaunchView } from "../components/SandboxLaunchView";

function SandboxLaunchRoute() {
  const { environmentId, sandboxId } = Route.useParams();
  const { unarchive } = Route.useSearch();
  return (
    <SandboxLaunchView
      ownerEnvironmentId={environmentId as EnvironmentId}
      sandboxId={sandboxId as SandboxId}
      unarchive={unarchive === true}
    />
  );
}

export const Route = createFileRoute("/_chat/sandbox/$environmentId/$sandboxId")({
  validateSearch: (search: Record<string, unknown>): { unarchive?: true } =>
    search.unarchive === true || search.unarchive === "true" ? { unarchive: true } : {},
  component: SandboxLaunchRoute,
});
