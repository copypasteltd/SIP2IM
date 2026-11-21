CREATE INDEX device_active_created_id ON device(created_at DESC,id DESC) WHERE revoked_at IS NULL;
