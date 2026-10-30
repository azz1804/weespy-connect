#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const RUNTIME = join(homedir(), 'WeespyAccounts', 'operator-runtime.json');
const empty = { type: 'object', properties: {}, additionalProperties: false };
export const TOOLS = [
  { name: 'weespy_status', description: 'État des comptes importés localement, IP attribuées, file et éventuelle intervention humaine. Aucun identifiant ni cookie retourné.', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'weespy_connect', description: 'Lance les connexions des comptes déjà importés dans WeeSpy Connect sur le Mac, puis envoie les sessions au VPS configuré. Sans keys : comptes sans session enregistrée. Retour immédiat ; consulter weespy_status ensuite. Utiliser sur demande du propriétaire. Ne jamais demander ou transmettre de mots de passe dans le chat.', inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string', pattern: '^(li|x|ig)([1-9]|1[0-9]|2[0-5])$' }, minItems: 1, maxItems: 75, uniqueItems: true } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
  { name: 'weespy_resume', description: 'Reprend après que le propriétaire a terminé la vérification dans Chrome. Ne résout aucun CAPTCHA. La confirmation d’identité reste dans l’interface locale.', inputSchema: empty, annotations: { readOnlyHint: false } },
  { name: 'weespy_skip', description: 'Passe le compte bloqué et continue avec le suivant, sans sauvegarder sa session.', inputSchema: empty, annotations: { readOnlyHint: false } },
  { name: 'weespy_stop', description: 'Arrête la file et ferme le navigateur de connexion et son proxy.', inputSchema: empty, annotations: { readOnlyHint: false } },
];
export async function bridge(action, args = {}) {
  const info = await lstat(RUNTIME);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('runtime');
  const runtime = JSON.parse(await readFile(RUNTIME, 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.origin) || !/^[a-f0-9]{64}$/.test(runtime.token)) throw new Error('runtime');
  const response = await fetch(runtime.origin + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.token}` },
    body: JSON.stringify({ action, ...(action === 'start' && args.keys !== undefined ? { keys: args.keys } : {}) }), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok) return { content: [{ type: 'text', text: data.error || 'Opération indisponible.' }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
export async function handle(message, call = bridge) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  if (!Object.hasOwn(message, 'id')) return null;
  let result;
  switch (message.method) {
    case 'initialize': result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'weespy-local', version: '2.0.0' }, instructions: 'Les secrets se saisissent dans WeeSpy Connect, jamais dans le chat. Les outils ne retournent que des états. Un CAPTCHA nécessite le propriétaire dans Chrome.' }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: TOOLS }; break;
    case 'tools/call': {
      const actions = { weespy_status: 'status', weespy_connect: 'start', weespy_resume: 'resume', weespy_skip: 'skip', weespy_stop: 'stop' };
      const action = actions[message.params?.name], args = message.params?.arguments ?? {};
      if (!action || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => action !== 'start' || k !== 'keys')) result = { content: [{ type: 'text', text: 'Outil ou arguments invalides.' }], isError: true };
      else try { result = await call(action, args); } catch { result = { content: [{ type: 'text', text: 'Ouvre WeeSpy Connect sur le Mac, charge le VPS et réessaie.' }], isError: true }; }
      break;
    }
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
  return { jsonrpc: '2.0', id: message.id, result };
}
async function main() {
  let pending = '', chain = Promise.resolve();
  const emit = response => { if (response) process.stdout.write(JSON.stringify(response) + '\n'); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    if (pending.length > 100_000) { process.stdin.destroy(); process.exitCode = 1; return; }
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      chain = chain.then(async () => {
        try { emit(await handle(JSON.parse(line))); }
        catch { emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
