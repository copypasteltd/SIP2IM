"""Exercise the app's actual SMS SQL predicates against native desktop SQLite.

The fixture uses the production DDL and selectors. Android ContentValues writes
and transaction boundaries are modeled here; this is not an Android receiver test.
"""
import json
import re
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Barrier

from test_binding_fence_sqlite import TASKS, create


QUEUE = re.search(r'private val queueScope = "([^"]+)"', TASKS)[1]
CLAIMED = re.search(r'private val claimedScope = "([^"]+)"', TASKS)[1]
OPEN = re.search(r'"(SELECT 1 FROM gateway_binding[^"\n]+)"', TASKS)[1]
PART = re.search(r'"(task_id = \? AND part_index = \?)", arrayOf\(attempt\.taskId', TASKS)[1]


def open_binding(db, binding, connection):
    with db:
        db.execute("UPDATE gateway_binding SET phase='OPEN', binding_id=?, connection_id=?, "
                   "device_id='fixture', token='fixture', origin='http://offline.invalid' WHERE singleton=1",
                   (binding, connection))


def reserve(db, task, binding, connection):
    with db:
        db.execute("INSERT INTO sms_task (task_id, command_id, payload, state, binding_id, connection_id) "
                   "VALUES (?, ?, '{}', 'queued', ?, ?)", (task, "cmd-" + task, binding, connection))


def result(db, event, task, binding, state, error=None):
    payload = json.dumps({"taskId": task, "state": state, "errorCode": error})
    db.execute("INSERT INTO outbox (id, type, payload, created_at, binding_id) VALUES (?, 'sms.result', ?, 1, ?)",
               (event, payload, binding))


def claim(db, task, binding, connection, parts, event):
    with db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute(OPEN, (binding, connection)).fetchone():
            return False
        updated = db.execute(f"UPDATE sms_task SET state='unknown' WHERE {QUEUE} AND task_id=?",
                             (binding, connection, "queued", task)).rowcount
        if not updated:
            return False
        db.executemany("INSERT INTO sms_part (task_id, part_index) VALUES (?, ?)",
                       ((task, index) for index in range(parts)))
        result(db, event, task, binding, "unknown")
        db.execute("UPDATE sms_task SET emitted='unknown' WHERE task_id=?", (task,))
        return True


def record(db, task, binding, connection, part, evidence, event, state, error=None):
    # The real JVM evidence policy is separately tested. Supply its decided write here.
    scoped = (task, binding, connection)
    with db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute(f"SELECT task_id FROM sms_task WHERE {CLAIMED}", scoped).fetchone():
            return False
        if db.execute(f"UPDATE sms_part SET sent=? WHERE {PART}", (evidence, task, part)).rowcount != 1:
            return False
        result(db, event, task, binding, state, error)
        db.execute(f"UPDATE sms_task SET emitted=? WHERE {CLAIMED}", (state, *scoped))
        return True


