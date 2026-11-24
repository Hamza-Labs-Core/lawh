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

-- The secret itself is never stored: only HMAC-SHA256(pepper, keyId + ':' + secret).
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
CREATE TRIGGER page_tags_sort AFTER UPDATE OF updated_at ON pages
BEGIN UPDATE page_tags SET sort_at = NEW.updated_at WHERE page_id = NEW.id; END;

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  n INTEGER NOT NULL, entry_path TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL, file_count INTEGER NOT NULL,
  published_by TEXT NOT NULL REFERENCES agents(id), key_id TEXT NOT NULL REFERENCES agent_keys(id),
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, n)
);
-- A version must follow the page's current one, on a page that isn't deleted; else the batch fails (409).
CREATE TRIGGER page_versions_next BEFORE INSERT ON page_versions
WHEN NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = NEW.page_id
                 AND p.current_version = NEW.n - 1 AND p.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'version conflict'); END;
CREATE TRIGGER page_versions_point AFTER INSERT ON page_versions
BEGIN UPDATE pages SET current_version = NEW.n, updated_at = NEW.created_at WHERE id = NEW.page_id; END;

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
-- Projects that have proved they hold a blob.
CREATE TABLE project_blobs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE CASCADE,
  PRIMARY KEY (project_id, sha256)
) WITHOUT ROWID;
CREATE INDEX project_blobs_blob ON project_blobs(sha256);

-- A publish in progress. It names the page by project and slug: commit creates the pages row, so an
-- unfinished publish is never visible and never takes a slug. A cron removes expired rows.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), slug TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES agent_keys(id),
  base_version INTEGER NOT NULL, manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX uploads_page ON uploads(project_id, slug);
CREATE INDEX uploads_expiry ON uploads(expires_at);

-- Blobs this upload sent (hashed from its own body) or reuses from its project. Rows pin a blob against cleanup.
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
-- The inbox query names this index (INDEXED BY): the planner would otherwise sort.
CREATE INDEX decisions_inbox ON decisions(updated_at, id) WHERE status IN ('open','stale');
CREATE INDEX decisions_recent ON decisions(updated_at, id);
CREATE INDEX decisions_project ON decisions(project_id, updated_at, id);
CREATE INDEX decisions_page ON decisions(page_id, position);
CREATE INDEX decisions_project_status ON decisions(project_id, status, updated_at, id);

CREATE TABLE decision_revisions (
  decision_id TEXT NOT NULL REFERENCES decisions(id), revision INTEGER NOT NULL,
  question TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL,              -- ordered; the first is the recommended one
  version_id TEXT REFERENCES page_versions(id) ON DELETE SET NULL,   -- NULL once that version is pruned
  version_n INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, revision)
) WITHOUT ROWID;
CREATE INDEX decision_revisions_version ON decision_revisions(version_id);

-- Append only. An answer must be for the current revision and be the next number, so a republish or
-- an answer from another device makes the whole batch fail (409). Deletes only in the 30-day purge.
CREATE TABLE decision_answers (
  decision_id TEXT NOT NULL REFERENCES decisions(id), seq INTEGER NOT NULL,
  revision INTEGER NOT NULL, option_id TEXT,     -- NULL: answered with notes only
  notes TEXT NOT NULL DEFAULT '', answered_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, seq),
  FOREIGN KEY (decision_id, revision) REFERENCES decision_revisions(decision_id, revision),
  CHECK (option_id IS NOT NULL OR length(trim(notes)) > 0)
) WITHOUT ROWID;
CREATE TRIGGER decision_answers_current BEFORE INSERT ON decision_answers
WHEN NOT EXISTS (SELECT 1 FROM decisions d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
                 WHERE d.id = NEW.decision_id AND d.revision = NEW.revision
                 AND d.answer_seq = NEW.seq - 1 AND d.status <> 'withdrawn')
BEGIN SELECT RAISE(ABORT, 'answer conflict'); END;
CREATE TRIGGER decision_answers_point AFTER INSERT ON decision_answers
BEGIN UPDATE decisions SET answer_seq = NEW.seq, status = 'answered', updated_at = NEW.answered_at
      WHERE id = NEW.decision_id; END;
CREATE TRIGGER decision_answers_no_update BEFORE UPDATE ON decision_answers
BEGIN SELECT RAISE(ABORT, 'answers are append only'); END;
CREATE TRIGGER decision_answers_no_delete BEFORE DELETE ON decision_answers
WHEN NOT EXISTS (SELECT 1 FROM pages p JOIN decisions d ON d.page_id = p.id
                 WHERE d.id = OLD.decision_id AND p.deleted_at <= (unixepoch() - 2592000) * 1000)
BEGIN SELECT RAISE(ABORT, 'answers are append only'); END;

