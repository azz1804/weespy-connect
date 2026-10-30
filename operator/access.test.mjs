import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAccess, accessErrorMessage } from './public/access.js';
import { createServer, readLocalAccess } from './server.mjs';
const oldToken='a'.repeat(64), newToken='b'.repeat(64);
function browser(stored=oldToken,hash='') {
  const values=new Map([['weespy-local',stored]]),listeners={};
  const b={location:{hash},sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},addEventListener:(name,fn)=>listeners[name]=fn};
  b.history={replaceState:(_state,_unused,path)=>{assert.equal(path,'/');b.location.hash='';}};
  b.navigateHash=value=>{b.location.hash=value;listeners.hashchange();};return b;
}
test('launcher refresh replaces stale token in the same tab without a reload',()=>{
  const b=browser();let renewed=0;const access=createLocalAccess(b,()=>renewed++);
  assert.equal(access.getToken(),oldToken);
  b.navigateHash('#'+newToken);
  assert.equal(access.getToken(),newToken);assert.equal(b.sessionStorage.getItem('weespy-local'),newToken);
  assert.equal(b.location.hash,'');assert.equal(renewed,1);
  b.navigateHash('#home');assert.equal(access.getToken(),newToken);assert.equal(renewed,1);
});
test('first load consumes fresh launcher token and rejects malformed stored credentials',()=>{
  const b=browser(oldToken,'#'+newToken);let renewed=0;const access=createLocalAccess(b,()=>renewed++);
  assert.equal(access.getToken(),newToken);assert.equal(b.location.hash,'');assert.equal(renewed,0);
  assert.equal(createLocalAccess(browser('invalid')).getToken(),'');
});
test('authentication failures are distinguished from a stopped local application',()=>{
  assert.match(accessErrorMessage({status:401}),/Accès.*non reconnu/);
  assert.doesNotMatch(accessErrorMessage({status:401}),/Impossible de joindre/);
  assert.match(accessErrorMessage(new TypeError('Failed to fetch')),/Impossible de joindre/);
});
test('reopened tab authenticates against the new server and the module is served',async()=>{
  const app=await createServer({token:newToken});const b=browser(),access=createLocalAccess(b);
  try {
    const get=()=>fetch(app.origin+'/api/state',{headers:{Authorization:'Bearer '+access.getToken()}});
    assert.equal((await get()).status,401);
    b.navigateHash('#'+newToken);assert.equal((await get()).status,200);
    const module=await fetch(app.origin+'/access.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
    const html=await (await fetch(app.origin)).text();assert.match(html,/<script type="module" src="\/app.js"/);
  }finally{await app.close();}
});


test('authenticated browser can open another tab without a fragment; foreign requests remain blocked', async () => {
  const app = await createServer({token:newToken});
  try {
    const response = await fetch(app.origin+'/api/state', {headers:{Authorization:'Bearer '+newToken}});
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
    const headers = {Cookie:cookie.split(';')[0], 'Sec-Fetch-Site':'same-origin'};
    assert.equal((await fetch(app.origin+'/api/state',{headers})).status,200);
    assert.equal((await fetch(app.origin+'/api/state',{headers:{...headers,Authorization:'Bearer '+oldToken}})).status,200);
    assert.equal((await fetch(app.origin+'/api/state',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,401);
    assert.equal((await fetch(app.origin+'/api/state',{headers:{...headers,Origin:'https://foreign.test'}})).status,403);
    const post = extra => fetch(app.origin+'/api/setup-cancel-checks',{method:'POST',headers:{...headers,'Content-Type':'application/json',...extra},body:'{}'});
    assert.equal((await post({})).status,401);
    assert.equal((await post({Origin:app.origin})).status,200);
    assert.equal((await fetch(app.origin+'/api/state')).status,401);
  } finally { await app.close(); }
});
test('private access persists across restarts and unsafe runtime files are rejected', async () => {
  const {mkdtemp, writeFile, chmod, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(),'weespy-access-')), path = join(dir,'runtime.json');
  let app;
  try {
    await writeFile(path,JSON.stringify({origin:'http://127.0.0.1:49831',token:newToken}),{mode:0o600});
    const saved = await readLocalAccess(path); assert.equal(saved.token,newToken);
    app = await createServer({token:saved.token}); await app.close();
    app = await createServer({token:(await readLocalAccess(path)).token});
    assert.equal((await fetch(app.origin+'/api/state',{headers:{Authorization:'Bearer '+newToken}})).status,200);
    await chmod(path,0o644); assert.equal(await readLocalAccess(path),null);
    await chmod(path,0o600); await writeFile(path,'invalid'); assert.equal(await readLocalAccess(path),null);
  } finally { await app?.close(); await rm(dir,{recursive:true,force:true}); }
});
