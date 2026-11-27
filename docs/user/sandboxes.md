# Sandboxes

A sandbox is an isolated environment that runs its own T3 Code server. Your T3 Code
environment creates the machine or container, prepares your project onto a new branch,
and routes traffic to it at a stable `/_env/<environmentId>` path on your server.
Sandboxes can run in the cloud on [Boat](https://boat.dev), locally in Docker
containers (**Local Docker**), or through any **Custom Command** provider driver.
You can also connect persistent self-hosted machines to the same server hub with
`t3 runner start`.

## Add an account

Open **Settings → Sandboxes** and choose **Add account**. Pick a provider:

- **Local Docker**: Runs each sandbox in a Docker container on the host using a
  configured image (for example `t3code/sandbox:latest`). No cloud API key is
  required.
- **Custom Command**: Delegates sandbox lifecycle operations (`create`, `exec`,
  `host`, `stop`, `resume`, `destroy`, `list-templates`) to a JSON-over-stdio
  program you provide.
- **Boat**: Creates cloud sandboxes with a Boat API key. T3 Code checks that the key
  can create, read, update, stop, resume, and delete sandboxes, run commands, write
  files, host ports, and read snapshots before saving the account.

For accounts with **Exposed host ports**, list local TCP ports from the host
machine that sandboxes may dial at `127.43.0.1:<port>` inside the sandbox
(unlisted host ports are refused by the hub).

The API key and any environment variable values stay in that environment's secret
store, not in its settings. You can add more than one account, such as a personal
and a work account.

In the project's settings, use **Sandboxes** to choose a template for each
account. For Boat accounts, the template menu lists the selected account's ready
Boat snapshots. A snapshot of another sandbox keeps its files and installed tools,
but the new sandbox starts T3 Code without that sandbox's threads and fetches the
branch it starts from into the snapshot's clone of the repository.
You can also override the account's machine size and stop time there.
These defaults apply to new sandboxes for every checkout of that repository.
Reset them to use the account defaults and start without a template.

Environment variables reach T3 Code and the agents in the sandbox, so this is
where a provider API key goes. Mark a variable **Setup only** to give it to the
machine setup script alone and keep it out of the agents' environment. This is
not a hard boundary: the sandbox's user has passwordless `sudo` and can read the
file that holds it.

When cloning a remote repository, the sandbox needs its own access to private
repositories. For GitHub, choose **Connect GitHub** in **Settings → Sandboxes**.
T3 Code creates a GitHub App on your account, and you pick the repositories it
can reach; **Manage repositories** changes that later. Every sandbox is then
signed in to `gh` and git as you with a token that lasts eight hours and that
the environment owning the sandbox renews while it runs, so agents can clone,
push, and open pull requests in your name. `GH_TOKEN` and `GITHUB_TOKEN` are not
accepted as environment variables, since either would override that sign-in.
For a repository on another host, add a token as an environment variable and
configure a Git credential helper that reads it in the account's machine setup
script.

## Start a sandbox

In a new thread in a project, open the environment picker and choose
**New sandbox · _account_**, then send your message. T3 Code opens the thread
immediately at `/_env/<environmentId>` and buffers turns until the sandbox
finishes booting. First-turn images and composer context are sent into the sandbox
when the thread starts.

- If your project has a remote repository, the sandbox clones that remote onto a
  new branch from the selected base branch. Turn on **Include uncommitted** when
  you want to overlay your uncommitted local changes on top.
- If your project is a local folder on the same host with no remote repository,
  **Local checkout** packs a compressed overlay of that workspace into the
  sandbox automatically.

To work on a repository you have not opened, run **New sandbox from repository**
from the command palette and enter `owner/repo` or a Git URL.

The project's setup scripts in `t3.json` run in the sandbox. Install the tools
they need in the account's machine setup script, or start from a template that
has them.

The owning hub automatically creates internal peer links to each running sandbox,
so an orchestrator thread on the hub (or `delegate_task` with
`isolation: "sandbox"`) can delegate subtasks into isolated sandboxes without
manual pairing steps.

## Portals and persistent runners

Services listening inside a running sandbox can be opened through authenticated
hub **Portals** at `/_env/<environmentId>/portal/<port>/`.

To connect your own always-on Linux or macOS workstation to the hub instead of
spawning ephemeral containers, run `t3 runner start` with a hub address and
pairing token. Runners connect outbound over WebSocket and serve all HTTP,
WebSocket, preview, and portal traffic under `/_env/<environmentId>/...` with
their own local session and device authority.

## Stop, resume, and delete

Archiving a sandbox's last active thread stops the sandbox, and unarchiving one
of its threads resumes it. A sandbox also stops on its own once no agent in it
has worked for its **Stop after inactivity** time. An agent that is running, or
waiting for your answer, counts as working, so a sandbox does not stop in the
middle of a turn. A sandbox set to **Never** runs until you stop it.

A sandbox that stopped on its own is asleep: its threads remain readable from
the hub cache without waking the sandbox. Sending a message in one wakes the
sandbox, queues your command idempotently in the hub inbox, drains it once the
sandbox connects, and splices live events onto open clients. Use **Wake** in the
composer banner if you want to wake a stopped sandbox before sending. A sandbox
you stopped by archiving its last thread is listed in **Settings → Archive**.
Both are listed in **Settings → Sandboxes**, where you can resume them.

The environment that owns the sandbox checks on it about once a minute and stops
it once it has been idle long enough. This has two limits:

- A message sent in the few seconds between that check and the machine stopping
  can be cut off.
- For cloud Boat sandboxes, while the owning environment is offline (such as on a
  laptop that is asleep), Boat stops the sandbox on its own within 10 minutes
  after its stop deadline expires.

**Delete sandbox**, in a sandbox thread's menu or in Settings, destroys the
container or VM, deletes cached hub state and sibling peer links, and removes
its `/_env/<environmentId>` route.

## Access

Hub-managed sandboxes terminate client sessions, DPoP proofs, and pairing links
at the owning hub server, while self-hosted runners (`t3 runner start`) retain
their own local session authority. Revoking a client session on the hub closes
its active sandbox WebSockets immediately and rejects further requests, without
needing to wake the sandbox. Delete a sandbox to destroy the machine and all
threads inside it.
