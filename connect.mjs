#!/usr/bin/env node
// Node 26 + Impit. No login automation; no secret-bearing log output.
import { createHmac } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, chmod, lstat, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const NETWORKS = Object.freeze({
  x: { key: 'x', login: 'https://x.com/i/flow/login', domains: ['x.com', 'twitter.com'], required: ['auth_token', 'ct0'] },
  linkedin: { key: 'li', login: 'https://www.linkedin.com/login', domains: ['linkedin.com'], required: ['li_at'] },
  instagram: { key: 'ig', login: 'https://www.instagram.com/accounts/login/', domains: ['instagram.com'], required: ['sessionid'] },
});
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const SERVER_HOST = 'mon-vps';
export const MAX_ACCOUNTS_PER_NETWORK = 25;
const SESSION_DIR = '/etc/weespy/account-sessions';
const ACCOUNTS = '/etc/weespy/account-inventory/accounts-20261028.json';
const PROXIES = '/etc/weespy/proxy-inventory/inventory-20261028.json';
const SSH_ARGS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', SERVER_HOST];

// Only these controlled messages may reach the terminal. Never echo error.message,
// child stderr, JSON parse errors, CDP errors, URLs or command output on failure.
export class OperatorError extends Error {
  constructor(message) { super(message); this.name = 'OperatorError'; }
}
class BrowserStopError extends OperatorError {}
const fail = message => { throw new OperatorError(message); };
export function safeError(error) {
  if (error instanceof OperatorError) return `OperatorError : ${error.message}`;
  const type = error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError'
    : error?.name === 'AbortError' ? 'AbortError' : 'Error';
  return `${type} : opération interrompue ou impossible ; aucune donnée sensible affichée.`;
}
function textField(value) {
  if (typeof value !== 'string' || !value.length) fail('Inventaire incomplet ou invalide.');
  return value;
}
function publicLabel(network, record) {
  let value = textField(network === 'linkedin' ? record.profile : record.username);
  if (network === 'linkedin' && /^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { fail('Profil LinkedIn invalide.'); }
    if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password)
      fail('Profil LinkedIn invalide.');
    value = url.pathname.match(/^\/in\/([^/]+)\/?$/)?.[1];
  }
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.%@-]{1,160}$/u.test(value))
    fail('Libellé public invalide dans l’inventaire.');
  return value;
}
export function ispAlias(index) {
  if (!Number.isInteger(index) || index < 1 || index > MAX_ACCOUNTS_PER_NETWORK) fail('Numéro de compte invalide.');
  return `isp${String(index).padStart(2, '0')}`;
}
export function sessionFile(network, index) {
  if (!Object.hasOwn(NETWORKS, network)) fail('Réseau invalide.');
  ispAlias(index);
  return `${SESSION_DIR}/${network}-${index}.json`;
}
export function mapAccounts(accounts, proxies) {
  const fixed = proxies?.isp_fixed;
  if (fixed?.scheme !== 'http' || fixed.port !== 12323 || !Array.isArray(fixed.exits))
    fail('Inventaire des IP fixes invalide.');
  return Object.entries(NETWORKS).flatMap(([network, config]) => {
    if (!Array.isArray(accounts?.[network]) || accounts[network].length < 1 || accounts[network].length > MAX_ACCOUNTS_PER_NETWORK)
      fail('Il faut entre un et vingt-cinq comptes pour chaque réseau.');
    return accounts[network].map((record, offset) => {
      const index = offset + 1;
      const alias = ispAlias(index);
      const matches = fixed.exits.filter(exit => exit.alias === alias);
      if (matches.length !== 1 || net.isIP(matches[0].ip) !== 4) fail('IP fixe absente ou invalide.');
      const exit = matches[0];
      const credentials = fixed.credential_groups?.[exit.group];
      const username = textField(credentials?.username);
      const password = textField(credentials?.password);
      if (username.includes(':') || /[\r\n]/.test(username + password)) fail('Identifiants proxy invalides.');
      textField(record?.password);
      textField(network === 'linkedin' ? record?.email : record?.username);
      if (network === 'x') { textField(record.email); textField(record.email_password); }
      if (record.totp_secret) decodeBase32(record.totp_secret);
      return { network, index, label: publicLabel(network, record), key: `${config.key}${index}`,
        isp_alias: alias, isp_ip: exit.ip, record,
        upstream: { ip: exit.ip, port: fixed.port, username, password } };
    });
  });
}

