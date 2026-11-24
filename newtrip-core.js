/* Suitcase · new-trip helpers with no page or network code, so they can be tested in Node.
 * - The "finish the sentence" step: its blanks, the sentence built from them, and what is sent to draft-trip.
 * - Dates: ISO date maths for the range calendar.
 * - Routes: fitting each route's nights to the trip length.
 * - Import: reading CSV/TSV text and .xlsx files into rows, and rows into phases and stops.
 */
(function (root) {
  'use strict';

  /* ───────── finish the sentence ───────── */

  // Each blank: the question shown above its options, the options, whether several can be picked, and the empty label.
  const BLANKS = {
    who: { q: 'Who’s going?', opts: ['by myself', 'with my partner', 'with friends', 'with my family'], ph: 'with…' },
    loves: { q: 'What do you love?', multi: true, ph: 'what you love',
      opts: ['city & culture', 'nature & adventure', 'food & wine', 'beaches & relaxing', 'arts & history', 'off-the-beaten-path places', 'hot springs & rest', 'nightlife'] },
    pace: { q: 'How do you like to travel?', opts: ['slowly, 3+ nights per stop', 'steadily, 2–3 nights per stop', 'quickly, 1–2 nights per stop'], ph: 'at what pace' },
    when: { q: 'When?', opts: ['in spring', 'in summer', 'in autumn', 'in winter', 'over the holidays'], ph: 'when' },
    from: { q: 'Starting in', opts: [], ph: 'where' },
    to: { q: 'Ending in', opts: [], ph: 'where' },
    must: { q: 'Must do', multi: true, ph: 'what',
      opts: ['do a multi-day hike', 'see wildlife', 'take a cooking class', 'one special stay', 'catch a local festival', 'go somewhere remote', 'see a famous landmark'] },
    skip: { q: 'Rather avoid', opts: ['big cities', 'organised tours', 'long bus days', 'early mornings'], ph: 'what' }
  };
  const REQUIRED = ['who', 'loves', 'pace'];
  // Optional parts, in the order they're offered under "Add more detail".
  const EXTRAS = [['when', 'when'], ['from', 'start point'], ['to', 'end point'], ['must', 'must do'], ['skip', 'rather avoid']];

  const filled = v => Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  const listText = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

  /* The options for one blank. Start and end points offer the places typed in step 1; "when" isn't offered with exact dates. */
  function optionsFor(id, ctx) {
    if (id === 'from' || id === 'to') return (ctx.places || []).slice(0, 6);
    return BLANKS[id].opts.slice();
  }
  function extrasFor(ctx, added) {
    return EXTRAS.filter(e => added.indexOf(e[0]) < 0 && !(e[0] === 'when' && ctx.exactDates));
  }

  /* The sentence as text pieces and blanks:
     "A 3-week trip through Patagonia [with my partner], and we love [food & wine]. We travel [slowly…]. Starting in [..]." */
  function tokens(ans, ctx) {
    const solo = ans.who === 'by myself';
    const B = (id, extra) => {
      const v = ans[id];
      return { blank: id, extra: !!extra, filled: filled(v), label: filled(v) ? (Array.isArray(v) ? listText(v) : v) : BLANKS[id].ph };
    };
    const out = ['A ' + ctx.lengthText + ' trip through ' + ctx.dest + ' ', B('who'), solo ? ', and I love ' : ', and we love ', B('loves'), solo ? '. I travel ' : '. We travel ', B('pace'), '.'];
    const clause = { when: [' Going ', B('when', 1), '.'], from: [' Starting in ', B('from', 1), '.'], to: [' Ending in ', B('to', 1), '.'],
      must: [solo ? ' I must ' : ' We must ', B('must', 1), '.'], skip: [solo ? ' I’d rather avoid ' : ' We’d rather avoid ', B('skip', 1), '.'] };
    (ans.added || []).forEach(k => { if (clause[k]) out.push(...clause[k]); });
    return out.map(t => typeof t === 'string' ? { text: t } : t);
  }
  const missing = ans => REQUIRED.filter(k => !filled(ans[k]));

  // "3 weeks" → "3-week"; 10 days → "10-day"; a month → "1-month".
  function lengthText(days, unitLabel) {
    if (unitLabel === 'Weekend') return 'weekend';
    const m = /^(\d+) (week|month|day)s?$/.exec(unitLabel || '');
    if (m) return m[1] + '-' + m[2];
    return days + '-day';
  }

  /* What draft-trip gets. Free text the traveller typed is kept but trimmed. */
  function request(ans, ctx) {
    const one = v => filled(v) ? String(v).trim().slice(0, 80) : null;
    const many = v => (Array.isArray(v) ? v : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 10);
    const added = ans.added || [];
    return {
      destination: ctx.dest, days: ctx.days, start: ctx.start || null,
      who: one(ans.who), loves: many(ans.loves), pace: one(ans.pace),
      when: added.indexOf('when') >= 0 ? one(ans.when) : null,
      from: added.indexOf('from') >= 0 ? one(ans.from) : null,
      to: added.indexOf('to') >= 0 ? one(ans.to) : null,
      must: added.indexOf('must') >= 0 ? many(ans.must) : [],
      avoid: added.indexOf('skip') >= 0 ? one(ans.skip) : null
    };
  }

  /* ───────── dates (ISO yyyy-mm-dd, no time zones) ───────── */
  const toUTC = iso => { const p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
  const fromUTC = t => new Date(t).toISOString().slice(0, 10);
  const addDays = (iso, n) => fromUTC(toUTC(iso) + n * 864e5);
  const daysIncl = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5) + 1;
  const isIso = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(toUTC(v));
  /* One month of the calendar: leading blanks for a Monday start, then each day. */
  function monthGrid(year, month) {
    const first = new Date(Date.UTC(year, month, 1)), n = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7, cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= n; d++) cells.push(fromUTC(Date.UTC(year, month, d)));
    return cells;
  }

  /* ───────── routes ───────── */

  /* Make a route's nights add up to the trip length: extra nights come off the end, missing ones go to the longest stop. */
  function fitNights(phases, total) {
    const stops = []; (phases || []).forEach(p => (p.stops || []).forEach(s => { s.nights = Math.max(1, Math.round(+s.nights || 1)); stops.push(s); }));
    let sum = stops.reduce((a, s) => a + s.nights, 0);
    for (let i = stops.length - 1; i >= 0 && sum > total; i--) {
      const cut = Math.min(stops[i].nights - 1, sum - total); stops[i].nights -= cut; sum -= cut;
    }
    if (sum < total && stops.length) { const big = stops.reduce((a, s) => (s.nights > a.nights ? s : a), stops[0]); big.nights += total - sum; sum = total; }
    return sum;   // can still be over the length when there are more stops than days
  }

  // Words the voice guide rules out; a highlight or pitch using one is still shown, minus exclamation marks.
  const tidy = t => String(t || '').replace(/!+/g, '.').replace(/\s+/g, ' ').trim();

  /* ───────── import: rows from CSV / TSV / .xlsx ───────── */

  function parseDelimited(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
    const count = ch => (firstLine.match(new RegExp('\\' + ch, 'g')) || []).length;
    const delim = ['\t', ',', ';'].sort((a, b) => count(b) - count(a))[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
  }

  /* .xlsx is a zip of XML files. Read the first sheet with the browser's own inflate (DecompressionStream), no library. */
  async function readXlsx(buf, inflate) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That file isn’t a spreadsheet Suitcase can read.');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      files[name] = { method, csize, off };
      p += 46 + nl + xl + cl;
    }
    const read = async name => {
      const f = files[name]; if (!f) return null;
      const ln = dv.getUint16(f.off + 26, true), lx = dv.getUint16(f.off + 28, true);
      const data = u8.subarray(f.off + 30 + ln + lx, f.off + 30 + ln + lx + f.csize);
      const raw = f.method === 0 ? data : await inflate(data);
      return new TextDecoder().decode(raw);
    };
    const shared = [];
    const sx = await read('xl/sharedStrings.xml');
    if (sx) (sx.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => shared.push(xmlText((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))));
    const sheetName = Object.keys(files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))[0];
    const sheet = sheetName && await read(sheetName);
    if (!sheet) throw new Error('That spreadsheet looks empty.');
    const rows = [];
    (sheet.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []).forEach(r => {
      const out = [];
      (r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(c => {
        const ref = (c.match(/ r="([A-Z]+)\d+"/) || [])[1]; const t = (c.match(/ t="(\w+)"/) || [])[1];
        const s = (c.match(/ s="(\d+)"/) || [])[1];
        let v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (t === 'inlineStr') v = xmlText(((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || '');
        else if (t === 's') v = shared[+v] || '';
        else if (v !== undefined) v = xmlText(v);
        const col = ref ? ref.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : out.length;
        out[col] = v === undefined ? '' : String(v);
        if (s !== undefined && t === undefined && /^\d{5}(\.\d+)?$/.test(out[col])) out[col] = { serial: +out[col] };   // maybe a date
      });
      rows.push(Array.from(out, x => (x === undefined ? '' : x)));
    });
    return rows.map(r => r.map(x => (typeof x === 'string' ? x.trim() : x))).filter(r => r.some(x => x !== ''));
  }
  const xmlText = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

  /* A cell as a date, if it is one: ISO, "Apr 5, 2027", "5/4/2027" is too ambiguous and is skipped, Excel serials. */
  function cellDate(v) {
    if (v && typeof v === 'object' && v.serial) return fromUTC(Date.UTC(1899, 11, 30) + Math.floor(v.serial) * 864e5);
    const s = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return isIso(s.slice(0, 10)) ? s.slice(0, 10) : null;
    const m = /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s) || /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
    if (m) { const t = Date.parse(m[0].replace(/^[A-Za-z]{3,9},?\s+(?=\S+\s)/, '') + ' UTC'); if (!isNaN(t)) return fromUTC(t); }
    return null;
  }
  const cellText = v => (v && typeof v === 'object' ? String(v.serial) : String(v || '')).trim();

  const HEAD = {
    place: /^(place|location|locations|city|town|stop|stops|where|base|destination|overnight|sleep|stay(ing)? in|accommodation location)$/i,
    nights: /^(nights?|# ?nights|no\.? of nights|days?|# ?days|length|duration)$/i,
    phase: /^(phase|region|area|leg|section|part|country|state|province)$/i,
    date: /^(date|day date|when|start|from|check.?in)$/i,
    plan: /^(plan|plans|notes?|activities|activity|what|to do|details|description|itinerary)$/i
  };

  /* Rows → { phases: [{ name, stops: [{ place, nights }] }], start, days, note }.
     Works for one row per stop (with a nights column) and one row per day (same place on following rows = one stop). */
  function planFromRows(rows) {
    rows = (rows || []).filter(r => r.some(c => cellText(c)));
    if (!rows.length) return { error: 'Nothing to import yet. Paste rows from a spreadsheet, or upload a .csv or .xlsx file.' };
    const width = Math.max(...rows.map(r => r.length));
    let col = { place: -1, nights: -1, phase: -1, date: -1 }, body = rows;
    // A header row is one where some cell names a column we know.
    const hi = rows.slice(0, 5).findIndex(r => r.some(c => HEAD.place.test(cellText(c))));
    if (hi >= 0) {
      const head = rows[hi].map(cellText);
      Object.keys(col).forEach(k => { col[k] = head.findIndex(h => HEAD[k].test(h)); });
      if (col.nights >= 0 && /^day$/i.test(head[col.nights])) col.nights = -1;   // "Day" is a day number (one row per day), not nights
      body = rows.slice(hi + 1);
    } else {
      // No header: the first column that is mostly words is the place; a column of small whole numbers is nights.
      const words = c => body.filter(r => /[A-Za-zÀ-ÿ]/.test(cellText(r[c])) && !cellDate(r[c])).length;
      const nums = c => body.filter(r => /^\d{1,3}$/.test(cellText(r[c]))).length;
      const dates = c => body.filter(r => cellDate(r[c])).length;
      for (let c = 0; c < width; c++) {
        if (col.date < 0 && dates(c) >= body.length * 0.6) col.date = c;
        else if (col.place < 0 && words(c) >= body.length * 0.6) col.place = c;
        else if (col.nights < 0 && nums(c) >= body.length * 0.6) col.nights = c;
      }
    }
    if (col.place < 0) return { error: 'Couldn’t find a column of places. Add a header such as “Place” or “Location” to that column.' };
    const out = [], byDay = col.nights < 0;
    let start = null, skipped = 0;
    body.forEach(r => {
      const place = cellText(r[col.place]).replace(/\s*\(.*?\)\s*$/, '').slice(0, 80);
      if (!place) { skipped++; return; }
      const phase = col.phase >= 0 ? cellText(r[col.phase]).slice(0, 60) || null : null;
      if (!start && col.date >= 0) start = cellDate(r[col.date]);
      let n = byDay ? 1 : parseInt(cellText(r[col.nights]), 10);
      if (!(n >= 1)) n = 1;
      n = Math.min(n, 365);
      let ph = out[out.length - 1];
      if (!ph || (phase && ph.name !== phase)) { ph = { name: phase, stops: [] }; out.push(ph); }
      const last = ph.stops[ph.stops.length - 1];
      if (byDay && last && last.place.toLowerCase() === place.toLowerCase()) last.nights += 1;
      else ph.stops.push({ place, nights: n });
    });
    const days = out.reduce((a, p) => a + p.stops.reduce((b, s) => b + s.nights, 0), 0);
    if (!days) return { error: 'Couldn’t find any places in those rows.' };
    if (days > 731) return { error: 'That plan is longer than two years. Trim it and try again.' };
    return { phases: out, start, days, byDay, skipped };
  }

  const api = { BLANKS, REQUIRED, EXTRAS, optionsFor, extrasFor, tokens, missing, lengthText, request, listText,
    addDays, daysIncl, isIso, monthGrid, fitNights, tidy, parseDelimited, readXlsx, planFromRows, cellDate };
  root.SuitcaseNewTrip = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
