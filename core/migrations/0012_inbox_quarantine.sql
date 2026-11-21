-- Preserve completed decisions; record late collisions without undoing committed work.
alter table platform_inbox_v1 drop constraint platform_inbox_v1_state_check;
alter table platform_inbox_v1 add constraint platform_inbox_v1_state_check
  check (state in ('pending','processing','completed','quarantined','deferred'));
alter table platform_inbox_v1 add column collision_detected boolean not null default false;
drop index platform_inbox_v1_ready;
create index platform_inbox_v1_ready on platform_inbox_v1 (received_at) where state in ('pending','processing');
