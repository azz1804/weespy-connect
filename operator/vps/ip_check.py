import asyncio,json,logging,sys
from urllib.parse import quote
logging.disable(logging.CRITICAL)
async def check(data):
    import impit
    p=data['proxy']
    url='http://'+quote(p['username'],safe='')+':'+quote(p['password'],safe='')+'@'+p['ip']+':'+str(p['port'])
    try:
        async with impit.AsyncClient(proxy=url,browser='chrome',http3=False,verify=True,timeout=15,follow_redirects=False) as client:
            r=await client.get('https://api.ipify.org?format=json')
            if r.status_code!=200 or len(r.content)>4096:return {'failure':'verification_unavailable'}
            return {'ok':True} if r.json().get('ip')==data['expected_ip'] else {'failure':'ip_mismatch'}
    except Exception:return {'failure':'verification_unavailable'}
if __name__=='__main__':
    try:result=asyncio.run(check(json.load(sys.stdin)))
    except Exception:result={'failure':'verification_unavailable'}
    print(json.dumps(result))
