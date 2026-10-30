import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  decodeBase32, totp, mapAccounts, ispAlias, sessionFile, filterCookies, hasSession,
  sessionPayload, saveCommand, saveSession, STATUS_COMMAND, listAndSelect, safeError,
  commandRunner, startForwarder, createProxyClient, probeIp, verifyExit, createClipboard, copyKey, prepareProfile,
  chromeArgs, launchChrome, waitForBrowserExit, readDebugger, connectCDP,
  captureCookies, runSelected, runOperator, terminalUI,
} from './connect.mjs';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const FAKE_SECRETS = ['FAKE_PASSWORD_DO_NOT_LOG', 'FAKE_EMAIL_PASSWORD_DO_NOT_LOG',
  'FAKE_PROXY_USER', 'FAKE_PROXY_PASSWORD', 'FAKE_COOKIE_DO_NOT_LOG', SECRET, '287082', '081804'];
function fixture() {
  const password = FAKE_SECRETS[0];
  const accounts = {
    x: Array.from({ length: 10 }, (_, i) => ({ username: `x-owner-${i + 1}`, password,
      email: `x${i + 1}@example.invalid`, email_password: FAKE_SECRETS[1] })),
    linkedin: Array.from({ length: 10 }, (_, i) => ({ email: `li${i + 1}@example.invalid`, password,
      profile: `https://www.linkedin.com/in/owner-${i + 1}/`, totp_secret: SECRET })),
    instagram: Array.from({ length: 10 }, (_, i) => ({ username: `ig-owner-${i + 1}`, password, totp_secret: SECRET })),
  };
  const proxies = { isp_fixed: { port: 12323, scheme: 'http', credential_groups: {
    A: { username: FAKE_SECRETS[2], password: FAKE_SECRETS[3] }, B: { username: FAKE_SECRETS[2], password: FAKE_SECRETS[3] },
  }, exits: Array.from({ length: 25 }, (_, i) => ({ alias: `isp${String(i + 1).padStart(2, '0')}`, ip: `192.0.2.${i + 1}`, group: i % 2 ? 'B' : 'A' })) } };
  return { accounts, proxies, rows: mapAccounts(accounts, proxies) };
}
const cookie = (name, domain, extra = {}) => ({ name, value: FAKE_SECRETS[4], domain, path: '/',
  expires: -1, size: 30, httpOnly: true, secure: true, session: true, sameSite: 'None',
  priority: 'Medium', sameParty: false, sourceScheme: 'Secure', sourcePort: 443, ...extra });
const noSecrets = value => assert.ok(FAKE_SECRETS.every(secret => !String(value).includes(secret)), 'La sortie doit rester expurgée.');
function fakeUI(keys = [], choice = 'li3') {
  return { lines: [], write(line) { this.lines.push(line); }, async select() { return choice; },
    async key() { if (!keys.length) throw new Error('Fake keys exhausted'); return keys.shift(); } };
}

test('TOTP SHA-1: RFC 6238, six chiffres, minuscules et espaces', () => {
  assert.ok(decodeBase32(SECRET).equals(Buffer.from('12345678901234567890')));
  assert.ok(decodeBase32('gez dgnbvgy3tqojq gezdgnbvgy3tqojq').equals(decodeBase32(SECRET)));
  assert.ok(totp(SECRET, 59).code === '287082');
  assert.equal(totp(SECRET, 59).remaining, 1);
  assert.ok(totp(SECRET, 1111111109).code === '081804');
  assert.equal(totp(SECRET, 60).remaining, 30);
  for (const value of ['', 'a!', 'A', 'ABC']) assert.throws(() => decodeBase32(value));
});

test('les 30 comptes suivent k → isp k, noms de fichier et schéma exact', () => {
  const { rows } = fixture();
  assert.equal(rows.length, 30);
  for (const row of rows) {
    assert.equal(row.isp_alias, ispAlias(row.index));
    assert.equal(row.isp_ip, `192.0.2.${row.index}`);
    assert.equal(sessionFile(row.network, row.index), `/etc/weespy/account-sessions/${row.network}-${row.index}.json`);
  }
  assert.equal(rows.find(r => r.key === 'li3').label, 'owner-3');
  assert.equal(rows.find(r => r.key === 'ig10').isp_alias, 'isp10');
  for (const invalid of [0, 26, '1', 1.5]) assert.throws(() => ispAlias(invalid));
  assert.throws(() => sessionFile('../tmp', 1));
  const full = cookie('li_at', '.linkedin.com', { partitionKey: { topLevelSite: 'https://linkedin.com', hasCrossSiteAncestor: false } });
  const payload = sessionPayload(rows.find(r => r.key === 'li3'), [full, cookie('other', '.example.com')], new Date('2026-10-28T00:00:00.000Z'));
  assert.deepEqual(Object.keys(payload), ['network', 'index', 'label', 'isp_alias', 'isp_ip', 'captured_at', 'cookies']);
  assert.equal(payload.captured_at, '2026-10-28T00:00:00.000Z');
  assert.ok(payload.cookies[0] === full, 'Tous les champs CDP doivent être conservés.');
  assert.equal(payload.cookies.length, 1);
});

