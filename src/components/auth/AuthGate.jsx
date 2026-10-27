// Live-mode sign-in (docs/BACKEND.md §5): Google, @assetstackai.com only. Demo mode renders the app directly.
// Usage: <AuthGate>{(user) => …}</AuthGate>, where `user` is the Supabase user (null in demo mode).
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ALLOWED_DOMAIN, LIVE, supabase } from '@/data/backend/client';
import Logo from '@/components/Logo';

const MESSAGES = {
  domain: `Only @${ALLOWED_DOMAIN} Google accounts can sign in.`,
  failed: 'Sign-in didn’t complete. Try again.',
};

/** Full-screen backdrop with one centred glass card. Also used by the store while live data loads. */
export function GateScreen({ children }) {
  return (
    <>
      <div className="backdrop-photo" aria-hidden="true" />
      <div className="backdrop-vignette" aria-hidden="true" />
      <div className="backdrop-grain" aria-hidden="true" />
      <main className="relative z-[2] grid h-full place-items-center overflow-y-auto p-4">
        <section className="glass glass-rim w-full max-w-[380px] rounded-[30px] px-7 py-8 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white shadow-[0_8px_24px_rgba(35,55,238,0.35)]"><Logo size={32} /></div>
          <h1 className="page-title mt-4 text-[34px] leading-none">Cortex</h1>
          <div className="mt-6">{children}</div>
        </section>
      </main>
    </>
  );
}

export function Spinner({ label }) {
  return <div role="status" className="flex justify-center dim"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /><span className="sr-only">{label}</span></div>;
}

// A refused sign-in comes back as ?error=… (or #error=…). Read it once and tidy the URL for the hash router.
// Only the sign-up trigger's rejection (a database error) means the wrong domain; anything else (cancelled,
// an expired sign-in, a failed exchange) is a sign-in that didn't complete.
function takeUrlError() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('error') || hash.get('error');
  if (!code) return null;
  const text = `${url.searchParams.get('error_description') || hash.get('error_description') || ''}`;
  ['error', 'error_code', 'error_description'].forEach((k) => url.searchParams.delete(k));
  if (hash.has('error')) url.hash = '';
  window.history.replaceState(window.history.state, '', url.toString());
  return /database|domain/i.test(text) ? 'domain' : 'failed';
}
const urlError = LIVE ? takeUrlError() : null; // once per page load (StrictMode runs state initialisers twice)

// A ?code= still in the URL once auth has settled is a return from Google that couldn't be exchanged for a
// session (expired, already used, or begun in another browser): a successful exchange removes it. Tidy it away.
function takeStaleCode() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('code')) return false;
  ['code', 'sb_flow_id'].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState(window.history.state, '', url.toString());
  return true;
}

const signOut = () => supabase.auth.signOut({ scope: 'local' }); // this browser only

function LiveGate({ children }) {
  const [error, setError] = useState(urlError);
  const [user, setUser] = useState(undefined); // undefined while the stored session is read
  const [account, setAccount] = useState({ id: null, status: 'checking' }); // active | inactive | error
  const [check, setCheck] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    // Token refreshes keep the same user object, so the app below doesn't re-render for them.
    const pick = (session) => {
      const next = session?.user ?? null;
      if (on) setUser((prev) => (prev && next && prev.id === next.id ? prev : next));
    };
    supabase.auth.getSession().then(({ data }) => {
      if (on && !data.session && takeStaleCode()) setError('failed');
      pick(data.session);
    }, () => pick(null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => pick(session));
    return () => { on = false; data.subscription.unsubscribe(); };
  }, []);

  // Back from Google's account chooser, the browser can restore this page as it was left, button still busy.
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) setBusy(false); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // RLS only shows profiles to active staff, so no row back means the account isn't active (yet).
  useEffect(() => {
    if (!user) return undefined;
    if (!user.email?.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)) {
      setError('domain');
      signOut();
      return undefined;
    }
    let on = true;
    setAccount({ id: user.id, status: 'checking' });
    (async () => {
      try {
        const { data, error: e } = await supabase.from('profiles').select('id, active').eq('id', user.id).maybeSingle();
        if (on) setAccount({ id: user.id, status: e ? 'error' : data?.active ? 'active' : 'inactive' });
      } catch {
        if (on) setAccount({ id: user.id, status: 'error' });
      }
    })();
    return () => { on = false; };
  }, [user, check]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { hd: ALLOWED_DOMAIN, prompt: 'select_account' },
      },
    });
    if (e) { setBusy(false); setError('failed'); } // otherwise the browser is already on its way to Google
  };

  const status = user && account.id === user.id ? account.status : 'checking';
  if (user === undefined || (user && status === 'checking')) return <GateScreen><Spinner label="Loading" /></GateScreen>;

  if (!user) {
    return (
      <GateScreen>
        <button type="button" onClick={signIn} disabled={busy} className="btn-primary inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 font-semibold">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Sign in with Google
        </button>
        <p className="mt-3 text-[13px] dimmer">Use your @{ALLOWED_DOMAIN} account</p>
        {error && <p role="alert" className="mt-4 rounded-2xl bg-rose-500/20 px-3 py-2 text-[13px] text-rose-100">{MESSAGES[error]}</p>}
      </GateScreen>
    );
  }

  if (status === 'active') return children(user);

  return (
    <GateScreen>
      <p className="dim">{status === 'error' ? 'Couldn’t check your account.' : 'Your account isn’t active yet. Ask an admin.'}</p>
      <p className="mt-1 truncate text-[12.5px] dimmer">{user.email}</p>
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" onClick={signOut} className="rounded-full chip px-4 h-10 font-semibold">Sign out</button>
        {status === 'error' && <button type="button" onClick={() => setCheck((n) => n + 1)} className="btn-primary rounded-full px-5 h-10 font-semibold">Retry</button>}
      </div>
    </GateScreen>
  );
}

export default function AuthGate({ children }) {
  return LIVE ? <LiveGate>{children}</LiveGate> : children(null);
}
