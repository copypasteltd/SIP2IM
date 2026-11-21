# Conditional settings write lifecycle (design, not wired)

A page-local lock does not survive navigation, session replacement, reload, process death, or other tabs. A settings GET after a lost PUT response is only an observation and cannot prove that the original database transaction has terminated. The current conditional API has no durable operation-status or fencing protocol.

A future client may persist a minimal, origin-scoped pending marker before dispatch, without storing tokens or setting values, and coordinate same-origin tabs with Web Locks. Storage failure, malformed markers, or missing lock support must prevent dispatch. Markers must survive unmount, abort, logout, and uncertain responses. Browser storage can be evicted and multiple origins, profiles, legacy clients and external writers are not coordinated; these mechanisms alone are not a durable global guarantee.

Safe automatic recovery needs a server-side durable operation identity, terminal outcome and fencing/reconciliation semantics that include effects; a snapshot, elapsed time, restart or local marker deletion is not proof of quiescence. Until that exists, the archived UI controller must not be enabled as a complete solution. Existing settings form uses legacy partial PUT and can still lose same-field concurrent updates.

Design validation remains outstanding: marker storage failures and malformed records, cross-tab lock handoff, page and session transitions, unknown response/late commit, durable server operation state, and real PostgreSQL/device tests.
