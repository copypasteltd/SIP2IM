"""Offline SQLite regression for the Android app's DDL and SQL predicates."""
import base64
from contextlib import closing
from pathlib import Path
import random
import re
import sqlite3
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1] / "main/kotlin/io/voipgw/gateway"
OUTBOX = (APP / "core/Outbox.kt").read_text(encoding="utf-8")
TASKS = (APP / "sms/SmsTaskStore.kt").read_text(encoding="utf-8")


def section(source, begin, end):
    return source.split(begin, 1)[1].split(end, 1)[0]


def statements(source):
    for long, short in re.findall(r'db\.execSQL\((?:"""(.*?)"""|"([^"\n]*)")\)', source, re.S):
        yield long or short


V4_DDL = tuple(statements(section(OUTBOX, "private fun addBindingFence", "private fun addBindingReplay")))
V5_DDL = tuple(statements(section(OUTBOX, "private fun addBindingReplay", "fun enqueue")))


def create(db, legacy):
    with db:
        db.execute("BEGIN")
        db.execute(next(sql for sql in statements(OUTBOX) if sql.startswith("CREATE TABLE outbox ")))
        if legacy == 0 or legacy >= 2:
            for sql in statements(section(OUTBOX, "private fun createSmsTables", "private fun createSmsQueueIndex")):
                db.execute(sql)
        if legacy == 0 or legacy >= 3:
            db.execute(next(statements(section(OUTBOX, "private fun createSmsQueueIndex", "override fun onUpgrade"))))
        if legacy in (0, 4):
            for sql in V4_DDL:
                db.execute(sql)
            if legacy == 0:
                for sql in V5_DDL:
                    db.execute(sql)
            db.execute(next(sql for sql in statements(OUTBOX) if "VALUES (1, 'UNBOUND')" in sql))


def upgrade(db, legacy, interrupt=False):
    with db:
        db.execute("BEGIN")
        if legacy < 2:
            for sql in statements(section(OUTBOX, "private fun createSmsTables", "private fun createSmsQueueIndex")):
                db.execute(sql)
        if legacy < 3:
            db.execute(next(statements(section(OUTBOX, "private fun createSmsQueueIndex", "override fun onUpgrade"))))
        if legacy < 4:
            for sql in V4_DDL:
                db.execute(sql)
            db.execute(next(sql for sql in statements(OUTBOX) if "VALUES (1, 'LEGACY')" in sql))
        for sql in V5_DDL:
            db.execute(sql)
            if interrupt:
                raise RuntimeError("Interrupted adding replay columns")


