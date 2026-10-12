// CSV reader for imports (RFC 4180): quoted fields, "" escapes, commas and line breaks inside quotes,
// CRLF / LF / CR line ends and a UTF-8 byte order mark. Pure; no DOM or Vite imports.

// Excel in some locales saves with ; and some exports use tabs: pick whichever leads the header line.
function sniff(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  return Object.keys(counts).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

/** Text → rows of cell strings. A trailing line break doesn't add an empty row. */
export function parseCsv(text, { delimiter } = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = delimiter || sniff(s);
  const rows = [];
  let row = [];
  let cell = '';
  let fieldStart = true; // a quote only opens a quoted field as its first character
  let pending = false; // anything read since the last row break
  const endCell = () => { row.push(cell); cell = ''; fieldStart = true; };
  const endRow = () => { endCell(); rows.push(row); row = []; pending = false; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    pending = true;
    if (c === '"' && fieldStart) {
      // Quoted field: copy up to the closing quote, turning "" into ".
      fieldStart = false;
      for (i++; i < s.length; i++) {
        const q = s.indexOf('"', i);
        if (q === -1) { cell += s.slice(i); i = s.length; break; } // unterminated: keep the rest
        cell += s.slice(i, q);
        if (s[q + 1] === '"') { cell += '"'; i = q + 1; } else { i = q; break; }
      }
    } else if (c === d) {
      endCell();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += c; // also text after a closing quote ("a"b), kept rather than dropped
      fieldStart = false;
    }
  }
  if (pending) endRow();
  return rows;
}

/** Header row + data rows, with blank lines dropped and header names trimmed. */
export function readCsv(text, options) {
  const rows = parseCsv(text, options).filter((r) => r.some((c) => c.trim() !== ''));
  const [head = [], ...data] = rows;
  return { headers: head.map((h) => h.trim()), rows: data };
}