export function decodeBase32(secret) {
  const input = textField(secret).replace(/\s/g, '').toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(input)) fail('Secret TOTP invalide.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const char of input) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
  }
  if (!bytes.length || accumulator !== 0 || bits >= 5) fail('Secret TOTP invalide.');
  return Buffer.from(bytes);
}
export function totp(secret, seconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) fail('Horloge invalide.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const key = decodeBase32(secret);
  const digest = createHmac('sha1', key).update(counter).digest();
  key.fill(0);
  const offset = digest.at(-1) & 15;
  return { code: String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'),
    remaining: 30 - seconds % 30 };
}

// All subprocesses use pipes or ignored output, never shell interpolation of data.
export function commandRunner(command, args, { input = '', signal, timeout = 30_000, maxBytes = 8_000_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], signal }); }
    catch { reject(new OperatorError('Commande locale ou SSH impossible.')); return; }
    const chunks = [];
    let size = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { failed = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new OperatorError('Commande locale ou SSH impossible.'));
      else resolvePromise({ stdout: Buffer.concat(chunks).toString('utf8') });
      for (const chunk of chunks) chunk.fill(0);
    });
    child.stdin.end(input);
  });
}
export const STATUS_COMMAND = `sudo -n python3 - <<'PY'
import json, os, re, stat
root = '${SESSION_DIR}'
rows = []
if os.path.islink(root):
    raise SystemExit(1)
for network in ('x', 'linkedin', 'instagram'):
    for index in range(1, ${MAX_ACCOUNTS_PER_NETWORK + 1}):
        path = f'{root}/{network}-{index}.json'
        if not os.path.lexists(path):
            continue
        if os.path.islink(path) or not stat.S_ISREG(os.stat(path).st_mode):
            raise SystemExit(1)
        with open(path) as f:
            data = json.load(f)
        alias = data.get('isp_alias')
        captured = data.get('captured_at')
        if (data.get('network') != network or data.get('index') != index
            or not isinstance(alias, str) or not re.fullmatch(r'isp(?:0[1-9]|1[0-9]|2[0-5])', alias)
            or not isinstance(captured, str)
            or not re.fullmatch(r'\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z', captured)):
            raise SystemExit(1)
        rows.append(dict(network=network, index=index, isp_alias=alias, captured_at=captured))
print(json.dumps(rows))
PY`;
async function ssh(run, command, options = {}) {
  try { return await run('ssh', [...SSH_ARGS, command], options); }
  catch { fail('Échec SSH ; vérifier l’accès au serveur et sudo sans mot de passe.'); }
}
export async function loadInventory(run = commandRunner, signal) {
  const accounts = JSON.parse((await ssh(run, `sudo -n cat ${ACCOUNTS}`, { signal })).stdout);
  const proxies = JSON.parse((await ssh(run, `sudo -n cat ${PROXIES}`, { signal })).stdout);
  const rows = mapAccounts(accounts, proxies);
  const statuses = JSON.parse((await ssh(run, STATUS_COMMAND, { signal })).stdout);
  if (!Array.isArray(statuses)) fail('État des sessions invalide.');
  for (const status of statuses) {
    const row = rows.find(r => r.network === status.network && r.index === status.index);
    if (!row || status.isp_alias !== row.isp_alias || typeof status.captured_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(status.captured_at)
        || !Number.isFinite(Date.parse(status.captured_at))) fail('État des sessions invalide ou IP réaffectée.');
    row.captured_at = status.captured_at;
  }
  return rows;
}
export async function listAndSelect({ run = commandRunner, ui, signal }) {
  const rows = await loadInventory(run, signal);
  for (const row of rows) ui.write(`${row.key.padEnd(4)} ${row.network} #${row.index} — ${row.label} — ${row.isp_alias} ${row.isp_ip} — ${row.captured_at ?? 'pas de session'}`);
  while (true) {
    const choice = (await ui.select('Compte (li11, x1, ig10 ; q pour quitter) : ')).trim().toLowerCase();
    if (choice === 'q') return null;
    const row = rows.find(item => item.key === choice);
    if (row) return row;
    ui.write('Choix invalide.');
  }
}

