"""The migrations must build exactly docs/spec/schema.sql, with no rows. Run: python3 scripts/check_migrations.py"""
import pathlib, re, sqlite3, sys

root = pathlib.Path(__file__).parent.parent
bad = []

entries = sorted((root / "migrations").iterdir())
for f in entries:
    if not f.is_file() or not re.fullmatch(r"[0-9]{4}_[a-z0-9_]+\.sql", f.name): sys.exit(f"FAIL {f.name} isn't a migration file name")
if [int(f.name[:4]) for f in entries] != list(range(1, len(entries) + 1)) or not entries: sys.exit("FAIL migration numbers have a gap or repeat")

def build(scripts):
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys=ON")
    # D1 refuses transactions in a migration. SQLite's own parser says which statements are some.
    def allow(action, *_):
        if action in (sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_SAVEPOINT): bad.append("a transaction statement")
        return sqlite3.SQLITE_OK
    db.set_authorizer(allow)
    for s in scripts: db.executescript(s)
    db.set_authorizer(None)
    return db

def objects(db): return {(t, n): " ".join((sql or "").split()) for t, n, sql in db.execute("SELECT type,name,sql FROM sqlite_master")}

read = lambda f: f.read_text(encoding="utf-8")
want = objects(build([read(root / "docs/spec/schema.sql")]))
db = build([read(f) for f in entries])
have = objects(db)
bad += [f"{t} {n} differs between migrations/ and docs/spec/schema.sql" for t, n in sorted(want.keys() | have.keys()) if want.get((t, n)) != have.get((t, n))]
# A new copy must start empty: above all, with every switch off. Search-index tables hold their own bookkeeping.
bad += [f"{n} has rows" for t, n in have if t == "table" and (n == "pages_fts_map" or not n.startswith(("pages_fts_", "sqlite_"))) and db.execute(f"SELECT 1 FROM {n} LIMIT 1").fetchone()]
bad += ["foreign keys don't hold"] if db.execute("PRAGMA foreign_key_check").fetchone() else []
for b in bad: print("FAIL", b)
if not bad: print(f"ok   {len(entries)} migration(s) build the {len(want)} objects of schema.sql, empty")
sys.exit(1 if bad else 0)
