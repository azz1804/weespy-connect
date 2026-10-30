import asyncio, base64, unittest
from gateway import Gateway

class Runtime:
    def __init__(self, url): self.proxies={'account':url}; self.events=[]
    def check(self): pass
    def debit(self, direction, size): pass
    def event(self, name, **values): self.events.append(name)

class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_is_sent_only_upstream_and_tunnel_closes(self):
        requests=[]
        async def upstream(reader, writer):
            try:
                requests.append(await reader.readuntil(b'\r\n\r\n'))
                writer.write(b'HTTP/1.1 200 OK\r\n\r\n'); await writer.drain()
                writer.write(await reader.read(20)); await writer.drain()
            finally:
                writer.close(); await writer.wait_closed()
        server=await asyncio.start_server(upstream,'127.0.0.1',0)
        try:
            port=server.sockets[0].getsockname()[1]
            async with Gateway(Runtime(f'http://fake:synthetic@127.0.0.1:{port}'),'account') as gateway:
                local=int(gateway.url.rsplit(':',1)[1]);reader,writer=await asyncio.open_connection('127.0.0.1',local)
                writer.write(b'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\n\r\n');await writer.drain()
                answer=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),2)
                self.assertNotIn(b'synthetic',answer)
                self.assertIn(base64.b64encode(b'fake:synthetic'),requests[0])
                writer.write(b'hello');await writer.drain()
                self.assertEqual(await asyncio.wait_for(reader.readexactly(5),2),b'hello')
                writer.close();await writer.wait_closed()
        finally:server.close();await server.wait_closed()

    async def test_plain_http_is_rejected_without_credentials_in_error(self):
        async with Gateway(Runtime('http://fake:synthetic@127.0.0.1:1'),'account') as gateway:
            reader,writer=await asyncio.open_connection('127.0.0.1',int(gateway.url.rsplit(':',1)[1]))
            writer.write(b'GET / HTTP/1.1\r\nHost: example.test\r\n\r\n');await writer.drain()
            answer=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),2)
            self.assertIn(b'502',answer);self.assertNotIn(b'synthetic',answer)
            writer.close();await writer.wait_closed()
if __name__=='__main__':unittest.main()
