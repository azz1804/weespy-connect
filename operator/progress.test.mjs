import test from 'node:test';
import assert from 'node:assert/strict';
import { Operator } from './controller.mjs';
import { Remote } from './remote.mjs';
import { cookieEvidence } from './cookie-evidence.mjs';
import { mergeImport } from './model.mjs';
const secret = 'SYNTHETIC_PRIVATE_VALUE';
const empty = () => ({version:1,proxies:[],accounts:[]});
const data = () => ({proxies:`203.0.113.1:12323:user:${secret} 203.0.113.2:12323:user:${secret}`, accounts:{linkedin:`owner@example.test:${secret}:owner:`}, includePending:false});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(probeProxy) {
  let reserved = 0, connected = 0;
  const remote = {target:{host:'fake'},load:async()=>({inventory:empty(),statuses:[]}),probeProxy,reserve:async()=>{reserved++;}};
  const operator = new Operator({remote:()=>remote,connect:async()=>{connected++;}});
  await operator.load({host:'fake'});
  const input=data(), preview=operator.previewSetup(input);
  return {operator,remote,request:{...input,previewId:preview.previewId},counts:()=>({reserved,connected})};
}
test('draft IP progress follows settled VPS probes, includes unassigned IPs and never reserves secrets', async () => {
  const calls=[]; const f=await fixture((proxy, signal)=>new Promise((resolve,reject)=>calls.push({proxy,signal,resolve,reject})));
  const {operator,request}=f;
  operator.checkSetupIPs(request);
  assert.deepEqual(operator.snapshot().ipChecks.rows.map(r=>r.state),['checking','queued']);
  assert.throws(()=>operator.setupAndConnect(request),/contrôle/);
  assert.deepEqual(operator.inventory,empty()); assert.deepEqual(f.counts(),{reserved:0,connected:0});
  calls[0].resolve(); await tick();
  assert.deepEqual(operator.snapshot().ipChecks.rows.map(r=>r.state),['ok','checking']);
  calls[1].reject(Object.assign(new Error(secret),{category:'ip'})); await operator.ipCheckJob;
  assert.deepEqual(operator.snapshot().ipChecks.rows.map(r=>r.state),['ok','error']);
  assert.throws(()=>operator.setupAndConnect(request),/contrôle/);
  assert.ok(!JSON.stringify(operator.snapshot()).includes(secret));
  f.remote.probeProxy=async()=>{}; operator.checkSetupIPs(request); await operator.ipCheckJob;
  assert.deepEqual(operator.snapshot().ipChecks.rows.map(r=>r.state),['ok','ok']);
  operator.setupAndConnect(request); await operator.job;
  assert.deepEqual(f.counts(),{reserved:1,connected:1});
  await operator.close();
});
test('cancelled and superseded probes cannot overwrite a newer check or leak credentials', async () => {
  const calls=[]; const f=await fixture((proxy,signal)=>new Promise(resolve=>calls.push({signal,resolve})));
  f.operator.checkSetupIPs(f.request); const old=f.operator.ipCheckJob;
  f.operator.checkSetupIPs(f.request); assert.equal(calls[0].signal.aborted,true);
  calls[0].resolve(); await old;
  assert.deepEqual(f.operator.snapshot().ipChecks.rows.map(r=>r.state),['checking','queued']);
  f.operator.cancelIPChecks(); calls[1].resolve(); await f.operator.ipCheckJob;
  assert.equal(f.operator.snapshot().ipChecks,null);
  assert.throws(()=>f.operator.checkSetupIPs({...f.request,proxies:'203.0.113.3:12323:user:changed'}),/configuration/);
  await f.operator.close();
});
test('shared account IP is probed once and only new or selected IPs are checked', async () => {
  const checked=[],f=await fixture(async p=>checked.push(p.ip));
  f.operator.inventory=mergeImport(empty(),{network:'linkedin',accounts:'',proxies:f.request.proxies});
  const input={proxies:'',accounts:{linkedin:'owner@example.test:fake:owner:',instagram:'insta:fake'},includePending:false};
  const preview=f.operator.previewSetup(input);
  f.operator.checkSetupIPs({...input,previewId:preview.previewId}); await f.operator.ipCheckJob;
  assert.deepEqual(checked,['203.0.113.1']); await f.operator.close();
});
test('cookie projection strips raw values, unknown names, duplicate claims and invalid dates', () => {
  const result=cookieEvidence('linkedin',{checkedAt:'2026-10-30T15:00:00Z',value:secret,cookies:[{name:'li_at',state:'present',value:secret},{name:'JSESSIONID',state:'expired',value:secret},{name:secret,state:'present'}]});
  assert.deepEqual(result.cookies,[{name:'li_at',state:'present'},{name:'JSESSIONID',state:'expired'}]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(cookieEvidence('linkedin',{...result,checkedAt:secret}),null);
  assert.equal(cookieEvidence('linkedin',{...result,cookies:[...result.cookies,result.cookies[0]]}).cookies[0].state,'unknown');
});
test('new proxy probes send credentials only on SSH stdin and never accept an empty success', async () => {
  let captured;
  const remote=new Remote({host:'fake'},async(command,args,options)=>{captured={command,args,input:JSON.parse(options.input)};return {stdout:'{"ok":true}'};});
  await remote.probeProxy({ip:'203.0.113.1',port:12323,username:'user',password:secret});
  assert.equal(captured.input.op,'proxy_probe'); assert.equal(captured.input.proxy.password,secret);
  assert.ok(!JSON.stringify(captured.args).includes(secret));
  const broken=new Remote({host:'fake'},async()=>({stdout:'{}'}));
  await assert.rejects(broken.probeProxy(captured.input.proxy),/non vérifiée/);
});

test('HTTP progress is pollable while checking; a stale cancel cannot stop a newer run', async () => {
  const {createServer}=await import('./server.mjs');
  const calls=[]; const f=await fixture((proxy,signal)=>new Promise((resolve,reject)=>{calls.push({resolve});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  const app=await createServer({operator:f.operator});
  const request=async(path,data)=>{
    const response=await fetch(app.origin+'/api/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+app.token,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try {
    const first=await request('setup-check-ips',f.request); assert.equal(first.status,200);
    assert.equal((await request('state')).body.ipChecks.rows[0].state,'checking');
    const second=await request('setup-check-ips',f.request);
    assert.notEqual(first.body.ipChecks.runId,second.body.ipChecks.runId);
    await request('setup-cancel-checks',{runId:first.body.ipChecks.runId});
    assert.equal((await request('state')).body.ipChecks.runId,second.body.ipChecks.runId);
    await request('setup-cancel-checks',{runId:second.body.ipChecks.runId});
    assert.equal((await request('state')).body.ipChecks,null);
  } finally {await app.close();}
});
