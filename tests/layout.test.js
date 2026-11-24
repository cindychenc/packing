// Unit tests for layout.js (the trip layout rules). Run:  node tests/layout.test.js
'use strict';
const assert = require('assert');
const L = require('../layout.js');

let n = 0; L.setIdMaker(() => 'id' + (++n));
const days = k => Array.from({ length: k }, () => L.blankDay());
const lens = x => x.phases.map(p => p.days.length);
let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; } };

// A 21-day trip: Tokyo 4 · Kyoto 5 · Hiroshima 3 · 9 free
function trip() {
  let x = { phases: [], free: days(21) };
  x = L.insertPhaseAt(x, 0, 4).layout; x.phases[0].name = 'Tokyo';
  x = L.insertPhaseAt(x, 1, 5).layout; x.phases[1].name = 'Kyoto';
  x = L.insertPhaseAt(x, 2, 3).layout; x.phases[2].name = 'Hiroshima';
  return x;
}

t('first phase from the free days keeps the trip length', () => {
  const r = L.insertPhaseAt({ phases: [], free: days(14) }, 0, 5);
  assert.deepStrictEqual(lens(r.layout), [5]); assert.strictEqual(r.layout.free.length, 9);
  assert.strictEqual(r.msg, 'Added Phase 1 (5 days)');
  assert.strictEqual(r.layout.phases[0].colour, L.PALETTE[0]);
});
t('new phase at the end takes free days in order, keeping their plans', () => {
  const x = { phases: [], free: days(5) }; x.free[0].location = 'Lisbon';
  const r = L.insertPhaseAt(x, 0, 2);
  assert.strictEqual(r.layout.phases[0].days[0].location, 'Lisbon');
  assert.strictEqual(x.free.length, 5, 'input not changed');
});
t('new phase longer than the free days makes the trip longer', () => {
  const r = L.insertPhaseAt({ phases: [], free: days(3) }, 0, 5);
  assert.strictEqual(L.total(r.layout), 5); assert.ok(r.msg.endsWith('trip is now 5 days'));
});
t('new phase in the middle moves later phases and uses up free days', () => {
  const r = L.insertPhaseAt(trip(), 1, 2);
  assert.deepStrictEqual(lens(r.layout), [4, 2, 5, 3]); assert.strictEqual(r.layout.free.length, 7);
  assert.strictEqual(r.msg, 'Added Phase 2 (2 days) · Kyoto and Hiroshima moved 2 days later');
});
t('colours are not repeated', () => {
  const x = trip(); assert.deepStrictEqual(x.phases.map(p => p.colour), L.PALETTE.slice(0, 3));
});
t('grow a middle phase: later phases move, trip length stays', () => {
  const r = L.resizePhase(trip(), 1, 1);
  assert.deepStrictEqual(lens(r.layout), [4, 6, 3]); assert.strictEqual(L.total(r.layout), 21);
  assert.strictEqual(r.msg, 'Kyoto +1 day · Hiroshima moved 1 day later');
});
t('grow a middle phase with no free days makes the trip longer', () => {
  let x = trip(); x.free = [];
  const r = L.resizePhase(x, 0, 2);
  assert.strictEqual(L.total(r.layout), 14); assert.strictEqual(r.msg, 'Tokyo +2 days · Kyoto and Hiroshima moved 2 days later · trip is now 14 days');
});
t('a free day with a plan is never thrown away when a middle phase grows', () => {
  let x = trip(); x.free = days(1); x.free[0].plan = 'keep me';
  const r = L.resizePhase(x, 0, 1);
  assert.strictEqual(r.layout.free[0].plan, 'keep me'); assert.strictEqual(L.total(r.layout), 14);
});
t('grow the last phase takes the next free day', () => {
  const x = trip(); const first = x.free[0].id;
  const r = L.resizePhase(x, 2, 1);
  assert.strictEqual(r.layout.phases[2].days[3].id, first); assert.strictEqual(r.msg, 'Hiroshima +1 day');
});
t('shrink a middle phase: later phases move earlier, an empty day goes to the end', () => {
  const r = L.resizePhase(trip(), 0, -2);
  assert.deepStrictEqual(lens(r.layout), [2, 5, 3]); assert.strictEqual(r.layout.free.length, 11);
  assert.strictEqual(r.msg, 'Tokyo −2 days · Kyoto and Hiroshima moved 2 days earlier');
});
t('shrink the last phase hands its days back with their plans', () => {
  const x = trip(); x.phases[2].days[2].location = 'Miyajima';
  const r = L.resizePhase(x, 2, -1);
  assert.strictEqual(r.layout.free[0].location, 'Miyajima');
});
t('a phase keeps at least 1 day', () => {
  assert.ok(L.resizePhase(trip(), 2, -5).layout.phases[2].days.length === 1);
  let x = L.resizePhase(trip(), 2, -2).layout; assert.ok(L.resizePhase(x, 2, -1).error);
});
t('remove a day from a middle phase', () => {
  const x = trip(); const gone = x.phases[1].days[2].id;
  const r = L.removeDay(x, 1, 2);
  assert.deepStrictEqual(lens(r.layout), [4, 4, 3]); assert.strictEqual(L.total(r.layout), 21);
  assert.ok(!r.layout.phases[1].days.some(d => d.id === gone));
  assert.strictEqual(r.msg, 'Removed a day from Kyoto · Hiroshima moved 1 day earlier');
});
t('remove a day from the last phase', () => {
  assert.strictEqual(L.removeDay(trip(), 2, 0).msg, 'Removed a day from Hiroshima · 1 more day to plan');
});
t('remove phase in the middle deletes its days, later phases move earlier', () => {
  const r = L.removePhase(trip(), 1);
  assert.deepStrictEqual(lens(r.layout), [4, 3]); assert.strictEqual(r.layout.free.length, 14);
  assert.strictEqual(r.msg, 'Removed Kyoto · 5 days back to plan · Hiroshima moved earlier');
});
t('remove the last phase keeps its days (and plans) as free days', () => {
  const x = trip(); x.phases[2].days[0].location = 'Hiroshima';
  const r = L.removePhase(x, 2);
  assert.strictEqual(r.layout.free[0].location, 'Hiroshima'); assert.strictEqual(r.layout.free.length, 12);
});
t('move a phase: days and plans move with it', () => {
  const x = trip(); x.phases[2].days[0].location = 'Hiroshima';
  const r = L.movePhase(x, 2, 0);
  assert.deepStrictEqual(r.layout.phases.map(p => p.name), ['Hiroshima', 'Tokyo', 'Kyoto']);
  assert.strictEqual(r.layout.phases[0].days[0].location, 'Hiroshima');
  assert.strictEqual(r.msg, 'Hiroshima now comes before Tokyo');
  assert.strictEqual(L.movePhase(x, 0, 2).msg, 'Tokyo is now the last phase');
});
t('unnamed phases are called "Second area to explore" etc.', () => {
  let x = L.insertPhaseAt({ phases: [], free: days(10) }, 0, 2).layout;
  x = L.insertPhaseAt(x, 1, 2).layout;
  assert.strictEqual(L.resizePhase(x, 0, 1).msg, 'First area to explore +1 day · Second area to explore moved 1 day later');
});
t('trip length: add and remove empty days at the end', () => {
  assert.strictEqual(L.total(L.setTripLength(trip(), 25).layout), 25);
  const r = L.setTripLength(trip(), 15);
  assert.strictEqual(L.total(r.layout), 15); assert.strictEqual(r.removed.length, 6);
  assert.ok(L.setTripLength(trip(), 11).error, 'cannot cut into phases');
  const x = trip(); x.free[8].plan = 'x';
  assert.strictEqual(L.setTripLength(x, 20).removedWithContent.length, 1);
});
t('toRows / fromRows round trip', () => {
  const x = trip(); x.phases[1].days[0].location = 'Kyoto';
  const rows = L.toRows(x);
  assert.deepStrictEqual(rows.days.map(d => d.idx), Array.from({ length: 21 }, (_, i) => i));
  assert.strictEqual(rows.days[4].phase_id, x.phases[1].id); assert.strictEqual(rows.days[20].phase_id, null);
  assert.deepStrictEqual(rows.phases.map(p => p.sort), [0, 1, 2]);
  const back = L.fromRows(rows.phases, rows.days);
  assert.deepStrictEqual(lens(back), [4, 5, 3]); assert.strictEqual(back.phases[1].days[0].location, 'Kyoto');
});
t('fromRows tidies older data into blocks', () => {
  const P = [{ id: 'A', sort: 0 }, { id: 'B', sort: 1 }, { id: 'C', sort: 2 }];
  const D = [['A'], [null], ['B'], ['A'], ['B'], [null]].map((r, i) => ({ id: 'd' + i, idx: i, phase_id: r[0] }));
  const x = L.fromRows(P, D);
  assert.deepStrictEqual(x.phases.map(p => p.id), ['A', 'B']);   // C has no days
  assert.deepStrictEqual(x.phases[0].days.map(d => d.id), ['d0', 'd3']);
  assert.deepStrictEqual(x.free.map(d => d.id), ['d1', 'd5']);
});
t('dateAt', () => {
  assert.strictEqual(L.dateAt('2027-04-01', 0), '2027-04-01'); assert.strictEqual(L.dateAt('2027-02-27', 3), '2027-03-02');
  assert.strictEqual(L.dateAt(null, 3), null);
});


