"""Private stdio bridge inside VPS container; no browser control port is published."""
import asyncio,json,logging,os,subprocess,sys,time
from pathlib import Path
from urllib.parse import quote,urlsplit
from gateway import Gateway
logging.disable(logging.CRITICAL)

class Runtime:
    def __init__(self,proxy):self.proxies={'account':proxy};self.until=time.monotonic()+1800;self.bytes=0
    def check(self):
        if time.monotonic()>self.until or self.bytes>100*1024*1024:raise RuntimeError('limit')
    def debit(self,direction,size):self.bytes+=size;self.check()
    def event(self,*args,**kwargs):pass

async def main():
    data=json.loads(await asyncio.to_thread(sys.stdin.readline));p=data['proxy'];driver=None;children=[]
    runtime=Runtime('http://'+quote(p['username'],safe='')+':'+quote(p['password'],safe='')+'@'+p['ip']+':'+str(p['port']))
    def spawn(args):
        child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);children.append(child);return child
    try:
        async with Gateway(runtime,'account',idle_seconds=20) as gateway:
            import impit
            async with impit.AsyncClient(proxy=gateway.url,browser='chrome',http3=False,verify=True,timeout=15,follow_redirects=False) as client:
                response=await client.get('https://api.ipify.org?format=json')
                if response.status_code!=200 or response.json().get('ip')!=data['expected_ip']:
                    print(json.dumps({'error':'ip'}),flush=True);return
            os.environ['DISPLAY']=':99';os.environ['HOME']='/tmp/desktop'
            for key,directory in [('HOME',''),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','run')]:
                path=Path('/tmp/desktop')/directory;path.mkdir(mode=0o700,parents=True,exist_ok=True);os.environ[key]=str(path)
            spawn(['Xvfb',':99','-screen','0','1360x900x24','-nolisten','tcp','-ac'])
            for _ in range(50):
                if Path('/tmp/.X11-unix/X99').exists():break
                await asyncio.sleep(.1)
            else:raise RuntimeError('display')
            spawn(['openbox']);spawn(['x11vnc','-display',':99','-localhost','-rfbport','5900','-nopw','-forever','-shared','-quiet'])
            spawn(['/usr/bin/websockify','--web=/usr/share/novnc','0.0.0.0:6080','127.0.0.1:5900'])
            from selenium import webdriver
            from selenium.webdriver.firefox.service import Service
            options=webdriver.FirefoxOptions();options.binary_location='/usr/bin/firefox-esr'
            options.add_argument('-profile');options.add_argument('/profile');options.add_argument('--no-remote')
            options.page_load_strategy='eager'
            proxy=urlsplit(gateway.url)
            prefs={'network.proxy.type':1,'network.proxy.http':proxy.hostname,'network.proxy.http_port':proxy.port,'network.proxy.ssl':proxy.hostname,'network.proxy.ssl_port':proxy.port,'network.proxy.no_proxies_on':'','network.proxy.failover_direct':False,'network.proxy.allow_hijacking_localhost':True,'network.trr.mode':5,'network.dns.disablePrefetch':True,'network.prefetch-next':False,'network.http.speculative-parallel-limit':0,'media.peerconnection.enabled':False,'browser.shell.checkDefaultBrowser':False,'browser.aboutwelcome.enabled':False,'signon.rememberSignons':False,'media.autoplay.default':5}
            Path('/profile/user.js').write_text(''.join('user_pref('+json.dumps(key)+', '+json.dumps(value)+');\n' for key,value in prefs.items()))
            for key,value in prefs.items():options.set_preference(key,value)
            driver=await asyncio.to_thread(webdriver.Firefox,options=options,service=Service(executable_path='/usr/local/bin/geckodriver',log_output=subprocess.DEVNULL))
            await asyncio.to_thread(driver.set_script_timeout,15);await asyncio.to_thread(driver.set_page_load_timeout,30)
            await asyncio.to_thread(driver.get,'https://api.ipify.org')
            browser_ip=await asyncio.to_thread(driver.execute_script,'return document.body.innerText;')
            if len(browser_ip)>4096 or browser_ip.strip()!=data['expected_ip']:
                print(json.dumps({'error':'ip'}),flush=True);return
            await asyncio.to_thread(driver.get,data['login'])
            print(json.dumps({'ready':True,'ipVerified':True}),flush=True)
            while True:
                line=await asyncio.to_thread(sys.stdin.readline)
                if not line:break
                request=json.loads(line);method=request['method'];value=None
                try:
                    if method=='step':
                        script='const done=arguments[arguments.length-1]; ('+data['page_step']+')(arguments[0],arguments[1],arguments[2]).then(done).catch(()=>done({stage:"script_error"}));'
                        value=await asyncio.to_thread(driver.execute_async_script,script,data['network'],data['label'],request.get('action'))
                    elif method=='cookies':
                        cookies=await asyncio.to_thread(driver.get_cookies)
                        value=[dict(name=c['name'],value=c['value'],domain=c['domain'],path=c.get('path','/'),secure=c.get('secure',True),httpOnly=c.get('httpOnly',False),expires=c.get('expiry',-1),session='expiry' not in c) for c in cookies]
                    elif method=='restart':await asyncio.to_thread(driver.get,data['login'])
                    elif method=='close':await asyncio.to_thread(driver.quit);driver=None
                    else:raise ValueError('method')
                    print(json.dumps({'id':request['id'],'value':value}),flush=True)
                    if method=='close':break
                except Exception:print(json.dumps({'id':request['id'],'error':'browser'}),flush=True)
    finally:
        if driver:
            try:await asyncio.to_thread(driver.quit)
            except Exception:pass
        for child in reversed(children):
            if child.poll() is None:child.terminate()
        for child in reversed(children):
            try:await asyncio.to_thread(child.wait,timeout=3)
            except subprocess.TimeoutExpired:child.kill()
if __name__=='__main__':
    try:asyncio.run(main())
    except BaseException:print(json.dumps({'error':'browser'}),flush=True)
