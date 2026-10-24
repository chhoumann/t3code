import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Owned by SandboxService. Commands write desired and desired_revision; the
  // reconciler writes every other column after the insert. Times are epoch ms.
  yield* sql`
    CREATE TABLE IF NOT EXISTS sandboxes (
      sandbox_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      seed_json TEXT NOT NULL,
      desired TEXT NOT NULL,
      desired_revision INTEGER NOT NULL,
      status_json TEXT NOT NULL,
      settled_revision INTEGER NOT NULL,
      inflight_json TEXT,
      create_key TEXT NOT NULL,
      create_first_attempt_at INTEGER,
      machine_id TEXT,
      http_base_url TEXT,
      environment_id TEXT,
      running_since INTEGER,
      inputs_written_at INTEGER,
      credentials_stale INTEGER NOT NULL,
      seed_launched_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
