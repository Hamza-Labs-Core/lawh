-- Lawh data model (D1 / SQLite). Times are Unix milliseconds. IDs are prefixed ULIDs.
-- Every query in checks/query_plans.py must use an index; the check fails on a table scan.

CREATE TABLE projects (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  created_at INTEGER NOT NULL, archived_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider TEXT,
  created_at INTEGER NOT NULL, disabled_at INTEGER
);

-- The secret itself is never stored: only HMAC-SHA256(pepper, secret).
CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_hmac TEXT NOT NULL, scopes_json TEXT NOT NULL,
  all_projects INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER
);
CREATE INDEX agent_keys_agent ON agent_keys(agent_id, created_at);
CREATE TABLE agent_key_projects (
  key_id TEXT NOT NULL REFERENCES agent_keys(id), project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (key_id, project_id)
) WITHOUT ROWID;

CREATE TABLE pages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ar')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','decided','archived')),
  current_version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE (project_id, slug)
);
CREATE INDEX pages_recent ON pages(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_project ON pages(project_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_status ON pages(status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_project_status ON pages(project_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_purge ON pages(deleted_at) WHERE deleted_at IS NOT NULL;

-- sort_at copies pages.updated_at, so a tag's list is read in order from an index.
CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id), tag TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id), sort_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, tag)
) WITHOUT ROWID;
CREATE INDEX page_tags_recent ON page_tags(tag, sort_at DESC, page_id DESC);
CREATE INDEX page_tags_project ON page_tags(project_id, tag, sort_at DESC, page_id DESC);

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  n INTEGER NOT NULL, entry_path TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
  published_by TEXT NOT NULL REFERENCES agents(id), key_id TEXT NOT NULL REFERENCES agent_keys(id),
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, n)
);

-- Files are stored once per content. r2_key is blobs/<sha256>/<ulid>: never reused, so cleanup
-- of an old object can't delete one uploaded again at the same moment.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, unreferenced_at INTEGER
);
CREATE INDEX blobs_gc ON blobs(unreferenced_at) WHERE unreferenced_at IS NOT NULL;
CREATE TABLE version_files (
  version_id TEXT NOT NULL REFERENCES page_versions(id), path TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256), media_type TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (version_id, path)
) WITHOUT ROWID;
CREATE INDEX version_files_blob ON version_files(sha256);

-- A publish in progress. A cron removes expired rows.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id), key_id TEXT NOT NULL,
  base_version INTEGER NOT NULL, manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX uploads_expiry ON uploads(expires_at);

-- Which blobs a key has itself uploaded and proved; see security.md, "Blob ownership".
CREATE TABLE upload_blobs (
  upload_id TEXT NOT NULL REFERENCES uploads(id), sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  PRIMARY KEY (upload_id, sha256)
) WITHOUT ROWID;
CREATE INDEX upload_blobs_blob ON upload_blobs(sha256);

CREATE TABLE idempotency (
  key_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  status INTEGER NOT NULL, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
) WITHOUT ROWID;
CREATE INDEX idempotency_expiry ON idempotency(expires_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,                       -- the page's own id, for example "storage"
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,     -- goes up when the question or its options change
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','stale','withdrawn')),
  answer_seq INTEGER NOT NULL DEFAULT 0,   -- current answer; 0 means none
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (page_id, key)
);
CREATE INDEX decisions_status ON decisions(status, updated_at, id);
CREATE INDEX decisions_project_status ON decisions(project_id, status, updated_at, id);

CREATE TABLE decision_revisions (
  decision_id TEXT NOT NULL REFERENCES decisions(id), revision INTEGER NOT NULL,
  question TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL,              -- ordered; the first is the recommended one
  version_id TEXT NOT NULL REFERENCES page_versions(id), created_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, revision)
) WITHOUT ROWID;

-- Append only. Triggers refuse updates and deletes, except during a purge.
CREATE TABLE decision_answers (
  decision_id TEXT NOT NULL REFERENCES decisions(id), seq INTEGER NOT NULL,
  revision INTEGER NOT NULL, option_id TEXT,     -- NULL: answered with notes only
  notes TEXT NOT NULL DEFAULT '', answered_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, seq)
) WITHOUT ROWID;
CREATE TRIGGER decision_answers_no_update BEFORE UPDATE ON decision_answers
BEGIN SELECT RAISE(ABORT, 'answers are append only'); END;
CREATE TRIGGER decision_answers_no_delete BEFORE DELETE ON decision_answers
WHEN NOT EXISTS (SELECT 1 FROM pages p JOIN decisions d ON d.page_id = p.id
                 WHERE d.id = OLD.decision_id AND p.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'answers are append only'); END;

CREATE TABLE comments (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id TEXT NOT NULL,                 -- the first comment's id
  version_n INTEGER NOT NULL, section_id TEXT, section_title TEXT, quote TEXT,
  author_type TEXT NOT NULL CHECK (author_type IN ('owner','agent')),
  agent_id TEXT REFERENCES agents(id), body TEXT NOT NULL,
  created_at INTEGER NOT NULL, resolved_at INTEGER, deleted_at INTEGER
);
CREATE INDEX comments_page ON comments(page_id, created_at, id);
CREATE INDEX comments_thread ON comments(thread_id, created_at, id);
CREATE INDEX comments_open ON comments(project_id, created_at, id)
  WHERE resolved_at IS NULL AND deleted_at IS NULL AND id = thread_id;
CREATE INDEX comments_purge ON comments(deleted_at) WHERE deleted_at IS NOT NULL;

-- Ordered feed agents can poll, and the outbox webhooks are sent from.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, page_id TEXT,
  type TEXT NOT NULL, subject_id TEXT NOT NULL, created_at INTEGER NOT NULL, enqueued_at INTEGER
);
CREATE INDEX events_project ON events(project_id, seq);
CREATE INDEX events_outbox ON events(seq) WHERE enqueued_at IS NULL;

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), url TEXT NOT NULL,
  event_types_json TEXT NOT NULL, secret_enc BLOB NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX webhooks_project ON webhooks(project_id, enabled);
CREATE TABLE webhook_deliveries (
  webhook_id TEXT NOT NULL, event_seq INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, last_code INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (webhook_id, event_seq)
) WITHOUT ROWID;

-- Owner sign-in. The tables below fit the built-in passkey option; the other options need only sessions.
CREATE TABLE owner_passkeys (
  credential_id TEXT PRIMARY KEY, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE owner_sessions (
  token_sha256 TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, subject_id TEXT
);

-- rowid is mapped to the page through pages_fts_map.
CREATE TABLE pages_fts_map (rowid INTEGER PRIMARY KEY, page_id TEXT NOT NULL UNIQUE REFERENCES pages(id));
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, summary, tags, body, prefix='2 3 4', tokenize="unicode61 remove_diacritics 2"
);