// ───────── stops ─────────
const locs = p => p.days.map(d => d.location);
t('stops are runs of the same place; empty days are their own runs', () => {
  const p = { days: [{ location: 'Tokyo' }, { location: ' tokyo ' }, { location: 'Kyoto' }, { location: null }, { location: null }] };
  assert.deepStrictEqual(L.stopsOf(p).map(s => [s.place, s.start, s.n]), [['Tokyo', 0, 2], ['Kyoto', 2, 1], [null, 3, 1], [null, 4, 1]]);
});
t('first stop makes the first phase from the free days', () => {
  const r = L.firstStop({ phases: [], free: days(14) }, 'Lima', 3);
  assert.deepStrictEqual(lens(r.layout), [3]); assert.strictEqual(r.layout.free.length, 11);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['Lima', 'Lima', 'Lima']);
  assert.strictEqual(r.msg, 'Added Lima (3 nights)');
});
t('add stop to the last phase takes free days in order', () => {
  let x = L.firstStop({ phases: [], free: days(10) }, 'Lima', 2).layout;
  const r = L.addStop(x, 0, 'Cusco', 3);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['Lima', 'Lima', 'Cusco', 'Cusco', 'Cusco']);
  assert.strictEqual(r.layout.free.length, 5); assert.strictEqual(L.total(r.layout), 10);
  assert.strictEqual(r.msg, 'Added Cusco (3 nights)');
});
t('add stop fills empty days at the end of the phase first', () => {
  const x = trip(); x.phases[0].days[0].location = 'Tokyo'; x.phases[0].days[1].location = 'Tokyo';
  const r = L.addStop(x, 0, 'Nikko', 2);
  assert.deepStrictEqual(lens(r.layout), [4, 5, 3]);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['Tokyo', 'Tokyo', 'Nikko', 'Nikko']);
});
t('add stop to a middle phase moves later phases and uses up free days', () => {
  const x = trip(); x.phases[1].days.forEach(d => { d.location = 'Kyoto'; });
  const r = L.addStop(x, 1, 'Nara', 2);
  assert.deepStrictEqual(lens(r.layout), [4, 7, 3]); assert.strictEqual(r.layout.free.length, 7);
  assert.strictEqual(r.msg, 'Added Nara (2 nights) · Hiroshima moved 2 days later');
});
t('longer stop inserts days right after it', () => {
  let x = L.firstStop({ phases: [], free: days(10) }, 'Lima', 2).layout;
  x = L.addStop(x, 0, 'Cusco', 2).layout;
  const r = L.setStopNights(x, 0, 0, 4);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['Lima', 'Lima', 'Lima', 'Lima', 'Cusco', 'Cusco']);
  assert.strictEqual(L.total(r.layout), 10);
  assert.strictEqual(r.msg, 'Lima +2 nights · everything after moved 2 days later');
});
t('shorter stop removes its last days and keeps the trip length', () => {
  let x = L.firstStop({ phases: [], free: days(10) }, 'Lima', 3).layout;
  x = L.addStop(x, 0, 'Cusco', 2).layout;
  const r = L.setStopNights(x, 0, 0, 1);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['Lima', 'Cusco', 'Cusco']);
  assert.strictEqual(L.total(r.layout), 10);
  assert.strictEqual(L.setStopNights(x, 0, 0, 0).error.indexOf('at least 1 night') > 0, true);
});
t('stops round-trip through toRows/fromRows', () => {
  let x = L.firstStop({ phases: [], free: days(6) }, 'Lima', 2).layout;
  x = L.addStop(x, 0, 'Cusco', 2).layout;
  const rows = L.toRows(x); const back = L.fromRows(rows.phases, rows.days);
  assert.deepStrictEqual(L.stopsOf(back.phases[0]).map(s => [s.place, s.n]), [['Lima', 2], ['Cusco', 2]]);
});

