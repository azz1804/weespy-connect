// Optional deployment smoke check: opens only about:blank, no account login.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
const proxy=JSON.parse(readFileSync('/job/proxy.json','utf8'));
const child=spawn('/opt/radar-venv/bin/python',['-B','/opt/operator/operator/vps/browser_bridge.py'],{stdio:['pipe','pipe','ignore'],uid:1000,gid:1000,env:{PATH:'/usr/local/bin:/usr/bin:/bin',PYTHONPATH:'/opt/operator/operator/vps',HOME:'/tmp/desktop'}});
let ready=false,closing=false;
function close(){if(closing)return;closing=true;child.stdin.write(JSON.stringify({id:1,method:'close'})+'\n');}
const monitor=setInterval(()=>{if(existsSync('/job/stop'))close();},500),deadline=setTimeout(close,180000);
child.on('error',()=>{writeFileSync('/job/result.json',JSON.stringify({ready:false,error:'launch'}));clearInterval(monitor);clearTimeout(deadline);});
child.on('exit',()=>{clearInterval(monitor);clearTimeout(deadline);});
child.stdin.on('error',()=>{});
createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);if(r.ready){ready=true;writeFileSync('/job/result.json',JSON.stringify({ready:true,ipVerified:r.ipVerified}));}else if(r.error){writeFileSync('/job/result.json',JSON.stringify({ready,error:r.error}));close();}}catch{close();}});
child.stdin.write(JSON.stringify({proxy,expected_ip:proxy.ip,network:'linkedin',label:'synthetic-smoke',login:'about:blank',page_step:'async function(){return {stage:"outside"}}'})+'\n');
