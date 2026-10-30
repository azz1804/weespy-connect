import { randomUUID } from 'node:crypto';
import { cookieEvidence } from './cookie-evidence.mjs';
import { Remote } from './remote.mjs';
import { connectOnVps } from './vps-client.mjs';
import { fail, mergeImport, publicInventory, rowsOf, parseAccounts, parseProxies, identity, digest, displayError as safeError } from './model.mjs';
import { existingView, reconcileDiscovery } from './existing.mjs';

const storedStates = new Set(['existing', 'saved']);
const categories = new Set(['ip', 'vps', 'session', 'browser', 'identity', 'credentials', 'verification']);
export async function inspectProxy(row, signal, remote) { return remote.checkProxy(row, signal); }
export class Operator {
  constructor({ remote = target => new Remote(target), connect = connectOnVps, checkProxy = inspectProxy, now = () => new Date().toISOString() } = {}) {
    this.makeRemote = remote; this.connect = connect; this.checkProxy = checkProxy; this.now = now;
    this.inventory = { version: 1, proxies: [], accounts: [] }; this.statuses = new Map(); this.history = new Map(); this.ipHealth = new Map();
    this.busy = false; this.active = null; this.queue = []; this.message = 'Connexion au VPS…'; this.target = null;
    this.vps = { state: 'unknown', checkedAt: null }; this.healthController = new AbortController();
    this.discovery = { accounts: [], warnings: [] };
  }
  snapshot({ agent = false } = {}) {
    const data = publicInventory(this.inventory, this.statuses);
    data.accounts = data.accounts.map(row => ({ ...row, history: this.history.get(row.key) || [], ipHealth: this.ipHealth.get(row.ip) || { state: 'unknown' } }));
    data.accounts = existingView(data.accounts, this.discovery);
    data.proxies = data.proxies.map(proxy => ({ ...proxy, reservedNetworks: [...new Set(this.discovery.accounts.filter(a => a.ip === proxy.ip).map(a => a.network))] }));
    data.proxies = data.proxies.map(proxy => ({ ...proxy, availableNetworks: ['linkedin', 'x', 'instagram'].filter(network => !proxy.reservedNetworks.includes(network) && !this.inventory.accounts.some(a => a.network === network && this.inventory.proxies[a.index - 1].ip === proxy.ip)) }));
    if (agent) data.accounts = data.accounts.map(({ label, ...rest }) => rest);
    return { ...data, execution: 'vps', ...(!agent ? {browserUrl:this.browserUrl||null} : {}), target: this.target?.host ?? null, ...(!agent ? { connection: this.target } : {}), busy: this.busy, active: this.active, queue: this.queue,
      actions: this.pending?.actions || [], message: this.message, loaded: !!this.remote, vps: this.vps, checkingHealth: !!this.healthJob, ipChecks: this.ipChecks || null, discoveryWarnings: this.discovery.warnings };
  }
  availableKeys(inventory = this.inventory) { return new Set(existingView(publicInventory(inventory, this.statuses).accounts, this.discovery).filter(a => !a.readOnly).map(a => a.key)); }
  existingLabels(network) { return this.discovery.accounts.filter(a => a.network === network && a.identityKnown).map(a => a.label); }
  reservedIPs(network) { return this.discovery.accounts.filter(a => a.network === network && a.ip).map(a => a.ip); }
  requireDiscovery() { if (this.discovery.warnings.length) fail('Certaines sessions existantes ne peuvent pas être vérifiées. Recharge le VPS avant de lancer des connexions pour éviter les doublons.'); }
  requireIdle() { if (this.busy) fail('Une connexion est en cours. Arrête la file avant de modifier les accès.'); }
  setStatus(key, status) {
    const old = this.statuses.get(key);
    const next = { ...old, ...status, updatedAt: this.now() };
    if (!Object.hasOwn(status, 'category')) delete next.category;
    this.statuses.set(key, next);
    if (old?.state !== next.state || old?.message !== next.message) {
      const events = this.history.get(key) || [];
      this.history.set(key, [...events, { at: next.updatedAt, state: next.state, category: next.category, message: next.message }].slice(-15));
    }
  }
  applyRemoteStatuses(sessions) {
    if (!Array.isArray(sessions)) fail('État des sessions invalide.');
    const rows = rowsOf(this.inventory), found = new Set();
    for (const s of sessions) {
      const row = rows.find(r => r.network === s.network && r.index === s.index);
      if (!row) fail('Une session du VPS n’a pas d’affectation connue. Recharge le serveur.');
      found.add(row.key);
      if (s.problem === 'invalid') { this.setStatus(row.key, { cookieEvidence: null, state: 'error', category: 'session', message: 'Fichier de session illisible sur le VPS. Vérification du fichier nécessaire.' }); continue; }
      if (row.label !== s.label || row.isp_ip !== s.isp_ip || row.isp_alias !== s.isp_alias || typeof s.captured_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(s.captured_at) || !Number.isFinite(Date.parse(s.captured_at))) fail('Une session du VPS ne correspond pas au compte ou à son IP. Vérification nécessaire.');
      const old = this.statuses.get(row.key);
      const status = { capturedAt: s.captured_at, checkedAt: this.now(), cookieEvidence: cookieEvidence(row.network, s.cookieEvidence) };
      if (['vps_identity', 'browser_storage'].includes(s.verification?.scope) && typeof s.verification.checked_at === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s.verification.checked_at) && Number.isFinite(Date.parse(s.verification.checked_at))) { status.verifiedAt = s.verification.checked_at; status.verificationScope = s.verification.scope; }
      if (['error', 'human', 'skipped', 'stopped'].includes(old?.state) && old.capturedAt === s.captured_at) { this.statuses.set(row.key, { ...old, cookieEvidence: status.cookieEvidence }); continue; }
      if (s.cookie_state === 'expired') Object.assign(status, { state: 'expired', category: 'session', message: 'Session expirée sur le VPS. Clique sur Reconnecter.' });
      else if (s.cookie_state === 'missing') Object.assign(status, { state: 'error', category: 'session', message: 'Session incomplète sur le VPS. Clique sur Reconnecter.' });
      else if (old?.state === 'saved' && old.capturedAt === s.captured_at && Date.parse(this.now()) - Date.parse(old.verifiedAt || 0) < 300_000) Object.assign(status, { state: 'saved', message: old.verificationScope === 'vps_identity' ? 'Identité vérifiée récemment depuis le VPS. Session sauvegardée.' : 'Session reconnue dans Firefox sur le VPS et sauvegardée.' });
      else Object.assign(status, { state: 'existing', message: 'Session présente sur le VPS, sans expiration connue. Validité auprès du réseau non revérifiée.' });
      this.setStatus(row.key, status);
    }
    for (const row of rows) if (!found.has(row.key) && storedStates.has(this.statuses.get(row.key)?.state)) this.setStatus(row.key, { cookieEvidence: null, state: 'error', category: 'session', message: 'La session n’est plus présente sur le VPS. Reconnecte ce compte.' });
  }
  async load(target) {
    this.requireIdle(); this.cancelIPChecks(); this.busy = true;
    await this.healthJob;
    const previous = { inventory: this.inventory, statuses: this.statuses, history: this.history, ipHealth: this.ipHealth, discovery: this.discovery };
    try {
      const remote = this.makeRemote(target), result = await remote.load();
      this.inventory = result.inventory; this.statuses = new Map(); this.history = new Map(); this.ipHealth = new Map();
      this.discovery = reconcileDiscovery(JSON.stringify(remote.target) === JSON.stringify(this.target) ? this.discovery : { accounts: [], warnings: [] }, result.existing);
      this.applyRemoteStatuses(result.statuses); this.remote = remote; this.target = remote.target;
      this.vps = { state: 'ok', checkedAt: this.now() }; this.message = 'Comptes chargés. Les nouveaux comptes seront connectés dès leur ajout.';
    } catch (error) { Object.assign(this, previous); this.vps = { state: 'error', checkedAt: this.now(), message: safeError(error) }; throw error; }
    finally { this.busy = false; }
    return this.snapshot();
  }
  import(data) {
    this.requireIdle(); if (!this.remote) fail('Renseigne le VPS dans les réglages avant d’ajouter tes comptes.');
    this.requireDiscovery();
    this.inventory = mergeImport(this.inventory, data, this.reservedIPs(data.network), this.existingLabels(data.network)); this.message = 'Import préparé en mémoire.'; return this.snapshot();
  }
  importAndConnect(data) {
    this.requireIdle(); if (!this.remote) fail('Renseigne d’abord le VPS dans les réglages.');
    this.requireDiscovery();
    const records = parseAccounts(data.network, data.accounts);
    if (!records.length) fail('Colle au moins un compte à connecter.');
    const next = mergeImport(this.inventory, data, this.reservedIPs(data.network), this.existingLabels(data.network));
    const requested = new Set(records.map(r => identity(data.network, r)));
    const available = this.availableKeys(next);
    const keys = rowsOf(next).filter(r => available.has(r.key) && r.network === data.network && requested.has(identity(r.network, r.record)) && !storedStates.has(this.statuses.get(r.key)?.state)).map(r => r.key);
    this.inventory = next;
    if (!keys.length) { this.message = 'Aucun nouveau compte à connecter. Consulte les sessions existantes et les éventuelles affectations à vérifier dans le tableau.'; return this.snapshot(); }
    return this.start(keys);
  }
  prepareSetup(data) {
    this.requireIdle(); if (!this.remote) fail('Connecte le VPS avant de continuer.');
    this.requireDiscovery();
    if (!data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts) || typeof data.proxies !== 'string' || typeof data.includePending !== 'boolean') fail('Import incomplet. Reviens à la saisie des accès.');
    const names = { linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram' };
    if (Object.keys(data.accounts).some(key => !Object.hasOwn(names, key))) fail('Réseau inconnu dans l’import.');
    let next = this.inventory;
    const candidates = parseProxies(data.proxies);
    let hasAccounts = false;
    const requested = new Set(), existingRequested = new Set();
    for (const [network, name] of Object.entries(names)) {
      const text = data.accounts[network] ?? '';
      if (typeof text !== 'string') fail('Colle les comptes dans la zone du réseau correspondant.');
      try {
        const records = parseAccounts(network, text);
        for (const record of records) {
          const person = `${network}:${identity(network, record)}`;
          requested.add(person);
          const label = network === 'linkedin' ? record.profile : record.username;
          if (this.existingLabels(network).some(existing => existing.toLowerCase() === label.toLowerCase())
            && !this.inventory.accounts.some(a => a.network === network && identity(network, a.record) === identity(network, record))) existingRequested.add(`${network}:${label.toLowerCase()}`);
        }
        if (records.length) {
          hasAccounts = true;
          next = mergeImport(next, { proxies: data.proxies, network, accounts: text }, this.reservedIPs(network), this.existingLabels(network));
        }
      } catch (error) { fail(`${name} : ${safeError(error)}`); }
    }
    if (!hasAccounts) next = mergeImport(next, { proxies: data.proxies, network: 'linkedin', accounts: '' });
    const available = this.availableKeys(next);
    const keys = rowsOf(next).filter(r => available.has(r.key) && !storedStates.has(this.statuses.get(r.key)?.state) && (data.includePending || requested.has(`${r.network}:${identity(r.network, r.record)}`))).map(r => r.key);
    // Bind the review to this server, its inventory and the exact connection selection.
    const previewId = digest(JSON.stringify([this.target, this.inventory, next, keys, data.proxies, data.accounts, data.includePending]));
    const publicRows = publicInventory(next, this.statuses).accounts;
    const preview = { previewId, target: this.target.host, accounts: publicRows.filter(r => keys.includes(r.key)),
      totalAccounts: next.accounts.length, totalIPs: next.proxies.length, newAccounts: next.accounts.length - this.inventory.accounts.length,
      reusedIPs: new Set(publicRows.filter(r => keys.includes(r.key) && this.inventory.proxies.some(p => p.ip === r.ip)).map(r => r.ip)).size,
      unusedIPs: candidates.filter(p => !next.proxies.some(current => current.ip === p.ip)).length,
      newIPs: next.proxies.length - this.inventory.proxies.length, skipped: existingRequested.size + rowsOf(next).filter(r => (data.includePending || requested.has(`${r.network}:${identity(r.network, r.record)}`)) && (storedStates.has(this.statuses.get(r.key)?.state) || !available.has(r.key))).length };
    return { next, keys, preview };
  }
  previewSetup(data) { return this.prepareSetup(data).preview; }
  cancelIPChecks() {
    this.ipCheckController?.abort(); this.ipChecks = null;
  }
  checkSetupIPs(data) {
    const { next, keys, preview } = this.prepareSetup(data);
    if (data.previewId !== preview.previewId) fail('La configuration a changé. Reviens au récapitulatif.');
    this.cancelIPChecks();
    const selected = new Set(rowsOf(next).filter(r => keys.includes(r.key)).map(r => r.isp_ip));
    for (const p of next.proxies) if (!this.inventory.proxies.some(old => old.ip === p.ip)) selected.add(p.ip);
    const proxies = next.proxies.filter(p => selected.has(p.ip));
    const remote = this.remote, controller = new AbortController(); this.ipCheckController = controller;
    const checks = { runId: randomUUID(), previewId: preview.previewId, rows: proxies.map(p => ({ ip: p.ip, state: 'queued' })) }; this.ipChecks = checks;
    this.ipCheckJob = (async () => {
      for (const [i, proxy] of proxies.entries()) {
        if (controller.signal.aborted) return;
        checks.rows[i] = { ip: proxy.ip, state: 'checking', startedAt: this.now() };
        try {
          await remote.probeProxy(proxy, controller.signal);
          if (controller.signal.aborted) return;
          checks.rows[i] = { ip: proxy.ip, state: 'ok', checkedAt: this.now() };
        } catch (error) {
          if (controller.signal.aborted) return;
          checks.rows[i] = { ip: proxy.ip, state: 'error', checkedAt: this.now(), message: error.category === 'vps' ? 'VPS inaccessible. Vérifie l’accès SSH.' : error.category === 'ip' ? 'La sortie ne correspond pas à cette IP.' : 'Contrôle impossible : accès proxy ou service de vérification indisponible.' };
        }
      }
    })();
    return this.snapshot();
  }
  setupAndConnect(data) {
    const { next, keys, preview } = this.prepareSetup(data);
    if (data.previewId !== preview.previewId) fail('La configuration a changé. Reviens au récapitulatif pour la vérifier.');
    if (this.ipChecks && (this.ipChecks.previewId !== preview.previewId || this.ipChecks.rows.some(r => r.state !== 'ok'))) fail('Attends la fin du contrôle des IP et corrige les erreurs avant de lancer.');
    if (!keys.length) fail('Aucun compte à connecter. Ajoute des comptes ou inclus les comptes en attente.');
    this.inventory = next;
    return this.start(keys);
  }
  start(keys) {
    this.requireIdle(); if (!this.remote) fail('Charge d’abord le VPS.');
    this.requireDiscovery();
    const rows = rowsOf(this.inventory);
    const available = this.availableKeys();
    const selected = keys === undefined ? rows.filter(r => available.has(r.key) && !storedStates.has(this.statuses.get(r.key)?.state))
      : Array.isArray(keys) && keys.length && keys.length <= 75 && new Set(keys).size === keys.length ? keys.map(k => rows.find(r => r.key === k)) : null;
    if (!selected?.length || selected.some(r => !r)) fail('Sélectionne au moins un compte valide.');
    if (selected.some(r => !available.has(r.key))) fail('Ce compte est déjà géré par un service du VPS ou son IP est occupée. Consulte sa ligne avant toute reconnexion.');
    this.cancelIPChecks(); this.busy = true; this.controller = new AbortController(); this.queue = selected.map(r => r.key); this.message = 'Connexion des comptes…';
    const reconnectKeys = new Set(selected.filter(r => storedStates.has(this.statuses.get(r.key)?.state)).map(r => r.key));
    this.job = this.run(selected, reconnectKeys).finally(() => { this.busy = false; this.active = null; this.queue = []; this.pending = null; for (const [ip, health] of this.ipHealth) if (health.state === 'checking') this.ipHealth.set(ip, { state: 'unknown' }); });
    return this.snapshot();
  }
  async run(rows, reconnectKeys = new Set()) {
    const signal = this.controller.signal; let failed = 0;
    try {
      if (typeof this.remote.status === 'function') {
        this.applyRemoteStatuses(await this.remote.status(signal));
        this.discovery = reconcileDiscovery(this.discovery, this.remote.existing);
        const available = this.availableKeys();
        if (this.discovery.warnings.length || rows.some(r => !available.has(r.key) || (!reconnectKeys.has(r.key) && storedStates.has(this.statuses.get(r.key)?.state)))) { this.message = 'Des sessions existantes ou des IP occupées viennent d’être détectées. Consulte le tableau avant de relancer.'; return; }
      }
      await this.remote.reserve(this.inventory, signal); this.vps = { state: 'ok', checkedAt: this.now() };
      for (const row of rows) {
        signal.throwIfAborted(); this.active = row.key; this.queue = this.queue.filter(k => k !== row.key);
        const report = (state, message, detail = {}) => {
          if (Object.hasOwn(detail,'browserUrl')) this.browserUrl=detail.browserUrl;
          if (state==='browser_closed') return;
          if (state === 'checking') this.ipHealth.set(row.isp_ip, { state: 'checking' });
          const status = { state, message };
          if (detail.capturedAt) status.capturedAt=detail.capturedAt;
          if (categories.has(detail.category)) status.category = detail.category;
          if (detail.ipVerified) this.ipHealth.set(row.isp_ip, { state: 'ok', checkedAt: this.now() });
          if (state === 'saved') { status.verifiedAt = detail.verifiedAt || this.now(); status.verificationScope = detail.verificationScope || 'browser_storage'; this.vps = { state: 'ok', checkedAt: this.now() }; }
          this.setStatus(row.key, status); this.message = `${row.key} — ${message}`;
        };
        try {
          await this.connect({ remote: this.remote, target: this.target, row, signal, report, waitForUser: (actions, signal) => this.waitForUser(actions, signal),
            save: async (session, signal) => { const receipt = await this.remote.save(session, signal); this.statuses.set(row.key, { ...this.statuses.get(row.key), capturedAt: session.captured_at }); return receipt; } });
          if (this.statuses.get(row.key)?.state === 'saved' && typeof this.remote.status === 'function') {
            try { this.applyRemoteStatuses(await this.remote.status(signal)); }
            catch { this.statuses.set(row.key, { ...this.statuses.get(row.key), cookieEvidence: null }); }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          const category = categories.has(error.category) ? error.category : 'browser';
          report('error', safeError(error), { category }); failed++;
          if (category === 'ip') this.ipHealth.set(row.isp_ip, { state: 'error', checkedAt: this.now(), message: 'IP inaccessible ou sortie différente de l’IP attribuée.' });
          if (error.fatal) { this.vps = { state: 'error', checkedAt: this.now(), message: safeError(error) }; this.message = 'Transfert vers le VPS interrompu. Consulte l’erreur sur la ligne du compte.'; return; }
        }
      }
      this.message = failed ? `File terminée. ${failed} compte(s) à reconnecter ; détails sur chaque ligne.` : 'File terminée. Consulte le résultat sur chaque ligne.';
    } catch (error) {
      this.message = signal.aborted ? 'Connexions arrêtées.' : safeError(error);
      if (!signal.aborted) { this.vps = { state: 'error', checkedAt: this.now(), message: safeError(error) }; for (const row of rows) this.setStatus(row.key, { state: 'error', category: 'vps', message: safeError(error) }); }
      if (this.active && signal.aborted) this.setStatus(this.active, { state: 'stopped', message: 'Arrêté sans nouvel envoi confirmé' });
    }
  }
  waitForUser(actions, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending = null; reject(new DOMException('Aborted', 'AbortError')); };
      this.pending = { actions, finish: action => { signal.removeEventListener('abort', abort); this.pending = null; resolve(action); } };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  action(action, { agent = false, key } = {}) {
    if (action === 'stop') { this.controller?.abort(); this.message = 'Arrêt et fermeture du navigateur…'; return this.snapshot({ agent }); }
    if (key && key !== this.active) fail('Ce compte n’est plus celui qui attend une intervention.');
    if (agent && action === 'confirm') fail('La confirmation d’identité doit être faite dans l’application par le propriétaire.');
    if (!this.pending?.actions.includes(action)) fail('Cette action n’est pas disponible maintenant.');
    this.pending.finish(action); return this.snapshot({ agent });
  }
  refreshHealth({ proxies = false } = {}) {
    if (this.closed || this.busy || !this.remote || this.healthJob) return this.healthJob || Promise.resolve(this.snapshot());
    const remote = this.remote, signal = this.healthController.signal;
    this.healthJob = (async () => {
      try {
        const statuses = await remote.status(signal);
        if (this.closed || this.busy || this.remote !== remote) return;
        this.discovery = reconcileDiscovery(this.discovery, remote.existing);
        this.applyRemoteStatuses(statuses); this.vps = { state: 'ok', checkedAt: this.now() };
        if (proxies) {
          const seen = new Set(), available = this.availableKeys();
          for (const row of rowsOf(this.inventory).filter(row => available.has(row.key))) {
            if (this.closed || this.busy || this.remote !== remote || signal.aborted) break;
            if (seen.has(row.isp_ip)) continue; seen.add(row.isp_ip);
            this.ipHealth.set(row.isp_ip, { state: 'checking' });
            let result;
            try { await this.checkProxy(row, signal, remote); result = { state: 'ok', checkedAt: this.now() }; }
            catch { if (signal.aborted) return; result = { state: 'error', checkedAt: this.now(), message: 'IP inaccessible ou sortie différente de l’IP attribuée.' }; }
            if (!this.closed && !this.busy && this.remote === remote) this.ipHealth.set(row.isp_ip, result);
          }
        }
      } catch (error) { if (!this.closed && !this.busy && this.remote === remote) this.vps = { state: 'error', checkedAt: this.now(), message: safeError(error) }; }
    })().finally(() => { this.healthJob = null; });
    return this.healthJob.then(() => this.snapshot());
  }
  startMonitor(interval = 60_000) {
    clearInterval(this.monitor); let tick = 0;
    this.monitor = setInterval(() => { this.refreshHealth({ proxies: ++tick % 5 === 0 }); }, interval); this.monitor.unref?.();
  }
  async close() {
    this.closed = true; this.cancelIPChecks(); await this.ipCheckJob; clearInterval(this.monitor); this.controller?.abort(); this.healthController.abort(); await this.job; await this.healthJob;
    this.inventory = { version: 1, proxies: [], accounts: [] }; this.discovery = { accounts: [], warnings: [] }; this.remote = null;
  }
}
