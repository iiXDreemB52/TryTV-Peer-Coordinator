'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateCandidate,summarizeCandidates}=require('./community-playback-aggregate.cjs');
const SOURCE='https://ristoanime.me/';
const OTHER='https://olympustaff.com/';
const approved=new Set([SOURCE,OTHER]);
const secret='0123456789abcdef0123456789abcdef';
const now=1_793_000_000;
const id=n=>n.toString(16).padStart(64,'0');
const attempt=n=>n.toString(16).padStart(32,'0');
const candidate=(n,overrides={})=>({sourceUrl:SOURCE,
 workUrl:`${SOURCE}anime/${n}`,provider:'Vidspeed (1)',viewer:id(n),
 attemptId:attempt(n),verified:true,...overrides});
const validate=(n,overrides={})=>validateCandidate(candidate(n,overrides),approved,secret,now);

test('accepts known source and same-origin work; never stores raw URL or viewer',()=>{
 const row=validate(1);
 assert.equal(row.sourceUrl,SOURCE);
 assert.equal(row.provider,'vidspeed');
 assert.equal(row.work.length,64);
 assert.equal(row.viewer.length,64);
 assert.notEqual(row.viewer,id(1));
 assert.equal(JSON.stringify(row).includes('/anime/1'),false);
 assert.equal(JSON.stringify(row).includes('episode'),false);
});
test('rejects unknown, unsafe, malformed and cross-source reports',()=>{
 for(const invalid of [
  {sourceUrl:'https://malicious.example/'},
  {sourceUrl:'http://ristoanime.me/'},
  {workUrl:'https://malicious.example/show'},
  {provider:'unknown'},
  {provider:'player 1'},
  {provider:'Vid|speed'},
  {viewer:'fake'},
  {attemptId:'fake'},
  {verified:'true'},
  {workUrl:'https://user:pass@ristoanime.me/show'},
  {workUrl:'https://ristoanime.me/show#fragment'},
  {workUrl:'https://127.0.0.1/show'},
 ]) assert.equal(validate(2,invalid),null,JSON.stringify(invalid));
 assert.equal(validateCandidate(candidate(3),approved,'short',now),null);
});
test('one work gets equal weight regardless of episode or viewer volume',()=>{
 const records=[];
 for(let j=1;j<=10;j++)records.push(validate(j,{workUrl:`${SOURCE}anime/1`,viewer:id(j)}));
 records.push(validate(11,{workUrl:`${SOURCE}anime/2`,verified:false}));
 records.push(validate(12,{workUrl:`${SOURCE}anime/3`,verified:false}));
 const result=summarizeCandidates(records,now).sources[SOURCE].providers.vidspeed;
 assert.equal(result.worksCount,3);
 assert.equal(result.viewers,12);
 assert.equal(result.observations,12);
 assert.equal(result.successRate,33.33);
 assert.equal(result.eligible,true);
 assert.equal(result.unverified,true);
});
test('same viewer and work cannot flood reputation with repeated episodes',()=>{
 const rows=Array.from({length:100},(_,j)=>validate(j+1,{
  viewer:id(1),workUrl:`${SOURCE}anime/1` }));
 const result=summarizeCandidates(rows,now).sources[SOURCE].providers.vidspeed;
 assert.equal(result.worksCount,1);
 assert.equal(result.viewers,1);
 assert.equal(result.observations,1);
 assert.equal(result.eligible,false);
});
test('latest report from viewer for work and provider wins; repeated attempt ignored',()=>{
 const first=validate(1);
 const corrected={...first,ok:false,at:now+1,attemptId:attempt(222)};
 const sameAttempt={...first,ok:true,at:now+2};
 const result=summarizeCandidates([first,sameAttempt,corrected],now+4)
  .sources[SOURCE].providers.vidspeed;
 assert.equal(result.observations,1);
 assert.equal(result.successRate,0);
});
test('source and provider are isolated; expired records removed',()=>{
 const good=validate(1);
 const differentProvider=validate(2,{provider:'AnaFast'});
 const differentSource=validate(3,{sourceUrl:OTHER,workUrl:`${OTHER}show/3`});
 const old={...validate(4),at:now-31*86400};
 const result=summarizeCandidates([good,differentProvider,differentSource,old],now).sources;
 assert.equal(result[SOURCE].providers.vidspeed.observations,1);
 assert.equal(result[SOURCE].providers.anafast.observations,1);
 assert.equal(result[OTHER].providers.vidspeed.observations,1);
});
