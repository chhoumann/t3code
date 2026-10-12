# Sandboxes

A sandbox is a cloud machine that runs its own T3 Code server for one task.
Your T3 Code environment creates the machine, clones your project onto a new
branch there, and starts a thread with your message. Sandboxes run on
[Boat](https://boat.dev).

## Add an account

Open **Settings → Sandboxes** and choose **Add account**. Paste a Boat API key.
T3 Code checks that the key can create, read, stop, resume, and delete
sandboxes, run commands, write files, and host ports before it saves the
account. The key must also be allowed to update sandboxes, so T3 Code can push
back Boat's own stop time while agents work. The key and any environment
variable values stay in that environment's secret store, not in its settings.
You can add more than one account, such as a personal and a work account.

In the project's settings, use **Sandboxes** to choose a template for each
account. The template menu lists the selected account's ready Boat snapshots.
You can also override the account's machine size and stop time there.
These defaults apply to new sandboxes for every checkout of that repository.
Reset them to use the account defaults and start without a template.

Environment variables reach T3 Code and the agents in the sandbox, so this is
where a provider API key goes. Mark a variable **Setup only** to give it to the
machine setup script alone and keep it out of the agents' environment. This is
not a hard boundary: the sandbox's user has passwordless `sudo` and can read the
file that holds it.

The sandbox clones your project itself, so it needs its own access to private
repositories. For an HTTPS remote, add a token as an environment variable and
configure a Git credential helper that reads it in the account's machine setup
script. An SSH remote needs a key set up the same way.

## Start a sandbox

In a new thread in a project, open the environment picker and choose
**New sandbox · _account_**, then send your message. The sandbox starts from
the commit your branch has pushed, so commit and push first: uncommitted or
unpushed work is not included. The first message cannot carry attachments or
context.

Every device connected to the environment that owns the sandbox pairs with it
automatically.

## Stop, resume, and delete

Archiving a sandbox's last active thread stops the sandbox, and unarchiving one
of its threads resumes it. A sandbox also stops on its own once no agent in it
has worked for its **Stop after inactivity** time. An agent that is running, or
waiting for your answer, counts as working, so a sandbox does not stop in the
middle of a turn. A sandbox set to **Never** runs until you stop it. Stopped
sandboxes, including ones that stopped on their own, are listed in
**Settings → Archive** and **Settings → Sandboxes**, where you can resume them.

The environment that owns the sandbox checks on it about once a minute and stops
it once it has been idle long enough. This has two limits:

- A message sent in the few seconds between that check and the machine stopping
  can be cut off.
- While the owning environment is offline, such as on a laptop that is asleep,
  Boat stops the sandbox on its own, even in the middle of a turn. It does so
  within 10 minutes after the stop time runs out, counted from the last agent
  activity the owning environment saw, and no sooner than 40 minutes after the
  sandbox started or resumed.

**Delete sandbox**, in a sandbox thread's menu or in Settings, destroys the
machine and everything on it, including its threads.

## Access

A sandbox's T3 Code server has a public address on Boat and requires T3 Code
sign-in, which devices get by pairing through the owning environment.
Revoking a device on the owning environment does not end the sessions it
already holds in its sandboxes. Delete a sandbox to cut off every device's
access to it.
