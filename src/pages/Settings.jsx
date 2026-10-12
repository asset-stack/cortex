import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileUp } from 'lucide-react';
import { useIsAdmin, useStore, useUsers } from '@/data/store';
import { ALLOWED_DOMAIN } from '@/data/backend/client';
import { BOARD_SCHEMAS } from '@/data/boards';
import { Avatar, PageHeader, Segmented } from '@/components/ui';
import { readCsv } from '@/lib/csv';
import { autoMap, fieldsFor, normalise, withFullName } from '@/lib/importers';
import { compactMoney, shortDate } from '@/lib/format';
import { hashParam } from '@/lib/router';
import { cn } from '@/lib/cn';

const SECTIONS = [{ id: 'team', label: 'Team' }, { id: 'business', label: 'Business' }, { id: 'import', label: 'Import' }];

function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-7 w-12 shrink-0 rounded-full border border-white/25 transition-colors disabled:opacity-50', checked ? 'bg-emerald-400/70' : 'bg-white/10')}>
      <span className={cn('absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-[2px]')} />
    </button>
  );
}

// Your own row is locked, so an admin can't demote or deactivate themselves (the store also keeps one active admin).
function Team() {
  const { state, actions } = useStore();
  return (
    <div className="rounded-[26px] glass glass-rim p-2 sm:p-3">
      <ul>
        {state.users.map((u) => {
          const self = u.id === state.me;
          const active = u.active !== false;
          return (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b rowline p-3 last:border-b-0">
              <div className={cn('flex min-w-0 flex-1 basis-[220px] items-center gap-3', !active && 'opacity-60')}>
                <Avatar userId={u.id} size={36} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-semibold"><span className="truncate">{u.name}</span>
                    {self && <span className="rounded-full chip px-2 py-0.5 text-[11px]">You</span>}</div>
                  <div className="text-[12.5px] dimmer truncate">{u.email || '—'}</div>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-4">
                <select className="field !w-auto !rounded-full !py-1.5 disabled:opacity-50" aria-label={`Role for ${u.name}`} value={u.role || 'member'} disabled={self}
                  onChange={(e) => actions.updateProfile(u.id, { role: e.target.value })}>
                  <option value="admin">Admin</option><option value="member">Member</option>
                </select>
                <span className="flex items-center gap-2 text-[12.5px] dim">Active
                  <Switch checked={active} disabled={self} label={`${u.name} active`} onChange={(v) => actions.updateProfile(u.id, { active: v })} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="px-3 pb-2 pt-1 text-[12px] dimmer">Staff join by signing in with their @{ALLOWED_DOMAIN} Google account.</p>
    </div>
  );
}

const ORG_DEFAULTS = {
  businessName: '', abn: '', address: '', email: '', phone: '', bankAccountName: '', bsb: '', accountNumber: '',
  paymentTermsDays: 30, invoicePrefix: 'INV-',
};

// Hints only: an odd ABN or BSB is still saved.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
function abnHint(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const d = s.replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return 'ABN is 11 digits';
  // ATO check: subtract 1 from the first digit, weight the digits, and the sum divides by 89.
  const sum = [...d].reduce((t, c, i) => t + (Number(c) - (i === 0 ? 1 : 0)) * ABN_WEIGHTS[i], 0);
  return sum % 89 === 0 ? '' : 'Check the ABN';
}
const bsbHint = (v) => (String(v || '').trim() && !/^\d{6}$/.test(String(v).replace(/[\s-]/g, '')) ? 'BSB is 6 digits' : '');

function Field({ label, hint, multiline, className, ...props }) {
  const id = useId();
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[12px] dimmer">{label}</span>
      <Tag className={cn('field', multiline && 'resize-none !rounded-[18px]', hint && '!border-amber-300')} autoComplete="off"
        aria-invalid={hint ? true : undefined} aria-describedby={hint ? id : undefined} {...props} />
      {hint && <span id={id} className="text-[12px] text-amber-200">{hint}</span>}
    </label>
  );
}

function Business() {
  const { state, actions } = useStore();
  const org = { ...ORG_DEFAULTS, ...state.org };
  const set = (k) => (e) => actions.updateOrg({ [k]: e.target.value });
  // Payment terms keep their own text so the box can be cleared while typing; only whole days are saved.
  const [terms, setTerms] = useState(String(org.paymentTermsDays));
  useEffect(() => { setTerms((t) => (Number(t) === org.paymentTermsDays && t.trim() !== '' ? t : String(org.paymentTermsDays))); }, [org.paymentTermsDays]);
  const onTerms = (e) => {
    const v = e.target.value;
    setTerms(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 365) actions.updateOrg({ paymentTermsDays: n });
  };
  return (
    <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
      <h2 className="font-extrabold text-[16px]">Details</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Business name" value={org.businessName} onChange={set('businessName')} />
        <Field label="ABN" value={org.abn} onChange={set('abn')} inputMode="numeric" hint={abnHint(org.abn)} />
        <Field label="Email" type="email" value={org.email} onChange={set('email')} />
        <Field label="Phone" type="tel" value={org.phone} onChange={set('phone')} />
        <Field label="Address" multiline rows={3} className="sm:col-span-2" value={org.address} onChange={set('address')} />
      </div>
      <h2 className="mt-7 font-extrabold text-[16px]">Bank</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Account name" className="sm:col-span-2" value={org.bankAccountName} onChange={set('bankAccountName')} />
        <Field label="BSB" value={org.bsb} onChange={set('bsb')} inputMode="numeric" hint={bsbHint(org.bsb)} />
        <Field label="Account number" value={org.accountNumber} onChange={set('accountNumber')} inputMode="numeric" />
      </div>
      <h2 className="mt-7 font-extrabold text-[16px]">Invoices</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Payment terms (days)" type="number" min={0} max={365} step={1} inputMode="numeric" value={terms} onChange={onTerms}
          onBlur={() => setTerms(String(org.paymentTermsDays))} />
        <Field label="Invoice prefix" value={org.invoicePrefix} onChange={set('invoicePrefix')} />
      </div>
    </div>
  );
}

const KINDS = [{ id: 'clients', label: 'Clients' }, { id: 'contacts', label: 'Contacts' }, { id: 'deals', label: 'Deals' }, { id: 'tasks', label: 'Board tasks' }];
const OPEN_ROUTE = { clients: 'clients', contacts: 'outreach', deals: 'pipeline' };
const NEW_GROUP = '__new';

// A preview cell: tasks keep board fields under `values`; the note is the first note / update.
function cellText(kind, rec, f, users) {
  const v = f.key === 'notes' ? (rec.notes || rec.updates)?.[0]?.text
    : kind === 'tasks' && f.key !== 'name' ? rec.values[f.key] : rec[f.key];
  if (f.type === 'user') return users[v]?.name || '';
  if (f.type === 'users') return (v || []).map((id) => users[id]?.name).filter(Boolean).join(', ');
  if (f.type === 'date' || f.type === 'ts') return v ? shortDate(v) : '';
  if (f.type === 'money') return compactMoney(v);
  return v || '';
}

function Import() {
  const { state, actions } = useStore();
  const users = useUsers();
  const [kind, setKind] = useState('clients');
  const [board, setBoard] = useState('projects');
  const [group, setGroup] = useState('');
  const [groupName, setGroupName] = useState('');
  const [csv, setCsv] = useState(null); // { name, headers, rows }
  const [mapping, setMapping] = useState({});
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const reading = useRef(0); // ignore a slower read of a file that has since been replaced

  const groups = state.boards[board]?.groups || [];
  const groupId = group === NEW_GROUP || !groups.length ? NEW_GROUP : groups.some((g) => g.id === group) ? group : groups[0].id;
  const fields = useMemo(() => fieldsFor(kind, board), [kind, board]);
  const shown = fields.filter((f) => f.key !== 'created' && mapping[f.key] >= 0);

  const { records, blank } = useMemo(() => {
    if (!csv) return { records: [], blank: 0 };
    const all = csv.rows.map((r) => normalise(kind, r, mapping, { users: state.users, me: state.me, board }));
    const named = all.filter(Boolean);
    return { records: named, blank: all.length - named.length };
  }, [csv, kind, mapping, state.users, state.me, board]);

  const remap = (k, b) => { if (csv) setMapping(autoMap(csv.headers, k, b)); };
  const chooseKind = (k) => { setKind(k); setResult(null); remap(k, board); };
  const chooseBoard = (b) => { setBoard(b); setGroup(''); remap(kind, b); };

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
      setMapping(autoMap(headers, kind, board));
    };
    reader.onerror = () => { if (token === reading.current) setError("Couldn't read that file."); };
    reader.readAsText(file);
  };

  const needsGroupName = kind === 'tasks' && groupId === NEW_GROUP && !groupName.trim();
  const ready = !!csv && mapping.name >= 0 && records.length > 0 && !needsGroupName;
  const run = () => {
    if (!ready) return;
    const options = kind === 'tasks'
      ? { board, groupId: groupId === NEW_GROUP ? '' : groupId, groupName: groupId === NEW_GROUP ? groupName.trim() : '' }
      : {};
    const res = actions.importRecords(kind, records, options) || {};
    setResult({ kind, board, added: res.added ?? 0, skipped: res.skipped ?? 0, blank });
    setCsv(null); setMapping({}); setGroupName('');
    if (groupId === NEW_GROUP) setGroup('');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[26px] glass glass-rim p-5 sm:p-6">
        <Segmented label="Import type" value={kind} onChange={chooseKind} options={KINDS} />
        {kind === 'tasks' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5"><span className="text-[12px] dimmer">Board</span>
              <select className="field" value={board} onChange={(e) => chooseBoard(e.target.value)}>
                {Object.entries(BOARD_SCHEMAS).map(([k, s]) => <option key={k} value={k}>{s.title}</option>)}
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
        <div className="mt-5 flex flex-wrap items-center gap-3">
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
              Imported {result.added}, skipped {result.skipped} duplicate{result.skipped === 1 ? '' : 's'}
              {result.blank > 0 && `, ${result.blank} without a name`}
            </span>
            {result.added > 0 && (
              <a href={`#/${result.kind === 'tasks' ? result.board : OPEN_ROUTE[result.kind]}`} className="ml-auto inline-flex items-center gap-1.5 rounded-full chip px-3 py-1.5 text-[12.5px] font-semibold">
                Open<ArrowRight className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Settings() {
  const isAdmin = useIsAdmin();
  const [section, setSection] = useState(() => (SECTIONS.some((s) => s.id === hashParam('tab')) ? hashParam('tab') : 'team')); // #/settings?tab=import
  // The route guard in App keeps members out; this covers a render before it applies.
  if (!isAdmin) return <PageHeader title="Settings" />;
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mt-6"><Segmented label="Settings sections" value={section} onChange={setSection} options={SECTIONS} /></div>
      <div className="mt-6 max-w-[920px]">
        {section === 'team' && <Team />}
        {section === 'business' && <Business />}
        {section === 'import' && <Import />}
      </div>
    </div>
  );
}
