// A client's platform usage export (CSV) → one row per month for actions.importUsage(): credits used are summed over
// the month, assets / sites / seats are snapshots and take the month's highest figure. Columns are found by their
// header (the import dialog shows the mapping and can change it); a file without a date column counts every row toward
// one month the caller picks. Pure, relative imports only (scripts/test-sync.mjs runs it in Node), and it never
// throws on messy input: rows it can't use come back in `skipped` with the reason.
import { parseCsv } from './csv.js';

// Header spellings for each column, most likely first. `month` is the date column.
export const USAGE_COLUMNS = [
  { key: 'month', label: 'Date', aliases: ['date', 'month', 'period', 'day', 'timestamp', 'datetime', 'date time', 'created at', 'usage date', 'billing month', 'billing period'] },
  { key: 'credits', label: 'Credits', aliases: ['credits', 'credits used', 'credit usage', 'usage credits', 'credit', 'credit used', 'credits consumed'] },
  { key: 'assets', label: 'Assets', aliases: ['assets', 'asset count', 'total assets'] },
  { key: 'sites', label: 'Sites', aliases: ['sites', 'locations', 'site count', 'total sites'] },
  { key: 'seats', label: 'Seats', aliases: ['seats', 'users', 'active users', 'seats used', 'user count'] },
];

// ── Header matching ──────────────────────────────────────────────────────────

// "Credits_Used", "creditsUsed" and " credits  used " all read as "credits used".
const words = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Ids and what is left of an allowance ("Site ID", "Credits remaining", "Credit limit") are never usage.
const NOT_USAGE = /\b(id|remaining|balance|available|limit|allowance|quota|left)\b/;

// 100 for the same words, 95 for the same letters run together, 50–90 when the header contains every word of an
// alias ("Usage date (UTC)"), the closer the fit the higher. Earlier aliases win ties.
function score(header, aliases) {
  const h = words(header);
  if (!h || NOT_USAGE.test(h)) return 0;
  const ht = h.split(' ');
  let best = 0;
  aliases.forEach((alias, i) => {
    const a = words(alias);
    const at = a.split(' ');
    let s = 0;
    if (h === a) s = 100;
    else if (h.replace(/ /g, '') === a.replace(/ /g, '')) s = 95;
    else if (at.every((t) => ht.includes(t))) s = 50 + (40 * at.length) / ht.length;
    if (s) best = Math.max(best, s - i * 0.01);
  });
  return best;
}

/** Headers → { month, credits, assets, sites, seats }: each a column index, or -1. Best matches are taken first and
 *  each column is used once. */
export function detectColumns(headers) {
  const list = Array.isArray(headers) ? headers : [];
  const pairs = [];
  USAGE_COLUMNS.forEach((f, fi) => list.forEach((h, hi) => {
    const s = score(h, f.aliases);
    if (s > 0) pairs.push({ key: f.key, fi, hi, s });
  }));
  pairs.sort((a, b) => b.s - a.s || a.fi - b.fi || a.hi - b.hi);
  const mapping = Object.fromEntries(USAGE_COLUMNS.map((f) => [f.key, -1]));
  const used = new Set();
  pairs.forEach(({ key, hi }) => {
    if (mapping[key] !== -1 || used.has(hi)) return;
    mapping[key] = hi;
    used.add(hi);
  });
  return mapping;
}

// ── Values ───────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// 1–12 for a month name or its start ("Sep", "Sept"), else 0: "Mayor" and "Marketing" aren't months.
const monthName = (w) => {
  const x = String(w).toLowerCase();
  return x.length >= 3 ? MONTHS.findIndex((name) => name.startsWith(x)) + 1 : 0;
};
const fullYear = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
// 'YYYY-MM-01' when the day is a real one in that month (this century), else ''.
function monthFor(y, m, d = 1) {
  const real = y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  return real ? `${y}-${pad(m)}-01` : '';
}

