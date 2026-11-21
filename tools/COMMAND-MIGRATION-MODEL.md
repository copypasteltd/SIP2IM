# Command namespace SQLite model

Run from the repository root with native Python 3:

```text
python -m unittest discover -s tools -p test_command_migration_model.py -v
```

The standalone standard-library model accepts in-memory row snapshots, never source database paths. Tests use in-memory SQLite and one automatically removed temporary synthetic database for an abrupt child-process exit before commit. It is not an Android importer or a production migration. The caller explicitly asserts fresh-install identity or quiesced writers; neither assertion is established or enforced against external writers. Capture snapshots only while all old writers remain stopped through commit. A writer that ignores this assumption can invalidate the result.

Every supplied row is retained in the snapshot table, including null IDs and duplicate IDs. Collisions and unknown identities are quarantined in the namespace; null IDs cannot be addressed and remain only in the snapshot. Migrated state remains staged and unverified, with command reservation disabled. Version 3 requires explicit configuration and SMS task snapshots, including explicit empty snapshots. Configuration key/value rows, v3 acknowledgment creation timestamps, and all supplied task fields are retained in separate tables. Version 3 acknowledgment input follows `(id, error, created, command_type, payload)`. A queued task is staged only when its unique SMS command has the same task ID and payload, a null command error, no emitted status, and an unambiguous namespace identity; SMS source rows follow `(command_id, task_id, payload, error)` and retain the task association separately; a null error is permitted; duplicate task or command IDs are quarantined. All other states, including Android’s `unknown` claimed-send state, are quarantined because execution may already have occurred. Staged tasks are not executable. Invalid configuration fails and rolls back the entire stage. The model does not establish lossless snapshots of actual Android schemas, recover evicted IDs, validate fresh-install provenance, lock old writers, or define a verification/promotion procedure. These are required before production use.

Python SQLite tests are not proof of Android SQLite behavior, Android integration, device crash recovery, or production safety.
