import * as Schema from "effect/Schema";

/**
 * Renders what a sandbox machine runs to become a T3 environment: the script
 * it runs once at creation, the account env file, and the command that
 * refreshes the account env on a later boot. Paths live under /home/user
 * because Boat keeps only /home/user and /etc across stop and resume, wipes
 * /tmp, and leaves ~/.cache out of snapshots.
 */
const SANDBOX_HOME = "/home/user";
export const SANDBOX_T3_HOME = `${SANDBOX_HOME}/.t3`;
export const SANDBOX_T3_PORT = 3773;
/** Account env, loaded by the T3 service and the machine setup unit. */
export const SANDBOX_ENV_FILE = `${SANDBOX_T3_HOME}/sandbox.env`;
/** Owner uploads (env, setup script, server tarball) land here. */
const SANDBOX_INPUTS_DIR = `${SANDBOX_T3_HOME}/sandbox`;
/**
 * Setup-only account env, loaded by the machine setup unit alone so agents
 * under T3 never inherit it. Agents can still read the file; it keeps values
 * out of their environment, not out of their reach.
 */
export const SANDBOX_SETUP_ENV_FILE = `${SANDBOX_INPUTS_DIR}/setup.env`;
/** The account's machine setup script, run by a system unit on every boot. */
export const SANDBOX_MACHINE_SETUP_SCRIPT = `${SANDBOX_INPUTS_DIR}/machine-setup.sh`;
/** Where the owner uploads an unreleased server build. */
export const SANDBOX_T3_TARBALL = `${SANDBOX_INPUTS_DIR}/t3.tgz`;
/** Tells the guest server which owner manages it; see `ManagedSandbox`. Relative to T3 home. */
export const MANAGED_SANDBOX_FILE = "sandbox/managed.json";
export const SANDBOX_MANAGED_FILE = `${SANDBOX_T3_HOME}/${MANAGED_SANDBOX_FILE}`;
/**
 * Written by the owner last, once every input is in place. It holds the
 * sandbox id, since a machine made from a template snapshot of an earlier
 * sandbox already has that sandbox's.
 */
export const SANDBOX_INPUTS_READY_FILE = `${SANDBOX_INPUTS_DIR}/inputs-ready`;
/**
 * Held by the clone and the credential refresh, so one replayed while its
 * first run still goes waits for it and then finds the work done. The kernel
 * releases it when the holder dies, however it dies.
 */
const SANDBOX_EXEC_LOCK = `${SANDBOX_INPUTS_DIR}/exec.lock`;
/** Everything the boot script prints, kept for diagnosing a failed boot. */
export const SANDBOX_BOOT_LOG = `${SANDBOX_INPUTS_DIR}/boot.log`;
/** Stable path to the installed `t3`, for exec calls such as minting sessions. */
export const SANDBOX_T3_BIN = `${SANDBOX_T3_HOME}/bin/t3`;
/** Staged by the owner, then swapped in by the refresh command. */
export const SANDBOX_STAGED_ENV_FILE = `${SANDBOX_INPUTS_DIR}/sandbox.env.next`;
export const SANDBOX_STAGED_SETUP_ENV_FILE = `${SANDBOX_INPUTS_DIR}/setup.env.next`;
export const SANDBOX_STAGED_MACHINE_SETUP_SCRIPT = `${SANDBOX_INPUTS_DIR}/machine-setup.sh.next`;
/** Holds the owner's GitHub token only between its upload and the `gh auth login` that reads it. */
export const SANDBOX_GITHUB_TOKEN_FILE = `${SANDBOX_INPUTS_DIR}/github-token`;
/** Where `gh` keeps the login the owner delivers; a template snapshot carries the earlier sandbox's. */
const GH_CONFIG_DIR = `${SANDBOX_HOME}/.config/gh`;

const SERVICE_DROP_IN_DIR = `${SANDBOX_HOME}/.config/systemd/user/t3code.service.d`;
const MACHINE_SETUP_UNIT = "t3-sandbox-machine-setup.service";
const MACHINE_SETUP_LOG = `${SANDBOX_INPUTS_DIR}/machine-setup.log`;
const INPUTS_WAIT_SECONDS = 900;
const SERVER_START_WAIT_SECONDS = 120;

export const SandboxT3Source = Schema.Struct({
  /**
   * `npm` installs a published release through `t3 service install` itself.
   * `tarball` installs an unreleased build the owner uploaded: the server
   * bundle beside its Linux runtime node_modules, laid out like a release
   * archive but run by the machine's Node. It is placed in the pinned-runtime
   * slot for its version, where `t3 service install` finds it instead of
   * downloading.
   */
  kind: Schema.Literals(["npm", "tarball"]),
  version: Schema.String,
});
export type SandboxT3Source = typeof SandboxT3Source.Type;

