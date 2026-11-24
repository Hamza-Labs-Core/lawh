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
      INSERT INTO members(id,name,role,created_at,joined_at) VALUES('o','Owner','owner',1,1);
      INSERT INTO agents VALUES('a1','o','bot','x',1,NULL);
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

ANS = "INSERT INTO decision_answers VALUES('d1',?,?,?,?,5,'o')"
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
C = "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES(?,'g1','p1','c1',1,'o',5,'x',1)"
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
OLD, SOON = NOW - DAY, NOW + DAY
# Sign-in. 'm' is a member who joined, 'x' is invited, 'r' is another member.
def people(db):
    db.executescript(f"""
      INSERT INTO members(id,name,created_by,created_at,joined_at) VALUES('m','Mona','o',1,1),('r','Rami','o',1,1),('x','New','o',1,NULL);
      INSERT INTO teams VALUES('t1','Design',1),('t2','Ops',1);
      INSERT INTO team_projects VALUES('t1','p1'),('t2','p2');
    """)
def link(tok, kind, member, by, exp=SOON): return batch(db, ("INSERT INTO access_links VALUES(?,?,?,?,1,?,NULL)", (tok, kind, member, by, exp)))
def passkey(cred, member, lnk=None, sess=None): return batch(db, ("INSERT INTO passkeys(credential_id,member_id,public_key,sign_count,label,created_at,link_id,session_id) VALUES(?,?,x'00',0,'n',1,?,?)", (cred, member, lnk, sess)))
def session(tok, member, pk=None, approval=None): return batch(db, ("INSERT INTO sessions VALUES(?,?,'l',1,1,?,?,?)", (tok, member, SOON, pk, approval)))
def pending(i, exp=SOON): return batch(db, ("INSERT INTO device_approvals(id,code_hmac,secret_sha256,label,created_at,expires_at) VALUES(?,?,'s','l',1,?)", (i, i, exp)))
def approve(i, member, sess): return batch(db, ("UPDATE device_approvals SET approved_at=1,member_id=?,approver_session=? WHERE id=?", (member, sess, i)))
def keys(m): return [r[0] for r in db.execute("SELECT credential_id FROM passkeys WHERE member_id=? ORDER BY 1", (m,))]
def count(t, m): return db.execute(f"SELECT count(*) FROM {t} WHERE member_id=?", (m,)).fetchone()[0]
people(db)
check("a second owner is refused", not batch(db, "UPDATE members SET role='owner' WHERE id='m'"))
check("the owner can't be removed", not batch(db, "UPDATE members SET removed_at=1 WHERE id='o'"))
check("ownership moves in one batch", batch(db, "UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='m'")
      and batch(db, "UPDATE members SET role='member' WHERE id='m'", "UPDATE members SET role='owner' WHERE id='o'"))
