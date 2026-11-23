// In-memory stand-in for supabase-js, used only by the headless browser tests.
// Mirrors the database rules in supabase/migrations/ (001 + 002) that the app relies on.
(function () {
  const uid = () => crypto.randomUUID();
  const db = JSON.parse(localStorage.getItem('fake:db') || 'null') || { trips: [], days: [], phases: [] };
  const persist = () => localStorage.setItem('fake:db', JSON.stringify(db));
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'cindy@example.com' };
  const iso = d => d.toISOString().slice(0, 10);
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const endOf = t => (t.start_date ? iso(new Date(pd(t.start_date).getTime() + (t.length_days - 1) * 86400000)) : null);
  const blankDay = (trip_id, idx) => ({ id: uid(), trip_id, idx, phase_id: null, location: null, plan: null, notes: null });
  const now = () => new Date().toISOString();
  const content = d => !!((d.location || '').trim() || (d.plan || '').trim() || (d.notes || '').trim());

  function afterInsert(table, row) {
    if (table === 'trips') { row.end_date = endOf(row); for (let i = 0; i < row.length_days; i++) db.days.push(blankDay(row.id, i)); }
  }
  function beforeUpdate(table, old, next) {
    if (table !== 'trips') return null;
    if ('end_date' in (next.__patch || {})) return { message: 'column "end_date" can only be updated to DEFAULT' };
    next.end_date = endOf(next);
    if (old.length_days === next.length_days) return null;
    if (!(next.length_days >= 1 && next.length_days <= 731)) return { message: 'violates check constraint "trip_length"' };
    const cut = db.days.filter(d => d.trip_id === old.id && d.idx >= next.length_days);
    if (cut.some(content)) return { message: 'DAYS_WITH_CONTENT_OUTSIDE_DATES' };
    db.days = db.days.filter(d => cut.indexOf(d) < 0);
    const have = new Set(db.days.filter(d => d.trip_id === old.id).map(d => d.idx));
    for (let i = 0; i < next.length_days; i++) if (!have.has(i)) db.days.push(blankDay(old.id, i));
    return null;
  }

  // Same checks and effects as apply_layout() in supabase/migrations/002_planner.sql.
  function applyLayout({ p_trip, p_expect, p_phases, p_days }) {
    const trip = db.trips.find(t => t.id === p_trip);
    if (!trip) return { data: null, error: { message: 'TRIP_NOT_FOUND' } };
    if (p_expect && trip.updated_at !== p_expect) return { data: null, error: { message: 'LAYOUT_CHANGED' } };
    const n = p_days.length, bad = m => ({ data: null, error: { message: 'BAD_LAYOUT: ' + m } });
    if (n < 1 || n > 731) return bad('length');
    const idxs = p_days.map(d => d.idx).sort((a, b) => a - b);
    if (idxs.some((v, i) => v !== i)) return bad('days must be numbered 0 to ' + (n - 1));
    const order = p_days.slice().sort((a, b) => a.idx - b.idx);
    const ids = new Set(p_phases.map(p => p.id));
    if (order.some(d => d.phase_id && !ids.has(d.phase_id))) return bad('unknown phase');
    const seq = []; order.forEach(d => { if (seq[seq.length - 1] !== d.phase_id) seq.push(d.phase_id); });
    const named = seq.filter(Boolean);
    if (new Set(named).size !== named.length) return bad('every phase needs days that are next to each other');
    if (named.length !== p_phases.length) return bad('every phase needs days');
    const bySort = p_phases.slice().sort((a, b) => a.sort - b.sort).map(p => p.id);
    if (bySort.join() !== named.join()) return bad('phases are not in sort order');
    if (seq.indexOf(null) >= 0 && seq.indexOf(null) !== seq.length - 1) return bad('days without a phase must come after the phases');
    const oldPh = db.phases.filter(p => p.trip_id === p_trip);
    db.phases = db.phases.filter(p => p.trip_id !== p_trip).concat(p_phases.map(p => Object.assign({ created_at: now() },
      oldPh.find(o => o.id === p.id) || {}, p, { trip_id: p_trip, name: (p.name || '').trim() || null, updated_at: now() })));
    db.days = db.days.filter(d => d.trip_id !== p_trip).concat(p_days.map(d => ({ id: d.id, trip_id: p_trip, idx: d.idx, phase_id: d.phase_id || null,
      location: d.location || null, plan: d.plan || null, notes: d.notes || null })));
    trip.length_days = n; trip.end_date = endOf(trip);
    trip.updated_at = new Date(Math.max(Date.now(), Date.parse(trip.updated_at) + 1)).toISOString();
    persist();
    return { data: trip.updated_at, error: null };
  }

  function builder(table) {
    const q = { op: 'select', filters: [], orders: [], one: null, payload: null };
    const api = {
      select() { if (q.op === 'select') q.op = 'select'; q.returning = true; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      upsert(p) { q.op = 'upsert'; q.payload = p; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push(r => r[c] === v); return api; },
      in(c, arr) { q.filters.push(r => arr.indexOf(r[c]) >= 0); return api; },
      order(c, o) { q.orders.push([c, !o || o.ascending !== false]); return api; },
      single() { q.one = 'single'; return api; },
      maybeSingle() { q.one = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); }
    };
    function run() {
      if (window.__fakeFail) return { data: null, error: { message: window.__fakeFail } };
      const rows = db[table] || (db[table] = []);
      const match = r => q.filters.every(f => f(r));
      let data = null, error = null;
      if (q.op === 'select') {
        data = rows.filter(match).map(r => Object.assign({}, r));
        q.orders.forEach(([c, asc]) => data.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)));
      } else if (q.op === 'insert') {
        const list = [].concat(q.payload).map(p => Object.assign({ id: uid(), created_at: now(), updated_at: now() },
          table === 'trips' ? { owner_id: user.id, archived: false, subtitle: null, start_date: null } : {},
          table === 'phases' ? { photo_url: null, photo_credit: null, sort: 0 } : {}, p));
        list.forEach(r => { rows.push(r); afterInsert(table, r); });
        data = list.map(r => Object.assign({}, r));
      } else if (q.op === 'update') {
        data = [];
        for (const r of rows.filter(match)) {
          const next = Object.assign({}, r, q.payload, { __patch: q.payload });
          const err = beforeUpdate(table, r, next);
          if (err) { error = err; data = null; break; }
          Object.assign(r, q.payload, { end_date: next.end_date, updated_at: now() });
          data.push(Object.assign({}, r));
        }
      } else if (q.op === 'upsert') {
        data = [].concat(q.payload).map(p => {
          const r = rows.find(x => x.id === p.id);
          if (r) Object.assign(r, p); else rows.push(Object.assign({}, p));
          return Object.assign({}, r || p);
        });
      } else if (q.op === 'delete') {
        const gone = rows.filter(match);
        db[table] = rows.filter(r => !match(r));
        if (table === 'trips') gone.forEach(t => { db.days = db.days.filter(d => d.trip_id !== t.id); db.phases = db.phases.filter(p => p.trip_id !== t.id); });
        if (table === 'phases') gone.forEach(p => db.days.forEach(d => { if (d.phase_id === p.id) d.phase_id = null; }));
        data = gone;
      }
      if (!error) persist();
      if (!error && q.one) {
        if (data.length > 1) return { data: null, error: { message: 'more than one row' } };
        if (!data.length && q.one === 'single') return { data: null, error: { message: 'no rows' } };
        data = data[0] || null;
      }
      return { data, error };
    }
    return api;
  }

  const listeners = [];
  const signedIn = () => localStorage.getItem('fake:signedin') === '1';
  const sess = () => (signedIn() ? { user, access_token: 'x' } : null);
  window.supabase = {
    createClient() {
      return {
        from: builder,
        rpc: async (fn, args) => (window.__fakeFail ? { data: null, error: { message: window.__fakeFail } } : fn === 'apply_layout' ? applyLayout(args) : { data: null, error: { message: 'unknown function ' + fn } }),
        auth: {
          getSession: async () => ({ data: { session: sess() } }),
          onAuthStateChange(fn) { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
          signInWithOtp: async ({ email }) => { window.__lastOtp = email; return { error: null }; },
          signOut: async () => { localStorage.removeItem('fake:signedin'); listeners.forEach(f => f('SIGNED_OUT', null)); return { error: null }; },
          __signIn() { localStorage.setItem('fake:signedin', '1'); listeners.forEach(f => f('SIGNED_IN', sess())); }
        }
      };
    }
  };
})();
