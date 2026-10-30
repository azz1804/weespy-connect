import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, stat, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseProxies, parseAccounts, mergeImport, rowsOf, publicInventory, sshTarget } from './model.mjs';
import { connectAccount, pageStep, profileFor } from './browser.mjs';
import { Remote, REMOTE } from './remote.mjs';
import { Operator } from './controller.mjs';
import { createServer, installBridge } from './server.mjs';
import { handle, TOOLS } from './mcp.mjs';
import { sessionPayload, OperatorError } from '../connect.mjs';

const secret = 'SYNTHETIC_PASSWORD_TEST_ONLY';
const base32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const proxyText = '203.0.113.1:12323:proxy-user:proxy-secret\\\n203.0.113.2:2345:other-user:other-secret';
const input = `person@example.test:${secret}:test-profile:${base32}`;
const empty = () => ({ version: 1, proxies: [], accounts: [] });
const inventory = () => mergeImport(mergeImport(empty(), { proxies: proxyText, network: 'linkedin', accounts: '' }), { network: 'linkedin', accounts: input });
const cookies = [{ name: 'li_at', value: 'SYNTHETIC_COOKIE_TEST_ONLY', domain: '.linkedin.com', session: true }, { name: 'JSESSIONID', value: 'SYNTHETIC_CSRF', domain: '.linkedin.com', session: true }];
const row = () => rowsOf(inventory())[0];
const abortSignal = () => new AbortController().signal;

test('imports proxy formats and rejects invalid/duplicate IPs without echoing values', () => {
  assert.equal(parseProxies(proxyText).length, 2);
  for (const value of ['203.0.113.1:0:u:p', 'not-an-ip:123:u:p', proxyText + '\n203.0.113.1:123:u:p']) assert.throws(() => parseProxies(value));
  assert.equal(parseAccounts('linkedin', input).length, 1);
  assert.equal(parseAccounts('instagram', 'account:password').length, 1);
  assert.equal(parseAccounts('instagram', 'account:pass\\word')[0].password, 'pass\\word');
  assert.throws(() => parseAccounts('linkedin', `bad:${secret}:profile:WRONG!`), error => !error.message.includes(secret));
});
test('assignment is stable, idempotent and shared only across different networks', () => {
  const first = inventory();
  assert.deepEqual(mergeImport(first, { proxies: proxyText, accounts: input, network: 'linkedin' }), first);
  const second = mergeImport(first, { network: 'linkedin', accounts: `second@example.test:fake-password:second-profile:${base32}` });
  assert.deepEqual(second.accounts.map(a => a.index), [1, 2]);
  const third = mergeImport(second, { network: 'instagram', accounts: 'insta:fake-password' });
  assert.equal(third.accounts.at(-1).index, 1);
  assert.throws(() => mergeImport(second, { network: 'linkedin', accounts: `third@example.test:password:third:${base32}` }));
  assert.throws(() => mergeImport(first, { network: 'linkedin', accounts: `person@example.test:different:other:${base32}` }));
  assert.throws(() => mergeImport(first, { network: 'linkedin', proxies: '203.0.113.1:12323:u:changed', accounts: '' }));
});
test('public state excludes account and proxy secrets and email', () => {
  const text = JSON.stringify(publicInventory(inventory()));
  for (const value of [secret, base32, 'proxy-secret', 'proxy-user', 'person@example.test']) assert.ok(!text.includes(value));
  assert.match(text, /203\.0\.113\.2/);
});
test('SSH inputs cannot become options or shell commands', () => {
  for (const host of ['-oProxyCommand=bad', 'server;echo bad', '$(whoami)', 'a@b\nanything', 'a b']) assert.throws(() => sshTarget({ host }));
  assert.deepEqual(sshTarget({ host: 'owner@vps.example.test', port: '22' }), { host: 'owner@vps.example.test', port: 22, identity: '' });
});
test('remote carries all imported secrets on stdin, uses strict host keys and compares revisions', async () => {
  const calls = [];
  const remote = new Remote({ host: 'test-vps' }, async (command, args, options) => { calls.push({ command, args, options }); return { stdout: JSON.stringify({ revision: { bundle: 'revision', legacy: [] } }) }; });
  remote.revision = { bundle: null, legacy: [] };
  await remote.reserve(inventory());
  assert.ok(calls[0].options.input.includes(secret));
  assert.ok(!JSON.stringify(calls[0].args).includes(secret));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
  assert.ok(calls[0].args.includes('ControlPath=none'));
  assert.ok(calls[0].args.includes('ControlMaster=no'));
  assert.equal(remote.revision.bundle, 'revision');
});

