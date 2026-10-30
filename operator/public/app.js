const $ = id => document.getElementById(id);
const initial = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(initial)) { sessionStorage.setItem('weespy-local', initial); history.replaceState(null, '', '/'); }
const token = sessionStorage.getItem('weespy-local');
const labels = { ready: 'À connecter', existing: 'Session sur VPS', saved: 'Connexion validée', human: 'À vérifier', checking: 'Contrôle IP…', connecting: 'Connexion…', saving: 'Sauvegarde sur VPS…', error: 'Erreur', expired: 'Session expirée', skipped: 'À reprendre', stopped: 'Arrêté', disabled: 'Désactivé', unavailable: 'État non vérifié', conflict: 'IP déjà utilisée' };
const networks = { linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram' };
const categoryNames = { ip: 'IP', vps: 'VPS', session: 'Session', browser: 'Connexion', credentials: 'Identifiants', identity: 'Identité', verification: 'Vérification' };
let state, pending = false, fetching = false, filter = 'all', tableSignature = '', lastShownMessage = '';
const dashboardNetworks = ['instagram', 'x', 'linkedin'];
const savedNetwork = sessionStorage.getItem('weespy-network-filter');
let dashboardNetwork = dashboardNetworks.includes(savedNetwork) ? savedNetwork : 'all';
const accountCollator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
let view = 'home', step = 1, network = 'linkedin', review = null, networkSignature = '';
const issues = a => ['error', 'expired', 'human', 'skipped', 'stopped', 'disabled', 'unavailable', 'conflict'].includes(a.state) || a.ipHealth?.state === 'error';
const stored = a => ['saved', 'existing'].includes(a.state) || (a.readOnly && a.sessionPresent && a.state !== 'unavailable');
const connectable = a => !a.readOnly && !stored(a);
const attention = a => connectable(a);
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Opération impossible.'); return result;
}
async function act(work, errorId) {
  if (pending) return; pending = true; updateSetupContext(); disable();
  if (errorId) $(errorId).hidden = true;
  try { await work(); await refresh(); }
  catch (error) { if (errorId) { $(errorId).textContent = error.message; $(errorId).hidden = false; $(errorId).tabIndex = -1; $(errorId).focus(); } else notice(error.message || 'Connexion locale interrompue.', true); }
  finally { pending = false; updateSetupContext(); disable(); }
}
function disable() {
  const busy = !!(pending || state?.busy);
  ['load', 'host', 'port', 'identity', 'claude', 'codex', 'setup-host', 'setup-port', 'setup-identity', 'setup-proxies', 'setup-linkedin', 'setup-x', 'setup-instagram', 'include-pending'].forEach(id => $(id).disabled = busy);
  ['add-open', 'empty-add', 'home-start', 'home-server-edit'].forEach(id => $(id).disabled = busy || !state);
  $('settings-open').disabled = pending || view === 'setup';
  $('connect-pending').disabled = busy || !!state?.discoveryWarnings?.length; $('stop').disabled = pending;
  $('setup-next').disabled = busy || (step === 3 && (!review?.accounts.length || !reviewIPsReady()));
  $('retry-ips').disabled = busy || !review || reviewChecks().some(r => ['queued', 'checking'].includes(r.state));
  $('setup-back').disabled = pending; $('setup-cancel').disabled = pending;
  document.querySelectorAll('[data-connect]').forEach(button => button.disabled = busy || !!state?.discoveryWarnings?.length);
  document.querySelectorAll('[data-action], [data-view]').forEach(button => button.disabled = pending);
}
function rowAction(label, key, action, primary = false) {
  const button = element('button', label, primary ? 'primary small' : 'secondary small'); button.type = 'button';
  if (action === 'connect') button.dataset.connect = key;
  else { button.dataset.action = action; button.dataset.key = key; }
  button.setAttribute('aria-label', label + ' ' + key); return button;
}
const networkAccounts = () => state.accounts.filter(a => dashboardNetwork === 'all' || a.network === dashboardNetwork);
function renderRows() {
  const search = $('search').value.trim().toLowerCase();
  const selected = networkAccounts();
  const rows = selected.filter(a => (filter === 'all' || (filter === 'attention' ? attention(a) : filter === 'issues' ? issues(a) : stored(a))) && `${a.label} ${a.key} ${a.ip} ${networks[a.network]}`.toLowerCase().includes(search))
    .sort((a, b) => dashboardNetworks.indexOf(a.network) - dashboardNetworks.indexOf(b.network) || accountCollator.compare(a.label, b.label) || accountCollator.compare(a.key, b.key));
  const signature = JSON.stringify([rows, state.active, state.actions, state.queue, state.browserUrl, filter, search, dashboardNetwork]);
  if (signature === tableSignature) return; tableSignature = signature;
  const openDetails = new Set([...document.querySelectorAll('details[data-history][open]')].map(d => d.dataset.history));
  const fragment = document.createDocumentFragment();
  let previousNetwork;
  for (const account of rows) {
    if (dashboardNetwork === 'all' && account.network !== previousNetwork) {
      const group = element('tr', undefined, 'network-group'), cell = element('td'); cell.colSpan = 5;
      const count = rows.filter(a => a.network === account.network).length;
      cell.append(element('strong', networks[account.network]), element('span', `${count} compte${count > 1 ? 's' : ''}`));
      group.append(cell); fragment.append(group); previousNetwork = account.network;
    }
    const tr = element('tr'); tr.dataset.accountNetwork = account.network; tr.dataset.accountKey = account.key; if (state.active === account.key) tr.classList.add('active-row');
    const who = element('td'), name = element('span', account.label, 'account-name'), meta = element('span', `${networks[account.network]} · ${account.external ? 'Déjà sur le VPS' : account.key}`, 'subtext');
    name.title = account.label; who.append(name, meta); if (account.sourceLabel) who.append(element('span', account.sourceLabel, 'subtext'));
    const ip = element('td'), ipLine = element('span', account.ip || 'Non renseignée', 'ip-address'), ipMeta = element('span', account.alias || '', 'subtext');
    ipLine.prepend(element('i', undefined, account.ipHealth?.state === 'checking' ? 'spinner' : 'dot ' + (account.ipHealth?.state || 'unknown')));
    ip.title = account.ipHealth?.state === 'ok' ? 'Sortie IP vérifiée à ' + time(account.ipHealth.checkedAt) : account.ipHealth?.message || 'IP pas encore vérifiée'; ip.append(ipLine, ipMeta);
    const status = element('td');
    const text = state.queue.includes(account.key) ? 'En attente' : labels[account.state] || account.state;
    const badge = element('span', text, 'state ' + account.state);
    if (['checking', 'connecting', 'saving'].includes(account.state) && !state.queue.includes(account.key)) { badge.prepend(spinner()); badge.setAttribute('aria-busy', 'true'); }
    status.append(badge);
    if (account.state === 'saved') status.append(element('span', 'Validée à ' + time(account.verifiedAt), 'subtext'));
    else if (account.capturedAt) status.append(element('span', (account.readOnly ? 'Session du ' : 'Envoyée le ') + new Date(account.capturedAt).toLocaleDateString('fr-FR'), 'subtext'));
    const detail = element('td', undefined, 'detail-cell');
    const category = categoryNames[account.category];
    detail.append(element('p', account.state === 'ready' ? '—' : (category ? category + ' · ' : '') + account.message, issues(account) ? 'row-message problem' : 'row-message'));
    detail.append(cookieProof(account));
    if (account.serviceCheckedAt) detail.append(element('span', 'Dernier retour du service : ' + new Date(account.serviceCheckedAt).toLocaleDateString('fr-FR') + ' à ' + time(account.serviceCheckedAt), 'subtext'));
    if (account.ipHealth?.state === 'error' && account.category !== 'ip') detail.append(element('p', 'IP · ' + account.ipHealth.message, 'row-message problem'));
    if (account.history?.length) {
      const history = element('details'); history.dataset.history = account.key; history.open = openDetails.has(account.key);
      history.append(element('summary', 'Historique'));
      const list = element('ol', undefined, 'history');
      for (const event of account.history.slice().reverse()) { const item = element('li'); item.append(element('time', time(event.at)), element('span', event.message)); list.append(item); }
      history.append(list); detail.append(history);
    }
    const action = element('td', undefined, 'row-actions');
    if (account.readOnly) action.append(element('span', account.source ? 'Géré sur le VPS' : account.category === 'identity' ? 'Profil à identifier' : 'Affectation à vérifier', 'managed-label'));
    else if (state.active === account.key && state.actions.length) {
      if (/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?autoconnect=true&resize=scale$/.test(state.browserUrl || '')) {
        const view=element('a','Voir Firefox sur le VPS','secondary'); view.href=state.browserUrl; view.target='_blank'; view.rel='noopener noreferrer'; action.append(view);
      }
      if (state.actions.includes('resume')) action.append(rowAction('Reprendre', account.key, 'resume', true));
      if (state.actions.includes('confirm')) action.append(rowAction('Confirmer le compte', account.key, 'confirm', true));
      action.append(rowAction('Passer', account.key, 'skip'));
    } else action.append(rowAction(account.state === 'ready' ? 'Connecter' : 'Reconnecter', account.key, 'connect'));
    tr.append(who, ip, status, detail, action); fragment.append(tr);
  }
  $('account-rows').replaceChildren(fragment); $('empty').hidden = state.accounts.length > 0 || !state.loaded;
  $('no-results').hidden = rows.length > 0 || !state.accounts.length;
}
function render() {
  const selected = networkAccounts();
  for (const name of ['all', ...dashboardNetworks]) {
    $('network-count-' + name).textContent = name === 'all' ? state.accounts.length : state.accounts.filter(a => a.network === name).length;
    document.querySelector(`[data-dashboard-network="${name}"]`).setAttribute('aria-pressed', String(dashboardNetwork === name));
  }
  $('count-all').textContent = selected.length;
  $('count-attention').textContent = selected.filter(attention).length;
  $('count-stored').textContent = selected.filter(stored).length;
  $('count-issues').textContent = selected.filter(issues).length;
  $('existing-warning').hidden = !state.discoveryWarnings?.length;
  $('existing-warning').textContent = 'Certaines sources de sessions du VPS ne peuvent pas être lues. Le dernier état est conservé et les nouvelles connexions sont suspendues pour éviter les doublons.';
  const destination = state.target === 'mon-vps' ? 'VPS' : state.target || 'VPS';
  $('vps-status').textContent = `${destination} · ${state.vps?.state === 'ok' ? 'accessible' : state.vps?.state === 'error' ? 'à vérifier' : 'connexion…'}`;
  $('vps-status').className = 'server-status ' + (state.vps?.state || 'unknown');
  $('vps-error').hidden = state.vps?.state !== 'error'; $('vps-error').textContent = state.vps?.message || 'Le VPS ne répond plus. Ouvre les réglages pour vérifier la connexion.';
  const remaining = selected.filter(connectable).length;
  $('connect-pending').hidden = !remaining || state.busy; $('connect-pending').textContent = `Connecter ${remaining === 1 ? 'le compte' : 'les ' + remaining + ' comptes'}${dashboardNetwork === 'all' ? '' : ' ' + networks[dashboardNetwork]} en attente`;
  $('stop').hidden = !state.busy;
  $('progress').hidden = !state.busy; $('progress').textContent = state.active ? `${state.active} · ${state.accounts.find(a => a.key === state.active)?.message || 'Connexion…'} · ${state.queue.length} en attente` : 'Connexion au VPS…';
  if (lastShownMessage !== state.message) { lastShownMessage = state.message; notice(state.busy || /^Comptes chargés/.test(state.message) ? '' : state.message); }
  $('summary').textContent = `${selected.length} compte${selected.length > 1 ? 's' : ''}${dashboardNetwork === 'all' ? '' : ' ' + networks[dashboardNetwork]} · ${new Set(selected.map(a => a.ip).filter(Boolean)).size} IP · ${selected.filter(stored).length} session${selected.filter(stored).length > 1 ? 's' : ''} sur le VPS`;
  $('last-check').textContent = state.vps?.checkedAt ? `VPS contrôlé à ${time(state.vps.checkedAt)} · suivi automatique` : 'Contrôle du VPS en cours…';
  renderHome(); renderRows(); if (review && step === 3) renderIPChecks(); updateSetupContext(); disable();
}
async function refresh() {
  if (fetching) return; fetching = true;
  try { state = await api('state'); render(); } finally { fetching = false; }
}

