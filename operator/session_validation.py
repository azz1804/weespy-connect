"""Embedded by the SSH program. No credentials returned in public receipts."""
import datetime, re, subprocess, uuid

class SessionFailure(Exception): pass

def valid_cookie(c,network,now):
    domains={'linkedin':('linkedin.com',),'x':('x.com','twitter.com'),'instagram':('instagram.com',)}[network]
    if not isinstance(c,dict): return False
    name,value,domain=c.get('name'),c.get('value'),c.get('domain')
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_\-]{1,128}',name): return False
    if not isinstance(value,str) or not value or len(value)>16384 or re.search(r'[\x00-\x1f\x7f]',value) or value.strip('"').lower()=='delete me': return False
    if not isinstance(domain,str) or not any(domain.lower().lstrip('.')==d or domain.lower().lstrip('.').endswith('.'+d) for d in domains): return False
    expiry=c.get('expires',-1)
    return c.get('session') is True or (isinstance(expiry,(int,float)) and not isinstance(expiry,bool) and math.isfinite(expiry) and (expiry==-1 or expiry>now))

def checked_session(s,proxy):
    network=s['network']; now=time.time()
    try:
        captured=datetime.datetime.fromisoformat(s['captured_at'].replace('Z','+00:00'))
        if captured.tzinfo is None or not -30 <= now-captured.timestamp() <= 300: raise ValueError()
    except Exception: raise SessionFailure('stale_capture')
    cookies=s.get('cookies')
    if not isinstance(cookies,list) or not 0<len(cookies)<=200: raise SessionFailure('missing_cookies')
    cookies=[c for c in cookies if valid_cookie(c,network,now)]
    required={'linkedin':('li_at','JSESSIONID'),'x':('auth_token','ct0'),'instagram':('sessionid',)}[network]
    if not all(any(c['name']==n for c in cookies) for n in required): raise SessionFailure('missing_cookies')
    # Do not persist caller-supplied success flags or unknown fields.
    clean={k:s[k] for k in ('network','index','label','isp_alias','isp_ip','captured_at')}
    clean['cookies']=cookies
    scope='browser_storage'
    if network=='linkedin':
        result=run_session_probe({'session':clean,'proxy':proxy})
        if result.get('failure'): raise SessionFailure(result['failure'])
        cookies=result.get('cookies',[])
        if result.get('scope')!='vps_identity' or not all(any(c.get('name')==n and valid_cookie(c,network,time.time()) for c in cookies) for n in required):
            raise SessionFailure('missing_cookies')
        clean['cookies']=cookies; scope='vps_identity'
    clean['verification']={'scope':scope,'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
    return clean

def run_session_probe(payload):
    # Never pull/install an image implicitly or fall back to a direct HTTP client.
    name='weespy-session-check-'+uuid.uuid4().hex
    runtime=['docker','run','--name',name,'--pull=never','--rm','-i','--cpus','0.5','--memory','256m','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/opt/radar-venv/bin/python','weespy-radar-firefox:local','-B','-c',SESSION_PROBE]
    try:
        result=subprocess.run(runtime,input=json.dumps(payload),text=True,capture_output=True,timeout=65)
        if result.returncode or len(result.stdout)>200000: return {'failure':'verification_unavailable'}
        data=json.loads(result.stdout)
        return data if isinstance(data,dict) else {'failure':'verification_unavailable'}
    except Exception: return {'failure':'verification_unavailable'}
    finally:
        # Killing a timed-out Docker client alone does not stop its container.
        try: subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=10)
        except Exception: pass
