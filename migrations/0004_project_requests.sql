-- Agent-proposed project creation requests, always requiring owner approval in the UI.
-- Attached either to an open `agent_connects` row (`connect_id IS NOT NULL`, `key_id IS NULL`)
-- or standalone from an already-connected owner agent (`key_id IS NOT NULL`, `connect_id IS NULL`).
CREATE TABLE project_requests (
  id TEXT PRIMARY KEY,
  connect_id TEXT UNIQUE REFERENCES agent_connects(id) ON DELETE CASCADE,
  key_id TEXT REFERENCES agent_keys(id) ON DELETE CASCADE,
  code_hmac TEXT UNIQUE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  member_id TEXT REFERENCES members(id),
  approver_session TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  CHECK ((connect_id IS NULL) <> (key_id IS NULL)),
  CHECK ((key_id IS NULL) = (code_hmac IS NULL)),
  CHECK ((answered_at IS NULL) = (member_id IS NULL)),
  CHECK ((member_id IS NULL) = (approver_session IS NULL)),
  CHECK (project_id IS NULL OR member_id IS NOT NULL)
);
CREATE INDEX project_requests_expiry ON project_requests(expires_at);
CREATE INDEX project_requests_key ON project_requests(key_id, created_at);
CREATE TRIGGER project_requests_new BEFORE INSERT ON project_requests WHEN NEW.answered_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'project request not allowed'); END;
CREATE TRIGGER project_requests_change BEFORE UPDATE ON project_requests
WHEN OLD.answered_at IS NOT NULL OR OLD.expires_at <= unixepoch() * 1000
  OR NEW.id <> OLD.id OR NEW.connect_id IS NOT OLD.connect_id OR NEW.key_id IS NOT OLD.key_id
  OR NEW.code_hmac IS NOT OLD.code_hmac OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
  OR NOT EXISTS (SELECT 1 FROM sessions s JOIN members m ON m.id = s.member_id
      WHERE s.token_sha256 = NEW.approver_session AND s.member_id = NEW.member_id AND m.role = 'owner' AND m.removed_at IS NULL AND s.expires_at > unixepoch() * 1000)
BEGIN SELECT RAISE(ABORT, 'project request not allowed'); END;
