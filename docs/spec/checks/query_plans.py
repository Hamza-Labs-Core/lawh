"""Build schema.sql in memory and fail if a hot query scans a table.

Run: python3 docs/spec/checks/query_plans.py
"""
import pathlib, sqlite3, sys

schema = (pathlib.Path(__file__).parent.parent / "schema.sql").read_text()
db = sqlite3.connect(":memory:")
db.executescript(schema)

Q = {
 "key lookup": "SELECT k.* FROM agent_keys k JOIN agents a ON a.id=k.agent_id WHERE k.id=? AND k.revoked_at IS NULL AND a.disabled_at IS NULL",
 "decisions on page": "SELECT * FROM decisions WHERE page_id=? ORDER BY position",
 "open decisions": "SELECT d.id FROM decisions d CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE d.status='open' AND (d.updated_at,d.id)>(?,?) ORDER BY d.updated_at,d.id LIMIT 50",
 "open decisions in project": "SELECT d.id FROM decisions d CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE d.project_id=? AND d.status='open' ORDER BY d.updated_at,d.id LIMIT 50",
 "all decisions": "SELECT d.id FROM decisions d CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE (d.updated_at,d.id)>(?,?) ORDER BY d.updated_at,d.id LIMIT 50",
 "all decisions in project": "SELECT d.id FROM decisions d CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE d.project_id=? ORDER BY d.updated_at,d.id LIMIT 50",
 "open threads": "SELECT c.id FROM comments c CROSS JOIN pages p ON p.id=c.page_id AND p.deleted_at IS NULL WHERE c.project_id=? AND c.resolved_at IS NULL AND c.deleted_at IS NULL AND c.id=c.thread_id ORDER BY c.created_at,c.id LIMIT 50",
 "search": "SELECT m.page_id FROM pages_fts f JOIN pages_fts_map m ON m.rowid=f.rowid WHERE pages_fts MATCH ? ORDER BY f.rowid DESC LIMIT 100",
 "project holds blob": "SELECT 1 FROM project_blobs WHERE project_id=? AND sha256=?",
 "uploads of page": "SELECT id FROM uploads WHERE project_id=? AND slug=?",
 "failed deliveries": "SELECT * FROM webhook_deliveries WHERE status='failed' ORDER BY updated_at DESC LIMIT 50",
 "revisions of version": "SELECT 1 FROM decision_revisions WHERE version_id=?",
 "take challenge": "DELETE FROM auth_challenges WHERE id=? AND expires_at>? RETURNING challenge",
 "key projects": "SELECT 1 FROM agent_key_projects WHERE key_id=? AND project_id=?",
 "library": "SELECT id,title FROM pages WHERE deleted_at IS NULL AND (updated_at,id)<(?,?) ORDER BY updated_at DESC,id DESC LIMIT 30",
 "library by project": "SELECT id FROM pages WHERE project_id=? AND deleted_at IS NULL AND (updated_at,id)<(?,?) ORDER BY updated_at DESC,id DESC LIMIT 30",
 "library by status": "SELECT id FROM pages WHERE status=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 30",
 "library by project+status": "SELECT id FROM pages WHERE project_id=? AND status=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 30",
 "library by tag": "SELECT p.id FROM page_tags t JOIN pages p ON p.id=t.page_id WHERE t.tag=? AND (t.sort_at,t.page_id)<(?,?) AND p.deleted_at IS NULL ORDER BY t.sort_at DESC,t.page_id DESC LIMIT 30",
 "library by project+tag": "SELECT p.id FROM page_tags t JOIN pages p ON p.id=t.page_id WHERE t.project_id=? AND t.tag=? AND p.deleted_at IS NULL ORDER BY t.sort_at DESC,t.page_id DESC LIMIT 30",
 "page by slug": "SELECT * FROM pages WHERE project_id=? AND slug=?",
 "versions": "SELECT n FROM page_versions WHERE page_id=? ORDER BY n DESC LIMIT 50",
 "serve file": "SELECT sha256 FROM version_files WHERE version_id=? AND path=?",
 "blob still used": "SELECT 1 FROM version_files WHERE sha256=? LIMIT 1",
 "blob pending": "SELECT 1 FROM upload_blobs WHERE sha256=? LIMIT 1",
 "blob gc": "SELECT sha256 FROM blobs WHERE unreferenced_at<? AND unreferenced_at IS NOT NULL LIMIT 100",
 "answer history": "SELECT * FROM decision_answers WHERE decision_id=? ORDER BY seq",
 "comments on page": "SELECT * FROM comments WHERE page_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 100",
 "thread": "SELECT * FROM comments WHERE thread_id=? ORDER BY created_at,id",
 "event feed": "SELECT * FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT 100",
 "outbox": "SELECT seq FROM events WHERE enqueued_at IS NULL ORDER BY seq LIMIT 100",
 "session": "SELECT * FROM owner_sessions WHERE token_sha256=?",
 "expired uploads": "SELECT id FROM uploads WHERE expires_at<? LIMIT 100",
 "purge pages": "SELECT id FROM pages WHERE deleted_at<? AND deleted_at IS NOT NULL LIMIT 20",
}
bad = 0
for name, sql in Q.items():
    plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, (1,) * sql.count("?"))]
    # An FTS MATCH is reported as a virtual-table scan; an ordered partial index whose WHERE is the
    # whole filter is a bounded index walk under LIMIT, not a table scan.
    ok = all(("SCAN" not in p) or "VIRTUAL TABLE INDEX" in p
             or (name in ("library", "outbox") and "USING" in p and "INDEX" in p) for p in plan)
    ok = ok and not any("TEMP B-TREE" in p for p in plan)
    bad += not ok
    print(("ok  " if ok else "FAIL"), name, "|", " ; ".join(plan))
sys.exit(1 if bad else 0)
