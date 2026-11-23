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
      loading(); editingDates = false; settingStart = false; curPhase = 0; lastPhase = 0; addingPhase = false; resetDraft();
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
    const sy = window.scrollY, pb = document.querySelector('.pcard.live .pc-body'), sx = pb ? pb.scrollTop : 0, samePhase = pb && pb.closest('.pcard').dataset.phase;
    drawTrip(tab);
    app.dataset.trip = tripData.trip.id; app.dataset.tab = tab;
    if (same) { window.scrollTo(0, sy); const pb2 = document.querySelector('.pcard.live .pc-body'); if (pb2 && pb2.closest('.pcard').dataset.phase === samePhase) pb2.scrollTop = sx; }
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
        if ((row[field] || null) === v) { if (!pending) setSave('saved', 'All changes saved'); return; }
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
  let layoutQueue = Promise.resolve();
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

  /* ───────────── Planner: phase timeline + phase cards ("Shape the trip", canvas row 2) ─────────────
     The timeline is the phase list (click = pick). The picked phase is a card with its stops and days;
     the phases before and after peek in at the sides. Stops are runs of days with the same place (layout.js). */
  const PLACES = window.SuitcasePlaces;
  let curPhase = 0;          // index of the phase card in focus
  let lastPhase = 0;         // for the slide-in direction
  let addingPhase = false;   // the blank "Add a phase" card is in focus
  const draft = { text: '', pick: null, nights: 2 };   // the "Add next stop" / first stop input
  const resetDraft = () => { draft.text = ''; draft.pick = null; draft.nights = 2; };

  const PIN = c => '<svg viewBox="0 0 24 24" width="20" height="20" fill="' + (c || '#888') + '" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>';
  const PIN_ADD = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#9A9A9A" stroke-width="1.8" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><path d="M12 7v6M9 10h6" stroke-linecap="round"/></svg>';
  const LEG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3F5675" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16M6 14l6 6 6-6"/></svg>';

  function plannerTab() {
    const L = currentLayout(), t = tripData.trip, n = L.phases.length;
    const dateAt = idx => LAYOUT.dateAt(t.start_date, idx);
    const shortDay = idx => (t.start_date ? md(dateAt(idx)) : 'Day ' + (idx + 1));
    const span = (a, b) => (a === b ? shortDay(a) : shortDay(a) + ' – ' + shortDay(b));
    const fmt = { dateAt, shortDay, span, freeStart: LAYOUT.total(L) - L.free.length };
    saveState = h('span', { class: 'save-state saved' }, 'All changes saved');
    if (curPhase > n - 1) curPhase = Math.max(0, n - 1);
    if (!L.free.length) addingPhase = false;
    const blankOn = !n || addingPhase;
    const pick = i => { lastPhase = curPhase; curPhase = i; addingPhase = false; openMenu = null; renderTrip('planner'); };

    /* timeline */
    const tl = h('div', { class: 'tl', role: 'list' },
      L.phases.map((p, i) => {
        const st = LAYOUT.startIdx(L, i);
        return h('button', { class: 'tl-ph' + (i === curPhase && !blankOn ? ' on' : ''), role: 'listitem', style: { flex: p.days.length, background: p.colour || '#888' },
          title: LAYOUT.nameOf(L, i) + ' · ' + span(st, st + p.days.length - 1), 'aria-current': i === curPhase && !blankOn ? 'true' : null, onclick: () => pick(i) },
          h('b', null, LAYOUT.nameOf(L, i)), h('span', null, plural(p.days.length, 'day')));
      }),
      L.free.length ? h('button', { class: 'tl-free' + (blankOn ? ' on' : ''), role: 'listitem', style: { flex: L.free.length },
        onclick: () => { if (!n) return; lastPhase = curPhase; curPhase = n - 1; addingPhase = true; renderTrip('planner'); } },
        plural(L.free.length, 'day') + ' to plan') : null);

    /* cards */
    let main, left = null, right = null;
    if (blankOn) {
      main = startCard(L, fmt);
      if (n) left = phaseCard(L, n - 1, fmt, false);
    } else {
      main = phaseCard(L, curPhase, fmt, true);
      if (curPhase > 0) left = phaseCard(L, curPhase - 1, fmt, false);
      if (curPhase < n - 1) right = phaseCard(L, curPhase + 1, fmt, false);
      else if (L.free.length) right = h('div', { class: 'pcard blank' }, h('div', { class: 'blank-in' },
        h('strong', null, '+ Add a phase'), h('span', { class: 'muted' }, plural(L.free.length, 'day') + ' left to plan')));
    }
    const focusIdx = blankOn ? n : curPhase;
    const dir = focusIdx > lastPhase ? ' from-r' : focusIdx < lastPhase ? ' from-l' : '';
    lastPhase = focusIdx;
    const tilt = k => ({ '--tilt': (k % 2 ? 1.5 : -1.5) + 'deg' });
    const stage = h('div', { class: 'stage' },
      left ? h('div', { class: 'peek l' + dir, style: tilt(focusIdx - 1), onclick: () => pick(blankOn ? n - 1 : curPhase - 1), title: 'Open this phase' }, left) : null,
      h('div', { class: 'focus' + dir }, main),
      right ? h('div', { class: 'peek r' + dir, style: tilt(focusIdx + 1), title: right.classList.contains('blank') ? 'Add a phase' : 'Open this phase',
        onclick: () => { if (right.classList.contains('blank')) { resetDraft(); addingPhase = true; renderTrip('planner'); } else pick(curPhase + 1); } }, right) : null);

    return h('section', { class: 'planner' },
      h('div', { class: 'planner-top' }, tl, h('div', { class: 'planner-meta' }, saveState)),
      stage);
  }

  /* A phase card. live = the one in focus (editable); the side cards are read-only previews. */
  function phaseCard(L, i, fmt, live) {
    const p = L.phases[i], st = LAYOUT.startIdx(L, i), stops = LAYOUT.stopsOf(p);
    const nStops = stops.filter(s => s.place).length;
    let name;
    if (live) {
      name = h('input', { class: 'pc-name', value: p.name || '', placeholder: LAYOUT.suggestion(i), maxlength: 60, 'aria-label': 'Phase name' });
      name.addEventListener('change', () => renamePhase(p.id, name.value.trim() || null));
      name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
    } else name = h('strong', { class: 'pc-name' }, LAYOUT.nameOf(L, i));
    const head = h('div', { class: 'pc-head' },
      h('i', { class: 'pc-sw', style: { background: p.colour || '#888' } }), name,
      h('span', { class: 'pc-meta' }, span3(fmt, st, p.days.length) + (nStops ? ' · ' + plural(nStops, 'stop') : '')),
      live ? phaseMenu(L, i, p) : null);
    const flow = h('div', { class: 'flow' });
    let prev = null;
    stops.forEach(s => {
      if (s.place) {
        if (prev) flow.append(h('div', { class: 'f-leg' }, h('span', { class: 'f-ico' }, svg(LEG)), h('span', { class: 'muted' }, prev + ' → ' + s.place)));
        prev = s.place;
        flow.append(h('div', { class: 'f-stop' }, h('span', { class: 'f-ico' }, svg(PIN(p.colour))),
          h('strong', { class: 'f-place' }, s.place), h('span', { class: 'muted f-range' }, fmt.span(st + s.start, st + s.start + s.n - 1)),
          live ? nights(s.n, v => tryLayout(LAYOUT.setStopNights(currentLayout(), i, s.start, v)), s.place) : h('span', { class: 'muted' }, plural(s.n, 'night'))));
      }
      for (let j = s.start; j < s.start + s.n; j++) flow.append(flowDay(L, i, j, st + j, fmt, live, !s.place));
    });
    if (live) flow.append(stopRow({ placeholder: 'Add next stop', ghostFrom: st + p.days.length, fmt, lastPhase: i === L.phases.length - 1,
      onAdd: (place, pk, nn) => addStopTo(i, place, pk, nn) }));
    return h('section', { class: 'pcard' + (live ? ' live' : ''), 'data-phase': p.id, inert: live ? null : true }, head, h('div', { class: 'pc-body' }, flow));
  }
  const span3 = (fmt, st, len) => fmt.span(st, st + len - 1) + ' · ' + plural(len, 'day');

  function flowDay(L, i, j, idx, fmt, live, free) {
    const d = L.phases[i].days[j], row = tripData.days.find(x => x.id === d.id), date = fmt.dateAt(idx);
    const box = h('span', { class: 'f-day' }, date ? [h('span', null, wd(date).toUpperCase()), h('strong', null, pd(date).getUTCDate())] : [h('span', null, 'DAY'), h('strong', null, idx + 1)]);
    const rm = live ? h('button', { class: 'dx', 'aria-label': 'Remove ' + fmt.shortDay(idx), title: 'Remove this day', onclick: () => tryLayout(LAYOUT.removeDay(currentLayout(), i, j)) }, '×') : null;
    if (free) {
      if (!live) return h('div', { class: 'f-row free' }, box, h('span', { class: 'muted' }, 'Free day'));
      const loc = h('input', { class: 'f-in', placeholder: 'Free day · where are you?', 'aria-label': 'Where are you on ' + fmt.shortDay(idx) });
      loc.addEventListener('change', () => { const v = loc.value.trim(); if (!v || !row) return; row.location = v; saveDayField(row.id, { location: v }); renderTrip('planner'); });
      loc.addEventListener('keydown', e => { if (e.key === 'Enter') loc.blur(); });
      return h('div', { class: 'f-row free' }, box, loc, rm);
    }
    if (!live) return h('div', { class: 'f-row' }, box, h('span', { class: 'f-plan' + (d.plan ? '' : ' muted') }, d.plan || 'No plan yet'));
    const plan = h('input', { class: 'f-in', value: d.plan || '', placeholder: 'Add a plan', 'aria-label': 'Plan for ' + fmt.shortDay(idx) });
    plan.addEventListener('input', () => {
      if (!row) return; const v = plan.value.trim() || null; row.plan = v;
      clearTimeout(row._tplan); row._tplan = setTimeout(() => saveDayField(row.id, { plan: v }), 500);
    });
    plan.addEventListener('keydown', e => { if (e.key === 'Enter') plan.blur(); });
    return h('div', { class: 'f-row' }, box, plan, rm);
  }

  // – N nights +
  function nights(n, onSet, label) {
    return h('span', { class: 'nights' },
      h('button', { class: 'mini', 'aria-label': 'One night less' + (label ? ' in ' + label : ''), disabled: n <= 1, onclick: () => onSet(n - 1) }, '–'),
      h('b', null, plural(n, 'night')),
      h('button', { class: 'mini', 'aria-label': 'One night more' + (label ? ' in ' + label : ''), onclick: () => onSet(n + 1) }, '+'));
  }

  /* The place input with autocomplete, nights, an Add button once a place is typed,
     and faded "Free day" rows for the days it will add (only while the input is in use). */
  function stopRow(o) {
    const inp = h('input', { class: 'f-in stop-in', placeholder: o.placeholder, value: draft.text, autocomplete: 'off', role: 'combobox',
      'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-label': o.placeholder, id: o.id || null });
    const list = h('div', { class: 'ac hidden', role: 'listbox' });
    const add = h('button', { class: 'btn primary small' + (draft.text.trim() ? '' : ' hidden'), onclick: () => go() }, 'Add');
    const nb = h('b', null, plural(draft.nights, 'night'));
    const minus = h('button', { class: 'mini', 'aria-label': 'One night less', disabled: draft.nights <= 1, onclick: () => setN(draft.nights - 1) }, '–');
    const plus = h('button', { class: 'mini', 'aria-label': 'One night more', onclick: () => setN(draft.nights + 1) }, '+');
    const ghosts = h('div', { class: 'f-ghosts hidden' });
    let items = [], acI = 0, seq = 0, timer = null, focused = false;
    const using = () => focused || !!draft.text.trim();
    function paintGhosts() {
      ghosts.classList.toggle('hidden', !using());
      const rows = [];
      for (let k = 0; k < draft.nights; k++) {
        const idx = o.ghostFrom + k, date = o.fmt.dateAt(idx);
        rows.push(h('div', { class: 'f-row gh' }, h('span', { class: 'f-day' }, date ? [h('span', null, wd(date).toUpperCase()), h('strong', null, pd(date).getUTCDate())] : [h('span', null, 'DAY'), h('strong', null, idx + 1)]),
          h('span', { class: 'muted' }, 'Free day')));
      }
      ghosts.replaceChildren(...rows);
    }
    function setN(v) { draft.nights = Math.max(1, Math.min(LAYOUT.MAX_DAYS, v)); nb.textContent = plural(draft.nights, 'night'); minus.disabled = draft.nights <= 1; paintGhosts(); if (o.onChange) o.onChange(); }
    function paintList() {
      const open = focused && items.length > 0;
      list.classList.toggle('hidden', !open); inp.setAttribute('aria-expanded', open ? 'true' : 'false');
      list.replaceChildren(...items.map((it, k) => h('button', { class: 'ac-i' + (k === acI ? ' on' : ''), role: 'option', 'aria-selected': k === acI ? 'true' : 'false',
        onmousedown: e => { e.preventDefault(); choose(it); } }, h('strong', null, it.name), it.label ? h('span', { class: 'muted' }, it.label) : null)));
    }
    function choose(it) { draft.text = it.name; draft.pick = it; inp.value = it.name; items = []; paintList(); add.classList.remove('hidden'); if (o.onChange) o.onChange(); }
    function go() {
      const v = draft.text.trim(); if (!v) { inp.focus(); return; }
      const pk = draft.pick && draft.pick.name === v ? draft.pick : null, nn = draft.nights;
      resetDraft(); o.onAdd(v, pk, nn);
    }
    inp.addEventListener('input', () => {
      draft.text = inp.value; draft.pick = null;
      add.classList.toggle('hidden', !draft.text.trim()); paintGhosts(); if (o.onChange) o.onChange();
      clearTimeout(timer); const my = ++seq;
      timer = setTimeout(async () => { const r = await PLACES.suggest(draft.text); if (my !== seq) return; items = r; acI = 0; paintList(); }, 250);
    });
    inp.addEventListener('keydown', e => {
      const open = !list.classList.contains('hidden');
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); acI = (acI + 1) % items.length; paintList(); }
      else if (e.key === 'ArrowUp' && open) { e.preventDefault(); acI = (acI - 1 + items.length) % items.length; paintList(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (open) choose(items[acI]); else go(); }
      else if (e.key === 'Escape') { items = []; paintList(); }
    });
    inp.addEventListener('focus', () => { focused = true; paintGhosts(); paintList(); });
    inp.addEventListener('blur', () => setTimeout(() => { focused = false; items = items; paintList(); paintGhosts(); }, 150));
    paintGhosts();
    return h('div', { class: 'stop-add' },
      h('div', { class: 'f-stop add' }, h('span', { class: 'f-ico' }, svg(PIN_ADD)),
        h('span', { class: 'ac-wrap' }, inp, list),
        h('span', { class: 'nights' }, minus, nb, plus), add),
      ghosts);
  }

  /* Empty trip ("Let's get started.") or a new phase after the last one ("Add a phase"). */
  function startCard(L, fmt) {
    const first = !L.phases.length, n = L.phases.length;
    const title = h('h2', { class: 'pc-name start-t' });
    const sub = h('span', { class: 'pc-meta' });
    const paint = () => {
      const guess = PLACES.phaseNameFor(draft.pick);
      title.textContent = draft.text.trim() ? (guess || (first ? 'First phase' : 'Phase ' + (n + 1))) : (first ? 'Let\'s get started.' : 'Add a phase');
      title.classList.toggle('preview', !!draft.text.trim());
      sub.textContent = plural(L.free.length, 'day') + ' to plan' + (first ? ' · add where the trip starts' : ' · add the first stop of the next phase');
    };
    paint();
    const row = stopRow({ id: 'firststop', placeholder: first ? 'Where does the trip start?' : 'First stop of the next phase', ghostFrom: fmt.freeStart, fmt,
      onChange: paint, onAdd: (place, pk, nn) => firstStopAdd(place, pk, nn) });
    return h('section', { class: 'pcard live start' },
      h('div', { class: 'pc-head' }, h('i', { class: 'pc-sw', style: { background: LAYOUT.nextColour(L) } }), title, sub,
        !first ? h('button', { class: 'link-btn', onclick: () => { addingPhase = false; resetDraft(); renderTrip('planner'); } }, 'Cancel') : null),
      h('div', { class: 'pc-body' }, h('div', { class: 'flow' }, row)));
  }

  function phaseMenu(L, i, p) {
    const menu = h('div', { class: 'menu pmenu' + (openMenu === p.id ? '' : ' hidden') },
      h('button', { disabled: i === 0, onclick: () => { openMenu = null; if (tryLayout(LAYOUT.movePhase(currentLayout(), i, i - 1))) curPhase = i - 1, renderTrip('planner'); } }, 'Move earlier'),
      h('button', { disabled: i === L.phases.length - 1, onclick: () => { openMenu = null; if (tryLayout(LAYOUT.movePhase(currentLayout(), i, i + 1))) curPhase = i + 1, renderTrip('planner'); } }, 'Move later'),
      h('button', { onclick: () => { openMenu = null; colourPhotoModal(p.id); } }, 'Colour & photo…'),
      h('hr'),
      h('button', { class: 'danger', onclick: () => { openMenu = null; tryLayout(LAYOUT.removePhase(currentLayout(), i)); } }, 'Delete phase'));
    const more = h('button', { class: 'icon-btn small', 'aria-label': 'More for ' + LAYOUT.nameOf(L, i), onclick: e => {
      e.stopPropagation(); const open = menu.classList.contains('hidden');
      document.querySelectorAll('.pmenu').forEach(m => m.classList.add('hidden')); menu.classList.toggle('hidden', !open); openMenu = open ? p.id : null; } }, svg(ICON.more));
    return h('div', { class: 'menu-wrap' }, more, menu);
  }

  async function renamePhase(id, v) {
    const row = tripData.phases.find(x => x.id === id);
    if (row) { row.name = v; row.auto_name = false; }
    // After any layout save still on its way, so an older layout can't put the old name back.
    const { error } = await (layoutQueue = layoutQueue.then(() => sb.from('phases').update({ name: v, auto_name: false }).eq('id', id)));
    if (error) toast('Couldn\'t save the name: ' + errText(error), true);
    else if (tripData && currentTab() === 'planner' && document.querySelector('.planner')) renderTrip('planner');
  }

  // Name a phase from its first stop while it is still auto-named (country, or continent for a country).
  function autoName(layout, i, pk) {
    const p = layout.phases[i], row = tripData.phases.find(x => x.id === p.id);
    if (row && row.auto_name === false) return;
    const guess = PLACES.phaseNameFor(pk);
    if (!guess) return;
    const placed = LAYOUT.stopsOf(p).filter(s => s.place).length;
    if (placed === 1 || !(p.name || '').trim()) p.name = guess;
  }

  // Keep where each place is (for the map later). Same name on the same trip = same place.
  function rememberPlace(pk) {
    if (!pk || !tripData) return;
    sb.from('places').upsert({ trip_id: tripData.trip.id, name: pk.name, lat: pk.lat, lng: pk.lng, country: pk.country, found_as: pk.label || null },
      { onConflict: 'trip_id,name' }).then(r => { if (r && r.error) console.warn('place not saved', r.error.message); });
  }
  const focusAdd = () => setTimeout(() => { const el = document.querySelector('.pcard.live .stop-in'); if (el) el.focus(); }, 30);

  function addStopTo(i, place, pk, nn) {
    const res = LAYOUT.addStop(currentLayout(), i, place, nn);
    if (res.error) { toast(res.error, true); return; }
    autoName(res.layout, i, pk); rememberPlace(pk);
    commitLayout(res.layout, res.msg); focusAdd();
  }
  function firstStopAdd(place, pk, nn) {
    const res = LAYOUT.firstStop(currentLayout(), place, nn);
    if (res.error) { toast(res.error, true); return; }
    autoName(res.layout, res.phaseIndex, pk); rememberPlace(pk);
    lastPhase = curPhase; curPhase = res.phaseIndex; addingPhase = false;
    commitLayout(res.layout, res.msg); focusAdd();
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
