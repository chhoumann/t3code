import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sandboxes ADD COLUMN provider_http_url TEXT`;
  yield* sql`ALTER TABLE sandboxes ADD COLUMN first_boot_at INTEGER`;
  yield* sql`ALTER TABLE sandboxes ADD COLUMN overlay_archive BLOB`;
  yield* sql`
    UPDATE sandboxes
    SET first_boot_at = updated_at
    WHERE environment_id IS NOT NULL AND first_boot_at IS NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_fleet_nodes (
      environment_id TEXT PRIMARY KEY,
      sandbox_id TEXT UNIQUE,
      node_kind TEXT NOT NULL,
      auth_mode TEXT NOT NULL,
      node_secret_hash TEXT NOT NULL,
      node_secret_plain TEXT,
      mesh_ip TEXT NOT NULL,
      slug TEXT NOT NULL,
      exposed_ports_json TEXT NOT NULL DEFAULT '[]',
      descriptor_json TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_fleet_grants (
      grant_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_fleet_grants_env
    ON sandbox_fleet_grants (environment_id, expires_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_fleet_sessions (
      session_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      jwk_json TEXT NOT NULL,
      proof_thumbprint TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      client_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_fleet_sessions_env
    ON sandbox_fleet_sessions (environment_id, revoked_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_projection_cache (
      environment_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (environment_id, cache_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      environment_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE (environment_id, idempotency_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_inbox_pending
    ON sandbox_inbox (environment_id, delivered_at, seq)
  `;
});
