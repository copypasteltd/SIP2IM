-- Durable receipt only; external delivery and command execution are not enabled here.
create table platform_inbox (
  platform text not null check (platform in ('qq','telegram')),
  platform_message_id text not null check (length(platform_message_id) > 0),
  payload jsonb,
  legacy_history boolean not null default false,
  state text not null default 'pending' check (state in ('pending','processing','completed')),
  lease_token uuid,
  lease_until timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (platform, platform_message_id),
  check ((state = 'processing' and lease_token is not null and lease_until is not null) or
         (state <> 'processing' and lease_token is null and lease_until is null)),
  check ((legacy_history and payload is null and state = 'completed') or (not legacy_history and payload is not null)),
  check ((state = 'completed') = (completed_at is not null))
);
create index platform_inbox_ready on platform_inbox (received_at, platform, platform_message_id) where state <> 'completed';
