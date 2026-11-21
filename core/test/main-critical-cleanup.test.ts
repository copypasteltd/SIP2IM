import {readFile} from 'node:fs/promises';
import {describe,expect,it,vi} from 'vitest';
import ts from 'typescript';
import {Lifecycle} from '../src/lifecycle.js';

// Evaluate the actual defer calls with fake dependencies, never importing main or starting services.
async function wire(fakes: Record<string, unknown>, through?: string): Promise<Lifecycle> {
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const tree=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
  const calls:string[]=[];
  const visit=(node:ts.Node):void=>{
    if (ts.isCallExpression(node) && ['lifecycle.defer', 'transportLifecycle.defer'].includes(node.expression.getText(tree))) {
      calls.push(node.getText(tree).replace(/^transportLifecycle\./, 'lifecycle.')+';');
    }
    ts.forEachChild(node,visit);
  };
  visit(tree);
  const end=through === undefined ? calls.length : calls.findIndex(call=>call.includes(through))+1;
  if(end===0) throw new Error('registration not found');
  const js=ts.transpileModule(calls.slice(0,end).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const lifecycle=new Lifecycle();
  new Function('lifecycle',...Object.keys(fakes),js)(lifecycle,...Object.values(fakes));
  return lifecycle;
}
function fixture() {
  const pool={end:vi.fn()}, ownership={close:vi.fn()};
  const hub={stop:vi.fn()}, settings={drain:vi.fn()}, browserCalls={stop:vi.fn()};
  const dispatcher={stop:vi.fn()}, incomingOutbox={stop:vi.fn()}, maintenanceInvalidation={stop:vi.fn()}, adapterRuntime={close:vi.fn()};
  const rejectWorker={stop:vi.fn()}, stopSessions=vi.fn(), media={close:vi.fn(),drain:vi.fn()};
  const wsCloser={start:vi.fn(),wait:vi.fn()}, presence={stop:vi.fn()}, activeSmsRateRuntime={stop:vi.fn()};
  return {pool,ownership,hub,settings,browserCalls,dispatcher,incomingOutbox,maintenanceInvalidation,adapterRuntime,rejectWorker,stopSessions,media,wsCloser,presence,activeSmsRateRuntime};
}
const deferred=()=>{let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve};};

describe('main lifecycle wiring',()=>{
  it('waits for media authentication drain before ending the pool',async()=>{
    const f=fixture(), gate=deferred(); f.media.drain.mockReturnValue(gate.promise as never);
    const lifecycle=await wire(f); const closing=lifecycle.close();
    await vi.waitFor(()=>expect(f.media.drain).toHaveBeenCalledOnce());
    expect(f.media.close).toHaveBeenCalledOnce(); expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.wsCloser.start).toHaveBeenCalledOnce();
    expect(f.stopSessions).toHaveBeenCalledOnce();
    expect(f.wsCloser.wait).not.toHaveBeenCalled();
    gate.resolve(); await closing; expect(f.pool.end).toHaveBeenCalledOnce();
    expect(f.wsCloser.start.mock.invocationCallOrder[0]!).toBeLessThan(f.stopSessions.mock.invocationCallOrder[0]!);
    expect(f.stopSessions.mock.invocationCallOrder[0]!).toBeLessThan(f.media.close.mock.invocationCallOrder[0]!);
    expect(f.media.drain.mock.invocationCallOrder[0]!).toBeLessThan(f.wsCloser.wait.mock.invocationCallOrder[0]!);
    expect(f.wsCloser.wait.mock.invocationCallOrder[0]!).toBeLessThan(f.pool.end.mock.invocationCallOrder[0]!);
    expect(f.pool.end.mock.invocationCallOrder[0]!).toBeLessThan(f.ownership.close.mock.invocationCallOrder[0]!);
  });
  it('drains media even when close fails and preserves both failures',async()=>{
    const f=fixture(), gate=deferred(), closeError=new Error('close'), drainError=new Error('drain');
    f.media.close.mockImplementation(()=>{throw closeError;});
    f.media.drain.mockImplementation(async()=>{await gate.promise; throw drainError;});
    const lifecycle=await wire(f), closing=lifecycle.close();
    const outcome=expect(closing).rejects.toMatchObject({errors:expect.arrayContaining([expect.objectContaining({errors:[closeError,drainError]})])});
    await vi.waitFor(()=>expect(f.media.drain).toHaveBeenCalledOnce());
    expect(f.pool.end).not.toHaveBeenCalled(); gate.resolve(); await outcome;
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.adapterRuntime.close).toHaveBeenCalled();
  });
  it('guards the pool during partial startup cleanup',async()=>{
    const f=fixture(); f.adapterRuntime.close.mockImplementation(()=>{throw new Error('partial startup cleanup');});
    const lifecycle=await wire(f,'adapterRuntime.close()');
    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.ownership.close).not.toHaveBeenCalled();
    expect(f.incomingOutbox.stop).toHaveBeenCalledOnce();
  });
  it('retains ownership when the business pool fails to close', async () => {
    const f=fixture();
    f.pool.end.mockRejectedValueOnce(new Error('pool close failed'));
    await expect((await wire(f)).close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.ownership.close).not.toHaveBeenCalled();
  });
  it('gates pool closure on media drain failure alone',async()=>{
    const f=fixture(); f.media.drain.mockImplementation(async()=>{throw new Error('drain');});
    await expect((await wire(f)).close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.media.close).toHaveBeenCalledOnce(); expect(f.pool.end).not.toHaveBeenCalled();
  });
  it.each(['presence','workers','sessions','adapter','outbox','maintenance','socket'] as const)('keeps the pool open on %s cleanup failure',async failure=>{
    const f=fixture(), error=new Error(failure);
    switch(failure){
      case 'presence': f.presence.stop.mockImplementation(()=>{throw error;}); break;
      case 'workers': f.rejectWorker.stop.mockImplementationOnce(()=>{throw error;}); break;
      case 'sessions': f.stopSessions.mockImplementationOnce(()=>{throw error;}); break;
      case 'adapter': f.adapterRuntime.close.mockImplementation(()=>{throw error;}); break;
      case 'outbox': f.incomingOutbox.stop.mockImplementation(()=>{throw error;}); break;
      case 'maintenance': f.maintenanceInvalidation.stop.mockImplementation(()=>{throw error;}); break;
      case 'socket': f.wsCloser.wait.mockImplementation(()=>{throw error;}); break;
    }
    const lifecycle=await wire(f);
    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(f.pool.end).not.toHaveBeenCalled(); expect(f.media.drain).toHaveBeenCalledOnce();
  });
});
