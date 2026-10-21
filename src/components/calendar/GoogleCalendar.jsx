import { useState } from 'react';
import { CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { Avatar, ConfirmModal, Popover } from '@/components/ui';
import { ago } from '@/lib/format';
import { cn } from '@/lib/cn';

const BUTTON = 'inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';

function personState(p) {
  if (!p?.connected) return 'Not connected';
  if (p.reconnect) return 'Reconnect';
  if (p.error) return p.error;
  return p.syncedAt ? `Synced ${ago(p.syncedAt)} ago`.replace('now ago', 'just now') : 'Waiting for the first sync';
}

/**
 * Google Calendar on the team Calendar: connect yours (read only; teammates see your meetings' titles and times, Private
 * ones as Busy), then when the team's meetings last synced, with Sync now, who has connected, and Disconnect. Live mode
 * only. `status` is store.calendar.status()'s answer.
 */
export default function GoogleCalendar({ status, syncing, onSync, onConnect, onDisconnect }) {
  const { google } = useStore();
  const users = useUsers();
  const [anchor, setAnchor] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(''); // '' | 'connect' | 'disconnect'
  const people = status?.people || [];
  const connected = people.filter((p) => p.connected);
  const label = syncing ? 'Syncing…' : status?.syncedAt ? `Synced ${ago(status.syncedAt)} ago`.replace('now ago', 'just now') : 'Google Calendar';

  if (google.demo) {
    return <span className={cn(BUTTON, 'chip dim')} title="Google Calendar works in live mode only"><CalendarClock className="h-4 w-4" />Live mode only</span>;
  }
  return (
    <>
      {google.calendar ? (
        <button type="button" ref={setAnchor} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} className={cn(BUTTON, 'chip')}>
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}{label}
        </button>
      ) : (
        <span ref={setAnchor} className="inline-flex shrink-0 gap-2">
          <button type="button" onClick={() => setConfirm('connect')} disabled={!google.ready} className={cn(BUTTON, 'btn-primary')}>
            <CalendarClock className="h-4 w-4" />Connect Google Calendar
          </button>
          {connected.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Team’s Google Calendars" title="Team’s Google Calendars"
              aria-haspopup="true" aria-expanded={open} className="grid h-10 w-10 place-items-center rounded-full chip">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          )}
        </span>
      )}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={290} align="right">
        <div className="flex flex-col gap-1">
          {people.map((p) => {
            const u = users[p.userId];
            return (
              <div key={p.userId} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                <Avatar userId={p.userId} size={24} ring={false} />
                <span className="min-w-0 flex-1 truncate">{u?.name || 'Someone'}</span>
                <span className={cn('max-w-[130px] truncate text-[12px]', p.connected && !p.error && !p.reconnect ? 'dim' : 'text-amber-200')} title={personState(p)}>
                  {personState(p)}
                </span>
              </div>
            );
          })}
          <div className="mt-1 flex flex-wrap gap-2 border-t rowline px-1 pt-2">
            <button type="button" onClick={() => { setOpen(false); onSync(); }} disabled={syncing || !connected.length} className={cn(BUTTON, 'chip !h-9')}>
              <RefreshCw className="h-4 w-4" />Sync now
            </button>
            {google.calendar && (
              <button type="button" onClick={() => { setOpen(false); setConfirm('disconnect'); }} className={cn(BUTTON, 'chip !h-9')}>Disconnect</button>
            )}
          </div>
        </div>
      </Popover>
      <ConfirmModal open={confirm === 'connect'} onClose={() => setConfirm('')} onConfirm={onConnect} action="Connect" title="Connect Google Calendar?">
        Teammates see your meetings’ titles and times. Private events show as Busy.
      </ConfirmModal>
      <ConfirmModal open={confirm === 'disconnect'} onClose={() => setConfirm('')} onConfirm={onDisconnect} action="Disconnect" title="Disconnect Google?">
        {google.connected ? 'Your meetings leave the Calendar, and Gmail and Drive are disconnected too.' : 'Your meetings leave the Calendar.'}
      </ConfirmModal>
    </>
  );
}
