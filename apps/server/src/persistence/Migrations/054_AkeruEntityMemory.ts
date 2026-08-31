import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE akeru_memory_revisions (
      memory_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (
        scope IN ('user', 'bot-user', 'bot', 'project', 'group', 'workspace', 'thread')
      ),
      partition_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (
        entity_kind IN ('user', 'bot', 'person', 'project', 'group', 'workspace', 'other')
      ),
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN ('fact', 'preference', 'identity', 'relationship', 'routine', 'instruction')
      ),
      value_json TEXT NOT NULL,
      fact_text TEXT NOT NULL CHECK (length(trim(fact_text)) > 0),
      source_thread_id TEXT,
      source_message_id TEXT,
      author_bot_id TEXT,
      initiating_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      updated_at TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved', 'rejected')),
      supersedes_id TEXT REFERENCES akeru_memory_revisions(memory_id),
      superseded_by_id TEXT,
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
      deletion_state TEXT NOT NULL CHECK (deletion_state IN ('active', 'tombstoned', 'deleted')),
      pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
      sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
      affected_bot_ids_json TEXT NOT NULL,
      UNIQUE (tenant_id, root_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX idx_akeru_memory_partition_current
    ON akeru_memory_revisions (
      tenant_id,
      scope,
      partition_id,
      approval_state,
      deletion_state,
      superseded_by_id
    )
  `;
  yield* sql`
    CREATE INDEX idx_akeru_memory_entity_current
    ON akeru_memory_revisions (tenant_id, entity_kind, entity_id, superseded_by_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_akeru_memory_one_current_revision
    ON akeru_memory_revisions (tenant_id, root_id)
    WHERE superseded_by_id IS NULL
  `;
  yield* sql`
    CREATE INDEX idx_akeru_memory_source_thread
    ON akeru_memory_revisions (source_thread_id)
  `;

  yield* sql`
    CREATE TABLE akeru_memory_derived_copies (
      tenant_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, root_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_akeru_memory_derived_copies_thread
    ON akeru_memory_derived_copies (thread_id)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE akeru_memory_fts USING fts5(
      memory_id UNINDEXED,
      fact_text,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;

  yield* sql`
    CREATE TRIGGER akeru_memory_fts_insert
    AFTER INSERT ON akeru_memory_revisions
    WHEN NEW.approval_state = 'approved'
      AND NEW.deletion_state = 'active'
      AND NEW.superseded_by_id IS NULL
    BEGIN
      INSERT INTO akeru_memory_fts(memory_id, fact_text)
      VALUES (NEW.memory_id, NEW.fact_text);
    END
  `;

  yield* sql`
    CREATE TRIGGER akeru_memory_fts_update
    AFTER UPDATE ON akeru_memory_revisions
    BEGIN
      DELETE FROM akeru_memory_fts WHERE memory_id = OLD.memory_id;
      INSERT INTO akeru_memory_fts(memory_id, fact_text)
      SELECT NEW.memory_id, NEW.fact_text
      WHERE NEW.approval_state = 'approved'
        AND NEW.deletion_state = 'active'
        AND NEW.superseded_by_id IS NULL;
    END
  `;

  yield* sql`
    CREATE TRIGGER akeru_memory_fts_delete
    AFTER DELETE ON akeru_memory_revisions
    BEGIN
      DELETE FROM akeru_memory_fts WHERE memory_id = OLD.memory_id;
    END
  `;
});
