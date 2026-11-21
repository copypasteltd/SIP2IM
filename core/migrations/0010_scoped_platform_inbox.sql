-- Legacy inbox and platform_message remain intact: no account or peer can be inferred.
-- New rows use a separate table, avoiding any mutation or replay of legacy work.
create table platform_inbox_v1 (
  platform text not null check (platform in ('qq','telegram')),
  account_id text not null,
  peer_type text not null check (peer_type in ('user','group','channel')),
  peer_id text not null,
  message_id text not null,
  namespace text not null check (namespace = 'server'),
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending','processing','completed')),
  lease_token uuid,
  lease_until timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  pairing_outcome jsonb,
  primary key (platform, account_id, peer_type, peer_id, namespace, message_id),
  check (length(account_id) between 1 and 256 and length(peer_id) between 1 and 256 and length(message_id) between 1 and 256),
  check ((state = 'processing' and lease_token is not null and lease_until is not null) or
         (state <> 'processing' and lease_token is null and lease_until is null)),
  check ((state = 'completed') = (completed_at is not null)),
  check (pairing_outcome is null or state = 'completed')
);
create index platform_inbox_v1_ready on platform_inbox_v1 (received_at) where state <> 'completed';