function cleanHeaders(headers) {
  const blocked = new Set(['proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']);
  for (const name of String(headers.connection ?? '').toLowerCase().split(',')) blocked.add(name.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}
export async function startForwarder(upstream, { host = '127.0.0.1', port = 0 } = {}) {
  if (host !== '127.0.0.1') fail('Le proxy local doit écouter uniquement sur 127.0.0.1.');
  if (!net.isIP(upstream.ip) || !Number.isInteger(upstream.port) || upstream.port < 1 || upstream.port > 65535)
    fail('Adresse du proxy amont invalide.');
  const authorization = `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}`;
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer({ maxHeaderSize: 32_768 }, (request, response) => {
    let destination;
    try { destination = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (destination.protocol !== 'http:' || destination.username || destination.password) { response.writeHead(400).end(); return; }
    const headers = { ...cleanHeaders(request.headers), host: destination.host, 'proxy-authorization': authorization };
    const remote = http.request({ hostname: upstream.ip, port: upstream.port, method: request.method,
      path: destination.href, headers, agent: false }, incoming => {
      // Never relay upstream proxy authentication errors or bodies (they may echo credentials).
      if (incoming.statusCode === 407) { incoming.destroy(); response.writeHead(502).end(); return; }
      response.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    remote.on('socket', track);
    remote.setTimeout(30_000, () => remote.destroy());
    remote.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => remote.destroy());
    request.on('error', () => remote.destroy());
    response.on('close', () => remote.destroy());
    request.pipe(remote);
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (request, client, head) => {
    // An authority only: no URL, credentials, CRLF or arbitrary CONNECT headers.
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$/.test(request.url)) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const targetPort = Number(request.url.slice(request.url.lastIndexOf(':') + 1));
    if (targetPort < 1 || targetPort > 65535) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const remote = track(net.createConnection({ host: upstream.ip, port: upstream.port }));
    let pending = Buffer.alloc(0), established = false;
    const rejectTunnel = () => {
      if (!established && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
      remote.destroy();
    };
    remote.setTimeout(15_000, rejectTunnel);
    remote.on('error', rejectTunnel);
    client.on('error', () => remote.destroy());
    client.on('close', () => remote.destroy());
    remote.on('close', () => { if (established) client.destroy(); else rejectTunnel(); });
    remote.once('connect', () => remote.write(`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\nProxy-Authorization: ${authorization}\r\n\r\n`));
    const onData = chunk => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end === -1) { if (pending.length > 32_768) rejectTunnel(); return; }
      if (end > 32_768 || !/^HTTP\/1\.[01] 200(?: |\r\n)/.test(pending.subarray(0, end + 2).toString('latin1'))) { rejectTunnel(); return; }
      established = true;
      remote.setTimeout(0);
      remote.removeListener('data', onData);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (pending.length > end + 4) client.write(pending.subarray(end + 4));
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
      pending = null;
    };
    remote.on('data', onData);
  });
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => { server.removeListener('error', rej); res(); });
  });
  // Failures after listen are handled without printing objects or secret-bearing messages.
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  return { port: server.address().port, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(res => server.close(res));
  } };
}

