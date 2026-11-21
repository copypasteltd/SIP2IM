-- Additive custody schema. Table creation does not enable quarantine ACKs.
CREATE TABLE sms_received_quarantine (
    id uuid PRIMARY KEY,
    event_id text NOT NULL UNIQUE REFERENCES device_event(id) ON DELETE RESTRICT,
    device_id text NOT NULL REFERENCES device(id) ON DELETE RESTRICT,
    device_ts_ms bigint NOT NULL CHECK (device_ts_ms BETWEEN 0 AND 8640000000000000),
    reason text NOT NULL CHECK (reason IN ('postgres-invalid-string', 'parts-out-of-range', 'postgres-invalid-string,parts-out-of-range', 'postgres-index-limit')),
    encoding text NOT NULL CHECK (encoding = 'json-utf16le-v1'),
    payload bytea NOT NULL,
    payload_length int NOT NULL CHECK (payload_length BETWEEN 2 AND 262144 AND payload_length % 2 = 0 AND payload_length = octet_length(payload)),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32 AND digest = sha256(payload)),
    alert_id text NOT NULL UNIQUE REFERENCES alert(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        CHECK (created_at >= '0001-01-01 00:00:00+00' AND created_at < '10000-01-01 00:00:00+00'),
    CHECK (length(event_id) = 30 AND event_id COLLATE "C" ~ '^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    CHECK (length(device_id) = 30 AND device_id COLLATE "C" ~ '^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$')
);
CREATE INDEX sms_received_quarantine_page ON sms_received_quarantine(created_at DESC, id DESC);

-- Snapshot the access outcome, including missing or invalid export targets. Deleting
-- a session or changing the alert's acknowledgement state does not erase access history.
CREATE TABLE sms_received_quarantine_access (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id text NOT NULL REFERENCES admin(id) ON DELETE RESTRICT,
    mode text NOT NULL CHECK (mode IN ('inventory', 'export')),
    outcome text NOT NULL CHECK (outcome IN ('ok', 'missing', 'invalid')),
    record_id uuid,
    cursor_time timestamptz,
    cursor_id uuid,
    row_limit int NOT NULL CHECK (row_limit BETWEEN 1 AND 51),
    row_count int NOT NULL CHECK (row_count BETWEEN 0 AND row_limit),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((cursor_time IS NULL) = (cursor_id IS NULL)),
    CHECK ((mode = 'inventory' AND record_id IS NULL AND outcome = 'ok') OR
           (mode = 'export' AND record_id IS NOT NULL AND cursor_id IS NULL AND row_limit = 1 AND
            (row_count = 1 OR outcome = 'missing') AND (row_count = 0 OR outcome <> 'missing')))
);
CREATE INDEX sms_received_quarantine_access_time ON sms_received_quarantine_access(created_at DESC, id DESC);

CREATE FUNCTION check_sms_received_quarantine_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM device_event e JOIN alert a ON a.id = NEW.alert_id
        WHERE e.id = NEW.event_id AND e.device_id = NEW.device_id
          AND e.type = 'sms.received.quarantined'
          AND extract(epoch from e.device_ts) * 1000 = NEW.device_ts_ms
          AND e.payload = jsonb_build_object('quarantineId', NEW.id::text)
          AND a.type = 'sms_receive_quarantined' AND a.subject_type = 'sms_quarantine' AND a.subject_id = NEW.id::text
          AND NOT EXISTS (SELECT 1 FROM sms_message m WHERE m.event_id = NEW.event_id)
    ) THEN
        RAISE EXCEPTION 'Inconsistent inbound SMS quarantine references';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER sms_received_quarantine_links BEFORE INSERT ON sms_received_quarantine
    FOR EACH ROW EXECUTE FUNCTION check_sms_received_quarantine_links();

CREATE FUNCTION reject_sms_received_quarantine_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Inbound SMS custody and access audit are append-only';
END;
$$;
CREATE TRIGGER sms_received_quarantine_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON sms_received_quarantine
    FOR EACH STATEMENT EXECUTE FUNCTION reject_sms_received_quarantine_mutation();
CREATE TRIGGER sms_received_quarantine_access_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON sms_received_quarantine_access
    FOR EACH STATEMENT EXECUTE FUNCTION reject_sms_received_quarantine_mutation();

REVOKE ALL ON sms_received_quarantine, sms_received_quarantine_access FROM PUBLIC;
