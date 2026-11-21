import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import command_migration_model as model


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")

    def tearDown(self):
        self.db.close()

    def test_fresh_requires_explicit_initialization_and_reservation(self):
        with self.assertRaises(TypeError):
            model.initialize(self.db)
        model.initialize(self.db, fresh_install=True)
        self.assertEqual(model.reserve(self.db, "id", "sms.send", b"x", "ok"), ("ok", True))
        self.assertEqual(model.reserve(self.db, "id", "sms.send", b"x", "different"), ("ok", False))
        self.assertEqual(model.reserve(self.db, "id", "other", b"x", "ok"), ("CONFLICT", False))
        self.assertEqual(model.reserve(self.db, "id", "sms.send", b"y", "ok"), ("CONFLICT", False))

    def test_versions_opaque_and_collisions_retained(self):
        for version in (1, 2):
            with self.subTest(version=version):
                db = sqlite3.connect(":memory:")
                try:
                    model.initialize(db, fresh_install=False)
                    sms = [("same", None, b"sms", ""), ("sms-only", None, b"s", "")]
                    ledger = [("same", "dial", b"call", "done"), ("opaque", None, None, "done"), (None, None, b"raw", "unknown")]
                    model.stage(db, sms_rows=sms, ledger_rows=ledger, ledger_version=version, writers_quiesced=True)
                    self.assertEqual(db.execute("SELECT count(*) FROM snapshot").fetchone()[0], 5)
                    self.assertEqual(db.execute("SELECT ambiguous FROM namespace WHERE id='same'").fetchone(), (1,))
                    self.assertEqual(db.execute("SELECT ambiguous FROM namespace WHERE id='opaque'").fetchone(), (1,))
                    self.assertEqual(db.execute("SELECT ambiguous FROM namespace WHERE id='sms-only'").fetchone(), (0,))
                    self.assertEqual(db.execute("SELECT state FROM migration").fetchone(), ("staged_unverified",))
                    with self.assertRaises(ValueError): model.reserve(db, "new", "dial", b"x", "")
                    with self.assertRaises(ValueError): model.stage(db, sms_rows=sms, ledger_rows=ledger, ledger_version=version, writers_quiesced=True)
                finally:
                    db.close()

    def test_v1_identity_is_never_inferred(self):
        model.initialize(self.db, fresh_install=False)
        model.stage(self.db, sms_rows=[], ledger_rows=[("x", "invented", b"bytes", "")], ledger_version=1, writers_quiesced=True)
        self.assertEqual(self.db.execute("SELECT command_type,payload,ambiguous FROM namespace").fetchone(), (None, None, 1))
        self.assertEqual(self.db.execute("SELECT command_type,payload FROM snapshot").fetchone(), ("invented", b"bytes"))

    def test_failure_rolls_back_data_and_marker(self):
        model.initialize(self.db, fresh_install=False)
        def fail(): raise RuntimeError("injected")
        with self.assertRaises(RuntimeError):
            model.stage(self.db, sms_rows=[("x", None, b"a", "")], ledger_rows=[], ledger_version=2, writers_quiesced=True, before_commit=fail)
        self.assertEqual(self.db.execute("SELECT state FROM migration").fetchone(), ("legacy_unverified",))
        self.assertEqual(self.db.execute("SELECT count(*) FROM namespace").fetchone(), (0,))
        self.assertEqual(self.db.execute("SELECT count(*) FROM snapshot").fetchone(), (0,))
        model.stage(self.db, sms_rows=[("x", None, b"a", "")], ledger_rows=[], ledger_version=2, writers_quiesced=True)

    def test_v3_retains_config_and_quarantines_conflicting_and_claimed_tasks(self):
        model.initialize(self.db, fresh_install=False)
        config = [("endpoint", "local"), ("enabled", "false")]
        tasks = [("t1", "good", "a", "queued", None),
                 ("t2", "collision", "b", "queued", None),
                 ("t3", "claimed", "c", "unknown", "unknown"),
                 ("t4", "mismatch", "different", "queued", None),
                 ("t5", "missing", "x", "queued", None),
                 ("t6", "emitted", "e", "queued", "sent")]
        sms = [("good", "t1", "a", None), ("collision", "t2", "b", None),
               ("claimed", "t3", "c", None), ("mismatch", "t4", "m", None),
               ("emitted", "t6", "e", None)]
        model.stage(self.db, sms_rows=sms, ledger_rows=[("collision", "", 123, "dial", "z")],
                    ledger_version=3, writers_quiesced=True, config_rows=config, task_rows=tasks)
        self.assertEqual(self.db.execute("SELECT key,value FROM config_snapshot ORDER BY ordinal").fetchall(), config)
        self.assertEqual(self.db.execute("SELECT created FROM ledger_created").fetchall(), [(123,)])
        self.assertEqual(self.db.execute("SELECT task_id FROM sms_task_link ORDER BY ordinal").fetchall(), [(row[1],) for row in sms])
        rows = self.db.execute("SELECT task_id,command_id,payload,state,emitted,disposition FROM task_snapshot ORDER BY ordinal").fetchall()
        self.assertEqual([row[:5] for row in rows], tasks)
        self.assertEqual([row[5] for row in rows], ["staged", "quarantined", "quarantined", "quarantined", "quarantined", "quarantined"])
        self.assertEqual(self.db.execute("SELECT state FROM migration").fetchone(), ("staged_unverified",))
        with self.assertRaises(ValueError): model.reserve(self.db, "good", "sms.send", "a", "")

    def test_v3_missing_or_invalid_snapshots_fail_closed(self):
        model.initialize(self.db, fresh_install=False)
        for kwargs in ({}, {"config_rows": [("x", "a"), ("x", "b")], "task_rows": []},
                       {"config_rows": [("x", None)], "task_rows": []}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                model.stage(self.db, sms_rows=[("x", None, "a", "")], ledger_rows=[],
                            ledger_version=3, writers_quiesced=True, **kwargs)
            self.assertEqual(self.db.execute("SELECT state FROM migration").fetchone(), ("legacy_unverified",))
            for table in ("snapshot", "namespace", "config_snapshot", "task_snapshot"):
                self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone(), (0,))

    def test_rejected_sms_command_cannot_stage_queued_task(self):
        model.initialize(self.db, fresh_install=False)
        model.stage(self.db, sms_rows=[("accepted", "t1", "a", None),
                                       ("rejected", "t2", "b", "REJECTED"),
                                       ("empty-error", "t3", "c", "")],
                    ledger_rows=[], ledger_version=3, writers_quiesced=True, config_rows=[],
                    task_rows=[("t1", "accepted", "a", "queued", None),
                               ("t2", "rejected", "b", "queued", None),
                               ("t3", "empty-error", "c", "queued", None)])
        self.assertEqual(self.db.execute("SELECT disposition FROM task_snapshot ORDER BY ordinal").fetchall(),
                         [("staged",), ("quarantined",), ("quarantined",)])
        self.assertEqual(self.db.execute("SELECT error FROM snapshot WHERE source='sms' ORDER BY ordinal").fetchall(),
                         [(None,), ("REJECTED",), ("",)])

    def test_sms_task_id_mismatch_quarantines(self):
        model.initialize(self.db, fresh_install=False)
        model.stage(self.db, sms_rows=[("x", "original", "payload", None)], ledger_rows=[],
                    ledger_version=3, writers_quiesced=True, config_rows=[],
                    task_rows=[("other", "x", "payload", "queued", None)])
        self.assertEqual(self.db.execute("SELECT ambiguous FROM namespace").fetchone(), (0,))
        self.assertEqual(self.db.execute("SELECT disposition FROM task_snapshot").fetchone(), ("quarantined",))

    def test_duplicate_tasks_are_all_quarantined(self):
        model.initialize(self.db, fresh_install=False)
        model.stage(self.db, sms_rows=[("x", None, "a", "")], ledger_rows=[], ledger_version=3,
                    writers_quiesced=True, config_rows=[],
                    task_rows=[("t", "x", "a", "queued", None), ("u", "x", "a", "queued", None)])
        self.assertEqual(self.db.execute("SELECT disposition FROM task_snapshot").fetchall(), [("quarantined",), ("quarantined",)])

    def test_v3_injected_failure_rolls_back_every_table(self):
        model.initialize(self.db, fresh_install=False)
        def fail(): raise RuntimeError("injected")
        with self.assertRaises(RuntimeError):
            model.stage(self.db, sms_rows=[("x", None, "a", "")], ledger_rows=[], ledger_version=3,
                        writers_quiesced=True, config_rows=[("key", "value")],
                        task_rows=[("t", "x", "a", "queued", None)], before_commit=fail)
        self.assertEqual(self.db.execute("SELECT state FROM migration").fetchone(), ("legacy_unverified",))
        for table in ("snapshot", "namespace", "config_snapshot", "task_snapshot"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone(), (0,))

    def test_old_writer_precondition(self):
        model.initialize(self.db, fresh_install=False)
        with self.assertRaises(ValueError):
            model.stage(self.db, sms_rows=[], ledger_rows=[], ledger_version=2, writers_quiesced=False)
        self.assertEqual(self.db.execute("SELECT state FROM migration").fetchone(), ("legacy_unverified",))

    def test_process_exit_before_commit(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = str(Path(tmp) / "synthetic.db")
            db = sqlite3.connect(path)
            model.initialize(db, fresh_install=False)
            db.close()
            script = "import os,sqlite3,command_migration_model as m; d=sqlite3.connect(%r); m.stage(d,sms_rows=[('x',None,b'a','')],ledger_rows=[('x','',123,'dial',b'b')],ledger_version=3,writers_quiesced=True,config_rows=[('k','v')],task_rows=[('t','x',b'a','queued',None)],before_commit=lambda:os._exit(23))" % path
            result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, check=False)
            self.assertEqual(result.returncode, 23)
            db = sqlite3.connect(path)
            try:
                self.assertEqual(db.execute("SELECT state FROM migration").fetchone(), ("legacy_unverified",))
                self.assertEqual(db.execute("SELECT count(*) FROM namespace").fetchone(), (0,))
                self.assertEqual(db.execute("SELECT count(*) FROM snapshot").fetchone(), (0,))
                self.assertEqual(db.execute("SELECT count(*) FROM config_snapshot").fetchone(), (0,))
                self.assertEqual(db.execute("SELECT count(*) FROM task_snapshot").fetchone(), (0,))
                model.stage(db, sms_rows=[("x", None, b"a", "")], ledger_rows=[], ledger_version=3,
                            writers_quiesced=True, config_rows=[("k", "v")],
                            task_rows=[("t", "x", b"a", "queued", None)])
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