// Impit always uses the local forwarder, which alone holds proxy credentials.
// HTTP/3 is disabled because Impit does not support proxies with HTTP/3.
export async function createProxyClient(port, { timeout = 15_000, ImpitImpl } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Port du proxy local invalide.');
  if (!Number.isInteger(timeout) || timeout < 1) fail('Délai HTTP invalide.');
  if (!ImpitImpl) {
    try { ({ Impit: ImpitImpl } = await import('impit')); }
    catch { fail('Impit indisponible ; exécuter npm ci dans le dossier de l’outil.'); }
  }
  return new ImpitImpl({ browser: 'chrome', proxyUrl: `http://127.0.0.1:${port}`,
    ignoreTlsErrors: false, vanillaFallback: false, http3: false, followRedirects: false, timeout });
}
export async function probeIp(port, { signal, timeout = 15_000, ImpitImpl } = {}) {
  let reader;
  const controller = new AbortController();
  const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    bounded.throwIfAborted();
    const client = await createProxyClient(port, { timeout, ImpitImpl });
    bounded.throwIfAborted();
    const response = await client.fetch('https://api.ipify.org?format=json', { signal: bounded, redirect: 'error' });
    if (response.status !== 200) fail('Réponse de contrôle IP invalide.');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      bounded.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) fail('Réponse de contrôle IP trop volumineuse.');
      chunks.push(Buffer.from(value));
    }
    const ip = JSON.parse(Buffer.concat(chunks).toString('utf8')).ip;
    if (typeof ip !== 'string' || !net.isIP(ip)) fail('Adresse IP reçue invalide.');
    return ip;
  } catch (error) {
    if (error instanceof OperatorError && error.message.startsWith('Impit indisponible')) throw error;
    fail('Vérification de sortie avec Impit impossible ; Chrome ne sera pas ouvert.');
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { await reader?.cancel(); } catch { /* Already aborted or consumed. */ }
    reader?.releaseLock();
  }
}
export async function verifyExit(row, port, probe = probeIp, signal) {
  const actual = await probe(port, { signal });
  if (actual !== row.isp_ip) fail('L’IP de sortie ne correspond pas à l’IP attribuée ; arrêt avant Chrome.');
  return `sortie : ${row.isp_ip} ✓`;
}

export function filterCookies(network, cookies) {
  const config = NETWORKS[network];
  if (!config || !Array.isArray(cookies)) fail('Réponse cookies invalide.');
  return cookies.filter(cookie => typeof cookie?.domain === 'string' && config.domains.some(domain => {
    const host = cookie.domain.toLowerCase().replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  }));
}
export function hasSession(network, cookies, nowSeconds = Date.now() / 1000, required = NETWORKS[network].required) {
  return required.every(name => filterCookies(network, cookies).some(cookie =>
    cookie.name === name && typeof cookie.value === 'string' && cookie.value.length > 0 && !/[\x00-\x1f\x7f]/.test(cookie.value) && cookie.value.replaceAll('"', '').toLowerCase() !== 'delete me'
    && (cookie.session === true || cookie.expires === undefined || cookie.expires === -1 || (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires > nowSeconds))));
}
export function sessionPayload(row, cookies, now = new Date()) {
  sessionFile(row.network, row.index);
  const filtered = filterCookies(row.network, cookies);
  if (!hasSession(row.network, filtered, now.getTime() / 1000)) fail('Cookie de session absent ou expiré ; rien n’a été enregistré.');
  return { network: row.network, index: row.index, label: row.label, isp_alias: row.isp_alias,
    isp_ip: row.isp_ip, captured_at: now.toISOString(), cookies: filtered };
}
export function saveCommand(network, index) {
  const file = sessionFile(network, index);
  // Fixed, validated paths only. noclobber rejects stale/concurrent .tmp files.
  return `sudo -n sh -c 'set -eu; umask 077; test ! -L ${SESSION_DIR}; mkdir -p ${SESSION_DIR}; chown root:root ${SESSION_DIR}; chmod 700 ${SESSION_DIR}; test ! -L ${file}; set -C; cat > ${file}.tmp; chmod 600 ${file}.tmp; chown root:root ${file}.tmp; mv -fT ${file}.tmp ${file}'`;
}
export async function saveSession(payload, run = commandRunner, signal) {
  await ssh(run, saveCommand(payload.network, payload.index), { input: JSON.stringify(payload), signal });
}

