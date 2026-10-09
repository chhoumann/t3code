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
export const SANDBOX_INPUTS_DIR = `${SANDBOX_T3_HOME}/sandbox`;
/** The account's machine setup script, run by a system unit on every boot. */
export const SANDBOX_MACHINE_SETUP_SCRIPT = `${SANDBOX_INPUTS_DIR}/machine-setup.sh`;
/** Where the owner uploads an unreleased server build. */
export const SANDBOX_T3_TARBALL = `${SANDBOX_INPUTS_DIR}/t3.tgz`;
/** Written by the owner last, once every input is in place. */
export const SANDBOX_INPUTS_READY_FILE = `${SANDBOX_INPUTS_DIR}/inputs-ready`;
/** Everything the boot script prints, kept for diagnosing a failed boot. */
export const SANDBOX_BOOT_LOG = `${SANDBOX_INPUTS_DIR}/boot.log`;
/** Stable path to the installed `t3`, for exec calls such as minting sessions. */
export const SANDBOX_T3_BIN = `${SANDBOX_T3_HOME}/bin/t3`;
/** Staged by the owner, then swapped in by the refresh command. */
export const SANDBOX_STAGED_ENV_FILE = `${SANDBOX_INPUTS_DIR}/sandbox.env.next`;
export const SANDBOX_STAGED_MACHINE_SETUP_SCRIPT = `${SANDBOX_INPUTS_DIR}/machine-setup.sh.next`;

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
    `ExecStart=/bin/bash ${SANDBOX_MACHINE_SETUP_SCRIPT}`,
    `StandardOutput=append:${MACHINE_SETUP_LOG}`,
    `StandardError=append:${MACHINE_SETUP_LOG}`,
    "TimeoutStartSec=600",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "sudo systemctl daemon-reload",
    `sudo systemctl enable ${MACHINE_SETUP_UNIT}`,
    `sudo systemctl start ${MACHINE_SETUP_UNIT}`,
  ];
}

export function renderSandboxBootScript(source: SandboxT3Source): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    `export T3CODE_HOME=${shellQuote(SANDBOX_T3_HOME)}`,
    `mkdir -p ${shellQuote(SANDBOX_INPUTS_DIR)} "$T3CODE_HOME/bin" ${shellQuote(SERVICE_DROP_IN_DIR)}`,
    `exec > >(tee -a ${shellQuote(SANDBOX_BOOT_LOG)}) 2> >(tee -a ${shellQuote(SANDBOX_BOOT_LOG)} >&2)`,
    "set -x",
    "",
    `for _ in $(seq 1 ${INPUTS_WAIT_SECONDS}); do [ -f ${shellQuote(SANDBOX_INPUTS_READY_FILE)} ] && break; sleep 1; done`,
    `[ -f ${shellQuote(SANDBOX_INPUTS_READY_FILE)} ] || { echo "Timed out waiting for the sandbox inputs." >&2; exit 1; }`,
    `chmod 600 ${shellQuote(SANDBOX_ENV_FILE)}`,
    "",
    // Dev servers and T3's own file watching exhaust the stock inotify limits,
    // and Boat caps user.slice swap at zero although the VM has a swapfile.
    "sudo tee /etc/sysctl.d/90-t3-sandbox.conf >/dev/null <<'EOF'",
    "fs.inotify.max_user_watches = 524288",
    "fs.inotify.max_user_instances = 1024",
    "EOF",
    "sudo sysctl -q --system",
    "sudo systemctl set-property user.slice MemorySwapMax=infinity",
    "sudo loginctl enable-linger user",
    ...renderMachineSetupUnit(),
    "",
    `cat > ${shellQuote(`${SERVICE_DROP_IN_DIR}/sandbox.conf`)} <<'EOF'`,
    "[Service]",
    "Environment=T3CODE_HOST=0.0.0.0",
    `Environment=T3CODE_PORT=${SANDBOX_T3_PORT}`,
    `EnvironmentFile=${SANDBOX_ENV_FILE}`,
    // The machine's own Boat token must not reach agents running under T3.
    "UnsetEnvironment=ASCII_TOKEN",
    "EOF",
    ...renderInstall(source),
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

/**
 * Swaps the staged env file and setup script in after a boot the owner did not
 * script, re-runs the setup unit when either changed, and restarts T3 when its
 * env changed. Prints `env_changed=0|1 setup_changed=0|1`.
 */
export function renderRefreshCredentialsCommand(): string {
  const swap = (staged: string, target: string, flag: string) => [
    `if cmp -s ${shellQuote(staged)} ${shellQuote(target)}; then rm -f ${shellQuote(staged)};`,
    `else chmod 600 ${shellQuote(staged)} && mv -f ${shellQuote(staged)} ${shellQuote(target)} && ${flag}=1; fi`,
  ];
  return [
    "set -euo pipefail",
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    "env_changed=0",
    "setup_changed=0",
    ...swap(SANDBOX_STAGED_ENV_FILE, SANDBOX_ENV_FILE, "env_changed"),
    ...swap(SANDBOX_STAGED_MACHINE_SETUP_SCRIPT, SANDBOX_MACHINE_SETUP_SCRIPT, "setup_changed"),
    `if [ "$env_changed$setup_changed" != 00 ]; then sudo systemctl restart ${MACHINE_SETUP_UNIT} || echo "machine setup failed" >&2; fi`,
    'if [ "$env_changed" = 1 ]; then systemctl --user restart t3code.service; fi',
    'echo "env_changed=$env_changed setup_changed=$setup_changed"',
  ].join("\n");
}
