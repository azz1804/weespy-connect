// Entire connection engine runs in the VPS container. stdout/stderr never carry secrets.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { connectAccount, pageStep } from '../browser.mjs';
import { Remote, REMOTE } from '../remote.mjs';
import { NETWORKS, OperatorError, commandRunner } from '../../connect.mjs';

const config=JSON.parse(readFileSync('/job/config.json','utf8'));
const controller=new AbortController();let pending, prompt=0, state={state:'checking',message:'Préparation de Firefox sur le VPS…',actions:[],terminal:false};
function publish(patch){state={...state,...patch,updatedAt:new Date().toISOString()};writeFileSync('/job/status.tmp',JSON.stringify(state),{mode:0o600});renameSync('/job/status.tmp','/job/status.json');}
function problem(message,category='browser'){const error=new OperatorError(message);error.category=category;return error;}
const deadline=setTimeout(()=>controller.abort(),30*60*1000);
const controls=setInterval(()=>{
  try{if(!existsSync('/job/control.json'))return;const action=JSON.parse(readFileSync('/job/control.json','utf8'));unlinkSync('/job/control.json');
    if(action.action==='stop')controller.abort();
    else if(pending && action.promptId===state.promptId && state.actions.includes(action.action)){const resolve=pending;pending=null;publish({actions:[]});resolve(action.action);}
  }catch{/* Incomplete/invalid controls never authorize a transition. */}
},300);
async function open(_target,row,signal,report){
  let id=0,closed=false;const requests=new Map();let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const child=spawn('/opt/radar-venv/bin/python',['-B','/opt/operator/operator/vps/browser_bridge.py'],{stdio:['pipe','pipe','ignore'],uid:1000,gid:1000,env:{PATH:'/usr/local/bin:/usr/bin:/bin',PYTHONPATH:'/opt/operator/operator/vps',HOME:'/tmp/desktop'}});
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const rejectAll=()=>{const error=problem('Firefox sur le VPS ne répond plus.');readyReject(error);for(const item of requests.values())item.reject(error);requests.clear();};
  child.once('error',rejectAll);child.once('exit',rejectAll);child.stdin.on('error',rejectAll);
  createInterface({input:child.stdout}).on('line',line=>{try{
    if(line.length>500000)throw Error();const value=JSON.parse(line);
    if(value.ready){readyResolve();return;}
    if(!value.id){if(value.error==='ip')readyReject(problem('La sortie du VPS ne correspond pas à l’IP attribuée.','ip'));else rejectAll();return;}
    const request=requests.get(value.id);if(!request)return;requests.delete(value.id);value.error?request.reject(problem('Action Firefox impossible sur le VPS.')):request.resolve(value.value);
  }catch{rejectAll();}});
  const call=(method,extra={})=>new Promise((resolve,reject)=>{
    const current=++id;const timer=setTimeout(()=>{requests.delete(current);reject(problem('Firefox sur le VPS a dépassé le délai de réponse.'));},45000);
    requests.set(current,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    child.stdin.write(JSON.stringify({id:current,method,...extra})+'\n');
  });
  const close=async()=>{if(closed)return;closed=true;
    if(signal.aborted) child.kill('SIGTERM');
    try{if(child.exitCode===null)await call('close');}catch{}
    child.stdin.end();let timer;try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);}finally{clearTimeout(timer);}
    if(child.exitCode===null)child.kill('SIGTERM');
  };
  const onAbort=()=>readyReject(problem('Ouverture du navigateur annulée.'));signal.addEventListener('abort',onAbort,{once:true});
  try{
    child.stdin.write(JSON.stringify({proxy:row.upstream,expected_ip:row.isp_ip,network:row.network,label:row.label,login:NETWORKS[row.network].login,page_step:pageStep.toString()})+'\n');
    let timeout;try{await Promise.race([ready,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(problem('Ouverture de Firefox impossible sur le VPS.')),60000);})]);}finally{clearTimeout(timeout);signal.removeEventListener('abort',onAbort);}
    signal.throwIfAborted();report('connecting','Firefox ouvert sur le VPS. IP vérifiée.',{ipVerified:true});
    return {close,snapshot:()=>call('step'),submit:action=>call('step',{action}),cookies:()=>call('cookies'),restartLogin:()=>call('restart')};
  }catch(error){await close();throw error;}
}
const localProgram=REMOTE.replace('req=json.load(sys.stdin)',"def run_session_probe(payload):\n    import asyncio\n    from session_probe import probe\n    return asyncio.run(probe(payload))\nreq=json.load(sys.stdin)");
const remote=new Remote({host:'localhost'},(_command,_args,options)=>commandRunner('/opt/radar-venv/bin/python',['-B','-c',localProgram],{...options,timeout:100000}));
remote.revision=config.revision;
try{
  publish({network:config.row.network,index:config.row.index});
  await connectAccount({target:{host:'vps'},row:config.row,signal:controller.signal,open,
    report:(next,message,detail={})=>publish({state:next,message:message.replaceAll('Chrome','Firefox sur le VPS'),category:detail.category,ipVerified:state.ipVerified||!!detail.ipVerified,verifiedAt:detail.verifiedAt,verificationScope:detail.verificationScope,actions:[]}),
    waitForUser:(actions,signal)=>new Promise((resolve,reject)=>{
      const abort=()=>{pending=null;reject(problem('Connexion arrêtée sur le VPS.'));};
      pending=value=>{signal.removeEventListener('abort',abort);resolve(value);};signal.addEventListener('abort',abort,{once:true});
      publish({actions,promptId:++prompt});if(signal.aborted)abort();
    }),save:async session=>{const receipt=await remote.save(session,controller.signal);publish({capturedAt:receipt.captured_at});return receipt;}});
  publish({terminal:true,actions:[]});
}catch(error){publish({terminal:true,actions:[],state:controller.signal.aborted?'stopped':'error',category:error instanceof OperatorError?error.category||'browser':'browser',message:controller.signal.aborted?'Connexion arrêtée sur le VPS.':error instanceof OperatorError?error.message:'Erreur du navigateur sur le VPS ; aucun nouvel export confirmé.'});}
finally{clearInterval(controls);clearTimeout(deadline);try{unlinkSync('/job/config.json');}catch{}}
