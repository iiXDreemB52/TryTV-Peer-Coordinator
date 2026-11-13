'use strict';
// Opt-in, server-side-only community signal intake. No GitHub token or
// signing credential must ever be included in the distributed TryTV client.
// Client-reported video progress is an untrusted HINT, not server proof.
const {validateCandidate,summarizeCandidates}=require('./community-playback-aggregate.cjs');
const DEFAULT_PRIVATE_REPO='iiXDreemB52/TryTV-Public-Catalog';
const DEFAULT_PUBLIC_REPO='iiXDreemB52/TryTV-Client-Data';
const MANIFEST='trytv/work-maps/manifest.json';
const EVIDENCE='trytv/playback/community-evidence-v1.json';
const PUBLIC='trytv/playback/source-provider-reputation.v2.json';
const MAX_POST=2300,MAX_EVENTS=3000,MAX_QUEUE=400,MAX_STORED_BYTES=1500000;
const RETAIN_SECONDS=30*86400;

function createIntake({
 enabled=process.env.TRYTV_PLAYBACK_INGEST_ENABLED==='true',
 token=process.env.TRYTV_PLAYBACK_GITHUB_TOKEN,
 viewerSecret=process.env.TRYTV_PLAYBACK_VIEWER_SECRET,
 privateRepo=DEFAULT_PRIVATE_REPO,
 publicRepo=DEFAULT_PUBLIC_REPO,
 fetchImpl=globalThis.fetch,
 now=()=>Math.floor(Date.now()/1000),
 flushEveryMs=10*60*1000,
 startTimer=true
}={}){
 const configured=enabled&&typeof token==='string'&&token.length>=30&&
  typeof viewerSecret==='string'&&viewerSecret.length>=32&&
  typeof fetchImpl==='function';
 let approved=null,approvedAt=0,refresh=null,flushBusy=null,dirty=false;
 let lastPublished=0,lastError='';
 const queue=[],attempts=new Set(),rates=new Map();
 const auth={'accept':'application/vnd.github+json',
  'authorization':`Bearer ${token||''}`,'user-agent':'trytv-playback-aggregator',
  'x-github-api-version':'2022-11-28'};

 function githubUrl(repo,path){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!/^[-\w./]+$/.test(path))throw Error('unsafe GitHub target');
  return `https://api.github.com/repos/${repo}/contents/${path}`;
 }
 async function getFile(repo,path){
  const response=await fetchImpl(githubUrl(repo,path),{headers:auth,signal:AbortSignal.timeout(14000)});
  if(response.status===404)return {sha:null,data:null};
  if(!response.ok)throw Error(`GitHub read failed ${response.status}`);
  const result=await response.json();
  if(!result||typeof result.sha!=='string'||result.encoding!=='base64'||
    typeof result.content!=='string'||result.content.length>MAX_STORED_BYTES*2)throw Error('invalid GitHub content');
  const decoded=Buffer.from(result.content.replace(/\s+/g,''),'base64');
  if(decoded.length>MAX_STORED_BYTES)throw Error('GitHub content too large');
  return {sha:result.sha,data:JSON.parse(decoded.toString('utf8'))};
 }
 async function putFile(repo,path,data,sha){
  const wire=Buffer.from(JSON.stringify(data));
  if(wire.length>MAX_STORED_BYTES)throw Error('publication exceeds size budget');
  const payload={message:'Update verified-gated TryTV community playback hints',
    content:wire.toString('base64'),branch:'main'};
  if(sha)payload.sha=sha;
  const response=await fetchImpl(githubUrl(repo,path),{
   method:'PUT',headers:{...auth,'content-type':'application/json'},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(14000)});
  if(!response.ok)throw Error(`GitHub write failed ${response.status}`);
 }
 async function sourceAllowlist(){
  if(approved&&now()-approvedAt<900)return approved;
  if(refresh)return refresh;
  refresh=(async()=>{
   const {data}=await getFile(privateRepo,MANIFEST);
   if(!data||typeof data.sources!=='object'||!data.sources||Array.isArray(data.sources))
    throw Error('invalid trusted manifest');
   const sources=new Set(Object.keys(data.sources));
   if(sources.size<1||sources.size>300)throw Error('invalid trusted source count');
   approved=sources;approvedAt=now();return sources;
  })();
  try{return await refresh}finally{refresh=null}
 }
 function send(res,status,body){
  if(res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
   'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
 }
 function rateLimit(ip,viewer){
  const minute=Math.floor(now()/60);
  for(const [id,row] of rates)if(row.minute<minute-1)rates.delete(id);
  if(rates.size>2000&&!rates.has('ip:'+ip))return false;
  for(const [id,max] of [['ip:'+ip,8],['viewer:'+viewer,12]]){
   const entry=rates.get(id);
   if(entry?.minute===minute&&entry.count>=max)return false;
  }
  for(const id of ['ip:'+ip,'viewer:'+viewer]){
   const entry=rates.get(id);
   if(entry?.minute===minute)entry.count++;
   else rates.set(id,{minute,count:1});
  }
  return true;
 }
 async function receive(req,res,ip){
  if(!configured){send(res,503,{ok:false,error:'ingestion-not-configured'});return}
  if(queue.length>=MAX_QUEUE){send(res,429,{ok:false,error:'receiver-busy'});return}
  if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json'){
   send(res,415,{ok:false,error:'json-only'});return
  }
  let bytes=0,chunks=[];
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_POST){
    send(res,413,{ok:false,error:'too-large'});return
   }chunks.push(chunk)}
  }catch{send(res,400,{ok:false,error:'invalid-body'});return}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{send(res,400,{ok:false,error:'invalid-json'});return}
  let allowed;
  try{allowed=await sourceAllowlist()}
  catch{send(res,503,{ok:false,error:'source-list-unavailable'});return}
  const evidence=validateCandidate(body,allowed,viewerSecret,now());
  if(!evidence){send(res,422,{ok:false,error:'invalid-evidence'});return}
  if(!rateLimit(String(ip||'unknown'),evidence.viewer)){
   send(res,429,{ok:false,error:'rate-limited'});return
  }
  if(attempts.has(evidence.attemptId)){
   send(res,202,{ok:true,queued:false,duplicate:true,unverified:true});return
  }
  queue.push(evidence);attempts.add(evidence.attemptId);
  if(attempts.size>MAX_QUEUE*2){attempts.clear();for(const r of queue)attempts.add(r.attemptId)}
  send(res,202,{ok:true,queued:true,persisted:false,unverified:true});
 }
 async function flush(){
  if(!configured)return {ok:false,error:'ingestion-not-configured'};
  if(flushBusy)return flushBusy;
  if(!queue.length&&!dirty)return {ok:true,empty:true};
  flushBusy=(async()=>{
   try{
    if(queue.length){
     const existing=await getFile(privateRepo,EVIDENCE);
     if(existing.data&&(!Array.isArray(existing.data.events)||existing.data.schema!==1))
      throw Error('unexpected evidence schema');
     const batch=queue.slice(0,MAX_QUEUE);
     const all=[...(existing.data?.events||[]),...batch]
      .filter(r=>r&&Number.isSafeInteger(r.at)&&r.at<=now()+60&&now()-r.at<=RETAIN_SECONDS);
     const byAttempt=new Map();
     for(const r of all)byAttempt.set(r.sourceUrl+'|'+r.attemptId,r);
     const events=[...byAttempt.values()].sort((a,b)=>a.at-b.at).slice(-MAX_EVENTS);
     await putFile(privateRepo,EVIDENCE,{schema:1,updatedAt:now(),events},existing.sha);
     queue.splice(0,batch.length);attempts.clear();for(const r of queue)attempts.add(r.attemptId);
     dirty=true;
    }
    const stored=await getFile(privateRepo,EVIDENCE);
    const publicFile=await getFile(publicRepo,PUBLIC);
    const evidence=stored.data?.events||[];
    const summary=summarizeCandidates(evidence,now());
    // Remote user signals are hints. Never expose viewer or work hashes publicly.
    // Clients must NOT bypass direct playback verification based on this file.
    for(const src of Object.values(summary.sources))
     for(const [name,info] of Object.entries(src.providers))
      if(!info.eligible)delete src.providers[name];
    for(const [name,src] of Object.entries(summary.sources))
     if(!Object.keys(src.providers).length)delete summary.sources[name];
    summary.communitySignalsOnly=true;
    await putFile(publicRepo,PUBLIC,summary,publicFile.sha);
    dirty=false;lastPublished=now();lastError='';
    return {ok:true,publishedAt:lastPublished,queued:queue.length};
   }catch(error){lastError=String(error?.message||error).slice(0,110);
    return {ok:false,error:lastError,queued:queue.length,pendingPublish:dirty}}
  })();
  try{return await flushBusy}finally{flushBusy=null}
 }
 function handle(req,res,ip){
  let url;try{url=new URL(req.url,'http://localhost')}
  catch{return false}
  if(!['/v1/playback/evidence','/v1/playback/status'].includes(url.pathname))return false;
  if(url.searchParams.size){send(res,404,{ok:false});return true}
  if(url.pathname==='/v1/playback/status'&&req.method==='GET'){
   send(res,200,{schema:1,configured,queued:queue.length,pendingPublish:dirty,
    lastPublished,lastError:lastError?'publication-or-catalog-error':'',unverifiedOnly:true});return true;
  }
  if(url.pathname==='/v1/playback/evidence'&&req.method==='POST'){
   void receive(req,res,ip).catch(()=>send(res,503,{ok:false,error:'receiver-failure'}));
   return true;
  }
  send(res,405,{ok:false,error:'method-not-allowed'});return true;
 }
 const timer=configured&&startTimer?setInterval(()=>{void flush()},flushEveryMs):null;
 timer?.unref?.();
 return {configured,handle,flush,status:()=>({queued:queue.length,dirty,lastPublished,lastError}),
  close:async()=>{if(timer)clearInterval(timer);if(queue.length||dirty)await flush()}};
}
module.exports={createIntake};
