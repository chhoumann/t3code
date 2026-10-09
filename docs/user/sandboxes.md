# Sandboxes

A sandbox is a cloud machine that runs its own T3 Code server for one task.
Your T3 Code environment creates the machine, clones your project onto a new
branch there, and starts a thread with your message. Sandboxes run on
[Boat](https://boat.dev).

## Add an account

Open **Settings → Sandboxes** and choose **Add account**. Paste a Boat API key.
T3 Code checks that the key can create, read, stop, resume, and delete
sandboxes, run commands, write files, and host ports before it saves the
account. The key and any environment variable values stay in that
environment's secret store, not in its settings. You can add more than one
account, such as a personal and a work account.

Environment variables reach T3 Code and the agents in the sandbox, so this is
where a provider API key goes. Mark a variable **Setup only** to give it to the
machine setup script alone and keep it out of the agents' environment. This is
not a hard boundary: the sandbox's user has passwordless `sudo` and can read the
file that holds it.

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
of its threads resumes it. A sandbox also stops on its own after the account's
**Stop after** time. Stopped sandboxes are listed in **Settings → Archive**.

**Delete sandbox**, in a sandbox thread's menu or in Settings, destroys the
machine and everything on it, including its threads.

## Access

A sandbox's T3 Code server has a public address on Boat and requires T3 Code
sign-in, which devices get by pairing through the owning environment.
Revoking a device on the owning environment does not end the sessions it
already holds in its sandboxes. Delete a sandbox to cut off every device's
access to it.
