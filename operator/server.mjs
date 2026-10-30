#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, lstat, chmod, writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { commandRunner } from '../connect.mjs';
import { fail, sshTarget, displayError as safeError } from './model.mjs';
import { Operator } from './controller.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME = join(homedir(), 'WeespyAccounts', 'operator-runtime.json');
export const SETTINGS = join(homedir(), 'WeespyAccounts', 'operator-settings.json');
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function readLocalAccess(path = RUNTIME) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) return null;
    const value = JSON.parse(await readFile(path, 'utf8'));
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}
export async function bodyOf(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 256_000) fail('Import trop volumineux.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Données invalides.'); }
  finally { for (const chunk of chunks) chunk.fill(0); }
}
export async function installBridge(provider, run = commandRunner) {
  if (!['claude', 'codex'].includes(provider)) fail('Choisis Claude CLI ou Codex.');
  const bridge = join(HERE, 'mcp.mjs');
  const args = provider === 'claude'
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'weespy-local', '--', process.execPath, bridge]
    : ['mcp', 'add', 'weespy-local', '--', process.execPath, bridge];
  try { await run(provider, args, { timeout: 20_000 }); }
  catch { fail('CLI absent ou lien déjà configuré. Vérifie son installation et sa configuration MCP.'); }
  return { message: `Lien installé. Ouvre une nouvelle session ${provider === 'claude' ? 'Claude CLI' : 'Codex'} et demande « Connecte les comptes WeeSpy prêts ».`, login: provider === 'claude' ? 'claude auth login' : 'codex login' };
}
export async function createServer({ operator = new Operator(), token = randomBytes(32).toString('hex'), install = installBridge, onTarget = async () => {}, port = 0 } = {}) {
  let origin;
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/access.js', ['access.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const server = http.createServer(async (request, response) => {
    const json = (code, data) => { if (!response.headersSent) response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return json(403, { error: 'Accès local uniquement.' });
      const asset = assets.get(request.url);
      if (asset && request.method === 'GET') { response.writeHead(200, { 'Content-Type': asset[1] }); return response.end(await readFile(join(HERE, 'public', asset[0]))); }
      const cookieName = `weespy-local-${new URL(origin).port}`;
      const cookie = (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const bearerAccess = same(request.headers.authorization, `Bearer ${token}`);
      const cookieAccess = same(cookie, token) && request.headers['sec-fetch-site'] === 'same-origin'
        && (request.method === 'GET' || request.headers.origin === origin);
      if (!bearerAccess && !cookieAccess) return json(401, { error: 'Accès à WeeSpy Connect non reconnu. Ouvre « Lancer-WeeSpy-Connect.command » pour rétablir la connexion.' });
      // Only an already authenticated request can authorize other tabs in this browser.
      if (bearerAccess) response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      if (request.url === '/api/state' && request.method === 'GET') return json(200, operator.snapshot());
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') return json(405, { error: 'Requête invalide.' });
      const data = await bodyOf(request);
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Requête invalide.');
      switch (request.url) {
        case '/api/load': { const state = await operator.load(data); await onTarget(operator.target); return json(200, state); }
        case '/api/import': return json(200, operator.import(data));
        case '/api/import-connect': return json(200, operator.importAndConnect(data));
        case '/api/setup-preview': return json(200, operator.previewSetup(data));
        case '/api/setup-check-ips': return json(200, operator.checkSetupIPs(data));
        case '/api/setup-cancel-checks': if (data.runId && data.runId === operator.ipChecks?.runId) operator.cancelIPChecks(); return json(200, operator.snapshot());
        case '/api/setup-connect': return json(200, operator.setupAndConnect(data));
        case '/api/start': return json(200, operator.start(data.keys));
        case '/api/action': return json(200, operator.action(data.action, { key: data.key }));
        case '/api/install': operator.requireIdle(); return json(200, await install(data.provider));
        case '/api/agent': {
          switch (data.action) {
            case 'status': return json(200, operator.snapshot({ agent: true }));
            case 'start': operator.start(data.keys); return json(200, operator.snapshot({ agent: true }));
            case 'resume': case 'skip': case 'stop': return json(200, operator.action(data.action, { agent: true }));
            default: fail('Action indisponible pour l’assistant.');
          }
          break;
        }
        default: return json(404, { error: 'Introuvable.' });
      }
    } catch (error) { json(400, { error: safeError(error) }); }
  });
  server.requestTimeout = 50_000; server.headersTimeout = 10_000; server.maxHeadersCount = 30;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, server, operator, async close() { await operator.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
async function main() {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 26) fail('Cette version nécessite macOS et Node 26.');
  const base = dirname(RUNTIME); await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await lstat(base); if (info.isSymbolicLink() || info.uid !== process.getuid()) fail('Dossier local non sûr.');
  await chmod(base, 0o700);
  // Reuse an already running app; never silently replace another session's token.
  const old = await readLocalAccess();
  try {
    if (old) {
      const response = await fetch(old.origin + '/api/state', { headers: { Authorization: `Bearer ${old.token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { if (!process.argv.includes('--no-open')) spawn('/usr/bin/open', [old.origin + '/#' + old.token], { stdio: 'ignore' }).unref(); return; }
    }
  } catch { /* No live instance; create a fresh session. */ }
  const onTarget = async target => {
    const temp = SETTINGS + '.' + process.pid;
    try { await writeFile(temp, JSON.stringify(sshTarget(target)), { mode: 0o600, flag: 'wx' }); await rename(temp, SETTINGS); }
    finally { await rm(temp, { force: true }); }
  };
  const app = await createServer({ port: 49831, onTarget, ...(old ? { token: old.token } : {}) });
  const temp = RUNTIME + '.' + process.pid;
  await writeFile(temp, JSON.stringify({ origin: app.origin, token: app.token }), { mode: 0o600, flag: 'wx' });
  await rename(temp, RUNTIME);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); }; // Keep private access so existing tabs survive a restart.
  process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; })); process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; }));
  let target = { host: 'mon-vps' };
  try { target = sshTarget(JSON.parse(await readFile(SETTINGS, 'utf8'))); } catch { /* Default WeeSpy VPS on first launch. */ }
  app.operator.load(target).then(() => onTarget(app.operator.target)).catch(error => { app.operator.message = safeError(error); });
  app.operator.startMonitor();
  process.stdout.write(`WeeSpy Connect ouvert sur ${app.origin}. Garde cette fenêtre ouverte. Ctrl-C pour fermer.\n`);
  if (!process.argv.includes('--no-open')) spawn('/usr/bin/open', [app.origin + '/#' + app.token], { stdio: 'ignore' }).unref();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('Impossible de lancer WeeSpy Connect. Vérifie Node 26 et ferme une éventuelle ancienne instance.\n'); process.exitCode = 1; });
