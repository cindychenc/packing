/* Suitcase manager · v1 (sign-in, My trips, New trip, trip page with Itinerary + Phases)
 * Plain JS, no build step. Data lives in Supabase; row-level security decides what each person sees.
 */
(function () {
  'use strict';

  const CFG = window.SUITCASE_CONFIG;
  const LAYOUT = window.SuitcaseLayout;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
  });

  const PALETTE = [
    ['Fern', '#4A7A0E'], ['Iris', '#5A45D6'], ['Tangerine', '#C24A00'], ['Chartreuse', '#758400'],
    ['Cherry', '#C2002F'], ['Deep olive', '#2E3B14'], ['Olive', '#6B6B3C'], ['Rose', '#84505D']
  ];
  const DAY_FIELDS = ['location', 'plan', 'notes'];
  const MAX_DAYS = 731;

  const app = document.getElementById('app');
  let session = null;
  let authReady = false;
  let view = null;           // what is on screen, for cleanup
  let tripData = null;       // { trip, days, phases } for the open trip

  /* ───────────── tiny DOM helper ───────────── */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'html') el.innerHTML = v;   // only ever used with our own SVG strings
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svg = s => h('span', { html: s, style: { display: 'contents' } });
  const ICON = {
    suitcase: '<svg viewBox="0 0 32 32" fill="none"><rect x="3" y="9" width="26" height="19" rx="5" fill="#F0FA69"/><rect x="3" y="9" width="26" height="19" rx="5" stroke="#111" stroke-width="2"/><path d="M12 9V6.5A2.5 2.5 0 0 1 14.5 4h3A2.5 2.5 0 0 1 20 6.5V9" stroke="#111" stroke-width="2"/><path d="M10 9v19M22 9v19" stroke="#111" stroke-width="2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    map: '<svg viewBox="0 0 64 64" fill="none" stroke="#111" stroke-width="2.5" stroke-linejoin="round"><rect x="8" y="18" width="48" height="36" rx="9" fill="#F0FA69"/><path d="M24 18v-4a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4M20 18v36M44 18v36"/></svg>'
  };

  /* ───────────── dates (all as 'YYYY-MM-DD', handled in UTC) ───────────── */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = d => d.toISOString().slice(0, 10);
  const todayIso = () => { const n = new Date(); return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); };
  const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / 86400000);
  const md = s => { const d = pd(s); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
  const wd = s => WD[pd(s).getUTCDay()];
  function range(a, b) {
    const A = pd(a), B = pd(b), sameYear = A.getUTCFullYear() === B.getUTCFullYear();
    const thisYear = A.getUTCFullYear() === new Date().getFullYear() && sameYear;
    return md(a) + (sameYear ? '' : ', ' + A.getUTCFullYear()) + ' → ' + md(b) + (thisYear ? '' : ', ' + B.getUTCFullYear());
  }
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  // A day's label: "Apr 6" when the trip has dates, otherwise "Day 6".
  const dayName = d => (d.date ? md(d.date) : 'Day ' + (d.idx + 1));

  /* ───────────── toast + modal ───────────── */
  let toastTimer;
  // toast(msg) · toast(msg, true) for errors · toast(msg, false, undoFn) adds an Undo button (shown longer)
  function toast(msg, bad, undo) {
    const t = document.getElementById('toast');
    t.replaceChildren(h('span', null, msg));
    if (undo) t.append(h('button', { type: 'button', onclick: () => { t.className = ''; undo(); } }, 'Undo'));
    t.className = 'show' + (bad ? ' bad' : '') + (undo ? ' has-undo' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : undo ? 7000 : 2600);
  }
  function modal(build) {
    const scrim = h('div', { class: 'scrim', onmousedown: e => { if (e.target === scrim) close(); } });
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    build(box, close);
    scrim.append(box); document.body.append(scrim);
    const first = box.querySelector('input, select, textarea, button.primary');
    if (first) setTimeout(() => first.focus(), 30);
    return close;
  }
  function confirmBox(title, text, okLabel, onOk, danger) {
    modal((box, close) => {
      const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: async () => { ok.disabled = true; await onOk(); close(); } }, okLabel);
      box.append(h('h2', null, title), h('p', { class: 'lead' }, text),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), ok));
    });
  }
  function errText(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/fetch|network/i.test(m)) return 'Couldn\'t reach Suitcase. Check your connection and try again.';
    return m;
  }

  /* ───────────── layout ───────────── */
  function topbar(crumbs) {
    return h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, svg(ICON.suitcase), 'Suitcase'),
      crumbs ? [h('span', { class: 'crumb-sep' }, '/'), crumbs] : null,
      h('div', { class: 'spacer' }),
      session ? h('span', { class: 'user-chip' }, session.user.email) : null,
      session ? h('button', { class: 'btn ghost small', onclick: signOut }, 'Sign out') : null);
  }
  function show(...nodes) { app.replaceChildren(...nodes); window.scrollTo(0, 0); delete app.dataset.trip; }
  function loading() { show(topbar(), h('div', { class: 'loading' }, 'Loading…')); }

  /* ───────────── sign in ───────────── */
  function signInView(notice) {
    let sending = false;
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', required: true,
      value: localStorage.getItem('suitcase:lastEmail') || '' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Email me a sign-in link');
    const err = h('div', { class: 'notice warn hidden' });
    const form = h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault();
      if (sending) return;
      const addr = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(addr)) { err.textContent = 'That doesn\'t look like an email address.'; err.classList.remove('hidden'); return; }
      sending = true; btn.disabled = true; btn.textContent = 'Sending…'; err.classList.add('hidden');
      const { error } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: location.origin + location.pathname } });
      sending = false; btn.disabled = false; btn.textContent = 'Email me a sign-in link';
      if (error) {
        err.textContent = /rate|seconds|too many/i.test(error.message)
          ? 'Too many sign-in emails just now. Wait a minute and try again.' : errText(error);
        err.classList.remove('hidden'); return;
      }
      localStorage.setItem('suitcase:lastEmail', addr);
      sentView(addr);
    } },
      h('label', { class: 'field' }, h('span', null, 'Email'), email), err, btn);
    show(h('div', { class: 'signin' }, h('div', { class: 'signin-card' },
      h('div', { class: 'brand' }, svg(ICON.suitcase), 'Suitcase'),
      h('h1', null, 'Plan your trips'),
      h('p', null, 'Sign in with your email. We\'ll send you a link, no password needed.'),
      notice ? h('div', { class: 'notice warn' }, notice) : null,
      form,
      h('div', { class: 'signin-note' }, 'New here? The same link creates your account.'))));
    setTimeout(() => email.focus(), 30);
  }
  function sentView(addr) {
    let wait = 60;
    const resend = h('button', { class: 'btn', disabled: true }, 'Resend in 60 s');
    const tick = setInterval(() => {
      wait--; if (!document.body.contains(resend)) return clearInterval(tick);
      if (wait <= 0) { clearInterval(tick); resend.disabled = false; resend.textContent = 'Resend link'; }
      else resend.textContent = 'Resend in ' + wait + ' s';
    }, 1000);
    resend.onclick = async () => {
      resend.disabled = true;
      const { error } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) { toast(errText(error), true); resend.disabled = false; } else { toast('Sent again'); sentView(addr); }
    };
    show(h('div', { class: 'signin' }, h('div', { class: 'signin-card' },
      h('div', { class: 'sent-icon' }, svg(ICON.mail)),
      h('h1', null, 'Check your email'),
      h('p', null, 'We sent a sign-in link to ', h('strong', null, addr), '. Open it on this computer and you\'re in.'),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => signInView() }, 'Use a different email'), resend),
      h('div', { class: 'signin-note' }, 'Not there? Check spam. The link works once and expires after an hour.'))));
  }
  async function signOut() {
    await sb.auth.signOut();
    tripData = null; location.hash = '#/';
  }

  /* ───────────── My trips ───────────── */
  async function tripsView() {
    loading();
    const [t, p, d] = await Promise.all([
      sb.from('trips').select('*').order('start_date', { ascending: true, nullsFirst: false }),
      sb.from('phases').select('id, trip_id, colour, sort'),
      sb.from('days').select('trip_id, phase_id')
    ]);
    const err = t.error || p.error || d.error;
    if (err) { show(topbar(), h('main', null, h('div', { class: 'notice warn' }, 'Couldn\'t load your trips: ' + errText(err)))); return; }
    const trips = t.data, today = todayIso();
    const stripFor = trip => {
      const days = d.data.filter(x => x.trip_id === trip.id);
      const counts = {};
      days.forEach(x => { counts[x.phase_id || ''] = (counts[x.phase_id || ''] || 0) + 1; });
      const ph = p.data.filter(x => x.trip_id === trip.id);
      return h('div', { class: 'strip' }, Object.keys(counts).filter(Boolean).map(id => {
        const phase = ph.find(x => x.id === id);
        return h('span', { style: { flex: counts[id], background: (phase && phase.colour) || '#C9C9C9' } });
      }), counts[''] ? h('span', { style: { flex: counts[''], background: 'transparent' } }) : null);
    };
    const card = trip => {
      const total = trip.length_days;
      let kicker, pill = null;
      if (!trip.start_date) kicker = 'No dates yet';
      else if (today < trip.start_date) { const n = diffDays(today, trip.start_date); kicker = n === 1 ? 'Tomorrow' : 'In ' + n + ' days'; }
      else if (today <= trip.end_date) { kicker = 'Day ' + (diffDays(trip.start_date, today) + 1) + ' of ' + total; pill = h('span', { class: 'pill now dot' }, 'On the trip'); }
      else kicker = 'Finished';
      const phaseCount = p.data.filter(x => x.trip_id === trip.id).length;
      return h('a', { class: 'trip-card', href: '#/trip/' + trip.id },
        stripFor(trip),
        h('div', { class: 'body' },
          h('div', { class: 'kicker' }, kicker),
          h('div', { class: 'name' }, trip.name),
          h('div', { class: 'dates' }, trip.start_date ? range(trip.start_date, trip.end_date) : plural(total, 'day') + ' · dates open'),
          h('div', { class: 'foot' }, pill, h('span', { class: 'pill' }, plural(total, 'day')),
            phaseCount ? h('span', { class: 'pill' }, plural(phaseCount, 'phase')) : null)));
    };
    const live = trips.filter(x => !x.archived && (!x.end_date || x.end_date >= today));
    const past = trips.filter(x => !x.archived && x.end_date && x.end_date < today).reverse();
    const archived = trips.filter(x => x.archived);
    const newCard = h('button', { class: 'new-card', onclick: newTripModal }, h('span', { class: 'plus' }, svg(ICON.plus)), 'New trip');

    let body;
    if (!trips.length) {
      body = h('div', { class: 'empty' }, h('div', { class: 'art' }, svg(ICON.map)),
        h('h2', null, 'Your first trip starts here'),
        h('p', null, 'Give it a name and dates. You can add phases, places and bookings after.'),
        h('button', { class: 'btn primary', onclick: newTripModal }, svg(ICON.plus), 'New trip'));
    } else {
      body = [
        h('div', { class: 'trip-grid' }, live.map(card), newCard),
        past.length ? [h('div', { class: 'section-label' }, 'Past trips'), h('div', { class: 'trip-grid' }, past.map(card))] : null,
        archived.length ? h('details', { class: 'archived' },
          h('summary', { class: 'section-label' }, 'Archived · ' + archived.length),
          h('div', { class: 'trip-grid' }, archived.map(card))) : null
      ];
    }
    show(topbar(), h('main', null,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My trips'),
        trips.length ? h('div', { class: 'sub' }, plural(live.length, 'trip') + ' coming up') : null),
        h('div', { class: 'spacer' }),
        trips.length ? h('button', { class: 'btn primary', onclick: newTripModal }, svg(ICON.plus), 'New trip') : null),
      body));
  }

  // New trip pop-up (wireframe frames 2–3). "Not yet" = a length only; "Yes, I do" = start date + length.
  const ROUGH = [['weekend', 'Weekend', 3], ['w1', '1 week', 7], ['w2', '2 weeks', 14], ['w3', '3 weeks', 21]];
  function newTripModal() {
    const st = { mode: 'rough', unit: 'w1', months: 1, start: '', len: 21 };
    modal((box, close) => {
      box.classList.add('newtrip');
      const err = h('div', { class: 'notice warn hidden' });
      const name = h('input', { class: 'input big-name', placeholder: 'Name your trip', maxlength: 80, 'aria-label': 'Trip name', oninput: () => err.classList.add('hidden') });
      const body = h('div');
      const create = h('button', { class: 'btn primary', type: 'submit' }, 'Start planning →');
      const lengthOf = () => st.mode === 'exact' ? st.len : st.unit === 'month' ? st.months * 30 : ROUGH.find(r => r[0] === st.unit)[2];
      const seg = (key, label) => h('button', { type: 'button', class: 'seg-btn' + (st.mode === key ? ' on' : ''), 'aria-pressed': String(st.mode === key),
        onclick: () => { st.mode = key; draw(); if (key === 'exact' && name.value.trim()) body.querySelector('input[type=date]').focus(); } }, label);
      const stepper = (val, label, onMinus, onPlus, minusOff, plusOff) => h('span', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'Less', disabled: minusOff, onclick: e => { e.stopPropagation(); onMinus(); } }, '–'),
        h('strong', null, label), h('button', { type: 'button', 'aria-label': 'More', disabled: plusOff, onclick: e => { e.stopPropagation(); onPlus(); } }, '+'));
      function draw() {
        let inner;
        if (st.mode === 'rough') {
          inner = h('div', { class: 'len-pills' },
            ROUGH.map(r => h('button', { type: 'button', class: 'len-pill' + (st.unit === r[0] ? ' on' : ''), 'aria-pressed': String(st.unit === r[0]),
              onclick: () => { st.unit = r[0]; draw(); } }, r[1])),
            st.unit === 'month'
              ? h('span', { class: 'len-pill on months' }, stepper(st.months, plural(st.months, 'month'),
                  () => { st.months = Math.max(1, st.months - 1); draw(); }, () => { st.months = Math.min(24, st.months + 1); draw(); }, st.months <= 1, st.months >= 24))
              : h('button', { type: 'button', class: 'len-pill', 'aria-pressed': 'false', onclick: () => { st.unit = 'month'; draw(); } }, 'Months'));
        } else {
          const date = h('input', { class: 'input', type: 'date', value: st.start, 'aria-label': 'Start date', oninput: e => { st.start = e.target.value; back.textContent = backText(); err.classList.add('hidden'); } });
          const back = h('div', { class: 'back-on' });
          const backText = () => st.start ? 'Back on ' + new Date(Date.UTC(...st.start.split('-').map((v, i) => i === 1 ? v - 1 : +v)) + (st.len - 1) * 864e5)
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
          back.textContent = backText();
          inner = h('div', null, h('div', { class: 'exact-row' }, h('span', null, 'Starting'), date, h('span', null, 'for'),
            stepper(st.len, plural(st.len, 'day'), () => { st.len = Math.max(1, st.len - 1); draw(); }, () => { st.len = Math.min(MAX_DAYS, st.len + 1); draw(); }, st.len <= 1, st.len >= MAX_DAYS)), back);
        }
        body.replaceChildren(
          h('div', { class: 'q' }, 'Do you know your dates yet?'),
          h('div', { class: 'seg' }, seg('rough', 'Not yet'), seg('exact', 'Yes, I do')),
          inner,
          h('div', { class: 'hint' }, 'You can change all of this later.'));
      }
      draw();
      box.append(h('h2', null, 'New trip'),
        h('form', { novalidate: true, onsubmit: async ev => {
          ev.preventDefault();
          if (!name.value.trim()) { name.focus(); err.textContent = 'Give your trip a name.'; err.classList.remove('hidden'); return; }
          if (st.mode === 'exact' && !st.start) { body.querySelector('input[type=date]').focus(); err.textContent = 'Pick a start date, or choose "Not yet".'; err.classList.remove('hidden'); return; }
          err.classList.add('hidden');
          create.disabled = true; create.textContent = 'Creating…';
          const { data, error } = await sb.from('trips')
            .insert({ name: name.value.trim(), start_date: st.mode === 'exact' ? st.start : null, length_days: lengthOf(), owner_id: session.user.id })
            .select().single();
          if (error) { err.textContent = errText(error); err.classList.remove('hidden'); create.disabled = false; create.textContent = 'Start planning →'; return; }
          close(); location.hash = '#/trip/' + data.id;
        } },
          name, body, err,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), create),
          h('div', { class: 'import-row' }, h('div', null, h('strong', null, 'Already have a plan? Import it'), h('span', { class: 'soon-tag' }, 'Soon')),
            h('div', { class: 'muted' }, 'Paste a Google Sheet or website link and we\'ll fill in your days, places and phases.'))));
    });
  }

  /* ───────────── trip page ───────────── */
  async function loadTrip(id) {
    const [t, d, p] = await Promise.all([
      sb.from('trips').select('*').eq('id', id).maybeSingle(),
      sb.from('days').select('*').eq('trip_id', id).order('idx', { ascending: true }),
      sb.from('phases').select('*').eq('trip_id', id).order('sort', { ascending: true })
    ]);
    const err = t.error || d.error || p.error;
    if (err) throw err;
    if (!t.data) return null;
    datesFor(t.data, d.data);
    return { trip: t.data, days: d.data, phases: p.data };
  }
  // Each day's date (only on the client): the trip's start date + its position. None while the trip has no dates.
  function datesFor(trip, days) {
    days.forEach(d => { d.date = LAYOUT.dateAt(trip.start_date, d.idx); });
  }

  async function tripView(id, tab) {
    if (!tripData || tripData.trip.id !== id) {
      loading(); editingDates = false; settingStart = false;
      try { tripData = await loadTrip(id); }
      catch (e) { show(topbar(), h('main', null, h('div', { class: 'notice warn' }, 'Couldn\'t load this trip: ' + errText(e)))); return; }
      if (!tripData) {
        show(topbar(), h('main', null, h('div', { class: 'empty' }, h('h2', null, 'Trip not found'),
          h('p', null, 'It may have been deleted, or it belongs to someone else.'),
          h('a', { class: 'btn primary', href: '#/' }, 'Back to My trips'))));
        return;
      }
    }
    renderTrip(tab);
  }

  const phaseById = id => tripData.phases.find(p => p.id === id);
  const pname = p => (p && p.name) || 'Unnamed phase';
  function phaseSpan(phase) {
    const days = tripData.days.filter(d => d.phase_id === phase.id);
    if (!days.length) return null;
    return { start: days[0].date, end: days[days.length - 1].date, first: days[0].idx, last: days[days.length - 1].idx, n: days.length };
  }
  function orderedPhases() {
    return tripData.phases.slice().sort((a, b) => {
      const sa = phaseSpan(a), sb2 = phaseSpan(b);
      if (sa && sb2 && sa.first !== sb2.first) return sa.first - sb2.first;
      if (sa && !sb2) return -1;
      if (!sa && sb2) return 1;
      return (a.sort || 0) - (b.sort || 0);
    });
  }
  const dot = c => 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="' + (c || '#C9C9C9') + '"/></svg>') + '")';

  function renderTrip(tab) {
    // Redrawing the same trip keeps the page (and the phase columns) where they were scrolled to.
    const same = app.dataset.trip === tripData.trip.id && app.dataset.tab === tab;
    const sy = window.scrollY, pm = document.querySelector('.planner-main'), sx = pm ? pm.scrollLeft : 0;
    drawTrip(tab);
    app.dataset.trip = tripData.trip.id; app.dataset.tab = tab;
    if (same) { window.scrollTo(0, sy); const pm2 = document.querySelector('.planner-main'); if (pm2) pm2.scrollLeft = sx; }
  }
  function drawTrip(tab) {
    const { trip, days } = tripData;
    const total = days.length, today = todayIso();
    let when;
    if (!trip.start_date) when = 'No dates yet';
    else if (today < trip.start_date) { const n = diffDays(today, trip.start_date); when = n === 1 ? 'Starts tomorrow' : 'Starts in ' + n + ' days'; }
    else if (today <= trip.end_date) when = 'Day ' + (diffDays(trip.start_date, today) + 1) + ' today';
    else when = 'Finished';

    const menuBox = h('div', { class: 'menu hidden' },
      h('button', { onclick: () => { hideMenu(); renameModal(); } }, 'Rename'),
      h('button', { onclick: () => { hideMenu(); toggleArchive(); } }, trip.archived ? 'Unarchive' : 'Archive'),
      h('hr'),
      h('button', { class: 'danger', onclick: () => { hideMenu(); deleteTrip(); } }, 'Delete trip'));
    const hideMenu = () => menuBox.classList.add('hidden');
    const menuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Trip menu', onclick: e => { e.stopPropagation(); menuBox.classList.toggle('hidden'); } }, svg(ICON.more));
    document.onclick = () => { hideMenu(); if (openMenu) { openMenu = null; document.querySelectorAll('.pmenu').forEach(m => m.classList.add('hidden')); } };

    const counts = [];
    days.forEach(d => { const last = counts[counts.length - 1]; if (last && last.id === (d.phase_id || '')) last.n++; else counts.push({ id: d.phase_id || '', n: 1 }); });
    const used = orderedPhases().filter(p => phaseSpan(p));



    show(topbar([h('a', { class: 'crumb', href: '#/' }, 'My trips'), h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'crumb-current' }, trip.name)]),
      h('main', null,
        h('div', { class: 'trip-head' },
          h('div', null, h('h1', null, trip.name),
            h('div', { class: 'sub' }, h('span', { class: 'meta' }, metaText(trip)),
              editingDates ? null : h('button', { class: 'link-btn', onclick: () => { editingDates = true; renderTrip(currentTab()); } }, 'Edit dates'),
              trip.start_date ? h('span', { class: 'pill' + (when.startsWith('Day') ? ' now dot' : '') }, when) : null,
              trip.archived ? h('span', { class: 'pill' }, 'Archived') : null),
            editingDates ? datesEditor() : null,
            trip.subtitle ? h('div', { class: 'muted', style: { marginTop: '4px' } }, trip.subtitle) : null),
          h('div', { class: 'spacer' }),
          h('div', { class: 'menu-wrap' }, menuBtn, menuBox)),
        used.length && tab !== 'planner' ? [
          h('div', { class: 'phase-bar', 'aria-hidden': 'true' }, counts.map(c => {
            const p = c.id && phaseById(c.id);
            return h('span', { style: { flex: c.n, background: p ? p.colour || '#C9C9C9' : 'transparent' }, title: p ? pname(p) : '' });
          }))
        ] : null,
        tab === 'planner' ? plannerTab() : itineraryTab()),
      bottomNav(trip, tab));
  }

  /* ───────────── Itinerary tab ───────────── */
  let saveState;
  function setSave(state, text) {
    if (!saveState) return;
    saveState.className = 'save-state ' + state;
    saveState.textContent = text;
  }
  let pending = 0;
  async function saveDays(rows) {
    pending++; setSave('saving', 'Saving…');
    const { error } = await sb.from('days').upsert(rows, { onConflict: 'id' });
    pending--;
    if (error) { setSave('error', 'Not saved'); toast('Couldn\'t save: ' + errText(error), true); return false; }
    if (!pending) setSave('saved', 'All changes saved');
    return true;
  }
  // Save one or two fields of a day (the Planner's typing). Never touches its position or phase.
  async function saveDayField(id, patch) {
    pending++; setSave('saving', 'Saving…');
    const { error } = await sb.from('days').update(patch).eq('id', id);
    pending--;
    if (error) { setSave('error', 'Not saved'); toast('Couldn\'t save: ' + errText(error), true); return false; }
    if (!pending) setSave('saved', 'All changes saved');
    return true;
  }
  const dayRow = d => ({ id: d.id, trip_id: d.trip_id, idx: d.idx, phase_id: d.phase_id || null,
    location: d.location || null, plan: d.plan || null, notes: d.notes || null });

  // Itinerary (wireframe frames 8–9): every day in a sheet-like grid, grouped by phase.
  function itineraryTab() {
    const L = currentLayout(), t = tripData.trip;
    saveState = h('span', { class: 'save-state' });
    const shortDay = idx => (t.start_date ? md(LAYOUT.dateAt(t.start_date, idx)) : 'Day ' + (idx + 1));
    const span = (a, b) => (a === b ? shortDay(a) : shortDay(a) + ' – ' + shortDay(b));

    if (!L.phases.length) {
      return h('section', { class: 'itin-empty' },
        h('h2', null, 'Nothing on the itinerary yet'),
        h('p', null, plural(t.length_days, 'day') + (t.start_date ? ' · ' + span(0, t.length_days - 1) : ' · no dates yet')),
        h('div', { class: 'ghosts', 'aria-hidden': 'true' }, [0.6, 0.45, 0.3].map((o, k) => h('div', { class: 'ghost', style: { opacity: o } },
          h('span', { class: 'g-box' }), h('span', { class: 'g-bar', style: { width: [70, 55, 62][k] + '%' } }), h('span', { class: 'g-bar', style: { width: [85, 65, 40][k] + '%' } })))),
        h('a', { class: 'btn primary', href: '#/trip/' + t.id }, 'Start planning'),
        h('div', { class: 'muted', style: { marginTop: '10px', fontSize: '13px' } }, 'Your days show up here as soon as they\'re in a phase.'));
    }

    const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    const timers = {};
    const fieldSave = (row, field, ta, now) => {
      clearTimeout(timers[row.id + field]);
      const run = () => {
        const v = ta.value.replace(/\s+$/, '') || null;
        if ((row[field] || null) === v) return;
        row[field] = v; saveDayField(row.id, { [field]: v });
      };
      if (now) run(); else { setSave('saving', 'Editing…'); timers[row.id + field] = setTimeout(run, 700); }
    };

    const body = h('tbody');
    const order = [];            // day rows in screen order, for multi-row paste
    const boxes = {};            // `${order index}:${field}` -> textarea
    L.phases.forEach((p, i) => {
      const start = LAYOUT.startIdx(L, i), n = p.days.length;
      const name = h('input', { class: 'gname', value: p.name || '', placeholder: LAYOUT.suggestion(i), maxlength: 60, 'aria-label': 'Phase ' + (i + 1) + ' name' });
      name.addEventListener('change', async () => {
        const v = name.value.trim() || null, row = tripData.phases.find(x => x.id === p.id);
        if (row) row.name = v;
        addBtn.textContent = '+ Add a day to ' + (v || LAYOUT.suggestion(i));
        const { error } = await sb.from('phases').update({ name: v }).eq('id', p.id);
        if (error) toast('Couldn\'t save the name: ' + errText(error), true);
      });
      name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
      const addBtn = h('button', { class: 'add-row-btn', onclick: () => tryLayout(LAYOUT.addDayToPhase(currentLayout(), i)) }, '+ Add a day to ' + LAYOUT.nameOf(L, i));
      body.append(h('tr', { class: 'ghead', 'data-phase': p.id }, h('td', { colspan: 4 }, h('div', { class: 'ghead-in' },
        h('i', { class: 'pdot', style: { background: p.colour || '#C9C9C9' } }), name, h('span', { class: 'gspan' }, span(start, start + n - 1) + ' · ' + plural(n, 'day'))))));
      p.days.forEach((d, j) => {
        const idx = start + j, row = tripData.days.find(x => x.id === d.id), date = LAYOUT.dateAt(t.start_date, idx), k = order.length;
        order.push(row);
        const cells = DAY_FIELDS.map((f, c) => {
          const ta = h('textarea', { class: 'edit' + (f === 'location' ? ' loc' : ''), rows: 1, spellcheck: f !== 'location',
            'aria-label': f[0].toUpperCase() + f.slice(1) + ' for ' + shortDay(idx), placeholder: f === 'location' ? 'Where are you?' : '' });
          ta.value = row[f] || '';
          boxes[k + ':' + f] = ta;
          ta.addEventListener('input', () => { autosize(ta); fieldSave(row, f, ta, false); });
          ta.addEventListener('blur', () => fieldSave(row, f, ta, true));
          ta.addEventListener('keydown', e => { if (e.key === 'Escape') ta.blur(); });
          ta.addEventListener('paste', e => pasteRows(e, k, c));
          return h('td', { class: f === 'notes' ? 'notes-col' : null }, ta);
        });
        body.append(h('tr', { 'data-id': d.id, class: date && date === todayIso() ? 'today' : null },
          h('td', null, h('div', { class: 'dtile' }, date ? [h('span', null, wd(date).toUpperCase()), h('strong', null, pd(date).getUTCDate())] : [h('span', null, 'DAY'), h('strong', null, idx + 1)])),
          ...cells));
      });
      body.append(h('tr', { class: 'addrow' }, h('td', null), h('td', { colspan: 3 }, addBtn)));
    });

    // Several rows copied from a spreadsheet: fill down from this cell (and across Location → Plan → Notes).
    function pasteRows(e, k, c) {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;   // a single value: normal paste
      e.preventDefault();
      const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
      const changed = new Map();
      lines.forEach((line, r) => {
        const row = order[k + r]; if (!row) return;
        line.split('\t').forEach((val, cc) => {
          const field = DAY_FIELDS[c + cc]; if (!field) return;
          row[field] = val.trim() || null;
          const box = boxes[(k + r) + ':' + field];
          if (box) { box.value = row[field] || ''; autosize(box); }
          changed.set(row.id, Object.assign(changed.get(row.id) || {}, { [field]: row[field] }));
        });
      });
      const skipped = Math.max(0, k + lines.length - order.length);
      Promise.all([...changed].map(([id, patch]) => saveDayField(id, patch))).then(oks => {
        if (oks.every(Boolean)) toast('Pasted into ' + plural(changed.size, 'day') + (skipped ? ' · ' + plural(skipped, 'row') + ' past the last planned day left out' : ''));
      });
    }

    let free = null;
    if (L.free.length) {
      const fs = LAYOUT.startIdx(L, L.phases.length);
      free = h('div', { class: 'freebox' },
        h('div', null, h('strong', null, plural(L.free.length, 'more day') + ' to plan'), h('div', { class: 'muted' }, span(fs, fs + L.free.length - 1) + ' · not in a phase yet')),
        h('button', { class: 'btn primary', onclick: () => {
          if (tryLayout(LAYOUT.insertPhaseAt(currentLayout(), currentLayout().phases.length, 1)))
            setTimeout(() => { const all = document.querySelectorAll('.gname'); if (all.length) all[all.length - 1].focus(); }, 30);
        } }, '+ Add new phase'));
    }

    const table = h('table', { class: 'itin grouped' },
      h('colgroup', null, h('col', { class: 'c-tile' }), h('col', { class: 'c-loc' }), h('col'), h('col', { class: 'c-notes' })),
      h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Location'), h('th', null, 'Plan'), h('th', { class: 'notes-col' }, 'Notes'))), body);
    requestAnimationFrame(() => body.querySelectorAll('textarea').forEach(autosize));
    return h('section', { class: 'itin-wrap' },
      h('div', { class: 'grid-tools' }, h('span', { class: 'muted' }, 'Paste rows from a spreadsheet into Location, Plan or Notes.'), h('div', { class: 'spacer' }), saveState),
      h('div', { class: 'itin-card' }, table, free));
  }

  /* ───────────── Planner tab (wireframe frames 4–7) ─────────────
     The trip as phases (columns) + days not planned yet (the tray). Structural changes go through layout.js and
     apply_layout() in one call, with an Undo toast; typing in a day saves that day only. */
  const PLACEHOLDER_IDEAS = ['Patagonia', 'Tuscany', 'Kyoto', 'the Dolomites', 'Pacific Coast Highway'];
  let layoutQueue = Promise.resolve();
  let typeTimer = null;
  let barHover = null;      // free-day index hovered in the trip bar or tray
  let openMenu = null;      // phase id whose ••• menu is open

  function currentLayout() { return LAYOUT.fromRows(tripData.phases, tripData.days); }

  // Put a layout into tripData (so the screen updates at once) and save it with apply_layout().
  function commitLayout(next, msg, opts) {
    opts = opts || {};
    const prev = currentLayout();
    const t = tripData.trip, tripId = t.id;
    const rows = LAYOUT.toRows(next);
    const oldPhases = tripData.phases;
    tripData.phases = rows.phases.map(p => Object.assign({}, oldPhases.find(o => o.id === p.id) || {}, p, { trip_id: tripId }));
    tripData.days = rows.days.map(d => Object.assign({ trip_id: tripId }, d));
    t.length_days = tripData.days.length;
    t.end_date = t.start_date ? LAYOUT.dateAt(t.start_date, t.length_days - 1) : null;
    datesFor(t, tripData.days);
    renderTrip(currentTab());
    layoutQueue = layoutQueue.then(async () => {
      if (!tripData || tripData.trip.id !== tripId) return;
      setSave('saving', 'Saving…');
      const { data, error } = await sb.rpc('apply_layout', { p_trip: tripId, p_expect: tripData.trip.updated_at, p_phases: rows.phases, p_days: rows.days });
      if (error) {
        setSave('error', 'Not saved');
        if (/LAYOUT_CHANGED/.test(error.message)) {
          toast('This trip was changed somewhere else, so it was reloaded.', true);
          tripData = null; tripView(tripId, currentTab());
        } else {
          toast('Couldn\'t save: ' + errText(error), true);
          commitLayout(prev, '', { quiet: true, noUndo: true });
        }
        return;
      }
      tripData.trip.updated_at = data;
      setSave('saved', 'All changes saved');
    });
    if (!opts.quiet && msg) toast(msg, false, opts.noUndo ? null : () => commitLayout(prev, 'Undone', { noUndo: true }));
  }
  function tryLayout(res) {
    if (res.error) { toast(res.error, true); return null; }
    commitLayout(res.layout, res.msg);
    return res;
  }

  function plannerTab() {
    const L = currentLayout(), t = tripData.trip;
    const dateAt = idx => LAYOUT.dateAt(t.start_date, idx);
    const shortDay = idx => (t.start_date ? md(dateAt(idx)) : 'Day ' + (idx + 1));
    const span = (a, b) => (a === b ? shortDay(a) : shortDay(a) + ' – ' + shortDay(b));
    const freeStart = L.phases.reduce((a, p) => a + p.days.length, 0);
    saveState = h('span', { class: 'save-state saved' }, 'All changes saved');
    const newPhaseUpTo = k => tryLayout(LAYOUT.insertPhaseAt(currentLayout(), currentLayout().phases.length, k + 1));
    const nameFocus = i => setTimeout(() => { const el = document.querySelectorAll('.pcol .pname')[i]; if (el) el.focus(); }, 30);

    /* trip bar */
    const bar = h('div', { class: 'tripbar' });
    const hintText = L.free.length ? 'Drag a phase\'s right edge to change its length · drag a phase to reorder · click a free day to start a new phase' : 'Drag a phase\'s right edge to change its length · drag a phase to reorder';
    const hint = h('div', { class: 'tripbar-hint' }, L.phases.length || !L.free.length ? hintText : 'Click a day to start your first phase there');
    L.phases.forEach((p, i) => {
      const block = h('div', { class: 'tb-phase', style: { flex: p.days.length, background: p.colour || '#C9C9C9' }, title: LAYOUT.nameOf(L, i) },
        h('span', { class: 'tb-label' }, LAYOUT.nameOf(L, i) + ' · ' + p.days.length),
        h('span', { class: 'tb-edge', title: 'Drag to change the length' }));
      block.addEventListener('pointerdown', e => barDrag(e, i, block, bar, L));
      bar.append(block);
    });
    if (L.free.length) {
      const free = h('div', { class: 'tb-free', style: { flex: L.free.length } });
      L.free.forEach((d, k) => free.append(h('button', { class: 'tb-day' + (barHover !== null && k <= barHover ? ' hot' : ''), 'aria-label': 'New phase up to ' + shortDay(freeStart + k),
        onmouseenter: () => { barHover = k; paintHover(); }, onmouseleave: () => { barHover = null; paintHover(); },
        onclick: () => { barHover = null; if (newPhaseUpTo(k)) nameFocus(L.phases.length); } })));
      free.append(h('span', { class: 'tb-free-label' }, plural(L.free.length, 'more day') + ' to plan'));
      bar.append(free);
    }
    const tip = h('div', { class: 'tb-tip hidden' });
    function paintHover() {
      document.querySelectorAll('.tb-day').forEach((el, k) => el.classList.toggle('hot', barHover !== null && k <= barHover));
      document.querySelectorAll('.tray-day').forEach((el, k) => el.classList.toggle('hot', barHover !== null && k <= barHover));
      const th = document.querySelector('.tray-hint');
      if (barHover === null) { hint.textContent = L.phases.length || !L.free.length ? hintText : 'Click a day to start your first phase there'; hint.classList.remove('hot'); if (th) th.textContent = trayHint; }
      else {
        hint.textContent = '+ New phase · ' + plural(barHover + 1, 'day') + ' · ' + span(freeStart, freeStart + barHover); hint.classList.add('hot');
        if (th) th.textContent = span(freeStart, freeStart + barHover) + ' · click to plan up to here';
        const tt = document.querySelector('.tray-title.empty-title');
        if (tt) tt.textContent = 'Let\'s plan the first ' + plural(barHover + 1, 'day');
      }
      if (barHover === null) { const tt = document.querySelector('.tray-title.empty-title'); if (tt) tt.textContent = 'Let\'s plan the first few days'; }
    }

    /* tray: days not in a phase yet */
    const trayHint = L.phases.length ? 'Click the day your next phase ends' : 'Pick a day — we\'ll plan your first steps up to there';
    let tray = null;
    if (L.free.length) {
      const CAP = 42, shown = L.free.slice(0, CAP);
      tray = h('aside', { class: 'tray' + (L.phases.length ? '' : ' alone') },
        L.phases.length ? h('div', { class: 'tray-title' }, plural(L.free.length, 'more day') + ' to plan')
                        : h('div', { class: 'tray-title empty-title' }, 'Let\'s plan the first few days'),
        h('div', { class: 'tray-hint' }, trayHint),
        h('div', { class: 'tray-grid' }, shown.map((d, k) => {
          const idx = freeStart + k;
          return h('button', { class: 'tray-day', 'aria-label': 'Plan up to ' + shortDay(idx),
            onmouseenter: () => { barHover = k; paintHover(); }, onmouseleave: () => { barHover = null; paintHover(); },
            onclick: () => { barHover = null; if (newPhaseUpTo(k)) nameFocus(L.phases.length); } },
            t.start_date ? [h('span', { class: 'wd' }, wd(dateAt(idx)).toUpperCase()), h('strong', null, pd(dateAt(idx)).getUTCDate())]
                         : [h('span', { class: 'wd' }, 'DAY'), h('strong', null, idx + 1)]);
        }), L.free.length > CAP ? h('span', { class: 'tray-more' }, '+ ' + (L.free.length - CAP) + ' more') : null));
    }

    /* phase columns */
    let cols = null;
    if (L.phases.length) {
      cols = h('div', { class: 'phasecard' }, L.phases.map((p, i) => phaseColumn(L, p, i, { shortDay, span })));
    }

    clearInterval(typeTimer);
    let tick = 0;
    typeTimer = setInterval(() => {
      const inputs = document.querySelectorAll('.pcol .pname');
      if (!inputs.length) return clearInterval(typeTimer);
      tick++;
      inputs.forEach((el, i) => { if (!el.value) el.placeholder = typedPlaceholder(i, tick); });
    }, 90);

    return h('section', { class: 'planner' },
      h('div', { class: 'planner-top' }, h('div', { class: 'tripbar-wrap' }, bar, tip), h('div', { class: 'planner-meta' }, hint, saveState)),
      h('div', { class: 'planner-main' + (L.phases.length ? '' : ' no-phases') }, cols, tray));
  }

  // "First area to explore", then example regions, typed out one letter at a time.
  function typedPlaceholder(i, tick) {
    const words = [LAYOUT.suggestion(i)].concat(PLACEHOLDER_IDEAS.map(w => 'e.g. ' + w));
    const lives = words.map(w => w.length + 18);      // type it out, hold, then the next one
    let n = tick % lives.reduce((a, b) => a + b, 0);
    for (let k = 0; k < words.length; k++) {
      if (n < lives[k]) return words[k].slice(0, Math.min(words[k].length, n + 1));
      n -= lives[k];
    }
    return words[0];
  }

  function phaseColumn(L, p, i, fmt) {
    const start = LAYOUT.startIdx(L, i), n = p.days.length;
    const name = h('input', { class: 'pname', value: p.name || '', placeholder: LAYOUT.suggestion(i), maxlength: 60, 'aria-label': 'Phase ' + (i + 1) + ' name' });
    name.addEventListener('change', async () => {
      const v = name.value.trim() || null;
      const row = tripData.phases.find(x => x.id === p.id);
      if (row) row.name = v;
      const { error } = await sb.from('phases').update({ name: v }).eq('id', p.id);
      if (error) toast('Couldn\'t save the name: ' + errText(error), true);
      else document.querySelectorAll('.tb-phase .tb-label')[i] && (document.querySelectorAll('.tb-phase .tb-label')[i].textContent = (v || LAYOUT.suggestion(i)) + ' · ' + n);
    });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });

    const menu = h('div', { class: 'menu pmenu' + (openMenu === p.id ? '' : ' hidden') },
      h('button', { disabled: i === 0, onclick: () => { openMenu = null; tryLayout(LAYOUT.movePhase(currentLayout(), i, i - 1)); } }, 'Move left'),
      h('button', { disabled: i === L.phases.length - 1, onclick: () => { openMenu = null; tryLayout(LAYOUT.movePhase(currentLayout(), i, i + 1)); } }, 'Move right'),
      h('button', { onclick: () => { openMenu = null; colourPhotoModal(p.id); } }, 'Colour & photo…'),
      h('hr'),
      h('button', { class: 'danger', onclick: () => { openMenu = null; tryLayout(LAYOUT.removePhase(currentLayout(), i)); } }, 'Delete phase'));
    const more = h('button', { class: 'icon-btn small', 'aria-label': 'More for ' + LAYOUT.nameOf(L, i), onclick: e => {
      e.stopPropagation(); const open = menu.classList.contains('hidden');
      document.querySelectorAll('.pmenu').forEach(m => m.classList.add('hidden')); menu.classList.toggle('hidden', !open); openMenu = open ? p.id : null; } }, svg(ICON.more));

    const days = p.days.map((d, j) => dayCard(L, p, i, j, start + j, fmt));
    return h('section', { class: 'pcol', 'data-phase': p.id },
      h('div', { class: 'pcol-head' }, h('i', { class: 'pdot', style: { background: p.colour || '#C9C9C9' } }), name, h('div', { class: 'menu-wrap' }, more, menu)),
      h('div', { class: 'pcol-info' }, plural(n, 'day') + ' · ' + fmt.span(start, start + n - 1)),
      h('div', { class: 'daylist' }, days,
        h('button', { class: 'add-day', onclick: () => tryLayout(LAYOUT.addDayToPhase(currentLayout(), i)) }, '+ Add a day')));
  }

  function dayCard(L, p, i, j, idx, fmt) {
    const d = p.days[j];
    const row = tripData.days.find(x => x.id === d.id);
    const t = tripData.trip;
    const date = LAYOUT.dateAt(t.start_date, idx);
    const prev = j > 0 ? p.days[j - 1] : null;
    // "↓ Kyoto again": only on the first empty day right after a day with a place
    const again = !d.location && prev && prev.location ? prev.location : null;
    const save = (field, v) => {
      if (!row) return;
      row[field] = v || null;
      clearTimeout(row['_t' + field]); row['_t' + field] = setTimeout(() => saveDayField(row.id, { [field]: v || null }), 500);
    };
    const loc = h('input', { class: 'dloc', value: d.location || '', placeholder: 'Where are you?', 'aria-label': 'Where are you on ' + fmt.shortDay(idx) });
    const plan = h('input', { class: 'dplan', value: d.plan || '', placeholder: 'Start planning', 'aria-label': 'Plan for ' + fmt.shortDay(idx) });
    const planWrap = h('div', { class: d.location ? '' : 'hidden' }, plan);
    loc.addEventListener('input', () => { save('location', loc.value.trim()); planWrap.classList.toggle('hidden', !loc.value.trim()); });
    // When the place changes, redraw (plan field, "↓ … again" hints, phase info) but keep the cursor where the user went.
    let locChanged = false;
    loc.addEventListener('change', () => { locChanged = true; });
    loc.addEventListener('blur', e => {
      if (!locChanged) return;
      const next = e.relatedTarget && e.relatedTarget.getAttribute('aria-label');
      setTimeout(() => { renderTrip(currentTab()); if (next) { const el = document.querySelector('[aria-label="' + next.replace(/"/g, '\\"') + '"]'); if (el) el.focus(); } }, 0);
    });
    plan.addEventListener('input', () => save('plan', plan.value.trim()));
    [loc, plan].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); }));
    return h('div', { class: 'dcard' },
      h('div', { class: 'dtile' }, date ? [h('span', null, wd(date).toUpperCase()), h('strong', null, pd(date).getUTCDate())] : [h('span', null, 'DAY'), h('strong', null, idx + 1)]),
      h('div', { class: 'dbody' }, loc,
        again ? h('button', { class: 'again', onclick: () => { save('location', again); renderTrip(currentTab()); } }, '↓ ' + again + ' again') : null,
        planWrap),
      h('button', { class: 'dx', 'aria-label': 'Remove ' + fmt.shortDay(idx), title: 'Remove this day', onclick: () => tryLayout(LAYOUT.removeDay(currentLayout(), i, j)) }, '×'));
  }

  // Trip bar dragging: the right edge changes a phase's length; the block itself reorders. A click jumps to the column.
  function barDrag(e, i, block, bar, L) {
    if (e.button !== 0) return;
    const edge = e.target.classList.contains('tb-edge');
    const total = LAYOUT.total(L), dayW = bar.getBoundingClientRect().width / total;
    const x0 = e.clientX; let moved = false, delta = 0, target = i;
    const w0 = block.getBoundingClientRect().width;
    block.setPointerCapture(e.pointerId);
    const onMove = ev => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 5) return;
      moved = true;
      if (edge) {
        delta = Math.max(1 - L.phases[i].days.length, Math.round(dx / dayW));
        block.style.flex = 'none'; block.style.width = Math.max(dayW, w0 + delta * dayW) + 'px';
        block.querySelector('.tb-label').textContent = LAYOUT.nameOf(L, i) + ' · ' + (L.phases[i].days.length + delta);
      } else {
        block.style.transform = 'translateX(' + dx + 'px)'; block.classList.add('dragging');
        const blocks = [...bar.querySelectorAll('.tb-phase')];
        const cx = ev.clientX;
        target = blocks.reduce((best, b, k) => { const r = b.getBoundingClientRect(); return cx > r.left + r.width / 2 ? k : best; }, 0);
        if (cx < blocks[0].getBoundingClientRect().left + blocks[0].getBoundingClientRect().width / 2) target = 0;
      }
    };
    const onUp = () => {
      block.removeEventListener('pointermove', onMove); block.removeEventListener('pointerup', onUp);
      if (!moved) {
        const col = document.querySelectorAll('.pcol')[i];
        if (col) col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        return;
      }
      if (edge) { if (delta) tryLayout(LAYOUT.resizePhase(currentLayout(), i, delta)); else renderTrip(currentTab()); }
      else { if (target !== i) tryLayout(LAYOUT.movePhase(currentLayout(), i, target)); else renderTrip(currentTab()); }
    };
    block.addEventListener('pointermove', onMove); block.addEventListener('pointerup', onUp);
  }

  // Colour & photo for a phase (from its ••• menu).
  function colourPhotoModal(phaseId) {
    const p = tripData.phases.find(x => x.id === phaseId);
    if (!p) return;
    modal((box, close) => {
      let colour = (p.colour || '').toUpperCase();
      const sw = h('div', { class: 'cp-swatches' });
      const drawSw = () => sw.replaceChildren(...PALETTE.map(([label, c]) => h('button', { type: 'button', title: label, 'aria-label': label,
        'aria-pressed': String(colour === c), class: colour === c ? 'on' : '', style: { background: c }, onclick: () => { colour = c; drawSw(); } })));
      drawSw();
      const url = h('input', { class: 'input', type: 'url', placeholder: 'https://…', value: p.photo_url || '' });
      const credit = h('input', { class: 'input', placeholder: 'e.g. Photo: Jane Doe / Unsplash', value: p.photo_credit || '' });
      const err = h('div', { class: 'notice warn hidden' });
      box.append(h('h2', null, (p.name || 'Phase') + ' · colour & photo'), h('p', { class: 'lead' }, 'The colour marks this phase everywhere; the photo heads it in Carryon.'),
        h('form', { onsubmit: async e => {
          e.preventDefault();
          const u = url.value.trim();
          if (u && !/^https:\/\//i.test(u)) { err.textContent = 'The photo link has to start with https://'; err.classList.remove('hidden'); return; }
          const patch = { colour: colour || null, photo_url: u || null, photo_credit: credit.value.trim() || null };
          const { error } = await sb.from('phases').update(patch).eq('id', p.id);
          if (error) { err.textContent = errText(error); err.classList.remove('hidden'); return; }
          Object.assign(p, patch); close(); renderTrip(currentTab()); toast('Saved');
        } },
          h('div', { class: 'field' }, h('span', null, 'Colour'), sw),
          h('label', { class: 'field' }, h('span', null, 'Photo link (optional)'), url),
          h('label', { class: 'field' }, h('span', null, 'Photo credit'), credit), err,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
    });
  }

  /* ───────────── trip menu actions ───────────── */
  function renameModal() {
    const t = tripData.trip;
    modal((box, close) => {
      const name = h('input', { class: 'input', value: t.name, maxlength: 80 });
      const sub = h('input', { class: 'input', value: t.subtitle || '', maxlength: 120, placeholder: 'Optional, e.g. "Hiking from Patagonia to Peru"' });
      box.append(h('h2', null, 'Rename trip'), h('p', { class: 'lead' }, 'Shown at the top of Carryon.'),
        h('form', { onsubmit: async e => {
          e.preventDefault();
          if (!name.value.trim()) return name.focus();
          const patch = { name: name.value.trim(), subtitle: sub.value.trim() || null };
          const { error } = await sb.from('trips').update(patch).eq('id', t.id);
          if (error) return toast(errText(error), true);
          Object.assign(t, patch); close(); renderTrip(currentTab());
        } }, h('label', { class: 'field' }, h('span', null, 'Name'), name), h('label', { class: 'field' }, h('span', null, 'Subtitle'), sub),
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
    });
  }

  /* ───────────── trip dates (header "Edit dates") ───────────── */
  let editingDates = false;
  const longDate = iso => pd(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  function metaText(t) {
    if (!t.start_date) return plural(t.length_days, 'day') + ' · no dates yet';
    return longDate(t.start_date) + ' – ' + longDate(t.end_date) + ', ' + pd(t.end_date).getUTCFullYear() + ' · ' + plural(t.length_days, 'day');
  }
  // Save a change to the trip's start date / length, reload its days, show msg (with Undo when undoPatch is given).
  async function patchTrip(patch, msg, undoPatch) {
    const t = tripData.trip;
    const { data, error } = await sb.from('trips').update(patch).eq('id', t.id).select().single();
    if (error) { toast(/DAYS_WITH_CONTENT/.test(error.message) ? 'Some days at the end have plans. Reload and try again.' : errText(error), true); return false; }
    const fresh = await loadTrip(t.id).catch(() => null);
    if (fresh) tripData = fresh; else Object.assign(t, data);
    renderTrip(currentTab());
    if (msg) toast(msg, false, undoPatch ? () => patchTrip(undoPatch, 'Undone') : null);
    return true;
  }
  function changeLength(n) {
    const t = tripData.trip;
    if (n < 1 || n > MAX_DAYS) return;
    if (n > t.length_days) return patchTrip({ length_days: n }, 'Trip is now ' + plural(n, 'day') + ' · new day added at the end', { length_days: t.length_days });
    const cut = tripData.days.filter(d => d.idx >= n);
    const full = cut.filter(d => (d.location || '').trim() || (d.plan || '').trim() || (d.notes || '').trim());
    if (!full.length) return patchTrip({ length_days: n }, 'Trip is now ' + plural(n, 'day'), { length_days: t.length_days });
    confirmBox('Remove ' + full.map(dayName).join(', ') + '?', 'The last day of the trip has plans. Making the trip shorter deletes ' + (full.length === 1 ? 'it' : 'them') + '.',
      'Delete and shorten', async () => {
        const { error } = await sb.from('days').delete().in('id', full.map(d => d.id));
        if (error) return toast(errText(error), true);
        await patchTrip({ length_days: n }, 'Trip is now ' + plural(n, 'day'));
      }, true);
  }
  function datesEditor() {
    const t = tripData.trip;
    const done = h('button', { class: 'btn small primary', onclick: () => { editingDates = false; renderTrip(currentTab()); } }, 'Done');
    let startPart;
    if (t.start_date) {
      const inp = h('input', { class: 'input date-chip', type: 'date', value: t.start_date, 'aria-label': 'Start date',
        onchange: e => { if (e.target.value && e.target.value !== t.start_date) patchTrip({ start_date: e.target.value }, 'Trip now starts ' + longDate(e.target.value), { start_date: t.start_date }); } });
      startPart = h('span', { class: 'de-group' }, h('span', { class: 'de-label' }, 'Starts'), inp,
        h('button', { class: 'link-btn', onclick: () => patchTrip({ start_date: null }, 'Start date removed · ' + plural(t.length_days, 'day') + ', no dates yet', { start_date: t.start_date }) }, 'Remove start date'));
    } else if (settingStart) {
      const inp = h('input', { class: 'input date-chip', type: 'date', 'aria-label': 'Day 1 date',
        onchange: e => { if (e.target.value) { settingStart = false; patchTrip({ start_date: e.target.value }, 'Day 1 is ' + longDate(e.target.value), { start_date: null }); } } });
      setTimeout(() => inp.focus(), 20);
      startPart = h('span', { class: 'de-group' }, h('span', { class: 'de-label' }, 'Day 1 is'), inp,
        h('button', { class: 'icon-x', 'aria-label': 'Cancel', onclick: () => { settingStart = false; renderTrip(currentTab()); } }, '×'));
    } else {
      startPart = h('button', { class: 'btn small', onclick: () => { settingStart = true; renderTrip(currentTab()); } }, 'Set start date');
    }
    const n = t.length_days;
    const len = h('span', { class: 'stepper' },
      h('button', { type: 'button', 'aria-label': 'One day less', disabled: n <= 1, onclick: () => changeLength(n - 1) }, '–'),
      h('strong', null, plural(n, 'day')),
      h('button', { type: 'button', 'aria-label': 'One day more', disabled: n >= MAX_DAYS, onclick: () => changeLength(n + 1) }, '+'));
    return h('div', { class: 'dates-editor' }, startPart, h('span', { class: 'de-group' }, h('span', { class: 'de-label' }, 'Length'), len), h('div', { class: 'spacer' }), done);
  }
  let settingStart = false;

  async function toggleArchive() {
    const t = tripData.trip;
    const { error } = await sb.from('trips').update({ archived: !t.archived }).eq('id', t.id);
    if (error) return toast(errText(error), true);
    t.archived = !t.archived; toast(t.archived ? 'Archived' : 'Unarchived'); renderTrip(currentTab());
  }

  function deleteTrip() {
    const t = tripData.trip;
    confirmBox('Delete "' + t.name + '"?', 'This deletes the trip, its days, phases and bookings, and stops every share link. It can\'t be undone.',
      'Delete trip', async () => {
        const { error } = await sb.from('trips').delete().eq('id', t.id);
        if (error) return toast(errText(error), true);
        tripData = null; location.hash = '#/'; toast('Trip deleted');
      }, true);
  }

  /* ───────────── routing ───────────── */
  function currentTab() { return /\/itinerary$/.test(location.hash) ? 'itinerary' : 'planner'; }
  // Floating nav at the bottom of a trip: Planner · Itinerary · (Bookings, Checklist, Share: soon)
  function bottomNav(trip, tab) {
    return h('nav', { class: 'fnav', 'aria-label': 'Trip sections' },
      h('a', { class: 'fn' + (tab === 'planner' ? ' on' : ''), href: '#/trip/' + trip.id, 'aria-current': tab === 'planner' ? 'page' : null }, 'Planner'),
      h('a', { class: 'fn' + (tab === 'itinerary' ? ' on' : ''), href: '#/trip/' + trip.id + '/itinerary', 'aria-current': tab === 'itinerary' ? 'page' : null }, 'Itinerary'),
      ['Bookings', 'Checklist', 'Share'].map(n => h('span', { class: 'fn off', title: 'Coming soon' }, n, h('span', { class: 'soon-tag' }, 'Soon'))));
  }
  function route() {
    if (!authReady) return;
    const hash = location.hash;
    if (/access_token=|error_code=|type=magiclink/.test(hash)) return;   // the auth library is reading the link
    if (!session) { signInView(); return; }
    const m = hash.match(/^#\/trip\/([0-9a-f-]{36})(?:\/(phases|itinerary))?$/i);
    if (m && m[2] === 'phases') { history.replaceState(null, '', '#/trip/' + m[1]); tripView(m[1], 'planner'); }   // old Phases tab → Planner
    else if (m) tripView(m[1], m[2] || 'planner');
    else { tripData = null; tripsView(); }
  }
  window.addEventListener('hashchange', route);

  // A link that failed (expired, already used) comes back as #error=…
  const authError = /error_code=|error=/.test(location.hash) ? new URLSearchParams(location.hash.slice(1)) : null;

  sb.auth.onAuthStateChange((event, s) => {
    const was = session && session.user.id;
    session = s;
    if (!authReady) return;
    if ((s && s.user.id) !== was) {
      if (s && /access_token=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/');
      route();
    }
  });

  sb.auth.getSession().then(({ data }) => {
    session = data.session;
    authReady = true;
    if (/access_token=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/');
    if (authError && !session) {
      history.replaceState(null, '', location.pathname);
      const code = authError.get('error_code') || '';
      signInView(/expired|otp/i.test(code + authError.get('error_description'))
        ? 'That sign-in link has expired or was already used. Send yourself a new one.'
        : 'Sign-in didn\'t work: ' + (authError.get('error_description') || code || 'unknown error').replace(/\+/g, ' '));
      return;
    }
    route();
  });
})();
