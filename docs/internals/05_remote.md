# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. Direct access, Tailscale,
SSH, and T3 Connect change how the client reaches the server; they do not introduce a different
execution model.

## Identity is independent of the route

- An environment keeps its ID across restarts and endpoint changes. Repository identity can
  correlate clones across environments (preferring `upstream` for PR features, grouping forks by
  `origin`), but work never silently crosses environments.
- [Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts) publishes
  atomically and retains repair state so concurrent initializers choose the same winner; do not
  sweep that recovery state as temp cleanup.
- **Routes are untrusted hints.** Only the connecting client can prove reachability. Never fall back
  to loopback when a shareable endpoint is unavailable (loopback names the client's own machine).
  Verify a direct or learned route answers as the expected environment before sending credentials,
  and never let a token paired over HTTPS downgrade to plain HTTP.
- Pull request routing trust covers the saved route set: adding or changing a route revokes trust;
  reordering does not.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's agents work in another
by signing in to the target's `/mcp` as an ordinary OAuth client (`t3code-peer-link`). The receiving
side lists and revokes it in Sharing & access like any other session, and owns its expiry/renewal.

- **Mode ceilings always narrow.** Forwarded calls carry the calling agent's modes in
  `T3-Mode-Limit`, which the receiving `/mcp` can only intersect downward with the link's approved
  access.
- **Non-full-access links are fenced by `linkOrigin`.** Threads launched by a peer link (and their
  derived forks, subagents, and spawned threads) carry an immutable `linkOrigin` stamp enforced in
  shared access rules ([`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts)). Below full
  access, linked work can mutate only threads with the same origin, cannot touch projects, settings,
  scheduled tasks, or further links, and skips project setup scripts and worktree layout commands
  (in a project that declares a layout, a worktree launch or handoff for such a thread fails;
  restoring a missing folder brings back plain checkouts). Full-access links are not fenced because
  their agents already run as the receiving OS user. Being unfenced only answers who asked: a
  layout command still runs only with a person's approval of its text, and for an agent only from
  a thread in Full access, both checked in
  [`TaskFolders`](../../apps/server/src/workspace/TaskFolders.ts) at every run.
- **Namespace idempotency keys.** All callers on the linking side share one session on the receiving
  side, so idempotency keys must be hashed with the caller's namespace before forwarding.
- **Clients read linked threads as standard thread streams.**
  [`PeerThreadRelay`](../../apps/server/src/peer/PeerThreadRelay.ts) proxies the same stream format
  read-only so there is no second transcript schema to maintain.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects directly to each
environment without proxying traffic. A [hosted pairing URL](../../apps/web/src/hostedPairing.ts)
puts the backend target in the query and the pairing secret in the URL fragment so the secret never
reaches the hosted origin, then strips it from history.

## Desktop previews tunnel loopback

A desktop webview for a remote environment keeps `localhost` URLs and tunnels loopback connections
through `/api/preview/tunnel` on the environment's own origin:

- **Fixed SOCKS5 proxy, not PAC.** Chromium ignores PAC scripts for loopback hosts. Use a fixed
  proxy that routes only loopback through the tunnel (excluding link-local addresses) and never
  falls back directly—a failed or disabled tunnel must error rather than silently load the
  reviewer's own localhost.
- **Media tickets and local-owner check.** Desktop main holds no environment credentials, so the
  renderer supplies a media ticket per connection (also tracking route switches). Because Chromium
  cannot authenticate to SOCKS5 and a forwarded port is a plain local port, on Linux and macOS both
  listeners serve only connections the system attributes to the current OS user (`/proc/net/tcp`
  on Linux, `lsof` on macOS), and a connection whose owner cannot be read is refused. On Windows
  the listeners do not check the owner.

## Access and process ownership are separate

- Tailscale supplies an endpoint for normal pairing; auth remains the environment's responsibility.
- [SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the launcher started
  it; a server discovered already running must survive client disconnect.
- Remote servers outlive client releases. Clients negotiate features via advertised capabilities
  rather than assuming version parity. Process replacement uses the
  [update protocol](./07_server-updates.md).

## Fleet Hub and virtual environment routing

The self-hosted [`FleetHubService`](../../apps/server/src/fleet/FleetHubService.ts) multiplexes
outbound guest/runner tunnels and exposes each remote node under `/_env/<environmentId>` on the
single hub origin:

- **Authority split by node kind.** Ephemeral sandboxes run in `hub_authority` mode: pairing grants,
  session issuance, DPoP replay/thumbprint binding, and immediate WebSocket revocation live in the
  hub SQLite database so access control works even while a sandbox is stopped. Persistent
  self-hosted runners (`t3 runner start`, connecting via [`GuestFleetRuntime`](../../apps/server/src/fleet/GuestFleetRuntime.ts))
  run in `runner_passthrough` mode and retain their own local session and device authority.
- **Park-and-Splice zero-limbo lifecycle.** Sandboxes receive a deterministic `EnvironmentId` at
  launch (`ms 0`) seeded into `sandbox_projection_cache`. While a sandbox boots or sleeps, shell and
  thread reads serve directly from SQLite cache with zero container/VM wakeups; mutating commands park
  idempotently in `sandbox_inbox`, trigger sandbox wake, drain once the mux tunnel attaches, and
  splice live guest subscription chunks onto open client WebSockets.
- **Origin preservation across `/_env/` proxies.** Forwarded HTTP requests carry
  `x-t3-forwarded-prefix`, `x-forwarded-host`, and `x-forwarded-proto` so [`requestUrl`](../../apps/server/src/requestUrl.ts)
  reconstructs the public `/_env/<environmentId>` URL on both guests and runners (required for
  `McpOAuth` resource validation and `runner_passthrough` DPoP `htu` checks). Hub `/mcp`,
  `/oauth/mcp/*`, and `/.well-known/oauth-*` forwards preserve caller `Authorization` headers so
  automatic sibling `PeerLinks` (via `PeerLinks.linkInternalFleetPeer`) authenticate end-to-end.
- **Exposed host ports and Portals.** Inbound TCP mux streams from a sandbox guest to localhost are
  enforced against the node's allowlisted `exposed_ports_json` (`127.43.0.1:<port>` inside the
  guest). Inbound HTTP/WebSocket Portal requests at `/_env/<environmentId>/portal/<port>/*` require
  a valid hub session or WS ticket before tunneling into the sandbox.
