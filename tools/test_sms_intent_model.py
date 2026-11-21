"""Deterministic transaction interleavings, independent of wall clock or threads."""
import itertools
import unittest
from dataclasses import replace
from sms_intent_model import Intent, Store, StoreError, cleanup_legacy, post_after_admission


def intent(key, **changes):
    return replace(Intent("owner", "server", key, "sim", "recipient", "body"), **changes)


class IntentModelTests(unittest.TestCase):
    def test_concurrent_admissions_serialize_in_both_orders(self):
        a, b = intent("a"), intent("b")
        for order in itertools.permutations((a, b)):
            s, sent = Store(), []
            # Both tabs decide to attempt admission before either transaction commits.
            results = [post_after_admission(s, item, sent.append) for item in order]
            self.assertEqual(results, [True, False])
            self.assertEqual(sent, [order[0]])
            self.assertEqual(list(s.pending.values()), [order[0]])

    def test_abort_and_unavailable_never_post(self):
        for failure in ("abort", "unavailable"):
            s, sent = Store(), []
            s.abort_next = failure == "abort"
            s.available = failure != "unavailable"
            with self.assertRaises(StoreError):
                post_after_admission(s, intent("a"), sent.append)
            self.assertEqual(sent, [])
            self.assertEqual(s.pending, {})

    def test_divergent_legacy_migrations_both_orders_and_crash(self):
        a, b = intent("a"), intent("b", body="different")
        for order in itertools.permutations(("A", "B")):
            s, legacy = Store(), {"A": a, "B": b}
            for tab in order:
                value = legacy[tab]
                self.assertEqual(s.migrate(value), "copied")
                # Crash after commit, before verify/delete; retry is idempotent.
                self.assertEqual(s.migrate(value), "copied")
                self.assertTrue(cleanup_legacy(s, legacy, tab, value))
            self.assertEqual(set(s.pending.values()), {a, b})
            self.assertEqual(legacy, {})

    def test_ack_before_or_after_delayed_migration_never_resurrects(self):
        a = intent("a")
        for order in (("ack", "migrate"), ("migrate", "ack")):
            s, legacy = Store(), {"sleeping": a}
            s.migrate(a)
            for action in order:
                if action == "ack":
                    self.assertTrue(s.acknowledge(a, a.scope))
                else:
                    s.migrate(legacy["sleeping"])
            self.assertEqual(s.pending, {})
            self.assertEqual(s.tombstones[a.identity], a)
            self.assertEqual(s.migrate(a), "acknowledged")
            self.assertTrue(cleanup_legacy(s, legacy, "sleeping", a))
            self.assertFalse(s.admit(a))
            self.assertEqual(s.pending, {})

    def test_conflicting_same_key_never_overwrites_pending_or_tombstone(self):
        a, conflict = intent("a"), intent("a", body="other")
        for acknowledged in (False, True):
            s = Store()
            s.migrate(a)
            if acknowledged:
                s.acknowledge(a, a.scope)
            self.assertEqual(s.migrate(conflict), "conflict")
            self.assertEqual((s.tombstones if acknowledged else s.pending)[a.identity], a)
            self.assertIn(conflict, s.conflicts)
            legacy = {"tab": conflict}
            self.assertTrue(cleanup_legacy(s, legacy, "tab", conflict))
            self.assertIn(conflict, s.conflicts)
            self.assertFalse(s.admit(intent("new", owner="another")))

    def test_cross_owner_key_collision_and_conflict_abort(self):
        a, b = intent("shared"), intent("shared", owner="other")
        for order in itertools.permutations((a, b)):
            s = Store()
            self.assertEqual(s.migrate(order[0]), "copied")
            s.abort_next = True
            with self.assertRaises(StoreError):
                s.migrate(order[1])
            self.assertNotIn(order[1], s.conflicts)
            self.assertEqual(s.migrate(order[1]), "conflict")
            self.assertEqual(s.pending[order[0].identity], order[0])
            self.assertIn(order[1], s.conflicts)
            self.assertTrue(s.acknowledge(order[0], order[0].scope))
            self.assertFalse(s.acknowledge(order[1], order[1].scope))
            self.assertEqual(s.tombstones[order[0].identity], order[0])
            self.assertEqual(s.migrate(order[1]), "conflict")
            self.assertIn(order[1], s.conflicts)

    def test_cross_owner_admission_tombstone_and_conflict_orders(self):
        a = intent("shared")
        b = intent("shared", owner="other")
        for first, second in itertools.permutations((a, b)):
            s, sent = Store(), []
            self.assertTrue(post_after_admission(s, first, sent.append))
            self.assertFalse(post_after_admission(s, second, sent.append))
            self.assertEqual(sent, [first])
            self.assertTrue(s.acknowledge(first, first.scope))
            self.assertFalse(post_after_admission(s, second, sent.append))
            self.assertEqual(s.migrate(second), "conflict")
            self.assertFalse(post_after_admission(s, intent("new", owner=second.owner), sent.append))
            self.assertEqual(s.tombstones[first.identity], first)
            self.assertIn(second, s.conflicts)
            self.assertEqual(sent, [first])

    def test_cleanup_checks_copy_and_unchanged_legacy(self):
        a, b = intent("a"), intent("b")
        s, legacy = Store(), {"tab": a}
        with self.assertRaises(StoreError):
            cleanup_legacy(s, legacy, "tab", a)
        s.migrate(a)
        legacy["tab"] = b
        self.assertFalse(cleanup_legacy(s, legacy, "tab", a))
        self.assertEqual(legacy["tab"], b)
        s.available = False
        with self.assertRaises(StoreError):
            cleanup_legacy(s, legacy, "tab", b)
        self.assertEqual(legacy["tab"], b)

    def test_ack_requires_same_session_and_complete_immutable_value(self):
        a = intent("a")
        s = Store()
        s.migrate(a)
        self.assertFalse(s.acknowledge(a, ("another-owner", "server")))
        self.assertFalse(s.acknowledge(replace(a, body="changed"), a.scope))
        self.assertEqual(s.pending[a.identity], a)
        s.abort_next = True
        with self.assertRaises(StoreError):
            s.acknowledge(a, a.scope)
        self.assertEqual(s.pending[a.identity], a)
        self.assertEqual(s.tombstones, {})

    def test_corrupt_legacy_is_not_deleted(self):
        s, legacy = Store(), {"tab": "invalid"}
        with self.assertRaises(StoreError):
            s.migrate(legacy["tab"])
        self.assertEqual(legacy["tab"], "invalid")
        self.assertEqual(s.pending, {})


if __name__ == "__main__":
    unittest.main()
