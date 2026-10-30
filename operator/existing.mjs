import { cookieEvidence } from './cookie-evidence.mjs';
import net from 'node:net';
import { digest } from './model.mjs';

// Runs only on the VPS. Cookie values and proxy credentials never leave this reader.
export const EXISTING_READER = `
import re,datetime,ipaddress,urllib.parse
existing_paths={
 'x-worker':'/etc/weespy/secrets/runtime/x-managed-accounts.json',
 'linkedin-worker':'/etc/weespy/secrets/linkedin-pool/jars',
 'linkedin-firefox':'/etc/weespy/account-sessions/vps-firefox-20261030/status.json',
 'instagram-service':'/etc/weespy/instagram-scraper/accounts.json',
 'instagram-auth':'/etc/weespy/instagram-scraper/account-auth.json',
 'proxies':'/etc/weespy/secrets/runtime/dedicated-proxies.json'
}
def existing_json(path):
    data=read(path)
    return json.loads(data) if data is not None else None
def existing_date(value):
    try:
        d=datetime.datetime.fromisoformat(str(value).replace('Z','+00:00'))
        if d.tzinfo is None: return None
        return d.astimezone(datetime.timezone.utc).isoformat().replace('+00:00','Z')
    except Exception: return None
def existing_label(value):
    return value if isinstance(value,str) and re.fullmatch(r'[\\w.@%:-]{1,160}',value) else None
def existing_ip(value):
    try:
        host=urllib.parse.urlsplit(value if '://' in str(value) else '//'+str(value)).hostname
        ip=ipaddress.ip_address(host)
        return str(ip) if ip.version==4 else None
    except Exception: return None
def existing_cookie_state(cookies,network):
    required={'linkedin':['li_at','JSESSIONID'],'instagram':['sessionid'],'x':['auth_token','ct0']}[network]
    domains={'linkedin':['linkedin.com'],'instagram':['instagram.com'],'x':['x.com','twitter.com']}[network]
    if not isinstance(cookies,list): return 'missing'
    rows=[c for c in cookies if isinstance(c,dict)]
    def matching(c,n):
        domain=str(c.get('domain','')).lower().lstrip('.')
        value=c.get('value')
        return c.get('name')==n and isinstance(value,str) and bool(value.strip()) and value.strip().strip('"').lower()!='delete me' and any(domain==d or domain.endswith('.'+d) for d in domains)
    def alive(c):
        expiry=c.get('expires')
        return c.get('session') is True or expiry is None or (isinstance(expiry,(int,float)) and not isinstance(expiry,bool) and math.isfinite(expiry) and (expiry==-1 or expiry>time.time()))
    if not all(any(matching(c,n) for c in rows) for n in required): return 'missing'
    return 'present' if all(any(matching(c,n) and alive(c) for c in rows) for n in required) else 'expired'
def existing_cookie_evidence(cookies,network):
    required={'linkedin':['li_at','JSESSIONID'],'instagram':['sessionid'],'x':['auth_token','ct0']}[network]
    domains={'linkedin':['linkedin.com'],'instagram':['instagram.com'],'x':['x.com','twitter.com']}[network]
    rows=[]
    for name in required:
        candidates=[c for c in cookies if isinstance(c,dict) and c.get('name')==name and isinstance(c.get('value'),str) and c['value'].strip() and c['value'].strip().strip('"').lower()!='delete me' and any(str(c.get('domain','')).lower().lstrip('.')==d or str(c.get('domain','')).lower().endswith('.'+d) for d in domains)] if isinstance(cookies,list) else []
        def alive(c):
            expiry=c.get('expires')
            return c.get('session') is True or expiry is None or (isinstance(expiry,(int,float)) and not isinstance(expiry,bool) and math.isfinite(expiry) and (expiry==-1 or expiry>time.time()))
        rows.append({'name':name,'state':'present' if any(alive(c) for c in candidates) else 'expired' if candidates else 'missing'})
    return {'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'cookies':rows}
def existing_header_cookies(header,network):
    if not isinstance(header,str) or len(header)>20000: raise ValueError('cookies')
    values={}
    for part in header.split(';'):
        name,sep,value=part.strip().partition('=')
        if sep:values[name]=value
    return [{'name':name,'value':value,'domain':'.'+{'linkedin':'linkedin.com','x':'x.com','instagram':'instagram.com'}[network]} for name,value in values.items()]
def existing_x_routes(account_ids):
    # Resolve explicit worker routing. Never guess an IP from an account number.
    import subprocess
    try:
        ids=subprocess.check_output(['docker','ps','--filter','name=weespy-backend-worker-','--format','{{.ID}}'],timeout=5,stderr=subprocess.DEVNULL).decode().split()
        if not ids or len(ids)>32:return {}
        containers=json.loads(subprocess.check_output(['docker','inspect',*ids],timeout=5,stderr=subprocess.DEVNULL))
        proxies=existing_json(existing_paths['proxies']) or {}
        routes={account:set() for account in account_ids}
        for container in containers:
            if not any(m.get('Source')==existing_paths['x-worker'] and m.get('Destination')=='/run/secrets/x-managed-accounts.json' for m in container.get('Mounts',[])):continue
            env=dict(e.split('=',1) for e in container.get('Config',{}).get('Env',[]) if '=' in e)
            assignments=json.loads(env.get('WEESPY_DEDICATED_PROXY_ASSIGNMENTS','{}'))
            for account in account_ids:
                key='x-session:'+hashlib.sha256(('x-session-proxy\\0default\\0'+account).encode()).hexdigest()
                alias=assignments.get(key)
                ip=existing_ip(proxies.get(alias)) if alias else None
                routes[account].add((alias,ip))
        return {account:{'alias':next(iter(values))[0],'ip':next(iter(values))[1]} for account,values in routes.items() if len(values)==1 and all(next(iter(values)))}
    except Exception:return {}
def existing_sessions():
    accounts=[]; warnings=[]
    def emit(source,account_id,network,label,identity_known,state,session_present,**extra):
        if not existing_label(account_id) or not existing_label(label): raise ValueError('identity')
        accounts.append(dict(source=source,id=account_id,network=network,label=label,identityKnown=identity_known,state=state,sessionPresent=session_present,**extra))
    source='x-worker'
    try:
        config=existing_json(existing_paths[source])
        if config is not None:
            if not isinstance(config,dict) or len(config)>200: raise ValueError('config')
            routes=existing_x_routes(config.keys())
            for account_id,entry in config.items():
                if not isinstance(entry,dict): raise ValueError('entry')
                header=entry.get('cookie_header',''); csrf=entry.get('ct0')
                if not isinstance(header,str) or len(header)>20000: raise ValueError('cookies')
                values={}
                for part in header.split(';'):
                    name,sep,value=part.strip().partition('=')
                    if sep: values[name]=value
                present=bool(values.get('auth_token')) and bool(csrf) and values.get('ct0')==csrf
                label=existing_label(entry.get('username'))
                enabled=entry.get('enabled',True) is True
                emit(source,account_id,'x',label or account_id,bool(label),'present' if present else 'missing',present,enabled=enabled,ip=routes.get(account_id,{}).get('ip'),alias=routes.get(account_id,{}).get('alias'),updatedAt=None,lastCheckAt=None,cookieEvidence=existing_cookie_evidence(existing_header_cookies(header,'x'),'x'))
    except Exception: warnings.append(source)
    source='linkedin-worker'
    try:
        root_path=existing_paths[source]; safe(root_path)
        if os.path.exists(root_path):
            if not os.path.isdir(root_path): raise ValueError('directory')
            proxies=existing_json(existing_paths['proxies']) or {}
            folders=sorted(n for n in os.listdir(root_path) if re.fullmatch(r'li[0-9]{2,4}',n))
            if len(folders)>200: raise ValueError('size')
            for account_id in folders:
                jar=existing_json(root_path+'/'+account_id+'/jar.json')
                if jar is None: continue
                if not isinstance(jar,dict) or jar.get('account_id')!=account_id: raise ValueError('jar')
                label=existing_label(jar.get('profile_id')); alias=existing_label(jar.get('proxy_alias'))
                if not label or not alias: raise ValueError('identity')
                state=existing_cookie_state(jar.get('cookies'),'linkedin')
                present=state!='missing'; updated=existing_date(jar.get('updated_at'))
                visit=existing_json(root_path+'/'+account_id+'/visit.json') or {}
                checked=existing_date(visit.get('at'))
                if checked and (not updated or datetime.datetime.fromisoformat(checked.replace('Z','+00:00'))>=datetime.datetime.fromisoformat(updated.replace('Z','+00:00'))) and visit.get('signal')=='session': state='rejected'
                emit(source,account_id,'linkedin',label,True,state,present,enabled=None,ip=existing_ip(proxies.get(alias)),alias=alias,updatedAt=updated,lastCheckAt=checked,cookieEvidence=existing_cookie_evidence(jar.get('cookies'),'linkedin'))
    except Exception: warnings.append(source)
    source='linkedin-firefox'
    try:
        manifest=existing_json(existing_paths[source])
        if manifest is not None:
            if not isinstance(manifest,dict) or manifest.get('version')!=1 or not isinstance(manifest.get('accounts'),list) or len(manifest['accounts'])>200: raise ValueError('manifest')
            for entry in manifest['accounts']:
                if not isinstance(entry,dict): raise ValueError('entry')
                result=entry.get('status')
                if result not in {'verified','login_refused','session_expired','session_export_failed','session_cookie_lost','session_check_failed','browser_error','excluded','browser_starting','browser_ready','login_submitted','awaiting_browser_quit','cookies_captured','captcha','restricted','email_code','human_verification','totp_failed','pending','needs_login'}: raise ValueError('state')
                checked=existing_date(entry.get('verified_at'))
                if result=='verified' and not checked: raise ValueError('proof')
                account=entry.get('account')
                if not isinstance(account,str) or not re.fullmatch(r'li[0-9]{2,4}',account):raise ValueError('account')
                saved=existing_json(os.path.dirname(existing_paths[source])+'/'+account+'.json')
                evidence=None
                if saved is not None:
                    if not isinstance(saved,dict) or saved.get('network')!='linkedin' or saved.get('index')!=int(account[2:]) or saved.get('label')!=entry.get('profile') or saved.get('isp_ip')!=entry.get('ip') or saved.get('isp_alias')!=entry.get('alias'):raise ValueError('assignment')
                    evidence=existing_cookie_evidence(existing_header_cookies(saved.get('cookie_header'),'linkedin'),'linkedin')
                if result=='verified' and (evidence is None or any(c['state']!='present' for c in evidence['cookies']) or existing_date(saved.get('verified_at'))!=checked):result='session_export_failed'
                emit(source,entry.get('account'),'linkedin',entry.get('profile'),True,'verified' if result=='verified' else 'missing',result=='verified',enabled=False if result=='excluded' else None,ip=existing_ip(entry.get('ip')),alias=existing_label(entry.get('alias')),updatedAt=checked,lastCheckAt=checked,detail=result,cookieEvidence=evidence)
    except Exception: warnings.append(source)
    source='instagram-service'
    try:
        config=existing_json(existing_paths[source])
        if config is not None:
            auth=existing_json(existing_paths['instagram-auth'])
            entries=config.get('accounts') if isinstance(config,dict) else None
            if not isinstance(entries,list) or len(entries)>200 or not isinstance(auth,dict) or not isinstance(auth.get('accounts'),dict): raise ValueError('config')
            for entry in entries:
                if not isinstance(entry,dict): raise ValueError('entry')
                details=auth['accounts'].get(entry.get('auth_ref'))
                if not isinstance(details,dict): raise ValueError('auth')
                present=isinstance(details.get('sessionid'),str) and bool(details['sessionid'].strip())
                if not present: continue
                label=existing_label(details.get('username'))
                if not label: raise ValueError('identity')
                emit(source,entry.get('account_id'),'instagram',label,True,'present',True,enabled=entry.get('enabled',True) is True,ip=existing_ip(details.get('proxy')),alias=None,updatedAt=None,lastCheckAt=None,cookieEvidence=existing_cookie_evidence([{'name':'sessionid','value':details['sessionid'],'domain':'.instagram.com'}],'instagram'))
    except Exception: warnings.append(source)
    # Do not treat a partially read source as a complete, trusted inventory.
    accounts=[a for a in accounts if a['source'] not in warnings]
    firefox_profiles={a['label'].lower() for a in accounts if a['source']=='linkedin-firefox'}
    return {'accounts':[a for a in accounts if a['source']!='linkedin-worker' or a['label'].lower() not in firefox_profiles],'warnings':warnings}
`;

