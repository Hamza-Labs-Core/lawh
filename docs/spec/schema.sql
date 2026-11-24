-- Lawh data model (D1 / SQLite). Times are Unix milliseconds. IDs are prefixed ULIDs.
-- Every query in checks/query_plans.py must use an index; the check fails on a table scan.

CREATE TABLE projects (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  created_at INTEGER NOT NULL, archived_at INTEGER
);

-- People. One owner; everyone else is a member. Rows are never deleted: 30 days after removal the name
-- becomes NULL, and history shows "Former member". An invited person has joined_at NULL and is in no team.
CREATE TABLE members (
  id TEXT PRIMARY KEY, name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_by TEXT REFERENCES members(id), created_at INTEGER NOT NULL,
  joined_at INTEGER, removed_at INTEGER,
  CHECK (role <> 'owner' OR removed_at IS NULL),
  CHECK (removed_at IS NOT NULL OR (name IS NOT NULL AND length(trim(name)) > 0))
);
CREATE UNIQUE INDEX members_owner ON members(role) WHERE role = 'owner';
CREATE INDEX members_list ON members(name, id) WHERE removed_at IS NULL AND joined_at IS NOT NULL;
CREATE INDEX members_pending ON members(created_at) WHERE joined_at IS NULL AND removed_at IS NULL;
CREATE INDEX members_inviter ON members(created_by) WHERE joined_at IS NULL AND removed_at IS NULL;
CREATE INDEX members_purge ON members(removed_at) WHERE removed_at IS NOT NULL AND name IS NOT NULL;

CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
-- level: 1 viewer, 2 commenter, 3 decider, 4 manager. The owner is in no team and counts as 5 everywhere.
-- set_by is who wrote the row's current level. At most 5 teams a person and 10 projects a team, so a person
-- has at most 50 rows in project_access.
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  set_by TEXT NOT NULL REFERENCES members(id), set_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, member_id)
) WITHOUT ROWID;
CREATE INDEX team_members_member ON team_members(member_id, team_id, level);
CREATE TABLE team_projects (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (team_id, project_id)
) WITHOUT ROWID;
CREATE INDEX team_projects_project ON team_projects(project_id, team_id);
CREATE TRIGGER team_projects_cap BEFORE INSERT ON team_projects
WHEN (SELECT COUNT(*) FROM team_projects WHERE team_id = NEW.team_id) >= 10
BEGIN SELECT RAISE(ABORT, 'too many projects'); END;
CREATE TRIGGER team_projects_fixed BEFORE UPDATE ON team_projects
BEGIN SELECT RAISE(ABORT, 'add and remove instead'); END;
-- One row per team that gives a member a project; the member's level is the highest. Always read with
-- member_id = ? (and project_id = ?).
CREATE VIEW project_access AS
  SELECT tm.member_id, tp.project_id, tm.level FROM team_members tm
  JOIN members m ON m.id = tm.member_id AND m.role = 'member' AND m.joined_at IS NOT NULL AND m.removed_at IS NULL
  JOIN team_projects tp ON tp.team_id = tm.team_id;
-- The owner sets any level. A manager of the team sets up to decider, and can't change a manager.
-- Managers remove people with a guarded DELETE (checks/integrity.py).
CREATE TRIGGER team_members_add BEFORE INSERT ON team_members
WHEN NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.member_id AND m.role = 'member'
                 AND m.joined_at IS NOT NULL AND m.removed_at IS NULL)
  OR (SELECT COUNT(*) FROM team_members t WHERE t.member_id = NEW.member_id) >= 5
  OR NOT (EXISTS (SELECT 1 FROM members o WHERE o.id = NEW.set_by AND o.role = 'owner')
       OR (NEW.level < 4 AND EXISTS (SELECT 1 FROM team_members b
           WHERE b.team_id = NEW.team_id AND b.member_id = NEW.set_by AND b.level = 4)))
BEGIN SELECT RAISE(ABORT, 'level not allowed'); END;
CREATE TRIGGER team_members_change BEFORE UPDATE ON team_members
WHEN NEW.team_id <> OLD.team_id OR NEW.member_id <> OLD.member_id
  OR NOT (EXISTS (SELECT 1 FROM members o WHERE o.id = NEW.set_by AND o.role = 'owner')
       OR (NEW.level < 4 AND OLD.level < 4 AND EXISTS (SELECT 1 FROM team_members b
           WHERE b.team_id = NEW.team_id AND b.member_id = NEW.set_by AND b.level = 4)))
