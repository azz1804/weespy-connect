import unittest
from session_start import start_login_page

class Driver:
    def __init__(self, cookies=()): self.cookies = cookies; self.visits = []
    def get(self, url): self.visits.append(url)
    def get_cookies(self): return self.cookies

def cookie(name, domain='.x.com', value='SYNTHETIC'):
    return dict(name=name, domain=domain, value=value)

class SessionStartTests(unittest.TestCase):
    def test_existing_x_session_stays_on_home(self):
        d=Driver([cookie('auth_token'),cookie('ct0')])
        start_login_page(d,'x','https://x.com/i/flow/login')
        self.assertEqual(d.visits,['https://x.com/home'])
    def test_missing_empty_or_foreign_cookies_open_login(self):
        for cookies in [[],[cookie('auth_token')],[cookie('auth_token'),cookie('ct0',value='')],
                        [cookie('auth_token',domain='.example.test'),cookie('ct0')]]:
            with self.subTest(cookies=cookies):
                d=Driver(cookies);start_login_page(d,'x','https://x.com/i/flow/login')
                self.assertEqual(d.visits,['https://x.com/home','https://x.com/i/flow/login'])
    def test_other_network_does_not_visit_x(self):
        d=Driver();start_login_page(d,'linkedin','https://www.linkedin.com/login')
        self.assertEqual(d.visits,['https://www.linkedin.com/login'])
    def test_navigation_failure_is_not_retried(self):
        class Failing(Driver):
            def get(self,url): super().get(url);raise RuntimeError('network')
        d=Failing()
        with self.assertRaises(RuntimeError):start_login_page(d,'x','https://x.com/i/flow/login')
        self.assertEqual(d.visits,['https://x.com/home'])

if __name__=='__main__':unittest.main()
