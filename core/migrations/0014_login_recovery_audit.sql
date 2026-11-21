-- This audit contains no login payload, response, or credentials.
create table platform_login_recovery_audit (
  operation_id uuid primary key,
  platform text not null check (platform in ('qq','telegram')),
  terminal_outcome text not null check (terminal_outcome in ('ack','offline','invalid')),
  terminal_at timestamptz not null,
  actor text not null check (actor ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  recovered_at timestamptz not null default clock_timestamp()
);