export function createClipboard(run = commandRunner, { ttl = 45_000, onError = () => {} } = {}) {
  let current, timer, queue = Promise.resolve();
  const serial = job => { const result = queue.then(job); queue = result.catch(() => {}); return result; };
  const clear = async () => {
    if (current === undefined) return;
    if ((await run('/usr/bin/pbpaste', [])).stdout === current) await run('/usr/bin/pbcopy', [], { input: '' });
    current = undefined;
  };
  return {
    copy(value) { return serial(async () => {
      clearTimeout(timer);
      await run('/usr/bin/pbcopy', [], { input: value });
      current = value;
      timer = setTimeout(() => serial(clear).catch(() => onError(new OperatorError('Effacement du presse-papiers impossible.'))), ttl);
      timer.unref?.();
    }); },
    close() { clearTimeout(timer); return serial(clear); },
  };
}
export async function copyKey(row, key, clipboard, ui, seconds) {
  let value;
  if (key === 'u') value = row.network === 'linkedin' ? row.record.email : row.record.username;
  else if (key === 'p') value = row.record.password;
  else if (key === 'c' && row.record.totp_secret) {
    const result = totp(row.record.totp_secret, seconds);
    await clipboard.copy(result.code);
    ui.write(`Code copié ; ${result.remaining} s restantes.`);
    return;
  } else if (key === 'e' && row.network === 'x') value = row.record.email;
  else if (key === 'm' && row.network === 'x') value = row.record.email_password;
  else { ui.write('Touche indisponible pour ce compte.'); return; }
  await clipboard.copy(value);
  ui.write('Copié ; effacement sous 45 s si le contenu n’a pas changé.');
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid()) fail('Dossier de profil non sûr.');
  await chmod(path, 0o700);
}
export async function prepareProfile(row, home = homedir()) {
  sessionFile(row.network, row.index);
  const base = join(home, 'WeespyAccounts');
  const profiles = join(base, 'profiles');
  const profile = join(profiles, `${row.network}-${row.index}`);
  for (const path of [base, profiles, profile]) await privateDirectory(path);
  const lock = join(profile, '.weespy-operator-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { fail('Ce profil est déjà utilisé (ou verrou après une interruption).'); }
  try {
    let singleton = false;
    try { await lstat(join(profile, 'SingletonLock')); singleton = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (singleton) fail('Fermer le Chrome déjà associé à ce profil avant de recommencer.');
    return { path: profile, release: () => rm(lock, { recursive: true, force: true }) };
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
}
export function chromeArgs(profile, port, network, headless = false) {
  const args = [`--user-data-dir=${profile}`, `--proxy-server=http://127.0.0.1:${port}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-first-run', '--no-default-browser-check',
    '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--disable-quic', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-breakpad', '--disable-logging'];
  if (headless) args.push('--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank');
  else args.push('--new-window', NETWORKS[network].login);
  return args;
}
export function launchChrome(args, spawnImpl = spawn) {
  const child = spawnImpl(CHROME, args, { stdio: 'ignore' });
  let ended = false, failed = false;
  const exited = new Promise(res => {
    child.once('error', () => { failed = true; ended = true; res(); });
    child.once('exit', () => { ended = true; res(); });
  });
  const wait = async ms => {
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise(res => { timer = setTimeout(() => res(false), ms); })]); }
    finally { clearTimeout(timer); }
  };
  return { exited, get ended() { return ended; }, get failed() { return failed; }, wait,
    async stop() {
      if (!ended) { child.kill('SIGTERM'); if (!await wait(5000)) { child.kill('SIGKILL'); if (!await wait(5000)) throw new BrowserStopError('Chrome n’a pas pu être arrêté ; verrou du profil conservé.'); } }
    },
  };
}
export async function waitForBrowserExit(browser, timeout = 60_000, signal) {
  let abort;
  try {
    const interrupted = new Promise((_res, rej) => {
      abort = () => rej(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (!await Promise.race([browser.wait(timeout), interrupted])) await browser.stop();
  } finally { signal?.removeEventListener('abort', abort); }
}

export async function readDebugger(profile, browser, { signal, fetchImpl = fetch, read = readFile, timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (browser.ended) fail('Chrome de capture s’est arrêté avant la lecture.');
    let contents;
    try { contents = await read(join(profile, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contents) {
      const [portText, path] = contents.trim().split(/\r?\n/);
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) fail('Port de capture invalide.');
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) fail('Chrome de capture indisponible.');
      const address = new URL((await response.json()).webSocketDebuggerUrl);
      if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || address.port !== portText
        || address.pathname !== path || address.username || address.password || address.search || address.hash)
        fail('Adresse de capture non locale ou invalide.');
      return address.href;
    }
    await delay(100, undefined, { signal });
  }
  fail('Délai dépassé pour le démarrage de Chrome de capture.');
}
export async function connectCDP(address, { WebSocketImpl = WebSocket, signal, timeout = 10_000 } = {}) {
  const socket = new WebSocketImpl(address);
  const pending = new Map();
  let sequence = 0;
  const rejectAll = () => { for (const entry of pending.values()) entry.reject(new OperatorError('Connexion de capture interrompue.')); pending.clear(); };
  const abort = () => { rejectAll(); socket.close(); };
  socket.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(event.data); } catch { rejectAll(); return; }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new OperatorError('Lecture de session refusée par Chrome.'));
    else entry.resolve(data.result);
  });
  socket.addEventListener('error', rejectAll);
  socket.addEventListener('close', rejectAll);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => done(new OperatorError('Délai de connexion à Chrome dépassé.')), timeout);
      const opened = () => done();
      const broken = () => done(new OperatorError('Connexion à Chrome impossible.'));
      const done = error => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened); socket.removeEventListener('error', broken); socket.removeEventListener('close', broken);
        signal?.removeEventListener('abort', broken);
        error ? rej(error) : res();
      };
      socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', broken, { once: true }); socket.addEventListener('close', broken, { once: true });
      signal?.addEventListener('abort', broken, { once: true });
      if (signal?.aborted) broken();
    });
  } catch (error) { signal?.removeEventListener('abort', abort); socket.close(); throw error; }
  return {
    call(method) {
      // No arbitrary page/input/runtime commands can reach a browser.
      if (!['Storage.getCookies', 'Browser.close'].includes(method)) return Promise.reject(new OperatorError('Commande de capture interdite.'));
      return new Promise((res, rej) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); rej(new OperatorError('Délai de lecture de Chrome dépassé.')); }, timeout);
        const finish = callback => value => { clearTimeout(timer); callback(value); };
        pending.set(id, { resolve: finish(res), reject: finish(rej) });
        if (signal?.aborted || socket.readyState !== 1) { pending.get(id).reject(new OperatorError('Connexion de capture fermée.')); pending.delete(id); return; }
        try { socket.send(JSON.stringify({ id, method })); }
        catch { pending.get(id).reject(new OperatorError('Commande de capture impossible.')); pending.delete(id); }
      });
    },
    close() { signal?.removeEventListener('abort', abort); rejectAll(); socket.close(); },
  };
}
export async function captureCookies(profile, port, network, {
  signal, launch = launchChrome, readEndpoint = readDebugger, connect = connectCDP, remove = rm,
} = {}) {
  await remove(join(profile, 'DevToolsActivePort'), { force: true });
  signal?.throwIfAborted();
  const browser = launch(chromeArgs(profile, port, network, true));
  let client;
  try {
    const address = await readEndpoint(profile, browser, { signal });
    client = await connect(address, { signal });
    const result = await client.call('Storage.getCookies');
    const cookies = filterCookies(network, result.cookies);
    try { await client.call('Browser.close'); }
    catch (error) { if (!await browser.wait(5000)) throw error; }
    await browser.wait(5000);
    return cookies;
  } finally { client?.close(); await browser.stop(); }
}

export async function runSelected(row, { ui, run = commandRunner, signal, makeForwarder = startForwarder,
  probe = probeIp, profileFactory = prepareProfile, launch = launchChrome, capture = captureCookies,
  clipboardFactory = createClipboard, closeTimeout = 60_000 } = {}) {
  let forwarder, profile, browser, keepProfileLock = false;
  const clipboard = clipboardFactory(run, { onError: error => ui.write(safeError(error)) });
  try {
    signal?.throwIfAborted();
    forwarder = await makeForwarder(row.upstream);
    ui.write(await verifyExit(row, forwarder.port, probe, signal));
    profile = await profileFactory(row);
    signal?.throwIfAborted();
    browser = launch(chromeArgs(profile.path, forwarder.port, row.network));
    ui.write('Connexion manuelle dans Chrome. Revenez dans ce terminal pour les touches.');
    ui.write(`u : identifiant | p : mot de passe${row.record.totp_secret ? ' | c : code TOTP' : ''}${row.network === 'x' ? ' | e : e-mail | m : mot de passe e-mail' : ''} | d : terminé | q : quitter sans capture`);
    while (true) {
      const key = await Promise.race([ui.key(), browser.exited.then(() => 'browser-exited')]);
      if (key === 'q') { ui.write('Arrêt sans capture.'); return 'quit'; }
      if (key === 'browser-exited') fail('Chrome s’est arrêté avant « d » ; aucune session envoyée.');
      if (key === 'd') break;
      await copyKey(row, key, clipboard, ui);
    }
    await clipboard.close();
    ui.write('Fermez toutes les fenêtres de ce profil Chrome (⌘Q). Arrêt automatique après 60 s.');
    await waitForBrowserExit(browser, closeTimeout, signal);
    signal?.throwIfAborted();
    const cookies = await capture(profile.path, forwarder.port, row.network, { signal });
    await forwarder.close(); forwarder = null;
    const payload = sessionPayload(row, cookies);
    await saveSession(payload, run, signal);
    ui.write(`session enregistrée : ${row.network} #${row.index} sur ${row.isp_alias} (${payload.cookies.length} cookies)`);
    return 'saved';
  } catch (error) {
    keepProfileLock = error instanceof BrowserStopError;
    throw error;
  } finally {
    // Attempt every cleanup even if another one fails. Keep the lock if Chrome
    // cannot be stopped, so a second invocation cannot capture a running profile.
    let cleanupError;
    try { await browser?.stop(); } catch (error) { cleanupError = error; }
    try { await forwarder?.close(); } catch (error) { cleanupError ??= error; }
    try { await clipboard.close(); } catch (error) { cleanupError ??= error; }
    if (!cleanupError && !keepProfileLock) { try { await profile?.release(); } catch (error) { cleanupError = error; } }
    if (cleanupError) throw cleanupError;
  }
}

export async function runOperator({ ui, run = commandRunner, signal, select = listAndSelect, connect = runSelected }) {
  while (true) {
    signal?.throwIfAborted();
    const row = await select({ ui, run, signal });
    if (!row) return;
    const result = await connect(row, { ui, run, signal });
    if (result !== 'saved') return;
    ui.write('Retour au menu : choisissez le compte suivant, ou q pour quitter. Actualisation des sessions…');
  }
}

// Raw terminal input: commands only, no echoed input or readline history.
export function terminalUI(signal, input = process.stdin, output = process.stdout, onInterrupt = () => {}) {
  if (!input.isTTY || !output.isTTY) fail('Lancez cet outil dans un terminal interactif.');
  let reader, buffer = '';
  const oldRaw = input.isRaw;
  const receive = chunk => {
    const value = chunk.toString('utf8');
    if (value.includes('\u0003')) { onInterrupt(); reader?.reject(new DOMException('Aborted', 'AbortError')); reader = null; return; }
    if (!reader) return;
    if (reader.mode === 'key') {
      if (/^[upcemdq]$/i.test(value)) { const active = reader; reader = null; active.resolve(value.toLowerCase()); }
      return;
    }
    for (const char of value) {
      if (char === '\r' || char === '\n') { const active = reader; reader = null; active.resolve(buffer); buffer = ''; break; }
      if (char === '\u007f') buffer = buffer.slice(0, -1);
      else if (/^[a-z0-9]$/i.test(char) && buffer.length < 8) buffer += char;
    }
  };
  const aborted = () => { reader?.reject(new DOMException('Aborted', 'AbortError')); reader = null; };
  input.setRawMode(true); input.resume(); input.on('data', receive); input.on('end', aborted);
  signal.addEventListener('abort', aborted);
  const read = mode => new Promise((res, rej) => {
    if (signal.aborted) { rej(new DOMException('Aborted', 'AbortError')); return; }
    buffer = ''; reader = { mode, resolve: res, reject: rej };
  });
  return { write: value => output.write(`${value}\n`),
    select(prompt) { output.write(`${prompt}(saisie masquée)\n`); return read('select'); },
    key: () => read('key'),
    close() { aborted(); input.removeListener('data', receive); input.removeListener('end', aborted); signal.removeEventListener('abort', aborted); input.setRawMode(Boolean(oldRaw)); input.pause(); },
  };
}
export async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
  let ui;
  try {
    if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) !== 26) fail('Cet outil nécessite macOS et Node 26.');
    process.umask(0o077);
    ui = terminalUI(controller.signal, process.stdin, process.stdout, stop);
    ui.write(`Serveur configuré : VPS (alias SSH ${SERVER_HOST}). Lecture des inventaires et des statuts par SSH.`);
    await runOperator({ ui, signal: controller.signal });
  } catch (error) { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; }
  finally { controller.abort(); ui?.close(); for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
