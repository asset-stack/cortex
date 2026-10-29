import { useMemo, useRef, useState } from 'react';
import { ArrowRight, FileUp } from 'lucide-react';
import { useStore, useUsers } from '@/data/store';
import { BOARD_SCHEMAS } from '@/data/boards';
import { useAccess } from '@/lib/access';
import { boardHref, boardTitle, findBoard } from '@/lib/boards';
import { Segmented } from '@/components/ui';
import { readCsv } from '@/lib/csv';
import { autoMap, fieldsFor, normalise, withFullName } from '@/lib/importers';
import { compactMoney, shortDate } from '@/lib/format';
import { cn } from '@/lib/cn';

// Accounts and CRM contacts arrive with 0014 (needs: accounts), leads with 0016 (needs: leads).
const KINDS = [
  { id: 'clients', label: 'Clients' }, { id: 'accounts', label: 'Accounts', needs: 'accounts' }, { id: 'people', label: 'CRM contacts', needs: 'accounts' },
  { id: 'deals', label: 'Deals' }, { id: 'contacts', label: 'Outreach contacts' }, { id: 'leads', label: 'Leads', needs: 'leads' },
  { id: 'tasks', label: 'Board tasks' },
];
const OPEN_ROUTE = { clients: 'clients', contacts: 'outreach', deals: 'pipeline', accounts: 'pipeline?tab=accounts', people: 'pipeline?tab=people', leads: 'leads' };
const NEW_GROUP = '__new';

// A preview cell: tasks keep board fields under `values`; a client's key contact, email and phone are its first
// contact; the note is the first note / update.
function cellText(kind, rec, f, users) {
  const v = f.key === 'notes' ? (rec.notes || rec.updates)?.[0]?.text
    : f.person ? rec.contacts?.[0]?.[f.person]
      : kind === 'tasks' && f.key !== 'name' ? rec.values[f.key] : rec[f.key];
  if (f.type === 'user') return users[v]?.name || '';
  if (f.type === 'users') return (v || []).map((id) => users[id]?.name).filter(Boolean).join(', ');
  if (f.type === 'date' || f.type === 'ts') return v ? shortDate(v) : '';
  if (f.type === 'money') return compactMoney(v);
  return v || '';
}

/** CSV import of clients, contacts, deals, leads or board tasks: pick a file, check the column mapping, preview, import.
 *  `only` fixes the kind (Leads opens it for leads, onto `list`). */
