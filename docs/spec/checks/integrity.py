"""Check the rules schema.sql must enforce by itself. Run: python3 docs/spec/checks/integrity.py"""
import pathlib, sqlite3, sys, time

schema = (pathlib.Path(__file__).parent.parent / "schema.sql").read_text()
NOW = int(time.time() * 1000)
DAY = 86_400_000
fails = 0

def fresh():
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.executescript(schema)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(f"""
      INSERT INTO projects VALUES('p1','one','One','واحد',1,NULL),('p2','two','Two','اثنان',1,NULL);
      INSERT INTO agents VALUES('a1','bot','x',1,NULL);
      INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('k1','a1','h','[]',1,9);
      INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g1','p1','s','T','a1',1,1);
      INSERT INTO page_versions VALUES('v1','g1',1,'index.html','',1,1,'a1','k1',1);
      INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES('d1','g1','p1','k',0,1,1);
      INSERT INTO decision_revisions VALUES('d1',1,'Q','','[]','v1',1,1);
    """)
    return db

def batch(db, *stmts):
    """Like D1 batch(): all or nothing."""
    db.execute("BEGIN")
    try:
        for s in stmts: db.execute(*s) if isinstance(s, tuple) else db.execute(s)
        db.execute("COMMIT"); return True
    except sqlite3.Error:
        db.execute("ROLLBACK"); return False

def check(name, ok):
    global fails
    fails += not ok
    print("ok  " if ok else "FAIL", name)

ANS = "INSERT INTO decision_answers VALUES('d1',?,?,?,?,5)"
db = fresh()
check("first answer accepted", batch(db, (ANS, (1, 1, 'a', ''))))
check("answer moves the pointer", db.execute("SELECT answer_seq,status FROM decisions").fetchone() == (1, 'answered'))
check("same answer number refused", not batch(db, (ANS, (1, 1, 'b', ''))))
check("skipped answer number refused", not batch(db, (ANS, (3, 1, 'b', ''))))
batch(db, "INSERT INTO decision_revisions VALUES('d1',2,'Q2','','[]','v1',1,1)", "UPDATE decisions SET revision=2,status='stale'")
check("answer for an old revision refused", not batch(db, (ANS, (2, 1, 'b', ''))))
check("refused answers leave no row", db.execute("SELECT count(*) FROM decision_answers").fetchone()[0] == 1)
check("decision still answerable afterwards", batch(db, (ANS, (2, 2, 'b', ''))))
check("empty answer refused", not batch(db, (ANS, (3, 2, None, '  '))))
check("notes-only answer accepted", batch(db, (ANS, (3, 2, None, 'why'))))
db.execute("UPDATE decisions SET status='withdrawn'")
check("withdrawn decision refuses an answer", not batch(db, (ANS, (4, 2, 'a', ''))))
check("answer update refused", not batch(db, "UPDATE decision_answers SET notes='x'"))
check("answer delete refused", not batch(db, "DELETE FROM decision_answers"))
db.execute("UPDATE pages SET deleted_at=?", (NOW - 29 * DAY,))
check("answer delete refused before 30 days", not batch(db, "DELETE FROM decision_answers"))
db.execute("UPDATE pages SET deleted_at=?", (NOW - 31 * DAY,))
C = "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,author_type,body,created_at) VALUES(?,'g1','p1','c1',1,'owner','x',1)"
db.execute(C, ("c1",)); db.execute(C, ("c2",))
db.executescript("INSERT INTO blobs VALUES('h','k',1,1,1); INSERT INTO version_files VALUES('v1','a','h','text/plain',1); INSERT INTO page_tags VALUES('g1','t','p1',1); INSERT INTO pages_fts_map(page_id) VALUES('g1'); INSERT INTO pages_fts(rowid,scope,title) VALUES(1,'p1','T')")
check("purge out of order refused", not batch(db, "DELETE FROM decisions", "DELETE FROM pages"))
check("purge of a full page after 30 days, in order", batch(db, "DELETE FROM pages_fts WHERE rowid=1", *[f"DELETE FROM {t}" for t in
      ("pages_fts_map", "page_tags", "comments", "decision_answers", "decision_revisions", "decisions", "version_files", "page_versions", "pages")]))

db = fresh()
db.execute(C, ("c1",)); db.execute(C, ("c2",))
check("removing a thread's first comment removes replies", batch(db, "DELETE FROM comments WHERE id='c1'") and not db.execute("SELECT 1 FROM comments").fetchone())

V = "INSERT INTO page_versions VALUES(?,'g1',?,'i','',1,1,'a1','k1',5)"
db = fresh()
check("publishing moves the page", db.execute("SELECT current_version FROM pages").fetchone()[0] == 1)
check("next version accepted", batch(db, (V, ("v2", 2))))
check("skipped version refused", not batch(db, (V, ("v4", 4))))
db.execute("DELETE FROM decision_revisions"); db.execute("DELETE FROM page_versions WHERE n=2")
check("late publish of a pruned number refused", not batch(db, (V, ("v2b", 2))))
db.execute("UPDATE pages SET deleted_at=1")
check("publish to a deleted page refused", not batch(db, (V, ("v3", 3))))
db = fresh(); db.execute("UPDATE pages SET deleted_at=1")
check("answer on a deleted page refused", not batch(db, (ANS, (1, 1, 'a', ''))))

