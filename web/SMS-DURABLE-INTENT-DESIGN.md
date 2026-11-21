# SMS pending-intent durable storage: design requirements

Status: **not implemented**. The current UI uses tab-scoped sessionStorage. Closing a tab or clearing storage can lose an unresolved key; different tabs are not coordinated.

A future replacement must persist immutable owner, server, key, SIM, recipient and body before any POST. Same-origin admission and conditional acknowledgement must be transactional; an absent read-only lookup is never proof the earlier POST cannot later commit. Retrying the exact key is an explicit action that can initiate sending.

Migration must preserve each surviving legacy tab’s value, including divergent pending requests, without overwrite. Commit and verify a durable copy before removing a legacy value. Retain per-key acknowledgement tombstones so a crash or dormant legacy tab cannot resurrect acknowledged intent. Tombstone retention cannot depend on proving inaccessible old tabs are gone. Corrupt values and storage/open/transaction errors fail closed.

Every asynchronous callback must revalidate session and immutable intent. Broadcast notifications are hints only; admission and state transitions must re-read in a transaction. Never treat a retry 4xx as proving an earlier unknown attempt failed. Do not hold a database transaction across network operations.

Old app tabs cannot be inspected or fenced by a new tab; rollout requires operational coordination or a server-side fencing protocol. Browser storage may be cleared or evicted and holds SMS contents in plaintext. Client persistence cannot guarantee exactly-once physical delivery.

Required verification includes transaction commit/abort before POST, multiple tabs and legacy conflicts, crash between migration and cleanup, tombstone replay, delayed responses and account changes, invalid/unavailable storage, 4xx after uncertainty, explicit lookup and retry, and real-browser integration. No such migration is claimed complete.