test('inventaires incomplets, mauvais ports et IP ambiguës sont refusés', () => {
  const first = fixture(); first.accounts.x = [];
  assert.throws(() => mapAccounts(first.accounts, first.proxies));
  const second = fixture(); second.proxies.isp_fixed.exits.push(second.proxies.isp_fixed.exits[0]);
  assert.throws(() => mapAccounts(second.accounts, second.proxies));
  const third = fixture(); third.proxies.isp_fixed.scheme = 'https';
  assert.throws(() => mapAccounts(third.accounts, third.proxies));
  const fourth = fixture(); fourth.accounts.linkedin[0].profile = 'https://user:password@linkedin.com/in/slug';
  assert.throws(() => mapAccounts(fourth.accounts, fourth.proxies));
});

test('extension LinkedIn: 20 comptes, affectations historiques préservées et limites à 25', () => {
  const { accounts, proxies, rows: original } = fixture();
  accounts.linkedin.push(...Array.from({ length: 15 }, (_, i) => ({ email: `new${i + 11}@example.invalid`,
    password: FAKE_SECRETS[0], profile: `new-owner-${i + 11}`, totp_secret: SECRET })));
  const rows = mapAccounts(accounts, proxies);
  assert.equal(rows.length, 45);
  for (const before of original) {
    const after = rows.find(row => row.key === before.key);
    assert.equal(after.isp_alias, before.isp_alias); assert.equal(after.label, before.label);
  }
  for (let index = 11; index <= 25; index++) {
    const row = rows.find(row => row.key === `li${index}`);
    assert.equal(row.isp_alias, `isp${index}`);
    assert.equal(row.isp_ip, `192.0.2.${index}`);
    assert.equal(sessionFile(row.network, index), `/etc/weespy/account-sessions/linkedin-${index}.json`);
    assert.equal(sessionPayload(row, [cookie('li_at', '.linkedin.com')]).index, index);
  }
  accounts.linkedin.push(accounts.linkedin[0]);
  assert.throws(() => mapAccounts(accounts, proxies));
});

test('statut et sélection li20 avec inventaire étendu, sans fuite de secrets', async () => {
  const { accounts, proxies } = fixture();
  accounts.linkedin.push(...Array.from({ length: 10 }, (_, i) => ({ email: `new${i + 11}@example.invalid`,
    password: FAKE_SECRETS[0], profile: `new-owner-${i + 11}`, totp_secret: SECRET })));
  const run = async (_command, args) => {
    const command = args.at(-1);
    if (command.includes('sudo -n cat /etc/weespy/account-inventory/')) return { stdout: JSON.stringify(accounts) };
    if (command.includes('sudo -n cat /etc/weespy/proxy-inventory/')) return { stdout: JSON.stringify(proxies) };
    assert.equal(command, STATUS_COMMAND); assert.ok(command.includes('range(1, 26)'));
    return { stdout: JSON.stringify([{ network: 'linkedin', index: 20, isp_alias: 'isp20', captured_at: '2026-10-29T00:00:00.000Z' }]) };
  };
  const ui = fakeUI([], 'li20');
  const selected = await listAndSelect({ run, ui });
  assert.equal(selected.key, 'li20'); assert.equal(selected.isp_alias, 'isp20');
  assert.equal(ui.lines.length, 40); assert.equal(selected.captured_at, '2026-10-29T00:00:00.000Z');
  noSecrets(ui.lines.join('\n'));
});

