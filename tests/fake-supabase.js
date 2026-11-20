// In-memory stand-in for supabase-js, used only by the headless browser tests.
// Mirrors the database triggers in supabase/migrations/001_schema.sql that the app relies on.
(function () {
  const uid = () => crypto.randomUUID();
  const db = JSON.parse(localStorage.getItem('fake:db') || 'null') || { trips: [], days: [], phases: [] };
  const persist = () => localStorage.setItem('fake:db', JSON.stringify(db));
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'cindy@example.com' };
  const iso = d => d.toISOString().slice(0, 10);
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  function daysFor(trip) {
    const out = [];
    for (let d = pd(trip.start_date); d <= pd(trip.end_date); d = new Date(d.getTime() + 86400000)) out.push(iso(d));
    return out;
  }
  const now = () => new Date().toISOString();

  function afterInsert(table, row) {
    if (table === 'trips') daysFor(row).forEach(date => db.days.push({ id: uid(), trip_id: row.id, date, phase_id: null, location: null, plan: null, notes: null }));
  }
  function beforeUpdate(table, old, next) {
    if (table !== 'trips' || (old.start_date === next.start_date && old.end_date === next.end_date)) return null;
    const outside = db.days.filter(d => d.trip_id === old.id && (d.date < next.start_date || d.date > next.end_date));
    if (outside.some(d => d.location || d.plan || d.notes)) return { message: 'DAYS_WITH_CONTENT_OUTSIDE_DATES' };
    db.days = db.days.filter(d => outside.indexOf(d) < 0);
    const have = new Set(db.days.filter(d => d.trip_id === old.id).map(d => d.date));
    daysFor(next).forEach(date => { if (!have.has(date)) db.days.push({ id: uid(), trip_id: old.id, date, phase_id: null, location: null, plan: null, notes: null }); });
    return null;
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
          table === 'trips' ? { owner_id: user.id, archived: false, subtitle: null } : {},
          table === 'phases' ? { photo_url: null, photo_credit: null, sort: 0 } : {}, p));
        list.forEach(r => { rows.push(r); afterInsert(table, r); });
        data = list.map(r => Object.assign({}, r));
      } else if (q.op === 'update') {
        data = [];
        for (const r of rows.filter(match)) {
          const next = Object.assign({}, r, q.payload);
          const err = beforeUpdate(table, r, next);
          if (err) { error = err; data = null; break; }
          Object.assign(r, q.payload, { updated_at: now() });
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
