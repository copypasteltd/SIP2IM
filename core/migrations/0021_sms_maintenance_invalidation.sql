-- Pending maintenance task updates, coalesced by task identity.
CREATE TABLE sms_maintenance_admin_invalidation (
  task_id text PRIMARY KEY REFERENCES sms_task(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_maintenance_admin_invalidation_order ON sms_maintenance_admin_invalidation(created_at, task_id);
