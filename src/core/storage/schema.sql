-- Mnemium SQLite schema — FROZEN CONTRACT (relational + FTS5).
-- Vector tables are created PROGRAMMATICALLY by the VectorIndex impl, one per
-- embedding model (tagged by model id, dim-specific) so an embedder swap is a
-- background re-embed + cutover — they are intentionally NOT in this static schema.
-- PRAGMA user_version is the migration counter.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;

-- key/value: active embedder id, schema bookkeeping, bandit weights blob, etc.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document (
  id           TEXT PRIMARY KEY,
  source_type  TEXT NOT NULL,
  provider     TEXT,
  uri          TEXT,
  title        TEXT,
  scope_uri    TEXT NOT NULL,
  captured_at  INTEGER NOT NULL,
  raw_content  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_scope ON document(scope_uri, captured_at);

CREATE TABLE IF NOT EXISTS chunk (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunk(document_id, ord);

CREATE TABLE IF NOT EXISTS memory (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,                 -- fact|preference|episode|task|identity
  content          TEXT NOT NULL,
  scope_uri        TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  is_latest        INTEGER NOT NULL DEFAULT 1,    -- 0/1
  parent_memory_id TEXT,
  root_memory_id   TEXT,
  is_static        INTEGER NOT NULL DEFAULT 0,
  is_inference     INTEGER NOT NULL DEFAULT 0,
  confidence       REAL NOT NULL DEFAULT 0.5,
  event_date       INTEGER,
  document_date    INTEGER,
  valid_from       INTEGER,
  valid_to         INTEGER,
  forget_after     INTEGER,
  forget_reason    TEXT,
  is_forgotten     INTEGER NOT NULL DEFAULT 0,
  reuse_count      INTEGER NOT NULL DEFAULT 0,
  source_count     INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  -- trust fields (v2): evidence-bound extraction + claim lifecycle
  evidence         TEXT,                          -- verbatim source span backing the claim
  speaker          TEXT,                          -- user|assistant — who said the evidence
  support_kind     TEXT,                          -- exact|paraphrase|inferred
  claim_status     TEXT NOT NULL DEFAULT 'active' -- active|pending_review (rejected lives in memory_rejection)
);
-- typed-retrieval scoping; version-chain rebuild; active-set + expiry sweep
CREATE INDEX IF NOT EXISTS idx_memory_scope_type ON memory(scope_uri, type, is_latest);
CREATE INDEX IF NOT EXISTS idx_memory_chain      ON memory(root_memory_id, version);
CREATE INDEX IF NOT EXISTS idx_memory_active      ON memory(scope_uri, is_latest, forget_after);
CREATE INDEX IF NOT EXISTS idx_memory_claim       ON memory(claim_status);

-- Validator audit trail. Rejected candidates are NOT memories — keeping them
-- out of `memory` means no retrieval/export/supersede path can leak them by
-- a missed claim_status filter. This table is append-only and UI-facing
-- ("why was this dropped?"), never searched by retrieval.
CREATE TABLE IF NOT EXISTS memory_rejection (
  id           TEXT PRIMARY KEY,
  scope_uri    TEXT NOT NULL,
  provider     TEXT,
  thread_id    TEXT,
  message_id   TEXT,
  type         TEXT,
  content      TEXT NOT NULL,
  evidence     TEXT,
  speaker      TEXT,
  support_kind TEXT,
  reason       TEXT NOT NULL,                     -- validator rule that fired
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejection_scope ON memory_rejection(scope_uri, created_at);

-- M:N corroboration link (one chunk -> many memories; one memory <- many chunks)
CREATE TABLE IF NOT EXISTS memory_source (
  memory_id    TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  chunk_id     TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  document_id  TEXT NOT NULL,
  relevance    REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (memory_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS entity (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  scope_uri       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_norm ON entity(normalized_name);

CREATE TABLE IF NOT EXISTS memory_entity (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE IF NOT EXISTS edge (
  id            TEXT PRIMARY KEY,
  src_memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  dst_memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,                    -- about|co_occurs|supersedes|invalidates|derives
  weight        REAL NOT NULL DEFAULT 1.0,
  computed_by   TEXT NOT NULL DEFAULT 'eager',    -- eager|lazy|llm
  confidence    REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(src_memory_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst_memory_id, type);

-- audit: references only, anchored to provider message id
CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  scope_uri   TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  injected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_thread ON ledger(thread_id, injected_at);

-- FTS5 for lexical/hybrid search. External-content tables mirror memory/chunk; keep
-- in sync via triggers. Hybrid retrieval = vec (sqlite-vec) + bm25(fts) + typed filter.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory USING fts5(content, content='memory', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunk  USING fts5(text,    content='chunk',  content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO fts_memory(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO fts_memory(fts_memory, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO fts_memory(fts_memory, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO fts_memory(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO fts_chunk(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO fts_chunk(fts_chunk, rowid, text) VALUES('delete', old.rowid, old.text);
END;
