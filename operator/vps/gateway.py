"""One local CONNECT tunnel per identity, permanently bound to its upstream proxy.

Counts encrypted application bytes both ways for browser + collector traffic.
TCP/IP retransmissions and provider billing overhead are not observable here.
"""
import asyncio
import base64
import ssl
from urllib.parse import unquote, urlsplit

class Halt(Exception):
    """Stop this tunnel without exposing proxy credentials."""


class Gateway:
    def __init__(self, runtime, identity, *, idle_seconds=6):
        self.runtime = runtime
        self.identity = identity
        self.idle_seconds = idle_seconds
        self.upstream = urlsplit(runtime.proxies[identity])
        self.sent = self.received = 0
        self.writers = set()

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.handle, '127.0.0.1', 0, limit=32768)
        self.url = f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'
        return self

    async def __aexit__(self, *_):
        if hasattr(self, 'collector_http'):
            await self.collector_http.close()
        self.server.close()
        # Python 3.12 waits for active client transports too. Close the browser's
        # keep-alive tunnels first, otherwise STOP can wait on an idle browser.
        for writer in tuple(self.writers):
            writer.close()
        await asyncio.wait_for(self.server.wait_closed(), timeout=5)

    def count(self, direction, size):
        self.runtime.debit(direction, size)
        if direction == 'bytes_sent':
            self.sent += size
        else:
            self.received += size

    async def handle(self, reader, writer):
        remote = None
        self.writers.add(writer)
        try:
            self.runtime.check()
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 20)
            method, target, _ = header.split(b'\r\n', 1)[0].decode('ascii').split(' ', 2)
            if method != 'CONNECT' or not target.endswith(':443') or any(c in target for c in '\r\n /'):
                raise Halt('unsupported_proxy_request')
            parts = self.upstream
            # Port 443 and an explicit HTTPS scheme use TLS to the proxy.
            tls = ssl.create_default_context() if parts.scheme == 'https' or parts.port == 443 else None
            upstream_reader, remote = await asyncio.wait_for(
                asyncio.open_connection(parts.hostname, parts.port, ssl=tls), 30)
            self.writers.add(remote)
            authorization = base64.b64encode((unquote(parts.username or '') + ':' + unquote(parts.password or '')).encode()).decode()
            request = (f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n').encode()
            self.count('bytes_sent', len(request))
            remote.write(request)
            await remote.drain()
            answer = await asyncio.wait_for(upstream_reader.readuntil(b'\r\n\r\n'), 30)
            self.count('bytes_received', len(answer))
            status = int(answer.split(b' ', 2)[1])
            if status != 200:
                self.runtime.event('proxy_rejected', identity=self.identity, http_status=status)
                raise Halt('proxy_rejected')
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            loop = asyncio.get_running_loop()
            last_activity = loop.time()

            async def pump(source, destination, direction):
                nonlocal last_activity
                while True:
                    self.runtime.check()
                    # The upstream can silently stop forwarding an idle tunnel
                    # before the browser notices. Close our side first so the
                    # browser establishes a fresh CONNECT for its next request.
                    remaining = self.idle_seconds - (loop.time() - last_activity)
                    if remaining <= 0:
                        break
                    try:
                        chunk = await asyncio.wait_for(source.read(16384), min(remaining, 1))
                    except asyncio.TimeoutError:
                        continue
                    if not chunk:
                        break
                    last_activity = loop.time()
                    self.count(direction, len(chunk))
                    destination.write(chunk)
                    await destination.drain()

            tasks = [asyncio.create_task(pump(reader, remote, 'bytes_sent')),
                     asyncio.create_task(pump(upstream_reader, writer, 'bytes_received'))]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except Exception:
            # Do not expose upstream headers, URLs, credentials or exception text.
            if not writer.is_closing():
                writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
        finally:
            for stream in (remote, writer):
                if stream:
                    self.writers.discard(stream)
                    stream.close()
