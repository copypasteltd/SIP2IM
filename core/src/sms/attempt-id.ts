import { ulid } from 'ulid';

// Use the maximum ULID timestamp as a dedicated range. Existing command, hello.ok,
// and ACK allocators use the current clock. The envelope ts still describes real time.
const smsCommandTime = 2 ** 48 - 1;
const smsCommandId = /^cmd_7ZZZZZZZZZ[0-9A-HJKMNP-TV-Z]{16}$/;

export function allocateSmsCommandId(): string {
  return 'cmd_' + ulid(smsCommandTime);
}

export function isSmsCommandId(id: string): boolean {
  return id.length === 30 && smsCommandId.test(id);
}
