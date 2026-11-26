-- Open threads of every project, for the owner.
CREATE INDEX comments_open_recent ON comments(created_at, id)
  WHERE resolved_at IS NULL AND deleted_at IS NULL AND id = thread_id;
-- Live threads of a page, without walking past replies.
CREATE INDEX comments_page_threads ON comments(page_id, created_at, id)
  WHERE deleted_at IS NULL AND id = thread_id;
