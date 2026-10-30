import { mkdir, lstat, chmod, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NETWORKS, OperatorError, chromeArgs, launchChrome, readDebugger, startForwarder, verifyExit, totp, filterCookies, hasSession, sessionPayload } from '../connect.mjs';
import { digest, identity, fail } from './model.mjs';

// Runs only in the selected top-level page. Never return page text, input values,
// HTML, cookies, or arbitrary page-controlled instructions to the UI or an LLM.
export async function pageStep(network, label, action = null) {
  const hosts = { linkedin: ['www.linkedin.com', 'linkedin.com'], x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], instagram: ['www.instagram.com', 'instagram.com'] };
  if (location.protocol !== 'https:' || !hosts[network]?.includes(location.hostname)) return { stage: 'untrusted' };
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.disabled;
  const first = selectors => [...document.querySelectorAll(selectors)].filter(visible);
  const unique = selectors => { const list = first(selectors); return list.length === 1 ? list[0] : null; };
  const text = document.body?.innerText?.toLowerCase() || '';
  const path = location.pathname;
  const login = network === 'linkedin' ? /^\/(login|uas\/login|checkpoint\/)/.test(path)
    : network === 'x' ? (/^\/i\/flow\/login/.test(path) || (/^\/i\/jf\/onboarding\/web\/?$/.test(path) && new URL(location.href).searchParams.get('mode') === 'login')) : /^\/accounts\/(login|two_factor|login_two_factor)|^\/challenge/.test(path);
  const challenge = first('iframe[src*="captcha"],iframe[src*="arkoselabs"],iframe[src*="hcaptcha"],iframe[title*="challenge"],iframe[title*="reCAPTCHA"]').length > 0
    || (login && /captcha|verify you are human|vérifiez que vous êtes humain|confirmez que vous êtes humain|security puzzle|suspicious activity|activité suspecte|account suspended|compte suspendu/.test(text));
  const error = /not the right password|incorrect password|wrong password|mot de passe incorrect|incorrect code|invalid code|code incorrect|code invalide|too many attempts|trop de tentatives|account locked|compte verrouillé/.test(text);
  const credentialChange = first('input[autocomplete="new-password"],input[name="newPassword"]').length > 0
    || /reset your password|change your password|choisissez un nouveau mot de passe|changer votre mot de passe/.test(text);

  if (challenge || (login && (error || credentialChange))) return { stage: 'human', reason: credentialChange ? 'credential_change' : error ? 'rejected' : 'challenge' };
  const ownProfile = { linkedin: '.feed-identity-module a[href],.profile-card a[href],[data-control-name="identity_welcome_message"]', x: 'a[data-testid="AppTabBar_Profile_Link"]', instagram: 'nav a[href],[role="navigation"] a[href]' };
  const links = [...document.querySelectorAll(ownProfile[network])];
  const profilePaths = links.map(a => { try { const u = new URL(a.href, location.href); return u.origin === location.origin ? u.pathname.replace(/\/$/, '').toLowerCase() : null; } catch { return null; } }).filter(Boolean);
  const expectedPath = (network === 'linkedin' ? '/in/' : '/') + label.toLowerCase();
  const identityPaths = network === 'linkedin' ? profilePaths.filter(path => /^\/in\/[^/]+$/.test(path)) : profilePaths;
  const identityMismatch = identityPaths.length > 0 && !identityPaths.includes(expectedPath);
  const identityVerified = profilePaths.includes(expectedPath);
  if (!login) return { stage: 'outside', identityVerified, identityMismatch: network !== 'instagram' && identityMismatch };
  let stage = 'human', fields = [], submit;
  const button = (selectors, re) => {
    const candidates = first(selectors).filter(e => !re || re.test((e.innerText || e.value || e.getAttribute('aria-label') || '').trim()));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const appCode = /authenticator|authentication app|application d[’']authentification|code generator|générateur de code/.test(text);
  const otp = unique('input[autocomplete="one-time-code"],input[name="verificationCode"],input[name="pin"],input#input__phone_verification_pin');
  if (otp && appCode) {
    stage = 'totp'; fields = [otp]; submit = button('button[type="submit"],input[type="submit"],[role="button"]', /^(verify|vérifier|confirm|confirmer|next|suivant|continuer|continue|submit|envoyer)$/i);
  } else if (network === 'linkedin') {
    const user = unique('input#username'), password = unique('input#password');
    if (user && password) { stage = 'credentials'; fields = [user, password]; }
    else if (password && first('input#username').length === 0 && /welcome back|bon retour/.test(text)) { stage = 'password'; fields = [password]; }
  } else if (network === 'instagram') {
    const user = unique('input[name="username"]'), password = unique('input[name="password"]');
    if (user && password) { stage = 'credentials'; fields = [user, password]; submit = button('button[type="submit"]', /^(log in|se connecter|connexion)$/i); }
  } else if (network === 'x') {
    const password = unique('input[name="password"]') || unique('input[type="password"][autocomplete="current-password"],input[type="password"]');
    const user = unique('input[autocomplete="username"]') || unique('input[type="email"],input[name="text"],input[type="text"]');
    if (password) { stage = 'password'; fields = [password]; submit = button('[data-testid="LoginForm_Login_Button"]'); }
    else if (user && !/unusual|unusual activity|inhabituelle|confirm your|confirmez/.test(text)) {
      stage = 'username'; fields = [user]; submit = button('button,[role="button"]', /^(next|suivant|continue|continuer)$/i);
    }
  }
  // Buttons can be disabled until inputs are filled; query again after filling.
  if (!action) return { stage, identityVerified: false };
  if (action.stage !== stage || !fields.length || !Array.isArray(action.values) || action.values.length !== fields.length || action.values.some(v => typeof v !== 'string')) return { stage: 'changed' };
  if (fields.some(e => e.form && new URL(e.form.action || location.href, location.href).origin !== location.origin) || (fields.length === 2 && fields[0].form !== fields[1].form)) return { stage: 'untrusted' };
  const originalURL = location.href;
  fields.forEach((e, i) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, action.values[i]);
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Let controlled inputs update before re-resolving the enabled submit control.
  await new Promise(resolve => setTimeout(resolve, 180));
  if (location.href !== originalURL || fields.some((e,i) => !visible(e) || e.value !== action.values[i])) return { stage: 'changed' };
  submit = null;
  // An actual visible submit control is required. Never submit a hidden or unknown form.
  if (!submit) {
    if (network === 'x' && stage === 'password') submit = button('[data-testid="LoginForm_Login_Button"]') || button('button[type="submit"],button,[role="button"]', /^(log in|sign in|se connecter|connexion|continue|continuer)$/i);
    else submit = button('button[type="submit"],input[type="submit"],button,[role="button"]', stage === 'username' ? /^(next|suivant|continue|continuer)$/i : /^(sign in|log in|se connecter|s[’']identifier|connexion|verify|vérifier|confirm|confirmer|continue|continuer|next|suivant|submit|envoyer)$/i);
  }
  if (!submit || (submit.form && new URL(submit.form.action || location.href, location.href).origin !== location.origin)) return { stage: 'human', reason: 'submit' };
  submit.click(); return { stage: 'submitted' };
}

export async function cdpSocket(address, { signal, timeout = 12_000 } = {}) {
  const url = new URL(address);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) fail('Adresse Chrome invalide.');
  const socket = new WebSocket(address), pending = new Map(); let counter = 0;
  const rejectAll = () => { for (const item of pending.values()) item.done(new OperatorError('Chrome ne répond plus.')); pending.clear(); };
  const abort = () => { rejectAll(); socket.close(); };
  socket.addEventListener('message', event => {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    const item = pending.get(data.id); if (!item) return;
    pending.delete(data.id); item.done(data.error ? new OperatorError('Action Chrome impossible.') : null, data.result);
  });
  socket.addEventListener('error', rejectAll); socket.addEventListener('close', rejectAll);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); socket.removeEventListener('open', ready); socket.removeEventListener('error', broken); socket.removeEventListener('close', broken); signal?.removeEventListener('abort', broken); error ? reject(error) : resolve(); };
      const ready = () => finish(), broken = () => finish(new OperatorError('Ouverture de Chrome impossible.'));
      const timer = setTimeout(broken, timeout);
      socket.addEventListener('open', ready, { once: true }); socket.addEventListener('error', broken, { once: true }); socket.addEventListener('close', broken, { once: true }); signal?.addEventListener('abort', broken, { once: true });
      if (signal?.aborted) broken();
    });
  } catch (e) { signal?.removeEventListener('abort', abort); socket.close(); throw e; }
  return {
    call(method, params = {}) {
      if (!['Runtime.evaluate', 'Storage.getCookies', 'Browser.close', 'Page.navigate'].includes(method)) return Promise.reject(new OperatorError('Action Chrome interdite.'));
      return new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => { pending.delete(id); reject(new OperatorError('Chrome ne répond plus.')); }, timeout);
        const done = (err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); };
        if (signal?.aborted || socket.readyState !== 1) { done(new OperatorError('Chrome fermé.')); return; }
        pending.set(id, { done });
        try { socket.send(JSON.stringify({ id, method, params })); } catch { pending.delete(id); done(new OperatorError('Chrome fermé.')); }
      });
    },
    close() { signal?.removeEventListener('abort', abort); abort(); },
  };
}