test('filtres de domaine stricts, cookies requis et expiration', () => {
  const cookies = [cookie('li_at', '.linkedin.com'), cookie('pref', 'www.linkedin.com'),
    cookie('bad', '.evillinkedin.com'), cookie('bad', 'linkedin.com.evil.invalid'),
    cookie('auth_token', '.x.com'), cookie('ct0', '.twitter.com'), cookie('sessionid', '.instagram.com')];
  assert.equal(filterCookies('linkedin', cookies).length, 2);
  assert.equal(filterCookies('x', cookies).length, 2);
  assert.equal(filterCookies('instagram', cookies).length, 1);
  for (const network of ['linkedin', 'x', 'instagram']) assert.ok(hasSession(network, cookies));
  assert.ok(!hasSession('x', [cookie('auth_token', '.x.com')]));
  assert.ok(!hasSession('x', [cookie('auth_token', '.x.com.evil'), cookie('ct0', '.x.com')]));
  assert.ok(!hasSession('linkedin', [cookie('li_at', '.linkedin.com', { value: '' })]));
  assert.ok(!hasSession('linkedin', [cookie('li_at', '.linkedin.com', { session: false, expires: 123 })], 124));
  assert.throws(() => sessionPayload(fixture().rows[0], []));
});

test('listing et sélection avec SSH injecté: aucun secret dans stdout/stderr', async () => {
  const { accounts, proxies } = fixture();
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    assert.equal(command, 'ssh');
    assert.equal(args.at(-2), 'mon-vps');
    const last = args.at(-1);
    if (last === 'sudo -n cat /etc/weespy/account-inventory/accounts-20261028.json') return { stdout: JSON.stringify(accounts), stderr: FAKE_SECRETS[0] };
    if (last === 'sudo -n cat /etc/weespy/proxy-inventory/inventory-20261028.json') return { stdout: JSON.stringify(proxies), stderr: FAKE_SECRETS[3] };
    assert.equal(last, STATUS_COMMAND);
    return { stdout: JSON.stringify([{ network: 'linkedin', index: 3, isp_alias: 'isp03', captured_at: '2026-10-28T00:00:00.000Z' }]), stderr: FAKE_SECRETS[4] };
  };
  const ui = fakeUI();
  assert.equal((await listAndSelect({ run, ui })).key, 'li3');
  assert.equal(ui.lines.length, 30);
  assert.ok(ui.lines.some(line => line.includes('pas de session')));
  assert.ok(ui.lines.some(line => line.includes('2026-10-28T00:00:00.000Z')));
  noSecrets(ui.lines.join('\n')); noSecrets(JSON.stringify(calls));
  assert.ok(!ui.lines.join('\n').includes('@example.invalid'));
  const quit = fakeUI([], 'q');
  assert.equal(await listAndSelect({ run, ui: quit }), null);
  let stderr = '';
  try { await listAndSelect({ run: async () => { throw new Error(`https://${FAKE_SECRETS[2]}:${FAKE_SECRETS[3]}@fake.invalid`); }, ui }); }
  catch (error) { stderr += safeError(error); }
  noSecrets(stderr);
  assert.ok(stderr.includes('Échec SSH'));
  noSecrets(safeError(new SyntaxError(FAKE_SECRETS[0])));
  noSecrets(safeError(new Error(FAKE_SECRETS[4])));
});

test('runner: stderr ignoré et échec sans contenu ni commande', async () => {
  const value = await commandRunner(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("FAKE_PASSWORD_DO_NOT_LOG")']);
  assert.equal(value.stdout, 'ok');
  assert.equal(value.stderr, undefined);
  try { await commandRunner(process.execPath, ['-e', 'process.stderr.write("FAKE_PASSWORD_DO_NOT_LOG"); process.exit(1)']); assert.fail('expected failure'); }
  catch (error) { noSecrets(safeError(error)); }
});

test('envoi: JSON uniquement via stdin, permissions root et remplacement atomique', async () => {
  const row = fixture().rows.find(r => r.key === 'ig10');
  const payload = sessionPayload(row, [cookie('sessionid', '.instagram.com')]);
  let writes = 0;
  await saveSession(payload, async (command, args, options) => {
    writes++;
    assert.equal(command, 'ssh');
    assert.equal(args.at(-2), 'mon-vps');
    noSecrets(args.join(' '));
    const commandText = args.at(-1);
    assert.equal(commandText, saveCommand('instagram', 10));
    for (const part of ['umask 077', 'chmod 700', 'chmod 600', 'chown root:root', 'set -C', 'mv -fT']) assert.ok(commandText.includes(part));
    const parsed = JSON.parse(options.input);
    assert.ok(parsed.cookies[0].value === FAKE_SECRETS[4]);
    assert.equal(parsed.network, 'instagram');
    return { stdout: '', stderr: FAKE_SECRETS[4] };
  });
  assert.equal(writes, 1);
  assert.ok(!STATUS_COMMAND.includes('data[\'cookies\']'));
  assert.ok(STATUS_COMMAND.includes('rows.append(dict(network=network, index=index, isp_alias=alias, captured_at=captured))'));
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) throw new Error('Fake network timed out'); await delay(5); }
}