BEGIN SELECT RAISE(ABORT, 'level not allowed'); END;

-- An agent belongs to a person. Its keys work only where that person is the owner or a manager.
-- An agent that changes person loses its keys: the old person still has the secrets.
CREATE TABLE agents (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
  name TEXT NOT NULL, provider TEXT,
  created_at INTEGER NOT NULL, disabled_at INTEGER,
  UNIQUE (member_id, name)
);

-- The secret itself is never stored: only HMAC-SHA256(pepper, keyId + ':' + lowercase hex SHA-256 of its text).
CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_hmac TEXT NOT NULL, scopes_json TEXT NOT NULL,
  all_projects INTEGER NOT NULL DEFAULT 0 CHECK (all_projects IN (0,1)),   -- counts only for the owner's agents
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER,
  label TEXT                                 -- the machine it is for
);
CREATE INDEX agent_keys_agent ON agent_keys(agent_id, created_at);
CREATE TRIGGER agent_keys_add BEFORE INSERT ON agent_keys
WHEN NOT EXISTS (SELECT 1 FROM agents a JOIN members m ON m.id = a.member_id AND m.joined_at IS NOT NULL AND m.removed_at IS NULL
                 WHERE a.id = NEW.agent_id AND a.disabled_at IS NULL AND (m.role = 'owner'
                   OR NEW.all_projects = 0 AND EXISTS (SELECT 1 FROM team_members t WHERE t.member_id = m.id AND t.level = 4)))
BEGIN SELECT RAISE(ABORT, 'key not allowed'); END;
CREATE TRIGGER agent_keys_fixed BEFORE UPDATE ON agent_keys
WHEN NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at OR NEW.agent_id <> OLD.agent_id OR NEW.secret_hmac <> OLD.secret_hmac OR NEW.scopes_json <> OLD.scopes_json
  OR NEW.all_projects <> OLD.all_projects OR NEW.label IS NOT OLD.label OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'key not allowed'); END;
CREATE TRIGGER agents_moved AFTER UPDATE OF member_id ON agents WHEN NEW.member_id <> OLD.member_id
BEGIN UPDATE agent_keys SET revoked_at = unixepoch() * 1000 WHERE agent_id = NEW.id AND revoked_at IS NULL; END;
-- "Connect an agent". The agent's client makes the secret and sends only its SHA-256, so secret_hmac is known at
-- the start, and this id becomes the key's id. The answer itself adds the key, by trigger: nothing is left to use later.
CREATE TABLE agent_connects (
  id TEXT PRIMARY KEY, code_hmac TEXT NOT NULL UNIQUE, secret_hmac TEXT NOT NULL,
  client TEXT NOT NULL, machine TEXT NOT NULL,   -- what the client says about itself
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  answered_at INTEGER, member_id TEXT REFERENCES members(id), approver_session TEXT,
  agent_id TEXT REFERENCES agents(id),           -- NULL in an answered row: refused
  scopes_json TEXT, all_projects INTEGER, projects_json TEXT, key_expires_at INTEGER,
  CHECK ((answered_at IS NULL) = (member_id IS NULL)),
  CHECK ((member_id IS NULL) = (approver_session IS NULL)),
  CHECK (agent_id IS NULL OR member_id IS NOT NULL),
  CHECK ((agent_id IS NULL) = (scopes_json IS NULL)), CHECK ((agent_id IS NULL) = (all_projects IS NULL)),
  CHECK ((agent_id IS NULL) = (projects_json IS NULL)), CHECK ((agent_id IS NULL) = (key_expires_at IS NULL)),
  CHECK (projects_json IS NULL OR json_type(projects_json) = 'array')
);
CREATE INDEX agent_connects_expiry ON agent_connects(expires_at);
CREATE TRIGGER agent_connects_new BEFORE INSERT ON agent_connects WHEN NEW.answered_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'connect not allowed'); END;
-- Answered once, while in date, from a live session, for an agent of that session's person.
CREATE TRIGGER agent_connects_change BEFORE UPDATE ON agent_connects
WHEN OLD.answered_at IS NOT NULL OR OLD.expires_at <= unixepoch() * 1000
  OR NEW.id <> OLD.id OR NEW.code_hmac <> OLD.code_hmac OR NEW.secret_hmac <> OLD.secret_hmac
  OR NEW.client <> OLD.client OR NEW.machine <> OLD.machine
  OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
  OR NOT EXISTS (SELECT 1 FROM sessions s
      WHERE s.token_sha256 = NEW.approver_session AND s.member_id = NEW.member_id AND s.expires_at > unixepoch() * 1000)
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.member_id = NEW.member_id))
BEGIN SELECT RAISE(ABORT, 'connect not allowed'); END;
CREATE TRIGGER agent_connects_key AFTER UPDATE ON agent_connects WHEN NEW.agent_id IS NOT NULL
BEGIN
  INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,all_projects,created_at,expires_at,label)
    VALUES (NEW.id,NEW.agent_id,NEW.secret_hmac,NEW.scopes_json,NEW.all_projects,NEW.answered_at,NEW.key_expires_at,NEW.machine);
  INSERT INTO agent_key_projects SELECT NEW.id, value FROM json_each(NEW.projects_json);