/** Single-quotes a value for bash. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Takes the exec lock for the rest of the command. A command that may leave
 * a process behind (git's credential cache daemon, say) runs with
 * `CLOSE_EXEC_LOCK`, or that process holds the lock after the command ends.
 */
export const SANDBOX_EXEC_LOCK_LINES: ReadonlyArray<string> = [
  `exec 9>>${shellQuote(SANDBOX_EXEC_LOCK)}`,
  "flock 9",
];
export const CLOSE_EXEC_LOCK = "9>&-";

/**
 * One `NAME="value"` line per variable. Double quotes with `\ " $ \`` escaped
 * read back identically through systemd's EnvironmentFile and bash's `.`,
 * line breaks included.
 */
export function renderSandboxEnvFile(
  env: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  return env
    .map(({ name, value }) => `${name}="${value.replaceAll(/[\\"$`]/g, (char) => `\\${char}`)}"\n`)
    .join("");
}

function renderInstall(source: SandboxT3Source): ReadonlyArray<string> {
  const runtime = `"$T3CODE_HOME/runtime/versions/"${shellQuote(source.version)}`;
  if (source.kind === "npm") {
    return [
      `npx --yes ${shellQuote(`t3@${source.version}`)} service install`,
      `ln -sfn ${runtime}/t3 ${shellQuote(SANDBOX_T3_BIN)}`,
    ];
  }
  return [
    `RUNTIME=${runtime}`,
    `if [ ! -f "$RUNTIME/.install-complete" ]; then`,
    `  STAGING="$T3CODE_HOME/runtime/versions/.staging-sandbox"`,
    `  rm -rf "$STAGING" && mkdir -p "$STAGING"`,
    `  tar -xzf ${shellQuote(SANDBOX_T3_TARBALL)} -C "$STAGING" --strip-components=1`,
    `  NODE_BIN="$(command -v node)"`,
    `  printf '#!/bin/sh\\nexec %s "$(dirname "$(readlink -f "$0")")/dist/bin.mjs" "$@"\\n' "$NODE_BIN" > "$STAGING/t3"`,
    `  chmod 755 "$STAGING/t3"`,
    `  printf '%s\\n' ${shellQuote(source.version)} > "$STAGING/.install-complete"`,
    `  rm -rf "$RUNTIME" && mv "$STAGING" "$RUNTIME"`,
    `fi`,
    `rm -f ${shellQuote(SANDBOX_T3_TARBALL)}`,
    `"$RUNTIME/t3" service install`,
    `ln -sfn "$RUNTIME/t3" ${shellQuote(SANDBOX_T3_BIN)}`,
  ];
}

/**
 * Boat keeps /etc but not /var/lib across stop and resume, so state the
 * account's setup creates there (a Tailscale login, say) is gone after a
 * resume. A system unit re-runs the setup on every boot, ordered before the
 * user manager that starts T3. A failing setup still lets T3 start.
 */
function renderMachineSetupUnit(): ReadonlyArray<string> {
  return [
    `sudo tee /etc/systemd/system/${MACHINE_SETUP_UNIT} >/dev/null <<EOF`,
    "[Unit]",
    "Description=T3 sandbox machine setup",
    "Wants=network-online.target",
    "After=network-online.target",
    "Before=user@$(id -u).service",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "User=$(id -un)",
    `EnvironmentFile=${SANDBOX_ENV_FILE}`,
    `EnvironmentFile=${SANDBOX_SETUP_ENV_FILE}`,
    `ExecStart=/bin/bash ${SANDBOX_MACHINE_SETUP_SCRIPT}`,
    `StandardOutput=append:${MACHINE_SETUP_LOG}`,
    `StandardError=append:${MACHINE_SETUP_LOG}`,
    // Leaves room in Boat's 600-second exec for the refresh command that restarts this unit.
    "TimeoutStartSec=540",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "sudo systemctl daemon-reload",
    `sudo systemctl enable ${MACHINE_SETUP_UNIT}`,
    // A template snapshot's unit already ran at boot, with the earlier sandbox's inputs.
    `sudo systemctl restart ${MACHINE_SETUP_UNIT}`,
  ];
}

/**
 * Installs the GitHub CLI from GitHub's apt repository when the image lacks
 * it. Agents push and open pull requests through it, and git reaches GitHub
 * through its credential helper, with the login the owner delivers.
 */
