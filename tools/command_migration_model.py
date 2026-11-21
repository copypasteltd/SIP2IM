"""Isolated SQLite migration model; not Android code and not a database importer.

Callers provide immutable snapshots, not database paths. Quiescence and freshness
are asserted by the caller; this model cannot establish either fact.
"""
import sqlite3

SCHEMA = (
    "CREATE TABLE migration (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)",
    "CREATE TABLE namespace (id TEXT PRIMARY KEY, command_type TEXT, payload BLOB, error TEXT, ambiguous INTEGER NOT NULL)",
    "CREATE TABLE snapshot (source TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT, command_type TEXT, payload BLOB, error TEXT, PRIMARY KEY(source, ordinal))",
    "CREATE TABLE ledger_created (ordinal INTEGER PRIMARY KEY, created INTEGER)",
    "CREATE TABLE sms_task_link (ordinal INTEGER PRIMARY KEY, task_id TEXT)",
    "CREATE TABLE config_snapshot (ordinal INTEGER PRIMARY KEY, key TEXT, value TEXT)",
    "CREATE TABLE task_snapshot (ordinal INTEGER PRIMARY KEY, task_id TEXT, command_id TEXT, payload BLOB, state TEXT, emitted TEXT, disposition TEXT NOT NULL)",
)


def initialize(db, *, fresh_install):
    """Explicit caller assertion; missing legacy history is never proof of freshness."""
    if type(fresh_install) is not bool:
        raise ValueError("fresh_install must be explicitly True or False")
    if db.in_transaction:
        raise ValueError("requires no active transaction")
    try:
        db.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA:
            db.execute(statement)
        db.execute("INSERT INTO migration VALUES (1, ?)",
                   ("fresh" if fresh_install else "legacy_unverified",))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def stage(db, *, sms_rows, ledger_rows, ledger_version, writers_quiesced,
          config_rows=None, task_rows=None, before_commit=None):
    """Stage snapshots atomically. SMS rows are (command_id, task_id, payload, error);
    v3 ledger rows are (id, error, created, command_type, payload);
    v1/v2 ledger rows are (id, command_type, payload, error).

    config_rows are (key, value); task_rows are
    (task_id, command_id, payload, state, emitted). Claimed Android sends are
    recorded as unknown, and are never staged as retryable. All migrated tasks
    remain non-executable; late callback evidence is outside this model.
    v1 ledger identities are opaque regardless of any supplied type or payload.
    The caller must hold writers stopped for snapshot capture and migration; the
    boolean is an assumption, not a lock or an Android guarantee.
    """
    if writers_quiesced is not True:
        raise ValueError("legacy writers must be quiesced")
    if type(ledger_version) is not int or ledger_version not in (1, 2, 3):
        raise ValueError("unsupported ledger version")
    if ledger_version == 3 and (config_rows is None or task_rows is None):
        raise ValueError("v3 requires explicit config and task snapshots")
    if ledger_version != 3 and config_rows is not None:
        raise ValueError("config snapshot requires ledger v3")
    if db.in_transaction:
        raise ValueError("requires no active transaction")
    try:
        db.execute("BEGIN IMMEDIATE")
        state = db.execute("SELECT state FROM migration WHERE id=1").fetchone()
        if state != ("legacy_unverified",):
            raise ValueError("destination is not an unstaged legacy install")
        if any(db.execute("SELECT count(*) FROM " + table).fetchone()[0]
               for table in ("namespace", "snapshot", "ledger_created", "sms_task_link", "config_snapshot", "task_snapshot")):
            raise ValueError("destination must be empty")
        for source, rows in (("sms", sms_rows), ("ledger", ledger_rows)):
            for ordinal, row in enumerate(rows):
                if source == "sms":
                    command_id, linked_task_id, payload, error = row
                    kind = None
                    db.execute("INSERT INTO sms_task_link VALUES (?,?)", (ordinal, linked_task_id))
                elif ledger_version == 3:
                    command_id, error, created, kind, payload = row
                    if type(created) is not int or error is None:
                        raise ValueError("invalid v3 acknowledgment")
                    db.execute("INSERT INTO ledger_created VALUES (?,?)", (ordinal, created))
                else:
                    command_id, kind, payload, error = row
                # Preserve caller-provided source data independently of derived identity.
                db.execute("INSERT INTO snapshot VALUES (?,?,?,?,?,?)", (source, ordinal, command_id, kind, payload, error))
                if command_id is None:
                    continue  # retained but impossible to address in namespace
                if source == "sms":
                    kind = "sms.send"
                elif ledger_version == 1:
                    kind = payload = None
                ambiguous = int(kind is None or payload is None or (source == "ledger" and error is None))
                existing = db.execute("SELECT 1 FROM namespace WHERE id=?", (command_id,)).fetchone()
                if existing:
                    db.execute("UPDATE namespace SET ambiguous=1 WHERE id=?", (command_id,))
                else:
                    db.execute("INSERT INTO namespace VALUES (?,?,?,?,?)", (command_id, kind, payload, error, ambiguous))
        # Keep exact supplied rows; malformed or duplicate v3 keys fail the whole stage.
        keys = set()
        for ordinal, (key, value) in enumerate(config_rows or ()):
            if not isinstance(key, str) or not isinstance(value, str) or key in keys:
                raise ValueError("invalid or duplicate configuration key")
            keys.add(key)
            db.execute("INSERT INTO config_snapshot VALUES (?,?,?)", (ordinal, key, value))
        for ordinal, (task_id, command_id, payload, state, emitted) in enumerate(task_rows or ()):
            # Android uses unknown for a claimed send: its external outcome is uncertain.
            matching = db.execute("SELECT s.id, s.payload, l.task_id, s.error FROM snapshot s LEFT JOIN sms_task_link l ON l.ordinal=s.ordinal WHERE s.source='sms' AND s.id=?", (command_id,)).fetchall()
            identity = db.execute("SELECT ambiguous FROM namespace WHERE id=?", (command_id,)).fetchone()
            safe = (state == "queued" and emitted is None and task_id is not None and command_id is not None
                    and payload is not None and len(matching) == 1
                    and matching[0][1] == payload and matching[0][2] == task_id
                    and matching[0][3] is None and identity == (0,))
            disposition = "staged" if safe else "quarantined"
            db.execute("INSERT INTO task_snapshot VALUES (?,?,?,?,?,?,?)",
                       (ordinal, task_id, command_id, payload, state, emitted, disposition))
        # Duplicate task or command identities quarantine every associated task.
        db.execute("UPDATE task_snapshot SET disposition='quarantined' WHERE task_id IN "
                   "(SELECT task_id FROM task_snapshot WHERE task_id IS NOT NULL GROUP BY task_id HAVING count(*)>1) "
                   "OR command_id IN (SELECT command_id FROM task_snapshot WHERE command_id IS NOT NULL GROUP BY command_id HAVING count(*)>1)")
        result = db.execute("UPDATE migration SET state='staged_unverified' WHERE id=1 AND state='legacy_unverified'")
        if result.rowcount != 1:
            raise ValueError("migration marker changed")
        if before_commit is not None:
            before_commit()
        db.commit()
    except BaseException:
        db.rollback()
        raise


def reserve(db, command_id, kind, payload, error):
    """Return (result, inserted); only explicitly fresh installs can reserve."""
    if db.execute("SELECT state FROM migration WHERE id=1").fetchone() != ("fresh",):
        raise ValueError("command execution disabled")
    if any(x is None for x in (command_id, kind, payload, error)):
        raise ValueError("identity and result must be present")
    inserted = db.execute("INSERT OR IGNORE INTO namespace VALUES (?,?,?,?,0)",
                          (command_id, kind, payload, error)).rowcount == 1
    row = db.execute("SELECT command_type,payload,error,ambiguous FROM namespace WHERE id=?", (command_id,)).fetchone()
    if row[3] or row[0] != kind or row[1] != payload or row[2] is None:
        return "CONFLICT", False
    return row[2], inserted