END;
CREATE TABLE agent_key_projects (
  key_id TEXT NOT NULL REFERENCES agent_keys(id), project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (key_id, project_id)
) WITHOUT ROWID;
CREATE INDEX agent_key_projects_project ON agent_key_projects(project_id, key_id);
-- A key is for all projects or for a list, and the list holds only projects its person manages at that moment.
CREATE TRIGGER agent_key_projects_add BEFORE INSERT ON agent_key_projects
WHEN NOT EXISTS (SELECT 1 FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = a.member_id
    WHERE k.id = NEW.key_id AND k.all_projects = 0 AND k.revoked_at IS NULL AND a.disabled_at IS NULL AND (m.role = 'owner'
      OR EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = m.id AND x.project_id = NEW.project_id AND x.level = 4)))
BEGIN SELECT RAISE(ABORT, 'key not allowed'); END;
CREATE TRIGGER agent_key_projects_fixed BEFORE UPDATE ON agent_key_projects
BEGIN SELECT RAISE(ABORT, 'key not allowed'); END;

CREATE TABLE pages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ar')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','decided','archived')),
  current_version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE (project_id, slug), UNIQUE (id, project_id)
);
CREATE INDEX pages_recent ON pages(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_project ON pages(project_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_status ON pages(status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_project_status ON pages(project_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_purge ON pages(deleted_at) WHERE deleted_at IS NOT NULL;

-- sort_at copies pages.updated_at, so a tag's list is read in order from an index.
CREATE TABLE page_tags (
  page_id TEXT NOT NULL, tag TEXT NOT NULL,
  project_id TEXT NOT NULL, sort_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, tag),
  FOREIGN KEY (page_id, project_id) REFERENCES pages(id, project_id)
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
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL,
  project_id TEXT NOT NULL,                -- the page's project: access is checked against it
  key TEXT NOT NULL,                       -- the page's own id, for example "storage"
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,     -- goes up when the question or its options change
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','stale','withdrawn')),
  answer_seq INTEGER NOT NULL DEFAULT 0,   -- current answer; 0 means none
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (page_id, key),
  FOREIGN KEY (page_id, project_id) REFERENCES pages(id, project_id)
);
CREATE INDEX decisions_status ON decisions(status, updated_at, id);
-- The inbox query names this index (INDEXED BY): the planner would otherwise sort.
CREATE INDEX decisions_inbox ON decisions(updated_at, id) WHERE status IN ('open','stale');
-- The same for one project, for members of teams.
CREATE INDEX decisions_project_inbox ON decisions(project_id, updated_at, id) WHERE status IN ('open','stale');
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
  member_id TEXT NOT NULL REFERENCES members(id),
  PRIMARY KEY (decision_id, seq),
  FOREIGN KEY (decision_id, revision) REFERENCES decision_revisions(decision_id, revision),
  CHECK (option_id IS NOT NULL OR length(trim(notes)) > 0)
) WITHOUT ROWID;
CREATE TRIGGER decision_answers_current BEFORE INSERT ON decision_answers
WHEN NOT EXISTS (SELECT 1 FROM decisions d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
                 WHERE d.id = NEW.decision_id AND d.revision = NEW.revision
                 AND d.answer_seq = NEW.seq - 1 AND d.status <> 'withdrawn')
BEGIN SELECT RAISE(ABORT, 'answer conflict'); END;
-- Whoever answers must be the owner or at least a decider on the page's project at that moment.
CREATE TRIGGER decision_answers_allowed BEFORE INSERT ON decision_answers
WHEN NOT EXISTS (SELECT 1 FROM members o WHERE o.id = NEW.member_id AND o.role = 'owner')
 AND NOT EXISTS (SELECT 1 FROM decisions d CROSS JOIN project_access x
                 ON x.member_id = NEW.member_id AND x.project_id = d.project_id AND x.level >= 3
                 WHERE d.id = NEW.decision_id)
BEGIN SELECT RAISE(ABORT, 'answer not allowed'); END;
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
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL, project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,   -- the first comment's id
  version_n INTEGER NOT NULL, section_id TEXT, section_title TEXT, quote TEXT,
  -- Exactly one author. author_level is the person's level when they wrote it (5 for the owner).
  member_id TEXT REFERENCES members(id), author_level INTEGER CHECK (author_level BETWEEN 2 AND 5),
  agent_id TEXT REFERENCES agents(id), body TEXT NOT NULL,
  created_at INTEGER NOT NULL, resolved_at INTEGER, deleted_at INTEGER,
  CHECK ((member_id IS NULL) <> (agent_id IS NULL)),
  CHECK ((member_id IS NULL) = (author_level IS NULL)),
  FOREIGN KEY (page_id, project_id) REFERENCES pages(id, project_id)
);
-- A reply belongs to a thread of the same page. Only a person starts one.
CREATE TRIGGER comments_place BEFORE INSERT ON comments
WHEN NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = NEW.page_id AND p.deleted_at IS NULL)
  OR (NEW.thread_id = NEW.id AND NEW.member_id IS NULL)
  OR (NEW.thread_id <> NEW.id AND NOT EXISTS (SELECT 1 FROM comments t WHERE t.id = NEW.thread_id
      AND t.thread_id = t.id AND t.page_id = NEW.page_id AND t.deleted_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'comment conflict'); END;
CREATE TRIGGER comments_allowed BEFORE INSERT ON comments
WHEN NEW.member_id IS NOT NULL AND NEW.author_level IS NOT (
  CASE WHEN EXISTS (SELECT 1 FROM members o WHERE o.id = NEW.member_id AND o.role = 'owner') THEN 5
  ELSE (SELECT MAX(x.level) FROM project_access x WHERE x.member_id = NEW.member_id AND x.project_id = NEW.project_id) END)
BEGIN SELECT RAISE(ABORT, 'comment not allowed'); END;
-- A comment isn't edited: only resolved_at and deleted_at change.
CREATE TRIGGER comments_fixed BEFORE UPDATE OF id, page_id, project_id, thread_id, version_n, section_id, section_title,
  quote, member_id, author_level, agent_id, body, created_at ON comments
BEGIN SELECT RAISE(ABORT, 'comments are not edited'); END;
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
  created_by TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL
);
CREATE INDEX webhooks_project ON webhooks(project_id, enabled);
CREATE TABLE webhook_deliveries (
  webhook_id TEXT NOT NULL REFERENCES webhooks(id), event_seq INTEGER NOT NULL REFERENCES events(seq), attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, last_code INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (webhook_id, event_seq)
) WITHOUT ROWID;
CREATE INDEX webhook_deliveries_status ON webhook_deliveries(status, updated_at);

