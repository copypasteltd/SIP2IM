-- Outbound dispatch remains disabled. Future callers must create an attempt before sending.
CREATE TABLE call_outbound_attempt (
  session_id text PRIMARY KEY REFERENCES call_session(id),
  device_id text NOT NULL REFERENCES device(id),
  call_id text NOT NULL,
  command_id text NOT NULL UNIQUE,
  ack_state text NOT NULL DEFAULT 'pending' CHECK (ack_state IN ('pending','ok','error','unknown')),
  callback_intent text NOT NULL DEFAULT 'none' CHECK (callback_intent IN ('none','quarantined','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