// ───────── drafts ─────────
t('a draft fills the trip in order and leaves the rest to plan', () => {
  const r = L.fromDraft([{ name: 'Chile', stops: [{ place: 'Santiago', nights: 2 }, { place: 'Pucón', nights: 3 }] }, { name: 'Peru', stops: [{ place: 'Cusco', nights: 4 }] }], 12);
  assert.deepStrictEqual(lens(r.layout), [5, 4]); assert.strictEqual(r.layout.free.length, 3);
  assert.deepStrictEqual(locs(r.layout.phases[1]), ['Cusco', 'Cusco', 'Cusco', 'Cusco']);
  assert.notStrictEqual(r.layout.phases[0].colour, r.layout.phases[1].colour); assert.strictEqual(r.shortened, false);
});
t('a draft longer than the trip is cut at the end', () => {
  const r = L.fromDraft([{ name: 'A', stops: [{ place: 'X', nights: 4 }, { place: 'Y', nights: 4 }, { place: 'Z', nights: 2 }] }], 6);
  assert.deepStrictEqual(locs(r.layout.phases[0]), ['X', 'X', 'X', 'X', 'Y', 'Y']); assert.strictEqual(r.shortened, true); assert.strictEqual(r.layout.free.length, 0);
});
t('empty stops and phases are skipped', () => {
  const r = L.fromDraft([{ name: 'Empty', stops: [] }, { name: '', stops: [{ place: ' ', nights: 2 }, { place: 'Lima', nights: 0 }] }], 3);
  assert.deepStrictEqual(lens(r.layout), [1]); assert.strictEqual(r.layout.phases[0].name, null);
});
console.log(passed + ' layout tests passed' + (process.exitCode ? ' (some failed)' : ''));
