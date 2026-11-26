# Product usage data and diagnostics

T3 Code can send lightweight product usage events and relay connection traces to keep the app reliable and fast. None of them has a built-in destination: each is sent only where its build or environment points it (see [Send data to your own services](#send-data-to-your-own-services)). Prompts, responses, file contents, and credentials are never included (unless you explicitly approve an [agent feedback](#agent-feedback) card with conversation text attached).

## Product usage events

The server sends usage events to the analytics endpoint its build or environment names, under a hashed random install ID (plus a hashed T3 Connect account ID when signed in, and random client device IDs). Events contain provider, catalog model name (non-catalog models report as custom), reasoning effort, permission mode, turn/request outcome, duration, release channel, and token counts.

## Disable telemetry

- **Server / CLI**: Set `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` before starting (`DO_NOT_TRACK=1` takes precedence). CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`) disable telemetry by default unless `T3CODE_TELEMETRY_ENABLED=true`.
- **Desktop app**: Export `T3CODE_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` in your shell profile (macOS/Linux) or user environment variables (Windows) and restart.
- **Managed policy**: Administrators can set `"telemetry": false` in [managed policy](./managed-policy.md#other-capabilities) for servers and desktop apps.
- **Mobile app**: Toggle **Send crash reports** and **Send connection traces** separately in **Settings → About T3 Code → Diagnostics**.

## Relay connection diagnostics

T3 Connect sends connection timings, request paths, environment/thread IDs, and error types (no addresses, logs, or stack frames) to the traces endpoint its build or environment names. Disabled by the server telemetry opt-outs above or by `T3CODE_OTEL_SDK_DISABLED` / `OTEL_SDK_DISABLED`.

## Agent feedback

Optional tool for agents to report T3 Code bugs or missing capabilities. Configure in **Settings → Labs → Agent feedback**:

- **Off** (default): Feedback tools and `t3 feedback` are disabled.
- **When I ask**: Agents submit a report only when you ask, shown as an interactive approval card before anything leaves your machine.
- **Automatic**: Also sends minimal automated reports (problem kind + tool/command name only—no text or conversation) when an agent hits a T3 tool failure; enables `t3 feedback` CLI reporting (up to 10/hour).

Approval cards show exact payloads (expected/actual/workaround, turn outline with no text, and optional **Include the conversation** up to 16 KB). File paths, usernames, hostnames, git remotes, and secret-like strings are scrubbed before saving, and reports use one-off random IDs. Inspect local reports with `t3 feedback list [--json]`.

## Send data to your own services

A source build without these settings sends no usage data, traces, or crash reports.
Set them in the server's environment, or in `.env` before building (see `.env.example`). The desktop
app reads `T3CODE_POSTHOG_HOST` and `T3CODE_POSTHOG_KEY` from your shell profile, like
`T3CODE_TELEMETRY_ENABLED`:

- **Product usage and agent feedback:** `T3CODE_POSTHOG_HOST` names a PostHog or PostHog-compatible
  host; the server posts to its `/batch/` path. `T3CODE_POSTHOG_KEY` is the project key, if your
  receiver needs one.
- **Relay connection traces:** `T3CODE_RELAY_CLIENT_OTLP_TRACES_URL` names any OTLP HTTP traces
  endpoint. `T3CODE_RELAY_CLIENT_OTLP_TRACES_HEADERS` adds headers in the OTLP `key=value,…`
  format. `T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN` and `_DATASET` are shorthands for Axiom.
  These apply to the server and desktop app at runtime, and to the web app at build time.
- **Mobile traces and crash reports (build time):** `T3CODE_MOBILE_OTLP_TRACES_URL`, `_HEADERS`,
  `_TOKEN`, and `_DATASET` work the same way for mobile traces. `T3CODE_MOBILE_OBSERVE_ENDPOINT_URL`
  sends crash reports somewhere other than the relay.

Trace endpoints must use HTTPS, or plain HTTP to `localhost`. Malformed headers turn that
pipeline off rather than sending without them.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the T3 Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
