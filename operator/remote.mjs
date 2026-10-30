import { commandRunner, OperatorError } from '../connect.mjs';
import { sshTarget, legacyInventory, validateInventory, validateProxy, fail } from './model.mjs';
import { readFileSync } from 'node:fs';
import { EXISTING_READER } from './existing.mjs';

// A single fixed program. All user data, including credentials, travels on stdin.
// The lock serializes reservations and session writes across operator instances.
const REMOTE_JOBS = readFileSync(new URL('./vps/remote_jobs.py', import.meta.url), 'utf8');
const IP_CHECK = readFileSync(new URL('./vps/ip_check.py', import.meta.url), 'utf8');
const SESSION_PROBE = readFileSync(new URL('./session_probe.py', import.meta.url), 'utf8');
const SESSION_VALIDATION = readFileSync(new URL('./session_validation.py', import.meta.url), 'utf8');
export const REMOTE = `import sys,json,os,stat,hashlib,tempfile,fcntl,time,math
root='/etc/weespy/account-sessions'
bundle=root+'/operator-inventory.json'
legacy=['/etc/weespy/account-inventory/accounts-20261028.json','/etc/weespy/proxy-inventory/inventory-20261028.json']
def safe(path):
    p=path
    while p and p!='/':
        if os.path.islink(p): raise ValueError('link')
        p=os.path.dirname(p)
def read(path):
    safe(path)
    if not os.path.exists(path): return None
    if not stat.S_ISREG(os.stat(path).st_mode): raise ValueError('file')
    with open(path,'rb') as f: data=f.read(2000001)
    if len(data)>2000000: raise ValueError('size')
    return data
def sha(data): return hashlib.sha256(data).hexdigest() if data is not None else None
def version():
    b=read(bundle)
    return {'bundle':sha(b),'legacy':[] if b is not None else [sha(read(p)) for p in legacy]}
def write(path,data):
    safe(path)
    fd,tmp=tempfile.mkstemp(prefix='.operator-',dir=root)
    try:
        os.fchmod(fd,0o600); os.fchown(fd,0,0)
        with os.fdopen(fd,'wb') as f:
            f.write(json.dumps(data,separators=(',',':')).encode()); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        d=os.open(root,os.O_RDONLY)
        try: os.fsync(d)
        finally: os.close(d)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def statuses():
    result=[]
    for network in ('linkedin','x','instagram'):
        for i in range(1,26):
            try:
                b=read(root+'/'+network+'-'+str(i)+'.json')
                if b is None: continue
                s=json.loads(b)
                item={k:s.get(k) for k in ('network','index','label','isp_alias','isp_ip','captured_at')}
                required={'linkedin':['li_at','JSESSIONID'],'x':['auth_token','ct0'],'instagram':['sessionid']}[network]
                cookies=s.get('cookies',[])
                def matches(c,name):
                    return isinstance(c,dict) and c.get('name')==name and valid_cookie({**c,'session':True},network,time.time())
                def alive(c):
                    return valid_cookie(c,network,time.time())
                item['cookieEvidence']=existing_cookie_evidence(cookies,network)
                item['verification']={k:s['verification'].get(k) for k in ('scope','checked_at')} if isinstance(s.get('verification'),dict) else None
                item['cookie_state']='valid' if all(any(matches(c,n) and alive(c) for c in cookies) for n in required) else 'expired' if all(any(matches(c,n) for c in cookies) for n in required) else 'missing'
                result.append(item)
            except Exception:
                result.append({'network':network,'index':i,'problem':'invalid'})
    return result
SESSION_PROBE=${JSON.stringify(SESSION_PROBE)}
${SESSION_VALIDATION}
${EXISTING_READER}
${REMOTE_JOBS}
req=json.load(sys.stdin)
op=req.get('op')
if op=='status':
    if version()!=req['revision']: raise ValueError('changed')
    print(json.dumps({'statuses':statuses(),'existing':existing_sessions()}))
elif op=='load':
    v=version(); b=read(bundle)
    data={'revision':v,'statuses':statuses(),'existing':existing_sessions()}
    if b is not None: data['inventory']=json.loads(b)
    else:
        old=[read(p) for p in legacy]
        if any(x is not None for x in old) and not all(x is not None for x in old): raise ValueError('incomplete')
        data['legacy']=[json.loads(x) for x in old] if all(x is not None for x in old) else None
    if version()!=v: raise ValueError('changed')
    print(json.dumps(data))
elif op in ('reserve','save'):
    safe(root); os.makedirs(root,mode=0o700,exist_ok=True); os.chown(root,0,0); os.chmod(root,0o700)
    lock=root+'/.operator-lock'; safe(lock)
    fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        if version()!=req['revision']: raise ValueError('changed')
        if op=='reserve':
            inv=req['inventory']
            if inv.get('version')!=1 or len(inv['accounts'])>75 or len(inv['proxies'])>25: raise ValueError('inventory')
            # Never silently attach an existing session to a different account/IP.
            for s in statuses():
                if s.get('problem'): raise ValueError('invalid session')
                a=next((a for a in inv['accounts'] if a['network']==s['network'] and a['index']==s['index']),None)
                if a is None: raise ValueError('orphan session')
                label=a['record'].get('profile') if a['network']=='linkedin' else a['record'].get('username')
                if s['label']!=label or s['isp_ip']!=inv['proxies'][a['index']-1]['ip']: raise ValueError('assignment')
            write(bundle,inv)
        else:
            s=req['session']; inv=json.loads(read(bundle))
            a=next((a for a in inv['accounts'] if a['network']==s['network'] and a['index']==s['index']),None)
            if a is None or s['network'] not in ('linkedin','x','instagram') or not 1<=s['index']<=25: raise ValueError('account')
            label=a['record'].get('profile') if a['network']=='linkedin' else a['record'].get('username')
            if s['label']!=label or s['isp_ip']!=inv['proxies'][a['index']-1]['ip'] or s['isp_alias']!='isp'+str(a['index']).zfill(2): raise ValueError('assignment')
            try: s=checked_session(s,inv['proxies'][a['index']-1])
            except SessionFailure as error:
                print(json.dumps({'failure':str(error)})); sys.exit(0)
            path=root+'/'+s['network']+'-'+str(s['index'])+'.json'
            write(path,s)
            if json.loads(read(path))!=s: raise ValueError('readback')
            print(json.dumps({'stored':True,'network':s['network'],'index':s['index'],'label':s['label'],'isp_ip':s['isp_ip'],'captured_at':s['captured_at'],'scope':s['verification']['scope'],'checkedAt':s['verification']['checked_at']}))
            sys.exit(0)
        print(json.dumps({'revision':version()}))
elif op in ('job_start','job_status','job_action'):
    print(json.dumps(job_request(req)))
elif op in ('proxy_check','proxy_probe'):
    if version()!=req['revision']:raise ValueError('changed')
    if op=='proxy_probe':
        p=req.get('proxy')
        if not isinstance(p,dict) or existing_ip(p.get('ip'))!=p.get('ip') or not isinstance(p.get('port'),int) or isinstance(p['port'],bool) or not 1<=p['port']<=65535:raise ValueError('proxy')
        if any(not isinstance(p.get(k),str) or not 1<=len(p[k])<=512 or any(ord(c)<32 or ord(c)==127 for c in p[k]) for k in ('username','password')) or ':' in p['username']:raise ValueError('proxy')
    else:
        if read(bundle):proxies=json.loads(read(bundle))['proxies']
        else:
            fixed=json.loads(read(legacy[1]))['isp_fixed']
            proxies=[{'ip':p['ip'],'port':fixed['port'],**fixed['credential_groups'][p['group']]} for p in fixed['exits']]
        p=next((p for p in proxies if p['ip']==req['ip']),None)
        if p is None:raise ValueError('proxy')
    result=subprocess.run(['docker','run','--pull=never','--rm','-i','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/opt/radar-venv/bin/python','weespy-radar-firefox:local','-B','-c',${JSON.stringify(IP_CHECK)}],input=json.dumps({'proxy':p,'expected_ip':p['ip']}),text=True,capture_output=True,timeout=25)
    print(result.stdout if result.returncode==0 else json.dumps({'failure':'verification_unavailable'}))
else: raise ValueError('operation')
`;
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
export class Remote {
  constructor(target, run = commandRunner) { this.target = sshTarget(target); this.run = run; this.revision = null; }
  async call(request, signal) {
    const t = this.target;
    // An unrelated, stalled shared SSH master must not freeze account operations.
    const args = ['-T', '-o', 'ControlPath=none', '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'];
    if (t.port) args.push('-p', String(t.port));
    if (t.identity) args.push('-i', t.identity);
    args.push('--', t.host, `sudo -n python3 -c ${quote(REMOTE)}`);
    let data;
    try {
      const result = await this.run('ssh', args, { input: JSON.stringify(request), signal, timeout: request.op === 'save' ? 100_000 : 45_000, maxBytes: 2_000_000 });
      data = JSON.parse(result.stdout);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { const error = new OperatorError('VPS inaccessible ou inventaire modifié. Vérifie l’accès SSH, puis recharge le serveur dans les réglages.'); error.category = 'vps'; error.fatal = true; throw error; }
    if (data.failure) {
      const failures = { engine_unavailable: ['vps','Le moteur Firefox automatique n’est pas disponible sur ce VPS. Aucun navigateur local ne sera lancé.'], engine_busy: ['browser','Un navigateur est déjà utilisé sur le VPS. Termine ce parcours avant de relancer.'], existing_conflict: ['identity','Ce compte ou cette IP est déjà géré par un service du VPS. Aucun doublon lancé.'], session_rejected: ['session','LinkedIn a rejeté la session depuis le VPS. Aucun remplacement de la session précédente.'], identity_mismatch: ['identity','Le VPS a reçu une autre identité LinkedIn. Aucun export validé.'], missing_cookies: ['session','Cookies requis absents ou expirés. Aucun export validé.'], stale_capture: ['session','Capture trop ancienne. Recommence la connexion.'], ip_mismatch: ['ip','La sortie du VPS ne correspond pas à l’IP attribuée.'], verification_unavailable: ['verification','Vérification Impit indisponible sur le VPS. La session reste non validée.'] };
      const [category,message] = failures[data.failure] || ['verification','Vérification distante impossible.'];
      const error = new OperatorError(message); error.category=category; if(data.failure==='engine_unavailable')error.fatal=true; throw error;
    }
    return data;
  }
  async load(signal) {
    const data = await this.call({ op: 'load' }, signal);
    const inventory = data.inventory ? validateInventory(data.inventory) : data.legacy ? legacyInventory(...data.legacy) : { version: 1, proxies: [], accounts: [] };
    this.revision = data.revision;
    if (!Array.isArray(data.statuses)) fail('État des sessions invalide.');
    this.existing = data.existing;
    return { inventory, statuses: data.statuses, existing: data.existing };
  }
  async reserve(inventory, signal) {
    const result = await this.call({ op: 'reserve', revision: this.revision, inventory: validateInventory(inventory) }, signal);
    this.revision = result.revision;
  }
  async save(session, signal) {
    const receipt = await this.call({ op: 'save', revision: this.revision, session }, signal);
    if (receipt.stored !== true || ['network','index','label','isp_ip','captured_at'].some(k => receipt[k] !== session[k]) || !Number.isFinite(Date.parse(receipt.checkedAt)) || receipt.scope !== (session.network === 'linkedin' ? 'vps_identity' : 'browser_storage')) {
      const error = new OperatorError('Accusé de sauvegarde du VPS invalide. Recharge les sessions avant de réessayer.'); error.category='vps'; error.fatal=true; throw error;
    }
    return receipt;
  }
  async startJob(row, signal) { return this.call({op:'job_start',engine:'vps-firefox-1',revision:this.revision,network:row.network,index:row.index},signal); }
  async jobStatus(jobId, signal) { return this.call({op:'job_status',jobId},signal); }
  async jobAction(jobId, action, promptId, signal) { return this.call({op:'job_action',jobId,action,promptId},signal); }
  async probeProxy(proxy, signal) { const result = await this.call({op:'proxy_probe',revision:this.revision,proxy:validateProxy(proxy)}, signal); if(result.ok!==true)fail('IP non vérifiée depuis le VPS.'); }
  async checkProxy(row, signal) { const result=await this.call({op:'proxy_check',revision:this.revision,ip:row.isp_ip},signal); if(result.ok!==true)fail('IP non vérifiée depuis le VPS.'); }
  async status(signal) { const data = await this.call({ op: 'status', revision: this.revision }, signal); this.existing = data.existing; return data.statuses; }
}
