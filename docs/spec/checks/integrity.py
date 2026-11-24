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
      INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1); UPDATE members SET joined_at=1;
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
db.execute("UPDATE pages SET deleted_at=NULL"); db.execute(C, ("c1",)); db.execute(C, ("c2",)); db.execute("UPDATE pages SET deleted_at=?", (NOW - 31 * DAY,))
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
      INSERT INTO members(id,name,created_by,created_at) VALUES('m','Mona','o',1),('r','Rami','o',1),('x','New','o',1);
      UPDATE members SET joined_at=1 WHERE id IN ('m','r');
      INSERT INTO teams VALUES('t1','Design',1),('t2','Ops',1);
      INSERT INTO team_projects VALUES('t1','p1'),('t2','p2');
    """)
def link(tok, kind, member, by, exp=SOON, to=('t1', 2)): return batch(db, ("INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES(?,?,?,?,1,?,?,?)", (tok, kind, member, by, exp, *(to if kind == 'invite' else (None, None)))))
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
check("ownership can't move to someone who hasn't joined", not batch(db, "UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='x'"))
db = fresh(); people(db)
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
check("an invited person is in no team yet", not count('team_members', 'x'))
check("a link's details can't change", not batch(db, "UPDATE access_links SET level=4 WHERE token_sha256='Lx'") and not batch(db, "UPDATE access_links SET used_at=NULL,expires_at=expires_at+1 WHERE token_sha256='Lx'"))
check("the invited person joins", passkey('x1', 'x', 'Lx') and db.execute("SELECT joined_at FROM members WHERE id='x'").fetchone()[0] > 1)
check("joining adds the team and level of the invite", db.execute("SELECT team_id,level,set_by FROM team_members WHERE member_id='x'").fetchall() == [('t1', 2, 'o')])
check("a used link can't be reopened", not batch(db, "UPDATE access_links SET used_at=NULL WHERE token_sha256='Lx'"))
check("a used link is refused and changes nothing", not passkey('bad', 'x', 'Lx') and keys('x') == ['x1'])
check("a member joins from a reset", passkey('m1', 'm', 'Lm') and session('sm', 'm', 'm1'))
check("a session can't use someone else's passkey", not session('bad', 'o', 'm1'))
check("a session adds a passkey for its own member only", passkey('m2', 'm', None, 'sm') and not passkey('bad', 'o', None, 'sm'))
check("an expired link is refused and changes nothing", batch(db, "DELETE FROM access_links WHERE token_sha256='Lm'") and link('late', 'reset', 'm', 'o', OLD) and not passkey('bad', 'm', 'late') and keys('m') == ['m1', 'm2'])
check("an approval can't be created already given", not batch(db, f"INSERT INTO device_approvals VALUES('bad','b','s','l',1,{SOON},1,NULL,'o','so')"))
check("an approval can't be created already used", not batch(db, f"INSERT INTO device_approvals VALUES('bad','b','s','l',1,{SOON},NULL,1,NULL,NULL)"))
pending('wait'); pending('good'); pending('gone', OLD); pending('old')
check("approving needs a session of that member", not approve('good', 'o', 'sm') and not approve('good', 'o', 'nope'))
check("a device is approved", approve('good', 'm', 'sm') and approve('old', 'm', 'sm'))
check("an expired approval can't be given or revived", not approve('gone', 'm', 'sm') and not batch(db, ("UPDATE device_approvals SET approved_at=1,member_id='m',approver_session='sm',expires_at=? WHERE id='gone'", (SOON,))))
check("an approval can't be extended or used before it is given", not batch(db, "UPDATE device_approvals SET expires_at=expires_at+1 WHERE id='good'") and not batch(db, "UPDATE device_approvals SET used_at=1 WHERE id='wait'"))
check("an approval can't be given twice", not approve('good', 'o', 'so'))
check("an approval not yet given is refused", not session('bad', 'm', None, 'wait'))
pending('short', int(time.time() * 1000) + 300); approve('short', 'm', 'sm'); time.sleep(1.5)
check("an expired approval is refused", count('device_approvals', 'm') == 3 and not session('bad', 'm', None, 'short'))
check("an approval that doesn't exist is refused", not session('bad', 'm', None, 'nope'))
check("an approval signs in only its own member", not session('bad', 'o', None, 'good'))
check("a good approval works once", session('sa', 'm', None, 'good') and not session('bad', 'm', None, 'good'))
db.execute("DELETE FROM sessions WHERE token_sha256='sa'")
check("and not again after that session ends", not batch(db, "UPDATE device_approvals SET used_at=NULL WHERE id='good'") and not session('bad', 'm', None, 'good'))
check("removing a passkey ends its sessions", batch(db, "DELETE FROM passkeys WHERE credential_id='m1'") and count('sessions', 'm') == 0)
check("an approval dies with the session that gave it", not session('bad', 'm', None, 'old'))
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
check("a manager can't make a manager", not set_level('t1', 'r', 4, 'm'))
check("a manager can't add people to another team", not put_in('t2', 'r', 1, 'm'))
check("a manager can't change a manager", set_level('t1', 'r', 4, 'o') and not set_level('t1', 'r', 1, 'm') and set_level('t1', 'r', 1, 'o'))
check("someone can't raise their own level", not set_level('t1', 'r', 3, 'r'))
check("a membership can't be moved to another team", not batch(db, "UPDATE team_members SET team_id='t2',set_by='o' WHERE member_id='r'"))
check("the owner is in no team", not put_in('t1', 'o', 1, 'o'))
check("someone invited can't be put in a team before joining", not put_in('t1', 'x', 1, 'o'))
check("a viewer can't answer or comment", not batch(db, (AM, (1, 'r'))) and not batch(db, (CM, ('q', 'q', 'r', 1))) and not batch(db, (CM, ('q', 'q', 'r', 2))))
check("a commenter comments but can't answer", set_level('t1', 'r', 2, 'm') and batch(db, (CM, ('q', 'q', 'r', 2))) and not batch(db, (AM, (1, 'r'))))
check("a comment can't claim a higher level", not batch(db, (CM, ('q2', 'q', 'r', 3))))
check("a decider answers", set_level('t1', 'r', 3, 'm') and batch(db, (AM, (1, 'r'))))
check("earlier comments keep the level they had", db.execute("SELECT author_level FROM comments WHERE id='q'").fetchone()[0] == 2)
check("the highest level of several teams counts", batch(db, "INSERT INTO team_projects VALUES('t2','p1')") and put_in('t2', 'r', 1, 'o') and level('r', 'p1') == 3)
KEY = "SELECT 1 FROM agent_key_projects kp CROSS JOIN project_access x ON x.member_id=? AND x.project_id=kp.project_id AND x.level=4 WHERE kp.key_id=? AND kp.project_id=?"
check("a comment stays in its page's project", not batch(db, "INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g2','p2','s','T','a1',1,1)",
      "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('e','g2','p1','e',1,'r',3,'x',1)"))
check("a decision stays in its page's project", not batch(db, "INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES('d9','g1','p2','z',0,1,1)"))
db.execute("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g3','p1','s3','T','a1',1,1)")
check("a reply stays on its thread's page", not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('e','g3','p1','q',1,'r',3,'x',1)")
      and batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('e','g1','p1','q',1,'r',3,'x',1)"))
check("an agent replies but can't start a thread", batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,agent_id,body,created_at) VALUES('e2','g1','p1','q',1,'a1','x',1)")
      and not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,agent_id,body,created_at) VALUES('e3','g1','p1','e3',1,'a1','x',1)"))
check("a comment can't be edited, but can be resolved and deleted", not batch(db, "UPDATE comments SET author_level=5 WHERE id='q'") and not batch(db, "UPDATE comments SET body='y' WHERE id='q'") and batch(db, "UPDATE comments SET resolved_at=1 WHERE id='q'") and batch(db, "UPDATE comments SET deleted_at=1 WHERE id='q'"))
check("no reply in a deleted thread", not batch(db, (CM, ('q4', 'q', 'r', 3))))
db.execute("UPDATE pages SET deleted_at=1 WHERE id='g3'")
check("no comment on a deleted page", not batch(db, "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('e4','g3','p1','e4',1,'r',3,'x',1)"))
check("a manager invites only people they added, to their team, up to decider", batch(db, "INSERT INTO members(id,name,created_by,created_at) VALUES('y','Later','m',1)")
      and not link('bad', 'invite', 'y', 'm', to=('t1', 4)) and not link('bad', 'invite', 'y', 'm', to=('t2', 1)) and not link('bad', 'invite', 'x', 'm') and link('Ly', 'invite', 'y', 'm', to=('t1', 3)))
check("a viewer can't add or invite people", set_level('t1', 'r', 1, 'm') and not batch(db, "INSERT INTO members(id,name,created_by,created_at) VALUES('z','Z','r',1)") and not link('bad', 'invite', 'y', 'r') and set_level('t1', 'r', 3, 'm'))
check("nobody is added already joined, or as a second owner", not batch(db, "INSERT INTO members(id,name,created_by,created_at,joined_at) VALUES('z','Z','o',1,1)") and not batch(db, "INSERT INTO members(id,name,role,created_at) VALUES('z','Z','owner',1)"))
check("an invite stops working when its maker loses the level", set_level('t1', 'm', 3, 'o') and not passkey('y1', 'y', 'Ly') and not count('passkeys', 'y')
      and not batch(db, "DELETE FROM access_links WHERE token_sha256='Ly'", "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES('Ly2','invite','y','m',1,9,'t1',1)") and set_level('t1', 'm', 4, 'o'))
REMOVE = "DELETE FROM team_members WHERE team_id=:t AND member_id=:m AND level<4 AND EXISTS (SELECT 1 FROM team_members b WHERE b.team_id=:t AND b.member_id=:by AND b.level=4)"
def remove(t, m, by): return db.execute(REMOVE, dict(t=t, m=m, by=by)).rowcount
check("a manager removes a member of the team, never a manager", remove('t1', 'm', 'm') == 0 and remove('t1', 'r', 'x') == 0 and remove('t1', 'r', 'm') == 1 and put_in('t1', 'r', 3, 'm'))
for i in range(4): db.execute("INSERT INTO teams VALUES(?,?,1)", (f"c{i}", f"c{i}"))
check("at most 5 teams a person", all(put_in(f"c{i}", 'r', 1, 'o') for i in range(3)) and count('team_members', 'r') == 5 and not put_in('c3', 'r', 1, 'o'))
for i in range(10): db.execute("INSERT INTO projects VALUES(?,?,'N','N',1,NULL)", (f"n{i}", f"n{i}"))
check("at most 10 projects a team", all(batch(db, ("INSERT INTO team_projects VALUES('c3',?)", (f"n{i}",))) for i in range(10)) and not batch(db, "INSERT INTO team_projects VALUES('c3','p1')"))
db.executescript("INSERT INTO agents VALUES('am','m','mbot','x',1,NULL); INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('km','am','h','[]',1,9); INSERT INTO agent_key_projects VALUES('km','p1'),('km','p2')")
def key_ok(p): return db.execute(KEY, ('m', 'km', p)).fetchone() is not None
check("a manager's key works only where they manage", key_ok('p1') and not key_ok('p2'))
check("and stops when they no longer manage", set_level('t1', 'm', 3, 'o') and not key_ok('p1') and set_level('t1', 'm', 4, 'o') and key_ok('p1'))
K = "INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,all_projects,created_at,expires_at) VALUES(?,?,'h','[]',?,1,9)"
check("only the owner's agents get a key for all projects", not batch(db, (K, ('ka', 'am', 1))) and not batch(db, "UPDATE agent_keys SET all_projects=1 WHERE id='km'") and batch(db, (K, ('ka', 'a1', 1))))
check("two people can each have an agent of one name", batch(db, "INSERT INTO agents VALUES('am2','m','bot','x',1,NULL)") and not batch(db, "INSERT INTO agents VALUES('am3','m','bot','x',1,NULL)"))
check("an agent that changes person loses its keys", batch(db, (K, ('kb', 'am2', 0)), "UPDATE agents SET member_id='o',name='bot2' WHERE id='am2'") and db.execute("SELECT revoked_at FROM agent_keys WHERE id='kb'").fetchone()[0])
check("a revoked key stays revoked", not batch(db, "UPDATE agent_keys SET revoked_at=NULL WHERE id='kb'"))
link('Lm', 'reset', 'm', 'o'); passkey('m1', 'm', 'Lm'); session('sm', 'm', 'm1'); pending('dev'); approve('dev', 'm', 'sm')
session('sd', 'm', None, 'dev'); pending('dev2'); approve('dev2', 'm', 'sm'); link('Lm2', 'reset', 'm', 'o')
db.execute("INSERT INTO auth_challenges VALUES('ch','register','m','c',1)")
OWNED = ('team_members', 'passkeys', 'sessions', 'device_approvals', 'auth_challenges', 'access_links')
check("the member has one of everything", all(count(t, 'm') for t in OWNED))
check("removing a member ends everything they had", batch(db, "UPDATE members SET removed_at=5 WHERE id='m'") and level('m', 'p1') is None
      and not any(count(t, 'm') for t in OWNED))
check("it revokes their agents' keys", db.execute("SELECT revoked_at FROM agent_keys WHERE id='km'").fetchone()[0] == 5)
check("it cancels their unused invites", not db.execute("SELECT 1 FROM access_links WHERE token_sha256='Ly'").fetchone() and db.execute("SELECT removed_at FROM members WHERE id='y'").fetchone()[0] == 5)
check("a removed member gets no key", not batch(db, (K, ('kc', 'am', 0))))
check("a removed member can't come back, join a team or get a link", not batch(db, "UPDATE members SET removed_at=NULL WHERE id='m'") and not put_in('t1', 'm', 1, 'o') and not link('bad', 'reset', 'm', 'o') and not session('bad', 'm', 'm1'))
check("answers of a removed member stay", batch(db, "UPDATE members SET removed_at=5,name=NULL WHERE id='r'") and db.execute("SELECT member_id FROM decision_answers").fetchone()[0] == 'r')
check("a name is cleared only after removal", not batch(db, "UPDATE members SET name=NULL WHERE id='o'"))
check("deleting a team removes its access", batch(db, "DELETE FROM teams WHERE id='t1'") and not db.execute("SELECT 1 FROM team_members WHERE team_id='t1'").fetchone())

# Ownership transfer. Agents whose name the new owner already uses get their id added.
MOVE = """UPDATE agents SET member_id='m', name=CASE WHEN EXISTS (SELECT 1 FROM agents b WHERE b.member_id='m' AND b.name=agents.name)
  THEN name || ' ' || id ELSE name END WHERE member_id='o'"""
db = fresh(); people(db); db.execute("INSERT INTO agents VALUES('am','m','bot','x',1,NULL)")
put_in('t1', 'm', 4, 'o'); link('trap', 'reset', 'm', 'o'); link('trap2', 'reset', 'r', 'o'); link('inv', 'invite', 'x', 'o'); link('own', 'owner', 'o', None)
check("ownership moves", batch(db, "UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='m'", MOVE))
check("no link made before it works after it", not any(passkey('bad', w, t) for w, t in (('m', 'trap'), ('r', 'trap2'), ('x', 'inv'), ('o', 'own'))) and not db.execute("SELECT 1 FROM access_links").fetchone())
check("the new owner is in no team and the old one has no access", count('team_members', 'm') == 0 and level('o', 'p1') is None and not batch(db, (AM, (1, 'o'))) and batch(db, (AM, (1, 'm'))))
check("an agent whose name is taken is renamed", db.execute("SELECT name FROM agents WHERE member_id='m' ORDER BY id").fetchall() == [('bot a1',), ('bot',)])
check("people invited by the old owner are cancelled, so none is left without a link", db.execute("SELECT removed_at FROM members WHERE id='x'").fetchone()[0])
check("the old owner's keys stop", db.execute("SELECT revoked_at FROM agent_keys WHERE id='k1'").fetchone()[0])
check("the old owner can't make links", not link('bad', 'reset', 'r', 'o') and link('ok', 'reset', 'r', 'm'))

# Each rule on its own, and beside rows of other people that must not change
def sql(*stmts): return batch(db, *stmts)
def refused(name, *stmts): check(name, not sql(*stmts))
def rows(t, where="1"): return db.execute(f"SELECT * FROM {t} WHERE {where} ORDER BY 1,2").fetchall()
def crowd():
    global db
    db = fresh(); people(db)
    put_in('t1', 'm', 4, 'o'); put_in('t1', 'r', 1, 'o'); put_in('t2', 'r', 4, 'o')
    link('lo', 'owner', 'o', None); passkey('o1', 'o', 'lo'); session('so', 'o', 'o1')
    for w in 'mr':
        link('l' + w, 'reset', w, 'o'); passkey(w + '1', w, 'l' + w); session('s' + w, w, w + '1')
        pending('a' + w); approve('a' + w, w, 's' + w); link('n' + w, 'reset', w, 'o')
        db.execute("INSERT INTO auth_challenges VALUES(?,'register',?,'c',1)", ('c' + w, w))
        db.execute("INSERT INTO agents VALUES(?,?,'bot','x',1,NULL)", ('a' + w, w)); db.execute(K, ('k' + w, 'a' + w, 0))
    db.execute("INSERT INTO members(id,name,created_by,created_at) VALUES('im','By Mona','m',1),('ir','By Rami','r',1)")
    link('vm', 'invite', 'im', 'o'); link('vr', 'invite', 'ir', 'r', to=('t2', 1)); link('vx', 'invite', 'x', 'o')
TABLES = ('sessions', 'passkeys', 'auth_challenges', 'device_approvals', 'team_members', 'access_links')
def others(): return [rows(t, "member_id<>'m' AND member_id<>'im'") for t in TABLES] + [rows('members', "id NOT IN ('m','im')"), rows('agents', "member_id<>'m'"), rows('agent_keys', "agent_id<>'am'")]
crowd(); before = others(); db.execute("UPDATE agent_keys SET revoked_at=3 WHERE id='km'")
check("removal touches nobody else", sql("UPDATE members SET removed_at=5 WHERE id='m'") and others() == before)
check("removal cancels an invite of theirs the owner renewed", not rows('access_links', "member_id='im'") and rows('members', "id='im' AND removed_at=5"))
check("a key revoked earlier keeps its time", rows('agent_keys', "id='km' AND revoked_at=3"))
check("a removal can be saved again unchanged", sql("UPDATE members SET removed_at=5,name=NULL WHERE id='m'"))
crowd(); before = others()
check("a reset touches nobody else", passkey('m9', 'm', 'nm') and others() == before and [keys('m'), count('sessions', 'm')] == [['m9'], 0])
check("a reset keeps the day they joined", rows('members', "id='m' AND joined_at=1"))
crowd(); n = len(rows('team_members')), len(rows('access_links')), others()
check("saving a role unchanged changes nothing", sql("UPDATE members SET role='member' WHERE id='m'") and n == (len(rows('team_members')), len(rows('access_links')), others()))
crowd(); keep = rows('team_members', "member_id='r'"), rows('access_links', "created_by='r' OR used_at IS NOT NULL")
check("transfer leaves other people's teams, links and used links", sql("UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='m'")
      and keep == (rows('team_members', "member_id='r'"), rows('access_links', "created_by='r' OR used_at IS NOT NULL")))
crowd(); sql("UPDATE members SET removed_at=5 WHERE id='r'")
refused("ownership can't move to someone removed", "UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='r'")
check("an agent keeps its keys when its details change", sql("UPDATE agents SET member_id='m',name='n2' WHERE id='am'") and rows('agent_keys', "id='km' AND revoked_at IS NULL"))
crowd(); sql("UPDATE agent_keys SET revoked_at=3 WHERE id='kr'", "UPDATE agents SET member_id='o',name='bot3' WHERE id='ar'")
check("moving an agent revokes only its live keys", rows('agent_keys', "id='kr' AND revoked_at=3") and rows('agent_keys', "id='km' AND revoked_at IS NULL"))
for c, v in (("id", "'z'"), ("created_at", "2"), ("expires_at", "99"), ("agent_id", "'ar'"), ("secret_hmac", "'z'"), ("scopes_json", "'[1]'")): refused(f"a key's {c} can't change", f"UPDATE agent_keys SET {c}={v} WHERE id='km'")
check("a key's last use can change, also after it is revoked", sql("UPDATE agent_keys SET last_used_at=2 WHERE id='kr'") and sql("UPDATE agent_keys SET last_used_at=2 WHERE id='km'"))
sql("INSERT INTO agents VALUES('ax','x','b','x',1,NULL)"); refused("no key for someone who hasn't joined", (K, ('kx', 'ax', 0)))
for c, v in (("token_sha256", "'z'"), ("kind", "'reset',team_id=NULL,level=NULL"), ("member_id", "'im'"), ("created_by", "'r'"), ("team_id", "'t2'")):
    refused(f"a link's {c} can't change", "DELETE FROM access_links WHERE member_id='im'", f"UPDATE access_links SET {c}={v} WHERE token_sha256='vx'")
sql("DELETE FROM access_links WHERE member_id='im'")
refused("only a manager of that team invites to it, even someone they added", ("INSERT INTO members(id,name,created_by,created_at) VALUES('q','Q','r',1)"), "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES('q','invite','q','r',1,9,'t1',1)")
refused("a manager can't invite someone another manager added", "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES('q','invite','im','r',1,9,'t2',1)")
refused("a manager of one team can't set levels in another", "UPDATE team_members SET level=2,set_by='r' WHERE team_id='t1' AND member_id='r'")
refused("a viewer can't add, beside a manager", "INSERT INTO members(id,name,created_by,created_at) VALUES('j','J','o',1)", "UPDATE members SET joined_at=1 WHERE id='j'", "INSERT INTO team_members VALUES('t1','j',1,'r',1)")
refused("a manager adds no manager", "INSERT INTO members(id,name,created_by,created_at) VALUES('j','J','o',1)", "UPDATE members SET joined_at=1 WHERE id='j'", "INSERT INTO team_members VALUES('t1','j',4,'m',1)")
check("a manager adds someone who joined", sql("INSERT INTO members(id,name,created_by,created_at) VALUES('j','J','o',1)", "UPDATE members SET joined_at=1 WHERE id='j'", "INSERT INTO team_members VALUES('t1','j',3,'m',1)"))
refused("a membership can't be given to someone else", "UPDATE team_members SET member_id='x',set_by='o' WHERE team_id='t1' AND member_id='j'")
refused("nobody is added already removed", "INSERT INTO members(id,name,created_by,created_at,removed_at) VALUES('z','Z','o',1,1)")
refused("roles are only owner and member", "UPDATE members SET role='x' WHERE id='m'")
for c in ("id='z'", "code_hmac='z'", "secret_sha256='z'", "approved_at=2", "approver_session='so',member_id='o'", "member_id='o'", "label='z'", "created_at=2", "approver_session='z'"): refused(f"a given approval can't change ({c})", f"UPDATE device_approvals SET {c} WHERE id='ar'")
pending('w'); refused("an approval isn't given and used at once", "UPDATE device_approvals SET approved_at=1,member_id='m',approver_session='sm',used_at=1 WHERE id='w'")
refused("an approval has a member, a time and a session, or none", f"INSERT INTO device_approvals VALUES('b','b','s','l',1,{SOON},NULL,NULL,'m','sm')")
refused("an approval names a session only with a member", f"INSERT INTO device_approvals VALUES('b','b','s','l',1,{SOON},NULL,NULL,NULL,'sm')")
refused("a session has one source", f"INSERT INTO sessions VALUES('b','m','l',1,1,{SOON},'m1','am')")
check("a normal session leaves approvals unused", session('s9', 'm', 'm1') and rows('device_approvals', "id='am' AND used_at IS NULL"))
db.execute("UPDATE sessions SET expires_at=1 WHERE token_sha256='sm'"); refused("an approval dies when its session expires", f"INSERT INTO sessions VALUES('b','m','l',1,1,{SOON},NULL,'am')")
refused("a sign-in challenge names no member", "INSERT INTO auth_challenges VALUES('b','sign_in','m','c',1)")
refused("a register challenge names a member", "INSERT INTO auth_challenges VALUES('b','register',NULL,'c',1)")
refused("challenges have two purposes", "INSERT INTO auth_challenges VALUES('b','other',NULL,'c',1)")
L0 = "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES"
refused("a link can't be created already used", "DELETE FROM access_links", "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,used_at) VALUES('b','reset','m','o',1,9,1)")
refused("an owner link has no maker", "DELETE FROM access_links", L0 + "('b','owner','o','o',1,9,NULL,NULL)")
refused("a reset link has a maker", "DELETE FROM access_links", L0 + "('b','reset','m',NULL,1,9,NULL,NULL)")
refused("an invite needs a team", "DELETE FROM access_links", L0 + "('b','invite','x','o',1,9,NULL,NULL)")
refused("an invite needs a level", "DELETE FROM access_links", L0 + "('b','invite','x','o',1,9,'t1',NULL)")
refused("a reset gives no team", "DELETE FROM access_links", L0 + "('b','reset','m','o',1,9,'t1',1)")
refused("a reset for the owner is refused", "DELETE FROM access_links", L0 + "('b','reset','o','o',1,9,NULL,NULL)")
CC = "INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,agent_id,body,created_at) VALUES"
refused("a comment has one author", CC + "('b','g1','p1','b',1,'o',5,'a1','x',1)")
refused("a person's comment has a level", CC + "('b','g1','p1','b',1,'r',NULL,NULL,'x',1)")
refused("an agent's comment has no level", CC + "('t','g1','p1','t',1,'o',5,NULL,'x',1)", CC + "('b','g1','p1','t',1,NULL,5,'a1','x',1)")
sql(CC + "('t','g1','p1','t',1,'o',5,NULL,'x',1)", CC + "('u','g1','p1','t',1,NULL,NULL,'a1','x',1)")
refused("a reply can't start a thread under a reply", CC + "('b','g1','p1','u',1,'o',5,NULL,'x',1)")
refused("a reply needs its thread to exist", "PRAGMA defer_foreign_keys=ON", CC + "('b','g1','p1','nope',1,'o',5,NULL,'x',1)", CC + "('nope','g1','p1','nope',1,'o',5,NULL,'x',1)")
refused("access in another project doesn't count for a comment", CC + "('b','g1','p1','b',1,'r',4,NULL,'x',1)")
refused("access in another project doesn't count for an answer", (AM, (1, 'r')))
crowd(); check("an old link doesn't work while a newer one is live", not passkey('bad', 'r', 'lr') and keys('r') == ['r1'])
passkey('im1', 'im', 'vm'); kept = rows('access_links', "member_id='im'")
check("removing an inviter keeps people who joined", sql("UPDATE members SET removed_at=5 WHERE id='m'") and rows('members', "id='im' AND removed_at IS NULL") and keys('im') == ['im1'] and kept == rows('access_links', "member_id='im'"))
crowd(); sql("UPDATE members SET removed_at=2 WHERE id='im'")
check("someone with a cancelled invite can be removed, and that invite keeps its time", sql("UPDATE members SET removed_at=5 WHERE id='m'") and rows('members', "id='im' AND removed_at=2"))
crowd(); passkey('im1', 'im', 'vm'); link('ri', 'reset', 'im', 'o'); sql("UPDATE members SET removed_at=5 WHERE id='m'")
check("removing an inviter keeps a reset link of someone who joined", rows('access_links', "token_sha256='ri'"))
crowd(); before = [rows(t) for t in TABLES]
check("saving 'not removed' on an active member changes nothing", sql("UPDATE members SET removed_at=NULL WHERE id='m'") and before == [rows(t) for t in TABLES] and keys('m') == ['m1'])
crowd(); sql("INSERT INTO auth_challenges VALUES('ci','register','im','c',1)", "UPDATE members SET removed_at=5 WHERE id='m'")
check("cancelled invites leave no challenge", not rows('auth_challenges', "member_id='im'"))
crowd(); check("deleting a team cancels its invites only", sql("DELETE FROM teams WHERE id='t2'") and rows('members', "id='ir' AND removed_at IS NOT NULL") and rows('members', "id IN ('im','x') AND removed_at IS NULL") and len(rows('access_links', "member_id IN ('im','x')")) == 2)
passkey('x1', 'x', 'vx'); check("and nobody who joined", sql("DELETE FROM teams WHERE id='t1'") and rows('members', "id='x' AND removed_at IS NULL") and rows('members', "id='im' AND removed_at IS NOT NULL") and keys('x') == ['x1'])
crowd(); sql("UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='m'")
check("transfer keeps other people's invites", rows('members', "id='ir' AND removed_at IS NULL") and rows('access_links', "member_id='ir'") and rows('members', "id IN ('im','x') AND removed_at IS NULL") == [])
crowd(); refused("ownership can't move to someone another person invited", "UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='ir'")
crowd(); sql("INSERT INTO members(id,name,created_by,created_at) VALUES('nl','No link','o',1),('gone','Gone','o',1)", "UPDATE members SET removed_at=2 WHERE id='gone'")
check("transfer cancels who the old owner invited or sent a link to, and changes no earlier cancellation", sql("UPDATE members SET role='member' WHERE id='o'", "UPDATE members SET role='owner' WHERE id='r'")
      and [x[0] for x in db.execute("SELECT id FROM members WHERE removed_at>2 ORDER BY id")] == ['im', 'ir', 'nl', 'x'] and rows('members', "id='gone' AND removed_at=2"))
crowd(); passkey('im1', 'im', 'vm'); sql("INSERT INTO auth_challenges VALUES('z1','register','ir','c',1),('z2','register','im','c',1)")
check("a removal leaves the challenges of other invites and of people who joined", sql("UPDATE members SET removed_at=5 WHERE id='m'") and len(rows('auth_challenges', "id IN ('z1','z2')")) == 2)
refused("a project can't be moved between teams", "UPDATE team_projects SET team_id='t1' WHERE team_id='t2'")
db = sqlite3.connect(":memory:", isolation_level=None); db.executescript(schema); db.execute("PRAGMA foreign_keys=ON")
db.executescript("INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1); INSERT INTO teams VALUES('t1','T',1)")
check("first setup works from empty", link('f', 'owner', 'o', None) and passkey('o1', 'o', 'f') and session('so', 'o', 'o1'))
db.execute("UPDATE members SET joined_at=NULL"); refused("the owner can't be invited", L0 + "('b','invite','o','o',1,9,'t1',1)")
crowd()
# Two pages and two decisions: rules look at their own row only.
db.executescript("""INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('gx','p1','gx','T','a1',1,1),('gy','p2','gy','T','a1',1,1);
  INSERT INTO page_tags VALUES('gx','t','p1',1),('g1','t','p1',1);
  INSERT INTO decisions(id,page_id,project_id,key,position,revision,created_at,updated_at) VALUES('dx','gx','p1','k',0,2,1,1),('dy','gy','p2','k',0,1,1,1);
  INSERT INTO decision_revisions VALUES('dx',1,'Q','','[]',NULL,1,1),('dx',2,'Q','','[]',NULL,1,1),('dy',1,'Q','','[]',NULL,1,1);""")
refused("a version follows its own page's number", "INSERT INTO page_versions VALUES('vb','gx',2,'i','',1,1,'a1','k1',5)")
check("publishing moves only its own page and tags", sql("INSERT INTO page_versions VALUES('vb','gx',1,'i','',1,1,'a1','k1',77)") and rows('pages', "updated_at=77") == rows('pages', "id='gx'") and rows('page_tags', "sort_at=77") == rows('page_tags', "page_id='gx'"))
refused("an answer fits its own decision's revision", "INSERT INTO decision_answers VALUES('dx',1,1,'a','',5,'o')")
check("an answer moves only its own decision", sql("INSERT INTO decision_answers VALUES('dx',1,2,'a','',5,'o')") and rows('decisions', "answer_seq=1") == rows('decisions', "id='dx'"))
refused("a manager of another project can't answer, beside a decision they may answer", "INSERT INTO decision_answers VALUES('dx',2,2,'a','',5,'r')")
check("but answers in their own project", sql("INSERT INTO decision_answers VALUES('dy',1,1,'a','',5,'r')"))
db.execute("UPDATE pages SET deleted_at=1 WHERE id='gy'")
refused("a page deleted elsewhere doesn't let answers go", "DELETE FROM decision_answers WHERE decision_id='dx'")
refused("a live page elsewhere doesn't allow an answer on a deleted one", "INSERT INTO decision_answers VALUES('dy',2,1,'a','',5,'o')")

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

# Connecting an agent
crowd()
def ask(i, exp=SOON): return sql(("INSERT INTO agent_connects(id,code_hmac,secret_sha256,client,machine,created_at,expires_at) VALUES(?,?,'s','claude','laptop',1,?)", (i, i, exp)))
def reply(i, member, sess, agent): return ("UPDATE agent_connects SET answered_at=1,member_id=?,approver_session=?,agent_id=? WHERE id=?", (member, sess, agent, i))
for i in 'uvwxyz': ask(i)
refused("a request can't start already answered", f"INSERT INTO agent_connects VALUES('q','q','s','c','m',1,{SOON},1,'m','sm','am')")
refused("two requests can't have one code", f"INSERT INTO agent_connects(id,code_hmac,secret_sha256,client,machine,created_at,expires_at) VALUES('q','u','s','c','m',1,{SOON})")
refused("no key before the answer", (K, ('u', 'am', 0)))
check("a person connects a new agent in one step", sql("INSERT INTO agents VALUES('new','m','laptop','claude',1,NULL)", reply('u', 'm', 'sm', 'new'), (K, ('u', 'new', 0))))
check("and a second key for an agent they have", sql(reply('v', 'm', 'sm', 'am'), (K, ('v', 'am', 0))) and rows('agent_keys', "id='km' AND revoked_at IS NULL"))
refused("a request gives one key", (K, ('u', 'new', 0)))
refused("an answer can't name someone else's agent", reply('w', 'm', 'sm', 'ar'))
refused("an answer needs the person's own session", reply('w', 'm', 'sr', 'am'))
refused("an answer needs a session", reply('w', 'm', 'nope', 'am'))
sql("UPDATE sessions SET expires_at=1 WHERE token_sha256='sr'"); refused("an answer needs a live session", reply('w', 'r', 'sr', 'ar'))
check("a refused request gives no key and can't be answered again", sql(reply('x', 'm', 'sm', None)) and not sql((K, ('x', 'am', 0))) and not sql(reply('x', 'm', 'sm', 'am')))
check("a key needs the agent that was named", sql(reply('y', 'm', 'sm', 'am')) and not sql((K, ('y', 'new', 0))) and not sql((K, ('y', 'a1', 0))))
ask('late', 1); refused("an expired request can't be answered", reply('late', 'm', 'sm', 'am'))
db.execute("INSERT INTO agent_connects(id,code_hmac,secret_sha256,client,machine,created_at,expires_at) VALUES('slow','slow','s','c','m',1,unixepoch()*1000+1100)")
sql(reply('slow', 'm', 'sm', 'am')); time.sleep(2.2); refused("nor used later", (K, ('slow', 'am', 0)))
for c in ("id='q'", "code_hmac='q'", "secret_sha256='q'", "client='q'", "machine='q'", "created_at=2", "expires_at=expires_at+1"): refused(f"an answer can't change the request ({c})", f"UPDATE agent_connects SET answered_at=1,member_id='m',approver_session='sm',agent_id='am',{c} WHERE id='z'")
refused("an answer can't be changed", reply('u', 'm', 'sm', 'am'))
for v in ("NULL,'m','sm',NULL", "NULL,NULL,'sm',NULL", "NULL,NULL,NULL,'am'"): refused(f"an answer is whole or absent ({v})", f"INSERT INTO agent_connects VALUES('q','q','s','c','m',1,{SOON},{v})")
check("a whole answer is accepted there", sql(reply('z', 'm', 'sm', 'am'), (K, ('z', 'am', 0))))
ask('own'); refused("a member's agent doesn't get all projects by connecting", reply('own', 'm', 'sm', 'am'), (K, ('own', 'am', 1)))
check("the owner's can", sql(reply('own', 'o', 'so', 'a1'), (K, ('own', 'a1', 1))))
check("a disabled agent gets no key", sql("UPDATE agents SET disabled_at=1 WHERE id='am'") and not sql((K, ('dis', 'am', 0))))
check("removing a person revokes connected keys", sql("UPDATE members SET removed_at=9 WHERE id='m'") and rows('agent_keys', "id='u' AND revoked_at=9"))
sys.exit(1 if fails else 0)