class BindingFenceSqliteTest(unittest.TestCase):
    def test_upgrade_keeps_unowned_inbound_commands_tasks_and_parts(self):
        for version in (1, 2, 3):
            with self.subTest(version=version), closing(sqlite3.connect(":memory:")) as db:
                create(db, version)
                with db:
                    db.execute("INSERT INTO outbox VALUES ('legacy-in', 'sms.received', '{}', 1, NULL, 0)")
                    if version >= 2:
                        db.execute("INSERT INTO sms_command VALUES ('legacy-cmd', 'legacy-task', '{}', NULL)")
                        db.execute("INSERT INTO sms_task VALUES ('legacy-task', 'legacy-cmd', '{}', 'unknown', 'unknown')")
                        db.execute("INSERT INTO sms_part VALUES ('legacy-task', 0, NULL, NULL)")
                upgrade(db, version)
                self.assertEqual(db.execute("SELECT phase, binding_id FROM gateway_binding").fetchall(), [("LEGACY", None)])
                self.assertEqual(db.execute("SELECT id, payload, binding_id FROM outbox").fetchall(), [("legacy-in", "{}", None)])
                if version >= 2:
                    self.assertEqual(db.execute("SELECT command_id, binding_id FROM sms_command").fetchall(), [("legacy-cmd", None)])
                    self.assertEqual(db.execute("SELECT state, emitted, binding_id, connection_id FROM sms_task").fetchall(), [("unknown", "unknown", None, None)])
                    self.assertEqual(db.execute("SELECT task_id, part_index, sent FROM sms_part").fetchall(), [("legacy-task", 0, None)])

    def test_interrupted_upgrade_rolls_back_without_changing_legacy_rows(self):
        with closing(sqlite3.connect(":memory:")) as db:
            create(db, 3)
            with db:
                db.execute("INSERT INTO outbox VALUES ('legacy-in', 'sms.received', '{}', 1, NULL, 0)")
            with self.assertRaises(RuntimeError):
                upgrade(db, 3, interrupt=True)
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='gateway_binding'").fetchone(), (0,))
            self.assertEqual(db.execute("SELECT * FROM outbox").fetchall(), [("legacy-in", "sms.received", "{}", 1, None, 0)])
            upgrade(db, 3)
            self.assertEqual(db.execute("SELECT phase FROM gateway_binding").fetchone(), ("LEGACY",))

    def test_v4_forward_upgrade_keeps_every_old_identity_phase_and_owned_row(self):
        for phase in ("UNBOUND", "PENDING", "LEGACY", "IDLE", "OPEN", "TERMINAL"):
            with self.subTest(phase=phase), closing(sqlite3.connect(":memory:")) as db:
                create(db, 4)
                generation = "v4-id" if phase not in ("UNBOUND", "LEGACY") else None
                identity = ("device", "legacy-fixture", "http://offline.invalid") if phase in ("IDLE", "OPEN", "TERMINAL") else (None,) * 3
                old_row = (1, phase, generation, *identity, "open-generation" if phase == "OPEN" else None,
                           "ws:4010" if phase == "TERMINAL" else None)
                with db:
                    db.execute("DELETE FROM gateway_binding")
                    db.execute("INSERT INTO gateway_binding VALUES (?, ?, ?, ?, ?, ?, ?, ?)", old_row)
                    db.execute("INSERT INTO outbox VALUES ('history', 'sms.received', '{}', 1, NULL, 0, ?)", (generation,))
                    db.execute("INSERT INTO sms_task VALUES ('task', 'cmd', '{}', 'unknown', 'unknown', ?, 'previous')", (generation,))
                with self.assertRaises(RuntimeError):
                    upgrade(db, 4, interrupt=True)
                self.assertEqual(db.execute("SELECT * FROM gateway_binding").fetchone(), old_row)
                upgrade(db, 4)
                self.assertEqual(db.execute("SELECT * FROM gateway_binding").fetchone(), (*old_row, *((None,) * 11)))
                self.assertEqual(db.execute("SELECT id, binding_id FROM outbox").fetchall(), [("history", generation)])
                self.assertEqual(db.execute("SELECT task_id, binding_id, connection_id FROM sms_task").fetchall(),
                                 [("task", generation, "previous")])

    def test_v2_pending_and_promotion_are_complete_single_rows(self):
        fields = re.findall(r"ADD COLUMN (replay_[a-z_]+)", "\n".join(V5_DDL))
        seed = random.Random(19)

        def token(count):
            return base64.urlsafe_b64encode(seed.randbytes(count)).decode().rstrip("=")

        bearer, attempt, code = token(32), token(16), str(seed.randrange(1_000_000)).zfill(6)
        origin = "http://offline.invalid:47860"
        pending = (attempt, bearer, origin, code, "fixture", "model", 19, "v1", 1, "en", 2)
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "binding.sqlite"
            with closing(sqlite3.connect(path)) as db:
                create(db, 0)
                with self.assertRaises(sqlite3.IntegrityError), db:
                    db.execute("UPDATE gateway_binding SET replay_attempt_id = ?", (attempt,))
                with self.assertRaises(sqlite3.IntegrityError), db:
                    db.execute("UPDATE gateway_binding SET phase='PENDING', binding_id='v2-id', replay_version=2")
                with db:
                    db.execute("UPDATE gateway_binding SET phase='PENDING', binding_id='v2-id', " +
                               ", ".join(f"{field}=?" for field in fields), pending)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT phase, binding_id, token, " + ", ".join(fields) +
                                            " FROM gateway_binding").fetchone(), ("PENDING", "v2-id", None, *pending))
                with self.assertRaises(sqlite3.IntegrityError), db:
                    db.execute("UPDATE gateway_binding SET phase='IDLE', device_id='device', token=?, origin=?", (bearer, origin))
                promote = ("UPDATE gateway_binding SET phase='IDLE', device_id='device', token=?, origin=?, " +
                           ", ".join(f"{field}=NULL" for field in fields) +
                           " WHERE binding_id=? AND phase='PENDING' AND replay_attempt_id=?")
                with db:
                    self.assertEqual(db.execute(promote, (bearer, origin, "stale-id", attempt)).rowcount, 0)
                    self.assertEqual(db.execute(promote, (bearer, origin, "v2-id", attempt)).rowcount, 1)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT phase, token, origin, " + ", ".join(fields) +
                                            " FROM gateway_binding").fetchone(), ("IDLE", bearer, origin, *((None,) * 11)))

    def test_inbound_is_kept_before_binding_and_after_terminal_close(self):
        capture = re.search(r'"(SELECT binding_id FROM gateway_binding WHERE singleton = 1 AND phase IN \([^\n"]+\))"', OUTBOX)[1]
        with closing(sqlite3.connect(":memory:")) as db:
            create(db, 0)

            def record_inbound(event):
                owner = db.execute(capture).fetchone()
                db.execute("INSERT INTO outbox (id, type, payload, created_at, binding_id) VALUES (?, 'sms.received', '{}', 1, ?)",
                           (event, owner[0] if owner else None))

            with db:
                record_inbound("before-binding")
                db.execute("UPDATE gateway_binding SET phase='PENDING', binding_id='binding' WHERE singleton=1")
                record_inbound("while-pending")
                db.execute("UPDATE gateway_binding SET phase='IDLE', device_id='device', token='fixture', origin='http://offline.invalid' WHERE singleton=1")
                record_inbound("while-bound")
                db.execute("UPDATE gateway_binding SET phase='TERMINAL', reason='ws:4010' WHERE singleton=1")
                record_inbound("after-terminal")
            self.assertEqual(db.execute("SELECT id, binding_id FROM outbox ORDER BY rowid").fetchall(),
                             [("before-binding", None), ("while-pending", None), ("while-bound", "binding"), ("after-terminal", "binding")])

    def test_open_and_terminal_survive_reopen_and_keep_provenance(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "fixture.sqlite"
            with closing(sqlite3.connect(path)) as db:
                create(db, 0)
                self.assertEqual(db.execute("SELECT phase FROM gateway_binding").fetchone(), ("UNBOUND",))
                with db:
                    db.execute("UPDATE gateway_binding SET phase='PENDING', binding_id='binding' WHERE singleton=1")
                    db.execute("UPDATE gateway_binding SET phase='IDLE', device_id='device', token='fixture', origin='http://offline.invalid' WHERE singleton=1")
                    db.execute("UPDATE gateway_binding SET phase='OPEN', connection_id='generation' WHERE singleton=1")
            for expected in ("OPEN", "TERMINAL"):
                with closing(sqlite3.connect(path)) as db:
                    row = db.execute("SELECT phase, binding_id, device_id, connection_id, reason FROM gateway_binding").fetchone()
                    self.assertEqual(row, (expected, "binding", "device", "generation" if expected == "OPEN" else None, None if expected == "OPEN" else "ws:4010"))
                    if expected == "OPEN":
                        with self.assertRaises(sqlite3.IntegrityError), db:
                            db.execute("UPDATE gateway_binding SET phase='TERMINAL' WHERE singleton=1")
                        with db:
                            db.execute("UPDATE gateway_binding SET phase='TERMINAL', connection_id=NULL, reason='ws:4010' WHERE singleton=1")

    def test_other_generation_and_unowned_rows_never_enter_active_queues(self):
        with closing(sqlite3.connect(":memory:")) as db:
            create(db, 0)
            scopes = [("legacy", None, None), ("old", "binding", "old"), ("foreign", "other", "now"), ("current", "binding", "now")]
            db.executemany("INSERT INTO sms_task (task_id, command_id, payload, state, binding_id, connection_id) VALUES (?, ?, '{}', 'queued', ?, ?)",
                           ((name, "cmd-" + name, binding, generation) for name, binding, generation in scopes))
            sql = re.search(r'"(SELECT MAX\(rowid\) FROM sms_task[^"\n]+)"', TASKS)[1]
            scope = re.search(r'private val queueScope = "([^"]+)"', TASKS)[1]
            args = ("binding", "now", "queued")
            boundary = db.execute(sql, args).fetchone()[0]
            self.assertEqual(db.execute(f"SELECT task_id FROM sms_task WHERE {scope} AND rowid <= ?", (*args, boundary)).fetchall(), [("current",)])
            for name, _, _ in scopes:
                changed = db.execute(f"UPDATE sms_task SET state='unknown' WHERE {scope} AND task_id=?", (*args, name)).rowcount
                self.assertEqual(changed, int(name == "current"))
            self.assertEqual(db.execute("SELECT count(*) FROM sms_task").fetchone(), (4,))

            db.executemany("INSERT INTO outbox (id, type, payload, created_at, binding_id) VALUES (?, 'sms.received', '{}', ?, ?)",
                           ((name, idx, binding) for idx, (name, binding, _) in enumerate(scopes)))
            outbox_scope = re.search(r'"(binding_id = \?)", arrayOf\(bindingId\), null, null, "created_at ASC, rowid ASC"', OUTBOX)[1]
            self.assertEqual(db.execute(f"SELECT id FROM outbox WHERE {outbox_scope} ORDER BY created_at, rowid", ("binding",)).fetchall(), [("old",), ("current",)])
            self.assertEqual(db.execute("SELECT count(*) FROM outbox").fetchone(), (4,))


if __name__ == "__main__":
    unittest.main()
