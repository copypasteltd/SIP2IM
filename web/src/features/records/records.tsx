import {useState} from 'react';
import {useInfiniteQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {request} from '../../api/client';
import {ErrorMessage} from '../../components/ui/error-message';
import {useConnection} from '../../realtime/use-admin-socket';
type RecordItem={id:string;type?:string;subjectId?:string;severity?:string;state?:string;lastAt?:number;platform?:string;kind?:string;rawText?:string;fromNumber?:string|null;fromSimId?:string|null;toNumber?:string|null;toKind?:string|null;body?:string|null;rejectCode?:string|null;sessionId?:string|null;smsTaskId?:string|null;replies?:{text:string;ts:number}[];createdAt?:number;action?:string;targetId?:string|null;detail?:unknown;ts?:number};
type RecordKind='alerts'|'commands'|'audit';
export function RecordsPage({kind}:{kind:RecordKind}) { return <RecordsContent key={kind} kind={kind}/>; }
function RecordsContent({kind}:{kind:RecordKind}) {
 const {t,i18n}=useTranslation();
 const stale=useConnection(s=>s.state)!=='connected';
 const [filter,setFilter]=useState('');
 const [commandKind,setCommandKind]=useState('');
 const client=useQueryClient();
 const path=kind==='audit'?'/api/audit-logs':'/api/'+kind;
 const query=useInfiniteQuery({queryKey:[kind,filter,commandKind],initialPageParam:undefined as string|undefined,queryFn:({pageParam,signal})=>{
  const params=new URLSearchParams(kind==='alerts'?(filter?{state:filter}:{}):{limit:'50',...(kind==='commands'&&filter?{platform:filter}:{}),...(kind==='commands'&&commandKind?{kind:commandKind}:{}),...(pageParam?{cursor:pageParam}:{})});
  const search=params.toString();return request<RecordItem[]>(path+(search?'?'+search:''),{signal});
 },getNextPageParam:p=>kind==='alerts'?undefined:p.nextCursor??undefined});
 const ack=useMutation({mutationFn:(id:string)=>request('/api/alerts/'+encodeURIComponent(id)+'/ack',{method:'POST'}),onSuccess:()=>{void client.invalidateQueries({queryKey:['alerts']});void client.invalidateQueries({queryKey:['dashboard']});}});
 const rows=query.data?.pages.flatMap(p=>p.data)??[];
 const retry=()=>{if(query.isFetchNextPageError) void query.fetchNextPage();else void query.refetch();};
 return <><h1>{t(kind)}</h1>{stale&&<p role="status">{t('dashboardPage.staleHelp')}</p>}
 {kind!=='audit'&&<label className="field">{t('records.filter')}<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">{t('records.all')}</option>{(kind==='alerts'?['open','acked','resolved']:['qq','telegram']).map(value=><option key={value} value={value}>{kind==='alerts'?t('records.'+value):value.toUpperCase()}</option>)}</select></label>}
 {kind==='commands'&&<label className="field">{t('records.kindFilter')}<select value={commandKind} onChange={e=>setCommandKind(e.target.value)}><option value="">{t('records.all')}</option><option value="call">{t('records.callKind')}</option><option value="sms">{t('records.smsKind')}</option></select></label>}
 {query.isPending?<p role="status">{t('loading')}</p>:<>
 {query.isError&&<div role="alert"><p>{t(query.isFetchNextPageError?'records.nextPageError':'loadError')}</p><button className="secondary" disabled={query.isFetching} onClick={retry}>{t('records.retry')}</button></div>}
 {query.data&&<>{rows.length===0&&<p>{t('empty')}</p>}<div className="device-list">{rows.map(row=><article className="panel" key={row.id}>
 <h2>{row.type??row.action??row.platform??t('unknown')}</h2>
 {kind==='commands'?<><dl>
 <dt>{t('records.kind')}</dt><dd>{row.kind??t('unknown')}</dd>
 <dt>{t('records.state')}</dt><dd>{row.state??t('unknown')}</dd>
 <dt>{t('records.sim')}</dt><dd>{row.fromSimId??t('unknown')}</dd>
 <dt>{t('records.from')}</dt><dd>{row.fromNumber??t('unknown')}</dd>
 <dt>{t('records.to')}</dt><dd>{row.toNumber??t('unknown')}{row.toKind?' ('+row.toKind+')':''}</dd>
 {row.rejectCode!=null&&<><dt>{t('records.rejectReason')}</dt><dd>{row.rejectCode}</dd></>}
 {row.sessionId!=null&&<><dt>{t('records.sessionId')}</dt><dd>{row.sessionId}</dd></>}
 {row.smsTaskId!=null&&<><dt>{t('records.smsTaskId')}</dt><dd>{row.smsTaskId}</dd></>}
 {row.body!=null&&<><dt>{t('records.body')}</dt><dd style={{whiteSpace:'pre-wrap'}}>{row.body}</dd></>}
 </dl>{row.rawText!=null&&<p style={{whiteSpace:'pre-wrap'}}>{row.rawText}</p>}
 <details><summary>{t('records.replies')}</summary>{row.replies===undefined?<p>{t('records.repliesUnavailable')}</p>:row.replies.length===0?<p>{t('records.noReplies')}</p>:row.replies.map((reply,index)=><p key={index}><time dateTime={new Date(reply.ts).toISOString()}>{new Intl.DateTimeFormat(i18n.language,{dateStyle:'short',timeStyle:'medium',hourCycle:'h23'}).format(reply.ts)}</time> · {reply.text}</p>)}</details></>:<><p>{row.subjectId??row.targetId??''} · {row.severity??row.state??''}</p>{row.rawText&&<p>{row.rawText}</p>}</>}
 <p>{row.lastAt||row.createdAt||row.ts?new Intl.DateTimeFormat(i18n.language,{dateStyle:'short',timeStyle:'medium',hourCycle:'h23'}).format(row.lastAt??row.createdAt??row.ts):t('unknown')}</p>
 {row.detail!==undefined&&<details><summary>{t('records.details')}</summary><pre>{JSON.stringify(row.detail,null,2)}</pre></details>}
 {kind==='alerts'&&row.state==='open'&&<button className="secondary" disabled={ack.isPending} onClick={()=>ack.mutate(row.id)}>{t('records.ack')}</button>}</article>)}</div>
 {query.hasNextPage&&!query.isFetchNextPageError&&<button className="secondary" disabled={query.isFetching} onClick={()=>{void query.fetchNextPage();}}>{t('loadMore')}</button>}<ErrorMessage error={ack.error}/></>}
 </>}</>;
}
