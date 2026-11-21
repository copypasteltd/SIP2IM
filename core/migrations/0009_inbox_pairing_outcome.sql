-- Pairing decisions are committed with the inbox completion; no external effects.
alter table platform_inbox add column pairing_outcome jsonb;
alter table platform_inbox add constraint platform_inbox_pairing_outcome_completed
  check (pairing_outcome is null or (state = 'completed' and not legacy_history));
