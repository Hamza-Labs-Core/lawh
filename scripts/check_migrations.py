"""The migrations must build exactly docs/spec/schema.sql. Run: python3 scripts/check_migrations.py"""
import pathlib, sqlite3, sys

root = pathlib.Path(__file__).parent.parent

def objects(*scripts):
    db = sqlite3.connect(":memory:")
    for s in scripts: db.executescript(s)
    return {(t, n): " ".join((sql or "").split()) for t, n, sql in db.execute("SELECT type,name,sql FROM sqlite_master")}

files = sorted((root / "migrations").glob("*.sql"))
numbers = [int(f.name[:4]) for f in files]
if not files or numbers != list(range(1, len(files) + 1)): sys.exit(f"FAIL migration numbers have a gap or repeat: {numbers}")
want = objects((root / "docs/spec/schema.sql").read_text())
have = objects(*(f.read_text() for f in files))
bad = sorted(k for k in want.keys() | have.keys() if want.get(k) != have.get(k))
for k in bad: print("FAIL", *k, "differs between migrations/ and docs/spec/schema.sql")
if not bad: print(f"ok   {len(files)} migration(s) build the {len(want)} objects of schema.sql")
sys.exit(1 if bad else 0)
