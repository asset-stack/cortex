import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { ago } from '@/lib/format';
import { cn } from '@/lib/cn';

const STALE = 10 * 60e3;
const GMAIL_RUNS = 30; // a first read of a mailbox takes several runs: keep going while the function says there's more
const GMAIL_RETRY = 60e3; // a first read that stopped (Gmail busy, the run cap) carries on a minute later…
const GMAIL_RETRIES = 10; // …at most this many times while the page stays open
let autoGmail = 0; // this page load's last automatic Gmail sync (the function also spaces each mailbox's out)
const NO_TAB = { 'agent tab': 'same name as the agent’s tab', reserved: 'Summary and Notes are the sync’s own tabs', duplicate: 'another mailbox has this name', 'no name': 'it has no name' };
let autoSynced = { url: '', at: 0 }; // this page load's last automatic sync (of which link), so switching views doesn't repeat it

/**
 * When the sheet was last read into Cortex, and Sync now. `autoSync` (the Outreach page, live mode): sync once on
 * open when the last sync is missing or over 10 minutes old. `onSynced` runs after a sync that worked. `reader`
 * (Settings → Outreach): whose Google account reads the sheet, and Use my Google for another admin.
 * Connected mailboxes' Gmail (0010) syncs alongside: on open (the function skips a mailbox read in the last 10 minutes)
 * and with Sync now (at once), run after run while there's more to read; `onSynced` also runs after each run that read
 * something. While an active mailbox's first read isn't done, it carries on a minute after it stops, while the page is
 * open (Outreach and Settings → Outreach). `startGmail`: start reading at once (just back from Connect Gmail).
 */
