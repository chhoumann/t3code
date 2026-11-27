import { createFileRoute } from "@tanstack/react-router";
import { SandboxesSettings } from "../components/settings/SandboxesSettings";

export const Route = createFileRoute("/_chat/settings/sandboxes")({
  component: SandboxesSettings,
});
