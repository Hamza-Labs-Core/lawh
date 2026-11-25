-- Open threads of every project, for the owner.
CREATE INDEX comments_open_recent ON comments(created_at, id)
  WHERE resolved_at IS NULL AND deleted_at IS NULL AND id = thread_id;
