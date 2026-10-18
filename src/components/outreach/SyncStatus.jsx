import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { ago } from '@/lib/format';
import { cn } from '@/lib/cn';

const STALE = 10 * 60e3;
let autoSyncedAt = 0; // this page load's last automatic sync, so switching views doesn't repeat it

/**
 * When the sheet was last read into Cortex, and Sync now. `autoSync` (the Outreach page, live mode): sync once on
 * open when the last sync is missing or over 10 minutes old. `onSynced` runs after a sync that worked.
 */
export default function SyncStatus({ autoSync = false, onSynced, className }) {
  const { state, outreach } = useStore();
  const { isAdmin } = useAccess();
  const [status, setStatus] = useState(null); // outreach.status()
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(''); // the last Sync now's error
  const api = useRef(outreach);
  api.current = outreach;
  const done = useRef(onSynced);
  done.current = onSynced;
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const s = await api.current.status();
    if (alive.current && n === seq.current) setStatus(s);
    return s;
  }, []);
  useEffect(() => { load(); }, [load, state.outreachSheet]);

  const running = useRef(false);
  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed('');
    const res = await api.current.sync();
    running.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (res?.ok) {
      await load();
      done.current?.();
    } else {
      setFailed(res?.error || 'Sync failed');
      load();
    }
  }, [load]);

  useEffect(() => {
    if (!autoSync || !outreach.live || !status?.ok || !status.sheetUrl || Date.now() - autoSyncedAt < STALE) return;
    const last = Date.parse(status.syncedAt || '');
    if (Number.isFinite(last) && Date.now() - last < STALE) return;
    autoSyncedAt = Date.now();
    sync();
  }, [autoSync, outreach.live, status, sync]);

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
      <button type="button" onClick={sync} disabled={busy}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full chip px-3.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}Sync now
      </button>
    </div>
  );
}