function showView(next, focus = true) {
  view = next;
  for (const name of ['home', 'accounts', 'setup']) $(name + '-view').hidden = name !== next;
  document.querySelectorAll('[data-view]').forEach(button => { if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (focus) { $(next === 'home' ? 'home-title' : next === 'accounts' ? 'accounts-title' : 'setup-title').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  disable();
}
function cancelChecks() { const runId = state?.ipChecks?.runId; if (runId) api('setup-cancel-checks', { runId }).catch(() => {}); }
function clearDraft() {
  if (review) cancelChecks();
  for (const id of ['setup-proxies', 'setup-linkedin', 'setup-x', 'setup-instagram']) $(id).value = '';
  review = null; $('review-rows').replaceChildren(); updateEntryCounts();
}
function navigate(next) { if (view === 'setup') clearDraft(); showView(next); }
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); if (!pending) navigate('home'); });
function openAccounts(nextFilter = 'all') { dashboardNetwork = 'all'; sessionStorage.setItem('weespy-network-filter', dashboardNetwork); filter = nextFilter; $('search').value = ''; updateFilters(); if (state) render(); navigate('accounts'); }
document.querySelectorAll('[data-overview]').forEach(button => button.addEventListener('click', () => openAccounts(button.dataset.overview === 'pending' ? 'attention' : button.dataset.overview)));
$('activity-open').addEventListener('click', () => openAccounts());
function renderHome() {
  const remaining = state.accounts.filter(connectable).length, saved = state.accounts.filter(stored).length;
  $('nav-count').textContent = state.accounts.length;
  $('home-stored').textContent = saved; $('home-pending').textContent = remaining; $('home-issues').textContent = state.accounts.filter(issues).length;
  $('home-ip-count').textContent = state.proxies.length;
  $('home-server-name').textContent = state.target === 'mon-vps' ? 'VPS · WeeSpy' : state.target || 'Ton premier VPS';
  $('home-server-host').textContent = state.target || 'À renseigner pour commencer';
  $('home-server-state').textContent = state.vps.state === 'ok' ? 'Accessible' : state.vps.state === 'error' ? 'À vérifier' : 'Connexion…';
  $('home-server-state').className = 'state ' + (state.vps.state === 'ok' ? 'saved' : state.vps.state === 'error' ? 'error' : 'ready');
  $('home-start').textContent = !state.loaded || !state.accounts.length ? 'Commencer la configuration →' : remaining ? 'Tout connecter →' : 'Ajouter des comptes →';
  $('home-total').textContent = `${state.accounts.length} compte${state.accounts.length > 1 ? 's' : ''} au total`;
  const running = state.busy && !!(state.active || state.queue.length);
  $('activity').hidden = !running;
  const active = state.accounts.find(a => a.key === state.active);
  $('activity-title').textContent = state.actions.length ? 'Une étape attend ton intervention' : 'Tes connexions avancent';
  $('activity-message').textContent = active ? `${active.label} · ${active.message} · ${state.queue.length} en attente` : 'Préparation de la file sur le VPS…';
  const counts = Object.keys(networks).map(key => ({ key, total: state.accounts.filter(a => a.network === key).length, saved: state.accounts.filter(a => a.network === key && stored(a)).length }));
  const signature = JSON.stringify(counts);
  if (signature !== networkSignature) {
    networkSignature = signature; const content = document.createDocumentFragment();
    for (const item of counts) {
      const line = element('div', undefined, 'network-line'), icon = element('span', { linkedin: 'in', x: '𝕏', instagram: '◎' }[item.key], 'network-icon ' + item.key);
      icon.setAttribute('aria-hidden', 'true');
      const title = element('div', undefined, 'network-name'); title.append(element('strong', networks[item.key]), element('span', `${item.total} compte${item.total > 1 ? 's' : ''}`));
      const status = element('span', item.total ? `${item.saved} / ${item.total} sur le VPS` : 'Prêt à accueillir tes comptes', 'network-state');
      line.append(icon, title, status); content.append(line);
    }
    $('home-networks').replaceChildren(content);
  }
}
function currentTarget() { return { host: $('setup-host').value.trim(), port: $('setup-port').value, identity: $('setup-identity').value.trim() }; }
function targetMatches() {
  const a = currentTarget(), b = state?.connection;
  return !!b && a.host === b.host && Number(a.port || 0) === Number(b.port || 0) && a.identity === (b.identity || '') && state.vps.state === 'ok';
}
function updateSetupContext() {
  if (!state) return;
  const count = state.accounts.filter(connectable).length;
  $('pending-number').textContent = count; $('pending-option').hidden = !count;
  $('setup-stock').textContent = `${state.proxies.length} déjà enregistrée${state.proxies.length > 1 ? 's' : ''}`;
  const prefix = { linkedin: 'li', x: 'x', instagram: 'ig' }[network];
  const free = state.proxies.filter(p => !p.assigned.some(k => k.startsWith(prefix)) && !p.reservedNetworks?.includes(network)).length;
  $('setup-capacity').textContent = `${free} place${free > 1 ? 's' : ''} libre${free > 1 ? 's' : ''} pour ${networks[network]} avec les IP actuelles. Une IP peut accueillir un compte de chaque réseau.`;
  if (state.accounts.some(a => a.network === network && a.source && a.identityKnown === false)) $('setup-capacity').textContent += ' Les sessions existantes de ce réseau doivent être identifiées avant de lancer de nouvelles connexions.';
  $('setup-server-status').hidden = !targetMatches();
  $('setup-server-status').textContent = `VPS accessible · ${state.accounts.length} comptes et ${state.proxies.length} IP retrouvés. Tu peux continuer.`;
  if (step === 1) $('setup-next').textContent = pending ? 'Vérification…' : targetMatches() ? 'Continuer →' : 'Vérifier le VPS →';
  else if (step === 2) $('setup-next').textContent = pending ? 'Vérification des accès…' : 'Voir le récapitulatif →';
  else $('setup-next').textContent = pending ? 'Lancement…' : `Lancer ${review?.accounts.length || 0} connexion${review?.accounts.length > 1 ? 's' : ''} →`;
}
function setStep(next) {
  step = next; $('setup-error').hidden = true;
  for (let i = 1; i <= 3; i++) {
    $('step-' + i).hidden = i !== next;
    const item = document.querySelector(`[data-step="${i}"]`); item.classList.toggle('complete', i < next);
    if (i === next) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  }
  $('setup-back').hidden = next === 1; $('setup-step-label').textContent = `Étape ${next} sur 3`;
  $('setup-next').textContent = next === 2 ? 'Voir le récapitulatif →' : next === 3 ? `Lancer ${review?.accounts.length || 0} connexion${review?.accounts.length > 1 ? 's' : ''} →` : 'Continuer →';
  updateSetupContext(); disable();
  const heading = $('step-' + next).querySelector('h2'); heading.tabIndex = -1; heading.focus({ preventScroll: true }); window.scrollTo({ top: 0 });
}
function openSetup() {
  clearDraft(); const target = state?.connection || { host: 'mon-vps' };
  $('setup-host').value = target.host; $('setup-port').value = target.port || ''; $('setup-identity').value = target.identity || '';
  $('include-pending').checked = true; selectNetwork('linkedin'); showView('setup', false); setStep(1);
}
['home-start', 'home-server-edit', 'add-open', 'empty-add'].forEach(id => $(id).addEventListener('click', openSetup));
$('setup-cancel').addEventListener('click', () => navigate('home'));
$('setup-back').addEventListener('click', () => { cancelChecks(); review = null; setStep(step - 1); });
['setup-host', 'setup-port', 'setup-identity'].forEach(id => $(id).addEventListener('input', updateSetupContext));
function setupData() { return { proxies: $('setup-proxies').value, accounts: Object.fromEntries(Object.keys(networks).map(key => [key, $('setup-' + key).value])), includePending: $('include-pending').checked }; }
function updateEntryCounts() {
  for (const key of Object.keys(networks)) $('input-count-' + key).textContent = $('setup-' + key).value.trim().split(/\s+/).filter(Boolean).length;
}
function selectNetwork(key) {
  network = key;
  for (const name of Object.keys(networks)) {
    const selected = name === key; $('pane-' + name).hidden = !selected;
    $('tab-' + name).setAttribute('aria-selected', String(selected)); $('tab-' + name).tabIndex = selected ? 0 : -1;
  }
  updateSetupContext();
}
document.querySelectorAll('[data-network]').forEach(button => {
  button.addEventListener('click', () => selectNetwork(button.dataset.network));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const keys = Object.keys(networks), index = keys.indexOf(network);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    selectNetwork(keys[next]); $('tab-' + keys[next]).focus();
  });
});
for (const key of Object.keys(networks)) $('setup-' + key).addEventListener('input', updateEntryCounts);
function renderReview() {
  $('review-target').textContent = review.target === 'mon-vps' ? 'VPS' : review.target;
  $('review-count').textContent = review.accounts.length; $('review-ips').textContent = review.totalIPs;
  $('review-title').textContent = review.accounts.length ? 'Vérifions les IP avant de démarrer.' : 'Aucun compte à connecter.';
  $('review-intro').textContent = review.accounts.length ? 'Chaque IP est testée depuis le VPS. Le lancement sera disponible lorsque tous les contrôles auront réussi.' : 'Consulte les sessions existantes et les affectations à vérifier dans le tableau, ou ajoute des comptes à l’étape précédente.';
  $('review-note').textContent = `${review.newAccounts} nouveau(x) compte(s) · ${review.newIPs} nouvelle(s) IP · ${review.skipped} compte(s) ignoré(s) : session déjà présente ou affectation à vérifier.`;
  const rows = document.createDocumentFragment();
  for (const account of review.accounts) { const tr = element('tr'); tr.append(element('td', account.label), element('td', networks[account.network]), element('td', account.ip)); rows.append(tr); }
  $('review-rows').replaceChildren(rows);
}
function spinner() { const icon = element('i', undefined, 'spinner'); icon.setAttribute('aria-hidden', 'true'); return icon; }
function reviewChecks() { return state?.ipChecks?.previewId === review?.previewId ? state.ipChecks.rows : []; }
function reviewIPsReady() { return !!review && state?.ipChecks?.previewId === review.previewId && reviewChecks().every(r => r.state === 'ok'); }
function renderIPChecks() {
  const checks = reviewChecks(), complete = checks.filter(r => ['ok', 'error'].includes(r.state)).length;
  const failed = checks.filter(r => r.state === 'error').length;
  const running = checks.some(r => ['queued', 'checking'].includes(r.state));
  $('ip-check-summary').textContent = !state.ipChecks || state.ipChecks.previewId !== review.previewId ? 'Préparation du contrôle…' : checks.length ? `${complete} / ${checks.length} IP contrôlées${running ? ' · contrôle en cours…' : failed ? ` · ${failed} à corriger` : ' · toutes les sorties correspondent'}` : 'Aucune nouvelle IP à contrôler.';
  const list = document.createDocumentFragment();
  for (const check of checks) {
    const item = element('li', undefined, 'ip-check-row');
    const label = element('strong', check.ip, 'ip-address');
    const text = {queued: 'En attente', checking: 'Vérification depuis le VPS…', ok: 'IP validée', error: 'À corriger'}[check.state];
    const badge = element('span', text, 'state ' + (check.state === 'ok' ? 'saved' : check.state));
    if (check.state === 'checking') { badge.prepend(spinner()); item.setAttribute('aria-busy', 'true'); }
    item.append(label, badge);
    if (check.message) item.append(element('span', check.message, 'ip-check-message problem'));
    else if (check.checkedAt) item.append(element('span', 'Contrôlée à ' + time(check.checkedAt), 'ip-check-message subtext'));
    list.append(item);
  }
  $('ip-check-list').replaceChildren(list);
  if (review.accounts.length) $('review-title').textContent = reviewIPsReady() ? 'Les IP sont prêtes.' : failed ? 'Des IP demandent une correction.' : 'Vérifions les IP avant de démarrer.';
}
$('retry-ips').addEventListener('click', () => act(async () => { state = await api('setup-check-ips', { ...setupData(), previewId: review.previewId }); renderIPChecks(); }, 'setup-error'));
function cookieProof(account) {
  const panel = element('div', undefined, 'cookie-proof');
  const evidence = account.cookieEvidence;
  if (!evidence) { panel.append(element('span', 'Cookies : présence non contrôlée', 'subtext')); return panel; }
  const previous = !['saved', 'existing'].includes(account.state);
  panel.append(element('span', previous ? 'Cookies de la sauvegarde précédente' : 'Cookies sauvegardés sur le VPS', 'cookie-heading'));
  for (const cookie of evidence.cookies) {
    const line = element('span', undefined, 'cookie-line');
    line.append(element('code', cookie.name), element('span', cookie.state === 'present' || cookie.state === 'expired' ? '••••••••' : '—', 'cookie-mask'), element('span', {present:'Présent', missing:'Absent', expired:'Expiré', unknown:'Non contrôlé'}[cookie.state], 'subtext'));
    panel.append(line);
  }
  panel.append(element('span', 'Présence contrôlée le ' + new Date(evidence.checkedAt).toLocaleDateString('fr-FR') + ' à ' + time(evidence.checkedAt), 'subtext'));
  const verifiedAt = !previous && (account.verificationScope === 'vps_identity' ? account.verifiedAt : account.source === 'linkedin-firefox' ? account.serviceCheckedAt : null);
  panel.append(element('span', verifiedAt ? 'Identité vérifiée le ' + new Date(verifiedAt).toLocaleDateString('fr-FR') + ' à ' + time(verifiedAt) : 'La présence des cookies seule ne confirme pas la connexion.', 'subtext'));
  return panel;
}
$('setup-form').addEventListener('submit', event => {
  event.preventDefault(); act(async () => {
    if (step === 1) {
      if (!currentTarget().host) throw new Error('Renseigne l’accès SSH de ton VPS.');
      if (!targetMatches()) { state = await api('load', currentTarget()); render(); }
      setStep(2);
    } else if (step === 2) {
      review = await api('setup-preview', setupData()); renderReview(); setStep(3);
      state = await api('setup-check-ips', { ...setupData(), previewId: review.previewId }); renderIPChecks();
    } else {
      await api('setup-connect', { ...setupData(), previewId: review.previewId });
      clearDraft(); openAccounts();
    }
  }, 'setup-error');
});
$('settings-open').addEventListener('click', () => {
  if (state?.connection) { $('host').value = state.connection.host; $('port').value = state.connection.port || ''; $('identity').value = state.connection.identity || ''; }
  const list = document.createDocumentFragment();
  for (const proxy of state?.proxies || []) list.append(element('p', `${proxy.ip} · ${proxy.assigned.join(', ') || 'Libre pour les trois réseaux'}`, 'hint'));
  $('ip-list').replaceChildren(list); $('settings-dialog').showModal();
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
$('server-form').addEventListener('submit', event => { event.preventDefault(); act(async () => { await api('load', { host: $('host').value.trim(), port: $('port').value, identity: $('identity').value.trim() }); $('settings-dialog').close(); }, 'settings-error'); });
$('connect-pending').addEventListener('click', () => { const keys = state ? networkAccounts().filter(connectable).map(a => a.key) : []; if (keys.length) act(() => api('start', { keys })); });
$('stop').addEventListener('click', () => act(() => api('action', { action: 'stop' })));
$('account-rows').addEventListener('click', event => {
  const connect = event.target.closest('[data-connect]'), action = event.target.closest('[data-action]');
  if (connect) act(() => api('start', { keys: [connect.dataset.connect] }));
  if (action) act(() => api('action', { action: action.dataset.action, key: action.dataset.key }));
});
function updateFilters() { document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter))); }
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; updateFilters(); if (state) { renderRows(); disable(); } }));
$('search').addEventListener('input', () => { if (state) { renderRows(); disable(); } });
document.querySelectorAll('[data-dashboard-network]').forEach(button => button.addEventListener('click', () => {
  dashboardNetwork = button.dataset.dashboardNetwork;
  document.querySelector('.table-scroll').scrollTop = 0;
  sessionStorage.setItem('weespy-network-filter', dashboardNetwork);
  if (state) render();
}));
['claude', 'codex'].forEach(provider => $(provider).addEventListener('click', () => act(async () => { const result = await api('install', { provider }); $('assistant-message').textContent = result.message + ' Si nécessaire : ' + result.login; }, 'settings-error')));
window.addEventListener('pagehide', clearDraft);
refresh().catch(() => notice('Relance WeeSpy Connect depuis son lanceur pour accéder à cette page.', true));
setInterval(() => { if (!pending) refresh().catch(() => notice('L’application locale ne répond plus. Relance WeeSpy Connect.', true)); }, 2000);