-- Sign-in, by passkey. Everything belongs to one member.
CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL,
  label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER,
  -- Where it came from: a link, or a session of the same member. Exactly one when added.
  link_id TEXT REFERENCES access_links(token_sha256) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(token_sha256) ON DELETE SET NULL
);
CREATE INDEX passkeys_member ON passkeys(member_id);
CREATE INDEX passkeys_link ON passkeys(link_id);
CREATE INDEX passkeys_session ON passkeys(session_id);
CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
  label TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  -- Exactly one source: a passkey, or an approval from a signed-in device.
  passkey_id TEXT REFERENCES passkeys(credential_id) ON DELETE CASCADE,
  approval_id TEXT UNIQUE,
  CHECK ((passkey_id IS NULL) <> (approval_id IS NULL))
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_member ON sessions(member_id);
CREATE INDEX sessions_passkey ON sessions(passkey_id);
-- Single use: read and removed by one DELETE … RETURNING. member_id is NULL for a sign-in.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('register','sign_in')),
  member_id TEXT REFERENCES members(id),
  challenge TEXT NOT NULL, expires_at INTEGER NOT NULL,
  CHECK ((purpose = 'register') = (member_id IS NOT NULL))
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE INDEX auth_challenges_member ON auth_challenges(member_id);
-- Single-use links that let one member register a passkey. 'owner': first setup or recovery, made only by
-- the command line. 'invite': a person who hasn't joined, with the team and level they get on joining.
-- 'reset': a member who lost their devices.
CREATE TABLE access_links (
  token_sha256 TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('owner','invite','reset')),
  member_id TEXT NOT NULL REFERENCES members(id), created_by TEXT REFERENCES members(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, level INTEGER CHECK (level BETWEEN 1 AND 4),
  CHECK ((kind = 'owner') = (created_by IS NULL)),
  CHECK ((kind = 'invite') = (team_id IS NOT NULL) AND (team_id IS NULL) = (level IS NULL))
);
CREATE INDEX access_links_member ON access_links(member_id);
CREATE INDEX access_links_team ON access_links(team_id);
CREATE INDEX access_links_expiry ON access_links(expires_at) WHERE used_at IS NOT NULL OR kind <> 'invite';
CREATE INDEX access_links_creator ON access_links(created_by);
-- One live link per member: making a new one first deletes the unused one.
CREATE UNIQUE INDEX access_links_live ON access_links(member_id) WHERE used_at IS NULL;
-- Only the owner makes reset links: one signs its user in as that member, in every team. A manager invites
-- to their own team, up to decider, and only people they invited themselves.
CREATE TRIGGER access_links_allowed BEFORE INSERT ON access_links
WHEN NEW.used_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.member_id AND m.removed_at IS NULL AND CASE NEW.kind
    WHEN 'owner' THEN m.role = 'owner'
    WHEN 'invite' THEN m.role = 'member' AND m.joined_at IS NULL AND (
      EXISTS (SELECT 1 FROM members c WHERE c.id = NEW.created_by AND c.role = 'owner')
      OR (NEW.level < 4 AND m.created_by = NEW.created_by AND EXISTS (SELECT 1 FROM team_members b
          WHERE b.team_id = NEW.team_id AND b.member_id = NEW.created_by AND b.level = 4)))
    ELSE m.role = 'member' AND m.joined_at IS NOT NULL AND EXISTS (SELECT 1 FROM members c
      WHERE c.id = NEW.created_by AND c.role = 'owner') END)
