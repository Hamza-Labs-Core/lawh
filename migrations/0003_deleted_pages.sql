-- Deleted pages: of one project, for its managers, and of every project, for the owner.
CREATE INDEX pages_deleted ON pages(project_id, deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX pages_deleted_recent ON pages(deleted_at, id) WHERE deleted_at IS NOT NULL;
