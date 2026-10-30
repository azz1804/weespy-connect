import net from 'node:net';
import { createHash } from 'node:crypto';
import { NETWORKS, OperatorError, decodeBase32, ispAlias, mapAccounts, safeError } from '../connect.mjs';

export const fail = message => { throw new OperatorError(message); };
export const displayError = error => safeError(error).replace(/^(?:OperatorError|SyntaxError|TypeError|AbortError|Error) : /, '');
export const digest = value => createHash('sha256').update(value).digest('hex');
const tokens = value => String(value ?? '').replace(/\\(?=\s|$)/g, '').trim().split(/\s+/).filter(Boolean);
const field = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
export function sshTarget(value) {
  if (!value || typeof value.host !== 'string' || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host)) fail('Indique un alias SSH ou utilisateur@adresse valide.');
  const port = value.port ? Number(value.port) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) fail('Port SSH invalide.');
  const identity = value.identity || '';
  if (identity && (typeof identity !== 'string' || !identity.startsWith('/') || /[\x00-\x1f]/.test(identity))) fail('Le chemin de la clé SSH doit être absolu.');
  return { host: value.host, port, identity };
}
export function validateProxy(proxy) {
  if (net.isIP(proxy?.ip) !== 4 || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535 || !field(proxy.username) || !field(proxy.password) || proxy.username.includes(':')) fail('IP fixe invalide : ip:port:identifiant:mot_de_passe attendu.');
  return { ip: proxy.ip, port: proxy.port, username: proxy.username, password: proxy.password };
}
export function parseProxies(text) {
  const found = new Set();
  return tokens(text).map(line => {
    const [ip, port, username, ...rest] = line.split(':');
    const proxy = validateProxy({ ip, port: Number(port), username, password: rest.join(':') });
    if (found.has(ip)) fail('Une IP apparaît plusieurs fois dans l’import.');
    found.add(ip); return proxy;
  });
}
export function validateRecord(network, record) {
  if (!Object.hasOwn(NETWORKS, network) || !record || !field(record.password)) fail('Compte incomplet.');
  const label = network === 'linkedin' ? record.profile : record.username;
  if (typeof label !== 'string' || !/^[\p{L}\p{N}_.@%-]{1,160}$/u.test(label)) fail('Pseudo ou identifiant public invalide.');
  if (network === 'linkedin' && (!field(record.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email))) fail('Adresse du compte LinkedIn invalide.');
  if (network === 'x' && record.email && !field(record.email)) fail('Adresse du compte X invalide.');
  if (record.totp_secret) decodeBase32(record.totp_secret);
  // Whitelist properties; imported data never becomes a command or script.
  return Object.fromEntries(['username', 'email', 'password', 'profile', 'totp_secret', 'email_password'].filter(k => field(record[k])).map(k => [k, record[k]]));
}
export function parseAccounts(network, text) {
  return tokens(text).map((line, index) => {
    try {
      const p = line.split(':'); let record;
      if (network === 'linkedin' && p.length === 4) record = { email: p[0], password: p[1], profile: p[2], totp_secret: p[3] };
      if (network === 'instagram' && [2, 3].includes(p.length)) record = { username: p[0], password: p[1], totp_secret: p[2] };
      if (network === 'x' && [2, 3, 4, 5].includes(p.length)) record = { username: p[0], password: p[1], email: p.length >= 4 ? p[2] : undefined, email_password: p.length >= 4 ? p[3] : undefined, totp_secret: p.length === 3 ? p[2] : p[4] };
      if (!record) fail('Format des comptes invalide. Utilise le format indiqué sous la zone de saisie.');
      return validateRecord(network, record);
    } catch (error) { fail(`Compte ${index + 1} : ${displayError(error)}`); }
  });
}
export const identity = (network, record) => (network === 'linkedin' ? record.email : record.username).toLowerCase();
export function makeRow(network, index, record, upstream) {
  return { network, index, key: `${NETWORKS[network].key}${index}`, label: network === 'linkedin' ? record.profile : record.username,
    isp_alias: ispAlias(index), isp_ip: upstream.ip, record, upstream };
}
export function validateInventory(value) {
  if (value?.version !== 1 || !Array.isArray(value.proxies) || value.proxies.length > 25 || !Array.isArray(value.accounts) || value.accounts.length > 75) fail('Inventaire invalide.');
  const proxies = value.proxies.map(validateProxy);
  if (new Set(proxies.map(p => p.ip)).size !== proxies.length) fail('IP répétée dans l’inventaire.');
  const occupied = new Set(), people = new Set();
  const accounts = value.accounts.map(a => {
    const record = validateRecord(a.network, a.record);
    if (!Number.isInteger(a.index) || !proxies[a.index - 1]) fail('Affectation IP invalide.');
    const key = `${a.network}:${a.index}`, person = `${a.network}:${identity(a.network, record)}`;
    if (occupied.has(key) || people.has(person)) fail('Compte ou affectation en double.');
    occupied.add(key); people.add(person);
    return { network: a.network, index: a.index, record };
  });
  return { version: 1, proxies, accounts };
}
export const rowsOf = inventory => inventory.accounts.map(a => makeRow(a.network, a.index, a.record, inventory.proxies[a.index - 1]));
export function legacyInventory(accounts, proxies) {
  const rows = mapAccounts(accounts, proxies);
  const all = proxies.isp_fixed.exits.slice().sort((a, b) => a.alias.localeCompare(b.alias));
  if (all.some((p, i) => p.alias !== ispAlias(i + 1))) fail('Ordre des IP fixes invalide.');
  return validateInventory({ version: 1, proxies: all.map(p => ({ ip: p.ip, port: proxies.isp_fixed.port, ...proxies.isp_fixed.credential_groups[p.group] })),
    accounts: rows.map(r => ({ network: r.network, index: r.index, record: r.record })) });
}
export function mergeImport(inventory, { proxies: proxyText, accounts: accountText, network }, reservedIPs = [], existingLabels = []) {
  const next = structuredClone(inventory);
  const records = parseAccounts(network, accountText);
  const candidates = parseProxies(proxyText);
  for (const proxy of candidates) {
    const existing = next.proxies.find(p => p.ip === proxy.ip);
    if (existing && JSON.stringify(existing) !== JSON.stringify(proxy)) fail('Cette IP existe avec des accès différents. Recharge l’inventaire avant de la modifier.');
    // Explicit stock imports can add unused IPs; account imports only add a deficit.
    if (!existing && !records.length) next.proxies.push(proxy);
  }
  for (const record of records) {
    const existing = next.accounts.find(a => a.network === network && identity(network, a.record) === identity(network, record));
    if (existing) {
      if (JSON.stringify(existing.record) !== JSON.stringify(record)) fail('Ce compte existe avec des données différentes. Aucun remplacement automatique.');
      continue;
    }
    const label = network === 'linkedin' ? record.profile : record.username;
    if (existingLabels.some(existing => existing.toLowerCase() === label.toLowerCase())) continue;
    let offset = next.proxies.findIndex((proxy, i) => !reservedIPs.includes(proxy.ip) && !next.accounts.some(a => a.network === network && a.index === i + 1));
    if (offset < 0) {
      const extra = candidates.find(p => !reservedIPs.includes(p.ip) && !next.proxies.some(current => current.ip === p.ip));
      if (extra && next.proxies.length < 25) { next.proxies.push(extra); offset = next.proxies.length - 1; }
    }
    if (offset < 0) fail('Pas assez d’IP libres pour ce réseau. Toutes les IP existantes utilisables sont déjà attribuées ; ajoute uniquement les IP manquantes (25 IP maximum).');
    next.accounts.push({ network, index: offset + 1, record });
  }
  return validateInventory(next);
}
export function publicInventory(inventory, statuses = new Map()) {
  return { accounts: rowsOf(inventory).map(r => ({ key: r.key, network: r.network, label: r.label, ip: r.isp_ip, alias: r.isp_alias, ...(statuses.get(r.key) || { state: 'ready', message: 'À connecter' }) })),
    proxies: inventory.proxies.map((p, i) => ({ ip: p.ip, alias: ispAlias(i + 1), assigned: inventory.accounts.filter(a => a.index === i + 1).map(a => `${NETWORKS[a.network].key}${a.index}`) })) };
}
