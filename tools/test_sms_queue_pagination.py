"""Offline SQLite checks for the Android queue SQL; not an Android integration test."""
from pathlib import Path
import re
import sqlite3
import unittest

APP = Path(__file__).resolve().parents[1] / 'android/app/src/main/kotlin/io/voipgw/gateway'
OUTBOX = (APP / 'core/Outbox.kt').read_text(encoding='utf-8')
TASKS = (APP / 'sms/SmsTaskStore.kt').read_text(encoding='utf-8')


def literal(source, pattern):
    match = re.search(pattern, source, re.S)
    if match is None:
        raise AssertionError(f'SMS queue source no longer contains the SQL for {pattern}')
    return match[1]


def queue_sql(prefix):
    return literal(OUTBOX, r'"(' + prefix + r'[^"\n]+)"')


def add_scope(db):
    for column in ('binding_id', 'connection_id'):
        db.execute(queue_sql(f'ALTER TABLE sms_task ADD COLUMN {column}'))
    db.execute(queue_sql('CREATE INDEX sms_task_connection_idx '))


class QueuePagingTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute(queue_sql('CREATE TABLE sms_task '))
        self.db.execute(queue_sql('CREATE INDEX IF NOT EXISTS sms_task_state_idx '))
        add_scope(self.db)
        self.scope = literal(TASKS, r'private val queueScope = "([^"]+)"')
        self.boundary_sql = literal(TASKS, r'"(SELECT MAX\(rowid\) FROM sms_task [^"]+)"')
        page = TASKS.partition('fun queuePage(')[2].partition('private fun isOpen(')[0]
        self.first = literal(page, r'if \(after == null\) "\$queueScope ([^"]+)"')
        self.later = literal(page, r'else "\$queueScope ([^"]+)"')

    def add(self, n, state='queued', binding='a', generation='live'):
        self.db.execute('INSERT INTO sms_task(task_id,command_id,payload,state,binding_id,connection_id) VALUES(?,?,?,?,?,?)',
                        (str(n), str(n), str(n), state, binding, generation))

    def boundary(self, binding='a', generation='live'):
        return self.db.execute(self.boundary_sql, (binding, generation, 'queued')).fetchone()[0]

    def page_statement(self, after):
        predicate = self.first if after is None else self.later
        return f'SELECT rowid,task_id,payload FROM sms_task WHERE {self.scope} {predicate} ORDER BY rowid ASC LIMIT ?'

    def page(self, after, upper, limit=2, binding='a', generation='live'):
        args = (upper,) if after is None else (after, upper)
        return self.db.execute(self.page_statement(after), (binding, generation, 'queued', *args, limit)).fetchall()

    def test_bounded_order_excludes_unowned_other_binding_and_old_generation(self):
        self.add('legacy', binding=None, generation=None)
        self.add('old', generation='old')
        self.add('other', binding='b')
        self.assertIsNone(self.boundary())
        for n in range(7):
            self.add(n, 'unknown' if n == 1 else 'queued')
        self.add('newest-but-old-generation', generation='old')
        upper = self.boundary()
        self.assertEqual(upper, self.db.execute("SELECT rowid FROM sms_task WHERE task_id='6'").fetchone()[0])
        first = self.page(None, upper)
        self.add(7)
        self.db.execute("UPDATE sms_task SET state='unknown' WHERE task_id='3'")
        self.db.execute("DELETE FROM sms_task WHERE task_id='4'")
        rows = first
        cursor = first[-1][0]
        while True:
            page = self.page(cursor, upper)
            if not page:
                break
            self.assertLessEqual(len(page), 2)
            rows += page
            cursor = page[-1][0]
        self.assertEqual([r[1] for r in rows], ['0', '2', '5', '6'])
        self.assertEqual([r[1] for r in self.page(upper, self.boundary())], ['7'])
        self.assertEqual([r[1] for r in self.page(None, self.boundary('a', 'old'), generation='old')],
                         ['old', 'newest-but-old-generation'])

    def test_range_query_uses_scoped_index_without_temporary_sort(self):
        for n in range(1000):
            self.add(n, 'unknown')
        self.add(1001)
        plan = self.db.execute('EXPLAIN QUERY PLAN ' + self.page_statement(1), ('a', 'live', 'queued', 1, 2000, 2)).fetchall()
        self.assertTrue(any('sms_task_connection_idx' in r[3] for r in plan), plan)
        self.assertFalse(any('TEMP B-TREE' in r[3] for r in plan), plan)
        self.assertEqual([r[1] for r in self.page(None, self.boundary())], ['1001'])

    def test_additive_upgrade_keeps_existing_rows_unowned(self):
        self.db.execute('DROP TABLE sms_task')  # Reset the in-memory fixture to v3.
        self.db.execute(queue_sql('CREATE TABLE sms_task '))
        self.db.execute(queue_sql('CREATE INDEX IF NOT EXISTS sms_task_state_idx '))
        self.db.execute("INSERT INTO sms_task VALUES ('old', 'cmd', '{}', 'queued', NULL)")
        before = self.db.execute('SELECT rowid,* FROM sms_task').fetchall()
        add_scope(self.db)
        self.assertEqual(self.db.execute('SELECT rowid,* FROM sms_task').fetchall(),
                         [(*row, None, None) for row in before])
        self.assertIsNone(self.boundary())
        self.add('new')
        self.assertEqual([r[1] for r in self.page(None, self.boundary())], ['new'])

    def test_implicit_rowid_reuse_is_a_documented_limit(self):
        self.add(1)
        self.add(2)
        upper = self.boundary()
        self.db.execute("DELETE FROM sms_task WHERE task_id='2'")
        self.add(3)
        self.assertEqual(self.page(1, upper)[0][1], '3')

if __name__ == "__main__": unittest.main()
