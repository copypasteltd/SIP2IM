-- A device call ID with a proven collision cannot identify any call generation.
CREATE TABLE call_identity_quarantine (
  device_id text NOT NULL REFERENCES device(id),
  call_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, call_id)
);
-- Preserve collisions already recorded by earlier Core versions.
INSERT INTO call_identity_quarantine(device_id,call_id)
SELECT DISTINCT s.device_id,e.payload->>'callId' FROM call_event e
JOIN call_session s ON s.id=e.session_id
WHERE e.payload->>'reason'='call_id_collision' AND e.payload->>'callId' IS NOT NULL
ON CONFLICT DO NOTHING;
