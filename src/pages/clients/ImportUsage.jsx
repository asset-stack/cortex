// Import usage: a client's platform export (CSV) totalled per month (src/lib/usageImport.js), checked in a preview, then
// actions.importUsage(), which replaces those months' figures (the same file twice changes nothing). Opened from the
// Usage page with a client picker, or from a client's Usage tab with `clientId`. Needs edit access to Clients.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/data/store';
import { useAccess } from '@/lib/access';
import { Modal } from '@/components/ui';
import { addMonths } from '@/lib/automations';
import { count, localYmd, monthLabel, monthStart } from '@/lib/format';
import { USAGE_COLUMNS, readUsage, usageMonths } from '@/lib/usageImport';
import { FILE_INPUT, Labelled, MODAL_FORM, MonthNav } from './shared';

const FIGURES = USAGE_COLUMNS.filter((f) => f.key !== 'month');
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en-AU', { sensitivity: 'base' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ImportForm({ clientId, onClose, onImported }) {
  const { state, actions } = useStore();
  const editable = useAccess().canEdit('clients');
  const clients = useMemo(() => [...state.clients].sort(byName), [state.clients]);
  const [picked, setPicked] = useState('');
  const [csv, setCsv] = useState(null); // { name, headers, rows, firstRow }
  const [mapping, setMapping] = useState({});
  const [month, setMonth] = useState(() => addMonths(monthStart(localYmd()), -1)); // a file without dates: last month
  const [error, setError] = useState('');
  const [done, setDone] = useState(0); // months imported
  const reading = useRef(0); // ignore a slower read of a file that has since been replaced
  const close = useRef(onClose);
  close.current = onClose;

  const target = clientId || picked;
  const dated = mapping.month >= 0;
  const result = useMemo(() => (csv ? usageMonths(csv.rows, mapping, { month, firstRow: csv.firstRow }) : null), [csv, mapping, month]);
  const shown = FIGURES.filter((f) => mapping[f.key] >= 0);
  const ready = editable && !!target && result?.months.length > 0;

  // The result shows for a moment, then the dialog closes.
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => close.current(), 1600);
    return () => clearTimeout(t);
  }, [done]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    const token = ++reading.current;
    setError('');
    if (!file) { setCsv(null); return; }
    try {
      const text = await file.text();
      if (token !== reading.current) return;
      const read = readUsage(text);
      if (!read.headers.length || !read.rows.some((r) => r.some((c) => c.trim()))) { setCsv(null); setError('No rows found.'); return; }
      setCsv({ name: file.name, ...read });
      setMapping(read.mapping);
    } catch {
      if (token === reading.current) { setCsv(null); setError("Couldn't read that file."); }
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    const n = actions.importUsage(target, result.months);
    if (!(n > 0)) { setError('Import failed.'); return; }
    setDone(n);
    onImported?.(result.months);
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="font-semibold">{plural(done, 'month')} imported</p>
        <button type="button" onClick={onClose} autoFocus className="btn-primary h-11 rounded-full font-semibold">Done</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={MODAL_FORM}>
      {!clientId && (
        <Labelled label="Client">
          <select className="field" value={picked} onChange={(e) => setPicked(e.target.value)} autoFocus>
            <option value="">—</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Labelled>
      )}
      <Labelled label="CSV file">
        <input type="file" accept=".csv,text/csv" className={FILE_INPUT} onChange={onFile} />
      </Labelled>
      {error && <div role="alert" className="text-[12.5px] text-rose-200">{error}</div>}

      {csv && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {USAGE_COLUMNS.map((f) => (
            <Labelled key={f.key} label={f.label}>
              <select className="field" value={mapping[f.key] ?? -1} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))}>
                <option value={-1}>—</option>
                {csv.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
            </Labelled>
          ))}
        </div>
      )}
      {csv && !dated && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] dimmer">Month</span>
          <div><MonthNav month={month} onChange={setMonth} /></div>
        </div>
      )}

      {result && (result.months.length === 0 ? <p className="dimmer">No months to import.</p> : (
        <div className="overflow-x-auto scroll-thin rounded-2xl chip">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[12px] dimmer">
                <th className="p-2.5 font-medium">Month</th>
                {shown.map((f) => <th key={f.key} className="p-2.5 text-right font-medium">{f.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.months.map((x) => (
                <tr key={x.month} className="border-t rowline">
                  <td className="whitespace-nowrap p-2.5 font-semibold">{monthLabel(x.month)}</td>
                  {shown.map((f) => (
                    <td key={f.key} className="p-2.5 text-right tnum">{x[f.key] === undefined ? <span className="dimmer">—</span> : count(x[f.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {result && result.skipped.length > 0 && (
        <details className="text-[12.5px]">
          <summary className="cursor-pointer text-amber-200">{plural(result.skipped.length, 'row')} skipped</summary>
          <ul className="mt-1.5 flex max-h-32 flex-col gap-0.5 overflow-y-auto scroll-thin dim">
            {result.skipped.slice(0, 100).map((s) => <li key={s.row} className="break-words">Row {s.row}: {s.reason}</li>)}
          </ul>
        </details>
      )}

      <button type="submit" disabled={!ready} className="btn-primary h-11 shrink-0 rounded-full font-semibold">
        {ready ? `Import ${plural(result.months.length, 'month')}` : 'Import'}
      </button>
    </form>
  );
}

/** The import dialog. `onImported(months)` runs after a successful import (the Usage page moves to the newest). */
export default function ImportUsage({ open, onClose, clientId = '', onImported }) {
  return (
    <Modal open={open} onClose={onClose} title="Import usage" width={560}>
      <ImportForm clientId={clientId} onClose={onClose} onImported={onImported} />
    </Modal>
  );
}
