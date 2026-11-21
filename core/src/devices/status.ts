export type Source = 'heartbeat' | 'snapshot' | 'probes';
const ttl: Record<Source,number> = { heartbeat: 90, snapshot: 86400, probes: 604800 };
export interface Observation<T> { value: T; observedAt: number; ttlSec: number }
export function observation<T>(value: T, observedAt: number, source: Source): Observation<T> { return {value,observedAt,ttlSec:ttl[source]}; }
export function fresh<T>(item: Observation<T> | undefined, now: number): T | undefined { return item && item.observedAt <= now && now <= item.observedAt + item.ttlSec*1000 ? item.value : undefined; }
export interface Device { online: boolean; enabled: boolean; paused: boolean; callEnabled: boolean; capabilityLevel: string; network?: Observation<string>; shizuku?: Observation<string>; downlink?: Observation<string>; uplink?: Observation<string> }
export function canCommand(device: Device): 'DEVICE_OFFLINE' | 'DEVICE_DISABLED' | null { return !device.online ? 'DEVICE_OFFLINE' : (!device.enabled || device.paused) ? 'DEVICE_DISABLED' : null; }
export function canCall(device: Device, simState: string, now: number, incoming = false): boolean { const level = /^L[1-5]$/.test(device.capabilityLevel) ? Number(device.capabilityLevel[1]) : 0; return canCommand(device) === null && device.callEnabled && level >= (incoming ? 4 : 3) && (['wifi','cellular'].includes(fresh(device.network,now) ?? '')) && (level < 4 ? ['running','stopped','not_installed','unsupported'].includes(fresh(device.shizuku,now) ?? '') : fresh(device.shizuku,now) === 'running') && fresh(device.downlink,now) === 'ok' && fresh(device.uplink,now) === 'ok' && simState === 'ready'; }
export function isOnline(lastSeen: number | null, now: number, offlineAfterSec: number): boolean { return lastSeen !== null && now - lastSeen <= offlineAfterSec * 1000; }