export default function Import({ only = '', list = '', onImported }) {
  const { state, actions, missing } = useStore();
  const kinds = KINDS.filter((k) => !k.needs || !missing.includes(k.needs));
  const users = useUsers();
  const [kind, setKind] = useState(only || 'clients');
  const access = useAccess();
  const targets = state.boards.filter((b) => access.canEditBoard(b)); // boards tasks can be imported into
  const [picked, setPicked] = useState('');
  // Until one is picked: the first team board, else your own page (never someone else's page by accident).
  const fallback = targets.find((b) => !b.owner) || targets.find((b) => b.owner === state.me) || targets[0];
  const board = (targets.find((b) => b.id === picked) || fallback)?.id || '';
  const module = findBoard(state, board)?.module || 'projects'; // the board's columns are its module's
  const [group, setGroup] = useState('');
  // Leads go onto a list: one there is, or a new one named here.
  const lists = state.leadLists || [];
  const [leadList, setLeadList] = useState(list);
  const listId = leadList === NEW_GROUP || !lists.length ? NEW_GROUP : lists.some((l) => l.id === leadList) ? leadList : lists[0].id;
  const [listName, setListName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [csv, setCsv] = useState(null); // { name, headers, rows }
  const [mapping, setMapping] = useState({});
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const reading = useRef(0); // ignore a slower read of a file that has since been replaced

  const groups = findBoard(state, board)?.groups || [];
  const groupId = group === NEW_GROUP || !groups.length ? NEW_GROUP : groups.some((g) => g.id === group) ? group : groups[0].id;
  const fields = useMemo(() => fieldsFor(kind, module), [kind, module]);
  const shown = fields.filter((f) => f.key !== 'created' && mapping[f.key] >= 0);

  const { records, blank } = useMemo(() => {
    if (!csv) return { records: [], blank: 0 };
    const all = csv.rows.map((r) => normalise(kind, r, mapping, { users: state.users, me: state.me, board: module }));
    const named = all.filter(Boolean);
    return { records: named, blank: all.length - named.length };
  }, [csv, kind, mapping, state.users, state.me, module]);

  const remap = (k, m) => { if (csv) setMapping(autoMap(csv.headers, k, m)); };
  const chooseKind = (k) => { setKind(k); setResult(null); remap(k, module); };
  const chooseBoard = (id) => { setPicked(id); setGroup(''); remap(kind, findBoard(state, id)?.module || 'projects'); };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again still fires change
    if (!file) return;
    const token = ++reading.current;
    const reader = new FileReader();
    reader.onload = () => {
      if (token !== reading.current) return;
      const { headers, rows } = withFullName(readCsv(String(reader.result || '')));
      if (!headers.length || !rows.length) { setCsv(null); setError('No rows found.'); return; }
      setError(''); setResult(null);
      setCsv({ name: file.name, headers, rows });
      setMapping(autoMap(headers, kind, module));
    };
    reader.onerror = () => { if (token === reading.current) setError("Couldn't read that file."); };
    reader.readAsText(file);
  };

  const needsGroupName = (kind === 'tasks' && groupId === NEW_GROUP && !groupName.trim())
    || (kind === 'leads' && listId === NEW_GROUP && !listName.trim());
  const ready = !!csv && mapping.name >= 0 && records.length > 0 && !needsGroupName;
  const run = () => {
    if (!ready) return;
    const options = kind === 'tasks'
      ? { board, groupId: groupId === NEW_GROUP ? '' : groupId, groupName: groupId === NEW_GROUP ? groupName.trim() : '' }
      : {};
    let target = '';
    if (kind === 'leads') target = listId === NEW_GROUP ? actions.addLeadList({ name: listName.trim() }) : listId;
    const res = (kind === 'leads' ? target && actions.importLeads(target, records) : actions.importRecords(kind, records, options)) || {};
    setResult({ kind, board, list: target, added: res.added ?? 0, skipped: res.skipped ?? 0, blank });
    if (kind === 'leads' && target) { setLeadList(target); setListName(''); onImported?.(target); }
    setCsv(null); setMapping({}); setGroupName('');
    if (groupId === NEW_GROUP) setGroup('');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
        {!only && <Segmented label="Import type" value={kind} onChange={chooseKind} options={kinds} />}
        {kind === 'leads' && (
          <div className={cn('grid gap-3 sm:grid-cols-2', !only && 'mt-4')}>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">List</span>
              <select className="field" value={listId} onChange={(e) => setLeadList(e.target.value)}>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                <option value={NEW_GROUP}>New list</option>
              </select>
            </label>
            {listId === NEW_GROUP && (
              <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">List name</span>
                <input className="field" value={listName} onChange={(e) => setListName(e.target.value)} />
              </label>
            )}
          </div>
        )}
        {kind === 'tasks' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Board</span>
              <select className="field" value={board} onChange={(e) => chooseBoard(e.target.value)}>
                {Object.entries(BOARD_SCHEMAS).map(([k, s]) => targets.some((b) => b.module === k) && (
                  <optgroup key={k} label={s.title}>
                    {targets.filter((b) => b.module === k).map((b) => <option key={b.id} value={b.id}>{boardTitle(state, b)}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Group</span>
              <select className="field" value={groupId} onChange={(e) => setGroup(e.target.value)}>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                <option value={NEW_GROUP}>New group</option>
              </select>
            </label>
            {groupId === NEW_GROUP && (
              <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Group name</span>
                <input className="field" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
              </label>
            )}
          </div>
        )}
        <div className={cn('flex flex-wrap items-center gap-3', (!only || kind === 'leads') && 'mt-5')}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" tabIndex={-1} aria-hidden="true" onChange={onFile} />
          <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 rounded-full chip px-4 h-10 font-semibold">
            <FileUp className="h-4 w-4" />Choose CSV
          </button>
          {csv && <span className="min-w-0 truncate dim">{csv.name}</span>}
          {csv && <span className="rounded-full chip px-2.5 py-0.5 text-[12px] tnum">{csv.rows.length} row{csv.rows.length === 1 ? '' : 's'}</span>}
        </div>
        {error && <p role="alert" className="mt-3 text-[12.5px] text-amber-200">{error}</p>}
      </div>

      {csv && (
        <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
          <h2 className="font-extrabold text-[16px]">Columns</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => {
              const missing = f.required && !(mapping[f.key] >= 0);
              return (
                <label key={f.key} className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">{f.label}</span>
                  <select className={cn('field', missing && '!border-rose-400')} aria-invalid={missing || undefined} value={mapping[f.key] ?? -1}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))}>
                    <option value={-1}>—</option>
                    {csv.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {csv && (
        <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-extrabold text-[16px]">Preview</h2>
            <button type="button" onClick={run} disabled={!ready} className="btn-primary inline-flex items-center gap-2 rounded-full px-5 h-11 font-semibold">
              Import {records.length}
            </button>
          </div>
          {records.length === 0 ? <p className="mt-3 dimmer">No rows to import.</p> : (
            <div className="mt-3 overflow-x-auto scroll-thin">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead><tr className="text-left text-[12px] dimmer">{shown.map((f) => <th key={f.key} className="p-2.5 font-medium">{f.label}</th>)}</tr></thead>
                <tbody>
                  {records.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t rowline">
                      {shown.map((f) => {
                        const t = cellText(kind, r, f, users);
                        return <td key={f.key} className={cn('max-w-[240px] truncate p-2.5', f.key === 'name' ? 'font-semibold' : 'dim')} title={t}>{t || <span className="dimmer">—</span>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div role="status">
        {result && (
          <div className="flex flex-wrap items-center gap-3 rounded-[22px] glass px-5 py-3.5">
            <span className="font-semibold">
              Imported {result.added}, skipped {result.skipped}{result.kind === 'people' ? '' : ` duplicate${result.skipped === 1 ? '' : 's'}`}
              {result.blank > 0 && `, ${result.blank} without a name`}
            </span>
            {result.added > 0 && !only && (
              <a href={result.kind === 'tasks' ? boardHref(findBoard(state, result.board))
                : result.kind === 'leads' ? `#/leads?list=${result.list}` : `#/${OPEN_ROUTE[result.kind]}`} className="ml-auto inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 text-[12.5px] font-semibold">
                Open<ArrowRight className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
