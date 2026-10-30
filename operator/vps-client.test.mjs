import test from 'node:test';
import assert from 'node:assert/strict';
import { connectOnVps } from './vps-client.mjs';
import { connectAccount } from './browser.mjs';
import { Operator } from './controller.mjs';
import { Remote } from './remote.mjs';
const id='a'.repeat(32),signal=()=>new AbortController().signal;
const initial={jobId:id,state:'connecting',message:'Firefox sur le VPS',terminal:false};
const done={jobId:id,state:'saved',message:'Sauvegardé',terminal:true,capturedAt:'2026-10-30T12:00:00Z',verificationScope:'vps_identity',verifiedAt:'2026-10-30T12:00:10Z'};
const row={network:'linkedin',index:1,record:{password:'SYNTHETIC_PRIVATE'}};

test('default engine starts a VPS job, receives metadata only and never opens a local browser',async()=>{
  const calls=[],reports=[];
  const remote={startJob:async()=>{calls.push('start');return initial;},jobStatus:async()=>{calls.push('status');return done;},jobAction:async()=>{throw Error('not needed');}};
  assert.equal(new Operator().connect,connectOnVps);
  const result=await connectOnVps({remote,row,signal:signal(),report:(...x)=>reports.push(x),sleep:async()=>{},view:async()=>{throw Error('no UI needed');}});
  assert.equal(result,'saved');assert.deepEqual(calls,['start','status']);assert.ok(!JSON.stringify(reports).includes('SYNTHETIC_PRIVATE'));
});
test('VPS human intervention opens only an SSH screen, binds Resume to its prompt, and closes the tunnel',async()=>{
  let closed=0;const actions=[],reports=[];
  const remote={startJob:async()=>({...initial,state:'human',actions:['resume','skip'],promptId:7}),jobAction:async(...args)=>{actions.push(args);return done;}};
  await connectOnVps({remote,row,target:{host:'test'},signal:signal(),report:(...x)=>reports.push(x),view:async()=>({url:'http://127.0.0.1:1234/vnc.html?autoconnect=true&resize=scale',close:()=>closed++}),waitForUser:async a=>{assert.deepEqual(a,['resume','skip']);return 'resume';}});
  assert.equal(closed,1);assert.equal(actions[0][0],id);assert.equal(actions[0][2],7);assert.ok(reports.some(r=>r[2].browserUrl));
});
test('stop cancels the remote job even when polling aborts',async()=>{
  const c=new AbortController(),actions=[];
  const remote={startJob:async()=>initial,jobAction:async(...a)=>{actions.push(a);return {};}};
  await assert.rejects(connectOnVps({remote,row,signal:c.signal,report(){},sleep:async()=>{c.abort();c.signal.throwIfAborted();}}));
  assert.equal(actions[0][0],id);assert.equal(actions[0][1],'stop');
});
test('missing remote engine fails explicitly; no local fallback and queue-stopping category',async()=>{
  const remote=new Remote({host:'test'},async()=>({stdout:'{"failure":"engine_unavailable"}'}));
  await assert.rejects(connectOnVps({remote,row,signal:signal(),report(){},view:async()=>{throw Error('must not open');}}),e=>e.fatal&&e.category==='vps');
});
test('SSH request for starting a job contains the assignment, never credentials or cookies',async()=>{
  let input;const remote=new Remote({host:'test'},async(_c,_a,o)=>{input=o.input;return {stdout:JSON.stringify(initial)};});
  await remote.startJob(row,signal());assert.ok(!input.includes('SYNTHETIC'));assert.deepEqual(JSON.parse(input),{op:'job_start',engine:'vps-firefox-1',revision:null,network:'linkedin',index:1});
});

test('connection state machine has no implicit local browser fallback',async()=>{
  await assert.rejects(connectAccount({row,signal:signal(),report(){}}),/connexions locales sont désactivées/);
});

test('remote success without dated identity proof is rejected',async()=>{
  const remote={startJob:async()=>({...done,verificationScope:null}),jobAction:async()=>({})};
  await assert.rejects(connectOnVps({remote,row,signal:signal(),report(){}}),e=>e.fatal&&e.category==='vps');
});

test('a stale acknowledgement after Resume does not pause the same step twice',async()=>{
  let prompts=0;const human={...initial,state:'human',actions:['resume','skip'],promptId:3};
  const remote={startJob:async()=>human,jobAction:async()=>human,jobStatus:async()=>done};
  await connectOnVps({remote,row,signal:signal(),report(){},view:async()=>({url:'http://127.0.0.1:1234/vnc.html?autoconnect=true&resize=scale',close(){}}),waitForUser:async()=>{if(++prompts>1)throw Error('duplicate prompt');return 'resume';},sleep:async()=>{}});
  assert.equal(prompts,1);
});

test('VPS storage failure stops the queue instead of trying another account',async()=>{
  const remote={startJob:async()=>({...initial,state:'error',terminal:true,category:'vps',message:'Sauvegarde impossible'})};
  await assert.rejects(connectOnVps({remote,row,signal:signal(),report(){}}),e=>e.fatal&&e.category==='vps');
});


test('remote screen failures stop the queue and stop the unfinished VPS job',async()=>{
 const actions=[];
 const remote={startJob:async()=>({...initial,state:'human',actions:['resume'],promptId:1}),jobAction:async(...args)=>{actions.push(args);return {};}};
 await assert.rejects(connectOnVps({remote,row,signal:signal(),report(){},view:async()=>{throw Error('SSH screen unavailable');}}),e=>e.fatal&&e.category==='vps');
 assert.equal(actions[0][1],'stop');
});
