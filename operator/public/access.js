// A launcher can refresh the fragment of an already-open tab without reloading it.
// Keep the current credential in memory/sessionStorage and consume each new hash.
export function createLocalAccess(browser, onRenew = () => {}) {
  const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const stored = browser.sessionStorage.getItem('weespy-local');
  let token = valid(stored) ? stored : '';
  function consume() {
    const incoming = browser.location.hash.slice(1);
    if (!valid(incoming)) return false;
    token = incoming;
    browser.sessionStorage.setItem('weespy-local', token);
    browser.history.replaceState(null, '', '/');
    return true;
  }
  consume();
  browser.addEventListener('hashchange', () => { if (consume()) onRenew(); });
  return { getToken: () => token };
}
export function accessErrorMessage(error) {
  if (error?.status === 401) return 'Accès à WeeSpy Connect non reconnu. Ouvre « Lancer-WeeSpy-Connect.command » pour rétablir la connexion.';
  if (error?.status) return error.message || 'Le tableau de bord a refusé la demande.';
  return 'Impossible de joindre l’application locale. Ouvre « Lancer-WeeSpy-Connect.command » pour la redémarrer.';
}
