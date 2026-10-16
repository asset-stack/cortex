// Tiny hash router: #/clients, #/marketing/<board id> … keeps the build static.
import { useEffect, useState } from 'react';

export const ROUTES = ['work', 'projects', 'marketing', 'outreach', 'pipeline', 'clients', 'settings'];
// Old links that still work: the Admin board merged into Projects (docs/PHASE2.md §6), item ids unchanged.
export const REDIRECTS = { admin: 'projects' };

// A malformed %-escape (a hand-typed or truncated link) is kept as typed rather than crashing the app.
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// #/projects/abc?item=x → { route: 'projects', sub: 'abc', query: '?item=x' }.
const split = () => {
  const [path, ...query] = window.location.hash.replace(/^#\/?/, '').split('?');
  const [route = '', sub = ''] = path.split('/');
  return { route, sub: decode(sub), query: query.length ? `?${query.join('?')}` : '' };
};

const read = () => {
  const { route, sub } = split();
  if (REDIRECTS[route]) return { route: REDIRECTS[route], sub: '' };
  return ROUTES.includes(route) ? { route, sub } : { route: 'work', sub: '' };
};

// #/admin?item=x → #/projects?item=x in the address bar, without a history entry (replaceState fires no hashchange).
const fixAddress = () => {
  const { route, query } = split();
  if (REDIRECTS[route]) window.history.replaceState(window.history.state, '', `#/${REDIRECTS[route]}${query}`);
};

/** { route, sub }: the page and, for Projects and Marketing, the board id ('' for the module's default board). */
export function useRoute() {
  const [at, setAt] = useState(read);
  useEffect(() => {
    fixAddress();
    const on = () => {
      fixAddress();
      const next = read();
      setAt((prev) => (prev.route === next.route && prev.sub === next.sub ? prev : next));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return at;
}

export const go = (r) => { window.location.hash = `/${r}`; };
// Query part of the hash: #/marketing?item=it_3 → hashParam('item') === 'it_3'.
export const hashParam = (k) => new URLSearchParams(window.location.hash.split('?')[1] || '').get(k);
