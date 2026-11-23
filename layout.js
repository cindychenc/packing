/* Suitcase · trip layout rules (pure functions, no DOM, no Supabase)
 *
 * A layout is the order of a trip's days and how they are grouped into phases:
 *   { phases: [{ id, name, colour, photo_url, photo_credit, days: [day, …] }, …],
 *     free:   [day, …] }                       // days not in a phase yet, always at the end
 *   day = { id, location, plan, notes }
 *
 * Phases are contiguous and in order; free days come after the last phase.
 * Every change returns { layout, msg } (msg is the toast text) or { error } and never mutates its input.
 * Ported from the "Design · New trip prototype" wireframes (Proto-NewTrip.dc.html).
 * Loaded by index.html (window.SuitcaseLayout) and by tests/layout.test.js (Node).
 */
(function (root) {
  'use strict';

  const MAX_DAYS = 731;
  const PALETTE = ['#4A7A0E', '#5A45D6', '#C24A00', '#758400', '#C2002F', '#2E3B14', '#6B6B3C', '#84505D'];
  const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

  let makeId = () => root.crypto.randomUUID();
  const setIdMaker = fn => { makeId = fn; };

  const blankDay = () => ({ id: makeId(), location: null, plan: null, notes: null });
  const hasContent = d => !!((d.location || '').trim() || (d.plan || '').trim() || (d.notes || '').trim());
  const dd = n => n + (n === 1 ? ' day' : ' days');
  const clone = L => ({ phases: L.phases.map(p => Object.assign({}, p, { days: p.days.slice() })), free: L.free.slice() });
  const total = L => L.phases.reduce((a, p) => a + p.days.length, 0) + L.free.length;

  /* Name shown for a phase: its own name, or "Second area to explore" when unnamed. */
  const suggestion = i => (ORD[i] ? ORD[i] + ' area' : 'Area ' + (i + 1)) + ' to explore';
  const nameOf = (L, i) => (L.phases[i].name || '').trim() || suggestion(i);
  function listNames(L, from) {
    const a = L.phases.slice(from).map((p, j) => nameOf(L, from + j));
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + ' and ' + a[1];
    return a[0] + ', ' + a[1] + ' and ' + (a.length - 2) + ' more';
  }

  function nextColour(L) {
    const used = L.phases.map(p => (p.colour || '').toUpperCase());
    return PALETTE.find(c => used.indexOf(c) < 0) || PALETTE[L.phases.length % PALETTE.length];
  }

  /* Take one empty day off the end of the free days (to keep the trip length when a middle phase grows).
     Returns false if there is none, so the caller makes the trip longer instead. */
  function popEmptyFree(c) {
    for (let k = c.free.length - 1; k >= 0; k--) if (!hasContent(c.free[k])) { c.free.splice(k, 1); return true; }
    return false;
  }

  /* ───────── changes ───────── */

  /* New phase at position i (0 = first, phases.length = after the last) with len days. */
  function insertPhaseAt(L, i, len) {
    if (!(len >= 1)) return { error: 'A phase needs at least 1 day' };
    const c = clone(L); const atEnd = i === c.phases.length; let days, grew = 0;
    if (atEnd) {
      days = c.free.splice(0, Math.min(len, c.free.length));
      while (days.length < len) { days.push(blankDay()); grew++; }
    } else {
      days = []; for (let k = 0; k < len; k++) { days.push(blankDay()); if (!popEmptyFree(c)) grew++; }
    }
    if (total(c) > MAX_DAYS) return { error: 'A trip can be at most ' + MAX_DAYS + ' days' };
    c.phases.splice(i, 0, { id: makeId(), name: null, colour: nextColour(L), photo_url: null, photo_credit: null, days });
    const later = listNames(c, i + 1);
    let msg = 'Added Phase ' + (i + 1) + ' (' + dd(len) + ')';
    if (later) msg += ' · ' + later + ' moved ' + dd(len) + ' later';
    if (grew) msg += ' · trip is now ' + dd(total(c));
    return { layout: c, msg, phaseIndex: i };
  }

  /* Make phase i longer (d > 0) or shorter (d < 0). */
  function resizePhase(L, i, d) {
    const c = clone(L); const last = i === c.phases.length - 1; const name = nameOf(c, i); const later = listNames(c, i + 1);
    let msg;
    if (d > 0) {
      let grew = 0;
      for (let k = 0; k < d; k++) {
        let day;
        if (last && c.free.length) day = c.free.shift();
        else { day = blankDay(); if (last || !popEmptyFree(c)) grew++; }
        c.phases[i].days.push(day);
      }
      if (total(c) > MAX_DAYS) return { error: 'A trip can be at most ' + MAX_DAYS + ' days' };
      msg = name + ' +' + dd(d);
      if (later) msg += ' · ' + later + ' moved ' + dd(d) + ' later';
      if (grew) msg += ' · trip is now ' + dd(total(c));
    } else {
      let k = 0;
      while (k < -d && c.phases[i].days.length > 1) {
        const day = c.phases[i].days.pop();
        if (last) c.free.unshift(day); else c.free.push(blankDay());   // a middle phase's removed days are deleted
        k++;
      }
      if (!k) return { error: 'A phase needs at least 1 day · use ••• to delete it' };
      msg = name + ' −' + dd(k);
      if (later) msg += ' · ' + later + ' moved ' + dd(k) + ' earlier';
    }
    return { layout: c, msg };
  }

  const addDayToPhase = (L, i) => resizePhase(L, i, 1);

  /* Remove day j of phase i. The trip keeps its length: an empty day is added to the days left to plan. */
  function removeDay(L, i, j) {
    const c = clone(L); const p = c.phases[i];
    if (p.days.length <= 1) return { error: 'A phase needs at least 1 day · use ••• to delete the phase' };
    const last = i === c.phases.length - 1; const name = nameOf(c, i); const later = listNames(c, i + 1);
    p.days.splice(j, 1);
    if (last) c.free.unshift(blankDay()); else c.free.push(blankDay());
    let msg = 'Removed a day from ' + name;
    msg += later ? ' · ' + later + ' moved 1 day earlier' : ' · 1 more day to plan';
    return { layout: c, msg };
  }

  /* Delete phase i. The last phase's days go back to plan as they are; a middle phase's days are deleted
     (later phases move earlier) and the same number of empty days is added at the end. */
  function removePhase(L, i) {
    const c = clone(L); const last = i === c.phases.length - 1; const name = nameOf(c, i); const later = listNames(c, i + 1);
    const p = c.phases.splice(i, 1)[0];
    if (last) c.free = p.days.concat(c.free);
    else c.free = c.free.concat(p.days.map(() => blankDay()));
    let msg = 'Removed ' + name + ' · ' + dd(p.days.length) + ' back to plan';
    if (later) msg += ' · ' + later + ' moved earlier';
    return { layout: c, msg };
  }

  /* Move phase from → to (its days, with their plans, move with it). */
  function movePhase(L, from, to) {
    if (from === to || to < 0 || to >= L.phases.length) return { error: 'Nothing to move' };
    const c = clone(L); const before = c.phases.map((q, j) => nameOf(L, j)); const ids = c.phases.map(q => q.id);
    const p = c.phases.splice(from, 1)[0]; c.phases.splice(to, 0, p);
    const name = before[from];
    const msg = to < c.phases.length - 1 ? name + ' now comes before ' + before[ids.indexOf(c.phases[to + 1].id)] : name + ' is now the last phase';
    return { layout: c, msg };
  }

  /* Trip length ± days at the end (only empty days can be removed). */
  function setTripLength(L, n) {
    if (!(n >= 1) || n > MAX_DAYS) return { error: 'A trip is 1 to ' + MAX_DAYS + ' days' };
    const c = clone(L); const now = total(c);
    if (n > now) { for (let k = now; k < n; k++) c.free.push(blankDay()); return { layout: c, msg: 'Trip is now ' + dd(n) }; }
    if (n === now) return { layout: c, msg: '' };
    const cut = now - n;
    if (cut > c.free.length) return { error: 'Only the ' + dd(c.free.length) + ' not in a phase can be removed · shorten the last phase first' };
    const gone = c.free.splice(c.free.length - cut, cut);
    return { layout: c, msg: 'Trip is now ' + dd(n), removed: gone, removedWithContent: gone.filter(hasContent) };
  }

  /* ───────── rows ↔ layout ───────── */

  /* From database rows (phases with sort, days with idx/phase_id) to a layout.
     Tidies older data: each phase becomes one block in order of its first day; days without a phase go to the end. */
  function fromRows(phaseRows, dayRows) {
    const days = dayRows.slice().sort((a, b) => a.idx - b.idx);
    const firstIdx = {}; days.forEach(d => { if (d.phase_id && !(d.phase_id in firstIdx)) firstIdx[d.phase_id] = d.idx; });
    const phases = phaseRows.filter(p => p.id in firstIdx)
      .sort((a, b) => firstIdx[a.id] - firstIdx[b.id] || (a.sort || 0) - (b.sort || 0))
      .map(p => ({ id: p.id, name: p.name || null, colour: p.colour || null, photo_url: p.photo_url || null, photo_credit: p.photo_credit || null,
        days: days.filter(d => d.phase_id === p.id).map(pick) }));
    const known = new Set(phases.map(p => p.id));
    return { phases, free: days.filter(d => !d.phase_id || !known.has(d.phase_id)).map(pick) };
  }
  const pick = d => ({ id: d.id, location: d.location || null, plan: d.plan || null, notes: d.notes || null });

  /* From a layout to what apply_layout() takes. Phases with no days are left out (they get deleted). */
  function toRows(L) {
    const phases = [], days = []; let idx = 0;
    L.phases.forEach((p, s) => {
      phases.push({ id: p.id, name: p.name || null, colour: p.colour || null, photo_url: p.photo_url || null, photo_credit: p.photo_credit || null, sort: s });
      p.days.forEach(d => days.push(Object.assign(pick(d), { idx: idx++, phase_id: p.id })));
    });
    L.free.forEach(d => days.push(Object.assign(pick(d), { idx: idx++, phase_id: null })));
    return { phases, days };
  }

  /* Index of the day (0-based) where phase i starts. */
  const startIdx = (L, i) => L.phases.slice(0, i).reduce((a, p) => a + p.days.length, 0);

  /* Dates: 'YYYY-MM-DD' for position idx, or null when the trip has no start date. */
  function dateAt(start, idx) {
    if (!start) return null;
    const [y, m, d] = start.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + idx)).toISOString().slice(0, 10);
  }

  const api = { MAX_DAYS, PALETTE, setIdMaker, blankDay, hasContent, total, suggestion, nameOf, nextColour,
    insertPhaseAt, resizePhase, addDayToPhase, removeDay, removePhase, movePhase, setTripLength,
    fromRows, toRows, startIdx, dateAt, clone };
  root.SuitcaseLayout = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