const sources = { 'x-worker': 'Service X du VPS', 'linkedin-worker': 'Service LinkedIn du VPS', 'linkedin-firefox': 'Firefox sur VPS', 'instagram-service': 'Service Instagram du VPS' };
const sourceNetwork = { 'x-worker': 'x', 'linkedin-worker': 'linkedin', 'linkedin-firefox': 'linkedin', 'instagram-service': 'instagram' };
const firefoxDetails = { verified: 'Identité vérifiée avec Impit sur cette IP. Vérification datée, sans garantie de connexion permanente.', login_refused: 'LinkedIn a refusé la tentative de connexion. Identifiants à recontrôler.', session_expired: 'Retour à la connexion après le premier essai ; reprise sur le même profil nécessaire.', session_export_failed: 'Sauvegarde impossible ou incomplète ; connexion non validée.', session_cookie_lost: 'Connexion acceptée, puis cookie de session disparu avant fermeture. Compte à vérifier sur LinkedIn.', session_check_failed: 'La vérification de la session a échoué.', browser_error: 'Le navigateur ou son contrôle réseau a échoué.', excluded: 'Compte écarté par une consigne antérieure ; réexamen en attente.', captcha: 'CAPTCHA : intervention nécessaire.', restricted: 'Restriction LinkedIn : intervention nécessaire.', email_code: 'Code e-mail nécessaire.', human_verification: 'Vérification humaine nécessaire.', totp_failed: 'Code 2FA refusé.' };
const safeText = value => typeof value === 'string' && /^[\p{L}\p{N}_.@%:-]{1,160}$/u.test(value);
const timestamp = value => value === null || value === undefined ? null : typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
export function validateDiscovery(value = { accounts: [], warnings: [] }) {
  if (!value || !Array.isArray(value.accounts) || value.accounts.length > 600 || !Array.isArray(value.warnings)) return { accounts: [], warnings: Object.keys(sources) };
  const warnings = new Set(value.warnings.filter(s => Object.hasOwn(sources, s))), accounts = [], found = new Set(), identities = new Set();
  for (const a of value.accounts) {
    if (!a || !Object.hasOwn(sources, a.source)) { for (const s of Object.keys(sources)) warnings.add(s); continue; }
    const key = `${a.source}:${a.id}`;
    if (a.network !== sourceNetwork[a.source] || !safeText(a.id) || !safeText(a.label) || !['present','expired','rejected','missing','verified'].includes(a.state) || (a.state === 'verified' && (a.source !== 'linkedin-firefox' || !timestamp(a.lastCheckAt) || !a.sessionPresent)) || typeof a.identityKnown !== 'boolean' || typeof a.sessionPresent !== 'boolean' || ![true,false,null].includes(a.enabled) || (a.ip !== null && net.isIP(a.ip) !== 4) || (a.alias !== null && !safeText(a.alias)) || found.has(key)) { warnings.add(a.source); continue; }
    found.add(key);
    const person = `${a.network}:${a.label.toLowerCase()}`;
    if (a.identityKnown && identities.has(person)) { warnings.add(a.source); continue; }
    if (a.identityKnown) identities.add(person);
    accounts.push({ source: a.source, id: a.id, network: a.network, label: a.label, identityKnown: a.identityKnown, state: a.state, sessionPresent: a.sessionPresent, enabled: a.enabled, ip: a.ip, alias: a.alias, updatedAt: timestamp(a.updatedAt), lastCheckAt: timestamp(a.lastCheckAt), cookieEvidence: cookieEvidence(a.network, a.cookieEvidence), ...(a.source==='linkedin-firefox' ? {detail:Object.hasOwn(firefoxDetails,a.detail)?a.detail:'pending'} : {}) });
  }
  return { accounts: accounts.filter(a => !warnings.has(a.source)), warnings: [...warnings] };
}
export function reconcileDiscovery(previous, incoming) {
  const next = validateDiscovery(incoming);
  return { ...next, accounts: [...next.accounts, ...(previous?.accounts || []).filter(a => next.warnings.includes(a.source)).map(a => ({ ...a, stale: true }))] };
}
export function existingView(rows, discovery) {
  const result = rows.map(row => ({ ...row }));
  for (const a of discovery.accounts) {
    const matches = a.identityKnown ? result.filter(r => !r.external && r.network === a.network && r.label.toLowerCase() === a.label.toLowerCase()) : [];
    const match = matches.length === 1 ? matches[0] : null;
    const metadata = { source: a.source, sourceLabel: sources[a.source], readOnly: true, sessionPresent: a.sessionPresent, capturedAt: a.updatedAt, serviceCheckedAt: a.lastCheckAt, identityKnown: a.identityKnown, cookieEvidence: a.stale ? null : cookieEvidence(a.network, a.cookieEvidence) };
    const verifiedIP = a.source === 'linkedin-firefox' && a.state === 'verified' && !a.stale && a.ip && a.lastCheckAt ? { state: 'ok', checkedAt: a.lastCheckAt } : null;
    let state = a.stale ? 'unavailable' : a.state === 'rejected' ? 'error' : a.state === 'expired' ? 'expired' : a.enabled === false ? 'disabled' : a.state === 'missing' ? 'error' : 'existing';
    let message = a.stale ? 'Lecture de cette source impossible. Dernier état conservé ; validité inconnue.' : a.state === 'rejected' ? 'Le service a signalé une perte de session. Intervention nécessaire sur le VPS.' : a.state === 'expired' ? 'Session existante expirée. Intervention nécessaire sur le VPS.' : a.enabled === false ? 'Session retrouvée, mais ce compte est désactivé dans son service.' : a.state === 'missing' ? 'Le service connaît ce compte, mais sa session est incomplète.' : 'Session déjà présente dans le service. Authentification auprès du réseau non revérifiée.';
    if(a.source==='linkedin-firefox' && !a.stale) message=firefoxDetails[a.detail] || 'Parcours Firefox en cours ou en attente ; connexion non validée.';
    if (!a.identityKnown) message += a.ip ? ' Profil non identifié ; son IP réelle reste réservée au service existant.' : ' Le nom du profil et son IP ne sont pas fournis par cette source ; aucune association par numéro.';
    if (match) {
      const configuredIP = match.ip;
      if (['existing', 'saved'].includes(match.state)) message += ' Une session de ce compte est également présente dans le dossier de l’outil.';
      if (a.ip && a.ip !== configuredIP) message += ` L’inventaire de l’outil prévoit ${configuredIP} ; l’IP existante est conservée à l’affichage.`;
      Object.assign(match, metadata, { state, message, ip: a.ip, alias: a.alias, configuredIP, ipHealth: verifiedIP || (a.ip === configuredIP ? match.ipHealth : { state: 'unknown' }), category: state === 'existing' ? undefined : 'session' });
    } else result.push({ key: 'external-' + digest(a.source + ':' + a.id).slice(0,16), network: a.network, label: a.label, ip: a.ip, alias: a.alias, ...metadata, external: true, state, message, category: state === 'existing' ? undefined : 'session', history: [], ipHealth: verifiedIP || { state: 'unknown' } });
  }
  // A connected account may use a slot which the new inventory calls free.
  for (const row of result.filter(r => !r.readOnly)) {
    if (discovery.accounts.some(a => a.ip && a.ip === row.ip && a.network === row.network && !(a.identityKnown && a.label.toLowerCase() === row.label.toLowerCase()))) {
      Object.assign(row, { readOnly: true, state: 'conflict', category: 'ip', message: 'Cette IP est déjà associée à une autre session de ce réseau sur le VPS. Corrige l’affectation avant de connecter ce compte.' });
    } else if (discovery.accounts.some(a => a.network === row.network && !a.identityKnown && a.sessionPresent && !a.ip)) {
      Object.assign(row, { readOnly: true, state: 'unavailable', category: 'identity', message: 'Des sessions de ce réseau existent sans nom de profil. Il faut les identifier avant de lancer de nouvelles connexions, pour éviter un doublon.' });
    }
  }
  return result;
}
