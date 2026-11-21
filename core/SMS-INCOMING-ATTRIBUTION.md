# Incoming SMS attribution

Incoming SMS messages are stored with a null SIM ID. Core retains the device event payload, including its slot, subscription and PDU timestamp fields; the message and notification outbox entry are still saved. The current Android producer does not extract SIM metadata from the broadcast: it sends a null subscription ID and a null slot on API 22+, while the pre-22 slot value of 0 is an assumption, not an observed receiving SIM.

The Android producer supplies the PDU timestamp as receivedAt, which is not proof of the phone reception time. SIM first_seen_at and retired_at are server observation times; last_seen_at is a device observation time capped at server time. They are not exact physical swap boundaries, and subscription IDs can be reused. Snapshots cannot prove which SIM received a particular message between observations, or that the clocks agree. This also applies to delayed messages and exact timestamp matches.

Consequently, even a single currently active SIM or a legacy device with API level below 22 no longer causes a slot-zero attribution. A future protocol would need authoritative identity tied to the same reception event, with reliable generation semantics, before assigning a SIM. Historical messages are not rewritten.
