"""Executable state model, not a browser store or production implementation."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Intent:
    owner: str
    server: str
    key: str
    sim: str
    recipient: str
    body: str

    def __post_init__(self):
        if any(not isinstance(v, str) or not v for v in vars(self).values()):
            raise ValueError("invalid intent")

    @property
    def identity(self):
        return self.server, self.key

    @property
    def scope(self):
        return self.owner, self.server


class StoreError(Exception):
    pass


class Store:
    """Each method below is one serialized, all-or-nothing transaction."""
    def __init__(self):
        self.pending = {}
        self.tombstones = {}
        self.conflicts = set()
        self.available = True
        self.abort_next = False

    def transaction(self, operation):
        if not self.available:
            raise StoreError("unavailable")
        pending, tombstones, conflicts = self.pending.copy(), self.tombstones.copy(), self.conflicts.copy()
        result = operation(pending, tombstones, conflicts)
        if self.abort_next:
            self.abort_next = False
            raise StoreError("aborted")
        self.pending, self.tombstones, self.conflicts = pending, tombstones, conflicts
        return result

    @staticmethod
    def _check(intent):
        if not isinstance(intent, Intent):
            raise StoreError("corrupt intent")

    def admit(self, intent):
        self._check(intent)
        def op(pending, tombstones, conflicts):
            if intent.identity in tombstones or any(i.server == intent.server for i in pending.values()) or any(i.server == intent.server for i in conflicts):
                return False
            pending[intent.identity] = intent
            return True
        return self.transaction(op)

    def migrate(self, intent):
        self._check(intent)
        def op(pending, tombstones, conflicts):
            previous = tombstones.get(intent.identity) or pending.get(intent.identity)
            if previous is not None:
                if previous != intent:
                    conflicts.add(intent)
                    return "conflict"
                return "acknowledged" if intent.identity in tombstones else "copied"
            pending[intent.identity] = intent
            return "copied"
        return self.transaction(op)

    def acknowledge(self, expected, current_scope):
        self._check(expected)
        def op(pending, tombstones, conflicts):
            if current_scope != expected.scope or pending.get(expected.identity) != expected:
                return False
            del pending[expected.identity]
            tombstones[expected.identity] = expected
            return True
        return self.transaction(op)

    def verify_copy(self, intent):
        self._check(intent)
        def op(pending, tombstones, conflicts):
            existing = tombstones.get(intent.identity) or pending.get(intent.identity)
            if existing != intent and intent not in conflicts:
                raise StoreError("copy not verified")
            return True
        return self.transaction(op)


def cleanup_legacy(store, legacy, tab, expected):
    """Verify transaction first; removal is conditional on the unchanged tab value."""
    store.verify_copy(expected)
    if legacy.get(tab) == expected:
        del legacy[tab]
        return True
    return False


def post_after_admission(store, intent, post):
    """A successful commit must precede the callback; no transaction spans it."""
    if store.admit(intent):
        post(intent)
        return True
    return False