BEGIN SELECT RAISE(ABORT, 'link not allowed'); END;
CREATE TRIGGER access_links_fixed BEFORE UPDATE ON access_links
WHEN OLD.used_at IS NOT NULL OR NEW.token_sha256 <> OLD.token_sha256 OR NEW.kind <> OLD.kind OR NEW.member_id <> OLD.member_id
  OR NEW.created_by IS NOT OLD.created_by OR NEW.expires_at <> OLD.expires_at
  OR NEW.team_id IS NOT OLD.team_id OR NEW.level IS NOT OLD.level
BEGIN SELECT RAISE(ABORT, 'link not allowed'); END;
-- The server writes only the INSERT into passkeys: these triggers check the link, mark it used and remove
-- everything the member's old devices held, or the INSERT fails and nothing changes. Joining adds the team
-- through team_members_add, so an invite whose maker can no longer give that level doesn't work.
CREATE TRIGGER passkeys_valid BEFORE INSERT ON passkeys
WHEN (NEW.link_id IS NULL) = (NEW.session_id IS NULL)
  OR (NEW.link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM access_links l JOIN members m ON m.id = l.member_id
      WHERE l.token_sha256 = NEW.link_id AND l.member_id = NEW.member_id AND m.removed_at IS NULL
      AND l.used_at IS NULL AND l.expires_at > unixepoch() * 1000
      AND CASE l.kind WHEN 'owner' THEN m.role = 'owner' WHEN 'invite' THEN m.role = 'member' AND m.joined_at IS NULL
          ELSE m.role = 'member' AND m.joined_at IS NOT NULL END))
  OR (NEW.session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions s
      WHERE s.token_sha256 = NEW.session_id AND s.member_id = NEW.member_id AND s.expires_at > unixepoch() * 1000))