test('CONNECT: authentification exacte, réponse fragmentée et tunnel bidirectionnel', async t => {
  let header = '', received = '';
  const peers = new Set();
  const upstream = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {});
    let ready = false, pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      if (ready) { received += chunk; socket.write(`echo:${chunk}`); return; }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end === -1) return;
      header = pending.subarray(0, end + 4).toString(); ready = true;
      socket.write('HTTP/1.1 200 Connection');
      setTimeout(() => socket.write(' Established\r\nX-Fake: yes\r\n\r\nserver-hello'), 5);
    });
  });
  const port = await listen(upstream);
  const proxy = await startForwarder({ ip: '127.0.0.1', port, username: FAKE_SECRETS[2], password: FAKE_SECRETS[3] });
  const client = net.connect(proxy.port, '127.0.0.1'); client.on('error', () => {});
  let output = ''; client.on('data', chunk => { output += chunk; });
  t.after(async () => { client.destroy(); await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise(res => upstream.close(res)); });
  await once(client, 'connect');
  client.write('CONNECT site.invalid:443 HTTP/1.1\r\nHost: site.invalid:443\r\nProxy-Authorization: BAD\r\n\r\nfirst');
  await until(() => output.includes('echo:first'));
  const expected = `CONNECT site.invalid:443 HTTP/1.1\r\nHost: site.invalid:443\r\nProxy-Authorization: Basic ${Buffer.from(`${FAKE_SECRETS[2]}:${FAKE_SECRETS[3]}`).toString('base64')}\r\n\r\n`;
  assert.ok(header === expected, 'Le CONNECT amont doit utiliser exclusivement les identifiants attribués.');
  assert.ok(output.includes('server-hello'));
  client.write('second'); await until(() => output.includes('echo:second'));
  assert.equal(received, 'firstsecond');
  noSecrets(output);
  await proxy.close();
  await until(() => client.destroyed);
});

test('HTTP simple: URL absolue, corps et authentification remplacée', async t => {
  let observed;
  const upstream = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => { observed = { url: request.url, headers: request.headers, body }; response.end('fake-response'); });
  });
  const port = await listen(upstream);
  const proxy = await startForwarder({ ip: '127.0.0.1', port, username: FAKE_SECRETS[2], password: FAKE_SECRETS[3] });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(res => upstream.close(res)); });
  const result = await new Promise((res, rej) => {
    const request = http.request({ hostname: '127.0.0.1', port: proxy.port, method: 'POST', path: 'http://site.invalid/path?q=1',
      headers: { 'proxy-authorization': 'BAD', 'proxy-connection': 'keep-alive' }, agent: false }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => res(body));
    });
    request.on('error', rej); request.end('fake-body');
  });
  assert.equal(result, 'fake-response');
  assert.equal(observed.url, 'http://site.invalid/path?q=1');
  assert.equal(observed.body, 'fake-body');
  assert.equal(observed.headers.host, 'site.invalid');
  assert.ok(observed.headers['proxy-authorization'] === `Basic ${Buffer.from(`${FAKE_SECRETS[2]}:${FAKE_SECRETS[3]}`).toString('base64')}`);
  assert.equal(observed.headers['proxy-connection'], undefined);
});

test('CONNECT refusé: corps amont expurgé, fermeture et bind externe refusé', async t => {
  const peers = new Set();
  const upstream = net.createServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.once('data', () => socket.end(`HTTP/1.1 407 Nope\r\n\r\n${FAKE_SECRETS[3]}`)); });
  const port = await listen(upstream);
  const config = { ip: '127.0.0.1', port, username: FAKE_SECRETS[2], password: FAKE_SECRETS[3] };
  for (const host of ['0.0.0.0', '::', 'localhost', '192.0.2.1']) await assert.rejects(startForwarder(config, { host }));
  const proxy = await startForwarder(config);
  t.after(async () => { await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise(res => upstream.close(res)); });
  const result = await new Promise((res, rej) => {
    const client = net.connect(proxy.port, '127.0.0.1');
    let body = ''; client.on('data', chunk => { body += chunk; }); client.on('error', rej); client.on('close', () => res(body));
    client.on('connect', () => client.write('CONNECT site.invalid:443 HTTP/1.1\r\n\r\n'));
  });
  assert.ok(result.startsWith('HTTP/1.1 502')); noSecrets(result);
});

