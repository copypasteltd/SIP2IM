import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { encodeMediaFrame } from '@voipgw/protocol';
import { MediaLeg } from './leg.js';

type Kind = 'device' | 'browser';
export interface MediaSocket {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code: number): void;
}
interface Entry {
  sessionId: string; legId: string; kind: Kind; deviceId?: string;
  tokenHash?: Buffer; leg: MediaLeg; socket?: MediaSocket; nextGeneration: number; acceptedGeneration: number; pending: Set<(code:number)=>void>;
  authorized: () => boolean;
  lastValidFrame?: number;
}
const hash = (token: string) => createHash('sha256').update(token).digest();

/** In-memory, fail-closed transport. Call lifecycle must provision and revoke legs. */
export class MediaTransport {
  private readonly entries = new Map<string, Entry>();
  private readonly authentications = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly authenticateDevice: (token: string) => Promise<{id:string;enabled:boolean}|null>, private readonly event: (sessionId:string, legId:string, name:string) => void = () => {}) {}
  private key(sessionId:string, legId:string): string { return JSON.stringify([sessionId, legId]); }
  provision(sessionId:string, legId:string, owner: ({kind:'device';deviceId:string}|{kind:'browser'}) & { current?: () => boolean }): {leg:MediaLeg; mediaToken?:string} {
    const key = this.key(sessionId,legId);
    if (this.closed) throw new Error('media transport is closed');
    if (!sessionId || !legId || this.entries.has(key)) throw new Error('invalid or duplicate media leg');
    const token = owner.kind === 'browser' ? randomBytes(32).toString('base64url') : undefined;
    const entry: Entry = {sessionId,legId,kind:owner.kind, ...(owner.kind === 'device' ? {deviceId:owner.deviceId} : {}), ...(token ? {tokenHash:hash(token)} : {}), leg: undefined as unknown as MediaLeg, nextGeneration:0, acceptedGeneration:0, pending:new Set(), authorized:owner.current ?? (()=>true)};
    entry.leg = new MediaLeg(owner.kind, frame => { const s=entry.socket; if (!s || !this.authorized(entry)) return; const data=encodeMediaFrame(frame); if (s.bufferedAmount + data.byteLength <= 65536) s.send(data); }, name => this.event(sessionId,legId,name), Date.now());
    this.entries.set(key,entry);
    return {leg:entry.leg, ...(token ? {mediaToken:token} : {})};
  }
  private authorized(entry: Entry): boolean {
    try { return !this.closed && !entry.leg.closed && entry.authorized(); } catch { return false; }
  }

  status(sessionId: string, legId: string, now = Date.now()): { attached: boolean; hasAttached: boolean; ready: boolean } {
    const entry = this.entries.get(this.key(sessionId, legId));
    const attached = !!entry?.socket && this.authorized(entry);
    const last = entry?.lastValidFrame;
    return { attached, hasAttached: !!entry?.acceptedGeneration,
      ready: attached && last !== undefined && now >= last && now - last < 2_000 };
  }

  private receive(entry: Entry, data: Uint8Array): void {
    const now = Date.now();
    if (entry.leg.receive(data, now)) entry.lastValidFrame = now;
  }

  revoke(sessionId:string,legId:string): void {
    const key=this.key(sessionId,legId), entry=this.entries.get(key); if (!entry) return;
    this.entries.delete(key); const errors:unknown[]=[];
    try { entry.leg.close(); } catch (error) { errors.push(error); }
    for (const stop of entry.pending) { try { stop(4404); } catch (error) { errors.push(error); } }
    const socket=entry.socket; entry.socket=undefined;
    try { socket?.close(4404); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'media leg revocation failed');
  }
  private revokeEntries(entries:Entry[]): void {
    const errors:unknown[]=[];
    for (const e of entries) { try { this.revoke(e.sessionId,e.legId); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'media transport revocation failed');
  }
  revokeDevice(deviceId:string): void { this.revokeEntries([...this.entries.values()].filter(e=>e.kind==='device' && e.deviceId===deviceId)); }
  close(): void { if (this.closed) return; this.closed=true; this.revokeEntries([...this.entries.values()]); }
  /** Wait for admitted device authentication to finish; call close first to prevent new work. */
  async drain(): Promise<void> { while (this.authentications.size) await Promise.all([...this.authentications]); }
  open(socket:MediaSocket, url:string, authorization?:string): {message(data:Uint8Array, binary:boolean):void; close():void} {
    let entry:Entry|undefined, authenticated=false, closed=false, pending=false;
    const queued:Uint8Array[]=[]; let queuedBytes=0;
    const clearQueue=()=>{ queued.length=0; queuedBytes=0; };
    const stop=(code:number) => { if (closed) return; closed=true; clearTimeout(timer); clearQueue(); target?.pending.delete(stop); if (entry?.socket===socket) entry.socket=undefined; socket.close(code); };
    const timer=setTimeout(()=>stop(4401),5000);
    let target:Entry|undefined;
    if (this.closed) stop(4404);
    try { const parsed=new URL(url,'http://localhost'); const params=parsed.searchParams;
      if (parsed.pathname !== '/ws/media' || [...params.keys()].some(k=>k !== 'session' && k !== 'leg') || params.getAll('session').length!==1 || params.getAll('leg').length!==1) { stop(4403); }
      else target=this.entries.get(this.key(params.get('session')!,params.get('leg')!));
    } catch { stop(4403); }
    if (!closed && !target) stop(4404);
    const generation=target ? ++target.nextGeneration : 0;
    if (!closed && target) target.pending.add(stop);
    const attach=(candidate:Entry) => {
      if (closed) return;
      if (this.entries.get(this.key(candidate.sessionId,candidate.legId))!==candidate || !this.authorized(candidate)) { stop(4404); return; }
      if (generation < candidate.acceptedGeneration) { stop(4409); return; }
      if (candidate.acceptedGeneration !== 0) candidate.leg.resetConnection(Date.now());
      candidate.lastValidFrame=undefined;
      candidate.acceptedGeneration=generation; candidate.pending.delete(stop);
      entry=candidate; authenticated=true; clearTimeout(timer);
      const previous=candidate.socket; candidate.socket=socket; if (previous && previous!==socket) previous.close(4409);
    };
    if (!closed && target && authorization !== undefined) {
      const match=/^Bearer ([^\s]+)$/i.exec(authorization);
      if (target.kind !== 'device' || !match) stop(4403);
      else {
        pending=true; const candidate=target;
        // Register before invoking user code, which can throw or synchronously close the transport.
        let finish!:()=>void; const tracked=new Promise<void>(resolve=>{ finish=resolve; });
        this.authentications.add(tracked);
        let authentication:Promise<{id:string;enabled:boolean}|null>;
        try { authentication=Promise.resolve(this.authenticateDevice(match[1]!)); }
        catch { authentication=Promise.reject(new Error('device authentication failed')); }
        void authentication.then(device=>{
          pending=false; if (closed) return;
          if (!device || !device.enabled || device.id!==candidate.deviceId) { stop(4403); return; } attach(candidate);
          for (const bytes of queued) { if (closed || candidate.socket!==socket) break; if (!this.authorized(candidate)) { stop(4404); break; } this.receive(candidate,bytes); if (candidate.leg.closed) stop(4403); } clearQueue();
        }).catch(()=>{ try { stop(4403); } catch { /* Socket close failed; authentication still must settle. */ } }).finally(()=>{ this.authentications.delete(tracked); finish(); });
      }
    }
    return {
      message: (data,binary) => {
        if (closed) return;
        if (!authenticated) {
          if (pending) { if (!binary || queued.length>=64 || queuedBytes+data.byteLength>65536) { stop(4403); return; } queued.push(Uint8Array.from(data)); queuedBytes+=data.byteLength; return; }
          if (!target || target.kind !== 'browser' || binary || data.byteLength>4096) { stop(4403); return; }
          let value:unknown; try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)); } catch { stop(4403); return; }
          const obj=value as {type?:unknown;token?:unknown}|null;
          if (!obj || obj.type!=='auth' || typeof obj.token!=='string' || !target.tokenHash || !timingSafeEqual(hash(obj.token),target.tokenHash)) { stop(4403); return; }
          target.tokenHash=undefined; attach(target); return;
        }
        if (!entry || entry.socket!==socket) return;
        if (!binary) { stop(4403); return; }
        if (!this.authorized(entry)) { stop(4404); return; }
        this.receive(entry,data); if (entry.leg.closed) stop(4403);
      },
      close: () => { if (closed) return; closed=true; clearTimeout(timer); clearQueue(); target?.pending.delete(stop); if (entry?.socket===socket) entry.socket=undefined; }
    };
  }
}