BEGIN SELECT RAISE(ABORT, 'passkey not allowed'); END;
CREATE TRIGGER passkeys_link_use AFTER INSERT ON passkeys WHEN NEW.link_id IS NOT NULL
BEGIN
  UPDATE access_links SET used_at = unixepoch() * 1000 WHERE token_sha256 = NEW.link_id;
  UPDATE members SET joined_at = unixepoch() * 1000 WHERE id = NEW.member_id AND joined_at IS NULL;
  INSERT INTO team_members(team_id, member_id, level, set_by, set_at)
    SELECT l.team_id, l.member_id, l.level, l.created_by, unixepoch() * 1000
    FROM access_links l WHERE l.token_sha256 = NEW.link_id AND l.kind = 'invite';
  DELETE FROM sessions WHERE member_id = NEW.member_id;
  DELETE FROM passkeys WHERE member_id = NEW.member_id AND credential_id <> NEW.credential_id;
  DELETE FROM auth_challenges WHERE member_id = NEW.member_id;
  DELETE FROM device_approvals WHERE member_id = NEW.member_id;
END;
-- "Approve from a device that is already signed in". Approving sets member_id from the approver's session.
CREATE TABLE device_approvals (
  id TEXT PRIMARY KEY, code_hmac TEXT NOT NULL UNIQUE, secret_sha256 TEXT NOT NULL, label TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, used_at INTEGER,
  member_id TEXT REFERENCES members(id), approver_session TEXT,
  CHECK ((approved_at IS NULL) = (member_id IS NULL)),
  CHECK ((member_id IS NULL) = (approver_session IS NULL))
);
CREATE INDEX device_approvals_expiry ON device_approvals(expires_at);
CREATE INDEX device_approvals_member ON device_approvals(member_id);
CREATE TRIGGER device_approvals_new BEFORE INSERT ON device_approvals WHEN NEW.approved_at IS NOT NULL OR NEW.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'approval not allowed'); END;
-- Given once while in date, then used once; nothing else changes.
CREATE TRIGGER device_approvals_change BEFORE UPDATE ON device_approvals
WHEN OLD.used_at IS NOT NULL OR OLD.expires_at <= unixepoch() * 1000
  OR NEW.id <> OLD.id OR NEW.code_hmac <> OLD.code_hmac OR NEW.secret_sha256 <> OLD.secret_sha256 OR NEW.expires_at <> OLD.expires_at
  OR NEW.label <> OLD.label OR NEW.created_at <> OLD.created_at
  OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS NOT OLD.approved_at OR NEW.member_id IS NOT OLD.member_id
      OR NEW.approver_session IS NOT OLD.approver_session))
  OR (OLD.approved_at IS NULL AND (NEW.used_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM sessions s
      WHERE s.token_sha256 = NEW.approver_session AND s.member_id = NEW.member_id AND s.expires_at > unixepoch() * 1000)))
BEGIN SELECT RAISE(ABORT, 'approval not allowed'); END;
-- The approver's session must still be live when the approval is used.
CREATE TRIGGER sessions_valid BEFORE INSERT ON sessions
WHEN NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.member_id AND m.joined_at IS NOT NULL AND m.removed_at IS NULL)
  OR (NEW.passkey_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM passkeys k
      WHERE k.credential_id = NEW.passkey_id AND k.member_id = NEW.member_id))
  OR (NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM device_approvals a JOIN sessions s
      ON s.token_sha256 = a.approver_session AND s.member_id = a.member_id AND s.expires_at > unixepoch() * 1000 WHERE a.id = NEW.approval_id
      AND a.member_id = NEW.member_id AND a.used_at IS NULL
      AND a.expires_at > unixepoch() * 1000))
