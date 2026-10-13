// The tax invoice as a PDF (the file that is emailed), drawn with pdf-lib from taxInvoiceModel(): the same model as the
// printed copy (TaxInvoice in src/pages/clients/invoice.jsx, laid out by .tax-invoice in src/styles/index.css), so the
// two never disagree. The app reaches this file only through import(), so Vite puts pdf-lib in its own chunk.
// Pure (relative imports), so the Node tests render it too.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { taxInvoiceModel } from './taxInvoice.js';

// ── Text the standard fonts can draw ───────────────────────────────────────────

// Helvetica (a standard PDF font) encodes WinAnsi only: printable ASCII, U+00A0–U+00FF and these CP1252 extras.
const CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
// Stand-ins for common characters outside it.
const SWAP = new Map(Object.entries({
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2015': '—', '\u2212': '-', '\u2044': '/', '\u2032': "'", '\u2033': '"',
  '←': '<-', '→': '->', '↔': '<->', '⇐': '<=', '⇒': '=>', '⇔': '<=>', '⟵': '<-', '⟶': '->',
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ħ: 'h', Ħ: 'H',
}));
// Invisible, so dropped: combining marks left over after composing, format characters (soft hyphen, zero-width spaces
// and joiners, direction marks, BOM) and emoji skin tones.
const HIDDEN = /[\p{M}\p{Cf}\u{1F3FB}-\u{1F3FF}]/u;
const encodable = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) || CP1252.has(ch);
};
const standIn = (ch) => (encodable(ch) ? ch : SWAP.get(ch) ?? (/\s/u.test(ch) ? ' ' : null));

/** `text` in WinAnsi, which the standard fonts can draw: other accented letters lose the accent (ā → a), minus signs,
 *  odd spaces and arrows get ASCII stand-ins, and anything else becomes '?'. Never throws. */
export function winAnsi(text) {
  let s;
  try {
    s = String(text ?? '').normalize('NFC');
  } catch {
    return '';
  }
  let out = '';
  for (const ch of s) {
    if (HIDDEN.test(ch)) continue;
    let rep = standIn(ch);
    if (rep == null) {
      // Compatibility decomposition: ā → a + macron, ﬁ → fi, ① → 1, full-width letters → ASCII.
      const parts = [...ch.normalize('NFKD')].filter((x) => !HIDDEN.test(x)).map(standIn);
      rep = parts.length && parts.every((x) => x != null) ? parts.join('') : '?';
    }
    out += rep;
  }
  return out;
}

// ── Layout: A4 portrait, in points, after the .tax-invoice print styles ────────

const PAGE = [595.28, 841.89];
const MARGIN = 48;
const LEFT = MARGIN;
const RIGHT = PAGE[0] - MARGIN;
const WIDTH = RIGHT - LEFT;
const TOP = PAGE[1] - MARGIN;
const BOTTOM = MARGIN;
const GAP = 34; // between side-by-side blocks (12 mm)
const PAD = [6.2, 4.5]; // table cell padding, x and y
const INK = rgb(0, 0, 0);
const GREY = rgb(0.4, 0.4, 0.4);
const RULE = rgb(0.75, 0.75, 0.75);

// Type styles: size and line height (lead) in pt.
const T = {
  title: { bold: true, size: 22, lead: 26 },
  name: { bold: true, size: 11, lead: 15 },
  body: { size: 10, lead: 14 },
  label: { bold: true, size: 10, lead: 14 },
  heading: { bold: true, size: 8, lead: 12, color: GREY },
  head: { bold: true, size: 9, lead: 12 },
  cell: { size: 9.5, lead: 13 },
  note: { bold: true, size: 9.5, lead: 13 },
  total: { bold: true, size: 11.5, lead: 15 },
  foot: { size: 8, lead: 10, color: GREY },
};
const SPACE = (lead) => ({ t: '', s: { lead } });

