'use strict';
// Untrusted client reports are CANDIDATES, never proof of video playback.
// The official player still verifies one second of video for every URL.
const crypto=require('node:crypto');
const DAY=86400,WINDOW=30*DAY;
const sha=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const key=x=>String(x||'').normalize('NFKC').trim().toLowerCase()
 .replace(/\s*\(\d+\)$/,'');
function strictHttps(value,maximum){
 if(typeof value!=='string'||value.length>maximum)return null;
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||
    (url.port&&url.port!=='443')||url.href!==value||!url.hostname.includes('.'))return null;
  return url;
 }catch{return null}
}
function validateCandidate(raw,approvedSources,secret,now=Math.floor(Date.now()/1000)){
 if(!raw||typeof raw!=='object'||!secret||secret.length<32)return null;
 const source=strictHttps(raw.sourceUrl,900),work=strictHttps(raw.workUrl,2200);
 if(!source||!work||!approvedSources.has(source.href)||
    source.hostname!==work.hostname)return null;
 const provider=key(raw.provider);
 if(provider.length<2||provider.length>90||
   /^(unknown|other|generic|unresolved|server|player|سيرفر|مشغل)\s*\d*$/i.test(provider)||
   /[\x00-\x1f\x7f|<>]/.test(provider))return null;
 if(typeof raw.verified!=='boolean'||
    !/^[a-f0-9]{64}$/.test(String(raw.viewer||''))||
    !/^[a-f0-9]{32,64}$/.test(String(raw.attemptId||'')))return null;
 return {sourceUrl:source.href,work:sha(source.href+'|'+work.href),provider,
  viewer:crypto.createHmac('sha256',secret).update(raw.viewer).digest('hex'),
  ok:raw.verified,attemptId:raw.attemptId,at:now};
}
function summarizeCandidates(events,now=Math.floor(Date.now()/1000)){
 const recent=new Map(),attempts=new Set();
 for(const row of Array.isArray(events)?events:[]){
  if(!row||!strictHttps(row.sourceUrl,900)||
    !/^[a-f0-9]{64}$/.test(String(row.work||''))||
    !/^[a-f0-9]{64}$/.test(String(row.viewer||''))||
    !/^[a-f0-9]{32,64}$/.test(String(row.attemptId||''))||
    typeof row.ok!=='boolean'||!Number.isSafeInteger(row.at)||
    row.at>now+60||now-row.at>WINDOW)continue;
  const provider=key(row.provider);
  if(provider.length<2||provider.length>90)continue;
  const attempt=row.sourceUrl+'|'+row.attemptId;
  if(attempts.has(attempt))continue;
  attempts.add(attempt);
  // One viewer contributes at most one current vote per work/provider.
  const unique=[row.sourceUrl,provider,row.work,row.viewer].join('|');
  const prior=recent.get(unique);
  if(!prior||row.at>=prior.at)recent.set(unique,{...row,provider});
 }
 const grouped=new Map();
 for(const row of recent.values()){
  const id=row.sourceUrl+'|'+row.provider;
  let byWork=grouped.get(id);
  if(!byWork){byWork={sourceUrl:row.sourceUrl,provider:row.provider,works:new Map(),viewers:new Set()};grouped.set(id,byWork)}
  let bucket=byWork.works.get(row.work);
  if(!bucket){bucket={yes:0,no:0};byWork.works.set(row.work,bucket)}
  bucket[row.ok?'yes':'no']++;
  byWork.viewers.add(row.viewer);
 }
 const sources={};
 for(const group of grouped.values()){
  let successes=0,failures=0,observations=0;
  for(const work of group.works.values()){
   const total=work.yes+work.no;
   successes+=work.yes/total;
   failures+=work.no/total;
   observations+=total;
  }
  const worksCount=group.works.size,viewers=group.viewers.size;
  // Distinct works have equal weight, even if one work has 100 episodes.
  const successRate=worksCount?successes/worksCount:0;
  const confidence=worksCount/(worksCount+5);
  const eligible=worksCount>=3&&viewers>=3&&observations>=5;
  (sources[group.sourceUrl]??={providers:{}}).providers[group.provider]={
   worksCount,viewers,observations,
   successRate:Math.round(successRate*10000)/100,
   confidence:Math.round(confidence*10000)/100,
   eligible,unverified:true
  };
 }
 return {schema:2,updatedAt:now,sources};
}
module.exports={validateCandidate,summarizeCandidates};
