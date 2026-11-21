"""Offline SQLite model and Kotlin source checks; not an Android runtime test."""
from contextlib import closing
from pathlib import Path
import re
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'android/app/src/main/kotlin/io/voipgw/gateway/core'
OUTBOX = (CORE / 'Outbox.kt').read_text(encoding='utf-8')
HEAD = OUTBOX.partition('fun pendingHead(')[2].partition('fun attempted(')[0]


def literal(source, pattern):
    match = re.search(pattern, source, re.S)
    if match is None:
        raise AssertionError(f'Outbox source no longer contains the SQL for {pattern}')
    return match[1]


def database(rows):
    db = sqlite3.connect(':memory:')
    for prefix in ('CREATE TABLE outbox ', 'ALTER TABLE outbox ', 'CREATE INDEX outbox_binding_idx '):
        db.execute(literal(OUTBOX, f'"({prefix}[^"\n]+)"'))
    db.executemany('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?)', rows)
    return db


def retrieve(db, binding, now):
    expires = literal(HEAD, r'db\.delete\("outbox", "([^"]+)"')
    scope = literal(HEAD, r'return db\.query\(.*?\),\s*"([^"]+)"')
    order = literal(HEAD, r'null, null, "([^"]+)", "1"\)')
    db.execute(f'DELETE FROM outbox WHERE {expires}', (binding, now))
    return db.execute(f'SELECT id, type, payload, created_at, attempts FROM outbox WHERE {scope} ORDER BY {order} LIMIT 1',
                      (binding,)).fetchone()


class PendingHeadTest(unittest.TestCase):
    def test_fifo_head_expiry_and_pruning_are_binding_scoped(self):
        rows = [
            ('expired', 'call.state', '{}', 1, 99, 0, 'a'),
            ('boundary', 'call.state', '{}', 2, 100, 3, 'a'),
            ('tie-first', 'sms.result', '{"a":1}', 5, None, 2, 'a'),
            ('tie-second', 'call.state', '{}', 5, 101, 4, 'a'),
            ('later-expired', 'call.state', '{}', 9, 100, 0, 'a'),
            ('future', 'sms.received', '{}', 20, None, 1, 'a'),
            ('other-expired', 'call.state', '{}', 0, 99, 0, 'b'),
            ('other-head', 'sms.received', '{}', 0, None, 0, 'b'),
            ('unowned', 'call.state', '{}', 0, 99, 0, None),
        ]
        for now in (50, 99, 100, 101, 1000):
            with self.subTest(now=now), closing(database(rows)) as db:
                retained = [r for r in rows if r[6] != 'a' or r[4] is None or r[4] > now]
                expected = min((r for r in retained if r[6] == 'a'), key=lambda r: r[3])
                self.assertEqual(retrieve(db, 'a', now), (*expected[:4], expected[5]))
                self.assertEqual(db.execute('SELECT * FROM outbox ORDER BY rowid').fetchall(), retained)
                if now == 100:
                    self.assertEqual(expected[0], 'tie-first')
                    self.assertEqual(retrieve(db, 'b', now)[0], 'other-head')
                    self.assertEqual(db.execute('SELECT id FROM outbox WHERE binding_id IS NULL').fetchall(), [('unowned',)])

    def test_empty_scope_and_backwards_clock(self):
        rows = [('call', 'call.state', '{}', 20, 100, 0, 'a'), ('sms', 'sms.result', '{}', 30, None, 0, 'a')]
        with closing(database(rows)) as db:
            self.assertIsNone(retrieve(db, 'different', 1000))
            self.assertEqual(retrieve(db, 'a', 99)[0], 'call')
            self.assertEqual(retrieve(db, 'a', 100)[0], 'sms')
            self.assertEqual(retrieve(db, 'a', 50)[0], 'sms')

    def test_attempt_and_ack_do_not_mutate_another_binding_or_legacy_rows(self):
        attempt = literal(OUTBOX, r'execSQL\("(UPDATE outbox SET attempts[^"\n]+)"')
        ack_fn = OUTBOX.partition('fun acknowledge(')[2]
        ack = literal(ack_fn, r'delete\("outbox", "([^"]+)"')
        rows = [('a-event', 'sms.received', '{}', 1, None, 0, 'a'),
                ('old-event', 'sms.received', '{}', 1, None, 0, 'b'),
                ('legacy-event', 'sms.received', '{}', 1, None, 0, None)]
        with closing(database(rows)) as db:
            for foreign in ('old-event', 'legacy-event'):
                self.assertEqual(db.execute(attempt, ('a', foreign)).rowcount, 0)
                self.assertEqual(db.execute(f'DELETE FROM outbox WHERE {ack}', ('a', foreign)).rowcount, 0)
            self.assertEqual(db.execute(attempt, ('a', 'a-event')).rowcount, 1)
            self.assertEqual(retrieve(db, 'a', 100)[-1], 1)
            self.assertEqual(db.execute(f'DELETE FROM outbox WHERE {ack}', ('a', 'a-event')).rowcount, 1)
            self.assertIsNone(retrieve(db, 'a', 100))
            self.assertEqual(db.execute('SELECT * FROM outbox ORDER BY rowid').fetchall(), rows[1:])

    def test_source_preserves_query_contract_and_flush_wiring(self):
        self.assertIn('Event?', HEAD)
        self.assertIn('arrayOf(bindingId, now.toString())', HEAD)
        self.assertIn('arrayOf("id", "type", "payload", "created_at", "attempts")', HEAD)
        self.assertIn('"binding_id = ?", arrayOf(bindingId)', HEAD)
        self.assertLess(HEAD.index('db.delete('), HEAD.index('db.query('))
        self.assertIn('if (cursor.moveToFirst())', HEAD)
        self.assertIn('else null', HEAD)
        service = (CORE / 'GatewayService.kt').read_text(encoding='utf-8')
        flush = service.partition('private fun flushNext(')[2].partition('private fun envelope(')[0]
        self.assertIn('outbox.pendingHead(active.bindingId) ?: return@runReady', flush)
        self.assertNotIn('outbox.pending()', flush)


if __name__ == '__main__':
    unittest.main()
