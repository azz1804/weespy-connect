import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeImport, rowsOf } from './model.mjs';
import { Operator } from './controller.mjs';
const empty = () => ({version:1,proxies:[],accounts:[]});
const proxy = n => `203.0.113.${n}:12323:synthetic:synthetic`;
const stock = n => mergeImport(empty(), {network:'x',proxies:Array.from({length:n},(_,i)=>proxy(i+1)).join('\n'),accounts:''});
async function fixture(inventory, accounts=[]) {
  const connected = [], checks = [];
  const remote = {target:{host:'test'},load:async()=>({inventory,statuses:[],existing:{accounts,warnings:[]}}),reserve:async()=>{},probeProxy:async p=>checks.push(p.ip)};
  const operator = new Operator({remote:()=>remote,connect:async({row})=>connected.push(row)});
  await operator.load(remote.target);
  return {operator,connected,checks};
}
const external = {source:'x-worker',id:'x-service',network:'x',label:'managed',identityKnown:true,state:'present',sessionPresent:true,enabled:true,ip:'203.0.113.1',alias:'p1',updatedAt:null,lastCheckAt:null};

test('25 existing IPs serve 25 X and 25 Instagram accounts even when LinkedIn occupies every IP', async () => {
  const inv = mergeImport(stock(25),{network:'linkedin',accounts:Array.from({length:25},(_,i)=>`owner${i}@example.test:synthetic:owner${i}:`).join('\n')});
  const {operator} = await fixture(inv);
  try {
    const data = {proxies:proxy(26),accounts:{x:Array.from({length:25},(_,i)=>`x${i}:synthetic`).join('\n'),instagram:Array.from({length:25},(_,i)=>`ig${i}:synthetic`).join('\n')},includePending:false};
    const preview = operator.previewSetup(data);
    assert.equal(preview.newIPs,0); assert.equal(preview.unusedIPs,1); assert.equal(preview.reusedIPs,25);
    assert.equal(preview.accounts.length,50); assert.equal(preview.totalIPs,25);
    for (const network of ['x','instagram']) assert.deepEqual(preview.accounts.filter(a=>a.network===network).map(a=>a.ip), inv.proxies.map(p=>p.ip));
    assert.deepEqual(operator.inventory,inv);
  } finally { await operator.close(); }
});
test('account import adds only the deficit, preserves assignments, and remains idempotent', () => {
  const inv = mergeImport(stock(2),{network:'x',accounts:'first:synthetic'});
  const data = {network:'x',proxies:[3,4,5].map(proxy).join('\n'),accounts:'second:synthetic third:synthetic'};
  const next = mergeImport(inv,data);
  assert.deepEqual(rowsOf(next).map(r=>r.isp_ip),['203.0.113.1','203.0.113.2','203.0.113.3']);
  assert.equal(next.proxies.length,3); assert.deepEqual(mergeImport(next,data),next);
  assert.deepEqual(inv.accounts.map(a=>a.index),[1]);
  assert.throws(()=>mergeImport(inv,{network:'x',accounts:'second:synthetic third:synthetic'}),/IP libres/);
  assert.equal(inv.proxies.length,2);
});
test('VPS reservations count per network and known external accounts do not consume another IP', async () => {
  const {operator,connected,checks} = await fixture(stock(2),[external]);
  try {
    assert.deepEqual(operator.snapshot().proxies.map(p=>p.availableNetworks.includes('x')),[false,true]);
    assert.ok(operator.snapshot().proxies.every(p=>p.availableNetworks.includes('instagram')));
    const data = {proxies:proxy(3),accounts:{x:'managed:synthetic new:synthetic',instagram:'new-ig:synthetic'},includePending:false};
    const preview = operator.previewSetup(data);
    assert.equal(preview.newIPs,0); assert.equal(preview.skipped,1);
    assert.deepEqual(preview.accounts.map(r=>[r.network,r.ip]),[['x','203.0.113.2'],['instagram','203.0.113.1']]);
    operator.checkSetupIPs({...data,previewId:preview.previewId}); await operator.ipCheckJob;
    assert.deepEqual(checks,['203.0.113.1','203.0.113.2']);
    operator.setupAndConnect({...data,previewId:preview.previewId}); await operator.job;
    assert.equal(connected.length,2); assert.equal(operator.inventory.proxies.length,2);
  } finally { await operator.close(); }
});
test('a fully occupied network adds one IP without forcing another network onto it', async () => {
  const inv = mergeImport(stock(1),{network:'x',accounts:'first:synthetic'});
  const {operator} = await fixture(inv);
  try {
    const preview = operator.previewSetup({proxies:[2,3].map(proxy).join('\n'),accounts:{x:'second:synthetic',instagram:'insta:synthetic'},includePending:false});
    assert.equal(preview.newIPs,1); assert.equal(preview.unusedIPs,1);
    assert.deepEqual(preview.accounts.map(r=>r.ip),['203.0.113.2','203.0.113.1']);
  } finally { await operator.close(); }
});
test('direct assistant import also reuses available stock and skips managed accounts', async () => {
  const {operator,connected} = await fixture(stock(2),[external]);
  try {
    operator.importAndConnect({network:'x',proxies:proxy(3),accounts:'managed:synthetic new:synthetic'});
    await operator.job;
    assert.equal(connected.length,1); assert.equal(connected[0].isp_ip,'203.0.113.2');
    assert.equal(operator.inventory.proxies.length,2);
  } finally { await operator.close(); }
});
