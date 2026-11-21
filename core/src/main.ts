import { WebSocketServer } from 'ws';
import { websocketServerCloser } from './ws-server-close.js';
import { wireSessionSocket } from './ws-session-wiring.js';
import { Lifecycle } from './lifecycle.js';
import { runWithSignals } from './signal-handling.js';
import { acquireCoreOwnership } from './db/ownership.js';
import { TrackedInterval } from './tracked-interval.js';
import { MediaTransport } from './media/transport.js';
import { loadConfig } from './config/load.js';
import { createPool,transaction } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { AuthService,tokenHash } from './auth/service.js';
import { PgAuthRepository } from './auth/repo.js';
import { BindingRepository } from './devices/binding.js';
import { createServer } from './http/server.js';
import { DeviceSessions } from './ws-device/session.js';
import { AdminSessions } from './ws-admin/session.js';
import { AdminHub } from './ws-admin/hub.js';
import { DeviceStatusRepository } from './devices/repo.js';
import { DeviceHealthAlerts } from './devices/health-alerts.js';
import { DeviceProtocolAlerts } from './devices/protocol-alerts.js';
import type { AlertEvent } from './alerts/episodes.js';
import { DeviceEvents } from './devices/events.js';
import {makeDeviceEventProducer,type DeviceEventEnvelope} from './devices/event-producer.js';
import { DeviceAdminRepository } from './devices/admin-repo.js';
import { createDeviceAdminOperations } from './devices/admin-operations.js';
import { SimRepository } from './devices/sim-repo.js';
import { DeviceDetailRepository } from './devices/detail-repo.js';
import { readShizukuConfig, registerShizukuReport, setShizukuAutostart } from './devices/shizuku-report.js';
import { DeviceCommands } from './ws-device/commands.js';
import { SmsDispatcher } from './sms/dispatch.js';
import { SimRateLimiter } from './sms/state.js';
import { SmsRepository } from './sms/repo.js';
import { SmsAttemptRepository } from './sms/attempt-repo.js';
import { IncomingSmsOutbox } from './sms/incoming-outbox.js';
import { SmsQueueRepository,type DispatchRecord } from './sms/queue-repo.js';
import { SmsCreateRepository } from './sms/create.js';
import { SmsIdempotencyRepository } from './sms/idempotency.js';
import { SmsRateRuntime } from './sms/rate-runtime.js';
import { transactionOutcome } from './settings/transaction-outcome.js';
import { SmsMaintenanceInvalidation } from './sms/maintenance-invalidation.js';
import { SmsHistory } from './sms/history.js';
import { SmsHistoryOptions } from './sms/history-options.js';
import { SettingsRepository } from './settings/repo.js';
import { DeviceConfigSync } from './settings/device-config.js';
import { SettingsService } from './settings/service.js';
import { ChannelRepository } from './channels/repo.js';
import { AdapterRuntime } from './channels/adapter-runtime.js';
import { AdapterAdmissionRejected } from './channels/adapter-manager.js';
import { LoginOperationRepository, PersistentLoginOperations } from './channels/login-persistent.js';
import { registerChannelRoutes } from './channels/routes.js';
import { registerChannelControlRoutes } from './channels/control-routes.js';
import { CallReadRepository } from './calls/read-repo.js';
import { RejectIntentWorker } from './calls/device-events.js';
import { reconcileCalls } from './calls/reconcile.js';
import { CallFailureAlerts } from './calls/failure-alerts.js';
import { registerSettingsPut } from './settings/routes.js';
import { registerOperations } from './http/operations.js';
import { registerWebCallRoutes } from './http/web-calls.js';
import { PgWebCallStore } from './calls/web-call-store.js';
import { WebCalls } from './calls/web-calls.js';
import {AuditRepository,registerAudit} from './http/audit.js';
import { DashboardRepository } from './dashboard/repo.js';
import { DashboardService } from './dashboard/service.js';
import { registerDashboardRoute } from './dashboard/routes.js';
import { assertSmsCustodyReady } from './db/sms-quarantine-custody.js';
import { createRecoverableSmsQuarantineReader } from './db/sms-quarantine-reader.js';
import { registerRecoverableSmsQuarantineInventory } from './http/sms-quarantine-inventory.js';
const lifecycle = new Lifecycle();
const transportLifecycle = new Lifecycle();
let closeApp: (() => Promise<void>) | undefined;
let ownershipLost = false;
let shutdownWatchdog: ReturnType<typeof setTimeout> | undefined;
const watchShutdown = () => {
  shutdownWatchdog ??= setTimeout(() => {
    console.error('Core shutdown exceeded its time budget');
    process.exit(1);
  }, 30_000);
};
const outcome = await runWithSignals(process, async (stopping, requestStop) => {
  stopping.addEventListener('abort', watchShutdown, { once: true });
const config = await loadConfig(process.env.VOIPGW_CONFIG ?? '/etc/voip-gateway/config.toml');
if (stopping.aborted) return;
const ownership = await acquireCoreOwnership(config.database, () => {
  ownershipLost = true;
  requestStop();
}, undefined, 5_000, 2_000);
// The pool and all protected work drain before the lock session can close.
lifecycle.defer(() => ownership.close(), { requiresCriticalSuccess: true });
if (stopping.aborted) return;
const assertAdmission = (): void => {
  ownership.assertHeld();
  if (stopping.aborted) throw new Error('Core is stopping');
};
assertAdmission();
const pool = createPool(config.database);
lifecycle.defer(()=>pool.end(),{critical:true,requiresCriticalSuccess:true});
await migrate(pool, process.env.VOIPGW_MIGRATIONS ?? 'core/migrations', assertAdmission);
if (stopping.aborted) return;
const custodyMode = process.env.VOIPGW_SMS_CUSTODY_MODE ?? 'disabled';
if (custodyMode !== 'disabled' && custodyMode !== 'retain' && custodyMode !== 'acknowledge') throw new Error('Invalid SMS custody mode');
const custodyAdmin = process.env.VOIPGW_SMS_CUSTODY_ADMIN_ID;
if (custodyMode !== 'disabled' || custodyAdmin !== undefined) {
  if (!custodyAdmin || !/^adm_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(custodyAdmin)) throw new Error('An SMS custody operator is required');
  await assertSmsCustodyReady(pool);
  const owner = await pool.query('SELECT id FROM admin WHERE id=$1', [custodyAdmin]);
  if (owner.rowCount !== 1) throw new Error('SMS custody operator was not found');
  if (stopping.aborted) return;
}
const shizuku = readShizukuConfig(process.env.VOIPGW_SHIZUKU_DEVICE_MAP, process.env.VOIPGW_SHIZUKU_REPORT_TOKEN);
const auth=new AuthService(new PgAuthRepository(pool));const binding=new BindingRepository(pool);const status=new DeviceStatusRepository(pool);const events=new DeviceEvents(pool, { smsCustody: custodyMode });const deviceAdmin=new DeviceAdminRepository(pool);const smsCreate=new SmsCreateRepository(pool);const simRepo=new SimRepository(pool);const smsHistory=new SmsHistory(pool);const smsHistoryOptions=new SmsHistoryOptions(pool);const settingsRepo=new SettingsRepository(pool);const channels=new ChannelRepository(pool);const calls=new CallReadRepository(pool);const deviceDetail=new DeviceDetailRepository(pool, deviceAdmin, shizuku?.devices);
let adapterRuntime: AdapterRuntime | undefined;
let webCalls: WebCalls | undefined;
let smsRateRuntime: SmsRateRuntime | undefined;
const deviceOperations=createDeviceAdminOperations({update:(id,patch)=>deviceAdmin.update(id,patch),revoke:id=>deviceAdmin.revoke(id),get:id=>deviceAdmin.get(id),revokeSession:(id,code)=>sessions.revoke(id,code),revokeMedia:id=>media.revokeDevice(id)});
const app=createServer({inspectSmsIdempotency:key=>new SmsIdempotencyRepository(pool).find(key),login:(u,p)=>auth.login(u,p),authenticate:t=>auth.authenticate(t),admin:async id=>{const r=await pool.query('SELECT username,locale FROM admin WHERE id=$1',[id]);return (r.rows[0] as {username:string;locale:string}|undefined)??null;},logout:async token=>{await pool.query('DELETE FROM admin_session WHERE token_hash=$1',[tokenHash(token)]);adminSessions.revokeToken(token);webCalls?.revokeOwner(tokenHash(token).toString('hex'));},changePassword:async(u,o,n)=>{const changed=await auth.changePassword(u,o,n);if(changed){adminSessions.revokeAll();webCalls?.revokeAllOwners();}return changed;},setLocale:async(id,locale)=>{await pool.query('UPDATE admin SET locale=$2,updated_at=now() WHERE id=$1',[id,locale]);},createCode:()=>binding.createCode(),bind:i=>binding.bind(i),
  bindV2: (input, credentialHash) => binding.bindV2(input, credentialHash),
  listBindingCodes: cursor => binding.listCodes(cursor),
  cancelBindingCode: async recordId => {
    const result = await binding.cancelCode(recordId);
    if (result?.deviceId && result.teardownPending) {
      await deviceOperations.teardownRevokedDevice(result.deviceId);
      await binding.markTeardownComplete(recordId);
      return { ...result, teardownPending: false };
    }
    return result;
  },
  health:async()=>{try{await pool.query('SELECT 1');return true;}catch{return false;}},adapterHealth:()=>({qq:adapterRuntime?.manager.status('qq')??'unknown',telegram:adapterRuntime?.manager.status('telegram')??'unknown'}),getSettings:()=>settings.get(),listChannels:()=>channels.list(),listCalls:f=>calls.list(f),callDetail:id=>calls.detail(id),callSummary:id=>calls.summary(id),callEvents:(id,limit,cursor)=>calls.eventPage(id,limit,cursor),listSms:f=>smsHistory.list(f),historyDevices:f=>smsHistoryOptions.devices(f),historySims:f=>smsHistoryOptions.sims(f),listThreads:(id,limit,cursor)=>smsHistory.threads(id,limit,cursor),createSms:async(key,simId,to,body)=>{const result=await smsCreate.create(key,simId,to,body);if(result&&!result.conflict)smsRateRuntime?.request(result.deviceId);return result;},setSimNumber:(id,number,kind,expectedNumber)=>simRepo.setNumber(id,number,kind,expectedNumber),reviewSim:async id=>{if(!await simRepo.review(id))return null;const row=await pool.query<{device_id:string}>('SELECT device_id FROM sim WHERE id=$1 AND retired_at IS NULL',[id]);const deviceId=row.rows[0]?.device_id;if(!deviceId)return null;const device=await deviceAdmin.get(deviceId) as {sims:{id:string}[]}|null;return device?.sims.find(s=>s.id===id)??null;},probeDevice:async id=>{const r=await pool.query('SELECT online,enabled,paused FROM device WHERE id=$1 AND revoked_at IS NULL',[id]);const d=r.rows[0] as {online:boolean;enabled:boolean;paused:boolean}|undefined;if(!d||!d.online)return 'DEVICE_OFFLINE';if(!d.enabled||d.paused)return 'DEVICE_DISABLED';try{assertAdmission();const ack=await commands.send(id,'probe.run',{items:['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia']});return ack.ok?'ok':'DEVICE_DISABLED';}catch{return 'TIMEOUT_UNKNOWN';}},listDevices:f=>deviceAdmin.page(f),deviceDetail:id=>deviceDetail.get(id),revokeDevice:id=>deviceOperations.revokeDevice(id),updateDevice:(id,patch)=>deviceOperations.updateDevice(id,patch),publicHost:config.server.public_host,port:config.server.port});
closeApp=()=>app.close();
if (custodyAdmin !== undefined) {
  registerRecoverableSmsQuarantineInventory(app, {
    authenticate: token => auth.authenticate(token),
    authorize: actor => !stopping.aborted && actor === custodyAdmin,
    auditAndRead: createRecoverableSmsQuarantineReader(pool),
  });
}
// An upgraded socket can keep the HTTP server open. Close the transports
// in preClose, then let Fastify await the remaining HTTP requests.
app.addHook('preClose', () => transportLifecycle.close());
app.addHook('onRequest', async (_request, reply) => {
  if (stopping.aborted) return reply.code(503).send({ error: { code: 'INTERNAL', message: 'INTERNAL', details: null } });
});
const smsAttempts = new SmsAttemptRepository(pool);
await smsAttempts.reconcile(assertAdmission);
if (stopping.aborted) return;
await reconcileCalls(pool, assertAdmission);
if (stopping.aborted) return;
const hub = new AdminHub(token => auth.authenticate(token));
lifecycle.defer(() => hub.stop(), { critical: true });
const notifyDevice = (id: string) => hub.publishLatest('device.updated', () => deviceAdmin.get(id));
const healthAlerts = new DeviceHealthAlerts(pool);
const callFailureAlerts = new CallFailureAlerts(pool);
const publishOperationalAlert = (type: AlertEvent['type'], data: unknown) =>
  stopping.aborted ? Promise.resolve() : hub.publish(type, data);
if (shizuku) {
  registerShizukuReport(app, shizuku, (id, report) =>
    setShizukuAutostart(pool, id, report, event => publishOperationalAlert(event.type, event.data)), () => !stopping.aborted);
}
const notifyAlert = (id: string) => hub.publishLatest('alert.raised', async () => {
  const result = await pool.query(`SELECT id,type,subject_type AS "subjectType",subject_id AS "subjectId",severity,state,detail,
    floor(extract(epoch from first_at)*1000)::double precision AS "firstAt",
    floor(extract(epoch from last_at)*1000)::double precision AS "lastAt",
    floor(extract(epoch from pushed_at)*1000)::double precision AS "pushedAt",
    floor(extract(epoch from resolved_at)*1000)::double precision AS "resolvedAt"
    FROM alert WHERE state='open' AND (type,subject_type) IN (('sms_ingestion_blocked','device'),('sms_receive_quarantined','sms_quarantine'))
    AND detail->>'eventId' = $1 ORDER BY last_at DESC LIMIT 1`, [id]);
  return result.rows[0] ?? null;
});
const commands=new DeviceCommands(assertAdmission);
const deviceConfigSync = new DeviceConfigSync(async () => {
  const { heartbeatSec, botLocale } = await settingsRepo.get();
  return { heartbeatSec, locale: botLocale };
}, () => commands.configAttachments(), assertAdmission, () => app.log.warn('Device configuration readback failed'));
transportLifecycle.defer(() => deviceConfigSync.stop(), { critical: true });
const settings = new SettingsService({
  get: () => settingsRepo.get(),
  update: async (patch, expected) => {
    try {
      const result = await settingsRepo.update(patch, expected);
      if (result.before.smsRatePerMin !== result.after.smsRatePerMin) smsRateRuntime?.changed(result.after.smsRatePerMin);
      if (result.before.heartbeatSec !== result.after.heartbeatSec || result.before.botLocale !== result.after.botLocale) deviceConfigSync.invalidate();
      return result;
    } catch (error) {
      const outcome = transactionOutcome(error);
      if (outcome && (Object.hasOwn(patch, 'heartbeatSec') || Object.hasOwn(patch, 'botLocale'))) deviceConfigSync.invalidate();
      if (Object.hasOwn(patch, 'smsRatePerMin')) {
        if (outcome === 'unknown') smsRateRuntime?.changed(undefined);
        else if (outcome === 'committed') {
          smsRateRuntime?.invalidate();
          void smsRateRuntime?.refresh();
        }
      }
      throw error;
    }
  },
}, {
  publish: value => hub.publish('settings.updated', value),
}, effect => app.log.error({ effect }, 'Settings effect failed'));
lifecycle.defer(() => settings.drain(), { critical: true });
registerAudit(app,item=>new AuditRepository(pool).record(item),()=>{process.stderr.write('audit write failed\n');});registerSettingsPut(app,settings,t=>auth.authenticate(t));registerChannelRoutes(app,settings,channels,t=>auth.authenticate(t));registerOperations(app,pool,t=>auth.authenticate(t),assertAdmission);registerDashboardRoute(app,new DashboardService(new DashboardRepository(pool)),t=>auth.authenticate(t));const smsRepo=new SmsRepository(pool);
const smsQueue=new SmsQueueRepository(pool);
const maintenanceInvalidation=new SmsMaintenanceInvalidation(pool,(type,data)=>hub.publish(type,data));
transportLifecycle.defer(()=>maintenanceInvalidation.stop(),{critical:true});
const flushSmsTasks = () => {
  void maintenanceInvalidation.flush().catch(error => app.log.error({ err: error }, 'SMS task notification dispatch failed'));
};
const dispatcher=new SmsDispatcher({
  queued: id => smsQueue.queued(id),
  canCommand: id => smsQueue.canCommand(id),
  simState: (id, device) => smsQueue.simState(id, device),
  mark: async (id, from, to, error, task) => {
    const changed = await smsRepo.changeState(id, from, to, error, task);
    if (changed) flushSmsTasks();
    return changed;
  },
  prepare: task => {
  if (stopping.aborted) return null;
  const t = task as DispatchRecord;
  const transport = commands.prepareSms(t.deviceId, {
    taskId: t.id, subId: t.subId, slot: t.slot, to: t.to, body: t.body,
  });
  if (!transport) return null;
  const attempt = smsAttempts.prepare({
    taskId: t.id, deviceId: t.deviceId, simId: t.simId, slot: t.slot,
    subId: t.subId, commandId: transport.commandId,
  });
    return {
      ...attempt,
      send: transport.send,
      claim: async () => {
        const claimed = await attempt.claim();
        if (claimed) flushSmsTasks();
        return claimed;
      },
      acknowledge: async ack => { await attempt.acknowledge(ack); flushSmsTasks(); },
      markUnknown: async () => { await attempt.markUnknown(); flushSmsTasks(); },
    };
  },
}, new SimRateLimiter());
stopping.addEventListener('abort', () => { void dispatcher.stop(); }, { once: true });
if (stopping.aborted) void dispatcher.stop();
transportLifecycle.defer(()=>dispatcher.stop(),{critical:true});
const activeSmsRateRuntime = new SmsRateRuntime({
  readRate: () => smsQueue.rate(),
  queuedDevices: after => smsQueue.queuedDevices(after),
  setRate: rate => dispatcher.setRate(rate),
  flush: (id, rate) => stopping.aborted ? Promise.resolve() : dispatcher.flush(id, rate),
  report: error => app.log.error({ err: error }, 'SMS scheduling failed'),
});
smsRateRuntime = activeSmsRateRuntime;
stopping.addEventListener('abort', () => { void activeSmsRateRuntime.stop(); }, { once: true });
if (stopping.aborted) void activeSmsRateRuntime.stop();
transportLifecycle.defer(()=>activeSmsRateRuntime.stop(),{critical:true});
flushSmsTasks();
const incomingOutbox=new IncomingSmsOutbox(pool,(type,data)=>hub.publish(type,data));
const flushIncoming=()=>{void incomingOutbox.flush().catch(error=>app.log.error({err:error},'incoming SMS notification dispatch failed'));};
transportLifecycle.defer(()=>incomingOutbox.stop(),{critical:true});
flushIncoming();
adapterRuntime = new AdapterRuntime({repository:channels,adapters:config.adapters,publish:(type,data)=>hub.publish(type,data)});
transportLifecycle.defer(()=>adapterRuntime.close(),{critical:true});
await adapterRuntime.start();
if (stopping.aborted) return;
const adapterManager = adapterRuntime.manager;
const assertAdapterAdmission = () => {
  try { assertAdmission(); }
  catch { throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE'); }
};
const loginOperations = new PersistentLoginOperations({
  prepareLogin: (platform, type, payload) => {
    assertAdapterAdmission();
    const send = adapterManager.prepareLogin(platform, type, payload);
    return observeLate => {
      assertAdapterAdmission();
      return send(observeLate);
    };
  },
}, new LoginOperationRepository(pool));
registerChannelControlRoutes(app, loginOperations, token => auth.authenticate(token), {
  loginStep: platform => stopping.aborted ? null : adapterManager.loginStep(platform),
  assertAdmission: assertAdapterAdmission,
});
const rejectWorker=new RejectIntentWorker(pool);
transportLifecycle.defer(()=>rejectWorker.stop(),{critical:true});
const sessions=new DeviceSessions({protocolAlerts:new DeviceProtocolAlerts(pool, assertAdmission, publishOperationalAlert),authenticate:t=>binding.authenticate(t),heartbeatSec:30,locale:'zh-CN',currentConfig:async()=>{const s=await settings.get();return {heartbeatSec:s.heartbeatSec,locale:s.botLocale};},commands,heartbeat:async(id,payload,ts)=>{const result=await status.heartbeat(id,payload as Record<string,unknown>,ts);if(!result.accepted || stopping.aborted)return;smsRateRuntime?.request(id);await notifyDevice(id);},onEvent:(id,event,context)=>stopping.aborted ? Promise.resolve(false) : makeDeviceEventProducer({handle:async(device,e)=>{const outcome=await events.handle(device,e,context);if (outcome === 'inserted' && (e.type === 'call.incoming' || e.type === 'call.state')) {
    void hub.publishLatest('call.updated', () => calls.summaryForEvent(e.id)).catch(() => {});
  }
  if (e.type === 'sms.received' && (outcome === 'quarantined' || outcome === 'rejected')) void notifyAlert(e.id).catch(() => {});return outcome;},incomingSms:flushIncoming,taskUpdated:async()=>flushSmsTasks(),
  snapshotCommitted: deviceId => {
    if (!stopping.aborted && context.isCurrent()) smsRateRuntime?.request(deviceId);
  },
})(id,event as DeviceEventEnvelope)});
const adminSessions=new AdminSessions(t=>auth.authenticate(t));
const stopSessions=async()=>{
  const results=await Promise.allSettled([Promise.resolve().then(()=>sessions.stop()),Promise.resolve().then(()=>adminSessions.stop())]);
  const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'session shutdown failed');
};
transportLifecycle.defer(stopSessions,{critical:true});
const ws=new WebSocketServer({noServer:true,maxPayload:65536});
const wsCloser=websocketServerCloser(ws);
transportLifecycle.defer(()=>wsCloser.wait(),{critical:true});
const media=new MediaTransport(t=>binding.authenticate(t));
transportLifecycle.defer(async()=>{
  const errors:unknown[]=[];
  try { media.close(); } catch(error) { errors.push(error); }
  try { await media.drain(); } catch(error) { errors.push(error); }
  if(errors.length)throw new AggregateError(errors,'media shutdown failed');
},{critical:true});
// Configure only devices whose generation-bound control and bidirectional audio
// have been verified for the exact target installation. Default is disabled.
const verifiedVoice = new Set((process.env.VOIPGW_VERIFIED_WEB_CALL_DEVICE_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean));
if ([...verifiedVoice].some(value => !/^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value))) throw new Error('Invalid verified voice device ID');
const captureVoice = (deviceId: string) => {
  if (!verifiedVoice.has(deviceId) || stopping.aborted) return null;
  const attachment = commands.captureCallAttachment(deviceId);
  return attachment && { ...attachment, current: () => !stopping.aborted && attachment.current() };
};
const browserCalls = new WebCalls({
  store: new PgWebCallStore(pool), media, capture: captureVoice,
  summary: sessionId => calls.summary(sessionId),
  authorizeOwner: async hash => {
    if (stopping.aborted) return null;
    const r = await pool.query<{expiresAt: number}>(
      'SELECT floor(extract(epoch from expires_at)*1000)::double precision AS "expiresAt" FROM admin_session WHERE token_hash=$1 AND expires_at>clock_timestamp()',
      [Buffer.from(hash, 'hex')],
    );
    return stopping.aborted ? null : r.rows[0]?.expiresAt ?? null;
  },
  update: sessionId => { void hub.publishLatest('call.updated', () => calls.summary(sessionId)).catch(() => {}); },
  automatic: verifiedVoice.size > 0,
  reportFailure: () => app.log.error('Browser call state could not be reconciled'),
});
webCalls = browserCalls;
transportLifecycle.defer(() => browserCalls.stop(), { critical: true });
registerWebCallRoutes(app, {
  authenticate: token => auth.authenticate(token),
  available: () => [...verifiedVoice].filter(id => captureVoice(id) !== null),
  calls: browserCalls,
});
app.server.on('upgrade',(request,socket,head)=>{if(stopping.aborted){socket.destroy();return;}const url=request.url??'';const isMedia=url.split('?')[0]==='/ws/media';if(!isMedia && url!=='/ws/device' && url!=='/ws/admin'){socket.destroy();return;}ws.handleUpgrade(request,socket,head,connection=>{if(isMedia){const session=media.open(connection,url,request.headers.authorization);connection.on('message',(data,binary)=>{const bytes=Array.isArray(data)?Buffer.concat(data):data instanceof ArrayBuffer?Buffer.from(data):data;session.message(bytes,binary);});connection.on('close',()=>session.close());connection.on('error',()=>session.close());return;}wireSessionSocket(connection,()=>url==='/ws/admin' ? adminSessions.open(connection,token=>hub.add(connection,token),()=>hub.remove(connection)) : sessions.open(connection),()=>app.log.warn('WebSocket session transport error'));});});
// Stop workers while session messages can still deliver ACKs, then drain sessions.
// Earlier registrations also cover partial startup; request socket close before draining clients.
transportLifecycle.defer(stopSessions,{critical:true});
transportLifecycle.defer(()=>wsCloser.start(),{critical:true});
transportLifecycle.defer(()=>rejectWorker.stop(),{critical:true});
transportLifecycle.defer(()=>dispatcher.stop(),{critical:true});
const presence=new TrackedInterval(10000,[
  ()=>stopping.aborted ? undefined : incomingOutbox.flush(),
  ()=>stopping.aborted ? undefined : rejectWorker.flush(),
  async()=>{if (!stopping.aborted && await smsQueue.expire()) flushSmsTasks();},
  async()=>{if (!stopping.aborted && await smsQueue.settleUnconfirmed()) flushSmsTasks();},
  async()=>{if (!stopping.aborted && await smsQueue.failRetired()) flushSmsTasks();},
  ()=>stopping.aborted ? undefined : activeSmsRateRuntime.refresh(),
  ()=>stopping.aborted ? undefined : maintenanceInvalidation.flush(),
  ()=>stopping.aborted ? undefined : deviceConfigSync.refresh(),
  async () => {
    if (stopping.aborted) return;
    try { await callFailureAlerts.sweep(assertAdmission, publishOperationalAlert); }
    catch (error) { if (!stopping.aborted) throw error; }
  },
  async () => {
    if (stopping.aborted) return;
    const { offlineAfterSec } = await settings.get();
    assertAdmission();
    const offline = await status.markOffline(offlineAfterSec);
    const results = await Promise.allSettled([
      healthAlerts.sweep(offlineAfterSec, assertAdmission, (type, data) => hub.publish(type, data)),
      (async () => { for (const id of offline) { if (stopping.aborted) break; await notifyDevice(id); } })(),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Device health tick failed');
  },
],error=>app.log.error({err:error},'presence interval task failed'));
transportLifecycle.defer(async()=>{
  const results=await Promise.allSettled([Promise.resolve().then(()=>activeSmsRateRuntime.stop()),Promise.resolve().then(()=>rejectWorker.stop()),Promise.resolve().then(()=>dispatcher.stop())]);
  const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'worker shutdown failed');
},{critical:true});
transportLifecycle.defer(()=>presence.stop(),{critical:true});
if (stopping.aborted) return;
assertAdmission();
await app.listen({host:config.server.host,port:config.server.port});
if (!stopping.aborted) void activeSmsRateRuntime.refresh();
}, async () => {
  // A stuck external transport or HTTP handler must not keep the process
  // serving indefinitely after shutdown has been requested.
  watchShutdown();
  try {
    const errors: unknown[] = [];
    try { await closeApp?.(); } catch (error) { errors.push(error); }
    try { await transportLifecycle.close(); } catch (error) { errors.push(error); }
    // If transport/HTTP quiescence is uncertain, keep the lock until the
    // process exits. Do not release it while local work could still run.
    if (errors.length) throw new AggregateError(errors, 'Core transport shutdown failed');
    await lifecycle.close();
  } finally { clearTimeout(shutdownWatchdog); }
});
if (ownershipLost) console.error('Core lost its database ownership session');
if (outcome.startupFailed) console.error('Core startup failed');
if (outcome.cleanupFailed) console.error('Core shutdown could not confirm that all resources drained');
if (ownershipLost || outcome.startupFailed || outcome.cleanupFailed) {
  process.exitCode = 1;
  // A failed drain may retain the database lock and sockets. Terminating the
  // process prevents further local execution and lets PostgreSQL close them.
  if (outcome.cleanupFailed) process.exit(1);
}