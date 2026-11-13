'use strict';
// TryTV source relay coordinator. Public signed SourceSync V2 BYTES ONLY.
// No catalog database, Cloudflare, R2, Vercel, or disk storage.
// WebSocket is a transient data path; GitHub remains fail-safe.
const http=require('node:http'),crypto=require('node:crypto');
const {WebSocket,WebSocketServer}=require('ws');
const {createIntake}=require('./community-playback-intake.cjs');
const PUBLIC_KEY=crypto.createPublicKey({key:Buffer.from('MCowBQYDK2VwAyEABh5+fCf15Kjd8/WF6zkkDS10V0vpATtIuTFLDW7zFac=','base64'),format:'der',type:'spki'});
const HINT_LIMIT=128*1024;
const MAX=12*1024*1024,MAX64=17*1024*1024,MAX_PEERS=200,ID=/^[a-f0-9]{16}$/,QID=/^[a-f0-9-]{36}$/;
const allowed=s=>s==='candidates.json'||s==='directory.json'||/^packs\/[a-f0-9]{64}\/(?:manifest\.json|snapshot-[1-9]\d*\.json\.gz)$/.test(s);
// Render is the sole trusted HTTPS reverse proxy. Prefer its last forwarded
// client address for fair per-client quotas under shared NAT connections.
function clientIp(req){
 const forwarded=String(req.headers['x-forwarded-for']||'').split(',').pop().trim();
 return /^[0-9a-fA-F:.]{3,64}$/.test(forwarded)?forwarded:
  String(req.socket.remoteAddress||'unknown');
}
function send(res,status,body,headers={}){
 if(res.writableEnded)return;res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(body);
}
function broker(){
 const clients=new Map(),pending=new Map(),rates=new Map();
 const communityPlayback=createIntake();
 let seq=0,totalBytes=0;
 const participants=(role)=>[...clients.values()].filter(p=>p.authenticated&&p.role===role&&p.ws.readyState===WebSocket.OPEN);
 function finish(qid,status,payload){
  const task=pending.get(qid);if(!task)return;
  pending.delete(qid);clearTimeout(task.timer);task.client.inflight=Math.max(0,task.client.inflight-1);
  if(task.res.writableEnded)return;
  if(status!==200||!payload){send(task.res,status||404,'Peer unavailable');return}
  send(task.res,200,payload,{'content-type':'application/octet-stream','content-length':String(payload.length)});
 }
 const wss=new WebSocketServer({noServer:true,maxPayload:MAX64+500,perMessageDeflate:false});
 wss.on('connection',(ws,req,meta)=>{
  const c={ws,role:meta.role,id:meta.id,ip:meta.ip,authenticated:meta.role==='peer',offers:new Set(),offersCandidates:false,inflight:0,quotaAt:Date.now(),bytes:0,nonce:'',guard:null};
  clients.set(ws,c);
  if(c.role==='owner'){
   c.nonce=crypto.randomUUID()+'-'+crypto.randomUUID();
   c.guard=setTimeout(()=>{if(!c.authenticated)ws.close(1008,'Owner authorization expired')},7000);
   ws.send(JSON.stringify({op:'challenge',nonce:c.nonce}));
  }else ws.send(JSON.stringify({op:'ready',role:'peer'}));
  ws.on('message',(wire,isBinary)=>{
   if(isBinary)return;
   let msg;try{msg=JSON.parse(wire.toString('utf8'))}catch{return}
   if(!c.authenticated){
    if(msg?.op!=='auth'||typeof msg.signature!=='string'||msg.signature.length>130){ws.close(1008,'Authentication required');return}
    try{
     const sig=Buffer.from(msg.signature,'base64');
     if(sig.length!==64||!crypto.verify(null,Buffer.from('trytv-owner-relay-v1\n'+c.nonce),PUBLIC_KEY,sig))throw Error('bad signature');
     c.authenticated=true;clearTimeout(c.guard);ws.send(JSON.stringify({op:'ready',role:'owner'}));
    }catch{ws.close(1008,'Invalid owner signature')}return;
   }
   if(c.role==='peer'&&msg?.op==='offer'){
    if(!Array.isArray(msg.hashes)||msg.hashes.length>80)return;
    c.offers=new Set(msg.hashes.filter(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)));
    c.offersCandidates=msg.candidates===true;
    return;
   }
   if(msg?.op!=='asset'||!QID.test(String(msg.qid||'')))return;
   const task=pending.get(msg.qid);if(!task||task.client!==c)return;
   if(task.suffix==='candidates.json'&&typeof msg.body==='string'&&msg.body.length>HINT_LIMIT*2){finish(msg.qid,413,null);return}
   if(msg.status!==200){finish(msg.qid,404,null);return}
   if(typeof msg.body!=='string'||msg.body.length>MAX64||!/^[a-zA-Z0-9+/]*={0,2}$/.test(msg.body)){finish(msg.qid,422,null);return}
   try{
    const bytes=Buffer.from(msg.body,'base64');
    const now=Date.now();if(now-c.quotaAt>60000){c.quotaAt=now;c.bytes=0}
    if(bytes.length<1||bytes.length>MAX||task.suffix==='candidates.json'&&bytes.length>HINT_LIMIT||c.bytes+bytes.length>32*1024*1024){finish(msg.qid,429,null);return}
    c.bytes+=bytes.length;totalBytes+=bytes.length;finish(msg.qid,200,bytes);
   }catch{finish(msg.qid,422,null)}
  });
  const closed=()=>{clients.delete(ws);clearTimeout(c.guard);
   for(const [id,task] of pending)if(task.client===c)finish(id,503,null);
  };
  ws.on('close',closed);ws.on('error',()=>{});
 });
 const server=http.createServer((req,res)=>{
  if(communityPlayback.handle(req,res,clientIp(req)))return;
  let u;try{u=new URL(req.url,'http://localhost')}catch{send(res,400,'Invalid path');return}
  if(req.method!=='GET'||u.searchParams.size>0){send(res,404,'Not found');return}
  if(u.pathname==='/healthz'){send(res,200,JSON.stringify({ok:true,service:'trytv-peer-coordinator',storedBundles:0}),{'content-type':'application/json'});return}
  if(u.pathname==='/status'){send(res,200,JSON.stringify({schema:1,peerCount:participants('peer').length,ownerOnline:participants('owner').length>0,candidateProviders:participants('peer').filter(p=>p.offersCandidates).length,activeTransfers:pending.size,storedBundles:0}),{'content-type':'application/json','access-control-allow-origin':'*'});return}
  if(u.pathname==='/participants'){send(res,200,JSON.stringify({schema:1,ids:participants('peer').map(c=>c.id).slice(0,MAX_PEERS),ttlSeconds:60}),{'content-type':'application/json'});return}
  const m=/^\/v2\/(p2p|owner)\/(.+)$/.exec(u.pathname);
  if(!m||!allowed(m[2])||m[1]==='owner'&&m[2]==='candidates.json'){send(res,404,'Not found');return}
  const ip=clientIp(req),now=Date.now();
  const b=rates.get(ip);if(b&&now-b.time<60000){if(b.count>=35){send(res,429,'Rate limit');return}b.count++}
  else rates.set(ip,{time:now,count:1});
  if(rates.size>1000)for(const [k,v] of rates)if(now-v.time>60000)rates.delete(k);
  if(pending.size>=45){send(res,429,'Busy');return}
  const hash=/^packs\/([a-f0-9]{64})\//.exec(m[2])?.[1];
  const list=participants(m[1]==='owner'?'owner':'peer').filter(c=>c.inflight<3&&(!hash||c.role==='owner'||c.offers.has(hash))&&(m[2]!=='candidates.json'||c.role==='peer'&&c.offersCandidates));
  if(!list.length){send(res,404,'No provider');return}
  const c=list[(seq++)%list.length],qid=crypto.randomUUID();
  const timer=setTimeout(()=>finish(qid,504,null),4700);
  c.inflight++;pending.set(qid,{res,client:c,timer,suffix:m[2]});
  res.on('close',()=>{if(!res.writableEnded)finish(qid,499,null)});
  try{c.ws.send(JSON.stringify({op:'get',qid,suffix:m[2]}))}catch{finish(qid,503,null)}
 });
 server.on('upgrade',(req,socket,head)=>{
  let u;try{u=new URL(req.url,'http://localhost')}catch{socket.destroy();return}
  if(u.pathname!=='/connect'||u.searchParams.size!==2){socket.destroy();return}
  const role=u.searchParams.get('role'),id=u.searchParams.get('id');
  if(!['peer','owner'].includes(role)||!ID.test(id||'')){socket.destroy();return}
  const ip=clientIp(req);
  if(clients.size>=MAX_PEERS+3||role==='peer'&&participants('peer').filter(c=>c.ip===ip).length>=30||role==='owner'&&participants('owner').length>=2){socket.destroy();return}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req,{role,id,ip}));
 });
 return {server,wss,
  status:()=>({peers:participants('peer').length,owner:participants('owner').length,bytes:totalBytes}),
  communityPlayback,
  close:async()=>{
   await communityPlayback.close();
   for(const x of clients.keys())x.terminate();
   await new Promise(resolve=>server.close(resolve));
  }};
}
if(require.main===module){
 const b=broker(),port=Number(process.env.PORT||3000);
 b.server.listen(port,'0.0.0.0',()=>console.log('trytv signed source relay listening',port));
 process.on('SIGTERM',()=>{void b.close().then(()=>process.exit(0))});
}
module.exports={broker,allowed};