// The lines table: each column's header (one entry per line, bottom-aligned) and the number columns' width limits.
const COLUMNS = [
  { head: ['Description'] },
  { head: ['Qty'], min: 36, max: 72 },
  { head: ['Unit price', '(ex GST)'], min: 72, max: 110 },
  { head: ['GST'], min: 60, max: 100 },
  { head: ['Amount', '(inc GST)'], min: 76, max: 110 },
];

// Helvetica's ascent and descent per pt: a line's text is centred in its line box, as with CSS line-height.
const baseline = (top, s) => top - (s.lead - 0.925 * s.size) / 2 - 0.718 * s.size;

/** The invoice as PDF bytes (A4, Helvetica). Lines that overflow a page continue on the next under a repeated header;
 *  the totals, GST note and payment details stay together. */
export async function invoicePdf({ client, invoice, org } = {}) {
  const m = taxInvoiceModel({ client, invoice, org: org || {} });
  const number = m.meta.find(([k]) => k === 'Invoice number')?.[1] || '';
  const doc = await PDFDocument.create();
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const fontOf = (s) => (s.bold ? fonts.bold : fonts.regular);
  const widthOf = (t, s) => fontOf(s).widthOfTextAtSize(winAnsi(t), s.size);

  // Text as the lines that fit `width`, like white-space: pre-line (line breaks kept, runs of spaces collapsed); a
  // word longer than a line is broken (overflow-wrap: anywhere).
  const wrap = (t, s, width) => {
    const font = fontOf(s);
    const fits = (x) => font.widthOfTextAtSize(x, s.size) <= width;
    const paras = String(t ?? '').split(/\r\n|[\n\r\u2028\u2029]/).map((p) => winAnsi(p).replace(/ +/g, ' ').replace(/^ | $/g, ''));
    while (paras.length && !paras[0]) paras.shift();
    while (paras.length && !paras.at(-1)) paras.pop();
    const out = [];
    paras.forEach((p) => {
      let line = '';
      p.split(' ').forEach((word) => {
        const joined = line ? `${line} ${word}` : word;
        if (fits(joined)) { line = joined; return; }
        if (line) out.push(line);
        line = '';
        for (const ch of word) {
          if (line && !fits(line + ch)) {
            out.push(line);
            line = '';
          }
          line += ch;
        }
      });
      out.push(line);
    });
    return out;
  };
  const block = (t, s, width = Infinity) => wrap(t, s, width).map((x) => ({ t: x, s }));
  const heightOf = (lines) => lines.reduce((h, l) => h + l.s.lead, 0);

  // Drawing. Without a page these only measure (the tail is measured before it is placed).
  const text = (page, t, x, top, s, align) => {
    const str = winAnsi(t);
    if (!page || !str) return;
    const font = fontOf(s);
    page.drawText(str, {
      x: align === 'right' ? x - font.widthOfTextAtSize(str, s.size) : x, y: baseline(top, s), font, size: s.size, color: s.color || INK,
    });
  };
  const drawBlock = (page, lines, x, top, align) => lines.reduce((at, l) => { text(page, l.t, x, at, l.s, align); return at - l.s.lead; }, top);
  const rule = (page, x1, x2, y, thickness = 0.6, color = RULE) => page?.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  // Label / value lists (the invoice details, payment details).
  const keyWidth = (list) => Math.max(0, ...list.map(([k]) => widthOf(k, T.label)));
  const pairs = (list, valueW) => list.map(([k, v]) => {
    const key = block(k, T.label);
    const value = block(v, T.body, valueW);
    return { key, value, h: Math.max(heightOf(key), heightOf(value), T.body.lead) + 1.7 };
  });
  const drawPairs = (page, rows, top, keyX, valueX, align) => rows.reduce((at, r) => {
    drawBlock(page, r.key, keyX, at);
    drawBlock(page, r.value, valueX, at, align);
    return at - r.h;
  }, top);

  const pages = [];
  const newPage = () => { const p = doc.addPage(PAGE); pages.push(p); return p; };
  const first = newPage();

  // Header: the title left, the supplier right.
  const title = block(m.title, T.title, WIDTH / 2);
  const supplierW = Math.min(WIDTH * 0.6, WIDTH - Math.max(0, ...title.map((l) => widthOf(l.t, l.s))) - GAP);
  const supplier = [
    ...block(m.supplier.name, T.name, supplierW), ...block(m.supplier.abn, T.body, supplierW),
    ...block(m.supplier.address, T.body, supplierW), ...block(m.supplier.contact, T.body, supplierW),
  ];
  drawBlock(first, title, LEFT, TOP);
  drawBlock(first, supplier, RIGHT, TOP, 'right');
  let y = TOP - Math.max(heightOf(title), heightOf(supplier)) - 28;

  // Bill to (left) and the invoice details (right, values right-aligned).
  const metaKeyW = keyWidth(m.meta);
  const metaValueW = Math.min(170, Math.max(0, ...m.meta.map(([, v]) => widthOf(v, T.body))));
  const meta = pairs(m.meta, metaValueW);
  const billW = WIDTH - metaKeyW - 17 - metaValueW - GAP;
  const billTo = [
    ...block('BILL TO', T.heading), SPACE(4), ...block(m.billTo.name, T.name, billW), ...block(m.billTo.abn, T.body, billW),
    ...block(m.billTo.address, T.body, billW), ...block(m.billTo.attn, T.body, billW),
  ];
  y = Math.min(drawBlock(first, billTo, LEFT, y), drawPairs(first, meta, y, RIGHT - metaValueW - 17 - metaKeyW, RIGHT, 'right')) - 25;

  // The lines table. Number columns are as wide as their widest entry (within limits); the description takes the rest.
  const cells = m.lines.map((l) => [l.desc, l.qty, l.unit, l.gst, l.inc]);
  const widths = COLUMNS.map((c, i) => (i ? Math.min(c.max, Math.max(c.min,
    ...c.head.map((h) => widthOf(h, T.head) + 2 * PAD[0]), ...cells.map((r) => widthOf(r[i], T.cell) + 2 * PAD[0]))) : 0));
  widths[0] = WIDTH - widths.reduce((a, b) => a + b, 0);
  const xs = widths.reduce((edges, w) => [...edges, edges.at(-1) + w], [LEFT]); // column edges, left to right
  const headH = Math.max(...COLUMNS.map((c) => c.head.length)) * T.head.lead + 2 * PAD[1];
  const rowH = (n) => n * T.cell.lead + 2 * PAD[1];
  const rows = cells.map((r) => r.map((t, i) => {
    const lines = wrap(t, T.cell, Math.max(1, widths[i] - 2 * PAD[0]));
    return lines.length ? lines : [''];
  }));

  // What goes on each page: a row that doesn't fit moves to the next page under a repeated header, and one taller
  // than a whole page is split across pages.
  const layout = [{ table: { top: y, rows: [] } }];
  let at = y - headH;
  const nextPage = () => {
    const p = { table: { top: TOP, rows: [] } };
    layout.push(p);
    at = TOP - headH;
    return p;
  };
  if (at - rowH(1) < BOTTOM) {
    layout[0].table = null;
    nextPage();
  }
  const room = TOP - headH - BOTTOM;
  rows.forEach((row) => {
    let rest = row;
    for (;;) {
      const h = rowH(Math.max(...rest.map((c) => c.length)));
      const { rows: list } = layout.at(-1).table;
      if (at - h >= BOTTOM) {
        list.push({ cols: rest, h, cont: rest !== row });
        at -= h;
        return;
      }
      const fit = Math.floor((at - BOTTOM - 2 * PAD[1]) / T.cell.lead);
      if (h > room && fit >= 2) {
        list.push({ cols: rest.map((c) => c.slice(0, fit)), h: rowH(fit), cont: rest !== row });
        rest = rest.map((c) => c.slice(fit));
      }
      nextPage();
    }
  });

  // Totals, the GST note and the payment details, as one block.
  const totalsKeyW = Math.max(...m.totals.map(([k], i) => widthOf(k, i === m.totals.length - 1 ? T.total : T.body)));
  const totalsValueW = Math.max(...m.totals.map(([, v], i) => widthOf(v, i === m.totals.length - 1 ? T.total : T.body)));
  const totalsX = RIGHT - Math.min(WIDTH, Math.max(204, totalsKeyW + totalsValueW + 2 * PAD[0] + 24));
  const payKeyW = keyWidth(m.payment);
  const payment = pairs(m.payment, WIDTH - payKeyW - 17);
  const drawTail = (page, top) => {
    let ty = top - 11;
    m.totals.forEach(([k, v], i) => {
      const total = i === m.totals.length - 1;
      const s = total ? T.total : T.body;
      if (total) {
        rule(page, totalsX, RIGHT, ty, 1.2, INK);
        ty -= 1.7;
      }
      text(page, k, totalsX + PAD[0], ty - 2.8, s);
      text(page, v, RIGHT - PAD[0], ty - 2.8, s, 'right');
      ty -= s.lead + 5.6;
    });
    text(page, m.gstNote, RIGHT - PAD[0], ty - 2, T.note, 'right');
    ty -= T.note.lead + 2 + 28;
    rule(page, LEFT, RIGHT, ty);
    ty = drawBlock(page, [...block('PAYMENT', T.heading), SPACE(4)], LEFT, ty - 11);
    return drawPairs(page, payment, ty, LEFT, LEFT + payKeyW + 17);
  };
  const tailH = -drawTail(null, 0);

  // When the block doesn't fit under the last row it starts a new page, taking the last row with it (so the totals
  // never stand alone) when that fits.
  if (at - tailH < BOTTOM) {
    const { rows: list } = layout.at(-1).table || { rows: [] };
    const carry = list.length > 1 && !list.at(-1).cont ? list.at(-1) : null;
    if (carry && headH + carry.h + tailH <= TOP - BOTTOM) {
      list.pop();
      nextPage().table.rows.push(carry);
      at -= carry.h;
    } else {
      layout.push({ table: null });
      at = TOP;
    }
  }
  layout.at(-1).tail = at;

  const drawTable = (page, { top, rows: list }) => {
    COLUMNS.forEach((c, i) => c.head.forEach((h, j) => {
      text(page, h, i ? xs[i + 1] - PAD[0] : xs[i] + PAD[0], top - headH + PAD[1] + (c.head.length - j) * T.head.lead, T.head, i ? 'right' : 'left');
    }));
    const edges = [top, top - headH];
    list.forEach((r) => {
      const rt = edges.at(-1);
      r.cols.forEach((lines, i) => lines.forEach((t, j) => {
        text(page, t, i ? xs[i + 1] - PAD[0] : xs[i] + PAD[0], rt - PAD[1] - j * T.cell.lead, T.cell, i ? 'right' : 'left');
      }));
      edges.push(rt - r.h);
    });
    edges.forEach((ey, k) => rule(page, LEFT, RIGHT, ey, k === 1 ? 0.9 : 0.6, k === 1 ? GREY : RULE));
    xs.forEach((x) => page.drawLine({ start: { x, y: top }, end: { x, y: edges.at(-1) }, thickness: 0.6, color: RULE }));
  };
  layout.forEach((p, i) => {
    const page = i ? newPage() : first;
    if (p.table) drawTable(page, p.table);
    if (p.tail != null) drawTail(page, p.tail);
  });

  if (pages.length > 1) {
    pages.forEach((page, i) => {
      text(page, [m.title, number].filter(Boolean).join(' '), LEFT, BOTTOM - 16, T.foot);
      text(page, `Page ${i + 1} of ${pages.length}`, RIGHT, BOTTOM - 16, T.foot, 'right');
    });
  }

  doc.setTitle([m.title, number].filter(Boolean).join(' '));
  doc.setAuthor(m.supplier.name);
  doc.setCreator('Cortex');
  doc.setProducer('Cortex');
  doc.setLanguage('en-AU');
  return doc.save();
}