db = fresh()
db.execute("INSERT INTO owner_setup_links VALUES('L','recovery',1,9,NULL)")
db.execute("INSERT INTO owner_passkeys(credential_id,public_key,sign_count,label,created_at) VALUES('old',x'00',0,'lost',1)")
def recover(cred): return batch(db, "DELETE FROM owner_passkeys", "DELETE FROM owner_sessions", "UPDATE owner_setup_links SET used_at=5 WHERE token_sha256='L'",
    ("INSERT INTO owner_passkeys(credential_id,public_key,sign_count,label,created_at,setup_link) VALUES(?,x'00',0,'n',1,'L')", (cred,)))
check("recovery replaces every passkey", recover('new') and db.execute("SELECT credential_id FROM owner_passkeys").fetchall() == [('new',)])
check("a used link can't be used again", not recover('thief') and db.execute("SELECT credential_id FROM owner_passkeys").fetchall() == [('new',)])
db.execute("DELETE FROM owner_setup_links")
check("a deleted link can't be used", not recover('thief'))
db.execute("INSERT INTO device_approvals VALUES('x','c','s','l',1,9,NULL,NULL)")
USE = "UPDATE device_approvals SET used_at=2"
check("an approval not yet given can't be used", not batch(db, USE))
db.execute("UPDATE device_approvals SET approved_at=1")
check("an approval works once", batch(db, USE) and not batch(db, USE))

db = fresh()
check("pruning a version keeps its decision wording", batch(db, "DELETE FROM page_versions WHERE id='v1'")
      and db.execute("SELECT version_id,version_n,question FROM decision_revisions").fetchone() == (None, 1, 'Q'))

db = fresh()
db.execute("INSERT INTO uploads VALUES('u1','p1','new','k1',0,'{}',1,2)")
check("unfinished first publish makes no page", db.execute("SELECT count(*) FROM pages WHERE slug='new'").fetchone()[0] == 0)
PAGE = "INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES(?,'p1','new','T','a1',1,1)"
check("first of two first publishes wins", batch(db, (PAGE, ('g2',))))
check("second first publish refused", not batch(db, (PAGE, ('g3',))))
check("concurrent version refused", not batch(db, "INSERT INTO page_versions VALUES('v9','g1',1,'i','',1,1,'a1','k1',1)"))

db = fresh()
db.executescript("INSERT INTO blobs VALUES('h','blobs/h/1',1,1,1); INSERT INTO project_blobs VALUES('p1','h'); INSERT INTO uploads VALUES('u1','p1','s','k1',1,'{}',1,2); INSERT INTO upload_blobs VALUES('u1','h')")
check("cleanup refused while an upload pins the blob", not batch(db, "DELETE FROM blobs"))
db.execute("DELETE FROM upload_blobs"); db.execute("INSERT INTO version_files VALUES('v1','a','h','text/plain',1)")
check("cleanup refused while a version uses the blob", not batch(db, "DELETE FROM blobs"))
db.execute("DELETE FROM version_files")
check("cleanup works when unused", batch(db, "DELETE FROM blobs") and not db.execute("SELECT 1 FROM project_blobs").fetchone())

db = fresh()
def tok(kind, value): return kind + value.encode().hex()
def put(rowid, project, status, *tags):
    db.execute("INSERT INTO pages_fts(rowid,scope,title) VALUES(?,?,'storage')", (rowid, " ".join([tok("p", project), tok("s", status), *[tok("t", t) for t in tags]])))
def find(*toks): return [r[0] for r in db.execute("SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rowid DESC LIMIT 100",
    (" AND ".join([f"scope:{t}" for t in toks] + ["{title summary tags body}:stor*"]),))]
for i in range(150): put(i + 10, "prj_01AAA", "draft")
put(1, "prj_01AAB", "in_review", "api-v2"); put(2, "prj_01AAB", "in_review", "api"); put(3, "prj_01AAB", "draft", "تكلفة سحابية")
check("project filter applies before the limit", find(tok("p", "prj_01AAB")) == [3, 2, 1])
check("status with an underscore matches exactly", find(tok("s", "in_review")) == [2, 1] and find(tok("s", "in")) == [])
check("hyphenated tags don't match each other", find(tok("t", "api")) == [2] and find(tok("t", "api-v2")) == [1])
check("Arabic tags with spaces match", find(tok("t", "تكلفة سحابية")) == [3])
check("a search word can't match the scope column", not db.execute("SELECT 1 FROM pages_fts WHERE pages_fts MATCH ?", ("{title summary tags body}:" + tok("p", "prj_01AAB"),)).fetchone())
def index(page):
    db.execute("DELETE FROM pages_fts_map WHERE page_id=?", (page,)); return db.execute("INSERT INTO pages_fts_map(page_id) VALUES(?)", (page,)).lastrowid
db.execute("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g2','p1','z','T','a1',1,1)")
a, b, c = index("g1"), index("g2"), index("g2"); db.execute("DELETE FROM pages_fts_map"); d = index("g1")
check("search rowids only go up, so order is newest first", a < b < c < d)

db = fresh()
db.execute("INSERT INTO page_tags VALUES('g1','t','p1',1)"); db.execute("UPDATE pages SET updated_at=77")
check("tag order follows the page", db.execute("SELECT sort_at FROM page_tags").fetchone()[0] == 77)
check("an agent comment needs an agent", not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,author_type,body,created_at) VALUES('c','g1','p1','c',1,'agent','x',1)"))
sys.exit(1 if fails else 0)