check("an owner link is refused for a member", not link('bad', 'owner', 'm', None))
check("an invite is refused for someone who joined", not link('bad', 'invite', 'm', 'o'))
check("a reset is refused for someone who hasn't joined", not link('bad', 'reset', 'x', 'o'))
check("a member can't make a reset link", not link('bad', 'reset', 'r', 'm'))
check("a member can't make a link for the owner", not link('bad', 'reset', 'o', 'm'))
check("a member can't re-link someone else's invite", not link('bad', 'invite', 'x', 'm'))
check("setup links work", link('L', 'owner', 'o', None) and link('Lm', 'reset', 'm', 'o') and link('Lx', 'invite', 'x', 'o'))
check("one live link per member", not link('Lx2', 'invite', 'x', 'o'))
check("a passkey needs a source", not passkey('bad', 'o'))
check("an unknown link is refused", not passkey('bad', 'o', 'none'))
check("a link works only for its own member", not passkey('bad', 'o', 'Lx') and not passkey('bad', 'r', 'Lm'))
check("someone who hasn't joined can't have a session", not session('bad', 'x', None, None))
check("the owner joins", passkey('o1', 'o', 'L') and session('so', 'o', 'o1'))
check("the invited person joins", passkey('x1', 'x', 'Lx') and db.execute("SELECT joined_at FROM members WHERE id='x'").fetchone()[0] > 1)
check("a used link is refused and changes nothing", not passkey('bad', 'x', 'Lx') and keys('x') == ['x1'])
check("a member joins from a reset", passkey('m1', 'm', 'Lm') and session('sm', 'm', 'm1'))
check("a session can't use someone else's passkey", not session('bad', 'o', 'm1'))
check("a session adds a passkey for its own member only", passkey('m2', 'm', None, 'sm') and not passkey('bad', 'o', None, 'sm'))
check("an expired link is refused and changes nothing", batch(db, "DELETE FROM access_links WHERE token_sha256='Lm'") and link('late', 'reset', 'm', 'o', OLD) and not passkey('bad', 'm', 'late') and keys('m') == ['m1', 'm2'])
check("an approval can't be created already given", not batch(db, f"INSERT INTO device_approvals VALUES('bad','b','s','l',1,{SOON},1,NULL,'o','so')"))
pending('wait'); pending('good'); pending('gone', OLD); pending('old')
check("approving needs a session of that member", not approve('good', 'o', 'sm') and not approve('good', 'o', 'nope'))
check("a device is approved", approve('good', 'm', 'sm') and approve('gone', 'm', 'sm') and approve('old', 'm', 'sm'))
check("an approval can't be given twice", not approve('good', 'o', 'so'))
check("an approval not yet given is refused", not session('bad', 'm', None, 'wait'))
check("an expired approval is refused", not session('bad', 'm', None, 'gone'))
check("an approval that doesn't exist is refused", not session('bad', 'm', None, 'nope'))
check("an approval signs in only its own member", not session('bad', 'o', None, 'good'))
check("a good approval works once", session('sa', 'm', None, 'good') and not session('bad', 'm', None, 'good'))
db.execute("DELETE FROM sessions WHERE token_sha256='sa'")
check("and not again after that session ends", not session('bad', 'm', None, 'good'))
check("removing a passkey ends its sessions", batch(db, "DELETE FROM passkeys WHERE credential_id='m1'") and count('sessions', 'm') == 0)
db.execute("INSERT INTO auth_challenges VALUES('ch','register','m','c',1)")
session('sp', 'm', 'm2'); pending('dev'); approve('dev', 'm', 'sp'); session('sd', 'm', None, 'dev')
db.execute("UPDATE sessions SET expires_at=1 WHERE token_sha256='sp'")
check("an expired session can't add a passkey or approve a device", not passkey('bad', 'm', None, 'sp') and not approve('wait', 'm', 'sp'))
check("a reset leaves only the new passkey", batch(db, "DELETE FROM access_links WHERE member_id='m' AND used_at IS NULL") and link('Lm2', 'reset', 'm', 'o') and session('sm2', 'm', 'm2') and passkey('m3', 'm', 'Lm2') and keys('m') == ['m3'])
check("a reset ends the member's sessions, approvals and challenges", count('sessions', 'm') + count('device_approvals', 'm') + count('auth_challenges', 'm') == 0)
check("a session that ended can't add a passkey", not passkey('bad', 'm', None, 'sm2'))
check("a session that ended can't approve a device", not approve('wait', 'm', 'sm2'))
check("a reset leaves other people alone", keys('o') == ['o1'] and keys('x') == ['x1'] and count('sessions', 'o') == 1)

