"""Offline behavioral model and source checks; not an Android runtime test."""
from pathlib import Path
from threading import Event, Lock, Thread
import unittest

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'android/app/src/main/kotlin/io/voipgw/gateway/core'

UNBOUND = ('UNBOUND',)
FIXTURE_IDENTITY = ('device', 'fixture-token', 'http://offline.invalid')


class BindingModel:
    """Durable record plus a process-local latch for an uncertain local write."""
    def __init__(self, disk=UNBOUND, *, legacy_preferences=False):
        self.disk = disk
        self.legacy_preferences = legacy_preferences
        self.uncertain = False
        self.lock = Lock()
        self.posts = 0

    def replace(self, expected, next_record, *, confirmed, landed):
        if self.disk != expected:
            self.uncertain = True
            return False
        if confirmed or landed:
            self.disk = next_record
        self.uncertain = not confirmed
        return confirmed

    def bind(self, valid=True, marker_commit=True, response='success', promotion_commit=True,
             marker_lands=False, promotion_lands=False, entered=None, release=None):
        with self.lock:
            if self.uncertain or self.legacy_preferences or self.disk != UNBOUND:
                return 'blocked'
            if not valid:
                return 'rejected'
            binding_id = 'attempt-1'
            if not self.replace(UNBOUND, ('PENDING', binding_id), confirmed=marker_commit, landed=marker_lands):
                return 'uncertain'
            self.posts += 1
        if entered:
            entered.set()
        if release and not release.wait(2):
            raise AssertionError('timed out')
        if response != 'success':
            return 'uncertain'
        if self.finish(binding_id, confirmed=promotion_commit, landed=promotion_lands):
            return 'success'
        return 'uncertain'

    def finish(self, binding_id, *, confirmed=True, landed=False):
        with self.lock:
            pending = ('PENDING', binding_id)
            if self.uncertain or self.legacy_preferences or self.disk != pending:
                return False
            return self.replace(pending, ('IDLE', binding_id, *FIXTURE_IDENTITY), confirmed=confirmed, landed=landed)

    def usable(self):
        return (not self.uncertain and not self.legacy_preferences and self.disk is not None
                and self.disk[0] == 'IDLE' and len(self.disk) == 5 and all(self.disk[1:]))


