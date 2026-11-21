-- PROPOSAL ONLY: do not execute as a migration. No ingestion or registration exists.
-- Permissions, immutability enforcement, retention and custody require separate design.
-- The event FK assumes a safe device_event marker parent; no such custody path exists yet.
-- PostgreSQL character counts differ from the reader's JavaScript UTF-16 code-unit limits.
-- page_limit is the requested database row count, including inventory lookahead.
CREATE TABLE sms_quarantine_record (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at >= '0001-01-01 00:00:00+00' AND created_at < '10000-01-01 00:00:00+00'),
 device_id text NOT NULL REFERENCES device(id) CHECK (char_length(device_id) BETWEEN 1 AND 256 AND octet_length(device_id) <= 1024),
 event_id text NOT NULL UNIQUE REFERENCES device_event(id) CHECK (char_length(event_id) BETWEEN 1 AND 256 AND octet_length(event_id) <= 1024),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 256 AND octet_length(reason) <= 1024),
 encoding text NOT NULL CHECK (encoding = 'json-utf16le-v1'),
 payload_length integer NOT NULL CHECK (payload_length >= 0),
 payload bytea NOT NULL CHECK (octet_length(payload) = payload_length)
);
CREATE INDEX sms_quarantine_record_page ON sms_quarantine_record (created_at DESC, id DESC);
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
-- Record identifiers and ordering fields must be immutable. Oversized records remain listable.
