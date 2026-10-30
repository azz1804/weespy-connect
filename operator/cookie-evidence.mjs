// Public metadata only: cookie values, lengths and fragments never reach the UI.
const names = { linkedin: ['li_at', 'JSESSIONID'], x: ['auth_token', 'ct0'], instagram: ['sessionid'] };
export function cookieEvidence(network, value) {
  if (!value || !Array.isArray(value.cookies)) return null;
  const date = typeof value.checkedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.checkedAt) && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null;
  if (!date) return null;
  return { checkedAt: date, cookies: (names[network] || []).map(name => {
    const entries = value.cookies.filter(c => c?.name === name);
    const state = entries.length === 1 && ['present', 'missing', 'expired', 'unknown'].includes(entries[0].state) ? entries[0].state : 'unknown';
    return { name, state };
  }) };
}