export default function SyncStatus({ autoSync = false, onSynced, reader = false, startGmail = false, className }) {
  const { state, actions, outreach, google } = useStore();
  const { isAdmin } = useAccess();
  const [status, setStatus] = useState(null); // outreach.status()
  const [gmail, setGmail] = useState([]); // outreach.gmailStatus().mailboxes
  const [reading, setReading] = useState(false); // a Gmail sync is running
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(''); // the last Sync now's error
  const [taking, setTaking] = useState(false); // Use my Google, until it has saved
  const api = useRef(outreach);
  api.current = outreach;
  const done = useRef(onSynced);
  done.current = onSynced;
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode mounts twice in development
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const [s, g] = await Promise.all([api.current.status(), api.current.gmailStatus()]);
    if (alive.current && n === seq.current) { setStatus(s); setGmail(g?.ok ? g.mailboxes : []); }
    return s;
  }, []);
  // Connected mailboxes still switched on (a mailbox switched off keeps its numbers but isn't read).
  const gmailOn = gmail.filter((g) => g.connected && g.active !== false);
  const anyGmail = gmailOn.length > 0;
  const unread = gmailOn.some((g) => !g.ready && !g.reconnect);

  // Gmail: one run reads up to a few hundred threads per mailbox (three mailboxes a run); runs chain while there's more,
  // each one that read something refreshing the numbers. `force`: Sync now (mailboxes read over a minute ago, not 10).
  const readingNow = useRef(false);
  const syncGmail = useCallback(async (force) => {
    if (readingNow.current) return null;
    readingNow.current = true;
    setReading(true);
    let res = null;
    for (let i = 0; i < GMAIL_RUNS; i++) {
      res = await api.current.syncGmail({ force });
      if (!alive.current) break;
      if (res?.ok && res.claimed) { load(); done.current?.(); }
      if (!res?.ok || !res.more) break;
    }
    readingNow.current = false;
    if (alive.current) { setReading(false); load(); }
    return res;
  }, [load]);
  useEffect(() => { load(); }, [load, state.outreachSheet]);

  const running = useRef(false);
  // The sheet, and Gmail alongside (`gmail`): the sheet's result shows as soon as it's back; Gmail carries on under
  // "Reading Gmail" (a first read can take many runs).
  const sync = useCallback(async ({ sheet = true, gmail: withGmail = false } = {}) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed('');
    if (withGmail) {
      syncGmail(true).then((g) => { if (alive.current && g && !g.ok) setFailed(g.error || 'Gmail sync failed'); });
    }
    const res = sheet ? await api.current.sync() : null;
    running.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (res && !res.ok) setFailed(res.error || 'Sync failed');
    await load();
    if (res?.ok) done.current?.();
  }, [load, syncGmail]);
  const syncNow = () => sync({ sheet: Boolean(status?.sheetUrl) || !anyGmail, gmail: anyGmail });

  useEffect(() => {
    if (!autoSync || !outreach.live || !status?.ok || !status.sheetUrl) return;
    if (autoSynced.url === status.sheetUrl && Date.now() - autoSynced.at < STALE) return; // a new link syncs at once
    const last = Date.parse(status.syncedAt || '');
    if (Number.isFinite(last) && Date.now() - last < STALE) return;
    autoSynced = { url: status.sheetUrl, at: Date.now() };
    sync({ sheet: true });
  }, [autoSync, outreach.live, status, sync]);
  // Gmail on open: the function itself skips a mailbox read in the last 10 minutes, so this only asks.
  useEffect(() => {
    if (!autoSync || !outreach.live || !anyGmail || Date.now() - autoGmail < STALE) return;
    autoGmail = Date.now();
    syncGmail(false);
  }, [autoSync, outreach.live, anyGmail, syncGmail]);
  // Just back from Connect Gmail: start its first read now.
  const started = useRef(false);
  useEffect(() => {
    if (!startGmail || !outreach.live || started.current) return;
    started.current = true;
    syncGmail(true);
  }, [startGmail, outreach.live, syncGmail]);
  // A first read that stopped before it was done (Gmail busy, the run cap) carries on a minute later.
  const retries = useRef(0);
  useEffect(() => {
    if (!outreach.live || !unread || reading || retries.current >= GMAIL_RETRIES) return undefined;
    const t = setTimeout(() => { retries.current += 1; syncGmail(true); }, GMAIL_RETRY);
    return () => clearTimeout(t);
  }, [outreach.live, unread, reading, syncGmail]);

  // Use my Google: this admin's Google account reads the sheet from now on (the last error goes), then a sync.
  const takeOver = async () => {
    if (!google.connected) { setFailed('Connect Google in Settings → Business first.'); return; }
    setFailed('');
    setTaking(true);
    const res = await actions.takeOutreachSheet();
    if (!alive.current) return;
    setTaking(false);
    if (!res?.ok) { setFailed(res?.error || 'That didn’t work'); return; }
    await load();
    sync();
  };
  const readerName = status?.sheetBy ? state.users.find((u) => u.id === status.sheetBy)?.name || '' : '';
  // Mailboxes the last sync couldn't give a tab in the sheet (sync_stats.noTab), and why.
  const noTab = reader && Array.isArray(status?.stats?.noTab) ? status.stats.noTab : [];
  const showReader = reader && outreach.live && isAdmin && status?.ok && Boolean(status.sheetUrl);

  // Gmail's part of the line: still reading a mailbox, a mailbox's error, or the latest sync.
  const gmailLine = (() => {
    const on = gmailOn;
    if (!on.length) return null;
    const broken = on.find((g) => g.error || g.reconnect);
    if (broken) return { text: `Gmail: ${broken.error || 'reconnect a mailbox in Settings → Outreach'}`, warn: true };
    const left = on.filter((g) => !g.ready).reduce((t, g) => t + g.pending, 0);
    if (reading || on.some((g) => !g.ready)) return { text: left ? `Reading Gmail · ${left.toLocaleString('en-AU')} left` : 'Reading Gmail…', warn: false };
    const last = on.map((g) => g.syncedAt).filter(Boolean).sort().at(-1);
    const a = last ? ago(last) : '';
    return { text: !a || a === '—' ? 'Gmail connected' : a === 'now' ? 'Gmail synced just now' : `Gmail synced ${a} ago`, warn: false };
  })();

  let line;
  let warn = false;
  if (busy) line = 'Syncing…';
  else if (failed) { line = failed; warn = true; }
  else if (!outreach.live) line = 'Demo data';
  else if (!status) line = '';
  else if (!status.ok) { line = status.error; warn = true; }
  else if (!status.sheetUrl) {
    line = isAdmin ? <a href="#/settings?tab=outreach" className="underline underline-offset-2 hover:text-white">Add the sheet in Settings → Outreach</a> : 'No sheet yet';
  } else if (status.error) { line = status.error; warn = true; } else if (status.syncedAt) {
    const a = ago(status.syncedAt);
    line = a === 'now' ? 'Synced just now' : a === '—' ? 'Synced' : `Synced ${a} ago`;
  } else line = 'Not synced yet';

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]', className)}>
      <span role="status" className={cn('min-w-0 break-words', warn ? 'text-amber-200' : 'dimmer')}>{line}</span>
      {gmailLine && !busy && <span className={cn('min-w-0 break-words', gmailLine.warn ? 'text-amber-200' : 'dimmer')}>{gmailLine.text}</span>}
      <button type="button" onClick={syncNow} disabled={busy || taking}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full chip px-3.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}Sync now
      </button>
      {noTab.length > 0 && (
        <span className="basis-full text-amber-200">
          {noTab.map((x) => `No tab for ${x.mailbox || 'a mailbox without a name'}: ${NO_TAB[x.why] || 'name not usable'}`).join(' · ')}
        </span>
      )}
      {showReader && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {readerName && <span className="dimmer">Reads as {readerName}</span>}
          {status.sheetBy !== state.me && (
            <button type="button" onClick={takeOver} disabled={busy || taking}
              className="inline-flex h-9 shrink-0 items-center rounded-full chip px-3.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
              Use my Google
            </button>
          )}
        </span>
      )}
    </div>
  );
}
