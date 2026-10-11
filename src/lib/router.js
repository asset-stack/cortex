// Tiny hash router: #/clients, #/marketing … keeps the build static.
import { useEffect, useState } from 'react';

export const ROUTES = ['work', 'projects', 'admin', 'outreach', 'marketing', 'pipeline', 'clients'];

const read = () => {
  const r = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.includes(r) ? r : 'work';
};

export function useRoute() {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (r) => { window.location.hash = `/${r}`; };
