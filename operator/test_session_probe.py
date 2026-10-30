import asyncio,json,unittest
from http.cookiejar import CookieJar
from session_probe import probe

class Cookies:
    def __init__(self):self.jar=CookieJar()
class Response:
    def __init__(self,status,data):self.status_code=status;self.data=data;self.content=json.dumps(data).encode()
    def json(self):return self.data
class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def run_probe(self,responses,mutate=None):
        calls=[];options={};waits=[]
        class Client:
            def __init__(self,**kwargs):options.update(kwargs)
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def get(self,url,**kwargs):
                calls.append((url,kwargs))
                if mutate:mutate(options['cookies'].jar,len(calls))
                response=responses.pop(0)
                if isinstance(response,Exception):raise response
                return response
        async def sleep(seconds):waits.append(seconds)
        data={'session':{'label':'owner','isp_ip':'203.0.113.1','cookies':[dict(name=n,value='SYNTHETIC',domain='.linkedin.com',session=True) for n in ('li_at','JSESSIONID')]},'proxy':dict(ip='203.0.113.1',port=12323,username='fake',password='fake')}
        result=await probe(data,Client,Cookies,sleep)
        return result,calls,options,waits
    async def test_two_identity_checks_on_fixed_proxy_and_rotation_preserved(self):
        def rotate(jar,n):
            if n==3:
                for c in jar:
                    if c.name=='li_at':c.value='ROTATED_SYNTHETIC'
        r,c,o,w=await self.run_probe([Response(200,{'ip':'203.0.113.1'}),Response(200,{'publicIdentifier':'owner'}),Response(200,{'publicIdentifier':'owner'})],rotate)
        self.assertEqual(r['scope'],'vps_identity');self.assertEqual(w,[8]);self.assertEqual(len(c),3)
        self.assertIn('ROTATED_SYNTHETIC',[x['value'] for x in r['cookies']]);self.assertFalse(o['follow_redirects']);self.assertFalse(o['http3']);self.assertTrue(o['verify']);self.assertEqual(o['timeout'],15)
        self.assertIn('@203.0.113.1:12323',o['proxy'])
    async def test_cookie_rejected_on_second_check_cannot_succeed(self):
        r,*_=await self.run_probe([Response(200,{'ip':'203.0.113.1'}),Response(200,{'publicIdentifier':'owner'}),Response(302,{})])
        self.assertEqual(r,{'failure':'session_rejected'})
    async def test_ip_service_failure_is_not_reported_as_wrong_ip(self):
        r,c,*_=await self.run_probe([Response(503,{})]);self.assertEqual(r,{'failure':'verification_unavailable'});self.assertEqual(len(c),1)
    async def test_wrong_ip_stops_before_sending_linkedin_request(self):
        r,c,*_=await self.run_probe([Response(200,{'ip':'203.0.113.9'})]);self.assertEqual(r,{'failure':'ip_mismatch'});self.assertEqual(len(c),1)
    async def test_wrong_identity_and_network_errors_are_distinct_and_secret_free(self):
        r,*_=await self.run_probe([Response(200,{'ip':'203.0.113.1'}),Response(200,{'publicIdentifier':'other'})]);self.assertEqual(r,{'failure':'identity_mismatch'})
        r,*_=await self.run_probe([RuntimeError('SYNTHETIC_SECRET')]);self.assertEqual(r,{'failure':'verification_unavailable'})
    async def test_server_deleted_cookie_fails_even_with_identity_response(self):
        def remove(jar,n):
            if n==3:jar.clear()
        r,*_=await self.run_probe([Response(200,{'ip':'203.0.113.1'}),Response(200,{'publicIdentifier':'owner'}),Response(200,{'publicIdentifier':'owner'})],remove)
        self.assertEqual(r,{'failure':'missing_cookies'})
if __name__=='__main__':unittest.main()