function renderGitHubCliInstall(): ReadonlyArray<string> {
  const keyring = "/etc/apt/keyrings/githubcli-archive-keyring.gpg";
  const sources = "/etc/apt/sources.list.d/github-cli.list";
  return [
    "if ! command -v gh >/dev/null; then",
    "  sudo mkdir -p -m 755 /etc/apt/keyrings",
    `  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee ${keyring} >/dev/null`,
    `  echo "deb [arch=$(dpkg --print-architecture) signed-by=${keyring}] https://cli.github.com/packages stable main" | sudo tee ${sources} >/dev/null`,
    // Written under this script's umask, which apt's unprivileged fetcher could not read.
    `  sudo chmod 644 ${keyring} ${sources}`,
    "  sudo apt-get update -qq",
    "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh",
    "fi",
  ];
}

/** Whether the owner has written this sandbox's inputs. */
export const renderInputsReadyTest = (sandboxId: string) =>
  `[ "$(cat ${shellQuote(SANDBOX_INPUTS_READY_FILE)} 2>/dev/null)" = ${shellQuote(sandboxId)} ]`;

export function renderSandboxBootScript(input: {
  readonly t3: SandboxT3Source;
  readonly sandboxId: string;
  /** What every client calls this environment; T3 reads it from the pretty hostname. */
  readonly label: string;
}): string {
  const inputsReady = renderInputsReadyTest(input.sandboxId);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    `export T3CODE_HOME=${shellQuote(SANDBOX_T3_HOME)}`,
    `mkdir -p ${shellQuote(SANDBOX_INPUTS_DIR)} "$T3CODE_HOME/bin" ${shellQuote(SERVICE_DROP_IN_DIR)}`,
    `exec > >(tee -a ${shellQuote(SANDBOX_BOOT_LOG)}) 2> >(tee -a ${shellQuote(SANDBOX_BOOT_LOG)} >&2)`,
    "set -x",
    "",
    // A template snapshot of an earlier sandbox carries that sandbox's T3 data, environment id
    // and sessions included, and starts its T3 at boot. This sandbox starts T3 afresh on the
    // installed runtime, which the snapshot keeps to save the install. The snapshot's GitHub
    // login goes the same way: the owner signs this sandbox in with its own token.
    'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user stop t3code.service 2>/dev/null || true',
    'rm -rf "$T3CODE_HOME/userdata"',
    `rm -rf ${shellQuote(GH_CONFIG_DIR)}`,
    "",
    `for _ in $(seq 1 ${INPUTS_WAIT_SECONDS}); do ${inputsReady} && break; sleep 1; done`,
    `${inputsReady} || { echo "Timed out waiting for the sandbox inputs." >&2; exit 1; }`,
    `chmod 600 ${shellQuote(SANDBOX_ENV_FILE)} ${shellQuote(SANDBOX_SETUP_ENV_FILE)}`,
    "",
    // Dev servers and T3's own file watching exhaust the stock inotify limits,
    // and Boat caps user.slice swap at zero although the VM has a swapfile.
    "sudo tee /etc/sysctl.d/90-t3-sandbox.conf >/dev/null <<'EOF'",
    "fs.inotify.max_user_watches = 524288",
    "fs.inotify.max_user_instances = 1024",
    "EOF",
    "sudo sysctl -q --system",
    "sudo systemctl set-property user.slice MemorySwapMax=infinity",
    `sudo hostnamectl set-hostname --pretty ${shellQuote(input.label)}`,
    "sudo loginctl enable-linger user",
    ...renderGitHubCliInstall(),
    ...renderMachineSetupUnit(),
    "",
    `cat > ${shellQuote(`${SERVICE_DROP_IN_DIR}/sandbox.conf`)} <<'EOF'`,
    "[Service]",
    "Environment=T3CODE_HOST=0.0.0.0",
    `Environment=T3CODE_PORT=${SANDBOX_T3_PORT}`,
    // Agents in the sandbox read the service log; a live admin pairing token must not be in it.
    "Environment=T3CODE_NO_STARTUP_PAIRING=true",
    `EnvironmentFile=${SANDBOX_ENV_FILE}`,
    // The machine's own Boat token must not reach agents running under T3.
    "UnsetEnvironment=ASCII_TOKEN",
    "EOF",
    ...renderInstall(input.t3),
    "",
    `for _ in $(seq 1 ${SERVER_START_WAIT_SECONDS}); do`,
    `  curl -fsS -o /dev/null http://127.0.0.1:${SANDBOX_T3_PORT}/.well-known/t3/environment && exit 0`,
    "  sleep 1",
    "done",
    'echo "T3 did not start." >&2',
    "exit 1",
    "",
  ].join("\n");
}

/** Left by a refresh that changed a file, until the restart it calls for has run. */
const SETUP_RESTART_PENDING = `${SANDBOX_INPUTS_DIR}/restart-setup.pending`;
const T3_RESTART_PENDING = `${SANDBOX_INPUTS_DIR}/restart-t3.pending`;

