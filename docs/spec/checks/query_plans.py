"""Build schema.sql in memory and fail if a hot query scans a table.

Run: python3 docs/spec/checks/query_plans.py
"""
import pathlib, sqlite3, sys

schema = (pathlib.Path(__file__).parent.parent / "schema.sql").read_text()
db = sqlite3.connect(":memory:")
db.executescript(schema)

Q = {
 "sessions of passkey": "SELECT 1 FROM sessions WHERE passkey_id=?",
 "inbox": "SELECT d.id FROM decisions d INDEXED BY decisions_inbox CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE d.status IN ('open','stale') AND (d.updated_at,d.id)>(?,?) ORDER BY d.updated_at,d.id LIMIT 50",
 "expired links": "DELETE FROM access_links WHERE expires_at<? AND (used_at IS NOT NULL OR kind<>'invite')",
 "level on project": "SELECT MAX(level) FROM project_access WHERE member_id=? AND project_id=?",
 "member's projects": "SELECT project_id,level FROM project_access WHERE member_id=?",
 "manager's key on project": "SELECT 1 FROM agent_key_projects kp CROSS JOIN project_access x ON x.member_id=? AND x.project_id=kp.project_id AND x.level=4 WHERE kp.key_id=? AND kp.project_id=?",
 "members": "SELECT id,name FROM members WHERE removed_at IS NULL AND joined_at IS NOT NULL AND (name,id)>(?,?) ORDER BY name,id LIMIT 50",
 "members to clear": "SELECT id FROM members WHERE removed_at<? AND removed_at IS NOT NULL AND name IS NOT NULL LIMIT 20",
 "invites to end": "SELECT id FROM members WHERE created_at<? AND joined_at IS NULL AND removed_at IS NULL LIMIT 20",
 "people someone invited": "SELECT id FROM members WHERE created_by=? AND joined_at IS NULL AND removed_at IS NULL",
 "pending invites of team": "SELECT l.member_id,l.level,m.name FROM access_links l JOIN members m ON m.id=l.member_id WHERE l.team_id=? AND l.used_at IS NULL",
 "drop member's links": "DELETE FROM access_links WHERE member_id=?",
 "webhooks of project": "SELECT w.id,m.name FROM webhooks w JOIN members m ON m.id=w.created_by WHERE w.project_id=?",
 "links someone made": "SELECT member_id FROM access_links WHERE created_by=? AND used_at IS NULL",
 "cancel who they invited": "UPDATE members SET removed_at=1 WHERE created_by=? AND joined_at IS NULL AND removed_at IS NULL",
 "cancel who they sent a link": "UPDATE members SET removed_at=1 WHERE joined_at IS NULL AND removed_at IS NULL AND id IN (SELECT member_id FROM access_links WHERE created_by=? AND used_at IS NULL)",
 "cancel who a team invited": "UPDATE members SET removed_at=1 WHERE joined_at IS NULL AND removed_at IS NULL AND id IN (SELECT member_id FROM access_links WHERE team_id=? AND used_at IS NULL)",
 "keys of project": "SELECT key_id FROM agent_key_projects WHERE project_id=?",
 "inbox in project": "SELECT d.id FROM decisions d INDEXED BY decisions_project_inbox CROSS JOIN pages p ON p.id=d.page_id AND p.deleted_at IS NULL WHERE d.project_id=? AND d.status IN ('open','stale') AND (d.updated_at,d.id)>(?,?) ORDER BY d.updated_at,d.id LIMIT 50",
 "members of team": "SELECT m.id,m.name,t.level FROM team_members t JOIN members m ON m.id=t.member_id WHERE t.team_id=?",
 "projects of team": "SELECT p.id FROM team_projects t JOIN projects p ON p.id=t.project_id WHERE t.team_id=?",
 "teams on project": "SELECT t.id FROM team_projects x JOIN teams t ON t.id=x.team_id WHERE x.project_id=?",
 "teams of member": "SELECT t.id,m.level FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.member_id=?",
 "member's links": "SELECT 1 FROM access_links WHERE member_id=? AND used_at IS NULL",
 "member's passkeys": "SELECT credential_id FROM passkeys WHERE member_id=?",
 "member's sessions": "SELECT label FROM sessions WHERE member_id=?",
 "member's agents": "SELECT id FROM agents WHERE member_id=? ORDER BY name",
 "end sessions": "DELETE FROM sessions WHERE member_id=?",
 "drop made links": "DELETE FROM access_links WHERE created_by=? AND used_at IS NULL",
 "answer allowed": "SELECT 1 FROM decisions d CROSS JOIN project_access x ON x.member_id=? AND x.project_id=d.project_id AND x.level>=3 WHERE d.id=?",
 "teams of person, count": "SELECT COUNT(*) FROM team_members WHERE member_id=?",
 "projects of team, count": "SELECT COUNT(*) FROM team_projects WHERE team_id=?",
 "expired connects": "DELETE FROM agent_connects WHERE expires_at<?",
 "projects a key can use now": "SELECT p.slug,p.name_en,p.name_ar FROM agent_key_projects kp JOIN projects p ON p.id=kp.project_id WHERE kp.key_id=? AND EXISTS (SELECT 1 FROM project_access x WHERE x.member_id=? AND x.project_id=kp.project_id AND x.level=4)",
 "connect by code": "SELECT id FROM agent_connects WHERE code_hmac=? AND expires_at>?",
 "connect by id": "SELECT * FROM agent_connects WHERE id=?",
 "expired approvals": "DELETE FROM device_approvals WHERE expires_at<?",
 "files of version": "SELECT path FROM version_files WHERE version_id=?",
 "key lookup": "SELECT k.*,m.role FROM agent_keys k JOIN agents a ON a.id=k.agent_id JOIN members m ON m.id=a.member_id WHERE k.id=? AND k.revoked_at IS NULL AND a.disabled_at IS NULL AND m.removed_at IS NULL",
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
 "agreement": "SELECT a.* FROM decision_answers a WHERE a.decision_id=? AND a.revision=? AND NOT EXISTS (SELECT 1 FROM decision_answers b WHERE b.decision_id=a.decision_id AND b.member_id=a.member_id AND b.seq>a.seq)",
 "my newest answer": "SELECT option_id,revision FROM decision_answers WHERE decision_id=? AND member_id=? ORDER BY seq DESC LIMIT 1",
 # The Worker drops repeated ids (a person in two teams) and adds 1 for the owner.
 "people who may answer": "SELECT tm.member_id FROM team_projects tp CROSS JOIN team_members tm ON tm.team_id=tp.team_id AND tm.level>=3 WHERE tp.project_id=?",
 "projects that need agreement": "UPDATE projects SET answers_needed=1 WHERE answers_needed>1",
 "answer history": "SELECT * FROM decision_answers WHERE decision_id=? ORDER BY seq",
 "comments on page": "SELECT * FROM comments WHERE page_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 100",
 "thread": "SELECT * FROM comments WHERE thread_id=? ORDER BY created_at,id",
 # The Worker reads the newest number first (0 when none). Without `after`, or with no read scope, it stops there and
 # skips the second query, because IN () would scan. A full page continues at its last item, any other at the newest number.
 "newest event": "SELECT MAX(seq) FROM events WHERE project_id=?",
 "events": "SELECT * FROM events WHERE project_id=? AND seq>? AND seq<=? AND type IN (?,?,?) ORDER BY seq LIMIT 100",
 "outbox": "SELECT seq FROM events WHERE enqueued_at IS NULL ORDER BY seq LIMIT 100",
 "session": "SELECT s.*,m.role FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_sha256=? AND s.expires_at>? AND m.removed_at IS NULL",
 "expired uploads": "SELECT id FROM uploads WHERE expires_at<? LIMIT 100",
 "purge pages": "SELECT id FROM pages WHERE deleted_at<? AND deleted_at IS NOT NULL LIMIT 20",
}
bad = 0
for name, sql in Q.items():
    plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, (1,) * sql.count("?"))]
    # An FTS MATCH is reported as a virtual-table scan; an ordered partial index whose WHERE is the
    # whole filter is a bounded index walk under LIMIT, not a table scan.
    ok = all(("SCAN" not in p) or "VIRTUAL TABLE INDEX" in p
             or (name == "outbox" and "USING" in p and "INDEX" in p) for p in plan)
    ok = ok and not any("TEMP B-TREE" in p for p in plan)
    bad += not ok
    print(("ok  " if ok else "FAIL"), name, "|", " ; ".join(plan))
sys.exit(1 if bad else 0)
