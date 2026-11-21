import type {InboundSmsOutcome} from './inbound-sms.js';

export interface DeviceEventEnvelope {v?:1; id:string; type:string; payload:unknown; ts:number}
export function makeDeviceEventProducer(ports: {
  handle(id: string, event: DeviceEventEnvelope): Promise<InboundSmsOutcome>;
  readSms?(eventId: string): Promise<unknown | null>;
  publish?(type: string, data: unknown): Promise<void>;
  incomingSms?(): void;
  taskUpdated?(id: string): Promise<void>;
}) {
  return async (id: string, event: DeviceEventEnvelope): Promise<boolean> => {
    const outcome = await ports.handle(id, event);
    if (outcome === 'quarantined') return event.type === 'sms.received';
    if (outcome !== 'inserted' && outcome !== 'duplicate') return false;
    if (event.type === 'sms.result') await ports.taskUpdated?.((event.payload as {taskId: string}).taskId);
    if (event.type === 'sms.received') ports.incomingSms?.();
    return true;
  };
}