test('IP incorrecte: pas de succès affiché ni ouverture de Chrome', async () => {
  const row = fixture().rows[0];
  assert.equal(await verifyExit(row, 1234, async () => row.isp_ip), `sortie : ${row.isp_ip} ✓`);
  await assert.rejects(verifyExit(row, 1234, async () => '192.0.2.250'));
  let closed = 0, launched = 0, prepared = 0;
  const ui = fakeUI();
  await assert.rejects(runSelected(row, { ui, probe: async () => '192.0.2.250',
    makeForwarder: async () => ({ port: 1234, async close() { closed++; } }),
    profileFactory: async () => { prepared++; }, launch: () => { launched++; },
    clipboardFactory: () => ({ async close() {} }),
  }));
  assert.equal(closed, 1); assert.equal(launched, 0); assert.equal(prepared, 0);
  assert.equal(ui.lines.length, 0);
});

test('Impit: contrôle ipify, proxy explicite, TLS vérifié, HTTP/3 et redirections désactivés', async () => {
  let configured, request;
  class FakeImpit {
    constructor(options) { configured = options; }
    async fetch(url, options) {
      request = { url, options };
      return new Response('{"ip":"192.0.2.1"}');
    }
  }
  assert.equal(await probeIp(1234, { ImpitImpl: FakeImpit, timeout: 3000 }), '192.0.2.1');
  assert.deepEqual(configured, { browser: 'chrome', proxyUrl: 'http://127.0.0.1:1234',
    ignoreTlsErrors: false, vanillaFallback: false, http3: false, followRedirects: false, timeout: 3000 });
  assert.equal(request.url, 'https://api.ipify.org?format=json');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal.aborted, 'Les ressources de la requête sont annulées après lecture.');
  noSecrets(JSON.stringify(configured));
  await assert.rejects(createProxyClient(0, { ImpitImpl: FakeImpit }));
});

test('Impit: réponse incorrecte, volumineuse, erreur sensible et annulation arrêtent le contrôle', async () => {
  for (const response of [new Response('{}', { status: 302 }), new Response('invalid json'),
    new Response('{"ip":"invalid"}'), new Response(' '.repeat(4097))]) {
    class FakeImpit { async fetch() { return response; } }
    await assert.rejects(probeIp(1234, { ImpitImpl: FakeImpit }), /Vérification de sortie avec Impit impossible/);
  }
  class FailingImpit { async fetch() { throw new Error(FAKE_SECRETS[3]); } }
  try { await probeIp(1234, { ImpitImpl: FailingImpit }); assert.fail('expected failure'); }
  catch (error) { noSecrets(safeError(error)); }
  let called = false;
  class NeverImpit { constructor() { called = true; } }
  await assert.rejects(probeIp(1234, { ImpitImpl: NeverImpit, signal: AbortSignal.abort() }));
  assert.equal(called, false);
});

test('Impit: délai appliqué aussi pendant la lecture du corps', async () => {
  class SlowImpit {
    async fetch(_url, { signal }) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ip":'));
        signal.addEventListener('abort', () => controller.error(new Error('fake timeout')), { once: true });
      } }));
    }
  }
  await assert.rejects(probeIp(1234, { ImpitImpl: SlowImpit, timeout: 10 }), /Vérification de sortie avec Impit impossible/);
});

test('Impit natif installé: réponse via proxy factice et refus de redirection', async t => {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers['proxy-authorization'] });
    if (request.url.endsWith('/redirect')) response.writeHead(302, { location: 'https://must-not-contact.invalid/' }).end();
    else response.end('{"ip":"192.0.2.1"}');
  });
  const port = await listen(upstream);
  const proxy = await startForwarder({ ip: '127.0.0.1', port, username: 'fake', password: 'fake' });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(res => upstream.close(res)); });
  const client = await createProxyClient(proxy.port, { timeout: 2000 });
  const response = await client.fetch('http://probe.invalid/ip');
  assert.equal((await response.json()).ip, '192.0.2.1');
  const { Impit } = await import('impit');
  class LocalImpit extends Impit {
    fetch(url, options) {
      assert.equal(url, 'https://api.ipify.org?format=json');
      // Keep the production stream reader and native client; only the remote
      // service is replaced with the local HTTP fixture for this offline test.
      return super.fetch('http://probe.invalid/ip', options);
    }
  }
  assert.equal(await probeIp(proxy.port, { ImpitImpl: LocalImpit, timeout: 2000 }), '192.0.2.1');
  await assert.rejects(client.fetch('http://probe.invalid/redirect', { redirect: 'error' }));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'http://probe.invalid/ip');
  assert.ok(requests.every(request => request.auth === `Basic ${Buffer.from('fake:fake').toString('base64')}`));
});