CREATE TABLE comments (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  thread_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,   -- the first comment's id
  version_n INTEGER NOT NULL, section_id TEXT, section_title TEXT, quote TEXT,
  author_type TEXT NOT NULL CHECK (author_type IN ('owner','agent')),
  agent_id TEXT REFERENCES agents(id), body TEXT NOT NULL,
  created_at INTEGER NOT NULL, resolved_at INTEGER, deleted_at INTEGER,
  CHECK ((author_type = 'agent') = (agent_id IS NOT NULL))
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
  webhook_id TEXT NOT NULL REFERENCES webhooks(id), event_seq INTEGER NOT NULL REFERENCES events(seq), attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, last_code INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (webhook_id, event_seq)
) WITHOUT ROWID;
CREATE INDEX webhook_deliveries_status ON webhook_deliveries(status, updated_at);

-- Owner sign-in. The tables below fit the built-in passkey option; the other option needs only sessions.
CREATE TABLE owner_passkeys (
  credential_id TEXT PRIMARY KEY, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER,
  setup_link TEXT REFERENCES owner_setup_links(token_sha256) ON DELETE SET NULL
);
CREATE INDEX owner_passkeys_link ON owner_passkeys(setup_link);
CREATE TABLE owner_sessions (
  token_sha256 TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  -- Exactly one source: a passkey, or an approval from a signed-in device.
  passkey_id TEXT REFERENCES owner_passkeys(credential_id) ON DELETE CASCADE,
  approval_id TEXT UNIQUE,
  CHECK ((passkey_id IS NULL) <> (approval_id IS NULL))
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
CREATE INDEX owner_sessions_passkey ON owner_sessions(passkey_id);
-- Single use: read and removed by one DELETE … RETURNING.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('register','sign_in')),
  challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
-- Single-use owner setup or recovery links.
CREATE TABLE owner_setup_links (
  token_sha256 TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE INDEX owner_setup_links_expiry ON owner_setup_links(expires_at);
-- Adding a passkey is what uses a link. The server writes only the INSERT: these triggers check the link,
-- mark it used and remove everything the old owner devices held, or the INSERT fails and nothing changes.
CREATE TRIGGER owner_passkeys_link_valid BEFORE INSERT ON owner_passkeys
WHEN NEW.setup_link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM owner_setup_links l
  WHERE l.token_sha256 = NEW.setup_link AND l.used_at IS NULL AND l.expires_at > unixepoch() * 1000)
BEGIN SELECT RAISE(ABORT, 'setup link not usable'); END;
CREATE TRIGGER owner_passkeys_link_use AFTER INSERT ON owner_passkeys WHEN NEW.setup_link IS NOT NULL
BEGIN
  UPDATE owner_setup_links SET used_at = unixepoch() * 1000 WHERE token_sha256 = NEW.setup_link;
  DELETE FROM owner_passkeys WHERE credential_id <> NEW.credential_id;
  DELETE FROM owner_sessions;
  DELETE FROM auth_challenges;
  DELETE FROM device_approvals;
END;
-- "Approve from a device that is already signed in".
CREATE TABLE device_approvals (
  id TEXT PRIMARY KEY, code_hmac TEXT NOT NULL UNIQUE, secret_sha256 TEXT NOT NULL, label TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, used_at INTEGER
);
CREATE INDEX device_approvals_expiry ON device_approvals(expires_at);
-- The same for a session that comes from an approval.
CREATE TRIGGER owner_sessions_approval_valid BEFORE INSERT ON owner_sessions
WHEN NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM device_approvals a WHERE a.id = NEW.approval_id
  AND a.approved_at IS NOT NULL AND a.used_at IS NULL AND a.expires_at > unixepoch() * 1000)
BEGIN SELECT RAISE(ABORT, 'approval not usable'); END;
CREATE TRIGGER owner_sessions_approval_use AFTER INSERT ON owner_sessions WHEN NEW.approval_id IS NOT NULL
BEGIN UPDATE device_approvals SET used_at = unixepoch() * 1000 WHERE id = NEW.approval_id; END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, subject_id TEXT
);

-- rowid is mapped to the page through pages_fts_map. `scope` holds one token each for the project, status
-- and tags, so filters apply inside the index, before LIMIT. A token is p, s or t and then the value's
-- UTF-8 bytes in hex: letters and digits only, so the tokenizer never splits it. Every publish, detail or
-- status change replaces both rows with a new, higher rowid (AUTOINCREMENT), so rowid order is newest
-- first. Deleting a page removes the rows; restoring adds them back.
CREATE TABLE pages_fts_map (rowid INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL UNIQUE REFERENCES pages(id));
CREATE VIRTUAL TABLE pages_fts USING fts5(
  scope, title, summary, tags, body, prefix='2 3 4', tokenize="unicode61 remove_diacritics 2"
);
