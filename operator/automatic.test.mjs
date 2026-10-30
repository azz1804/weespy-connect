import test from 'node:test';
import assert from 'node:assert/strict';
import {Operator} from './controller.mjs';
import {mergeImport} from './model.mjs';
const inventory=()=>mergeImport({version:1,proxies:[],accounts:[]},{network:'instagram',proxies:'203.0.113.1:12323:test:test',accounts:'old_instagram:synthetic'});
async function fixture(probe=async()=>{},existing={accounts:[],warnings:[]}){
 const connected=[],reserved=[];
 const remote={target:{host:'fake'},load:async()=>({inventory:inventory(),statuses:[],existing}),probeProxy:probe,reserve:async inv=>reserved.push(inv)};
 const operator=new Operator({remote:()=>remote,connect:async({row,report})=>{connected.push(row.network);report('saved','Session enregistrée');}});
 await operator.load(remote.target);
 const data={proxies:'',accounts:{x:'new_x:synthetic'},includePending:true};
 return {operator,data,connected,reserved};
}
test('automatic setup checks IPs then connects only the requested network, without a second click',async()=>{
 let release; const f=await fixture(()=>new Promise(r=>release=r));
 const preview=f.operator.previewSetup(f.data);
 assert.deepEqual(preview.accounts.map(a=>a.network),['x']);
 f.operator.autoConnectSetup({...f.data,previewId:preview.previewId});
 assert.equal(f.operator.busy,true);assert.deepEqual(f.connected,[]);
 await assert.rejects(f.operator.load({host:'different'}));
 release();await f.operator.setupJob;
 assert.deepEqual(f.connected,['x']);assert.equal(f.reserved.length,1);
 assert.equal(f.operator.setupRun.state,'finished');assert.equal(f.operator.busy,false);
 await f.operator.close();
});
test('failed and cancelled IP checks never launch an account',async()=>{
 const f=await fixture(async()=>{throw Error('synthetic failure');});
 const preview=f.operator.previewSetup(f.data);
 f.operator.autoConnectSetup({...f.data,previewId:preview.previewId});await f.operator.setupJob;
 assert.equal(f.operator.setupRun.state,'error');assert.deepEqual(f.connected,[]);assert.deepEqual(f.reserved,[]);
 await f.operator.close();
 let release;const g=await fixture(()=>new Promise(r=>release=r));
 const p=g.operator.previewSetup(g.data);g.operator.autoConnectSetup({...g.data,previewId:p.previewId});
 g.operator.action('stop');release();await g.operator.setupJob;
 assert.equal(g.operator.setupRun.state,'stopped');assert.deepEqual(g.connected,[]);await g.operator.close();
});
test('unknown X identities fail explicitly before IP validation instead of selecting pending Instagram',async()=>{
 const f=await fixture(async()=>{throw Error('must not check');},{warnings:[],accounts:[{source:'x-worker',id:'opaque',network:'x',label:'opaque',identityKnown:false,state:'present',sessionPresent:true,enabled:true,ip:null,alias:null,updatedAt:null,lastCheckAt:null}]});
 assert.throws(()=>f.operator.previewSetup(f.data),/X bloqué/);
 assert.equal(f.operator.ipChecks,null);assert.deepEqual(f.connected,[]);await f.operator.close();
});


test('an old tab closing cannot cancel an automatic run through the draft-cancellation endpoint',async()=>{
 const {createServer}=await import('./server.mjs');
 let release;const f=await fixture(()=>new Promise(r=>release=r));
 const app=await createServer({operator:f.operator});
 try{
  const preview=f.operator.previewSetup(f.data);f.operator.autoConnectSetup({...f.data,previewId:preview.previewId});
  const runId=f.operator.ipChecks.runId;
  const response=await fetch(app.origin+'/api/setup-cancel-checks',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({runId})});
  assert.equal(response.status,200);assert.equal(f.operator.ipChecks.runId,runId);
  release();await f.operator.setupJob;assert.deepEqual(f.connected,['x']);
 }finally{await app.close();}
});