# Teams
db = fresh(); people(db)
def put_in(team, member, level, by): return batch(db, ("INSERT INTO team_members VALUES(?,?,?,?,1)", (team, member, level, by)))
def set_level(team, member, level, by): return batch(db, ("UPDATE team_members SET level=?,set_by=? WHERE team_id=? AND member_id=?", (level, by, team, member)))
def level(m, p): return db.execute("SELECT MAX(level) FROM project_access WHERE member_id=? AND project_id=?", (m, p)).fetchone()[0]
AM = "INSERT INTO decision_answers VALUES('d1',?,1,'a','',5,?)"
CM = "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES(?,'g1','p1',?,1,?,?,'x',1)"
check("no team, no access", level('m', 'p1') is None and not batch(db, (AM, (1, 'm'))) and not batch(db, (CM, ('q', 'q', 'm', 2))))
check("a member can't add people", not put_in('t1', 'r', 1, 'm'))
check("the owner makes a manager", put_in('t1', 'm', 4, 'o') and level('m', 'p1') == 4)
check("access stops at the team's projects", level('m', 'p2') is None)
check("a manager adds a viewer", put_in('t1', 'r', 1, 'm'))
check("a manager can't make a manager", not set_level('t1', 'r', 4, 'm') and not put_in('t1', 'x', 4, 'm'))
check("a manager can't add people to another team", not put_in('t2', 'r', 1, 'm'))
check("a manager can't change a manager", set_level('t1', 'r', 4, 'o') and not set_level('t1', 'r', 1, 'm') and set_level('t1', 'r', 1, 'o'))
check("someone can't raise their own level", not set_level('t1', 'r', 3, 'r'))
check("a membership can't be moved to another team", not batch(db, "UPDATE team_members SET team_id='t2',set_by='o' WHERE member_id='r'"))
check("the owner is in no team", not put_in('t1', 'o', 1, 'o'))
check("a viewer can't answer or comment", not batch(db, (AM, (1, 'r'))) and not batch(db, (CM, ('q', 'q', 'r', 1))) and not batch(db, (CM, ('q', 'q', 'r', 2))))
check("a commenter comments but can't answer", set_level('t1', 'r', 2, 'm') and batch(db, (CM, ('q', 'q', 'r', 2))) and not batch(db, (AM, (1, 'r'))))
check("a comment can't claim a higher level", not batch(db, (CM, ('q2', 'q', 'r', 3))))
check("a decider answers", set_level('t1', 'r', 3, 'm') and batch(db, (AM, (1, 'r'))))
check("earlier comments keep the level they had", db.execute("SELECT author_level FROM comments WHERE id='q'").fetchone()[0] == 2)
check("the highest level of several teams counts", batch(db, "INSERT INTO team_projects VALUES('t2','p1')") and put_in('t2', 'r', 1, 'o') and level('r', 'p1') == 3)
check("someone invited has no access before joining", put_in('t1', 'x', 3, 'm') and level('x', 'p1') is None)
KEY = "SELECT 1 FROM agent_key_projects kp CROSS JOIN project_access x ON x.member_id=? AND x.project_id=kp.project_id AND x.level=4 WHERE kp.key_id=? AND kp.project_id=?"
db.executescript("INSERT INTO agents VALUES('am','m','mbot','x',1,NULL); INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('km','am','h','[]',1,9); INSERT INTO agent_key_projects VALUES('km','p1'),('km','p2')")
def key_ok(p): return db.execute(KEY, ('m', 'km', p)).fetchone() is not None
check("a manager's key works only where they manage", key_ok('p1') and not key_ok('p2'))
check("and stops when they no longer manage", set_level('t1', 'm', 3, 'o') and not key_ok('p1') and set_level('t1', 'm', 4, 'o') and key_ok('p1'))
batch(db, "INSERT INTO members(id,name,created_by,created_at) VALUES('y','Later','m',1)"); link('Ly', 'invite', 'y', 'm')
link('Lm', 'reset', 'm', 'o'); passkey('m1', 'm', 'Lm'); session('sm', 'm', 'm1'); pending('dev'); approve('dev', 'm', 'sm')
session('sd', 'm', None, 'dev'); pending('dev2'); approve('dev2', 'm', 'sm'); link('Lm2', 'reset', 'm', 'o')
db.execute("INSERT INTO auth_challenges VALUES('ch','register','m','c',1)")
OWNED = ('team_members', 'passkeys', 'sessions', 'device_approvals', 'auth_challenges', 'access_links')
check("the member has one of everything", all(count(t, 'm') for t in OWNED))
check("removing a member ends everything they had", batch(db, "UPDATE members SET removed_at=5 WHERE id='m'") and level('m', 'p1') is None
      and not any(count(t, 'm') for t in OWNED))
check("it revokes their agents' keys", db.execute("SELECT revoked_at FROM agent_keys WHERE id='km'").fetchone()[0] == 5)
check("it cancels their unused invites", not db.execute("SELECT 1 FROM access_links WHERE token_sha256='Ly'").fetchone())
check("a removed member can't come back, join a team or get a link", not batch(db, "UPDATE members SET removed_at=NULL WHERE id='m'") and not put_in('t1', 'm', 1, 'o') and not link('bad', 'reset', 'm', 'o') and not session('bad', 'm', 'm1'))
check("answers of a removed member stay", batch(db, "UPDATE members SET removed_at=5,name='' WHERE id='r'") and db.execute("SELECT member_id FROM decision_answers").fetchone()[0] == 'r')
check("deleting a team removes its access", batch(db, "DELETE FROM teams WHERE id='t1'") and not db.execute("SELECT 1 FROM team_members WHERE team_id='t1'").fetchone())

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
check("a comment needs an author", not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,body,created_at) VALUES('c','g1','p1','c',1,'x',1)"))
sys.exit(1 if fails else 0)
