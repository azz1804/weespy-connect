import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REMOTE } from './remote.mjs';
import { Operator } from './controller.mjs';
import { existingView, validateDiscovery, reconcileDiscovery } from './existing.mjs';
import { mergeImport, publicInventory } from './model.mjs';

const sourcePaths = {
  'x-worker':'/etc/weespy/secrets/runtime/x-managed-accounts.json',
  'linkedin-worker':'/etc/weespy/secrets/linkedin-pool/jars',
  'linkedin-firefox':'/etc/weespy/account-sessions/vps-firefox-20261030/status.json',
  'instagram-service':'/etc/weespy/instagram-scraper/accounts.json',
  'instagram-auth':'/etc/weespy/instagram-scraper/account-auth.json',
  proxies:'/etc/weespy/secrets/runtime/dedicated-proxies.json',
};
const secret = 'SYNTHETIC_EXISTING_SESSION_SECRET';
const inventory = () => mergeImport({ version: 1, proxies: [], accounts: [] }, { network: 'linkedin', proxies: '203.0.113.1:12323:fake:fake 203.0.113.2:12323:fake:fake', accounts: 'owner@example.test:fake:owner:' });
const external = overrides => ({ source: 'linkedin-worker', id: 'li01', network: 'linkedin', label: 'owner', identityKnown: true, state: 'present', sessionPresent: true, enabled: null, ip: '203.0.113.2', alias: 'p01', updatedAt: '2026-10-29T10:00:00Z', lastCheckAt: null, ...overrides });
const discovery = accounts => ({ accounts, warnings: [] });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weespy-existing-')));
  const paths = Object.fromEntries(Object.keys(sourcePaths).map(key => [key, join(root, key)]));
  let script = REMOTE.replace("root='/etc/weespy/account-sessions'", `root=${JSON.stringify(join(root, 'operator'))}`)
    .replace("legacy=['/etc/weespy/account-inventory/accounts-20261028.json','/etc/weespy/proxy-inventory/inventory-20261028.json']", `legacy=[${JSON.stringify(join(root,'no-accounts'))},${JSON.stringify(join(root,'no-proxies'))}]`);
  for (const [key,path] of Object.entries(sourcePaths)) script = script.replaceAll("'" + path + "'", JSON.stringify(paths[key]));
  const read = () => { const p = spawnSync('/usr/bin/python3', ['-c', script], { input: '{"op":"load"}', encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout).existing; };
  return { root, paths, read, async close() { await rm(root, { recursive: true, force: true }); } };
}
test('existing reader returns only metadata from X, LinkedIn and disabled Instagram sessions', async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths['x-worker'], JSON.stringify({ service01: { cookie_header: `auth_token=${secret}; ct0=${secret}`, ct0: secret, enabled: true } }));
    await mkdir(join(f.paths['linkedin-worker'],'li01'), { recursive: true });
    const jar = { account_id: 'li01', profile_id: 'owner', proxy_alias: 'p01', updated_at: '2026-10-29T10:00:00Z', cookies: ['li_at','JSESSIONID'].map(name => ({ name, value: secret, domain: '.linkedin.com', expires: 4102444800 })) };
    const jarPath=join(f.paths['linkedin-worker'],'li01','jar.json'); await writeFile(jarPath, JSON.stringify(jar));
    await writeFile(f.paths.proxies, JSON.stringify({ p01: `http://user:${secret}@203.0.113.2:12323` }));
    await writeFile(f.paths['instagram-service'], JSON.stringify({ accounts: [{ account_id: 'old-ig', auth_ref: 'old-ig', enabled: false }, { account_id: 'new-ig', auth_ref: 'new-ig', enabled: true }] }));
    await writeFile(f.paths['instagram-auth'], JSON.stringify({ accounts: { 'old-ig': { username: 'old-instagram', sessionid: secret, proxy: `http://user:${secret}@203.0.113.3:12323`, totp_seed: secret }, 'new-ig': { username: 'new-instagram', password: secret } } }));
    const before = await readFile(jarPath, 'utf8');
    const result = f.read(); assert.deepEqual(result.warnings, []); assert.equal(result.accounts.length, 3);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('cookie_header'));
    assert.equal(result.accounts.find(a=>a.network==='linkedin').ip, '203.0.113.2');
    assert.equal(result.accounts.find(a=>a.network==='x').identityKnown, false);
    assert.equal(result.accounts.find(a=>a.network==='instagram').enabled, false);
    assert.equal(await readFile(jarPath,'utf8'), before);
    assert.equal(validateDiscovery(result).accounts.length, 3);
  } finally { await f.close(); }
});
test('existing reader distinguishes expired, rejected, renewed and unsafe sources', async () => {
  const f = await fixture();
  try {
    const folder=join(f.paths['linkedin-worker'],'li01'); await mkdir(folder,{recursive:true});
    await writeFile(f.paths.proxies, '{}');
    const jar={account_id:'li01',profile_id:'owner',proxy_alias:'p01',updated_at:'2026-10-29T10:00:00Z',cookies:['li_at','JSESSIONID'].map(name=>({name,value:secret,domain:'.linkedin.com',expires:1}))};
    await writeFile(join(folder,'jar.json'),JSON.stringify(jar));
    assert.equal(f.read().accounts[0].state,'expired');
    jar.cookies.forEach(c=>c.expires=4102444800); await writeFile(join(folder,'jar.json'),JSON.stringify(jar));
    await writeFile(join(folder,'visit.json'),JSON.stringify({at:'2026-10-29T10:01:00Z',signal:'session',status:302}));
    assert.equal(f.read().accounts[0].state,'rejected');
    jar.updated_at='2026-10-29T10:02:00Z'; await writeFile(join(folder,'jar.json'),JSON.stringify(jar));
    assert.equal(f.read().accounts[0].state,'present');
    await rm(join(folder,'jar.json')); await symlink(f.paths.proxies,join(folder,'jar.json'));
    const invalid=f.read(); assert.deepEqual(invalid.warnings,['linkedin-worker']); assert.equal(invalid.accounts.length,0);
  } finally { await f.close(); }
});
test('existing identity is merged once with its real IP; another account cannot claim that IP', () => {
  const inv=mergeImport(inventory(),{network:'linkedin',accounts:'second@example.test:fake:second:'});
  const rows=existingView(publicInventory(inv).accounts,discovery([external()]));
  assert.equal(rows.length,2); assert.equal(rows[0].key,'li1'); assert.equal(rows[0].ip,'203.0.113.2'); assert.equal(rows[0].configuredIP,'203.0.113.1');
  assert.equal(rows[0].readOnly,true); assert.equal(rows[0].state,'existing'); assert.equal(rows[1].state,'conflict');
  assert.equal(inv.accounts[0].index,1);
});
test('opaque service IDs never match inventory numbers; unknown identities block duplicate logins', () => {
  const inv=mergeImport(inventory(),{network:'x',accounts:'my-profile:fake'});
  const data=discovery([external({source:'x-worker',network:'x',id:'x01',label:'x01',identityKnown:false,ip:null,alias:null,enabled:true})]);
  const rows=existingView(publicInventory(inv).accounts,data);
  assert.equal(rows.length,3); assert.equal(rows.find(a=>a.key==='x1').state,'unavailable');
  assert.equal(rows.find(a=>a.external).label,'x01'); assert.equal(rows.find(a=>a.external).ip,null);
});
test('new imports avoid IPs used by existing sessions and existing accounts cannot be reconnected by API', async () => {
  const inv={...inventory(),accounts:[]};
  const data=discovery([external({label:'already-there',ip:'203.0.113.1'})]);
  const remote={target:{host:'fake'},load:async()=>({inventory:inv,statuses:[],existing:data}),reserve:async()=>{}};
  const connected=[],operator=new Operator({remote:()=>remote,connect:async({row})=>connected.push(row.key)});
  await operator.load(remote.target);
  const input={proxies:'',accounts:{linkedin:'new@example.test:fake:new-profile:'},includePending:true};
  const preview=operator.previewSetup(input); assert.equal(preview.accounts[0].ip,'203.0.113.2');
  operator.setupAndConnect({...input,previewId:preview.previewId}); await operator.job; assert.deepEqual(connected,['li2']);
  const remote2={...remote,load:async()=>({inventory:inventory(),statuses:[],existing:discovery([external()])})};
  const protectedOperator=new Operator({remote:()=>remote2}); await protectedOperator.load(remote2.target);
  assert.throws(()=>protectedOperator.start(['li1']),/déjà géré/);
  const snapshot=JSON.stringify(protectedOperator.snapshot({agent:true})); assert.ok(!snapshot.includes('owner@example.test')); assert.ok(!snapshot.includes('"label"'));
  await operator.close(); await protectedOperator.close();
});
test('source read failures keep last-known rows and prevent automatic reconnection', async () => {
  const first=discovery([external()]),failed={accounts:[],warnings:['linkedin-worker']};
  const remote={target:{host:'fake'},existing:first,load:async()=>({inventory:inventory(),statuses:[],existing:first}),status:async()=>[]};
  const operator=new Operator({remote:()=>remote}); await operator.load(remote.target);
  remote.existing=failed; await operator.refreshHealth();
  assert.equal(operator.snapshot().accounts[0].state,'unavailable'); assert.equal(operator.snapshot().accounts[0].readOnly,true);
  assert.throws(()=>operator.start(),/ne peuvent pas être vérifiées/);
  remote.existing=first; await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state,'existing');
  assert.deepEqual(operator.snapshot().discoveryWarnings,[]); await operator.close();
});
test('preflight stops a queue if another service connected an account since the last refresh', async () => {
  const actions=[];
  const remote={target:{host:'fake'},load:async()=>({inventory:inventory(),statuses:[]}),status:async()=>{remote.existing=discovery([external()]);return []},reserve:async()=>actions.push('reserve')};
  const operator=new Operator({remote:()=>remote,connect:async()=>actions.push('connect')}); await operator.load(remote.target);
  operator.start(); await operator.job; assert.deepEqual(actions,[]); assert.equal(operator.snapshot().accounts[0].state,'existing');
  await operator.close();
});
test('discovery drops unexpected fields, rejects inconsistent sources and retains failure provenance', () => {
  const valid=validateDiscovery(discovery([external({cookies:secret,password:secret})])); assert.ok(!JSON.stringify(valid).includes(secret));
  const wrong=validateDiscovery(discovery([external({network:'x'})])); assert.deepEqual(wrong.warnings,['linkedin-worker']);
  const duplicate=validateDiscovery(discovery([external(),external({id:'li02'})])); assert.equal(duplicate.accounts.length,0);
  const stale=reconcileDiscovery(valid,{accounts:[],warnings:['linkedin-worker']}); assert.equal(stale.accounts[0].stale,true);
});
test('Firefox proofs replace older worker metadata without exposing secrets or allowing duplicate connection', async () => {
  const f=await fixture();
  try {
    const folder=join(f.paths['linkedin-worker'],'li01'); await mkdir(folder,{recursive:true});
    await writeFile(join(folder,'jar.json'),JSON.stringify({account_id:'li01',profile_id:'owner',proxy_alias:'p01',cookies:[]}));
    await writeFile(f.paths.proxies,'{}');
    await writeFile(f.paths['linkedin-firefox'],JSON.stringify({version:1,accounts:[{account:'li01',profile:'owner',ip:'203.0.113.2',alias:'isp21',status:'verified',verified_at:'2026-10-30T13:00:00+00:00',cookie_header:secret}]}));
    await writeFile(join(f.root,'li01.json'),JSON.stringify({network:'linkedin',index:1,label:'owner',isp_ip:'203.0.113.2',isp_alias:'isp21',verified_at:'2026-10-30T13:00:00Z',cookie_header:`li_at=${secret}; JSESSIONID=${secret}`}));
    const result=f.read();assert.deepEqual(result.warnings,[]);assert.equal(result.accounts.length,1);
    assert.equal(result.accounts[0].source,'linkedin-firefox');assert.ok(!JSON.stringify(result).includes(secret));
    const valid=validateDiscovery(result);assert.deepEqual(valid.warnings,[]);
    const rows=existingView(publicInventory(inventory()).accounts,valid);
    assert.equal(rows[0].state,'existing');assert.equal(rows[0].readOnly,true);assert.equal(rows[0].ip,'203.0.113.2');
    assert.match(rows[0].message,/Identité vérifiée/);assert.equal(rows[0].serviceCheckedAt,'2026-10-30T13:00:00Z');
    assert.deepEqual(rows[0].ipHealth,{state:'ok',checkedAt:'2026-10-30T13:00:00Z'});
  } finally {await f.close();}
});
test('Firefox missing cookies and excluded accounts stay actionable without claiming an authenticated session', async () => {
  const f=await fixture();
  try {
    await writeFile(f.paths['linkedin-firefox'],JSON.stringify({version:1,accounts:[{account:'li01',profile:'owner',ip:'203.0.113.2',alias:'isp21',status:'session_export_failed',verified_at:null},{account:'li04',profile:'excluded',ip:'203.0.113.3',alias:'isp24',status:'excluded',verified_at:null},{account:'li02',profile:'lost',ip:'203.0.113.4',alias:'isp22',status:'session_cookie_lost',verified_at:null}]}));
    const valid=validateDiscovery(f.read());assert.deepEqual(valid.warnings,[]);
    const rows=existingView(publicInventory(inventory()).accounts,valid);
    assert.equal(rows[0].state,'error');assert.equal(rows[0].sessionPresent,false);assert.match(rows[0].message,/connexion non validée/);
    assert.equal(rows[1].state,'disabled');assert.equal(rows[1].sessionPresent,false);
    assert.equal(rows[2].state,'error');assert.equal(rows[2].sessionPresent,false);assert.match(rows[2].message,/disparu avant fermeture/);
  } finally {await f.close();}
});
test('Firefox verified state requires a dated proof and matching network', () => {
  const invalid=validateDiscovery(discovery([external({source:'linkedin-firefox',state:'verified',detail:'verified',lastCheckAt:null})]));
  assert.deepEqual(invalid.warnings,['linkedin-firefox']);assert.equal(invalid.accounts.length,0);
});

