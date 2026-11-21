"""Offline inventory of caller-asserted quiescent, checkpointed SQLite copies."""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

TABLES = {
    "gateway": {"sms_command": ("command_id", "task_id", "payload", "error"),
                "sms_task": ("task_id", "command_id", "payload", "state", "emitted")},
    "ledger": {"acknowledgments": ("id", "error", "created", "command_type", "payload"),
               "config": ("key", "value")},
}
ID_PATTERN = {name: re.compile(prefix + r"_[0-7][0-9A-HJKMNP-TV-Z]{25}\Z")
              for name, prefix in (("command", "cmd"), ("task", "tsk"))}


def encoded(value):
    if isinstance(value, bytes):
        return {"sqlite_blob_base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, float) and not math.isfinite(value):
        return {"sqlite_real": str(value)}
    return value


def fingerprint(path):
    stat = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "device": stat.st_dev, "inode": stat.st_ino, "sha256": digest.hexdigest()}


def check_sidecars(path):
    states = {}
    for suffix in ("-wal", "-journal", "-shm"):
        sidecar = Path(str(path) + suffix)
        try:
            stat = sidecar.lstat()
        except FileNotFoundError:
            states[suffix] = None
            continue
        if sidecar.is_symlink():
            raise ValueError("symlink sidecar refused: " + str(sidecar))
        states[suffix] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                          "device": stat.st_dev, "inode": stat.st_ino}
        if suffix != "-shm" and stat.st_size:
            raise ValueError("nonempty SQLite sidecar: " + str(sidecar))
    return states


def read_source(path, source):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("source is not an existing regular file: " + str(path))
    sidecars_before = check_sidecars(path)
    before = fingerprint(path)
    # immutable avoids SQLite writing or consulting sidecars; WAL must already be checkpointed.
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        tables = {}
        existing = {row[0]: row[1] for row in db.execute(
            "SELECT name,type FROM sqlite_master WHERE type IN ('table','view')")}
        for name, expected in TABLES[source].items():
            if existing.get(name) != "table":
                tables[name] = {"status": "missing_table", "rows": [], "columns": []}
                continue
            columns = [r[1] for r in db.execute('PRAGMA table_xinfo("' + name + '")')]
            selected = [column for column in expected if column in columns]
            missing = [column for column in expected if column not in columns]
            if selected:
                sql = 'SELECT ' + ','.join('"' + col + '"' for col in selected) + ' FROM "' + name + '"'
                rows = [dict(zip(selected, (encoded(v) for v in row))) for row in db.execute(sql)]
            else:
                rows = [{} for _ in db.execute('SELECT 1 FROM "' + name + '"')]
            tables[name] = {"status": "partial" if missing else "complete", "columns": selected,
                            "missing_columns": missing, "other_columns": [c for c in columns if c not in expected],
                            "rows": rows}
    finally:
        db.close()
    sidecars_after = check_sidecars(path)
    after = fingerprint(path)
    if before != after or sidecars_before != sidecars_after:
        raise ValueError("source changed during inspection: " + str(path))
    return {"path": str(path), "user_version": version, "schema_validity": "not_verified",
            "integrity": "not_checked", "row_provenance": "report_array_index_only",
            "file": before, "sidecars": sidecars_before, "tables": tables}


def inventory(gateway, ledger, *, assert_quiescent=False):
    if assert_quiescent is not True:
        raise ValueError("caller must assert that both copies are quiescent and checkpointed")
    sources = {"gateway": read_source(gateway, "gateway"), "ledger": read_source(ledger, "ledger")}
    issues = []
    for source, table, fields in (("gateway", "sms_command", {"command_id": "command", "task_id": "task"}),
                                  ("gateway", "sms_task", {"command_id": "command", "task_id": "task"}),
                                  ("ledger", "acknowledgments", {"id": "command"})):
        data = sources[source]["tables"][table]
        for index, row in enumerate(data["rows"]):
            for field, kind in fields.items():
                if field not in row:
                    continue
                value = row[field]
                # Null task_id on a rejected SMS command is retained and reported as evidence.
                if value is None or not isinstance(value, str) or not ID_PATTERN[kind].fullmatch(value):
                    issues.append({"kind": "null_id" if value is None else "malformed_id", "source": source,
                                   "table": table, "row": index, "field": field, "value": value})
    sms = sources["gateway"]["tables"]["sms_command"]["rows"]
    ack = sources["ledger"]["tables"]["acknowledgments"]["rows"]
    tasks = sources["gateway"]["tables"]["sms_task"]["rows"]
    left = {row["command_id"] for row in sms + tasks if isinstance(row.get("command_id"), str)}
    right = {row["id"] for row in ack if isinstance(row.get("id"), str)}
    collisions = sorted(left & right)
    return {"format": "command-inventory-v1", "quiescence": "caller_asserted_not_verified",
            "cross_database_atomic_snapshot": "not_established", "sources": sources,
            "issues": issues, "cross_database_duplicate_command_ids": collisions,
            "selected_columns_read": all(t["status"] == "complete" for s in sources.values() for t in s["tables"].values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--assert-quiescent", action="store_true", help="assert both copies are quiescent and checkpointed")
    args = parser.parse_args()
    try:
        report = inventory(args.gateway, args.ledger, assert_quiescent=args.assert_quiescent)
        output = json.dumps(report, ensure_ascii=True, indent=2, allow_nan=False)
        print(output)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print("inventory failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
