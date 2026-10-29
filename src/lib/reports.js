// Pipeline → Reports (docs/PHASE2.md §22): the numbers a sales review asks for, from the deals and their stage history
// (0015). Values stay in each deal's currency (never converted): every total is a list per currency (totalsList()).
// Pure, with relative imports, so scripts/test-sync.mjs runs it in Node.
import { DEAL_STAGES, LOST, dealProbability, dealStage } from '../data/boards.js';
import { accountOf, isOpenDeal } from './accounts.js';
import { totalsList } from './format.js';

const DAY = 864e5;
const weighted = (deals) => deals.map((d) => ({ currency: d.currency, value: ((d.value || 0) * dealProbability(d)) / 100 }));
const sum = (deals) => ({ count: deals.length, value: totalsList(deals), weighted: totalsList(weighted(deals)) });
const month = (ymd) => String(ymd || '').slice(0, 7);
const addMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Open deals by expected close month: overdue (before this month), this month and the next `months - 1`, later, and
 *  no date. → [{ key, label, count, value, weighted }] (value / weighted: totals per currency). */
export function forecast(state, { today, months = 6 } = {}) {
  const open = (state?.deals || []).filter(isOpenDeal);
  const now = month(today);
  const last = addMonth(now, months - 1);
  const label = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const rows = [{ key: 'overdue', label: 'Overdue', deals: open.filter((d) => d.closeOn && month(d.closeOn) < now) }];
  for (let i = 0; i < months; i++) {
    const ym = addMonth(now, i);
    rows.push({ key: ym, label: label(ym), deals: open.filter((d) => month(d.closeOn) === ym) });
  }
  rows.push({ key: 'later', label: 'Later', deals: open.filter((d) => d.closeOn && month(d.closeOn) > last) });
  rows.push({ key: 'none', label: 'No close date', deals: open.filter((d) => !d.closeOn) });
  return rows.map(({ deals, ...r }) => ({ ...r, ...sum(deals) }));
}

/** Open deals by stage, in board order. → [{ stage, count, value, weighted }] */
export const byStage = (state) => {
  const open = (state?.deals || []).filter(isOpenDeal);
  return DEAL_STAGES.map((stage) => ({ stage, ...sum(open.filter((d) => dealStage(d) === stage)) }));
};

// When a deal was won (made a client) or lost: its history row to Won / Lost, else (no history yet) when it reached its
// stage; '' when not known.
function closedAt(state, deal, to) {
  const rows = (state?.dealHistory || []).filter((h) => h.dealId === deal.id && h.to === to);
  return rows.length ? rows[rows.length - 1].at : deal.stageAt || '';
}

/** Won and lost in the last `days` (by when they closed): counts, values, the win rate, and lost reasons by count.
 *  → { won, lost, rate (0–100, or null), reasons: [{ reason, count }] } */
export function winLoss(state, { now = Date.now(), days = 90 } = {}) {
  const since = now - days * DAY;
  const inWindow = (at) => { const t = Date.parse(at); return Number.isFinite(t) && t >= since && t <= now; };
  const deals = state?.deals || [];
  const won = deals.filter((d) => d.clientId && inWindow(closedAt(state, d, 'Won')));
  const lost = deals.filter((d) => !d.clientId && dealStage(d) === LOST && inWindow(closedAt(state, d, LOST)));
  const counts = new Map();
  lost.forEach((d) => { const r = String(d.lostReason || '').trim() || 'No reason given'; counts.set(r, (counts.get(r) || 0) + 1); });
  return {
    won: sum(won), lost: sum(lost),
    rate: won.length + lost.length ? Math.round((won.length * 100) / (won.length + lost.length)) : null,
    reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/** Time in each stage, from the history: each stay runs from the move into the stage to the deal's next move (or now,
 *  for an open deal still there). → [{ stage, avgDays (one decimal, or null), stays }] */
export function timeInStage(state, { now = Date.now() } = {}) {
  const byDeal = new Map();
  (state?.dealHistory || []).forEach((h) => { (byDeal.get(h.dealId) || byDeal.set(h.dealId, []).get(h.dealId)).push(h); });
  const deals = new Map((state?.deals || []).map((d) => [d.id, d]));
  const stays = new Map(DEAL_STAGES.map((s) => [s, []]));
  byDeal.forEach((rows, dealId) => {
    const deal = deals.get(dealId);
    const sorted = [...rows].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    sorted.forEach((h, i) => {
      if (!stays.has(h.to)) return;
      const next = sorted[i + 1];
      if (!next && !(deal && isOpenDeal(deal) && dealStage(deal) === h.to)) return; // a closed deal's last row isn't a stay
      const end = next ? Date.parse(next.at) : now;
      const start = Date.parse(h.at);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) stays.get(h.to).push((end - start) / DAY);
    });
  });
  return DEAL_STAGES.map((stage) => {
    const list = stays.get(stage);
    return { stage, stays: list.length, avgDays: list.length ? Math.round((list.reduce((t, x) => t + x, 0) / list.length) * 10) / 10 : null };
  });
}

/** Stage-to-stage conversion: of the deals that reached a stage (by their history, or where they are now), how many went
 *  on past it (a later stage, or Won). The last stage's next is Won. → [{ stage, reached, onward, rate (%, or null) }] */
export function conversion(state) {
  const furthest = new Map(); // deal id → highest stage index reached (DEAL_STAGES.length for Won)
  const reach = (id, i) => { if (i >= 0 && i > (furthest.get(id) ?? -1)) furthest.set(id, i); };
  const index = (stage) => (stage === 'Won' ? DEAL_STAGES.length : DEAL_STAGES.indexOf(stage));
  (state?.dealHistory || []).forEach((h) => { reach(h.dealId, index(h.to)); reach(h.dealId, index(h.from)); });
  (state?.deals || []).forEach((d) => { reach(d.id, d.clientId ? DEAL_STAGES.length : index(dealStage(d))); });
  const highs = [...furthest.values()];
  return DEAL_STAGES.map((stage, i) => {
    const reached = highs.filter((x) => x >= i).length;
    const onward = highs.filter((x) => x > i).length;
    return { stage, reached, onward, rate: reached ? Math.round((onward * 100) / reached) : null };
  });
}

/** Deals by a dimension ('sector': the deal's, else its account's; 'country': its account's): open count and value, won
 *  and lost counts. Biggest first; '' is "Not set". → [{ key, open, value, won, lost }] */
export function breakdown(state, by = 'sector') {
  const keyOf = (d) => {
    const a = accountOf(state, d);
    return String((by === 'country' ? a?.country : d.sector || a?.sector) || '').trim();
  };
  const groups = new Map();
  (state?.deals || []).forEach((d) => {
    const k = keyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  });
  return [...groups].map(([key, deals]) => {
    const open = deals.filter(isOpenDeal);
    return {
      key, label: key || 'Not set', open: open.length, value: totalsList(open),
      won: deals.filter((d) => d.clientId).length, lost: deals.filter((d) => !d.clientId && dealStage(d) === LOST).length,
    };
  }).sort((a, b) => (b.open + b.won) - (a.open + a.won) || (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.label.localeCompare(b.label));
}
