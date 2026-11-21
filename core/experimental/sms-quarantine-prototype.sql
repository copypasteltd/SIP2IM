-- EXPERIMENTAL / UNWIRED. Apply only to an isolated prototype database after
-- the normal Core schema. Not a migration; never apply to a running deployment.
ALTER TABLE device_event ADD COLUMN custody_kind text NOT NULL DEFAULT 'normal'
 CHECK (custody_kind IN ('normal','sms_quarantine'));
CREATE TABLE sms_quarantine_record (
 id uuid PRIMARY KEY,
 event_id text NOT NULL UNIQUE REFERENCES device_event(id),
 device_id text NOT NULL REFERENCES device(id),
 reason text NOT NULL CHECK (reason IN ('postgres-invalid-string','parts-out-of-range','postgres-invalid-string,parts-out-of-range')),
 encoding text NOT NULL CHECK (encoding='json-utf16le-v1'),
 payload bytea NOT NULL,
 payload_length integer NOT NULL CHECK (payload_length=octet_length(payload) AND payload_length % 2 = 0),
 repair_state text NOT NULL DEFAULT 'pending' CHECK (repair_state IN ('pending','repaired','disposed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- One durable, content-free alert per quarantined identity.
CREATE TABLE sms_quarantine_alert (
 event_id text PRIMARY KEY REFERENCES sms_quarantine_record(event_id),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- No record FK: a missing export must still be auditable.
CREATE TABLE sms_quarantine_access_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 actor_id text NOT NULL REFERENCES admin(id),
 mode text NOT NULL CHECK (mode IN ('inventory','export')),
 record_id uuid,
 cursor_time timestamptz,
 cursor_id uuid,
 page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 51),
 CHECK ((cursor_time IS NULL) = (cursor_id IS NULL)),
 CHECK ((mode = 'export' AND record_id IS NOT NULL AND cursor_id IS NULL AND page_limit = 1) OR (mode = 'inventory' AND record_id IS NULL))
);
