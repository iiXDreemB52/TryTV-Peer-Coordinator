'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {WebSocket}=require('ws'),{broker}=require('./server.cjs');
test('global broker relays only bounded candidate hints, without writing or approving them',async()=>{
 const b=broker();await new Promise(r=>b.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+b.server.address().port;
 const events={schema:1,events:[{source:'ristoanime',sourceUrl:'https://ristoanime.me/',type:'episode',
  episodeUrl:'https://ristoanime.me/series/example/episode-12/',episodeNumber:12,season:1}]};
 const bytes=Buffer.from(JSON.stringify(events));let ws;
 try{
  assert.equal((await fetch(base+'/v2/p2p/candidates.json')).status,404);
  assert.equal((await fetch(base+'/v2/owner/candidates.json')).status,404);
  ws=new WebSocket(base.replace('http','ws')+'/connect?role=peer&id=1234567890abcdef');
  ws.on('message',raw=>{
   const m=JSON.parse(raw.toString());
   if(m.op==='ready')ws.send(JSON.stringify({op:'offer',hashes:[],candidates:true}));
   if(m.op==='get')ws.send(JSON.stringify({op:'asset',qid:m.qid,status:200,body:bytes.toString('base64')}));
  });
  let ready=false;
  for(let i=0;i<50;i++){
   const s=await(await fetch(base+'/status')).json();
   if(s.candidateProviders===1){ready=true;break}
   await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(ready,true,'candidate peer must become visible in active roster');
  const r=await fetch(base+'/v2/p2p/candidates.json');
  assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  assert.equal((await(await fetch(base+'/status')).json()).storedBundles,0);
  assert.equal((await fetch(base+'/v2/owner/candidates.json')).status,404);
 }finally{ws?.close();await b.close()}
});
