-- Unknown from reservation onward: never retain login payloads, credentials, or adapter responses.
create table platform_login_operation (
  platform text primary key check (platform in ('qq','telegram')),
  operation_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
