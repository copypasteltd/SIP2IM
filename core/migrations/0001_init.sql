create table admin (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  failed_count int not null default 0,
  locked_until timestamptz,
  locale text not null default 'zh-CN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admin_session (
  token_hash bytea primary key,
  admin_id text not null references admin(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table device (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  paused boolean not null default false,
  call_enabled boolean not null default false,
  default_sim_id text,
  manufacturer text, model text, api_level int,
  capability_level text, apk_version text, apk_code int,
  locale text,
  last_seen_at timestamptz,
  online boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table device_credential (
  token_hash bytea primary key,
  device_id text not null references device(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table binding_code (
  code_hash bytea primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_device text references device(id),
  created_at timestamptz not null default now()
);

create table sim (
  id text primary key,
  device_id text not null references device(id),
  slot int not null,
  sub_id int,
  carrier text, mcc text, mnc text,
  state text not null,
  reported_number text,
  needs_review boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sim_device_slot_active on sim(device_id, slot) where retired_at is null;
alter table device add constraint device_default_sim_fk foreign key (default_sim_id) references sim(id);

create table sim_number (
  sim_id text primary key references sim(id),
  number text not null,
  number_kind text not null,
  source text not null check (source in ('reported','manual')),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index sim_number_number on sim_number(number);

create table device_status (
  device_id text not null references device(id),
  field text not null,
  value jsonb not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  ttl_sec int not null,
  primary key (device_id, field)
);

-- device_event：保存设备上报的 status.snapshot、call.*、sms.result 原始事件与连接事件（connected/disconnected/close_code）。
-- heartbeat 不入此表（只更新 device_status），以控制数据量。id = 设备事件信封 id（evt_）或 core 生成的 evt_（连接事件）。
create table device_event (
  id text primary key,
  device_id text not null references device(id),
  type text not null,
  payload jsonb not null,
  device_ts timestamptz,
  received_at timestamptz not null default now()
);
create index device_event_device_time on device_event(device_id, received_at desc);

create table sms_message (
  id text primary key,
  device_id text not null references device(id),
  sim_id text references sim(id),
  direction text not null check (direction in ('in','out')),
  peer text not null,
  peer_kind text not null,
  body text not null,
  parts int not null default 1,
  event_id text unique,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sms_message_thread on sms_message(device_id, sim_id, peer, occurred_at desc);

create table sms_task (
  id text primary key,
  sms_message_id text not null references sms_message(id),
  origin text not null check (origin in ('admin','command')),
  origin_ref text,
  state text not null,
  error_code text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table call_session (
  id text primary key,
  kind text not null check (kind in ('web_out','platform_in','platform_out')),
  idempotency_key text unique,
  device_id text not null references device(id),
  sim_id text references sim(id),
  peer text, peer_kind text,
  platform text,
  state text not null,
  end_cause text,
  prompt_played boolean not null default false,
  early_media_forwarded boolean not null default false,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index call_session_time on call_session(started_at desc);

create table call_leg (
  id text primary key,
  session_id text not null references call_session(id),
  type text not null check (type in ('cellular','platform','browser')),
  ref_id text,
  state text not null,
  connected_at timestamptz,
  ended_at timestamptz,
  end_cause text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table call_event (
  id text primary key,
  session_id text not null references call_session(id),
  leg_id text references call_leg(id),
  event text not null,
  payload jsonb not null default '{}',
  ts timestamptz not null default now()
);
create index call_event_session on call_event(session_id, ts);

create table channel (
  platform text primary key check (platform in ('qq','telegram')),
  state text not null default 'logged_out',
  self_id text,
  alias text,
  capabilities jsonb not null default '{}',
  voice_verified boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
insert into channel(platform) values ('qq'), ('telegram');

create table paired_user (
  id text primary key,
  platform text not null references channel(platform),
  platform_user_id text not null,
  display_name text,
  paired_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text
);
create unique index paired_user_active on paired_user(platform) where revoked_at is null;

create table pairing_code (
  id text primary key,
  platform text not null references channel(platform),
  code_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text,
  created_at timestamptz not null default now()
);

create table pairing_attempt (
  id text primary key,
  platform text not null,
  sender_id text not null,
  ok boolean not null,
  ts timestamptz not null default now()
);
create index pairing_attempt_sender on pairing_attempt(platform, sender_id, ts desc);

create table platform_message (
  id text primary key,
  platform text not null,
  direction text not null check (direction in ('in','out')),
  platform_message_id text,
  peer_id text not null,
  text text not null,
  purpose text,
  ref_id text,
  ts timestamptz not null default now(),
  unique (platform, direction, platform_message_id)
);

create table outbound_request (
  id text primary key,
  kind text not null check (kind in ('call','sms')),
  platform text not null,
  paired_user_id text not null references paired_user(id),
  platform_message_id text not null,
  raw_text text not null,
  from_number text,
  from_sim_id text references sim(id),
  to_number text,
  to_kind text,
  body text,
  state text not null,
  reject_code text,
  session_id text references call_session(id),
  sms_task_id text references sms_task(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, platform_message_id)
);

create table alert (
  id text primary key,
  type text not null,
  subject_type text not null,
  subject_id text not null,
  severity text not null check (severity in ('info','warning','critical')),
  state text not null check (state in ('open','acked','resolved')),
  detail jsonb not null default '{}',
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  pushed_at timestamptz,
  resolved_at timestamptz
);
create unique index alert_open on alert(type, subject_id) where state = 'open';

create table audit_log (
  id text primary key,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  ip text,
  ts timestamptz not null default now()
);

create table setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
