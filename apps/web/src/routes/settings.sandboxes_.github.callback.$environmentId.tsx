import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxGitHubCallback } from "../components/settings/SandboxGitHubCallback";

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

function SandboxGitHubCallbackRoute() {
  const { environmentId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <SandboxGitHubCallback
      environmentId={environmentId as EnvironmentId}
      code={search.githubCode ?? null}
      state={search.githubState ?? null}
    />
  );
}

/**
 * GitHub's callback query, under names of its own so they stay apart from the
 * other routes' `state`. Installation details are GitHub's to keep; the owner
 * only needs the code.
 */
export const Route = createFileRoute("/settings/sandboxes_/github/callback/$environmentId")({
  validateSearch: (raw: Record<string, unknown>) => {
    const code = text(raw.code);
    const state = text(raw.state);
    return {
      ...(code === null ? {} : { githubCode: code }),
      ...(state === null ? {} : { githubState: state }),
    };
  },
  component: SandboxGitHubCallbackRoute,
});
