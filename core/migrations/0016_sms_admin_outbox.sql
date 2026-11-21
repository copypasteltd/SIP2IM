-- One pending notification per incoming device event. Rows are removed after server-side fanout.
CREATE TABLE sms_incoming_admin_outbox (
  event_id text PRIMARY KEY REFERENCES sms_message(event_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_incoming_admin_outbox_order ON sms_incoming_admin_outbox(created_at, event_id);
