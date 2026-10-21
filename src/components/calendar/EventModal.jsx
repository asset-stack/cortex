import { useEffect, useId, useState } from 'react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { EVENT_KINDS, localInstant, placeAt } from '@/lib/calendar';
import { addDays } from '@/lib/automations';
import { localYmd } from '@/lib/format';
import { ConfirmModal, Modal, PeoplePicker, Segmented } from '@/components/ui';

const KIND_OPTIONS = Object.entries(EVENT_KINDS).map(([id, label]) => ({ id, label }));

// The form's fields from an event (times in this browser's zone), or a new one's defaults. An end time earlier than the
// start is the next day (a 23:00–00:30 meeting, or one set in a zone where it doesn't cross midnight).
function formOf(event, day, me) {
  if (!event) return { kind: 'meeting', title: '', day: day || localYmd(), endDay: '', allDay: false, start: '09:00', end: '10:00', people: me ? [me] : [] };
  const start = event.startsAt ? placeAt(event.startsAt) : null;
  return {
    kind: event.kind, title: event.title, day: start?.date || event.day, endDay: event.endDay || '', allDay: !start,
    start: start?.time || '09:00', end: event.endsAt ? placeAt(event.endsAt).time : '10:00', people: event.people || [],
  };
}

/**
 * New event, or an event on the Calendar: kind (meeting, event or reminder), title, day, all day (up to an end day) or a
 * start and end time, and people. Anyone adds one; the one who added it, or an admin, edits and deletes it (others see
 * it read only). It closes if the event is deleted meanwhile.
 */
export default function EventModal({ eventId = '', day = '', onClose }) {
  const { state, actions } = useStore();
  const access = useAccess();
  const event = eventId ? (state.calendarEvents || []).find((x) => x.id === eventId) : null;
  const gone = Boolean(eventId) && !event;
  const canEdit = !eventId || (Boolean(event) && (event.createdBy === state.me || access.isAdmin));
  const [f, setF] = useState(() => formOf(event, day, state.me));
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const hint = useId();
  useEffect(() => { if (gone) onClose(); }, [gone, onClose]);
  if (gone) return null;

  const set = (k) => (e) => { setErr(''); setF((x) => ({ ...x, [k]: e.target.value })); };
  const nextDay = !f.allDay && Boolean(f.start && f.end) && f.end < f.start;
  const fields = () => (f.allDay
    ? { kind: f.kind, title: f.title, day: f.day, endDay: f.endDay, startsAt: '', endsAt: '', people: f.people }
    : {
      kind: f.kind, title: f.title, day: f.day, endDay: '', startsAt: localInstant(f.day, f.start),
      endsAt: localInstant(nextDay ? addDays(f.day, 1) : f.day, f.end), people: f.people,
    });
  const submit = (e) => {
    e.preventDefault();
    if (!f.title.trim()) { setErr('Add a title'); return; }
    if (!f.allDay && !(f.start && f.end)) { setErr('Add a start and end time'); return; }
    if (f.allDay && f.endDay && f.endDay < f.day) { setErr('The end day is before the start'); return; }
    const ok = eventId ? actions.updateCalendarEvent(eventId, fields()) : actions.addCalendarEvent(fields());
    if (ok === false) { setErr('Couldn’t save this event'); return; }
    onClose();
  };
  const title = eventId ? (canEdit ? 'Edit event' : EVENT_KINDS[event.kind]) : 'New event';
  const creator = event && state.users.find((u) => u.id === event.createdBy)?.name;
  return (
    <>
      <Modal open onClose={onClose} title={title}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <fieldset disabled={!canEdit} className="contents">
            <Segmented options={KIND_OPTIONS} value={f.kind} onChange={(kind) => canEdit && setF((x) => ({ ...x, kind }))} label="Kind" />
            <input className="field" placeholder="Title" aria-label="Title" value={f.title} onChange={set('title')} maxLength={200} autoFocus={canEdit} />
            <div className="grid grid-cols-2 gap-3">
              <input type="date" className="field" aria-label={f.allDay ? 'Start day' : 'Day'} value={f.day} onChange={set('day')} required />
              <label className="field flex items-center gap-2">
                <input type="checkbox" checked={f.allDay} onChange={(e) => setF((x) => ({ ...x, allDay: e.target.checked }))} />All day
              </label>
              {f.allDay ? (
                <input type="date" className="field col-span-2" aria-label="End day" value={f.endDay} min={f.day} onChange={set('endDay')} />
              ) : (
                <>
                  <input type="time" className="field" aria-label="Start time" value={f.start} onChange={set('start')} required />
                  <input type="time" className="field" aria-label="End time" aria-describedby={nextDay ? hint : undefined} value={f.end} onChange={set('end')} required />
                  {nextDay && <div id={hint} className="col-span-2 -mt-1 text-right text-[12px] dim">Ends the next day</div>}
                </>
              )}
            </div>
            <div className="field flex items-center gap-2 !py-1"><span className="dimmer">People</span>
              <PeoplePicker value={f.people} onChange={(people) => setF((x) => ({ ...x, people }))} size={26} max={5} readOnly={!canEdit} />
            </div>
          </fieldset>
          {err && <div role="alert" className="text-[12.5px] text-rose-200">{err}</div>}
          {canEdit ? (
            <>
              <button type="submit" className="btn-primary rounded-full h-11 font-semibold">{eventId ? 'Save' : 'Add to Calendar'}</button>
              {eventId && (
                <button type="button" onClick={() => setConfirm(true)} className="self-start rounded-full px-3 h-9 font-semibold text-rose-200 hover:bg-white/10">Delete event</button>
              )}
            </>
          ) : (
            creator && <div className="text-[12.5px] dimmer">Added by {creator}</div>
          )}
        </form>
      </Modal>
      {eventId && (
        <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title={`Delete ${event.title}?`}
          onConfirm={() => { if (actions.removeCalendarEvent(eventId) !== false) onClose(); }} />
      )}
    </>
  );
}
