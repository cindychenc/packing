// node tests/newtrip.test.js
const T = require('../newtrip-core.js');
const zlib = require('zlib');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// step 2: the form (every answer optional)
const ctx = { dest: 'Patagonia', days: 21, exactDates: false, seasons: [] };
let rq = T.request({ loves: [], shape: 'any' }, ctx);
ok(rq.who === null && eq(rq.loves, []) && rq.pace === null && rq.fitness === null && rq.when === null && rq.shape === null && eq(rq.must, []) && rq.avoid === null, 'all blank is a valid request');
const ans = { who: 'by myself', loves: ['food scene', 'markets'], pace: 'slowly, 3+ nights per stop', fitness: 'day hikes', shape: 'open', from: ' Santiago ', to: 'Buenos Aires',
  must: 'the W Trek, a night in a yurt', avoid: 'long bus days' };
rq = T.request(ans, Object.assign({}, ctx, { seasons: ['spring', 'fall'] }));
ok(rq.who === 'by myself' && eq(rq.loves, ['food scene', 'markets']) && rq.fitness === 'day hikes' && rq.from === 'Santiago' && rq.to === 'Buenos Aires' && rq.shape === 'open'
  && eq(rq.must, ['the W Trek, a night in a yurt']) && rq.avoid === 'long bus days' && rq.when === 'in spring or autumn', 'request: ' + JSON.stringify(rq));
ok(T.request(Object.assign({}, ans, { shape: 'loop' }), ctx).to === 'Santiago', 'a loop ends where it starts');
ok(T.request(ans, Object.assign({}, ctx, { exactDates: true, seasons: ['spring'] })).when === null, 'no season with exact dates');
ok(eq(T.pickSeason(['spring'], 'summer'), ['spring', 'summer']) && eq(T.pickSeason(['spring', 'summer'], 'unsure'), ['unsure']) && eq(T.pickSeason(['unsure'], 'winter'), ['winter'])
  && eq(T.pickSeason(['spring', 'summer'], 'spring'), ['summer']), 'seasons: several at once; "Not sure yet" stands alone');
ok(T.whenText(['unsure']) === null && T.whenText(['winter']) === 'in winter' && T.whenText(['spring', 'summer', 'fall']) === 'in spring, summer or autumn', 'season text');
ok(T.paceCap(T.FORM.pace[0][2]) === 5 && T.paceCap(T.FORM.pace[2][2]) === 2 && T.paceCap(null) === 4, 'pace values keep their nights per stop');
ok(T.FORM.loves.length === 15 && T.FORM.shown === 6 && eq(T.toggle(['a'], 'b'), ['a', 'b']) && eq(T.toggle(['a', 'b'], 'a'), ['b']), 'interests and toggling');

// step 3: the table cells
ok(T.travelText([{ next: 'fly' }, { next: 'bus' }, { next: 'bus' }, { next: 'drive' }, {}]) === '1 flight · 2 buses · 1 driving day' && T.travelText([{}]) === '', 'getting around');
const pl = T.phaseList([{ name: 'Patagonia', stops: [{ place: 'Puerto Natales', nights: 6, why: 'Base for the W Trek.' }, { place: 'El Chaltén', nights: 5, why: 'Fitz Roy!' }] }],
  [{ text: 'W Trek, 5 days', place: 'puerto natales' }, { text: 'Skips the glacier', place: 'El Chaltén', skip: true }]);
ok(pl[0].days === 11 && pl[0].stops[0].what === 'W Trek, 5 days' && pl[0].stops[1].what === 'Fitz Roy.', 'list view: highlight for the stop, else why (tidied)');
ok(T.lengthText(21, '3 weeks') === '3-week' && T.lengthText(14, null) === '14-day' && T.lengthText(3, 'Weekend') === 'weekend', 'length text');

