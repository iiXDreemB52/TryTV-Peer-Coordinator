'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createIntake}=require('./community-playback-intake.cjs');
const SOURCE='https://ristoanime.me/';
const PRIVATE='iiXDreemB52/TryTV-Public-Catalog';
const PUBLIC='iiXDreemB52/TryTV-Client-Data';
const now=1_793_000_000;
const token='x'.repeat(40),viewerSecret='a'.repeat(40);
const evidenceUrl=`https://api.github.com/repos/${PRIVATE}/contents/trytv/playback/community-evidence-v1.json`;
const publicUrl=`https://api.github.com/repos/${PUBLIC}/contents/trytv/playback/source-provider-reputation.v2.json`;
const manifestUrl=`https://api.github.com/repos/${PRIVATE}/contents/trytv/work-maps/manifest.json`;
function fakeGithub(){
 const files=new Map(),calls=[];
 files.set(manifestUrl,{schema:1,sources:{[SOURCE]:{workCount:444}}});
 const call=async(url,options={})=>{
  calls.push({url,method:options.method||'GET'});
  if(!url.startsWith('https://api.github.com/'))throw Error('unexpected endpoint');
  const current=files.get(url);
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);
   if(current&&body.sha!==`sha-${JSON.stringify(current).length}`)
    return {status:409,ok:false,json:async()=>({})};
   const next=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
   files.set(url,next);
   return {status:200,ok:true,json:async()=>({})};
  }
  if(!current)return {status:404,ok:false};
  const raw=Buffer.from(JSON.stringify(current)).toString('base64');
  return {status:200,ok:true,json:async()=>({sha:`sha-${JSON.stringify(current).length}`,content:raw,encoding:'base64'})};
 };
 return {files,calls,fetchImpl:call};
}
const postBody=(n,change={})=>({sourceUrl:SOURCE,workUrl:`${SOURCE}anime/${n%3}`,
 provider:'Vidspeed (1)',viewer:n.toString(16).padStart(64,'0'),
 attemptId:n.toString(16).padStart(32,'0'),verified:n!==5,...change});
async function withHttp(intake,fn){
 const server=http.createServer((req,res)=>{if(!intake.handle(req,res,'198.51.100.11')){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=`http://127.0.0.1:${server.address().port}`;
 try{return await fn(root)}finally{await new Promise(resolve=>server.close(resolve));await intake.close()}
}
test('disabled intake does not accept reports or touch GitHub',async()=>{
 const gh=fakeGithub();
 const intake=createIntake({enabled:false,token,viewerSecret,fetchImpl:gh.fetchImpl,startTimer:false});
 await withHttp(intake,async(root)=>{
  const status=await (await fetch(`${root}/v1/playback/status`)).json();
  assert.equal(status.configured,false);
  const response=await fetch(`${root}/v1/playback/evidence`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(postBody(1))});
  assert.equal(response.status,503);
 });
 assert.equal(gh.calls.length,0);
});
test('intake validates allowlist, batches private evidence and publishes safe source-level hints',async()=>{
 const gh=fakeGithub();
 const intake=createIntake({enabled:true,token,viewerSecret,fetchImpl:gh.fetchImpl,
  now:()=>now,startTimer:false});
 await withHttp(intake,async(root)=>{
  for(let n=1;n<=5;n++){
   const response=await fetch(`${root}/v1/playback/evidence`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(postBody(n))});
   assert.equal(response.status,202,await response.text());
  }
  const bad=await fetch(`${root}/v1/playback/evidence`,{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify(postBody(6,{sourceUrl:'https://evil.example/'}))});
  assert.equal(bad.status,422);
  const result=await intake.flush();
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(gh.files.get(evidenceUrl).events.length,5);
  const saved=JSON.stringify(gh.files.get(evidenceUrl));
  assert.equal(saved.includes('anime/'),false);
  assert.equal(saved.includes(postBody(1).viewer),false);
  const published=gh.files.get(publicUrl);
  assert.equal(published.schema,2);
  assert.equal(published.communitySignalsOnly,true);
  assert.equal(published.sources[SOURCE].providers.vidspeed.eligible,true);
  assert.equal(published.sources[SOURCE].providers.vidspeed.unverified,true);
  assert.equal(published.sources[SOURCE].providers.vidspeed.worksCount,3);
  assert.equal(published.sources[SOURCE].providers.vidspeed.observations,5);
  assert.equal(JSON.stringify(published).includes('viewer'),true); // Only aggregate viewer COUNT.
  assert.equal(JSON.stringify(published).includes(postBody(1).viewer),false);
  assert.equal(JSON.stringify(published).includes('attemptId'),false);
  assert.equal((await intake.flush()).empty,true);
 });
});
test('under-supported crowd hints never publish a provider recommendation',async()=>{
 const gh=fakeGithub();
 const intake=createIntake({enabled:true,token,viewerSecret,fetchImpl:gh.fetchImpl,
  now:()=>now,startTimer:false});
 await withHttp(intake,async(root)=>{
  for(let n=1;n<=2;n++){
   const res=await fetch(`${root}/v1/playback/evidence`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(postBody(n))});
   assert.equal(res.status,202);
  }
  assert.equal((await intake.flush()).ok,true);
  assert.deepEqual(gh.files.get(publicUrl).sources,{});
 });
});
