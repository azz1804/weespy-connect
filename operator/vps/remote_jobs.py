"""Embedded in fixed SSH program; dispatches only bounded VPS jobs and metadata."""
import uuid,subprocess,time
ENGINE='vps-firefox-1'
SOURCE='/opt/weespy-connect-vps'
IMAGE='weespy-connect-firefox:v1'
CONTAINER='weespy-connect-automatic'
JOBS=root+'/operator-jobs'
def running(name):
    p=subprocess.run(['docker','inspect','--format','{{.State.Running}}',name],capture_output=True,text=True,timeout=10)
    return p.returncode==0 and p.stdout.strip()=='true'
def job_path(job):
    if not isinstance(job,str) or not re.fullmatch('[a-f0-9]{32}',job):raise ValueError('job')
    return JOBS+'/'+job

def job_public(job):
    path=job_path(job);s=json.loads(read(path+'/status.json'))
    if not s.get('terminal') and not running(CONTAINER):
        s.update(state='error',category='browser',message='Le navigateur du VPS s’est arrêté ; aucun nouvel export confirmé.',actions=[],terminal=True)
        write(path+'/status.json',s)
    allowed=('state','message','category','terminal','actions','promptId','ipVerified','verifiedAt','verificationScope','capturedAt','updatedAt','network','index')
    return {'jobId':job,**{k:s[k] for k in allowed if k in s}}

def job_request(req):
    safe(JOBS);os.makedirs(JOBS,mode=0o700,exist_ok=True)
    fd=os.open(JOBS+'/.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if req['op']=='job_start':
            if req.get('engine')!=ENGINE or not os.path.isfile(SOURCE+'/operator/vps/job.mjs'):return {'failure':'engine_unavailable'}
            if version()!=req['revision']:raise ValueError('changed')
            inv=json.loads(read(bundle));a=next((a for a in inv['accounts'] if a['network']==req.get('network') and a['index']==req.get('index')),None)
            if not a:raise ValueError('account')
            active=read(JOBS+'/active.json')
            if active and running(CONTAINER):
                active=json.loads(active);previous=job_public(active['jobId'])
                if previous.get('terminal'):
                    # A finished job may still be releasing its container/port.
                    until=time.monotonic()+8
                    while running(CONTAINER) and time.monotonic()<until:time.sleep(.25)
                    if running(CONTAINER):return {'failure':'engine_busy'}
                else:
                    if active['network']==a['network'] and active['index']==a['index'] and active['revision']==req['revision']:return previous
                    return {'failure':'engine_busy'}
            if running('weespy-connect-firefox'):return {'failure':'engine_busy'}
            checked=subprocess.run(['docker','image','inspect','--format','{{index .Config.Labels "weespy.operator.engine"}}',IMAGE],capture_output=True,text=True,timeout=10)
            if checked.returncode or checked.stdout.strip()!=ENGINE:return {'failure':'engine_unavailable'}
            p=inv['proxies'][a['index']-1];label=a['record'].get('profile') if a['network']=='linkedin' else a['record']['username']
            existing=existing_sessions()
            if existing['warnings']:return {'failure':'existing_conflict'}
            for old in existing['accounts']:
                if old['network']==a['network'] and (not old['identityKnown'] or old['label'].lower()==label.lower() or old['ip']==p['ip']):return {'failure':'existing_conflict'}
            job=uuid.uuid4().hex;path=job_path(job);os.mkdir(path,0o700)
            profile_key=hashlib.sha256(json.dumps([a['network'],label,p['ip']]).encode()).hexdigest()
            profile=root+'/vps-profiles/'+profile_key;safe(profile);os.makedirs(profile,mode=0o700,exist_ok=True);os.chown(profile,1000,1000)
            row=dict(network=a['network'],index=a['index'],label=label,record=a['record'],isp_alias='isp'+str(a['index']).zfill(2),isp_ip=p['ip'],upstream=p)
            write(path+'/config.json',dict(revision=req['revision'],row=row))
            write(path+'/status.json',dict(state='checking',message='Préparation de Firefox sur le VPS…',terminal=False,actions=[],network=a['network'],index=a['index']))
            args=['docker','run','--pull=never','-d','--rm','--name',CONTAINER,'--init','--cpus','1','--memory','3g','--shm-size','512m','--pids-limit','768','--read-only','--tmpfs','/tmp:rw,nosuid,size=256m','--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID','--security-opt','no-new-privileges','--user','0:0','--log-driver','none','-p','127.0.0.1:16081:6080','-e','PYTHONPATH=/opt/operator/operator','-v',SOURCE+':/opt/operator:ro','-v',root+':'+root,'-v',path+':/job','-v',profile+':/profile','--entrypoint','/usr/bin/node',IMAGE,'/opt/operator/operator/vps/job.mjs']
            # Persist the handle before dispatch, so an SSH timeout is recoverable.
            write(JOBS+'/active.json',dict(jobId=job,network=a['network'],index=a['index'],revision=req['revision']))
            launched=subprocess.run(args,capture_output=True,text=True,timeout=20)
            if launched.returncode:return {'failure':'engine_unavailable'}
            write(JOBS+'/active.json',dict(jobId=job,network=a['network'],index=a['index'],revision=req['revision']))
            return job_public(job)
        job=req.get('jobId');path=job_path(job);active=json.loads(read(JOBS+'/active.json') or b'{}')
        if active.get('jobId')!=job:raise ValueError('job')
        if req['op']=='job_action':
            state=job_public(job);action=req.get('action')
            if action!='stop' and (action not in state.get('actions',[]) or req.get('promptId')!=state.get('promptId')):raise ValueError('action')
            write(path+'/control.json',dict(action=action,promptId=req.get('promptId')))
        return job_public(job)