/**
 * Swaps the staged env files and setup script in after a resume and re-runs
 * the setup unit when any of them changed. T3 itself is not restarted here:
 * Boat resumes a machine from memory, so its agents are mid-work, and the
 * owner runs `renderRestartServerCommand` once they are idle. A change marks
 * its restart pending before the swap, so a refresh cut short still reports
 * it on the next one even though the files then match.
 * Prints `setup_restarted=0|1 t3_restart_pending=0|1`.
 */
export function renderRefreshCredentialsCommand(): string {
  // A staged file a replayed refresh finds gone was swapped in by the first run.
  const swap = (staged: string, target: string, pending: ReadonlyArray<string>) => [
    `if [ ! -e ${shellQuote(staged)} ]; then :;`,
    `elif cmp -s ${shellQuote(staged)} ${shellQuote(target)}; then rm -f ${shellQuote(staged)};`,
    `else touch ${pending.map(shellQuote).join(" ")} && chmod 600 ${shellQuote(staged)} && mv -f ${shellQuote(staged)} ${shellQuote(target)}; fi`,
  ];
  return [
    "set -euo pipefail",
    ...SANDBOX_EXEC_LOCK_LINES,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    ...swap(SANDBOX_STAGED_ENV_FILE, SANDBOX_ENV_FILE, [SETUP_RESTART_PENDING, T3_RESTART_PENDING]),
    ...swap(SANDBOX_STAGED_SETUP_ENV_FILE, SANDBOX_SETUP_ENV_FILE, [SETUP_RESTART_PENDING]),
    ...swap(SANDBOX_STAGED_MACHINE_SETUP_SCRIPT, SANDBOX_MACHINE_SETUP_SCRIPT, [
      SETUP_RESTART_PENDING,
    ]),
    "setup_restarted=0",
    "setup_failed=0",
    "t3_restart_pending=0",
    // A failed setup fails the refresh. Its marker stays, so the refresh a Retry runs re-runs it.
    `if [ -e ${shellQuote(SETUP_RESTART_PENDING)} ]; then`,
    `  if sudo systemctl restart ${MACHINE_SETUP_UNIT} ${CLOSE_EXEC_LOCK}; then`,
    `    rm -f ${shellQuote(SETUP_RESTART_PENDING)} && setup_restarted=1`,
    "  else setup_failed=1; fi",
    "fi",
    `if [ -e ${shellQuote(T3_RESTART_PENDING)} ]; then t3_restart_pending=1; fi`,
    'echo "setup_restarted=$setup_restarted t3_restart_pending=$t3_restart_pending"',
    `if [ "$setup_failed" = 1 ]; then echo "The account's machine setup failed. Its log is ${MACHINE_SETUP_LOG}." >&2; exit 1; fi`,
  ].join("\n");
}

/**
 * Restarts T3 when a refresh left its restart pending, so it loads the env
 * that changed. Run once the guest's agents are idle, since the restart ends
 * their runs. Prints `t3_restarted=0|1`.
 */
export function renderRestartServerCommand(): string {
  return [
    "set -euo pipefail",
    ...SANDBOX_EXEC_LOCK_LINES,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    "t3_restarted=0",
    `if [ -e ${shellQuote(T3_RESTART_PENDING)} ]; then`,
    `  systemctl --user restart t3code.service ${CLOSE_EXEC_LOCK}`,
    `  rm -f ${shellQuote(T3_RESTART_PENDING)} && t3_restarted=1`,
    "fi",
    'echo "t3_restarted=$t3_restarted"',
  ].join("\n");
}

/**
 * Signs the machine in to GitHub as the owner's App user with the token the
 * owner uploaded to `SANDBOX_GITHUB_TOKEN_FILE`, and has git use that login.
 * The token reaches `gh` on stdin only: never as an argument, which agents
 * could read from the process list, and the file goes however the login
 * ends. Commits carry the user's name, and their email when GitHub shows one.
 */
export function renderGitHubLoginCommand(user: {
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
}): string {
  const token = shellQuote(SANDBOX_GITHUB_TOKEN_FILE);
  return [
    "set -euo pipefail",
    ...SANDBOX_EXEC_LOCK_LINES,
    `export HOME=${shellQuote(SANDBOX_HOME)}`,
    // Either variable would make gh ignore the login it is about to store.
    "unset GH_TOKEN GITHUB_TOKEN",
    `trap 'rm -f ${token}' EXIT`,
    `chmod 600 ${token}`,
    `gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage < ${token}`,
    "gh auth setup-git --hostname github.com",
    `git config --global user.name ${shellQuote(user.name ?? user.login)}`,
    ...(user.email === null ? [] : [`git config --global user.email ${shellQuote(user.email)}`]),
  ].join("\n");
}