test('remote transaction persists mode 600, refuses stale writers and mismatched sessions', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'weespy-fake-remote-')));
  const root = join(temp, 'sessions');
  const script = REMOTE.replace("root='/etc/weespy/account-sessions'", `root=${JSON.stringify(root)}`)
    .replace("legacy=['/etc/weespy/account-inventory/accounts-20261028.json','/etc/weespy/proxy-inventory/inventory-20261028.json']", `legacy=[${JSON.stringify(join(temp, 'missing-accounts'))},${JSON.stringify(join(temp, 'missing-proxies'))}]`)
    .replace('os.fchown(fd,0,0)', 'None').replace('os.chown(root,0,0)', 'None').replace('req=json.load(sys.stdin)', "def run_session_probe(payload): return {'failure':'session_rejected'} if payload['session']['cookies'][0]['value']=='REJECTED_SYNTHETIC' else {'cookies':payload['session']['cookies'],'scope':'vps_identity'}\nreq=json.load(sys.stdin)");
  const call = data => spawnSync('/usr/bin/python3', ['-c', script], { input: JSON.stringify(data), encoding: 'utf8' });
  try {
    const initial = call({ op: 'load' }); assert.equal(initial.status, 0); const loaded = JSON.parse(initial.stdout);
    const reserved = call({ op: 'reserve', revision: loaded.revision, inventory: inventory() }); assert.equal(reserved.status, 0);
    const revision = JSON.parse(reserved.stdout).revision;
    assert.equal((await stat(join(root, 'operator-inventory.json'))).mode & 0o777, 0o600);
    assert.notEqual(call({ op: 'reserve', revision: loaded.revision, inventory: inventory() }).status, 0);
    const session = sessionPayload(row(), cookies);
    assert.notEqual(call({ op: 'save', revision, session: { ...session, isp_ip: '203.0.113.99' } }).status, 0);
    assert.equal(call({ op: 'save', revision, session }).status, 0);
    const status = JSON.parse(call({ op: 'load' }).stdout).statuses;
    assert.equal(status.length, 1); assert.ok(!JSON.stringify(status).includes(cookies[0].value));
    assert.equal((await stat(join(root, 'linkedin-1.json'))).mode & 0o777, 0o600);
    const changed = inventory(); changed.accounts[0].record.profile = 'someone-else';
    assert.notEqual(call({ op: 'reserve', revision, inventory: changed }).status, 0);
    const health = JSON.parse(call({ op: 'status', revision }).stdout); assert.equal(health.statuses[0].cookie_state, 'valid');
    const rejected = { ...session, cookies: cookies.map(c => ({ ...c, value: 'REJECTED_SYNTHETIC' })) };
    assert.equal(JSON.parse(call({ op: 'save', revision, session: rejected }).stdout).failure, 'session_rejected');
    assert.equal(JSON.parse(call({ op: 'save', revision, session: { ...session, captured_at: '2000-01-01T00:00:00Z' } }).stdout).failure, 'stale_capture');
    assert.equal(JSON.parse(call({ op: 'status', revision }).stdout).statuses[0].cookie_state, 'valid');
    const expired = { ...session, cookies: cookies.map(c => ({ ...c, session: false, expires: 1 })) };
    assert.equal(JSON.parse(call({ op: 'save', revision, session: expired }).stdout).failure, 'missing_cookies');
    assert.equal(JSON.parse(call({ op: 'status', revision }).stdout).statuses[0].cookie_state, 'valid');
    await writeFile(join(root, 'linkedin-1.json'), JSON.stringify(expired));
    assert.equal(JSON.parse(call({ op: 'status', revision }).stdout).statuses[0].cookie_state, 'expired');
    await writeFile(join(root, 'linkedin-1.json'), 'corrupt fixture');
    const corrupt = JSON.parse(call({ op: 'status', revision }).stdout).statuses;
    assert.deepEqual(corrupt, [{ network: 'linkedin', index: 1, problem: 'invalid' }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('profile reuse is locked and account/server/IP changes isolate profiles', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'weespy-profile-test-'));
  try {
    const p1 = await profileFor({ host: 'one' }, row(), temp);
    await assert.rejects(profileFor({ host: 'one' }, row(), temp)); await p1.release();
    const p2 = await profileFor({ host: 'one' }, row(), temp); assert.equal(p1.path, p2.path); await p2.release();
    const p3 = await profileFor({ host: 'two' }, row(), temp); assert.notEqual(p2.path, p3.path); await p3.release();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

function fakePage({ url = 'https://www.linkedin.com/login', text = '', formOrigin, duplicate = false, challenge = false, profile = false, network = 'linkedin', stage = 'credentials', otp = false, passwordOnly = false, loseInput = false, buttonText } = {}) {
  const location = new URL(url), form = { action: formOrigin || location.href };
  class Input { constructor() { this.form = form; this.disabled = false; } getClientRects() { return [1]; } dispatchEvent() {} }
  Object.defineProperty(Input.prototype, 'value', { get() { return this.stored; }, set(value) { if (!loseInput) this.stored = value; } });
  const user = new Input(), password = new Input(); let clicked = 0;
  const button = { ...new Input(), innerText: buttonText || (otp ? 'Verify' : stage === 'username' ? 'Next' : network === 'instagram' ? 'Log in' : 'Sign in'), form, getClientRects: () => [1], click: () => { clicked++; } };
  const querySelectorAll = selectors => {
    if (otp && selectors.startsWith('input[autocomplete="one-time-code"]')) return [user];
    if (otp && selectors.startsWith('input')) return [];
    if (network === 'instagram' && selectors === 'input[name="username"]') return [user];
    if (network === 'x' && stage === 'username' && selectors === 'input[autocomplete="username"]') return [user];
    if (network === 'x' && stage === 'username' && selectors === 'button,[role="button"]') return [button];
    if ((network === 'instagram' || (network === 'x' && stage === 'password')) && selectors === 'input[name="password"]') return [password];
    if (network === 'x' && selectors === '[data-testid="LoginForm_Login_Button"]') return [button];
    if (selectors === 'input#username' && passwordOnly) return [];
    if (selectors === 'input#username') return duplicate ? [user, new Input()] : [user];
    if (selectors === 'input#password') return [password];
    if (selectors.startsWith('iframe[')) return challenge ? [button] : [];
    if (selectors.startsWith('.feed-identity-module')) return profile ? [{ href: 'https://www.linkedin.com/in/test-profile' }] : [];
    if (selectors.startsWith('button[type=')) return [button];
    return [];
  };
  const context = vm.createContext({ location, document: { body: { innerText: text }, querySelectorAll }, URL, getComputedStyle: () => ({ visibility: 'visible' }), HTMLInputElement: Input, Event: class {}, setTimeout: f => { f(); } });
  return { step: action => vm.runInContext(`(${pageStep.toString()})(${JSON.stringify(network)},'test-profile',${JSON.stringify(action || null)})`, context), user, password, clicked: () => clicked };
}
test('page driver fills only trusted, unique login fields and clicks once', async () => {
  const page = fakePage(); assert.equal((await page.step()).stage, 'credentials');
  assert.equal((await page.step({ stage: 'credentials', values: ['fake-user', secret] })).stage, 'submitted');
  assert.equal(page.password.stored, secret); assert.equal(page.clicked(), 1);
});
test('page driver stops before filling for foreign origins, cross-origin forms, CAPTCHA or ambiguity', async () => {
  for (const options of [{ url: 'https://fake.example/login' }, { formOrigin: 'https://fake.example/submit' }, { challenge: true }, { duplicate: true }, { text: 'Wrong password' }, { text: 'Reset your password' }]) {
    const page = fakePage(options); const result = await page.step({ stage: 'credentials', values: ['fake-user', secret] });
    assert.notEqual(result.stage, 'submitted'); assert.equal(page.password.stored, undefined); assert.equal(page.clicked(), 0);
  }
});

test('remembered LinkedIn password and French submit work, refusal and lost input never click', async () => {
  const remembered = fakePage({ passwordOnly: true, text: 'Welcome back', buttonText: 'S’identifier' });
  assert.equal((await remembered.step()).stage, 'password');
  assert.equal((await remembered.step({stage:'password',values:[secret]})).stage, 'submitted');
  const rejected = fakePage({text: 'That’s not the right password'});
  assert.equal((await rejected.step()).reason, 'rejected');
  const changed = fakePage({loseInput: true});
  assert.equal((await changed.step({stage:'credentials',values:['synthetic',secret]})).stage, 'changed');
  assert.equal(changed.clicked(), 0);
  const feed = fakePage({url:'https://www.linkedin.com/feed/',text:'A post about wrong password and reset your password',profile:true});
  assert.equal((await feed.step()).identityVerified, true);
});

test('Instagram and X use their own recognized login stages', async () => {
  for (const config of [{ network: 'instagram', url: 'https://www.instagram.com/accounts/login/', stage: 'credentials' },
    { network: 'x', url: 'https://x.com/i/flow/login', stage: 'username' }, { network: 'x', url: 'https://x.com/i/flow/login', stage: 'password' }]) {
    const page = fakePage(config); assert.equal((await page.step()).stage, config.stage);
    assert.equal((await page.step({ stage: config.stage, values: config.stage === 'credentials' ? ['synthetic', 'synthetic'] : ['synthetic'] })).stage, 'submitted');
    assert.equal(page.clicked(), 1);
  }
});
test('TOTP fills only an explicitly identified authenticator challenge, never SMS', async () => {
  const app = fakePage({ otp: true, text: 'Enter a code from your authenticator app' });
  assert.equal((await app.step()).stage, 'totp');
  assert.equal((await app.step({ stage: 'totp', values: ['123456'] })).stage, 'submitted');
  const sms = fakePage({ otp: true, text: 'Enter the code sent by SMS' });
  assert.equal((await sms.step()).stage, 'human');
  await sms.step({ stage: 'totp', values: ['123456'] }); assert.equal(sms.user.stored, undefined);
});

async function engine(snapshots, opts = {}) {
  let position = 0, closed = false; const submitted = [], saved = [], reports = [];
  const result = await connectAccount({ target: { host: 'fake' }, row: row(), signal: opts.signal || abortSignal(),
    report: (...args) => reports.push(args), save: async payload => { saved.push(payload); return {stored:true,scope:'vps_identity',checkedAt:new Date().toISOString()}; }, sleep: async () => {}, stabilityMs: 0,
    waitForUser: opts.waitForUser || (async () => 'skip'),
    open: async () => ({ snapshot: async () => snapshots[Math.min(position++, snapshots.length - 1)],
      submit: async action => { submitted.push(structuredClone(action)); return {stage:'submitted'}; }, cookies: async () => opts.noCookies ? [] : cookies, close: async () => { closed = true; } }), ...opts });
  return { result, closed, submitted, saved, reports };
}
test('automatic flow submits once then saves only authenticated/identified session', async () => {
  const result = await engine([{ stage: 'credentials' }, { stage: 'outside', identityVerified: true }]);
  assert.equal(result.submitted.length, 1); assert.equal(result.saved.length, 1); assert.equal(result.result, 'saved'); assert.equal(result.closed, true);
  assert.ok(!JSON.stringify(result.reports).includes(secret));
});
test('unknown identity requires owner confirmation and fresh cookies', async () => {
  let prompts = 0;
  const result = await engine([{ stage: 'outside', identityVerified: false }], { waitForUser: async actions => { prompts++; assert.ok(actions.includes('confirm')); return 'confirm'; } });
  assert.equal(prompts, 1); assert.equal(result.saved.length, 1);
});
test('CAPTCHA, rejected login and missing cookies never get saved or retried in a loop', async () => {
  const rejected = await engine([{ stage: 'credentials' }, { stage: 'human', reason: 'rejected' }]);
  assert.equal(rejected.submitted.length, 1); assert.equal(rejected.saved.length, 0); assert.equal(rejected.result, 'skipped');
  const captcha = await engine([{ stage: 'human', reason: 'challenge' }]); assert.equal(captcha.submitted.length, 0); assert.equal(captcha.saved.length, 0);
  const noCookies = await engine([{ stage: 'outside', identityVerified: true }], { noCookies: true }); assert.equal(noCookies.saved.length, 0);
});
test('browser resources close on transfer failure and abort', async () => {
  let closed = 0;
  const controller = new AbortController();
  const open = async () => ({ snapshot: async () => ({ stage: 'outside', identityVerified: true }), cookies: async () => cookies, close: async () => closed++ });
  await assert.rejects(connectAccount({ target: {}, row: row(), signal: controller.signal, report() {}, open, stabilityMs:0, save: async () => { throw new Error('fake'); } }));
  controller.abort(); await assert.rejects(connectAccount({ target: {}, row: row(), signal: controller.signal, report() {}, open }));
  assert.equal(closed, 2);
});

function fakeRemote() { return { target: { host: 'fake-vps' }, load: async () => ({ inventory: inventory(), statuses: [] }), reserve: async () => {}, save: async () => {} }; }
test('queue is sequential, reserves first and rejects concurrent imports/starts', async () => {
  const events = [], remote = fakeRemote(); remote.reserve = async () => events.push('reserved');
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const operator = new Operator({ remote: () => remote, connect: async ({ row, report }) => { events.push(row.key); await gate; report('saved', 'done'); } });
  await operator.load({ host: 'fake-vps' });
  operator.import({ network: 'linkedin', accounts: `second@example.test:p:second:${base32}` });
  operator.start(); assert.throws(() => operator.start()); assert.throws(() => operator.import({}));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['reserved', 'li1']);
  unblock(); await operator.job; assert.deepEqual(events, ['reserved', 'li1', 'li2']); assert.equal(operator.busy, false);
});
test('stop releases human wait; assistants cannot confirm identity', async () => {
  const operator = new Operator({ remote: () => fakeRemote(), connect: async ({ waitForUser, signal }) => waitForUser(['confirm', 'skip'], signal) });
  await operator.load({ host: 'fake-vps' }); operator.start(); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => operator.action('confirm', { agent: true })); operator.action('stop'); await operator.job;
  assert.equal(operator.busy, false); assert.equal(operator.pending, null);
});

test('HTTP denies foreign origins/hosts/no token and never returns secrets to UI or MCP', async () => {
  const operator = new Operator({ remote: () => fakeRemote() }); await operator.load({ host: 'fake-vps' });
  const app = await createServer({ operator });
  try {
    assert.equal((await fetch(app.origin + '/api/state')).status, 401);
    const headers = { Authorization: `Bearer ${app.token}` };
    assert.equal((await fetch(app.origin + '/api/state', { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      const request = http.get(app.origin + '/api/state', { headers: { ...headers, Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
    });
    assert.equal(foreignHost, 403);
    const result = await fetch(app.origin + '/api/state', { headers }).then(r => r.text());
    assert.ok(!result.includes(secret)); assert.ok(!result.includes(base32)); assert.ok(!result.includes('proxy-secret'));
    const agent = await fetch(app.origin + '/api/agent', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }) }).then(r => r.json());
    assert.equal(agent.accounts[0].label, undefined);
    const forbidden = await fetch(app.origin + '/api/agent', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import', accounts: input }) });
    assert.equal(forbidden.status, 400);
    const html = await fetch(app.origin); assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  } finally { await app.close(); }
});
test('MCP initializes, lists constrained tools and routes only non-secret controls', async () => {
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }); assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 5);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  let received;
  await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'weespy_connect', arguments: { keys: ['li1'] } } }, async (action, args) => { received = { action, args }; return { content: [] }; });
  assert.deepEqual(received, { action: 'start', args: { keys: ['li1'] } });
  const reject = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'weespy_connect', arguments: { password: secret } } }); assert.equal(reject.result.isError, true);
  assert.ok(TOOLS.every(tool => !JSON.stringify(tool.inputSchema).includes('password')));
});
test('CLI bridge installation invokes a fixed binary and arguments, no shell or credentials', async () => {
  const calls = [];
  for (const provider of ['claude', 'codex']) await installBridge(provider, async (...args) => { calls.push(args); return { stdout: '' }; });
  assert.equal(calls[0][0], 'claude'); assert.ok(calls[0][1].includes('user')); assert.equal(calls[1][0], 'codex'); assert.ok(calls.every(c => c[1].includes('weespy-local')));
  await assert.rejects(installBridge('codex;echo bad'));
});