BEGIN SELECT RAISE(ABORT, 'session not allowed'); END;
CREATE TRIGGER sessions_approval_use AFTER INSERT ON sessions WHEN NEW.approval_id IS NOT NULL
BEGIN UPDATE device_approvals SET used_at = unixepoch() * 1000 WHERE id = NEW.approval_id; END;
-- Ownership moves to a member who joined. Whoever gets or gives up the role leaves every team and loses every
-- unused link made for them or by them; people invited by those links are canceled.
CREATE TRIGGER members_promote BEFORE UPDATE OF role ON members
WHEN NEW.role = 'owner' AND (OLD.joined_at IS NULL OR OLD.removed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'member not joined'); END;
CREATE TRIGGER members_role AFTER UPDATE OF role ON members WHEN NEW.role <> OLD.role
BEGIN
  UPDATE members SET removed_at = unixepoch() * 1000 WHERE created_by = NEW.id AND joined_at IS NULL AND removed_at IS NULL;
  UPDATE members SET removed_at = unixepoch() * 1000 WHERE joined_at IS NULL AND removed_at IS NULL
    AND id IN (SELECT member_id FROM access_links WHERE created_by = NEW.id AND used_at IS NULL);
  DELETE FROM team_members WHERE member_id = NEW.id;
  DELETE FROM access_links WHERE member_id = NEW.id AND used_at IS NULL;
  DELETE FROM access_links WHERE created_by = NEW.id AND used_at IS NULL;
END;
-- Only the owner and managers add people, and nobody is added already joined. The first row is the owner.
CREATE TRIGGER members_add BEFORE INSERT ON members
WHEN NEW.joined_at IS NOT NULL OR NEW.removed_at IS NOT NULL OR NEW.role = 'owner' AND EXISTS (SELECT 1 FROM members)
  OR (NEW.role = 'member' AND NOT EXISTS (SELECT 1 FROM members o WHERE o.id = NEW.created_by AND o.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members b WHERE b.member_id = NEW.created_by AND b.level = 4))
BEGIN SELECT RAISE(ABORT, 'member not allowed'); END;
-- Removing a member is one UPDATE; it also cancels their invites. It can't be undone: coming back is a new invite.
CREATE TRIGGER members_no_return BEFORE UPDATE OF removed_at ON members
WHEN OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at
BEGIN SELECT RAISE(ABORT, 'member was removed'); END;
CREATE TRIGGER members_remove AFTER UPDATE OF removed_at ON members WHEN NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL
BEGIN
  DELETE FROM sessions WHERE member_id = NEW.id;
  DELETE FROM passkeys WHERE member_id = NEW.id;
  DELETE FROM auth_challenges WHERE member_id = NEW.id;
  DELETE FROM device_approvals WHERE member_id = NEW.id;
  DELETE FROM access_links WHERE member_id = NEW.id;
  DELETE FROM access_links WHERE member_id IN (SELECT id FROM members
    WHERE created_by = NEW.id AND joined_at IS NULL AND removed_at IS NULL);
  DELETE FROM auth_challenges WHERE member_id IN (SELECT id FROM members
    WHERE created_by = NEW.id AND joined_at IS NULL AND removed_at IS NULL);
  UPDATE members SET removed_at = NEW.removed_at WHERE created_by = NEW.id AND joined_at IS NULL AND removed_at IS NULL;
  DELETE FROM team_members WHERE member_id = NEW.id;
  UPDATE agent_keys SET revoked_at = NEW.removed_at WHERE revoked_at IS NULL
    AND agent_id IN (SELECT id FROM agents WHERE member_id = NEW.id);
END;

-- Deleting a team cancels the people invited to it. Its links go with it; the audit log keeps the record.
CREATE TRIGGER teams_delete BEFORE DELETE ON teams
BEGIN UPDATE members SET removed_at = unixepoch() * 1000 WHERE joined_at IS NULL AND removed_at IS NULL
  AND id IN (SELECT member_id FROM access_links WHERE team_id = OLD.id AND used_at IS NULL); END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('member','agent','command','system')), actor_id TEXT, action TEXT NOT NULL, subject_id TEXT
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
