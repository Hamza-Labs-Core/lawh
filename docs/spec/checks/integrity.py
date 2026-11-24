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
      INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at,current_version) VALUES('g1','p1','s','T','a1',1,1,1);
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
check("purge after 30 days, in order", batch(db, "DELETE FROM decision_answers", "DELETE FROM decision_revisions", "DELETE FROM decisions", "DELETE FROM page_versions", "DELETE FROM pages"))

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
for i in range(150): db.execute("INSERT INTO pages_fts(rowid,scope,title) VALUES(?,?,?)", (i + 2, "prjp1 stdraft", "storage"))
db.execute("INSERT INTO pages_fts(rowid,scope,title) VALUES(1,'prjp2 stdraft tagcost','storage')")
hit = db.execute("SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'scope:prjp2 AND {title summary tags body}:stor*' ORDER BY rowid DESC LIMIT 100").fetchall()
check("project filter applies before the limit", hit == [(1,)])
check("a search word can't match the scope column", not db.execute("SELECT 1 FROM pages_fts WHERE pages_fts MATCH '{title summary tags body}:prjp2'").fetchone())

db = fresh()
db.execute("INSERT INTO page_tags VALUES('g1','t','p1',1)"); db.execute("UPDATE pages SET updated_at=77")
check("tag order follows the page", db.execute("SELECT sort_at FROM page_tags").fetchone()[0] == 77)
check("an agent comment needs an agent", not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,author_type,body,created_at) VALUES('c','g1','p1','c',1,'agent','x',1)"))
sys.exit(1 if fails else 0)