test('one-step import immediately connects only requested accounts and keeps assignments', async () => {
  const connected = [], operator = new Operator({ remote: () => fakeRemote(), connect: async ({ row, report }) => { connected.push(row.key); report('saved', 'done'); } });
  await operator.load({ host: 'fake-vps' });
  const response = operator.importAndConnect({ network: 'linkedin', accounts: `second@example.test:p:second:${base32}` });
  assert.equal(response.busy, true); await operator.job;
  assert.deepEqual(connected, ['li2']); assert.equal(operator.inventory.accounts[0].index, 1);
  operator.importAndConnect({ network: 'linkedin', accounts: `second@example.test:p:second:${base32}` });
  assert.equal(operator.busy, false); assert.deepEqual(connected, ['li2']);
  assert.throws(() => operator.importAndConnect({ network: 'linkedin', accounts: '' }));
});
test('account/IP failures retain a safe per-row history and continue the queue', async () => {
  const visited = [], operator = new Operator({ remote: () => fakeRemote(), connect: async ({ row, report }) => {
    visited.push(row.key); if (row.key === 'li1') { const error = new OperatorError('IP indisponible.'); error.category = 'ip'; throw error; }
    report('saved', 'done');
  } });
  await operator.load({ host: 'fake-vps' }); operator.import({ network: 'linkedin', accounts: `second@example.test:p:second:${base32}` });
  operator.start(); await operator.job;
  assert.deepEqual(visited, ['li1', 'li2']); const first = operator.snapshot().accounts[0];
  assert.equal(first.state, 'error'); assert.equal(first.category, 'ip'); assert.equal(first.ipHealth.state, 'error'); assert.equal(first.history.length, 1);
  assert.ok(!JSON.stringify(operator.snapshot()).includes(secret));
});
test('VPS transfer failures stop the queue before another account is opened', async () => {
  const visited = [], operator = new Operator({ remote: () => fakeRemote(), connect: async ({ row }) => {
    visited.push(row.key); const error = new OperatorError('Transfert indisponible.'); error.fatal = true; error.category = 'vps'; throw error;
  } });
  await operator.load({ host: 'fake-vps' }); operator.import({ network: 'linkedin', accounts: `second@example.test:p:second:${base32}` });
  operator.start(); await operator.job; assert.deepEqual(visited, ['li1']); assert.equal(operator.snapshot().vps.state, 'error');
});
test('health detects expired and missing sessions without equating presence to authentication', async () => {
  let statuses = [{ ...sessionPayload(row(), cookies), cookies: undefined, cookie_state: 'valid' }];
  const remote = fakeRemote(); remote.load = async () => ({ inventory: inventory(), statuses }); remote.status = async () => statuses;
  const operator = new Operator({ remote: () => remote });
  await operator.load({ host: 'fake-vps' }); assert.equal(operator.snapshot().accounts[0].state, 'existing');
  statuses[0].cookie_state = 'expired'; await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state, 'expired');
  statuses[0].cookie_state = 'valid'; await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state, 'existing');
  statuses = []; await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state, 'error');
  remote.status = async () => { throw new OperatorError('VPS indisponible.'); }; await operator.refreshHealth(); assert.equal(operator.snapshot().vps.state, 'error');
  await operator.close();
});
test('recent verified state becomes unverified stored state after five minutes', async () => {
  let clock = '2026-10-30T10:00:00.000Z';
  const session = { ...sessionPayload(row(), cookies, new Date(clock)), cookies: undefined, cookie_state: 'valid' };
  const remote = fakeRemote(); remote.load = async () => ({ inventory: inventory(), statuses: [session] }); remote.status = async () => [session];
  const operator = new Operator({ remote: () => remote, now: () => clock }); await operator.load({ host: 'fake-vps' });
  operator.setStatus('li1', { state: 'saved', verifiedAt: clock, message: 'done' });
  await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state, 'saved');
  clock = '2026-10-30T10:06:00.000Z'; await operator.refreshHealth(); assert.equal(operator.snapshot().accounts[0].state, 'existing');
});
test('health checks shared IP once and ignores stale results while a connection starts', async () => {
  const remote = fakeRemote(), checked = [];
  remote.status = async () => [];
  const operator = new Operator({ remote: () => remote, checkProxy: async row => checked.push(row.isp_ip) });
  await operator.load({ host: 'fake-vps' }); operator.import({ network: 'instagram', accounts: 'insta:p' });
  await operator.refreshHealth({ proxies: true }); assert.deepEqual(checked, ['203.0.113.1']);
  assert.equal(operator.snapshot().accounts[1].ipHealth.state, 'ok');
  let resolve; remote.status = () => new Promise(r => { resolve = r; }); const check = operator.refreshHealth();
  operator.busy = true; resolve([{ network: 'unknown' }]); await check; assert.equal(operator.vps.state, 'ok');
  operator.busy = false; await operator.close();
});
test('old row actions cannot resume the next account', async () => {
  const operator = new Operator({ remote: () => fakeRemote(), connect: async ({ waitForUser, signal }) => waitForUser(['resume', 'skip'], signal) });
  await operator.load({ host: 'fake-vps' }); operator.start(); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => operator.action('resume', { key: 'li2' })); operator.action('stop'); await operator.job;
});