test('Firefox cookie evidence reads the bound export and strips all values before crossing SSH', async () => {
  const f=await fixture();
  try {
    const manifest={version:1,accounts:[{account:'li01',profile:'owner',ip:'203.0.113.2',alias:'p01',status:'verified',verified_at:'2026-10-30T12:00:00Z'}]};
    await writeFile(f.paths['linkedin-firefox'],JSON.stringify(manifest));
    const path=join(f.root,'li01.json');
    await writeFile(path,JSON.stringify({network:'linkedin',index:1,label:'owner',isp_ip:'203.0.113.2',isp_alias:'p01',verified_at:'2026-10-30T12:00:00Z',cookie_header:`li_at=${secret}; JSESSIONID=${secret}`}));
    const result=f.read(); assert.deepEqual(result.warnings,[]);
    assert.deepEqual(result.accounts[0].cookieEvidence.cookies,[{name:'li_at',state:'present'},{name:'JSESSIONID',state:'present'}]);
    assert.ok(!JSON.stringify(result).includes(secret));
    const rows=existingView([],validateDiscovery(result)); assert.equal(rows[0].cookieEvidence.cookies[0].name,'li_at');
    assert.equal(existingView([],reconcileDiscovery(validateDiscovery(result),{accounts:[],warnings:['linkedin-firefox']}))[0].cookieEvidence,null);
    await writeFile(path,JSON.stringify({network:'linkedin',index:1,label:'different',isp_ip:'203.0.113.2',isp_alias:'p01',verified_at:'2026-10-30T12:00:00Z',cookie_header:`li_at=${secret}`}));
    assert.deepEqual(f.read().warnings,['linkedin-firefox']);
    await rm(path); const missing=f.read().accounts[0]; assert.equal(missing.cookieEvidence,null); assert.equal(missing.state,'missing'); assert.equal(missing.detail,'session_export_failed');
  } finally { await f.close(); }
});
