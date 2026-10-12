// Tiny hash router: #/clients, #/marketing … keeps the build static.
import { useEffect, useState } from 'react';

export const ROUTES = ['work', 'projects', 'marketing', 'outreach', 'pipeline', 'clients', 'settings'];
// Old links that still work: the Admin board merged into Projects (docs/PHASE2.md §6), item ids unchanged.
export const REDIRECTS = { admin: 'projects' };

const split = () => {
  const [path, ...query] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { path, query: query.length ? `?${query.join('?')}` : '' };
};

const read = () => {
  const { path } = split();
  if (REDIRECTS[path]) return REDIRECTS[path];
  return ROUTES.includes(path) ? path : 'work';
};

// #/admin?item=x → #/projects?item=x in the address bar, without a history entry (replaceState fires no hashchange).
const fixAddress = () => {
  const { path, query } = split();
  if (REDIRECTS[path]) window.history.replaceState(window.history.state, '', `#/${REDIRECTS[path]}${query}`);
};

export function useRoute() {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    fixAddress();
    const on = () => { fixAddress(); setRoute(read()); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (r) => { window.location.hash = `/${r}`; };
// Query part of the hash: #/marketing?item=it_3 → hashParam('item') === 'it_3'.
export const hashParam = (k) => new URLSearchParams(window.location.hash.split('?')[1] || '').get(k);
