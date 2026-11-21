export type SmsIntent = { version: 1; owner: string; simId: string; peer: string; body: string; key: string };
const storageKey = 'voip.sms.pending.v1';
const eventName = 'voip-sms-intent-change';
function validateIntent(value: unknown): SmsIntent {
 if (!value || typeof value !== 'object') throw new Error('Invalid saved intent');
 const v = value as Record<string, unknown>;
 if (v.version !== 1 || !['owner','simId','peer','body','key'].every(k => typeof v[k] === 'string') || !v.owner || typeof v.simId !== 'string' || !v.simId || v.simId.length > 128 || typeof v.peer !== 'string' || !v.peer || v.peer.length > 64 || typeof v.body !== 'string' || !v.body || v.body.length > 10000 || typeof v.key !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v.key)) throw new Error('Invalid saved intent');
 return v as SmsIntent;
}
export function readIntent(): SmsIntent | null { const raw=sessionStorage.getItem(storageKey); return raw === null ? null : validateIntent(JSON.parse(raw)); }
export function saveIntent(intent: SmsIntent): void { validateIntent(intent); sessionStorage.setItem(storageKey, JSON.stringify(intent)); window.dispatchEvent(new Event(eventName)); }
export function clearIntent(intent: SmsIntent): boolean { if (JSON.stringify(readIntent()) !== JSON.stringify(intent)) return false; sessionStorage.removeItem(storageKey); window.dispatchEvent(new Event(eventName)); return true; }
export function subscribeIntent(listener: () => void): () => void { window.addEventListener(eventName, listener); return () => window.removeEventListener(eventName, listener); }
let active = false;
export function acquireIntent(): boolean { if (active) return false; active = true; return true; }
export function releaseIntent(): void { active = false; window.dispatchEvent(new Event(eventName)); }
