// node tests/newtrip.test.js
const T = require('../newtrip-core.js');
const zlib = require('zlib');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// sentence
const ctx = { dest: 'Patagonia', lengthText: '3-week', days: 21, places: ['Santiago'] };
let ans = { added: [] };
let tk = T.tokens(ans, ctx);
ok(tk[0].text === 'A 3-week trip through Patagonia ' && tk[1].blank === 'who' && !tk[1].filled && tk[1].label === 'with…', 'sentence starts with the trip, blanks empty');
ok(eq(T.missing(ans), ['who', 'loves', 'pace']), 'three blanks needed');
ans = { who: 'by myself', loves: ['food & wine', 'nightlife'], pace: 'slowly, 3+ nights per stop', added: ['from', 'skip'], from: 'Santiago', skip: 'long bus days' };
tk = T.tokens(ans, ctx);
const txt = tk.map(t => t.text || t.label).join('');
ok(txt === 'A 3-week trip through Patagonia by myself, and I love food & wine and nightlife. I travel slowly, 3+ nights per stop. Starting in Santiago. I’d rather avoid long bus days.', 'solo wording + extras: ' + txt);
ok(T.missing(ans).length === 0, 'all filled');
const rq = T.request(ans, Object.assign({ start: null }, ctx));
ok(rq.who === 'by myself' && eq(rq.loves, ['food & wine', 'nightlife']) && rq.from === 'Santiago' && rq.to === null && rq.avoid === 'long bus days' && eq(rq.must, []), 'request');
ok(T.optionsFor('from', ctx)[0] === 'Santiago' && T.extrasFor({ exactDates: true }, []).every(e => e[0] !== 'when'), 'start point offers step-1 places; no "when" with exact dates');
ok(T.lengthText(21, '3 weeks') === '3-week' && T.lengthText(14, null) === '14-day' && T.lengthText(3, 'Weekend') === 'weekend', 'length text');

// dates
ok(T.addDays('2027-04-05', 13) === '2027-04-18' && T.daysIncl('2027-04-05', '2027-04-18') === 14, 'date maths');
const g = T.monthGrid(2027, 3); ok(g[0] === null && g.indexOf('2027-04-01') === 3 && g[g.length - 1] === '2027-04-30', 'April 2027 starts on a Thursday');

// fit nights
let ph = [{ stops: [{ nights: 3 }, { nights: 9 }] }, { stops: [{ nights: 12 }] }];
T.fitNights(ph, 21); ok(eq(ph.map(p => p.stops.map(s => s.nights)), [[3, 9], [9]]), 'too long: trimmed from the end');
ph = [{ stops: [{ nights: 2 }, { nights: 5 }] }]; T.fitNights(ph, 10); ok(eq(ph[0].stops.map(s => s.nights), [5, 5]), 'too short: shortest stops grow first');
ph = [{ stops: [{ nights: 2 }, { nights: 3 }, { nights: 2 }] }]; let fit = T.fitNights(ph, 60, 3);
ok(eq(ph[0].stops.map(s => s.nights), [3, 3, 3]) && fit.left === 51, 'a 2-month trip with too few stops: no stop past 3 nights, the rest left to plan');
ok(T.paceCap('steadily, 2–3 nights per stop') === 3 && T.paceCap('quickly, 1–2 nights per stop') === 2 && T.paceCap('slowly, 3+ nights per stop') === 5 && T.paceCap('whatever') === 4, 'pace caps');

// day plans
let dp = T.dayPlans([{ stops: [{ place: 'Tashkent', nights: 2, next: 'train', why: 'Fly in here.' }, { place: 'Samarkand', nights: 3, next: 'bus', plans: ['Registan at dusk', 'Shah-i-Zinda', 'Day trip to Urgut'] }] },
  { stops: [{ place: 'Karakol', nights: 1 }] }], [{ text: 'Registan square at sunset', place: 'Samarkand' }, { text: 'Hike to Altyn-Arashan', place: 'Karakol' }, { text: 'Skips Khiva', place: 'Khiva', skip: true }]);
ok(eq(dp.map(d => d.plan), ['Arrive in Tashkent', null, 'Train from Tashkent · Registan at dusk', 'Shah-i-Zinda', 'Day trip to Urgut', 'Bus from Samarkand · Hike to Altyn-Arashan · Last night'])
  && dp[0].notes === 'Fly in here.' && dp[1].notes === null, 'day plans: travel in, Claude lines, highlights not doubled, last night: ' + JSON.stringify(dp.map(d => d.plan)));
dp = T.dayPlans([{ stops: [{ place: 'Lisbon', nights: 2, plans: ['', 'Belém'] }] }], [], { travel: false });
ok(eq(dp.map(d => d.plan), [null, 'Belém']), 'imported: only their own words');

// csv / tsv
let rows = T.parseDelimited('Place,Nights,Region\nSantiago,2,Chile\n"Puerto Natales, Chile",6,Patagonia\nEl Chaltén,5,Patagonia\n');
let p = T.planFromRows(rows);
ok(p.days === 13 && eq(p.phases.map(x => x.name), ['Chile', 'Patagonia']) && p.phases[1].stops[0].place === 'Puerto Natales, Chile', 'CSV with header: ' + JSON.stringify(p.phases));
rows = T.parseDelimited('Date\tLocation\tPlan\n2027-04-05\tLisbon\tArrive\n2027-04-06\tLisbon\tAlfama\n2027-04-07\tSintra\tPena\n2027-04-08\tLisbon\t\n');
p = T.planFromRows(rows);
ok(p.start === '2027-04-05' && p.days === 4 && eq(p.phases[0].stops, [{ place: 'Lisbon', nights: 2, plans: ['Arrive', 'Alfama'] }, { place: 'Sintra', nights: 1, plans: ['Pena'] }, { place: 'Lisbon', nights: 1, plans: [''] }]), 'one row per day, TSV');
p = T.planFromRows(T.parseDelimited('Tokyo\t4\nKyoto\t3\nOsaka\t2'));
ok(p.days === 9 && p.phases[0].stops.length === 3, 'no header: places + nights found');
ok(/column of places/.test(T.planFromRows([['1', '2'], ['3', '4']]).error), 'no places: a clear error');

// xlsx: build a tiny one by hand (zip with deflate)
function zip(files) {
  const parts = [], cen = []; let off = 0;
  Object.keys(files).forEach(name => {
    const data = zlib.deflateRawSync(Buffer.from(files[name])), nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    cen.push(ch, nb); off += 30 + nb.length + data.length;
  });
  const c = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, c, e]);
}
const xl = zip({
  'xl/sharedStrings.xml': '<sst><si><t>Place</t></si><si><t>Nights</t></si><si><t>Start</t></si><si><t>Santiago &amp; around</t></si><si><r><t>El </t></r><r><t>Chaltén</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>3</v></c><c r="C2" s="1"><v>46482</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>5</v></c></row></sheetData></worksheet>' });
T.readXlsx(xl, async d => zlib.inflateRawSync(Buffer.from(d))).then(r => {
  const pl = T.planFromRows(r);
  ok(pl.days === 8 && pl.phases[0].stops[1].place === 'El Chaltén' && pl.phases[0].stops[0].place === 'Santiago & around', 'xlsx read: ' + JSON.stringify(pl.phases));
  ok(pl.start === '2027-04-05', 'xlsx date serial as start: ' + pl.start);
  console.log(fails ? fails + ' failed' : 'all passed'); process.exit(fails ? 1 : 0);
}).catch(e => { console.log('FAIL xlsx', e); process.exit(1); });
