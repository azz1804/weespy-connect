"""Fixed LinkedIn identity probe. Private input/output stays inside the VPS.

Invoked in the existing Impit runtime; never log response bodies or exceptions.
"""
import asyncio, json, logging, sys, time
from http.cookiejar import Cookie
from urllib.parse import quote
logging.disable(logging.CRITICAL)


def public_ids(value):
    if isinstance(value, dict):
        if isinstance(value.get('publicIdentifier'), str):
            yield value['publicIdentifier'].lower()
        for child in value.values():
            yield from public_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from public_ids(child)


async def probe(data, client_factory=None, cookies_factory=None, sleep=asyncio.sleep):
    if client_factory is None:
        import impit
        client_factory, cookies_factory = impit.AsyncClient, impit.Cookies
    jar = cookies_factory()
    session, proxy = data['session'], data['proxy']
    for c in session['cookies']:
        domain = c['domain'].lower()
        if domain.lstrip('.') not in ('linkedin.com', 'www.linkedin.com'):
            continue
        jar.jar.set_cookie(Cookie(0,c['name'],c['value'],None,False,domain,True,domain.startswith('.'),c.get('path','/'),True,c.get('secure',True),None if c.get('session') or c.get('expires',-1)==-1 else int(c['expires']),False,None,None,{}))
    url = 'http://' + quote(proxy['username'],safe='') + ':' + quote(proxy['password'],safe='') + '@' + proxy['ip'] + ':' + str(proxy['port'])
    try:
        async with client_factory(proxy=url,browser='chrome',http3=False,verify=True,timeout=15,follow_redirects=False,cookies=jar) as client:
            response = await client.get('https://api.ipify.org?format=json')
            if response.status_code != 200 or len(response.content)>4096:
                return {'failure':'verification_unavailable'}
            if response.json().get('ip') != session['isp_ip']:
                return {'failure':'ip_mismatch'}
            for check in range(2):
                if check: await sleep(8)
                csrf = next((c.value for c in jar.jar if c.name=='JSESSIONID' and c.domain.lstrip('.') in ('linkedin.com','www.linkedin.com')), None)
                if not csrf: return {'failure':'missing_cookies'}
                response = await client.get('https://www.linkedin.com/voyager/api/me',headers={'csrf-token':csrf.strip('"'),'Accept':'application/vnd.linkedin.normalized+json+2.1','x-restli-protocol-version':'2.0.0'})
                if response.status_code == 429 or response.status_code >= 500: return {'failure':'verification_unavailable'}
                if response.status_code != 200: return {'failure':'session_rejected'}
                if len(response.content)>1048576: return {'failure':'verification_unavailable'}
                if session['label'].lower() not in set(public_ids(response.json())): return {'failure':'identity_mismatch'}
            updated = [dict(name=c.name,value=c.value,domain=c.domain,path=c.path,secure=c.secure,session=c.expires is None,expires=c.expires if c.expires is not None else -1) for c in jar.jar if c.domain.lstrip('.') in ('linkedin.com','www.linkedin.com') and not c.is_expired()]
            if not all(any(c['name']==n and c['value'] and c['value'].strip('"').lower()!='delete me' for c in updated) for n in ('li_at','JSESSIONID')):
                return {'failure':'missing_cookies'}
            return {'cookies':updated,'scope':'vps_identity'}
    except Exception:
        return {'failure':'verification_unavailable'}


if __name__ == '__main__':
    try: result = asyncio.run(probe(json.load(sys.stdin)))
    except Exception: result = {'failure':'verification_unavailable'}
    print(json.dumps(result))
