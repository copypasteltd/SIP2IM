import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import compare_command_inventories as cmp


def android():
    sources = {}
    for source, tables in cmp.TABLES.items():
        entries = {name: {"status": "complete", "columns": list(cols), "missing_columns": [], "rows": []} for name, cols in tables.items()}
        sources[source] = {"path": source, "user_version": 1, "schema_validity": "not_verified", "integrity": "not_checked", "row_provenance": "report_array_index_only", "file": {"size": 1, "mtime_ns": 1, "device": 1, "inode": 1, "sha256": "a" * 64}, "sidecars": {"-wal": None, "-journal": None, "-shm": None}, "tables": entries}
    return {"format": "command-inventory-v1", "quiescence": "caller_asserted_not_verified", "cross_database_atomic_snapshot": "not_established", "selected_columns_read": True, "sources": sources}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.core, self.android = (Path(self.tmp.name) / x for x in ("core.ndjson", "android.json"))
        self.records = [{"type": "metadata", "version": 1, "limitations": ["limited"]}] + [{"type": "row", "row": {field: (x if field == "command_id" else None) for field in cmp.CORE_FIELDS}} for x in ("A", "A", "a", "", "C")] + [{"type": "status", "complete": True, "rows": 5, "reason": None, "continuation": None, "errors": []}]
        self.report = android()
        cols = cmp.TABLES["gateway"]["sms_command"]
        self.report["sources"]["gateway"]["tables"]["sms_command"]["rows"] = [{k: (value if k == "command_id" else None) for k in cols} for value in ("A", "B", "", 3)]
        self.save()

    def save(self):
        self.core.write_text("\n".join(map(json.dumps, self.records)), encoding="utf-8")
        self.android.write_text(json.dumps(self.report), encoding="utf-8")

    def test_exact_occurrences(self):
        result = cmp.compare(self.core, self.android)
        obs = {x["command_id"]: x for x in result["observations"]}
        self.assertTrue(obs["A"]["ambiguous"])
        self.assertEqual(len(obs["A"]["core"]), 2)
        self.assertEqual(obs[""]["observation"], "overlap")
        self.assertEqual(obs["a"]["observation"], "core_only_observed")
        self.assertEqual(obs["B"]["observation"], "android_only_observed")
        self.assertEqual(result["unmatchable"]["android"][0]["value"], 3)
        self.assertEqual(result["inputs"]["android"]["source_metadata"]["gateway"]["file"], self.report["sources"]["gateway"]["file"])
        self.assertNotIn("rows", result["inputs"]["android"]["source_metadata"]["gateway"]["tables"]["sms_command"])

    def test_core_cross_table_facets(self):
        self.records[1]["row"]["call_session_id"] = "session"
        self.records[1]["row"]["sms_task_id"] = "task"
        self.save()
        obs = {x["command_id"]: x for x in cmp.compare(self.core, self.android)["observations"]}
        self.assertTrue(obs["A"]["core_cross_table_overlap"])
        self.assertTrue(obs["A"]["multiple_occurrences"])
        self.assertFalse(obs["B"]["core_cross_table_overlap"])

    def test_incomplete(self):
        self.records.pop()
        self.report["sources"]["gateway"]["tables"]["sms_task"]["status"] = "partial"
        self.save()
        with self.assertRaises(ValueError): cmp.compare(self.core, self.android)
        result = cmp.compare(self.core, self.android, True)
        self.assertEqual(result["coverage"], "partial")
        self.assertGreaterEqual(len(result["coverage_issues"]), 2)

    def test_invalid_and_trailing(self):
        self.records[0]["version"] = 2
        self.save()
        with self.assertRaises(ValueError): cmp.compare(self.core, self.android, True)
        self.records[0]["version"] = 1
        self.records.append({"type": "row", "row": {"command_id": "late"}})
        self.save()
        with self.assertRaises(ValueError): cmp.compare(self.core, self.android, True)

    def test_row_and_sidecar_coverage(self):
        del self.records[1]["row"]["call_id"]
        self.report["sources"]["ledger"]["sidecars"]["-wal"] = {"size": 1, "mtime_ns": 1, "device": 1, "inode": 1}
        self.save()
        with self.assertRaises(ValueError): cmp.compare(self.core, self.android)
        result = cmp.compare(self.core, self.android, True)
        self.assertTrue(any("Core row" in x for x in result["coverage_issues"]))
        self.assertTrue(any("sidecar" in x for x in result["coverage_issues"]))

    def test_duplicate_json_keys_rejected(self):
        self.android.write_text('{"format":"command-inventory-v1","format":"command-inventory-v1"}', encoding="utf-8")
        with self.assertRaises(ValueError): cmp.compare(self.core, self.android, True)

    def test_count_metadata_and_cli(self):
        self.records[-1]["rows"] = 3
        del self.report["sources"]["ledger"]["file"]["sha256"]
        self.save()
        args = [sys.executable, str(Path(__file__).parent / "compare_command_inventories.py"), "--core", str(self.core), "--android", str(self.android)]
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
        run = subprocess.run(args + ["--allow-partial"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)["coverage"], "partial")


if __name__ == "__main__": unittest.main()
