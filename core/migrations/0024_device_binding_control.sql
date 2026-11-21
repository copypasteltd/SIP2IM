-- The code hash remains the authoritative, retained lock key for both protocols.
-- gen_random_uuid() is built into PostgreSQL 14. The UUID identifies a record,
-- never authorizes a bind or cancellation, and is independent of the code.
CREATE TABLE binding_code_control (
  code_hash bytea PRIMARY KEY REFERENCES binding_code(code_hash),
  record_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  protocol_version smallint,
  attempt_id bytea,
  credential_hash bytea,
  request_fingerprint bytea,
  replay_until timestamptz,
  cancelled_at timestamptz,
  teardown_pending boolean NOT NULL DEFAULT false,
  CONSTRAINT binding_code_control_replay_complete CHECK (
    (protocol_version IS NULL AND attempt_id IS NULL AND credential_hash IS NULL
      AND request_fingerprint IS NULL AND replay_until IS NULL)
    OR
    (protocol_version IS NOT NULL AND protocol_version = 2
      AND attempt_id IS NOT NULL AND octet_length(attempt_id) = 16
      AND credential_hash IS NOT NULL AND octet_length(credential_hash) = 32
      AND request_fingerprint IS NOT NULL AND octet_length(request_fingerprint) = 32
      AND replay_until IS NOT NULL)
  ),
  CONSTRAINT binding_code_control_teardown_fenced CHECK (NOT teardown_pending OR cancelled_at IS NOT NULL)
);

-- Give retained legacy rows a record ID without granting any v2 replay rights.
INSERT INTO binding_code_control(code_hash) SELECT code_hash FROM binding_code;

CREATE INDEX binding_code_used_by_device ON binding_code(used_by_device, code_hash)
  WHERE used_by_device IS NOT NULL;
