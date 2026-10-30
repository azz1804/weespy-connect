import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAccount } from './browser.mjs';
import { Remote } from './remote.mjs';
import { Operator } from './controller.mjs';
import { mergeImport, rowsOf } from './model.mjs';
const inventory=()=>mergeImport({version:1,proxies:[],accounts:[]},{network:'linkedin',proxies:'203.0.113.1:12323:synthetic:synthetic',accounts:'owner@example.test:synthetic:owner:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'});
const row=()=>rowsOf(inventory())[0];
const jar=()=>['li_at','JSESSIONID'].map(name=>({name,value:'SYNTHETIC_'+name,domain:'.linkedin.com',session:true}));
async function scenario(frames,{waitForUser=async()=> 'skip',receipt={stored:true,scope:'vps_identity',checkedAt:'2026-10-30T14:00:00Z'},deadline=600000}={}) {
  let tick=0,index=0,frame;const events=[],reports=[];
  const session={snapshot:async()=>{frame=frames[Math.min(index++,frames.length-1)];return frame.state;},cookies:async()=>frame.cookies??jar(),submit:async action=>{events.push(['submit',action.stage]);return {stage:'submitted'};},restartLogin:async()=>events.push(['restart']),close:async()=>events.push(['close'])};
  try { const result=await connectAccount({target:{host:'fake'},row:row(),signal:new AbortController().signal,report:(...x)=>reports.push(x),waitForUser,save:async payload=>{events.push(['save',payload.cookies]);return receipt;},open:async()=>session,sleep:async ms=>{tick+=ms;},now:()=>tick,timeoutMs:deadline}); return {result,events,reports}; }
  catch(error){return {error,events,reports};}
}
const outside={stage:'outside',identityVerified:true};
test('cookies disappearing after six seconds never reach VPS save',async()=>{
  const frames=Array.from({length:6},()=>({state:outside}));frames.push({state:outside,cookies:[]});
  const r=await scenario(frames);assert.match(r.error.message,/disparu/);assert.equal(r.error.category,'session');assert.deepEqual(r.events,[['close']]);
});
test('stable capture closes before remote validation, uses latest cookies and waits ten seconds',async()=>{
  const frames=Array.from({length:11},(_,i)=>({state:outside,cookies:jar().map(c=>({...c,value:c.value+'_'+i}))}));
  const r=await scenario(frames);assert.equal(r.result,'saved');assert.equal(r.events[0][0],'close');assert.equal(r.events[1][0],'save');assert.ok(r.events[1][1].every(c=>c.value.endsWith('_10')));assert.equal(r.events.filter(e=>e[0]==='close').length,1);
});
test('one same-profile continuation after 2FA, never an endless password loop',async()=>{
  const r=await scenario([{state:{stage:'credentials'},cookies:[]},{state:{stage:'totp'},cookies:[]},{state:{stage:'password'},cookies:[]},{state:outside}]);
  assert.equal(r.result,'saved');assert.deepEqual(r.events.filter(e=>e[0]==='submit').map(e=>e[1]),['credentials','totp','password']);
  const stuck=await scenario([{state:{stage:'credentials'},cookies:[]},{state:{stage:'totp'},cookies:[]},{state:{stage:'password'},cookies:[]}]);
  assert.equal(stuck.result,'skipped');assert.equal(stuck.events.filter(e=>e[0]==='submit'&&e[1]==='password').length,1);
});
test('partial feed after 2FA gets at most one login navigation',async()=>{
  const r=await scenario([{state:{stage:'totp'},cookies:[]},...Array.from({length:12},()=>({state:outside,cookies:[]})),{state:{stage:'password'},cookies:[]},{state:outside}]);
  assert.equal(r.events.filter(e=>e[0]==='restart').length,1);assert.equal(r.result,'saved');
});
test('explicit refusal disables automatic submission even after Resume',async()=>{
  let prompts=0;const r=await scenario([{state:{stage:'credentials'},cookies:[]},{state:{stage:'human',reason:'rejected'},cookies:[]},{state:{stage:'credentials'},cookies:[]}],{waitForUser:async()=>++prompts===1?'resume':'skip'});
  assert.equal(r.result,'skipped');assert.equal(r.events.filter(e=>e[0]==='submit').length,1);
});
test('known wrong identity is never overrideable by confirmation',async()=>{
  const r=await scenario([{state:{...outside,identityVerified:false,identityMismatch:true}}],{waitForUser:async()=>{throw Error('must not prompt');}});
  assert.equal(r.error.category,'identity');assert.deepEqual(r.events,[['close']]);
});
test('missing JSESSIONID and missing remote receipt cannot produce success',async()=>{
  const missing=await scenario([{state:outside,cookies:[jar()[0]]}]);assert.equal(missing.result,'skipped');assert.equal(missing.events.filter(e=>e[0]==='save').length,0);
  const noReceipt=await scenario([{state:outside}],{receipt:null});assert.equal(noReceipt.error.category,'vps');assert.ok(!noReceipt.reports.some(r=>r[0]==='saved'));
});
test('a stalled or repeatedly changing flow has a bounded deadline',async()=>{
  const r=await scenario([{state:{stage:'unknown'},cookies:[]}],{waitForUser:async()=> 'resume',deadline:20000});assert.match(r.error.message,/Délai/);assert.deepEqual(r.events,[['close']]);
});
test('remote rejects mismatched acknowledgement and preserves typed nonfatal verification errors',async()=>{
  const remote=new Remote({host:'fake'},async()=>({stdout:JSON.stringify({stored:true,network:'linkedin',index:99})}));
  await assert.rejects(remote.save({network:'linkedin',index:1}),e=>e.fatal&&e.category==='vps');
  remote.run=async()=>({stdout:JSON.stringify({failure:'session_rejected',message:'SYNTHETIC_SECRET'})});
  await assert.rejects(remote.save({}),e=>e.category==='session'&&!e.fatal&&!e.message.includes('SYNTHETIC_SECRET'));
});
test('monitor cannot turn a failed reconnection into success using old stored cookies',async()=>{
  const inv=inventory(),r=rowsOf(inv)[0],captured='2026-10-30T12:00:00Z';
  const status={network:r.network,index:r.index,label:r.label,isp_ip:r.isp_ip,isp_alias:r.isp_alias,captured_at:captured,cookie_state:'valid'};
  const remote={target:{host:'fake'},load:async()=>({inventory:inv,statuses:[status]}),status:async()=>[status]};
  const operator=new Operator({remote:()=>remote});await operator.load(remote.target);operator.setStatus(r.key,{state:'error',category:'session',message:'Nouvel essai refusé'});await operator.refreshHealth();
  assert.equal(operator.snapshot().accounts[0].state,'error');await operator.close();
});
