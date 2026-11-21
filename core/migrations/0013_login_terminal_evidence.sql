-- Existing reservations remain unknown. Never store command payloads or responses.
alter table platform_login_operation
  add column terminal_outcome text,
  add column terminal_at timestamptz,
  add constraint platform_login_terminal_evidence_check check (
    (terminal_outcome is null and terminal_at is null) or
    (terminal_outcome is not null and terminal_at is not null and terminal_outcome in ('ack', 'offline', 'invalid'))
  );
