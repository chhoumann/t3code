import * as Base64 from "effect/encoding/Base64";

/**
 * Renders the script a sandbox machine runs once at creation to become a T3
 * environment. Paths live under /home/user because Boat wipes /tmp on resume
 * and leaves ~/.cache out of snapshots.
 */
const SANDBOX_HOME = "/home/user";
export const SANDBOX_T3_HOME = `${SANDBOX_HOME}/.t3`;
export const SANDBOX_T3_PORT = 3773;
/** Account env, loaded by the T3 service. The owner writes it; the script makes it 0600. */
export const SANDBOX_ENV_FILE = `${SANDBOX_T3_HOME}/sandbox.env`;
/** Owner uploads (env, server tarball) land here. */
export const SANDBOX_INPUTS_DIR = `${SANDBOX_T3_HOME}/sandbox`;
/** Written by the owner last, once every input is in place. */
export const SANDBOX_INPUTS_READY_FILE = `${SANDBOX_INPUTS_DIR}/inputs-ready`;
/** Stable path to the installed `t3`, for exec calls such as minting sessions. */
export const SANDBOX_T3_BIN = `${SANDBOX_T3_HOME}/bin/t3`;

const SERVICE_DROP_IN_DIR = `${SANDBOX_HOME}/.config/systemd/user/t3code.service.d`;
const INPUTS_WAIT_SECONDS = 900;
const SERVER_START_WAIT_SECONDS = 120;

export type SandboxT3Source =
  /** A published release, installed by `t3 service install` itself. */
  | { readonly kind: "npm"; readonly version: string }
  /**
   * An unreleased build: an npm-packed bundle the owner uploaded. It is
   * placed in the pinned-runtime slot for its version, where `t3 service
   * install` finds it already present instead of downloading a release.
   */
  | { readonly kind: "tarball"; readonly version: string; readonly path: string };

export interface SandboxBootSpec {
  readonly source: SandboxT3Source;
  /** The account's machine setup script, run before T3 with the account env loaded. */
  readonly machineSetupScript: string | null;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function renderInstall(source: SandboxT3Source): ReadonlyArray<string> {
  const runtime = `"$T3CODE_HOME/runtime/versions/"${quote(source.version)}`;
  if (source.kind === "npm") {
    return [
      `npx --yes ${quote(`t3@${source.version}`)} service install`,
      `ln -sfn ${runtime}/t3 ${quote(SANDBOX_T3_BIN)}`,
    ];
  }
  return [
    `RUNTIME=${runtime}`,
    `if [ ! -f "$RUNTIME/.install-complete" ]; then`,
    `  STAGING="$T3CODE_HOME/runtime/versions/.staging-sandbox"`,
    `  rm -rf "$STAGING" && mkdir -p "$STAGING"`,
    `  tar -xzf ${quote(source.path)} -C "$STAGING" --strip-components=1`,
    `  (cd "$STAGING" && npm install --omit=dev --no-audit --no-fund --no-package-lock)`,
    `  NODE_BIN="$(command -v node)"`,
    `  printf '#!/bin/sh\\nexec %s "$(dirname "$(readlink -f "$0")")/dist/bin.mjs" "$@"\\n' "$NODE_BIN" > "$STAGING/t3"`,
    `  chmod 755 "$STAGING/t3"`,
    `  printf '%s\\n' ${quote(source.version)} > "$STAGING/.install-complete"`,
    `  rm -rf "$RUNTIME" && mv "$STAGING" "$RUNTIME"`,
    `fi`,
    `rm -f ${quote(source.path)}`,
    `"$RUNTIME/t3" service install`,
    `ln -sfn "$RUNTIME/t3" ${quote(SANDBOX_T3_BIN)}`,
  ];
}

export function renderSandboxBootScript(spec: SandboxBootSpec): string {
  const machineSetup =
    spec.machineSetupScript === null
      ? []
      : [
          `printf '%s' ${quote(Base64.encode(spec.machineSetupScript))} | base64 -d > ${quote(`${SANDBOX_INPUTS_DIR}/machine-setup.sh`)}`,
          `(set -a && . ${quote(SANDBOX_ENV_FILE)} && set +a && bash ${quote(`${SANDBOX_INPUTS_DIR}/machine-setup.sh`)})`,
        ];
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    `export T3CODE_HOME=${quote(SANDBOX_T3_HOME)}`,
    `mkdir -p ${quote(SANDBOX_INPUTS_DIR)} "$T3CODE_HOME/bin" ${quote(SERVICE_DROP_IN_DIR)}`,
    "",
    `for _ in $(seq 1 ${INPUTS_WAIT_SECONDS}); do [ -f ${quote(SANDBOX_INPUTS_READY_FILE)} ] && break; sleep 1; done`,
    `[ -f ${quote(SANDBOX_INPUTS_READY_FILE)} ] || { echo "Timed out waiting for the sandbox inputs." >&2; exit 1; }`,
    `touch ${quote(SANDBOX_ENV_FILE)} && chmod 600 ${quote(SANDBOX_ENV_FILE)}`,
    ...machineSetup,
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
    "",
    `cat > ${quote(`${SERVICE_DROP_IN_DIR}/sandbox.conf`)} <<'EOF'`,
    "[Service]",
    "Environment=T3CODE_HOST=0.0.0.0",
    `Environment=T3CODE_PORT=${SANDBOX_T3_PORT}`,
    `EnvironmentFile=${SANDBOX_ENV_FILE}`,
    // The machine's own Boat token must not reach agents running under T3.
    "UnsetEnvironment=ASCII_TOKEN",
    "EOF",
    ...renderInstall(spec.source),
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