// "5 Oct 2026", "05-Oct-2026", "Mon 5 October 2026" | "Oct 5, 2026" (a weekday may come first, a time may follow).
const DAY_MONTH_YEAR = /^(?:[a-z]+\.?,?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?[\s-]+(\d{4}|\d{2})(?!\d)/i;
const MONTH_DAY_YEAR = /^(?:[a-z]+\.?,?\s+)?([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/i;

/** A date, date-time or month in any common spelling → 'YYYY-MM-01', or '' when it isn't one. Slashed dates are day
 *  first (AU). A timestamp counts in the month it is written in (no time zone conversion), so a file gives the same
 *  months whoever imports it. */
export function monthOf(value) {
  const s = String(value ?? '').trim().replace(/^["']+|["']+$/g, '');
  if (!s) return '';
  // 2026-10-05, 2026-10-05T09:30:00Z, 2026/10/05 10:00, 2026-10
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:$|[T\s])/);
  if (m) return monthFor(+m[1], +m[2], m[3] ? +m[3] : 1);
  // 5/10/2026, 05-10-2026, 5.10.26 (day first; only a month-first date has a second part over 12)
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:$|[T\s,])/);
  if (m) {
    let [d, mo] = [+m[1], +m[2]];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return monthFor(fullYear(m[3]), mo, d);
  }
  // 10/2026, 10-2026
  m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return monthFor(+m[2], +m[1]);
  // Oct 2026, October 2026, Sept. 2026, Oct-2026, Oct-26 (Excel's month-year)
  m = s.match(/^([a-z]+)\.?(?:[\s,-]+(\d{4})|-(\d{2}))$/i);
  if (m && monthName(m[1])) return monthFor(fullYear(m[2] || m[3]), monthName(m[1]));
  m = s.match(DAY_MONTH_YEAR);
  if (m && monthName(m[2])) return monthFor(fullYear(m[3]), monthName(m[2]), +m[1]);
  m = s.match(MONTH_DAY_YEAR);
  if (m && monthName(m[1])) return monthFor(+m[3], monthName(m[1]), +m[2]);
  return '';
}

const NOTHING = /^(-+|–|—|n\/?a|none|null|nil)?$/i;

/** '1,234' | '$1,234.50' | '1 234' | '(5)' → a number; blank or a dash → null; anything else → NaN. */
export function numberOf(value) {
  const s = String(value ?? '').trim();
  if (NOTHING.test(s)) return null;
  const t = s.replace(/^\((.*)\)$/, '-$1').replace(/[$,\s  ]/g, '');
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

// ── Rows → months ────────────────────────────────────────────────────────────

const TOTAL = /^(grand |sub ?)?totals?:?$/i;
const blankRow = (r) => !Array.isArray(r) || r.every((c) => String(c ?? '').trim() === '');
// Sums of decimals without the float noise (0.1 + 0.2).
const tidy = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Data rows (arrays of cells) + a mapping → { months, rows, skipped }. `months` is [{ month: 'YYYY-MM-01', credits,
 * assets?, sites?, seats? }], newest first: credits (when that column is mapped) is the month's total, the others the
 * month's highest figure, left out when the month had none. `rows` counts the rows used; `skipped` lists the others as
 * { row, reason } (blank lines aside). `month` is the month every row counts toward when no date column is mapped.
 * `firstRow` is the spreadsheet row number of rows[0] (the header is row 1).
 */
export function usageMonths(rows, mapping, { month = '', firstRow = 2 } = {}) {
  const col = (k) => (Number.isInteger(mapping?.[k]) && mapping[k] >= 0 ? mapping[k] : -1);
  const dateCol = col('month');
  const fixed = dateCol < 0 ? monthOf(month) : '';
  const figures = USAGE_COLUMNS.filter((f) => f.key !== 'month' && col(f.key) >= 0);
  const skipped = [];
  if (!figures.length || (dateCol < 0 && !fixed)) return { months: [], rows: 0, skipped };

  const byMonth = new Map();
  let used = 0;
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    if (blankRow(r)) return;
    const row = firstRow + i;
    const cell = (c) => String(r[c] ?? '').trim();
    // A totals line would count everything twice.
    if (r.some((c) => TOTAL.test(String(c ?? '').trim()))) { skipped.push({ row, reason: 'Total row' }); return; }
    const m = dateCol < 0 ? fixed : monthOf(cell(dateCol));
    if (!m) { skipped.push({ row, reason: cell(dateCol) ? `Not a date: ${cell(dateCol)}` : 'No date' }); return; }
    const values = {};
    for (const f of figures) {
      const n = numberOf(cell(col(f.key)));
      if (Number.isNaN(n)) { skipped.push({ row, reason: `${f.label} isn't a number: ${cell(col(f.key))}` }); return; }
      if (n !== null) values[f.key] = n;
    }
    used++;
    const acc = byMonth.get(m) || { month: m };
    byMonth.set(m, acc);
    figures.forEach(({ key }) => {
      if (key === 'credits') acc.credits = tidy((acc.credits || 0) + (values.credits || 0));
      else if (key in values) acc[key] = key in acc ? Math.max(acc[key], values[key]) : values[key];
    });
  });

  const months = [...byMonth.values()]
    .filter((x) => Object.keys(x).length > 1) // a month with nothing in it changes nothing
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  return { months, rows: used, skipped };
}

/** CSV text → { headers, rows, mapping, firstRow }. The header is whichever of the first ten lines names the most
 *  columns, so a title line above it is passed over; `rows` are the lines after it. */
export function readUsage(text) {
  let all = [];
  try { all = parseCsv(text); } catch { all = []; }
  let at = -1;
  let best = -1;
  for (let i = 0, seen = 0; i < all.length && seen < 10; i++) {
    if (blankRow(all[i])) continue;
    seen++;
    const found = Object.values(detectColumns(all[i])).filter((x) => x >= 0).length;
    if (found > best) { best = found; at = i; }
  }
  if (at < 0) return { headers: [], rows: [], mapping: detectColumns([]), firstRow: 2 };
  const headers = all[at].map((h) => String(h ?? '').trim());
  return { headers, rows: all.slice(at + 1), mapping: detectColumns(headers), firstRow: at + 2 };
}

/** CSV text → { headers, mapping, months, rows, skipped }, with the detected mapping unless one is given. */
export function parseUsage(text, { mapping, month } = {}) {
  const csv = readUsage(text);
  const map = mapping || csv.mapping;
  return { headers: csv.headers, mapping: map, ...usageMonths(csv.rows, map, { month, firstRow: csv.firstRow }) };
}
