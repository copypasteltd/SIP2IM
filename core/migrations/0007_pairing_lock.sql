create table pairing_lock (
  platform text not null references channel(platform),
  sender_id text not null,
  locked_until timestamptz not null,
  primary key (platform, sender_id)
);

-- Preserve active lockouts for databases with attempts written before this migration.
-- If legacy code recorded further failures during a lock, use the latest qualifying
-- window conservatively: it can extend a lock, but cannot shorten one.
with failures as (
  select a.platform, a.sender_id, a.ts,
         lag(a.ts, 4) over (partition by a.platform, a.sender_id order by a.ts, a.id) as fifth_previous
  from pairing_attempt a
  join channel c on c.platform = a.platform
  where not a.ok and a.ts <= clock_timestamp()
), active_locks as (
  select platform, sender_id, max(ts + interval '30 minutes') as locked_until
  from failures
  where fifth_previous > ts - interval '10 minutes'
    and ts + interval '30 minutes' > clock_timestamp()
  group by platform, sender_id
)
insert into pairing_lock(platform, sender_id, locked_until)
select platform, sender_id, locked_until from active_locks;