test('Impit natif: ipify passe par CONNECT et échoue sans repli si le proxy refuse', async t => {
  const targets = [];
  const peers = new Set();
  const upstream = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {});
    socket.once('data', chunk => { targets.push(chunk.toString().split('\r\n')[0]); socket.end('HTTP/1.1 407 Refused\r\n\r\n'); });
  });
  const port = await listen(upstream);
  const proxy = await startForwarder({ ip: '127.0.0.1', port, username: 'fake', password: 'fake' });
  t.after(async () => { await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise(res => upstream.close(res)); });
  await assert.rejects(probeIp(proxy.port, { timeout: 2000 }), /Vérification de sortie avec Impit impossible/);
  assert.deepEqual(targets, ['CONNECT api.ipify.org:443 HTTP/1.1']);
});

test('presse-papiers: effacement conditionnel, renouvellement et fermeture', async () => {
  let content = '', copies = 0;
  const run = async (command, _args, options) => {
    if (command.endsWith('pbcopy')) { content = options.input; copies++; return { stdout: '' }; }
    assert.ok(command.endsWith('pbpaste')); return { stdout: content };
  };
  const clipboard = createClipboard(run, { ttl: 25 });
  await clipboard.copy(FAKE_SECRETS[0]);
  await delay(60); assert.equal(content, '');
  await clipboard.copy(FAKE_SECRETS[0]); content = 'owner-copy';
  await delay(60); assert.equal(content, 'owner-copy');
  await clipboard.copy(FAKE_SECRETS[0]); await clipboard.copy(FAKE_SECRETS[1]);
  await clipboard.close(); assert.equal(content, '');
  assert.equal(copies, 6);
});

test('touches: valeurs copiées uniquement, disponibilité et secondes TOTP', async () => {
  const { rows } = fixture();
  const ui = fakeUI(); const copied = [];
  const clipboard = { async copy(value) { copied.push(value); } };
  const x = rows[0];
  for (const key of ['u', 'p', 'e', 'm', 'c']) await copyKey(x, key, clipboard, ui, 59);
  assert.equal(copied.length, 4); assert.ok(copied[3] === FAKE_SECRETS[1]);
  const li = rows.find(r => r.key === 'li3');
  await copyKey(li, 'c', clipboard, ui, 59); assert.ok(copied.at(-1) === '287082');
  await copyKey(li, 'e', clipboard, ui, 59); assert.equal(copied.length, 5);
  assert.ok(ui.lines.includes('Code copié ; 1 s restantes.'));
  noSecrets(ui.lines.join('\n'));
});

test('profil privé, verrou exclusif et refus des liens symboliques', async t => {
  const home = await mkdtemp(join(tmpdir(), 'weespy-fake-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const row = fixture().rows[0];
  const profile = await prepareProfile(row, home);
  assert.equal(profile.path, join(home, 'WeespyAccounts/profiles/x-1'));
  for (const path of [join(home, 'WeespyAccounts'), join(home, 'WeespyAccounts/profiles'), profile.path]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  await assert.rejects(prepareProfile(row, home)); await profile.release();
  const again = await prepareProfile(row, home); await again.release();
  await symlink('/nonexistent-fake-chrome-lock', join(profile.path, 'SingletonLock'));
  await assert.rejects(prepareProfile(row, home));
  const badHome = join(home, 'bad'); await mkdir(badHome);
  await symlink(home, join(badHome, 'WeespyAccounts'));
  await assert.rejects(prepareProfile(row, badHome));
});

test('fenêtre manuelle sans CDP ni automatisation; capture du même profil', () => {
  for (const network of ['linkedin', 'x', 'instagram']) {
    const manual = chromeArgs('/fake/profile', 1234, network);
    assert.ok(manual.every(arg => !/remote-debugging|headless|automation/i.test(arg)));
    assert.ok(manual.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
    assert.ok(manual.includes('--proxy-bypass-list=<-loopback>'));
    const headless = chromeArgs('/fake/profile', 1234, network, true);
    assert.ok(headless.includes('--remote-debugging-port=0'));
    assert.ok(headless.includes('--headless=new'));
    assert.ok(headless.includes('--user-data-dir=/fake/profile'));
    assert.equal(headless.at(-1), 'about:blank');
    noSecrets(manual.join(' ')); noSecrets(headless.join(' '));
  }
});

test('processus Chrome simulé: stdout/stderr ignorés et arrêt après attente', async () => {
  let options; const signals = [];
  const child = new EventEmitter(); child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit('exit', 0)); };
  const browser = launchChrome(['--fake'], (_command, _args, config) => { options = config; return child; });
  assert.equal(options.stdio, 'ignore');
  await waitForBrowserExit(browser, 1);
  assert.deepEqual(signals, ['SIGTERM']); assert.ok(browser.ended);
  await browser.stop(); assert.equal(signals.length, 1);
});

test('DevTools: seulement le port local et le navigateur désigné', async () => {
  let fetched;
  const options = {
    read: async () => '12345\n/devtools/browser/fake-id\n',
    fetchImpl: async address => { fetched = address; return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/browser/fake-id' }) }; },
  };
  const address = await readDebugger('/fake/profile', { ended: false }, options);
  assert.equal(fetched, 'http://127.0.0.1:12345/json/version');
  assert.equal(address, 'ws://127.0.0.1:12345/devtools/browser/fake-id');
  for (const url of ['ws://evil.invalid:12345/devtools/browser/fake-id', 'ws://127.0.0.1:12345/devtools/page/fake-id', 'ws://127.0.0.1:12345/devtools/browser/other']) {
    await assert.rejects(readDebugger('/fake', { ended: false }, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: url }) }) }));
  }
});

