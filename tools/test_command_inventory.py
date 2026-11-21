from contextlib import contextmanager
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import command_inventory as inventory

HERE = Path(__file__).parent
CMD = "cmd_0" + "A" * 25
TASK = "tsk_0" + "B" * 25


@contextmanager
def database(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.root = Path(self.temp.name)
        self.gateway = self.root / "gateway.db"
        self.ledger = self.root / "command_ledger.db"
        with database(self.gateway) as db:
            db.executescript("""PRAGMA user_version=2;
                CREATE TABLE sms_command(command_id TEXT,task_id TEXT,payload TEXT,error TEXT);
                CREATE TABLE sms_task(task_id TEXT,command_id TEXT,payload TEXT,state TEXT,emitted TEXT);
                INSERT INTO sms_command VALUES(NULL,NULL,'a',NULL);
                INSERT INTO sms_command VALUES('bad','',X'00FF','');
            """)
            db.execute("INSERT INTO sms_command VALUES(?,?,?,?)", (CMD, TASK, "sms body", None))
            db.execute("INSERT INTO sms_task VALUES(?,?,?,?,?)", (TASK, CMD, "sms body", "unknown", None))
        with database(self.ledger) as db:
            db.executescript("""PRAGMA user_version=3;
                CREATE TABLE acknowledgments(id TEXT,error TEXT,created INTEGER,command_type TEXT,payload TEXT);
                CREATE TABLE config(key TEXT,value TEXT);
                INSERT INTO config VALUES('locale','en');
            """)
            db.execute("INSERT INTO acknowledgments VALUES(?,?,?,?,?)", (CMD, "", 123, "config.update", "{}"))

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.root.iterdir()}

    def test_inventory_retains_evidence_and_never_changes_sources(self):
        before = self.snapshot()
        report = inventory.inventory(self.gateway, self.ledger, assert_quiescent=True)
        self.assertEqual(before, self.snapshot())
        self.assertTrue(report["selected_columns_read"])
        self.assertEqual(report["cross_database_duplicate_command_ids"], [CMD])
        sms = report["sources"]["gateway"]["tables"]["sms_command"]["rows"]
        self.assertEqual(sms[1]["payload"], {"sqlite_blob_base64": "AP8="})
        self.assertEqual(sms[1]["error"], "")
        self.assertIsNone(sms[0]["error"])
        self.assertEqual(report["sources"]["gateway"]["tables"]["sms_task"]["rows"][0]["state"], "unknown")
        self.assertEqual(report["sources"]["ledger"]["tables"]["config"]["rows"][0]["value"], "en")
        self.assertEqual({i["kind"] for i in report["issues"]}, {"null_id", "malformed_id"})

    def test_legacy_schema_reports_missing_coverage(self):
        with database(self.ledger) as db:
            db.executescript("DROP TABLE acknowledgments; DROP TABLE config; CREATE TABLE acknowledgments(id TEXT,error TEXT,created INTEGER); PRAGMA user_version=1;")
            db.execute("INSERT INTO acknowledgments VALUES(?,?,?)", (CMD, "", 1))
        report = inventory.inventory(self.gateway, self.ledger, assert_quiescent=True)
        tables = report["sources"]["ledger"]["tables"]
        self.assertFalse(report["selected_columns_read"])
        self.assertEqual(tables["config"]["status"], "missing_table")
        self.assertEqual(tables["acknowledgments"]["missing_columns"], ["command_type", "payload"])
        self.assertNotIn("payload", tables["acknowledgments"]["rows"][0])

    def test_nonfinite_values_remain_serializable(self):
        with database(self.ledger) as db:
            db.execute("DROP TABLE config")
            db.execute("CREATE TABLE config(key, value)")
            db.execute("INSERT INTO config VALUES(?,?)", ("locale", "en"))
            db.execute("INSERT INTO config VALUES(?,?)", ("number", float("inf")))
        result = inventory.inventory(self.gateway, self.ledger, assert_quiescent=True)
        self.assertEqual(result["sources"]["ledger"]["tables"]["config"]["rows"][1]["value"], {"sqlite_real": "inf"})
        json.dumps(result, allow_nan=False)

    def test_task_only_collision_is_not_lost(self):
        with database(self.gateway) as db:
            db.execute("DELETE FROM sms_command WHERE command_id=?", (CMD,))
        report = inventory.inventory(self.gateway, self.ledger, assert_quiescent=True)
        self.assertEqual(report["cross_database_duplicate_command_ids"], [CMD])

    def test_assertion_sidecars_and_missing_inputs_fail_without_changes(self):
        with self.assertRaises(ValueError): inventory.inventory(self.gateway, self.ledger)
        with self.assertRaises((OSError, ValueError)): inventory.inventory(self.gateway, self.root / "missing", assert_quiescent=True)
        for suffix in ("-wal", "-journal"):
            sidecar = Path(str(self.gateway) + suffix)
            sidecar.write_bytes(b"pending")
            before = self.snapshot()
            with self.assertRaisesRegex(ValueError, "sidecar"):
                inventory.inventory(self.gateway, self.ledger, assert_quiescent=True)
            self.assertEqual(before, self.snapshot())
            sidecar.unlink()

    def test_cli_outputs_json_and_rejects_missing_assertion(self):
        args = [sys.executable, str(HERE / "command_inventory.py"), "--gateway", str(self.gateway), "--ledger", str(self.ledger)]
        before = self.snapshot()
        fail = subprocess.run(args, capture_output=True, text=True)
        self.assertNotEqual(fail.returncode, 0)
        self.assertEqual(fail.stdout, "")
        result = subprocess.run(args + ["--assert-quiescent"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["cross_database_duplicate_command_ids"], [CMD])
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
