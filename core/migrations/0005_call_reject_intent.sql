create table call_reject_intent (
 session_id text primary key references call_session(id),
 device_id text not null references device(id),
 call_id text not null,
 state text not null check (state in ('pending','sending','accepted','unknown','done')),
 attempts integer not null default 0,
 lease_until timestamptz,
 expires_at timestamptz not null default now() + interval '60 seconds',
 updated_at timestamptz not null default now()
);
create index call_reject_intent_pending on call_reject_intent(state, device_id);