test('CDP simulé: commandes limitées et aucune erreur distante affichée', async () => {
  const sent = [];
  class FakeSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) {
      const request = JSON.parse(text); sent.push(request.method);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id,
        ...(request.method === 'Storage.getCookies' ? { result: { cookies: [cookie('li_at', '.linkedin.com')] } } : { error: { message: FAKE_SECRETS[4] } }) }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const client = await connectCDP('ws://127.0.0.1/fake', { WebSocketImpl: FakeSocket });
  assert.equal((await client.call('Storage.getCookies')).cookies.length, 1);
  await assert.rejects(client.call('Runtime.evaluate'));
  try { await client.call('Browser.close'); } catch (error) { noSecrets(safeError(error)); }
  client.close();
  assert.deepEqual(sent, ['Storage.getCookies', 'Browser.close']);
});

test('capture simulée: supprime le port périmé, lit, ferme puis filtre', async () => {
  const events = [];
  const result = await captureCookies('/fake/profile', 1234, 'linkedin', {
    remove: async path => { assert.equal(path, '/fake/profile/DevToolsActivePort'); events.push('remove'); },
    launch: args => { assert.ok(args.includes('--user-data-dir=/fake/profile')); events.push('launch'); return { async wait() {}, async stop() { events.push('stop'); } }; },
    readEndpoint: async () => 'ws://127.0.0.1/fake',
    connect: async () => ({ async call(method) { events.push(method); return { cookies: [cookie('li_at', '.linkedin.com'), cookie('other', '.instagram.com')] }; }, close() { events.push('disconnect'); } }),
  });
  assert.equal(result.length, 1);
  assert.deepEqual(events, ['remove', 'launch', 'Storage.getCookies', 'Browser.close', 'disconnect', 'stop']);
});

test('capture: fermeture avant accusé CDP acceptée seulement après sortie du processus', async () => {
  for (const exited of [true, false]) {
    const capture = captureCookies('/fake', 1234, 'linkedin', {
      remove: async () => {},
      launch: () => ({ async wait() { return exited; }, async stop() {} }),
      readEndpoint: async () => 'ws://127.0.0.1/fake',
      connect: async () => ({ async call(method) {
        if (method === 'Browser.close') throw new Error(FAKE_SECRETS[4]);
        return { cookies: [cookie('li_at', '.linkedin.com')] };
      }, close() {} }),
    });
    if (exited) assert.equal((await capture).length, 1);
    else await assert.rejects(capture);
  }
});

function flow(keys = ['d'], cookies = [cookie('auth_token', '.x.com'), cookie('ct0', '.twitter.com')]) {
  const row = fixture().rows[0]; const events = []; const ui = fakeUI(keys);
  let sent;
  return { row, ui, events, get sent() { return sent; }, options: {
    ui, closeTimeout: 1, probe: async () => { events.push('probe'); return row.isp_ip; },
    makeForwarder: async () => { events.push('proxy'); return { port: 1234, async close() { events.push('proxy-close'); } }; },
    profileFactory: async () => { events.push('profile'); return { path: '/fake/profile', async release() { events.push('unlock'); } }; },
    launch: args => { events.push('visible'); assert.ok(!args.some(arg => arg.includes('remote-debugging'))); return {
      exited: new Promise(() => {}), async wait() { events.push('wait-close'); return false; }, async stop() { events.push('visible-stop'); },
    }; },
    capture: async () => { events.push('capture'); return cookies; },
    clipboardFactory: () => ({ async copy() { events.push('copy'); }, async close() { events.push('clipboard-close'); } }),
    run: async (command, args, options) => { assert.equal(command, 'ssh'); noSecrets(args.join(' ')); events.push('save'); sent = JSON.parse(options.input); return { stdout: '' }; },
  } };
}

