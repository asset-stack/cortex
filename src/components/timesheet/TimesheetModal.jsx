import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore } from '@/data/store';
import { CATEGORIES } from '@/data/boards';
import { LabelPicker, Modal } from '@/components/ui';
import { blocksFromEntries, dayActivity, dayLabel, formatMinutes, suggestBlocks } from '@/lib/timesheet';

// Mounted each time the modal opens: starts from the saved entries for the day, else from the suggestion.
function TimesheetForm({ day, onDone }) {
  const { state, actions } = useStore();
  const suggest = () => suggestBlocks(dayActivity(state, state.me, day));
  const [rows, setRows] = useState(() => {
    const saved = state.timeEntries.filter((e) => e.user === state.me && e.day === day);
    return saved.length ? blocksFromEntries(saved) : suggest();
  });
  const set = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch, source: 'manual' } : r)));
  const total = rows.reduce((t, r) => t + (Number(r.minutes) || 0), 0);

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (actions.saveTimesheet(day, rows) !== false) onDone(); }}>
      <ol className="-mx-1 flex max-h-[min(60vh,520px)] flex-col gap-3.5 overflow-y-auto scroll-thin px-1 py-0.5 sm:gap-2">
        {rows.map((r, i) => (
          <li key={`${r.start}-${i}`} className="grid grid-cols-[46px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[46px_150px_minmax(0,1fr)]">
            <span className="font-semibold dim tnum" title={formatMinutes(r.minutes)}>{r.start}</span>
            <LabelPicker label={`Category at ${r.start}`} value={r.category} options={CATEGORIES} allowEmpty={false} onChange={(category) => set(i, { category })} />
            <input value={r.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Note" aria-label={`Note at ${r.start}`}
              className="field col-start-2 !py-1.5 sm:col-start-auto" />
          </li>
        ))}
      </ol>
      <div className="mt-5 flex items-center gap-2">
        <button type="button" onClick={() => setRows(suggest())} className="inline-flex h-10 items-center gap-2 rounded-full chip px-4 font-semibold">
          <Sparkles className="h-4 w-4" />Suggest
        </button>
        <span className="ml-auto dimmer tnum">{formatMinutes(total)}</span>
        <button type="submit" className="btn-primary h-10 rounded-full px-5 font-semibold">Save</button>
      </div>
    </form>
  );
}

/** The signed-in person's hours for `day`: 8 hourly blocks, each a category and a note. Saving replaces the day. */
export default function TimesheetModal({ open, onClose, day }) {
  return (
    <Modal open={open} onClose={onClose} title={`Timesheet · ${dayLabel(day)}`} width={600}>
      <TimesheetForm key={day} day={day} onDone={onClose} />
    </Modal>
  );
}