class BindingGuardTest(unittest.TestCase):
    def test_validation_and_marker_failure_never_send(self):
        model = BindingModel()
        self.assertEqual(model.bind(valid=False), 'rejected')
        self.assertEqual(model.disk, UNBOUND)
        for lands in (False, True):
            with self.subTest(lands=lands):
                model = BindingModel()
                self.assertEqual(model.bind(marker_commit=False, marker_lands=lands), 'uncertain')
                self.assertEqual(model.posts, 0)
                self.assertEqual(model.bind(), 'blocked')
                self.assertFalse(model.usable())
                restarted = BindingModel(model.disk)
                if lands:
                    self.assertEqual(restarted.bind(), 'blocked')
                else:
                    self.assertEqual(restarted.bind(), 'success')  # No request crossed the boundary.

    def test_every_post_failure_retains_marker_across_restart(self):
        for response in ('disconnect', 'timeout', '400', '500', 'malformed', 'empty'):
            with self.subTest(response=response):
                model = BindingModel()
                self.assertEqual(model.bind(response=response), 'uncertain')
                self.assertEqual((model.posts, model.disk), (1, ('PENDING', 'attempt-1')))
                restarted = BindingModel(model.disk)
                self.assertEqual(restarted.bind(), 'blocked')
                self.assertEqual(restarted.posts, 0)
                self.assertFalse(restarted.usable())

    def test_promotion_uncertain_latches_process_and_restart_uses_disk(self):
        for lands in (False, True):
            with self.subTest(lands=lands):
                model = BindingModel()
                self.assertEqual(model.bind(promotion_commit=False, promotion_lands=lands), 'uncertain')
                self.assertFalse(model.usable())
                self.assertEqual(model.bind(), 'blocked')
                restarted = BindingModel(model.disk)
                self.assertEqual(restarted.usable(), lands)
                self.assertEqual(restarted.bind(), 'blocked')
                self.assertEqual(restarted.posts, 0)

    def test_success_and_existing_unusable_state(self):
        model = BindingModel()
        self.assertEqual(model.bind(), 'success')
        self.assertEqual(model.disk, ('IDLE', 'attempt-1', *FIXTURE_IDENTITY))
        self.assertTrue(BindingModel(model.disk).usable())
        for disk, legacy in ((None, False), (('LEGACY',), False), (UNBOUND, True),
                             (('PENDING', 'earlier'), False), (('IDLE', 'b', 'd', '', 'origin'), False)):
            with self.subTest(disk=disk, legacy=legacy):
                model = BindingModel(disk, legacy_preferences=legacy)
                self.assertEqual(model.bind(), 'blocked')
                self.assertFalse(model.usable())
                self.assertEqual(model.posts, 0)

    def test_promotion_only_matches_the_original_pending_id(self):
        pending = ('PENDING', 'current')
        model = BindingModel(pending)
        self.assertFalse(model.finish('older'))
        self.assertEqual(model.disk, pending)
        self.assertTrue(model.finish('current'))
        self.assertFalse(model.finish('current'))
        self.assertEqual(model.disk, ('IDLE', 'current', *FIXTURE_IDENTITY))

    def test_concurrent_attempts_post_once(self):
        model = BindingModel()
        entered, release = Event(), Event()
        results = []
        first = Thread(target=lambda: results.append(model.bind(entered=entered, release=release)))
        second = Thread(target=lambda: results.append(model.bind()))
        first.start()
        try:
            self.assertTrue(entered.wait(2))
            second.start()
            second.join(2)
            self.assertFalse(second.is_alive(), 'second attempt must not wait for network')
            self.assertEqual(results, ['blocked'])
        finally:
            release.set()
            first.join(2)
        self.assertFalse(first.is_alive())
        self.assertCountEqual(results, ['success', 'blocked'])
        self.assertEqual(model.posts, 1)

    def test_android_source_wiring(self):
        binding = (CORE / 'BindingClient.kt').read_text(encoding='utf-8')
        replay = (CORE / 'BindingReplay.kt').read_text(encoding='utf-8')
        fence = (CORE / 'BindingFence.kt').read_text(encoding='utf-8')
        creds = (CORE / 'Credentials.kt').read_text(encoding='utf-8')
        for phrase in ('BindingAddress.origin(address)', 'BindingAddress.code(code)', 'getPackageInfo',
                       'PendingBinding.create(origin, code, metadata)'):
            self.assertIn(phrase, binding)
        first = replay.partition('fun start(')[2].partition('fun resume(')[0]
        stages = ('State.UNBOUND', 'prepare()', 'fence.beginBinding(pending)', 'send(saved)')
        self.assertEqual([first.index(stage) for stage in stages], sorted(first.index(stage) for stage in stages))
        resume = replay.partition('fun resume(')[2].partition('private fun send(')[0]
        self.assertLess(resume.index('fence.pendingBinding()'), resume.index('send(saved)'))
        self.assertNotIn('prepare()', resume)
        self.assertLess(replay.index('exchange(checkNotNull(saved.pending))'), replay.index('fence.finishBinding(saved, proof)'))
        for phrase in ('/api/device/bind-v2', 'pending.bearer', 'pending.requestBody()', '.followRedirects(false)',
                       '.retryOnConnectionFailure(false)', 'permit.used.compareAndSet(false, true)',
                       'response.code() != 200 || !response.cacheControl().noStore()'):
            self.assertIn(phrase, binding)
        self.assertNotIn('"/api/device/bind"', binding)
        self.assertNotIn('Log.', binding)

        self.assertIn('SqliteBindingStore(Outbox.shared(app))', creds)
        self.assertNotIn('prefs.edit()', creds)
        store = creds.partition('override fun replace(')[2].partition('private fun readRecord(')[0]
        operations = ['db.beginTransaction()', 'if (!expected.matches(current)) return false',
                      'db.update("gateway_binding"', 'db.setTransactionSuccessful()', 'db.endTransaction()']
        self.assertEqual([store.index(step) for step in operations], sorted(store.index(step) for step in operations))
        for key in ('binding_id', 'device_id', 'token', 'origin'):
            self.assertIn(f'put("{key}", next.', store)
        for key in ('attempt_id', 'bearer', 'origin', 'code', 'manufacturer', 'model', 'api_level',
                    'apk_version', 'apk_code', 'locale'):
            self.assertIn(f'put("replay_{key}", pending?.', store)
        guard = fence.partition('fun beginBinding(')[2].partition('fun openConnection()')[0]
        self.assertIn('legacyPreferencesPresent() || !unbound.matches(store.read())', guard)
        self.assertIn('BindingRecord(BindingRecord.Phase.PENDING, newId(), pending = pending)', guard)
        self.assertIn('persistBinding(unbound, next)', guard)
        self.assertLess(guard.index('!expected.matches(store.read())'), guard.index('pending.attemptId != proof.attemptId'))
        self.assertLess(guard.index('pending.attemptId != proof.attemptId'), guard.index('persistBinding(expected, next)'))
        self.assertIn('store.replace(expected, next) && next.matches(store.read())', guard)
        self.assertIn('if (uncertain) return fallback', fence)

        ui = (CORE.parent / 'ui/MainActivity.kt').read_text(encoding='utf-8')
        for phrase in ('Credentials.registerBindingObserver', 'Credentials.unregisterBindingObserver',
                       'mainHandler.post { refreshBinding(); refreshConnection(); refreshStart() }',
                       'java.lang.ref.WeakReference(this)', 'BindingReplay.Result.UNCERTAIN',
                       'BindingFence.State.PENDING_REPLAY -> runBinding(client::resume)',
                       'if (result == BindingReplay.Result.SUCCESS) GatewayStart.request(app)'):
            self.assertIn(phrase, ui)
        for locale in ('values', 'values-en', 'values-zh-rHK'):
            text = (ROOT / 'android/app/src/main/res' / locale / 'strings.xml').read_text(encoding='utf-8')
            for key in ('binding_pending', 'binding_failed', 'binding_resume'):
                self.assertIn(f'name="{key}"', text)

if __name__ == '__main__': unittest.main()
