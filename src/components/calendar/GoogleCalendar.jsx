import { useState } from 'react';
import { CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, ConfirmModal, Popover } from '@/components/ui';
import { ago } from '@/lib/format';
import { cn } from '@/lib/cn';

const BUTTON = 'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const synced = (iso) => (ago(iso) === 'now' ? 'Synced just now' : `Synced ${ago(iso)} ago`);

function personState(p) {
  if (!p?.connected) return 'Not connected';
  if (p.reconnect) return 'Reconnect';
  if (p.error) return p.error;
  return p.syncedAt ? synced(p.syncedAt) : 'Waiting for the first sync';
}

/**
 * Google Calendar on the team Calendar: share yours (read only; teammates see your meetings' titles and times, Private
 * ones as Busy), then when the team's meetings last synced, with Sync now, who shares theirs, and Stop sharing (an
 * admin's Gmail and Drive stay connected). When Google refused your calendar, Reconnect. Live mode only. `status` is
 * store.calendar.status()'s answer.
 */
export default function GoogleCalendar({ status, syncing, onSync, onConnect, onStop }) {
  const { state, google } = useStore();
  const users = useUsers();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(''); // '' | 'connect' | 'stop'
  const people = status?.people || [];
  const connected = people.filter((p) => p.connected);
  const mine = people.find((p) => p.userId === state.me);
  // My own last sync failed (other than needing to reconnect, which has its own button): say so on the menu button.
  const broken = google.calendar && Boolean(mine?.error) && !mine?.reconnect;
  const label = syncing ? 'Syncing…' : broken ? mine.error : status?.syncedAt ? synced(status.syncedAt) : 'Google Calendar';

  if (google.demo) {
    return <span className={cn(BUTTON, 'chip dim')} title="Google Calendar works in live mode only"><CalendarClock className="h-4 w-4" />Live mode only</span>;
  }
  // Connect, or Reconnect when Google refused yours; the team's sync menu beside it once anyone shares theirs.
  const connect = !google.calendar || mine?.reconnect;
  return (
    <>
      <span ref={setAnchor} className="inline-flex shrink-0 gap-2">
        {connect && (
          <button type="button" onClick={() => setConfirm('connect')} disabled={!google.ready} className={cn(BUTTON, 'btn-primary')}>
            <CalendarClock className="h-4 w-4" />{google.calendar ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
          </button>
        )}
        {google.calendar ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}
            className={cn(BUTTON, 'chip', broken && 'text-amber-200')}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : !connect && <CalendarClock className="h-4 w-4" />}{label}
          </button>
        ) : connected.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Team’s Google Calendars" title="Team’s Google Calendars"
            aria-haspopup="true" aria-expanded={open} className="grid h-10 w-10 place-items-center rounded-full chip">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        )}
      </span>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={290} align="right">
        <div className="flex flex-col gap-1">
          {people.map((p) => (
            <div key={p.userId} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <Avatar userId={p.userId} size={24} ring={false} />
              <span className="min-w-0 flex-1 truncate">{users[p.userId]?.name || 'Someone'}</span>
              <span className={cn('max-w-[130px] truncate text-[12px]', p.connected && !p.error && !p.reconnect ? 'dim' : 'text-amber-200')} title={personState(p)}>
                {personState(p)}
              </span>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap gap-2 border-t rowline px-1 pt-2">
            <button type="button" onClick={() => { setOpen(false); onSync(); }} disabled={syncing || !connected.length} className={cn(BUTTON, 'chip !h-9')}>
              <RefreshCw className="h-4 w-4" />Sync now
            </button>
            {google.calendar && (
              <button type="button" onClick={() => { setOpen(false); setConfirm('stop'); }} className={cn(BUTTON, 'chip !h-9')}>Stop sharing</button>
            )}
          </div>
        </div>
      </Popover>
      <ConfirmModal open={confirm === 'connect'} onClose={() => setConfirm('')} onConfirm={onConnect} action={google.calendar ? 'Reconnect' : 'Connect'}
        title={google.calendar ? 'Reconnect Google Calendar?' : 'Connect Google Calendar?'}>
        Teammates see your meetings’ titles and times. Private events show as Busy.
      </ConfirmModal>
      <ConfirmModal open={confirm === 'stop'} onClose={() => setConfirm('')} onConfirm={onStop} action="Stop sharing" title="Stop sharing your calendar?">
        Your meetings leave the Calendar.
      </ConfirmModal>
    </>
  );
}