export async function profileFor(target, row, home = homedir()) {
  // Separate from old manual profiles; changing account, server or IP cannot reuse a login.
  const base = join(home, 'WeespyAccounts'), profiles = join(base, 'automatic');
  const profile = join(profiles, digest(JSON.stringify([target, row.network, identity(row.network, row.record), row.isp_ip])).slice(0, 32));
  for (const dir of [base, profiles, profile]) {
    await mkdir(dir, { recursive: true, mode: 0o700 }); const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid()) fail('Dossier Chrome non sûr.');
    await chmod(dir, 0o700);
  }
  const lock = join(profile, '.operator-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { fail('Ce profil est déjà ouvert ou verrouillé.'); }
  try {
    try { await lstat(join(profile, 'SingletonLock')); fail('Ce profil Chrome est déjà ouvert.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const defaultDir = join(profile, 'Default');
    await mkdir(defaultDir, { mode: 0o700, recursive: true });
    const defaultInfo = await lstat(defaultDir);
    if (defaultInfo.isSymbolicLink() || !defaultInfo.isDirectory() || defaultInfo.uid !== process.getuid()) fail('Dossier Chrome non sûr.');
    await chmod(defaultDir, 0o700);
    await writeFile(join(defaultDir, 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }), { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    return { path: profile, release: () => rm(lock, { recursive: true, force: true }) };
  } catch (e) { await rm(lock, { recursive: true, force: true }); throw e; }
}

export async function openSession(target, row, signal, report, dependencies = {}) {
  const deps = { profileFor, startForwarder, verifyExit, launchChrome, readDebugger, cdpSocket, ...dependencies };
  let profile, proxy, browser, browserCDP, pageCDP, closing;
  const close = () => closing ||= (async () => {
    if (browser && !browser.ended && browserCDP) {
      try { await browserCDP.call('Browser.close'); } catch { /* Closure can disconnect before acknowledgement. */ }
      await browser.wait(3000);
    }
    pageCDP?.close(); browserCDP?.close();
    let stopped = !browser;
    try { if (browser) { await browser.stop(); stopped = true; } }
    finally { await proxy?.close(); if (stopped) await profile?.release(); }
  })();
  try {
    report('checking', 'Vérification de l’IP avec Impit…');
    profile = await deps.profileFor(target, row);
    proxy = await deps.startForwarder(row.upstream);
    try { await deps.verifyExit(row, proxy.port, undefined, signal); }
    catch (error) { if (error instanceof OperatorError) error.category = 'ip'; throw error; }
    report('connecting', 'IP vérifiée. Ouverture de Chrome…', { ipVerified: true });
    signal.throwIfAborted();
    await rm(join(profile.path, 'DevToolsActivePort'), { force: true });
    const args = chromeArgs(profile.path, proxy.port, row.network);
    args.unshift('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1');
    browser = deps.launchChrome(args);
    const address = await deps.readDebugger(profile.path, browser, { signal });
    browserCDP = await deps.cdpSocket(address, { signal });
    const endpoint = new URL(address);
    let page;
    for (let attempt = 0; attempt < 30 && !page; attempt++) {
      const pages = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).then(r => r.json());
      const candidates = pages.filter(p => {
        if (p.type !== 'page' || !p.webSocketDebuggerUrl) return false;
        try { const url = new URL(p.url); return url.protocol === 'https:' && NETWORKS[row.network].domains.some(d => url.hostname === d || url.hostname === `www.${d}`); } catch { return false; }
      });
      page = candidates.find(p => p.url === NETWORKS[row.network].login) || (candidates.length === 1 ? candidates[0] : undefined);
      if (!page) await delay(200, undefined, { signal });
    }
    if (!page || new URL(page.webSocketDebuggerUrl).port !== endpoint.port) fail('Fenêtre de connexion introuvable.');
    pageCDP = await deps.cdpSocket(page.webSocketDebuggerUrl, { signal });
    const evaluate = async action => {
      const result = await pageCDP.call('Runtime.evaluate', { expression: `(${pageStep.toString()})(${JSON.stringify(row.network)},${JSON.stringify(row.label)},${JSON.stringify(action ?? null)})`, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails || !result.result?.value) fail('La page de connexion ne répond plus.');
      return result.result.value;
    };
    return { close, restartLogin: () => pageCDP.call('Page.navigate', { url: NETWORKS[row.network].login }), snapshot: () => evaluate(), submit: action => evaluate(action), cookies: async () => filterCookies(row.network, (await browserCDP.call('Storage.getCookies')).cookies) };
  } catch (e) { await close(); throw e; }
}

export async function connectAccount({ target, row, signal, report, waitForUser, save, open, sleep = delay, now = Date.now, stabilityMs = 10_000, timeoutMs = 600_000 }) {
  if (typeof open !== 'function') throw new OperatorError('Un navigateur sur le VPS est requis. Les connexions locales sont désactivées.');
  const session = await open(target, row, signal, report);
  const attempts = new Set(); let unknown = 0, snapshotErrors = 0, stableSince = null, seenCookies = false;
  let totpSubmitted = false, continuationUsed = false, continuationArmed = false, confirmed = false, unsafe = false, closed = false;
  const started = now(); let cycles = 0;
  const problem = (message, category = 'session') => { const e = new OperatorError(message); e.category = category; throw e; };
  try {
    while (true) {
      signal.throwIfAborted();
      if (now() - started > timeoutMs || ++cycles > 600) problem('Délai de connexion dépassé. Aucun nouvel export confirmé.', 'browser');
      let state;
      try { state = await session.snapshot(); snapshotErrors = 0; }
      catch (e) { if (++snapshotErrors <= 3) { await sleep(1000, undefined, { signal }); continue; } throw e; }
      if (state.stage === 'untrusted') problem('La page a quitté le domaine attendu. Aucune donnée saisie.', 'browser');
      if (state.identityMismatch) problem('Le profil connecté ne correspond pas au compte attendu. Aucun export.', 'identity');
      const cookies = await session.cookies();
      const complete = hasSession(row.network, cookies, now()/1000, row.network === 'linkedin' ? ['li_at', 'JSESSIONID'] : NETWORKS[row.network].required);
      if (seenCookies && !complete) problem('Le cookie de session a disparu pendant la connexion. Aucun export ; compte à vérifier sur le réseau.');
      if (state.stage === 'outside' && complete) {
        seenCookies = true;
        if (!state.identityVerified && !confirmed) {
          report('human', 'Vérifie le compte connecté dans Chrome, puis confirme son identité.', { category: 'identity' });
          if (await waitForUser(['confirm', 'skip'], signal) === 'skip') { report('skipped', 'Compte passé'); return 'skipped'; }
          confirmed = true; stableSince = null; continue;
        }
        if (stableSince === null) { stableSince = now(); report('checking', 'Vérification de la stabilité de la session…'); }
        if (now() - stableSince < stabilityMs) { await sleep(1000, undefined, { signal }); continue; }
        // Capture the newest jar, then stop the browser before checking from the VPS.
        const payload = sessionPayload(row, cookies);
        await session.close(); closed = true; signal.throwIfAborted();
        report('saving', row.network === 'linkedin' ? 'Vérification de l’identité depuis le VPS, puis sauvegarde…' : 'Sauvegarde et contrôle du fichier sur le VPS…');
        const receipt = await save(payload, signal);
        if (!receipt || receipt.stored !== true) problem('Le VPS n’a pas confirmé la sauvegarde.', 'vps');
        if (row.network === 'linkedin' && receipt.scope !== 'vps_identity') problem('Identité LinkedIn non vérifiée depuis le VPS.');
        report('saved', row.network === 'linkedin' ? 'Identité vérifiée depuis le VPS et session sauvegardée.' : 'Session stable dans Chrome et sauvegarde confirmée sur le VPS.', { verifiedAt: receipt.checkedAt, verificationScope: receipt.scope });
        return 'saved';
      }
      stableSince = null; confirmed = false;
      if (['rejected','challenge','credential_change'].includes(state.reason)) unsafe = true;
      const credentialStage = ['credentials','password'].includes(state.stage);
      const credentialUsed = attempts.has('credentials') || attempts.has('password');
      // One continuation after an actually submitted 2FA, same browser/profile/IP.
      // A rejection/challenge never enables this path, including after manual Resume.
      if (row.network === 'linkedin' && totpSubmitted && !unsafe && !continuationUsed && !complete) {
        if (credentialStage && credentialUsed) { continuationUsed = true; continuationArmed = true; }
        else if (state.stage === 'outside' && unknown >= 9 && session.restartLogin) {
          continuationUsed = true; continuationArmed = true; unknown = 0;
          report('connecting', 'Reprise unique après la 2FA sur le même profil et la même IP…');
          await session.restartLogin(); await sleep(1000, undefined, { signal }); continue;
        }
      }
      const automatic = ['credentials', 'username', 'password', 'totp'].includes(state.stage);
      const canSubmit = !attempts.has(state.stage) && !(row.network === 'linkedin' && credentialStage && credentialUsed) || continuationArmed && credentialStage;
      if (automatic && !unsafe && canSubmit && (state.stage !== 'totp' || row.record.totp_secret)) {
        const username = row.network === 'linkedin' ? row.record.email : row.record.username;
        let values = state.stage === 'credentials' ? [username, row.record.password] : [state.stage === 'username' ? username : row.record.password];
        if (state.stage === 'totp') {
          let code = totp(row.record.totp_secret);
          if (code.remaining < 8) { await sleep((code.remaining + 1) * 1000, undefined, { signal }); code = totp(row.record.totp_secret); }
          values = [code.code];
        }
        report('connecting', state.stage === 'totp' ? 'Validation du code de l’application 2FA…' : 'Connexion dans Chrome…');
        const result = await session.submit({ stage: state.stage, values }); values.fill('');
        if (result?.stage === 'submitted') {
          attempts.add(state.stage); if (state.stage === 'totp') totpSubmitted = true;
          if (credentialStage) continuationArmed = false;
          unknown = 0; await sleep(2500, undefined, { signal }); continue;
        }
        if (result?.stage === 'untrusted') problem('Formulaire de connexion non sûr ; aucune validation.', 'browser');
        if (result?.stage !== 'changed') unsafe = true;
      }
      if (++unknown < 10 && !unsafe) { await sleep(1000, undefined, { signal }); continue; }
      const message = state.reason === 'rejected' ? 'Le réseau a refusé cet essai. Vérifie les accès dans Chrome ; aucune nouvelle tentative automatique.'
        : state.reason === 'credential_change' ? 'Le réseau demande un changement de mot de passe. Effectue-le toi-même dans Chrome.'
        : 'Connexion non validée. Termine la vérification dans Chrome, puis reprends, ou passe ce compte.';
      report('human', message, { category: state.reason === 'rejected' ? 'credentials' : 'verification' });
      if (await waitForUser(['resume', 'skip'], signal) === 'skip') { report('skipped', 'Compte passé'); return 'skipped'; }
      unknown = 0;
    }
  } finally { if (!closed) await session.close(); }
}
