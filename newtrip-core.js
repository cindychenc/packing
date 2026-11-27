/* Suitcase · new-trip helpers with no page or network code, so they can be tested in Node.
 * - Step 2's form: its options and what is sent to draft-trip.
 * - Step 3's table: travel counts and the list of phases and stops.
 * - Dates: ISO date maths for the range calendar.
 * - Routes: fitting each route's nights to the trip length.
 * - Import: reading CSV/TSV text and .xlsx files into rows, and rows into phases and stops.
 */
(function (root) {
  'use strict';

  /* ───────── step 2: the form ───────── */

  // Every answer is optional; draft-trip fills gaps with a balanced default.
  const FORM = {
    loves: ['outdoor adventure', 'city culture', 'food scene', 'local communities', 'remote landscapes', 'unusual historical sites', 'markets', 'cooking',
      'history', 'architecture', 'photography', 'off the beaten path', 'museums', 'beach days', 'nightlife'],
    shown: 6,   // interests shown before "Show more"
    who: [['Solo', 'by myself'], ['Couple', 'with my partner'], ['Friends', 'with friends'], ['Family', 'with my family']],
    // the values keep the nights per stop: paceCap here and nightsFor in draft-trip read them
    pace: [['Slow and immersive', '3+ nights per stop', 'slowly, 3+ nights per stop'], ['Balanced', '2–3 nights per stop', 'steadily, 2–3 nights per stop'],
      ['Fast-paced', '1–2 nights per stop', 'quickly, 1–2 nights per stop']],
    fitness: ['Casual walks', 'Day hikes', 'Multi-day treks', 'Big adventures'],
    transport: [['Buses & trains', 'public'], ['Rental car', 'car'], ['Mix, fly the long hops', 'mix']],   // none picked: whatever fits
    shape: [['any', 'Don’t mind'], ['loop', 'Back where I started'], ['open', 'End somewhere else']],
    seasons: [['spring', 'Spring'], ['summer', 'Summer'], ['fall', 'Fall'], ['winter', 'Winter'], ['unsure', 'Not sure yet']]
  };

  const filled = v => Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  const listText = (a, word) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' ' + (word || 'and') + ' ' + a[a.length - 1];
  const toggle = (list, v) => (list || []).indexOf(v) >= 0 ? list.filter(x => x !== v) : (list || []).concat([v]);

  /* Seasons are multi-select; "Not sure yet" stands alone (picking it clears the rest, picking a season clears it). */
  function pickSeason(list, v) {
    list = list || [];
    if (list.indexOf(v) >= 0) return list.filter(x => x !== v);
    return v === 'unsure' ? ['unsure'] : list.filter(x => x !== 'unsure').concat([v]);
  }
  // ['spring', 'summer'] → "in spring or summer"; none or "Not sure yet" → null
  function whenText(seasons) {
    const names = { spring: 'spring', summer: 'summer', fall: 'autumn', winter: 'winter' };
    const s = (seasons || []).filter(x => names[x]).map(x => names[x]);
    return s.length ? 'in ' + listText(s, 'or') : null;
  }

  // "3 weeks" → "3-week"; 10 days → "10-day"; a month → "1-month".
  function lengthText(days, unitLabel) {
    if (unitLabel === 'Weekend') return 'weekend';
    const m = /^(\d+) (week|month|day)s?$/.exec(unitLabel || '');
    if (m) return m[1] + '-' + m[2];
    return days + '-day';
  }

  /* What draft-trip gets. Free text is kept but trimmed; blanks go as null or []. */
  function request(ans, ctx) {
    const one = (v, n) => filled(v) ? String(v).trim().slice(0, n || 80) : null;
    const many = v => (Array.isArray(v) ? v : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 15);
    const shape = ans.shape === 'loop' || ans.shape === 'open' ? ans.shape : null;
    return {
      destination: ctx.dest, days: ctx.days, start: ctx.start || null,
      who: one(ans.who), loves: many(ans.loves), pace: one(ans.pace), fitness: one(ans.fitness),
      when: ctx.exactDates ? null : whenText(ctx.seasons),
      from: one(ans.from), to: shape === 'loop' ? one(ans.from) : one(ans.to), shape,
      must: filled(ans.must) ? [one(ans.must, 300)] : [], avoid: one(ans.avoid, 300),
      transport: ['public', 'car', 'mix'].indexOf(ans.transport) >= 0 ? ans.transport : null, noFly: ans.noFly === true
    };
  }

  /* ───────── step 3: one route as table cells ───────── */

  const MODE_WORD = { fly: ['flight', 'flights'], bus: ['bus', 'buses'], drive: ['driving day', 'driving days'], train: ['train', 'trains'], boat: ['boat', 'boats'] };
  /* "21 nights" and "2 flights · 2 buses" from a route's stops (each stop's next = how you leave it). */
  function travelText(stops) {
    const n = {}; (stops || []).slice(0, -1).forEach(s => { if (s.next === 'hike') return; const m = MODE_WORD[s.next] ? s.next : 'bus'; n[m] = (n[m] || 0) + 1; });   // walking onto a trek isn't transport
    return Object.keys(MODE_WORD).filter(m => n[m]).map(m => n[m] + ' ' + MODE_WORD[m][n[m] === 1 ? 0 : 1]).join(' · ');
  }
  /* The list view: phases, each with its days and its stops (nights + the thing to do there). */
  function phaseList(phases, highlights) {
    const norm = t => String(t || '').trim().toLowerCase();
    const hl = (highlights || []).filter(h => h && !h.skip && h.place);
    return (phases || []).map(p => {
      const stops = (p.stops || []).map(s => { const h = hl.find(x => norm(x.place) === norm(s.place));
        return { place: s.place, nights: s.nights, what: tidy(h ? h.text : s.why || '') }; });
      return { name: p.name || '', days: stops.reduce((a, s) => a + (s.nights || 0), 0), stops };
    });
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

  /* The most nights per stop for a pace answer: "1–2 nights" → 2, "2–3 nights" → 3, "3+ nights" → 5; anything typed → 4. */
  function paceCap(pace) {
    const m = /(\d+)\s*[–-]\s*(\d+)\s*nights?/.exec(pace || ''), plus = /(\d+)\+\s*nights?/.exec(pace || '');
    return m ? +m[2] : plus ? +plus[1] + 2 : 4;
  }

  /* Make a route's nights fit the trip length.
     Too many: nights come off the end. Too few: the shortest stops get a night each, never past the pace's most nights per stop;
     whatever is still missing stays as days to plan (returned as left), instead of one very long stay. */
  function fitNights(phases, total, cap) {
    cap = cap || 99;
    const stops = []; (phases || []).forEach(p => (p.stops || []).forEach(s => { s.nights = Math.max(1, Math.round(+s.nights || 1)); stops.push(s); }));
    let sum = stops.reduce((a, s) => a + s.nights, 0);
    for (let i = stops.length - 1; i >= 0 && sum > total; i--) {
      const cut = Math.min(stops[i].nights - 1, sum - total); stops[i].nights -= cut; sum -= cut;
    }
    while (sum < total) {
      const room = stops.filter(s => s.nights < cap); if (!room.length) break;
      const low = Math.min(...room.map(s => s.nights));
      for (const s of room) { if (sum >= total) break; if (s.nights === low) { s.nights++; sum++; } }
    }
    return { sum, left: Math.max(0, total - sum) };
  }

  /* What to write in each day of a new plan, in order: { plan, notes } per night.
     - The first day at a stop says how you got there ("Bus from Osh"); the trip's first day says "Arrive in …".
     - The route's highlights (and the ones all routes share) go on the stop they belong to: the second day when there is one,
       since the first is a travel day.
     - Lines Claude wrote for each night (stop.plans) or rows from an imported sheet fill the rest.
     - The last day says it's the last night. */
  const MODE_FROM = { fly: 'Fly from ', bus: 'Bus from ', drive: 'Drive from ', train: 'Train from ', boat: 'Boat from ', hike: 'Hike from ' };
  function dayPlans(phases, highlights, opts) {
    const travel = !(opts && opts.travel === false);
    const stops = []; (phases || []).forEach(p => (p.stops || []).forEach(s => stops.push(s)));
    const out = [];
    const norm = t => String(t || '').toLowerCase();
    const words = t => norm(t).split(/[^a-zà-ÿ]+/).filter(w => w.length >= 5);
    stops.forEach((s, i) => {
      const n = Math.max(1, s.nights || 1), prev = stops[i - 1];
      const days = Array.from({ length: n }, (_, k) => {
        const own = Array.isArray(s.plans) ? s.plans[k] : null;
        return own ? [tidy(own)] : [];
      });
      if (!travel) { /* imported plans keep only their own words */ }
      else if (i === 0) days[0].unshift('Arrive in ' + s.place);
      else if (prev) days[0].unshift((MODE_FROM[prev.next] || 'Travel from ') + prev.place);
      (highlights || []).filter(hl => hl && !hl.skip && hl.place && norm(hl.place) === norm(s.place)).forEach(hl => {
        const text = tidy(hl.text), w = words(text);
        const already = days.some(d => d.some(line => w.some(x => norm(line).indexOf(x) >= 0)));
        if (!already) days[n > 1 ? 1 : 0].push(text);
      });
      days.forEach((d, k) => out.push({ plan: d.filter(Boolean).join(' · ') || null, notes: k === 0 && s.why ? tidy(s.why) : null }));
    });
    if (travel && out.length) { const last = out[out.length - 1]; last.plan = (last.plan ? last.plan + ' · ' : '') + 'Last night'; }
    return out;
  }

  /* A new trip from a generated route fills in only the days that are fixed: getting there, the highlights
     (with the start and end of a multi-day one, e.g. "W Trek, 5 days"), and the last night. Every other line
     Claude wrote for a stop is kept as an idea for that stop, for later. Each filled day is marked auto. */
  // "(~6 h, one bus a day, check locally)" after a travel line: Claude's rough hours and note, and anything the road check flagged
  const legBits = s => { const b = [];
    if (s.hours > 0) b.push('~' + (s.hours < 1 ? Math.round(s.hours * 60) + ' min' : (Math.round(s.hours * 2) / 2) + ' h'));
    const note = tidy(s.leg_note || '').replace(/\.$/, '');
    if (note && note.split(/\s+/).length <= 8 && !/\b(by|from|to)\b.*\b(train|bus|railway|ferry|flight|car)\b|\b\d+(\.\d+)?\s*(h|hrs?|hours?)\b/i.test(note)) b.push(note);   // drop a note that retells the route
    if (s.leg_flag && !/check locally/i.test(s.leg_note || '')) b.push('check locally');
    return b.length ? ' (' + b.join(', ') + ')' : ''; };
  const MULTI = /(?:,\s*|\s+|\()(\d{1,2})[- ]days?\b\)?|\b(\d{1,2})-day\b/i;
  function crucialPlans(phases, highlights) {
    const stops = [], phaseOf = [], nth = [];   // each stop's phase, and which visit to its place it is (Milan at the start vs the end)
    const seenAt = {};
    (phases || []).forEach((p, pi) => (p.stops || []).forEach(s => { stops.push(s); phaseOf.push(pi); const k = String(s.place || '').toLowerCase(); nth.push(seenAt[k] = (seenAt[k] || 0) + 1); }));
    // Bookings and logistics happen on a set day (picking up the car, a timed ticket, a flight): they're prefilled, never ideas.
    const FIXED = /\b(rental car|car rental|hire car|collect (the |your )?car|pick[- ]?up|drop[- ]?off|return (the |your )?car|check[- ]?in|check[- ]?out|flights?|airport|booked|booking|book ahead|tickets?|reservations?|timed entry)\b/i;
    const norm = t => String(t || '').toLowerCase();
    // Lines that are steps of one multi-day thing ("GR20 day 1", "GR20 day 3", "Stage 2: Ortu to Petra Piana", "Inca Trail 2 of 4")
    // are fixed too: they go on their own day, in order, instead of becoming ideas. A step needs a number and either
    // an "x of y" or a name it shares with another line of the route.
    const STEP = /\b(?:day|stage|leg|[ée]tape|section|part)\s*\d{1,2}\b|\b\d{1,2}\s*(?:of|\/)\s*\d{1,2}\b/i;
    const stepKey = t => norm(t).replace(/\b(?:day|stage|leg|[ée]tape|section|part)\s*\d{1,2}\b/g, ' ').replace(/\b\d{1,2}\s*(?:of|\/)\s*\d{1,2}\b/g, ' ')
      .replace(/[:–—-].*$/, '').replace(/[^a-z0-9à-ÿ]+/g, ' ').trim() || (norm(t).match(/\b(day|stage|leg|[ée]tape|section|part)\b/) || [''])[0];   // "Stage 2: Ortu to Petra Piana" groups as "stage"
    const keyN = {}; stops.forEach(s => (Array.isArray(s.plans) ? s.plans : []).forEach(t => { if (STEP.test(t || '')) { const k = stepKey(t); if (k) keyN[k] = (keyN[k] || 0) + 1; } }));
    const isStep = t => STEP.test(t) && (/\b\d{1,2}\s*(?:of|\/)\s*\d{1,2}\b/i.test(t) || keyN[stepKey(t)] >= 2);
    const words = t => norm(t).split(/[^a-zà-ÿ]+/).filter(w => w.length >= 5);
    const days = [], ideas = [];
    stops.forEach((s, i) => {
      const n = Math.max(1, s.nights || 1), prev = stops[i - 1];
      const lines = Array.from({ length: n }, () => []);
      lines[0].push(i === 0 ? 'Arrive in ' + s.place : (MODE_FROM[prev.next] || 'Travel from ') + prev.place + legBits(prev));
      const travel = lines[0].slice();
      const plansIn = (Array.isArray(s.plans) ? s.plans : []).map(tidy), stepsHere = plansIn.filter(t => t && isStep(t)).length >= 2;   // a trek stop with its days written out   // what a line mustn't repeat (the steps added below don't count)
      let next = n > 1 ? 1 : 0;                       // highlights start the day after arriving, when there is one
      const used = [];
      (highlights || []).filter(hl => hl && !hl.skip && hl.place && norm(hl.place) === norm(s.place)).forEach(hl => {
        const text = tidy(hl.text), m = MULTI.exec(text), len = m ? Math.min(+(m[1] || m[2]), n - next) : 1;
        if (m && len > 1 && stepsHere) return;   // the stop's own numbered days say it better than "Start X (5 days)"
        used.push(text);
        if (next >= n) { lines[n - 1].push(text); return; }
        if (m && len > 1) {
          const name = text.replace(MULTI, ' ').replace(/\s+/g, ' ').replace(/\s+([,.)])/g, '$1').replace(/[,\s(]+$/, '').trim();
          lines[next].push('Start ' + name + ' (' + len + ' days)');
          for (let k = 1; k < len - 1; k++) lines[next + k].push(name + ', day ' + (k + 1) + ' of ' + len);
          lines[next + len - 1].push('Finish ' + name);
          next += len;
        } else { lines[next].push(text); next = Math.min(next + 1, n); }
      });
      // Claude's other lines for this stop become ideas, unless they repeat a highlight or the travel line
      const whereAt = k => (Array.isArray(s.plan_where) && typeof s.plan_where[k] === 'string' && s.plan_where[k].trim()) || null;
      plansIn.forEach((t, k) => {
        if (!t) return;
        if (stepsHere && isStep(t)) { lines[Math.min(k, n - 1)].push(t); return; }
        if (FIXED.test(t) && !/^(arrive|fly|bus|drive|train|ferry|travel|last night)\b/i.test(t)) { lines[Math.min(k, n - 1)].push(t); return; }   // on its own night
        const w = norm(t).split(/[^a-zà-ÿ]+/).filter(x => x.length >= 4 && norm(s.place).indexOf(x) < 0 && (!prev || norm(prev.place).indexOf(x) < 0)), dup = used.concat(travel).some(u => w.some(x => norm(u).indexOf(x) >= 0));
        if (dup || /^(arrive|fly|bus|drive|train|ferry|travel|spare day|last night)\b/i.test(t)) return;
        if (isStep(t)) lines[Math.min(k, n - 1)].push(t);   // the plans are one per night, in order: a step stays on its night
        else ideas.push({ place: s.place, phase: phaseOf[i], visit: nth[i], text: t.replace(/^spare day:\s*/i, ''), where: whereAt(k) });
      });
      // the stop's extras are ideas too (so a stop whose plans all became fixed days still has some)
      (Array.isArray(s.extras) ? s.extras : []).forEach(e => { const t = tidy(typeof e === 'string' ? e : e && e.text), w = e && typeof e === 'object' && typeof e.where === 'string' && e.where.trim() || null;
        if (t && !FIXED.test(t) && !ideas.some(x => x.place === s.place && x.phase === phaseOf[i] && x.text.toLowerCase() === t.toLowerCase())) ideas.push({ place: s.place, phase: phaseOf[i], visit: nth[i], text: t, where: w }); });
      lines.forEach((d, k) => days.push({ plan: d.join(' · ') || null, notes: k === 0 && s.why ? tidy(s.why) : null, auto: d.length > 0 }));
    });
    if (days.length) { const last = days[days.length - 1]; last.plan = (last.plan ? last.plan + ' · ' : '') + 'Last night'; last.auto = true; }
    const seen = {};
    return { days, ideas: ideas.filter(x => { const k = norm(x.place + '|' + x.text); return !seen[k] && (seen[k] = 1); }) };
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
    let col = { place: -1, nights: -1, phase: -1, date: -1, plan: -1 }, body = rows;
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
      const plan = col.plan >= 0 ? cellText(r[col.plan]).slice(0, 300) : '';
      const last = ph.stops[ph.stops.length - 1];
      if (byDay && last && last.place.toLowerCase() === place.toLowerCase()) { last.nights += 1; last.plans.push(plan); }
      else ph.stops.push({ place, nights: n, plans: [plan] });
    });
    const days = out.reduce((a, p) => a + p.stops.reduce((b, s) => b + s.nights, 0), 0);
    if (!days) return { error: 'Couldn’t find any places in those rows.' };
    if (days > 731) return { error: 'That plan is longer than two years. Trim it and try again.' };
    return { phases: out, start, days, byDay, skipped };
  }

  const api = { FORM, toggle, pickSeason, whenText, lengthText, request, listText, travelText, phaseList, crucialPlans,
    addDays, daysIncl, isIso, monthGrid, fitNights, paceCap, dayPlans, tidy, parseDelimited, readXlsx, planFromRows, cellDate };
  root.SuitcaseNewTrip = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