// places: a country name narrows the search
const P = require('../places.js');
ok(P.ccFor('Kyrgyzstan') === 'KG' && P.ccFor('Kyrgyz Republic') === 'KG' && P.ccFor('Vietnam') === 'VN' && P.ccFor('nowhere') === null, 'country names to codes');
ok(P.km({ lat: 41.85, lng: 75.13 }, { lat: 21.0, lng: 105.8 }) > 3000, 'Song-Kol, Kyrgyzstan is nowhere near Vietnam');

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

// a trip from a route: only the fixed days are filled in; Claude's other lines become ideas
{
  const r = T.crucialPlans([{ stops: [
    { place: 'Santiago', nights: 2, next: 'fly', plans: ['Arrive, walk Lastarria', 'Cerro San Cristóbal funicular'] },
    { place: 'Puerto Natales', nights: 7, next: 'bus', why: 'Base for Torres!', plans: ['Arrive', 'W Trek day 1', 'Spare day: rest or a day trip', 'Milodon Cave', 'Walk the Puerto Natales waterfront'] },
    { place: 'Huaraz', nights: 3, plans: [] }] }],
    [{ text: 'W Trek, 5 days', place: 'Puerto Natales' }, { text: 'Glacier boat', place: 'puerto natales' }, { text: 'Huayhuash 8-day trek', place: 'Huaraz' }, { text: 'Skips the lakes', place: 'Santiago', skip: true }]);
  const plans = r.days.map(d => d.plan);
  ok(eq(plans, ['Arrive in Santiago', null, 'Fly from Santiago', 'Start W Trek (5 days)', 'W Trek, day 2 of 5', 'W Trek, day 3 of 5', 'W Trek, day 4 of 5', 'Finish W Trek', 'Glacier boat',
    'Bus from Puerto Natales', 'Start Huayhuash trek (2 days)', 'Finish Huayhuash trek · Last night']), 'fixed days only: ' + JSON.stringify(plans));
  ok(r.days.every(d => d.auto === !!d.plan) && r.days[2].notes === 'Base for Torres.', 'filled days are marked auto; why stays in notes');
  ok(eq(r.ideas.map(x => x.place + ': ' + x.text), ['Santiago: Cerro San Cristóbal funicular', 'Puerto Natales: Milodon Cave', 'Puerto Natales: Walk the Puerto Natales waterfront']), 'ideas: ' + JSON.stringify(r.ideas));
}
// the steps of a multi-day thing stay on their days, in order, and aren't ideas
{
  const r = T.crucialPlans([{ stops: [
    { place: 'Calenzana', nights: 2, next: 'bus', plans: ['Arrive', 'GR20 day 1'] },
    { place: 'Vizzavona', nights: 4, next: 'bus', plans: ['GR20 day 2', 'GR20 day 3', 'GR20 day 4', 'Swim in the Agnone pools'] },
    { place: 'Cusco', nights: 3, plans: ['Inca Trail 1 of 3', 'Inca Trail 2 of 3', 'Inca Trail 3 of 3'] },
    { place: 'Bastia', nights: 3, plans: ['Stage 1: Bastia to Erbalunga', 'Stage 2: Erbalunga to Macinaggio', 'Erbalunga tower walk'] }] }], []);
  const plans = r.days.map(d => d.plan);
  ok(eq(plans, ['Arrive in Calenzana', 'GR20 day 1', 'Bus from Calenzana · GR20 day 2', 'GR20 day 3', 'GR20 day 4', null,
    'Bus from Vizzavona · Inca Trail 1 of 3', 'Inca Trail 2 of 3', 'Inca Trail 3 of 3',
    'Travel from Cusco · Stage 1: Bastia to Erbalunga', 'Stage 2: Erbalunga to Macinaggio', 'Last night']), 'steps prefilled in order: ' + JSON.stringify(plans));
  ok(eq(r.ideas.map(x => x.text), ['Swim in the Agnone pools', 'Erbalunga tower walk']), 'only the loose line is an idea: ' + JSON.stringify(r.ideas));
}
