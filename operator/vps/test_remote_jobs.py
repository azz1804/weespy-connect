import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import fcntl,hashlib,re

class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=self.temp.name
        self.inv=dict(accounts=[dict(network='linkedin',index=1,record=dict(profile='synthetic',password='PRIVATE',email='fake@example.test'))],proxies=[dict(ip='192.0.2.1',port=12323,username='private',password='PRIVATE')])
        self.bundle=root+'/inventory.json';Path(self.bundle).write_text(json.dumps(self.inv))
        self.ns=dict(root=root,bundle=self.bundle,os=os,json=json,stat=__import__('stat'),hashlib=hashlib,re=re,fcntl=fcntl,safe=lambda _:None,version=lambda:{'bundle':'v'},read=lambda p:Path(p).read_bytes() if Path(p).exists() else None,write=lambda p,v:Path(p).write_text(json.dumps(v)),existing_sessions=lambda:{'accounts':[],'warnings':[]})
        exec(Path(__file__).with_name('remote_jobs.py').read_text(),self.ns)
        self.request=dict(op='job_start',engine='vps-firefox-1',revision={'bundle':'v'},network='linkedin',index=1)
        self.started=False;self.commands=[]
        def run(args,**kwargs):
            self.commands.append(args)
            if args[:3]==['docker','image','inspect']:return SimpleNamespace(returncode=0,stdout='vps-firefox-1\n')
            self.started=True;return SimpleNamespace(returncode=0,stdout='container')
        self.run=run;self.ns['running']=lambda name:self.started and name==self.ns['CONTAINER']
    def start(self):
        with patch('os.path.isfile',return_value=True),patch('os.chown'),patch('subprocess.run',side_effect=self.run):return self.ns['job_request'](self.request)
    def test_start_pins_browser_to_vps_loopback_and_never_passes_secrets_on_command_line(self):
        result=self.start();self.assertEqual(result['state'],'checking')
        command=self.commands[-1];self.assertIn('127.0.0.1:16081:6080',command);self.assertNotIn('PRIVATE',' '.join(command));self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertIn('--pull=never',command);self.assertIn('--read-only',command)
    def test_second_start_attaches_same_job_instead_of_launching_again(self):
        first=self.start();second=self.start();self.assertEqual(first['jobId'],second['jobId']);self.assertEqual(len([c for c in self.commands if c[:2]==['docker','run']]),1)
    def test_finished_container_is_allowed_to_drain_before_next_job(self):
        first=self.start();path=self.ns['job_path'](first['jobId']);self.ns['write'](path+'/status.json',dict(state='saved',actions=[],terminal=True))
        checks=0
        def running(name):
            nonlocal checks
            if name!=self.ns['CONTAINER']:return False
            checks+=1;return checks<=2
        self.ns['running']=running
        with patch('time.sleep'):second=self.start()
        self.assertNotEqual(first['jobId'],second['jobId'])
        self.assertEqual(len([c for c in self.commands if c[:2]==['docker','run']]),2)
    def test_changed_inventory_and_unsafe_job_reference_are_rejected(self):
        self.request['revision']={'bundle':'changed'}
        with self.assertRaises(ValueError):self.start()
        with self.assertRaises(ValueError):self.ns['job_path']('../private')
    def test_old_human_prompt_cannot_resume_a_new_step(self):
        result=self.start();path=self.ns['job_path'](result['jobId']);self.ns['write'](path+'/status.json',dict(state='human',actions=['resume'],promptId=2,terminal=False))
        with self.assertRaises(ValueError):self.ns['job_request'](dict(op='job_action',jobId=result['jobId'],action='resume',promptId=1))
    def test_existing_service_account_prevents_duplicate_browser(self):
        self.ns['existing_sessions']=lambda:{'accounts':[dict(network='linkedin',identityKnown=True,label='synthetic',ip='192.0.2.1')],'warnings':[]}
        self.assertEqual(self.start(),{'failure':'existing_conflict'});self.assertFalse(self.started)

if __name__=='__main__':unittest.main()
