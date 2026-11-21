"""Compare saved inventory reports offline; never open their source databases."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

CORE_FIELDS = ("command_id", "call_session_id", "call_device_id", "call_id", "sms_task_id", "sms_device_id", "registry_command_type", "registry_owner_type", "registry_owner_id", "registry_device_id")

TABLES = {"gateway": {"sms_command": ("command_id", "task_id", "payload", "error"), "sms_task": ("task_id", "command_id", "payload", "state", "emitted")}, "ledger": {"acknowledgments": ("id", "error", "created", "command_type", "payload"), "config": ("key", "value")}}


def read_file(path):
    with Path(path).open("rb") as source:
        data = source.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("report exceeds 64 MiB limit")
    return data.decode("utf-8"), {"path": str(Path(path).resolve()), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def object_(value, label):
    if not isinstance(value, dict):
        raise ValueError(label + " must be an object")
    return value


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key: " + key)
            result[key] = value
        return result
    def constant(value):
        raise ValueError("invalid JSON constant: " + value)
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def compare(core_path, android_path, allow_partial=False):
    text, core_file = read_file(core_path)
    android_text, android_file = read_file(android_path)
    records = [strict_json(line) for line in text.splitlines() if line.strip()]
    if not records:
        raise ValueError("empty Core report")
    for record in records:
        object_(record, "Core record")
    meta = records[0]
    if meta.get("type") != "metadata" or type(meta.get("version")) is not int or meta["version"] != 1 or not isinstance(meta.get("limitations"), list) or not all(isinstance(x, str) for x in meta["limitations"]):
        raise ValueError("invalid Core metadata/version")
    core_rows = []
    status = None
    issues = []
    for record in records[1:]:
        if record.get("type") == "row" and status is None:
            row = object_(record.get("row"), "Core row")
            if any(field not in row for field in CORE_FIELDS):
                issues.append("Core row selected fields incomplete: " + str(len(core_rows)))
            if not isinstance(row.get("command_id"), str) or any(row.get(field) is not None and not isinstance(row.get(field), str) for field in CORE_FIELDS[1:]):
                issues.append("Core row has invalid field types: " + str(len(core_rows)))
            core_rows.append(row)
        elif record.get("type") == "status" and status is None:
            status = record
        else:
            raise ValueError("invalid Core record ordering/type")
    if status is None:
        issues.append("Core terminal status missing")
    else:
        if type(status.get("complete")) is not bool or type(status.get("rows")) is not int or status["rows"] < 0 or not isinstance(status.get("errors"), list):
            raise ValueError("invalid Core status")
        if status["rows"] != len(core_rows):
            issues.append("Core terminal row count mismatch")
        if not {"reason", "continuation"}.issubset(status) or not status["complete"] or status.get("reason") is not None or status.get("continuation") is not None or status["errors"]:
            issues.append("Core status does not establish completion")
    report = object_(strict_json(android_text), "Android report")
    if report.get("format") != "command-inventory-v1":
        raise ValueError("invalid Android format/version")
    sources = object_(report.get("sources"), "Android sources")
    if report.get("selected_columns_read") is not True:
        issues.append("Android selected columns incomplete")
    if report.get("quiescence") != "caller_asserted_not_verified" or report.get("cross_database_atomic_snapshot") != "not_established":
        issues.append("Android snapshot metadata missing or unexpected")
    android_rows = []
    for source_name, tables in TABLES.items():
        source = object_(sources.get(source_name), "Android source")
        fingerprint = source.get("file")
        if not isinstance(fingerprint, dict):
            fingerprint = {}
        digest = fingerprint.get("sha256")
        if (not isinstance(source.get("path"), str) or not source.get("path") or type(source.get("user_version")) is not int or source.get("row_provenance") != "report_array_index_only" or source.get("schema_validity") != "not_verified" or source.get("integrity") != "not_checked" or not isinstance(source.get("sidecars"), dict) or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or any(type(fingerprint.get(k)) is not int for k in ("size", "mtime_ns", "device", "inode"))):
            issues.append("Android source metadata incomplete: " + source_name)
        sidecars = source.get("sidecars")
        if not isinstance(sidecars, dict) or set(sidecars) != {"-wal", "-journal", "-shm"} or any(value is not None and (not isinstance(value, dict) or any(type(value.get(k)) is not int for k in ("size", "mtime_ns", "device", "inode")) or value.get("size", -1) < 0 or (key != "-shm" and value.get("size") != 0)) for key, value in (sidecars.items() if isinstance(sidecars, dict) else [])):
            issues.append("Android sidecar metadata incomplete or contradictory: " + source_name)
        table_data = object_(source.get("tables"), "Android tables")
        for table, columns in tables.items():
            entry = object_(table_data.get(table), "Android table " + table)
            rows = entry.get("rows")
            if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                raise ValueError("invalid Android rows: " + table)
            selected = entry.get("columns")
            if entry.get("status") != "complete" or entry.get("missing_columns") != [] or not isinstance(selected, list) or not all(isinstance(c, str) for c in selected) or sorted(selected) != sorted(columns):
                issues.append("Android selected coverage incomplete: " + source_name + "." + table)
            field = {"sms_command": "command_id", "sms_task": "command_id", "acknowledgments": "id"}.get(table)
            for index, row in enumerate(rows):
                if any(col not in row for col in columns):
                    issues.append("Android row coverage incomplete: " + source_name + "." + table + "[" + str(index) + "]")
                if field:
                    android_rows.append({"source": source_name, "table": table, "row_index": index, "field": field, "field_present": field in row, "value": row.get(field)})
    if issues and not allow_partial:
        raise ValueError("incomplete input: " + "; ".join(issues))
    groups = {}
    unknown = {"core": [], "android": []}
    core = [{"row_index": i, "field": "command_id", "field_present": "command_id" in row, "value": row.get("command_id"), "row": row} for i, row in enumerate(core_rows)]
    for side, occurrences in (("core", core), ("android", android_rows)):
        for occurrence in occurrences:
            value = occurrence["value"]
            if not isinstance(value, str):
                unknown[side].append(occurrence)
            else:
                groups.setdefault(value, {"core": [], "android": []})[side].append(occurrence)
    observations = []
    for value, group in sorted(groups.items()):
        cross_table = any(item["row"].get("call_session_id") is not None and item["row"].get("sms_task_id") is not None for item in group["core"])
        multiple = len(group["core"]) > 1 or len(group["android"]) > 1
        observations.append({"command_id": value, "observation": "overlap" if group["core"] and group["android"] else ("core_only_observed" if group["core"] else "android_only_observed"), "core_cross_table_overlap": cross_table, "multiple_occurrences": multiple, "ambiguous": multiple or cross_table, **group})
    source_metadata = {name: {**{k: v for k, v in source.items() if k != "tables"}, "tables": {table: {k: v for k, v in entry.items() if k != "rows"} for table, entry in source["tables"].items()}} for name, source in sources.items() if name in TABLES}
    return {"format": "command-inventory-comparison-v1", "coverage": "partial" if issues else "reported_selected_fields_complete", "coverage_issues": issues, "limitations": ["Report byte hashes are not authentication.", "One-sided observations do not establish absence elsewhere.", "Exact equality does not establish common device, generation, ownership, collision consequences or safety.", "Source snapshots may differ in time; Android in-memory and other histories are not covered."], "inputs": {"core": {"report_file": core_file, "metadata": meta, "status": status}, "android": {"report_file": android_file, "source_metadata": source_metadata, "quiescence": report.get("quiescence"), "cross_database_atomic_snapshot": report.get("cross_database_atomic_snapshot"), "selected_columns_read": report.get("selected_columns_read")}}, "observations": observations, "unmatchable": unknown}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True)
    parser.add_argument("--android", required=True)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.core, args.android, args.allow_partial), indent=2, ensure_ascii=True, allow_nan=False))
    except (OSError, ValueError, UnicodeError) as exc:
        print("comparison failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
