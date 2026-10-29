// Pipeline → Reports (docs/PHASE2.md §22): the forecast by close month, the funnel (deals, value, time in each stage and
// how many go on), won and lost with the lost reasons, and deals by sector or country. Values stay in each deal's
// currency. Each table's bars show counts (one series, one colour; the number is always written next to it).
import { useState } from 'react';
import { useStore } from '@/data/store';
import { Segmented } from '@/components/ui';
import { breakdown, byStage, conversion, forecast, timeInStage, winLoss } from '@/lib/reports';
import { localYmd } from '@/lib/format';
import { cn } from '@/lib/cn';

const PERIODS = [{ id: '30', label: '30 days' }, { id: '90', label: '90 days' }, { id: '365', label: '12 months' }];
const DIMENSIONS = [{ id: 'sector', label: 'Sector' }, { id: 'country', label: 'Country' }];

/** A count with a bar scaled to the table's largest (the number carries the meaning; the bar only its size). */
function CountBar({ n, max, label }) {
  const pct = max ? Math.max(n ? 4 : 0, Math.round((n / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2" title={label}>
      <span className="w-6 shrink-0 text-right tnum">{n}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <span className="block h-full rounded-full bg-indigo-300/80" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const Money = ({ list }) => <span className="tnum">{(list || []).join(' · ')}</span>;

function Section({ title, actions, children }) {
  return (
    <section className="rounded-[24px] glass p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-extrabold text-[16px]">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const TH = 'px-2 py-2 text-left text-[12px] font-medium dimmer';
const TD = 'px-2 py-2 align-middle';

export default function Reports() {
  const { state } = useStore();
  const [period, setPeriod] = useState('90');
  const [dim, setDim] = useState('sector');
  const fc = forecast(state, { today: localYmd() });
  const stages = byStage(state);
  const times = new Map(timeInStage(state).map((x) => [x.stage, x]));
  const conv = new Map(conversion(state).map((x) => [x.stage, x]));
  const wl = winLoss(state, { days: Number(period) });
  const groups = breakdown(state, dim);
  const max = (list, k) => Math.max(0, ...list.map((x) => x[k]));
  const history = (state.dealHistory || []).length > 0;

  return (
    <div className="mt-6 grid gap-5 xl:grid-cols-2">
      <Section title="Forecast">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[460px] text-[13px]">
            <thead><tr><th className={TH}>Close</th><th className={cn(TH, 'w-[34%]')}>Deals</th><th className={TH}>Value</th><th className={TH}>Weighted</th></tr></thead>
            <tbody>
              {fc.map((r) => (
                <tr key={r.key} className={cn('border-t rowline', r.key === 'overdue' && r.count > 0 && 'text-amber-200')}>
                  <td className={cn(TD, 'whitespace-nowrap font-semibold')}>{r.label}</td>
                  <td className={TD}><CountBar n={r.count} max={max(fc, 'count')} label={`${r.count} deals closing ${r.label}`} /></td>
                  <td className={TD}>{r.count ? <Money list={r.value} /> : <span className="dimmer">—</span>}</td>
                  <td className={TD}>{r.count ? <Money list={r.weighted} /> : <span className="dimmer">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Stages">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr><th className={TH}>Stage</th><th className={cn(TH, 'w-[28%]')}>Open</th><th className={TH}>Value</th><th className={TH}>Avg days</th><th className={TH}>Go on</th></tr>
            </thead>
            <tbody>
              {stages.map((r) => {
                const t = times.get(r.stage);
                const c = conv.get(r.stage);
                return (
                  <tr key={r.stage} className="border-t rowline">
                    <td className={cn(TD, 'whitespace-nowrap font-semibold')}>{r.stage}</td>
                    <td className={TD}><CountBar n={r.count} max={max(stages, 'count')} label={`${r.count} open at ${r.stage}`} /></td>
                    <td className={TD}>{r.count ? <Money list={r.value} /> : <span className="dimmer">—</span>}</td>
                    <td className={cn(TD, 'tnum')}>{history && t?.avgDays !== null ? t.avgDays : <span className="dimmer">—</span>}</td>
                    <td className={cn(TD, 'tnum whitespace-nowrap')} title={c ? `${c.onward} of ${c.reached} went on` : ''}>
                      {c?.rate !== null && c?.rate !== undefined ? `${c.rate}%` : <span className="dimmer">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Won and lost" actions={<Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />}>
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Won', wl.won.count, wl.won.count ? wl.won.value.join(' · ') : ''],
            ['Lost', wl.lost.count, wl.lost.count ? wl.lost.value.join(' · ') : ''],
            ['Win rate', wl.rate === null ? '—' : `${wl.rate}%`, ''],
          ].map(([label, value, sub]) => (
            <div key={label} className="rounded-2xl chip px-3 py-2.5">
              <div className="text-[22px] font-black leading-none tnum">{value}</div>
              <div className="mt-1 text-[12px] dim">{label}{sub ? ` · ${sub}` : ''}</div>
            </div>
          ))}
        </div>
        <h3 className="mt-4 mb-1 text-[13px] font-bold">Lost reasons</h3>
        {wl.reasons.length === 0 ? <p className="dimmer text-[13px]">None in this period.</p> : (
          <table className="w-full text-[13px]">
            <tbody>
              {wl.reasons.map((r) => (
                <tr key={r.reason} className="border-t rowline first:border-t-0">
                  <td className={cn(TD, 'w-[45%]')}>{r.reason}</td>
                  <td className={TD}><CountBar n={r.count} max={max(wl.reasons, 'count')} label={`${r.count} lost: ${r.reason}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Deals by" actions={<Segmented label="Group by" value={dim} onChange={setDim} options={DIMENSIONS} />}>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[460px] text-[13px]">
            <thead><tr><th className={TH}>{dim === 'country' ? 'Country' : 'Sector'}</th><th className={cn(TH, 'w-[30%]')}>Open</th><th className={TH}>Value</th><th className={TH}>Won</th><th className={TH}>Lost</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key || 'none'} className="border-t rowline">
                  <td className={cn(TD, 'max-w-[180px] truncate font-semibold', !g.key && 'dim font-normal')}>{g.label}</td>
                  <td className={TD}><CountBar n={g.open} max={max(groups, 'open')} label={`${g.open} open`} /></td>
                  <td className={TD}>{g.open ? <Money list={g.value} /> : <span className="dimmer">—</span>}</td>
                  <td className={cn(TD, 'tnum')}>{g.won || <span className="dimmer">—</span>}</td>
                  <td className={cn(TD, 'tnum')}>{g.lost || <span className="dimmer">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