test('parcours complet simulé: ordre, sauvegarde seulement après fermeture et statut', async () => {
  const f = flow(['u', 'p', 'd']); assert.equal(await runSelected(f.row, f.options), 'saved');
  assert.ok(f.events.indexOf('probe') < f.events.indexOf('visible'));
  assert.ok(f.events.indexOf('visible-stop') < f.events.indexOf('capture'));
  assert.ok(f.events.indexOf('proxy-close') < f.events.indexOf('save'));
  assert.equal(f.sent.cookies.length, 2);
  assert.ok(f.ui.lines.includes('session enregistrée : x #1 sur isp01 (2 cookies)'));
  assert.equal(f.events.at(-1), 'unlock'); noSecrets(f.ui.lines.join('\n'));
});

test('q: arrêt du navigateur/proxy, aucun export; cookie absent: aucun export', async () => {
  const quit = flow(['q']); assert.equal(await runSelected(quit.row, quit.options), 'quit');
  assert.ok(!quit.events.includes('capture')); assert.ok(!quit.events.includes('save'));
  assert.ok(quit.events.includes('visible-stop')); assert.ok(quit.events.includes('proxy-close'));
  const missing = flow(['d'], [cookie('ct0', '.x.com')]);
  await assert.rejects(runSelected(missing.row, missing.options), /Cookie de session absent/);
  assert.ok(!missing.events.includes('save')); assert.equal(missing.events.at(-1), 'unlock');
});

test('échec capture ou SSH: nettoyage assuré et sortie expurgée', async () => {
  for (const failure of ['capture', 'ssh']) {
    const f = flow();
    if (failure === 'capture') f.options.capture = async () => { throw new Error(FAKE_SECRETS[4]); };
    else f.options.run = async () => { throw new Error(FAKE_SECRETS[4]); };
    try { await runSelected(f.row, f.options); assert.fail('expected error'); } catch (error) { noSecrets(safeError(error)); }
    assert.ok(f.events.includes('visible-stop')); assert.ok(f.events.includes('proxy-close'));
    assert.ok(f.events.includes('clipboard-close')); assert.ok(f.events.includes('unlock'));
    assert.ok(!f.ui.lines.some(line => line.startsWith('session enregistrée')));
  }
});

test('plusieurs comptes: retour au menu et actualisation après chaque capture', async () => {
  const ui = fakeUI(); const rows = fixture().rows.slice(0, 2); const events = [];
  await runOperator({ ui,
    select: async () => { events.push('refresh'); return rows.shift() ?? null; },
    connect: async row => { events.push(row.key); return 'saved'; },
  });
  assert.deepEqual(events, ['refresh', 'x1', 'refresh', 'x2', 'refresh']);
  assert.equal(ui.lines.length, 2); noSecrets(ui.lines.join('\n'));
});

test('plusieurs comptes: q ou une erreur arrêtent sans lancer un autre compte', async () => {
  for (const outcome of ['quit', 'error']) {
    let selections = 0;
    const operation = runOperator({ ui: fakeUI(),
      select: async () => { selections++; return fixture().rows[0]; },
      connect: async () => { if (outcome === 'error') throw new Error('fake failure'); return 'quit'; },
    });
    if (outcome === 'error') await assert.rejects(operation); else await operation;
    assert.equal(selections, 1);
  }
});

test('terminal simulé: saisie non affichée, collage ignoré, mode restauré', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => {};
  let stdout = ''; const output = { isTTY: true, write: value => { stdout += value; } };
  const controller = new AbortController();
  const ui = terminalUI(controller.signal, input, output, () => controller.abort());
  const choice = ui.select('Compte'); input.emit('data', Buffer.from('li3\r')); assert.equal(await choice, 'li3');
  const key = ui.key(); input.emit('data', Buffer.from(FAKE_SECRETS[0])); input.emit('data', Buffer.from('p')); assert.equal(await key, 'p');
  noSecrets(stdout); assert.ok(!stdout.includes('li3'));
  input.emit('data', Buffer.from('\u0003')); assert.ok(controller.signal.aborted, 'Ctrl-C doit agir même entre les lectures.');
  ui.close(); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
});
