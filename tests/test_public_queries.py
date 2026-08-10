import re
import sqlite3
from pathlib import Path


def test_public_d1_queries_compile_against_authoritative_migration() -> None:
    source = Path("apps/api/src/index.ts").read_text()
    queries = re.findall(r'env\.DB\.prepare\(\n\s*"([^"]+)"', source)
    connection = sqlite3.connect(":memory:")
    connection.executescript(Path("database/migrations/0001_initial.sql").read_text())

    for query in queries:
        bindings = tuple("TEST" for _ in range(query.count("?")))
        connection.execute(query, bindings).fetchall()

    assert len(queries) == 15
