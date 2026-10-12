import type { EnvironmentId, SandboxId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxLaunchView } from "../components/SandboxLaunchView";

function SandboxLaunchRoute() {
  const { environmentId, sandboxId } = Route.useParams();
  // One view per sandbox, so a wake on arrival runs once for each sandbox opened.
  return (
    <SandboxLaunchView
      key={`${environmentId}:${sandboxId}`}
      ownerEnvironmentId={environmentId as EnvironmentId}
      sandboxId={sandboxId as SandboxId}
    />
  );
}

export const Route = createFileRoute("/_chat/sandbox/$environmentId/$sandboxId")({
  component: SandboxLaunchRoute,
});