test('guided setup previews all networks without mutation, then starts one reserved queue', async () => {
  const events = [], remote = fakeRemote(); remote.reserve = async inv => events.push(['reserve', inv.accounts.length]);
  const operator = new Operator({ remote: () => remote, connect: async ({ row, report }) => { events.push(row.key); report('saved', 'done'); } });
  await operator.load({ host: 'fake-vps' });
  const before = structuredClone(operator.inventory);
  const data = { proxies: '', accounts: { linkedin: `second@example.test:${secret}:second:${base32}`, x: `x-person:${secret}`, instagram: `ig-person:${secret}` }, includePending: true };
  const preview = operator.previewSetup(data);
  assert.deepEqual(operator.inventory, before); assert.equal(operator.busy, false); assert.deepEqual(events, []);
  assert.deepEqual(preview.accounts.map(a => [a.key, a.ip]), [['li1', '203.0.113.1'], ['li2', '203.0.113.2'], ['x1', '203.0.113.1'], ['ig1', '203.0.113.1']]);
  for (const value of [secret, base32, 'proxy-secret', 'person@example.test']) assert.ok(!JSON.stringify(preview).includes(value));
  assert.equal(preview.newAccounts, 3); assert.equal(preview.newIPs, 0);
  operator.setupAndConnect({ ...data, previewId: preview.previewId }); await operator.job;
  assert.deepEqual(events, [['reserve', 4], 'li1', 'li2', 'x1', 'ig1']);
});
test('guided setup validates the whole batch before changing any assignment', async () => {
  const operator = new Operator({ remote: () => fakeRemote() }); await operator.load({ host: 'fake-vps' });
  const before = structuredClone(operator.inventory);
  const data = { proxies: '203.0.113.3:12323:new-user:new-secret', accounts: { linkedin: 'second@example.test:p:second:', instagram: 'bad-format' }, includePending: true };
  assert.throws(() => operator.previewSetup(data), /Instagram/);
  assert.deepEqual(operator.inventory, before);
  assert.throws(() => operator.previewSetup({ ...data, proxies: '', accounts: { linkedin: 'second@example.test:p:second: third@example.test:p:third:' } }), /IP libres/);
  assert.deepEqual(operator.inventory, before);
  assert.throws(() => operator.previewSetup({ ...data, accounts: { unknown: 'x:y' } }), /Réseau inconnu/);
});
test('review expires when its server, inputs, inventory or selection changes', async () => {
  const operator = new Operator({ remote: () => fakeRemote() }); await operator.load({ host: 'fake-vps' });
  const data = { proxies: '', accounts: { x: 'x-person:p' }, includePending: true };
  const previewId = operator.previewSetup(data).previewId;
  assert.throws(() => operator.setupAndConnect({ ...data, previewId: 'unreviewed' }), /configuration a changé/);
  assert.throws(() => operator.setupAndConnect({ ...data, accounts: { x: 'other:p' }, previewId }), /configuration a changé/);
  operator.target = { host: 'different-vps' };
  assert.throws(() => operator.setupAndConnect({ ...data, previewId }), /configuration a changé/);
  operator.target = { host: 'fake-vps' };
  operator.setStatus('li1', { state: 'existing', message: 'stored' });
  assert.throws(() => operator.setupAndConnect({ ...data, previewId }), /configuration a changé/);
  operator.statuses.clear(); operator.import({ network: 'instagram', accounts: 'new:p' });
  assert.throws(() => operator.setupAndConnect({ ...data, previewId }), /configuration a changé/);
  assert.equal(operator.busy, false);
});
test('guided setup skips stored duplicates and can exclude pending existing accounts', async () => {
  const operator = new Operator({ remote: () => fakeRemote(), connect: async () => {} }); await operator.load({ host: 'fake-vps' });
  const data = { proxies: '', accounts: { x: 'new:p new:p' }, includePending: false };
  const preview = operator.previewSetup(data); assert.deepEqual(preview.accounts.map(a => a.key), ['x1']);
  assert.equal(preview.newAccounts, 1);
  operator.setStatus('li1', { state: 'existing', message: 'stored' });
  const duplicate = operator.previewSetup({ proxies: '', accounts: { linkedin: input }, includePending: false });
  assert.equal(duplicate.accounts.length, 0); assert.equal(duplicate.skipped, 1);
  assert.throws(() => operator.setupAndConnect({ proxies: '', accounts: { linkedin: input }, includePending: false, previewId: duplicate.previewId }), /Aucun compte/);
  operator.busy = true; assert.throws(() => operator.previewSetup(data), /en cours/);
  operator.busy = false;
});
test('guided HTTP setup requires review, keeps preview read-only and returns no secrets', async () => {
  const seen = [], operator = new Operator({ remote: () => fakeRemote(), connect: async ({ row }) => seen.push(row.key) });
  await operator.load({ host: 'fake-vps' }); const app = await createServer({ operator });
  const data = { proxies: '', accounts: { x: `new:${secret}` }, includePending: false };
  const post = (route, body, auth = true) => fetch(app.origin + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${app.token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('setup-preview', data, false)).status, 401);
    assert.equal((await post('setup-connect', data)).status, 400);
    assert.equal((await post('setup-preview', { ...data, accounts: [] })).status, 400);
    const response = await post('setup-preview', data); assert.equal(response.status, 200); const preview = await response.json();
    assert.equal(operator.inventory.accounts.length, 1); assert.ok(!JSON.stringify(preview).includes(secret));
    const launched = await post('setup-connect', { ...data, previewId: preview.previewId }); assert.equal(launched.status, 200);
    assert.ok(!(await launched.text()).includes(secret)); await operator.job; assert.deepEqual(seen, ['x1']);
  } finally { await app.close(); }
});
