-- Existing failed rows have unknown provenance; do not infer a negative acknowledgement.
ALTER TABLE sms_task ADD COLUMN negative_ack boolean NOT NULL DEFAULT false, ADD COLUMN local_failure boolean NOT NULL DEFAULT false, ADD COLUMN legacy_failure boolean NOT NULL DEFAULT false;
UPDATE sms_task SET legacy_failure=true WHERE state='failed';
UPDATE sms_task t SET state='unknown', error_code='SMS_RESULT_CONFLICT', updated_at=now()
WHERE t.legacy_failure AND EXISTS (
 SELECT 1 FROM device_event e JOIN sms_message m ON m.id=t.sms_message_id AND m.device_id=e.device_id
 WHERE e.type='sms.result' AND e.payload->>'taskId'=t.id AND e.payload->>'state' IN ('sent','delivered')
);
