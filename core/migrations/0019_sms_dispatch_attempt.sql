-- No historical backfill: legacy task outcomes cannot identify a command attempt.
-- One attempt per task deliberately forbids automatic retries, including after uncertainty.
-- command_id uniqueness is scoped to this table, not the shared command namespace.
CREATE TABLE sms_dispatch_attempt (
  task_id text PRIMARY KEY REFERENCES sms_task(id),
  device_id text NOT NULL REFERENCES device(id),
  command_id text NOT NULL UNIQUE CHECK (command_id <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sms_dispatch_ack_evidence (
  evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id text NOT NULL REFERENCES sms_dispatch_attempt(command_id),
  ok boolean NOT NULL,
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((ok AND error_code IS NULL) OR (NOT ok AND error_code IS NOT NULL AND error_code <> ''))
);
CREATE UNIQUE INDEX sms_dispatch_ack_observation ON sms_dispatch_ack_evidence
  (command_id, ok, coalesce(error_code, ''));