class SmsSendSqliteTest(unittest.TestCase):
    def test_a_committed_claim_has_one_winner_across_connections_and_reopen(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            path = Path(directory) / "sms.sqlite"
            with closing(sqlite3.connect(path)) as db:
                create(db, 0)
                open_binding(db, "binding", "old")
                reserve(db, "task", "binding", "old")
                self.assertFalse(claim(db, "task", "other-binding", "old", 2, "wrong-owner"))

            ready = Barrier(2, timeout=5)

            def race(event):
                with closing(sqlite3.connect(path, timeout=5)) as db:
                    ready.wait()
                    return claim(db, "task", "binding", "old", 2, event)

            events = ("first", "second")
            with ThreadPoolExecutor(max_workers=2) as pool:
                winners = [event for event, won in zip(events, pool.map(race, events)) if won]
            self.assertEqual(len(winners), 1)

            with closing(sqlite3.connect(path)) as reopened:
                self.assertFalse(claim(reopened, "task", "binding", "old", 2, "duplicate"))
                open_binding(reopened, "binding", "new")
                self.assertFalse(claim(reopened, "task", "binding", "old", 2, "old-connection"))
                self.assertFalse(claim(reopened, "task", "binding", "new", 2, "new-connection"))
                self.assertEqual(reopened.execute("SELECT state, emitted, connection_id FROM sms_task").fetchall(),
                                 [("unknown", "unknown", "old")])
                self.assertEqual(reopened.execute("SELECT part_index, sent, delivered FROM sms_part ORDER BY part_index").fetchall(),
                                 [(0, None, None), (1, None, None)])
                row = reopened.execute("SELECT id, binding_id, payload FROM outbox").fetchone()
                self.assertEqual(row[:2], (winners[0], "binding"))
                self.assertEqual(json.loads(row[2]), {"taskId": "task", "state": "unknown", "errorCode": None})
                self.assertEqual(reopened.execute("SELECT count(*) FROM outbox").fetchone(), (1,))

    def test_callback_is_only_for_the_original_claim_and_existing_part_even_after_reconnect(self):
        with closing(sqlite3.connect(":memory:")) as db:
            create(db, 0)
            open_binding(db, "first", "old")
            reserve(db, "task", "first", "old")
            reserve(db, "queued", "first", "old")
            with db:
                db.execute("INSERT INTO sms_task VALUES ('legacy', 'legacy-cmd', '{}', 'unknown', 'unknown', NULL, NULL)")
                db.execute("INSERT INTO sms_part VALUES ('legacy', 0, NULL, NULL)")
            self.assertTrue(claim(db, "task", "first", "old", 2, "claim"))
            open_binding(db, "second", "new")
            for key in [("queued", "first", "old", 0), ("legacy", "first", "old", 0),
                        ("task", "first", "new", 0), ("task", "second", "old", 0),
                        ("task", "second", "new", 0), ("task", "first", "old", 2)]:
                with self.subTest(key=key):
                    self.assertFalse(record(db, *key, 1, "rejected", "sent"))
            self.assertTrue(record(db, "task", "first", "old", 1, 2, "conflict", "unknown", "SMS_CALLBACK_CONFLICT"))
            self.assertEqual(db.execute("SELECT task_id, part_index, sent, delivered FROM sms_part ORDER BY task_id, part_index").fetchall(),
                             [("legacy", 0, None, None), ("task", 0, None, None), ("task", 1, 2, None)])
            self.assertEqual(db.execute("SELECT id, binding_id FROM outbox ORDER BY rowid").fetchall(),
                             [("claim", "first"), ("conflict", "first")])

    def test_outbox_failure_rolls_back_admission_and_late_part_reconciliation(self):
        with closing(sqlite3.connect(":memory:")) as db:
            create(db, 0)
            open_binding(db, "binding", "gen")
            reserve(db, "task", "binding", "gen")
            with db:
                result(db, "collision", "history", "binding", "sent")
            with self.assertRaises(sqlite3.IntegrityError):
                claim(db, "task", "binding", "gen", 1, "collision")
            self.assertEqual(db.execute("SELECT state, emitted FROM sms_task").fetchone(), ("queued", None))
            self.assertEqual(db.execute("SELECT count(*) FROM sms_part").fetchone(), (0,))
            self.assertTrue(claim(db, "task", "binding", "gen", 1, "claim"))
            with self.assertRaises(sqlite3.IntegrityError):
                record(db, "task", "binding", "gen", 0, 1, "collision", "sent")
            self.assertEqual(db.execute("SELECT sent FROM sms_part").fetchone(), (None,))
            self.assertEqual(db.execute("SELECT state, emitted FROM sms_task").fetchone(), ("unknown", "unknown"))
            self.assertTrue(record(db, "task", "binding", "gen", 0, 1, "callback", "sent"))
            self.assertEqual(db.execute("SELECT sent FROM sms_part").fetchone(), (1,))
            self.assertEqual(db.execute("SELECT state, emitted FROM sms_task").fetchone(), ("unknown", "sent"))
            self.assertEqual(db.execute("SELECT id FROM outbox ORDER BY rowid").fetchall(),
                             [("collision",), ("claim",), ("callback",)])


if __name__ == "__main__":
    unittest.main()
