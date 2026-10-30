import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { OperatorError } from '../connect.mjs';
import { sshTarget } from './model.mjs';

export async function openVpsView(target,signal){
  const t=sshTarget(target),server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const args=['-N','-T','-o','ControlPath=none','-o','ControlMaster=no','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','IPQoS=none','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-L',`127.0.0.1:${port}:127.0.0.1:16081`];
  if(t.port)args.push('-p',String(t.port));if(t.identity)args.push('-i',t.identity);args.push('--',t.host);
  const child=spawn('ssh',args,{stdio:'ignore'});let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
  const close=()=>{child.kill('SIGTERM');signal?.removeEventListener('abort',close);};signal?.addEventListener('abort',close,{once:true});
  try{
    for(let attempt=0;attempt<12;attempt++){
      signal?.throwIfAborted();if(failed)break;
      try{const r=await fetch(`http://127.0.0.1:${port}/vnc.html`,{signal:AbortSignal.timeout(2000)});if(r.ok)return {url:`http://127.0.0.1:${port}/vnc.html?autoconnect=true&resize=scale`,close};}catch{}
      await delay(250,undefined,{signal});
    }
    throw new OperatorError('Impossible d’ouvrir l’écran Firefox du VPS via SSH.');
  }catch(error){close();throw error;}
}
export async function connectOnVps({remote,target,row,signal,report,waitForUser,view=openVpsView,sleep=delay}){
  let job,screen,finished=false,previous='',answeredPrompt=null;
  try{
    let status=await remote.startJob(row,signal);job=status.jobId;
    if(!/^[a-f0-9]{32}$/.test(job||''))throw new OperatorError('Référence de connexion VPS invalide.');
    for(;;){
      signal.throwIfAborted();
      if(status.jobId!==job || !['checking','connecting','human','saving','saved','skipped','stopped','error'].includes(status.state))throw new OperatorError('État du navigateur VPS invalide.');
      if (typeof status.message!=='string' || status.message.length>1000 || !Array.isArray(status.actions||[]) || (status.actions||[]).some(a=>!['confirm','resume','skip'].includes(a))) throw new OperatorError('Réponse du moteur VPS invalide.');
      if (status.state==='saved' && (!Number.isFinite(Date.parse(status.capturedAt)) || !Number.isFinite(Date.parse(status.verifiedAt)) || status.verificationScope!==(row.network==='linkedin'?'vps_identity':'browser_storage'))) {
        const error=new OperatorError('La preuve de sauvegarde du VPS est incomplète. Recharge son état.'); error.category='vps'; error.fatal=true; throw error;
      }
      const signature=JSON.stringify([status.state,status.message,status.promptId,status.terminal]);
      if(signature!==previous){report(status.state,status.message,{category:status.category,ipVerified:status.ipVerified,verifiedAt:status.verifiedAt,verificationScope:status.verificationScope,capturedAt:status.capturedAt});previous=signature;}
      if(status.terminal){finished=true;if(status.state==='error'){const error=new OperatorError(status.message);error.category=status.category;error.fatal=status.category==='vps';throw error;}return status.state;}
      if(status.state==='human' && status.actions?.length && status.promptId!==answeredPrompt){
        if(!screen)screen=await view(target,signal);
        report('human',status.message,{category:status.category,browserUrl:screen.url});
        const action=await waitForUser(status.actions,signal);
        answeredPrompt=status.promptId;
        status=await remote.jobAction(job,action,status.promptId,signal);continue;
      }
      await sleep(1500,undefined,{signal});status=await remote.jobStatus(job,signal);
    }
  }finally{
    screen?.close();report('browser_closed','',{browserUrl:null});
    if(job&&!finished){try{await remote.jobAction(job,'stop',undefined,AbortSignal.timeout(10000));}catch{/* VPS has its own bounded deadline. */}}
  }
}
