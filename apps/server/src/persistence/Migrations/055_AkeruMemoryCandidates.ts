import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE akeru_memory_candidates (
      candidate_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      initiating_user_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_message_id TEXT,
      author_bot_id TEXT,
      fact_text TEXT NOT NULL CHECK (length(trim(fact_text)) > 0),
      target_scope TEXT NOT NULL CHECK (
        target_scope IN ('private', 'bot', 'project', 'group', 'workspace')
      ),
      sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      affected_bot_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_memory_root_id TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_akeru_memory_candidates_thread_status
    ON akeru_memory_candidates (tenant_id, source_thread_id, status, created_at)
  `;

  yield* sql`
    CREATE TABLE akeru_memory_decision_receipts (
      receipt_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES akeru_memory_candidates(candidate_id),
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
      fact_text TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      affected_bot_ids_json TEXT NOT NULL,
      memory_root_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_akeru_memory_candidate_one_decision
    ON akeru_memory_decision_receipts (tenant_id, candidate_id)
  `;
});
