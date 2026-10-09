import { createFileRoute } from "@tanstack/react-router";

import { SandboxesSettings } from "../components/settings/SandboxesSettings";

export const Route = createFileRoute("/settings/sandboxes")({
  component: SandboxesSettings,
});
