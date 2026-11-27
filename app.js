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
    const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); if (box.onClose) box.onClose(); };
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

  /* ───────────── new trip pop-up ─────────────
     Canvas "Design · New trip prototype", frames 1a–1d:
     1 · where + dates → 2 · finish the sentence → 3 · three routes on a map → Customize this plan.
     Or, from step 1: Import a plan you have (rows pasted from a sheet, or a .csv / .xlsx file). */
  const NT = window.SuitcaseNewTrip;
  const ROUGH = [['weekend', 'Weekend', 3], ['w1', '1 week', 7], ['w2', '2 weeks', 14], ['w3', '3 weeks', 21]];
  let pendingStop = null;   // first stop to put in "Let's get started." once the new trip opens

  // Icons for highlight types (the KINDS list in supabase/functions/draft-trip/prompt.ts). 24×24, stroked.
  const HL_ICONS = {
    hike: 'M3 19l6-10 4 6 2-3 6 7H3zM8 11l1.5 1.5L11 11', kayak: 'M4 20L20 4M3 21l2-2M19 5l2-2M7 13c1.5 1.5 2.5 2.5 4 4M13 7c1.5 1.5 2.5 2.5 4 4', bike: 'M6 17m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M18 17m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M6 17l4-8h5l3 8M9 6h3M12 9l-2 8', mountain: 'M2 20l7-12 4 6 3-4 6 10z', volcano: 'M4 19l5-8h6l5 8zM10 11l.8-3M14 11l-.8-3M12 3.5v2M9 5l1 1.2M15 5l-1 1.2',
    glacier: 'M3 18l5-8 3 4 3-6 7 10zM9 12l1.5 1.5M14.5 9.5L16 12', valley: 'M2 19l5-11 3 6 2-8 3 8 2-4 5 9zM2 19h20',
    lake: 'M3 15c2 0 2-1.5 4.5-1.5S10 15 12 15s2-1.5 4.5-1.5S19 15 21 15M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2-1.5 4.5-1.5S19 19 21 19M8 10l4-6 4 6',
    beach: 'M4 20h16M7 20c0-5 2-9 5-11M12 9c-2-3-6-3-8-1 3 0 5 .5 8 1zm0 0c2-3 6-3 8-1-3 0-5 .5-8 1z', island: 'M3 18c3-2 15-2 18 0M12 16V8M12 8c-2-2-5-2-6 0M12 8c2-2 5-2 6 0',
    wildlife: 'M5 12a2 2 0 1 0 0-.1M9 7a2 2 0 1 0 0-.1M15 7a2 2 0 1 0 0-.1M19 12a2 2 0 1 0 0-.1M8 18c0-3 2-5 4-5s4 2 4 5c0 1.5-2 2-4 2s-4-.5-4-2z',
    food: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M16 3c-1.7 0-3 2.2-3 5s1.3 4 3 4v9', wine: 'M8 3h8l-1 6a3 3 0 0 1-6 0zM12 12v8M8 21h8',
    city: 'M3 21V9l6-3v15M9 21V4l8 3v14M17 21v-9l4 2v7M2 21h20', culture: 'M4 10h16L12 4zM6 10v8M10 10v8M14 10v8M18 10v8M3 21h18',
    history: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l2.5 2', ruins: 'M3 21h18M5 21V11h3v10M10 21V8h4v13M16 21V13h3v8M4 8l3-3M14 5l4 3',
    museum: 'M4 10h16L12 4zM6 10v8M10 10v8M14 10v8M18 10v8M3 21h18', market: 'M4 9l1-5h14l1 5M4 9h16v11H4zM4 9c0 2 3.5 2 4 0 .5 2 3.5 2 4 0 .5 2 3.5 2 4 0 .5 2 4 2 4 0',
    nightlife: 'M8 3h8l-4 7zM12 10v9M8 21h8', hot_springs: 'M4 18c3 2 13 2 16 0M8 14c0-2 1-2 1-4s-1-2-1-4M12 14c0-2 1-2 1-4s-1-2-1-4M16 14c0-2 1-2 1-4s-1-2-1-4',
    stay: 'M3 18V8M3 14h18v4M21 14c0-2-1-4-4-4H9v4M6 12a1.5 1.5 0 1 0 0-.1', festival: 'M4 21L9 7l8 8zM14 4c1 1 1 2 0 3M18 6c1 .5 2 .5 3 0M17 2v2',
    drive: 'M12 12m-8.5 0a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M3.8 10.5h6.3M13.9 10.5h6.3M12 14v6.3',
    boat: 'M3 16l2 4h14l2-4zM6 16V9h12v7M12 9V4M12 4l4 3', train: 'M6 3h12a1 1 0 0 1 1 1v11a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V4a1 1 0 0 1 1-1zM5 10h14M8 21l2-3M16 21l-2-3',
    flight: 'M3 13l7-2 4-7h2l-2 7 5 1 1-2h2l-1 4 1 4h-2l-1-2-5 1 2 7h-2l-4-7-7-2z', time: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l2.5 2',
    other: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0'
  };
  const hlIcon = (k, size) => '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (HL_ICONS[k] || HL_ICONS.other) + '"/></svg>';

  /* Mapbox GL JS, loaded the first time a route map is shown (it's ~2 MB). Tests set SUITCASE_MAP_FAKE to skip it. */
  let glReady = null;
  function loadGL() {
    if (window.SUITCASE_MAP_FAKE) return Promise.reject(new Error('fake'));
    if (!glReady) glReady = new Promise((res, rej) => {
      const css = h('link', { rel: 'stylesheet', href: 'lib/mapbox-gl-3.35.2.css' });
      const js = h('script', { src: 'lib/mapbox-gl-3.35.2.js' });
      js.onload = () => (window.mapboxgl ? res(window.mapboxgl) : rej(new Error('no mapboxgl')));
      js.onerror = () => { glReady = null; rej(new Error('Mapbox didn\'t load')); };
      document.head.append(css, js);
    });
    return glReady;
  }

  function newTripModal() {
    const st = { step: 'where', dest: '', picks: [], mode: null, unit: null, months: 1, start: '', end: '', cal: null, seasons: [],
      ans: { loves: [], who: null, pace: null, fitness: null, transport: null, noFly: false, shape: 'any', from: '', to: '', must: '', avoid: '' }, more: false, fopen: null,
      busy: false, routes: null, cur: 0, view: 'map', tw: null, twText: '', redraw: null, imp: { text: '', file: null, plan: null, msg: null } };
    modal((box, close) => {
      box.classList.add('newtrip');
      const err = h('div', { class: 'notice warn hidden', role: 'alert' });
      const showErr = m => { err.textContent = m; err.classList.remove('hidden'); };
      const hideErr = () => err.classList.add('hidden');
      const lengthOf = () => st.mode === 'exact' ? (st.start && st.end ? NT.daysIncl(st.start, st.end) : 0)
        : st.unit === 'month' ? st.months * 30 : (ROUGH.find(r => r[0] === st.unit) || [0, 0, 0])[2];
      const unitLabel = () => st.mode === 'exact' ? null : st.unit === 'month' ? plural(st.months, 'month') : (ROUGH.find(r => r[0] === st.unit) || [])[1];
      const datesOk = () => st.mode === 'exact' ? !!(st.start && st.end) : !!st.unit;
      const destOk = () => !!st.dest.trim();
      const destName = () => st.dest.split(',').map(x => x.trim()).filter(Boolean).join(', ');

      /* ── frame: label, body (scrolls), footer (pinned) ── */
      const lbl = h('span', { class: 'nt-lbl' });
      const body = h('div', { class: 'nt-body' });
      const foot = h('div', { class: 'nt-foot' });
      const x = h('button', { type: 'button', class: 'nt-x', 'aria-label': 'Close', onclick: () => close() }, '×');
      const setFoot = (left, right) => foot.replaceChildren(h('div', { class: 'nt-fl' }, left), h('div', { class: 'nt-fr' }, right));

      /* ── step 1: where (static, so the cursor survives redraws) ── */
      const dest = h('input', { class: 'input big-name dest-in', placeholder: 'Cities, countries or regions', maxlength: 200, autocomplete: 'off',
        role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-label': 'Where are you going?' });
      const acList = h('div', { class: 'ac hidden', role: 'listbox' });
      let items = [], acI = 0, seq = 0, timer = null, focused = false;
      const lastPart = () => { const parts = dest.value.split(','); return parts[parts.length - 1].trim(); };
      function paintAc() {
        const open = focused && items.length > 0;
        acList.classList.toggle('hidden', !open); dest.setAttribute('aria-expanded', String(open));
        acList.replaceChildren(...items.map((it, k) => h('button', { type: 'button', class: 'ac-i' + (k === acI ? ' on' : ''), role: 'option', 'aria-selected': String(k === acI),
          onmousedown: e => { e.preventDefault(); choose(it); } }, h('strong', null, it.name), it.label ? h('span', { class: 'muted' }, it.label) : null)));
      }
      function syncPicks() { const names = st.dest.split(',').map(x => x.trim().toLowerCase()); st.picks = st.picks.filter(p => names.indexOf(p.name.toLowerCase()) >= 0); }
      function choose(it) {
        const parts = dest.value.split(','); parts[parts.length - 1] = (parts.length > 1 ? ' ' : '') + it.name;
        dest.value = parts.join(','); st.dest = dest.value;
        st.picks = st.picks.filter(p => p.name !== it.name).concat([it]); syncPicks();
        items = []; paintAc(); draw();
      }
      dest.addEventListener('input', () => {
        st.dest = dest.value; syncPicks(); hideErr(); drawFoot1();
        clearTimeout(timer); const my = ++seq;
        timer = setTimeout(async () => { const r = await PLACES.suggest(lastPart()); if (my !== seq) return; items = r; acI = 0; paintAc(); }, 250);
      });
      dest.addEventListener('keydown', e => {
        const open = !acList.classList.contains('hidden');
        if (e.key === 'ArrowDown' && open) { e.preventDefault(); acI = (acI + 1) % items.length; paintAc(); }
        else if (e.key === 'ArrowUp' && open) { e.preventDefault(); acI = (acI - 1 + items.length) % items.length; paintAc(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (open) choose(items[acI]); }
        else if (e.key === 'Escape' && open) { e.stopPropagation(); items = []; paintAc(); }
      });
      dest.addEventListener('focus', () => { focused = true; paintAc(); });
      dest.addEventListener('blur', () => setTimeout(() => { focused = false; paintAc(); }, 150));
      const where = h('div', { class: 'nt-where' }, h('div', { class: 'nt-ttl' }, 'Where are you going?'), h('span', { class: 'ac-wrap' }, dest, acList));
      const datesBox = h('div', { class: 'nt-dates' });

      const stepper = (label, onMinus, onPlus, minusOff, plusOff) => h('span', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'Less', disabled: minusOff, onclick: e => { e.stopPropagation(); onMinus(); } }, '–'),
        h('strong', null, label), h('button', { type: 'button', 'aria-label': 'More', disabled: plusOff, onclick: e => { e.stopPropagation(); onPlus(); } }, '+'));
      const seg = (key, label) => h('button', { type: 'button', class: 'seg-btn' + (st.mode === key ? ' on' : ''), 'aria-pressed': String(st.mode === key),
        onclick: () => { st.mode = key; if (key === 'exact' && !st.start) st.cal = { pickEnd: false, hover: null, month: null }; draw(); } }, label);

      /* the range calendar: first tap = first day, second tap = last day */
      const fmtD = v => v ? new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
      function rangePart() {
        const c = st.cal, pickEnd = !!(c && c.pickEnd);
        const endV = pickEnd ? (c.hover && c.hover >= st.start ? c.hover : null) : st.end;
        const n = st.start && endV ? NT.daysIncl(st.start, endV) : 0;
        const btn = h('button', { type: 'button', class: 'rp-btn', 'aria-expanded': String(!!c), 'aria-haspopup': 'dialog',
          onclick: () => { st.cal = st.cal ? null : { pickEnd: false, hover: null, month: null }; draw(); } },
          svg('<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>'),
          h('span', { class: 'rp-v' + (c && !pickEnd ? ' act' : '') + (st.start ? '' : ' none') }, h('small', null, 'Start'), st.start ? fmtD(st.start) : 'Add date'),
          h('span', { class: 'rp-arr', 'aria-hidden': 'true' }, '→'),
          h('span', { class: 'rp-v rp-end' + (pickEnd ? ' act' : '') + (endV ? '' : ' none') }, h('small', null, 'End'), h('span', null, endV ? fmtD(endV) : pickEnd ? 'Pick a day' : 'Add date')),
          h('span', { class: 'rp-len' }, n ? plural(n, 'day') : ''));
        if (!c) return h('div', { class: 'rp' }, btn);
        const base = c.month || (st.start || todayIso()).slice(0, 7);
        const [by, bm] = base.split('-').map(Number);
        const today = todayIso();
        const months = [0, 1].map(o => {
          const y = by + Math.floor((bm - 1 + o) / 12), m = (bm - 1 + o) % 12;
          const cells = NT.monthGrid(y, m).map(v => {
            if (!v) return h('span', { class: 'rp-x' });
            const off = v < today || (pickEnd && v < st.start);
            const isS = v === st.start, isE = !!endV && v === endV, inR = !!(st.start && endV && v > st.start && v < endV);
            return h('button', { type: 'button', class: 'rp-d' + (isS ? ' s' : '') + (isE ? ' e' : '') + (inR ? ' in' : '') + (isS && endV && endV > st.start ? ' ss' : '') + (isE && endV > st.start ? ' ee' : ''),
              disabled: off, 'aria-label': fmtD(v), 'aria-pressed': String(isS || isE),
              'data-v': v, onmouseenter: () => { if (st.cal && st.cal.pickEnd) hoverEnd(v); },
              onclick: () => {
                if (!pickEnd) { st.start = v; st.end = ''; c.pickEnd = true; c.hover = v; }
                else { st.end = v; st.cal = null; }
                hideErr(); draw();
                const again = body.querySelector(st.cal ? '.rp-d[data-v="' + v + '"]' : '.rp-btn'); if (again) again.focus();
              } }, String(+v.slice(8)));
          });
          return h('div', { class: 'rp-m' }, h('div', { class: 'rp-mt' }, new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })),
            h('div', { class: 'rp-g' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span', { class: 'rp-dw', 'aria-hidden': 'true' }, d)), cells));
        });
        const shift = k => () => { const t = new Date(Date.UTC(by, bm - 1 + k, 1)); c.month = t.toISOString().slice(0, 7); draw(); };
        return h('div', { class: 'rp' }, btn, h('div', { class: 'rp-pop', role: 'dialog', 'aria-label': 'Pick your dates' },
          h('div', { class: 'rp-hd' }, h('button', { type: 'button', class: 'rp-nav', 'aria-label': 'Previous month', onclick: shift(-1) }, '‹'),
            h('span', { class: 'muted' }, pickEnd ? 'Now pick your last day' : 'Pick your first day'),
            h('button', { type: 'button', class: 'rp-nav', 'aria-label': 'Next month', onclick: shift(1) }, '›')),
          h('div', { class: 'rp-ms' }, months)));
      }
      /* While picking the last day, hovering only restyles the days and the End label (no redraw, so clicks land). */
      function hoverEnd(v) {
        const c = st.cal; c.hover = v; const endV = v >= st.start ? v : null;
        body.querySelectorAll('.rp-d[data-v]').forEach(b => { const d = b.dataset.v;
          b.classList.toggle('e', !!endV && d === endV); b.classList.toggle('ee', !!endV && d === endV && endV > st.start);
          b.classList.toggle('in', !!endV && d > st.start && d < endV); b.classList.toggle('ss', d === st.start && !!endV && endV > st.start); });
        const ev = body.querySelector('.rp-end'), len = body.querySelector('.rp-len');
        if (ev) { ev.lastChild.textContent = endV ? fmtD(endV) : 'Pick a day'; ev.classList.toggle('none', !endV); }
        if (len) len.textContent = endV ? plural(NT.daysIncl(st.start, endV), 'day') : '';
      }
      function datesPart() {
        let inner = null;
        if (st.mode === 'rough') {
          inner = h('div', { class: 'len-pills' },
            ROUGH.map(r => h('button', { type: 'button', class: 'len-pill' + (st.unit === r[0] ? ' on' : ''), 'aria-pressed': String(st.unit === r[0]),
              onclick: () => { st.unit = r[0]; draw(); } }, r[1])),
            st.unit === 'month'
              ? h('span', { class: 'len-pill on months' }, stepper(plural(st.months, 'month'),
                  () => { st.months = Math.max(1, st.months - 1); draw(); }, () => { st.months = Math.min(24, st.months + 1); draw(); }, st.months <= 1, st.months >= 24))
              : h('button', { type: 'button', class: 'len-pill', 'aria-pressed': 'false', onclick: () => { st.unit = 'month'; draw(); } }, 'Months'));
        } else if (st.mode === 'exact') inner = rangePart();
        const when = st.mode === 'rough' ? [h('div', { class: 'q nt-when' }, 'Roughly when?'),
          h('div', { class: 'fpills' }, NT.FORM.seasons.map(([v, label]) => pill(label, FI[v], st.seasons.indexOf(v) >= 0, () => { st.seasons = NT.pickSeason(st.seasons, v); draw(); })))] : [];
        return [h('div', { class: 'q' }, 'Do you know your dates yet?'), h('div', { class: 'seg' }, seg('rough', 'Not yet'), seg('exact', 'Yes, I do')), inner, ...when];
      }
      function drawFoot1() {
        const ready = destOk() && datesOk();
        setFoot(h('button', { type: 'button', class: 'btn', onclick: () => go('import') }, 'Import a plan you have'),
          [h('span', { class: 'muted' }, !destOk() ? 'Add where you\'re going.' : !datesOk() ? (st.mode === 'exact' ? 'Pick your first and last day.' : 'Answer the dates question.') : ''),
            h('button', { type: 'button', class: 'btn primary', disabled: !ready, onclick: () => go('sentence') }, 'Next →')]);
      }

      /* ── step 2: the form (every answer optional) ── */
      const ctx = () => ({ dest: destName(), days: lengthOf(), start: st.mode === 'exact' ? st.start : null, exactDates: st.mode === 'exact', seasons: st.seasons });
      // icons for the pills and cards (24×24 line drawings)
      const FI = {
        'outdoor adventure': 'M3 19l6-10 4 6 2-3 6 7H3zM8 11l1.5 1.5L11 11', 'city culture': 'M4 20V9l5-3v14M9 20V4h7v16M16 20v-9h4v9M3 20h18M12 8h1M12 11h1M12 14h1',
        'food scene': 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M16 3c-1.7 0-3 2.2-3 5s1.3 4 3 4v9',
        'local communities': 'M8 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M16 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M3 20c0-2.8 2.2-5 5-5s5 2.2 5 5M11 20c0-2.8 2.2-5 5-5s5 2.2 5 5',
        'remote landscapes': 'M2 19l5-11 3 6 2-8 3 8 2-4 5 9zM2 19h20', 'unusual historical sites': 'M3 21h18M5 21V11h3v10M10 21V8h4v13M16 21v-8h3v8M4 8l3-3M14 5l4 3',
        markets: 'M4 9l1-5h14l1 5M4 9h16v11H4zM4 9c0 2 3.5 2 4 0 .5 2 3.5 2 4 0 .5 2 3.5 2 4 0 .5 2 4 2 4 0M10 20v-5h4v5', cooking: 'M4 11h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6zM2 11h20M9 7c0-1.5 1-1.5 1-3M14 7c0-1.5 1-1.5 1-3',
        history: 'M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M6 4a2 2 0 0 0-2 2v1h3M9 9h7M9 13h7M9 17h4', architecture: 'M4 20V9l5-3v14M9 20V4h7v16M16 20v-9h4v9M3 20h18',
        photography: 'M4 8h3l2-3h6l2 3h3v11H4zM12 13.5m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', 'off the beaten path': 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M15.5 8.5l-2 5-5 2 2-5z',
        museums: 'M4 20h16M5 9h14M12 4l8 5H4zM7 9v11M12 9v11M17 9v11', 'beach days': 'M3 15c2 0 2-2 4.5-2S10 15 12 15s2-2 4.5-2S19 15 21 15M3 19c2 0 2-2 4.5-2S10 19 12 19s2-2 4.5-2S19 19 21 19M17 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
        nightlife: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
        'Slow and immersive': 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l2 2', Balanced: 'M3 12h4l2-4 4 8 2-4h6', 'Fast-paced': 'M4 17l5-5-5-5M11 17l5-5-5-5M18 7v10',
        'Casual walks': 'M13 4m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 21l2-6 2 2v4M12 15l-1-5 3-1 2 3h2M11 10l-3 2v3', 'Day hikes': 'M3 19l6-10 4 6 2-3 6 7H3zM8 11l1.5 1.5L11 11',
        'Multi-day treks': 'M3 20L12 5l9 15zM12 5v15M9 20l3-5 3 5', 'Big adventures': 'M2 20l7-13 3 5 2-3 8 11zM9 7l1.5 3M16 6V2l3 1-3 1',
        spring: 'M12 20v-8M12 12c-3 0-5-2-5-5 3 0 5 2 5 5zm0 0c3 0 5-2 5-5-3 0-5 2-5 5z', summer: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
        fall: 'M6 18C6 10 11 5 19 5c0 8-5 13-13 13zM6 18l6-6M6 18l-2 2', winter: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M10 4.5l2 2 2-2M10 19.5l2-2 2 2',
        unsure: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0',
        down: 'M6 9l6 6 6-6', up: 'M6 15l6-6 6 6', pen: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4'
      };
      const ico = (d, n) => svg('<svg viewBox="0 0 24 24" width="' + (n || 20) + '" height="' + (n || 20) + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (d || '') + '"/></svg>');
      const pill = (label, icon, on, fn) => h('button', { type: 'button', class: 'fp' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, icon ? ico(icon) : null, label);
      const segBtn = (label, on, fn) => h('button', { type: 'button', class: 'fsg' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, label);
      const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
      function formPart() {
        const a = st.ans, F = NT.FORM, set = (k, v) => { a[k] = v; draw(); };
        const shown = st.more ? F.loves : F.loves.filter((v, k) => k < F.shown || a.loves.indexOf(v) >= 0);
        const sec = (title, kids, extra) => h('div', { class: 'fsec' + (extra || '') }, title ? h('div', { class: 'fh' }, title) : null, kids);
        // text answers save as you type, without a redraw (keeps the cursor)
        const field = (k, label, ph, area) => h('label', { class: 'fxg' }, label ? h('span', { class: 'fxl' }, label) : null,
          h(area ? 'textarea' : 'input', { class: 'fin' + (area ? ' fta' : ''), placeholder: ph, 'aria-label': label || ph, maxlength: area ? 300 : 80, value: a[k] || '',
            oninput: e => { a[k] = e.target.value; } }));
        // start and end points: the same place suggestions as step 1
        const placeField = (k, label, ph) => {
          const inp = h('input', { class: 'fin', placeholder: ph, 'aria-label': label, maxlength: 80, value: a[k] || '', autocomplete: 'off',
            role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false' });
          const list = h('div', { class: 'ac hidden', role: 'listbox' });
          let items = [], i = 0, seq = 0, timer = null;
          const paint = () => { const open = document.activeElement === inp && items.length > 0;
            list.classList.toggle('hidden', !open); inp.setAttribute('aria-expanded', String(open));
            list.replaceChildren(...items.map((it, k2) => h('button', { type: 'button', class: 'ac-i' + (k2 === i ? ' on' : ''), role: 'option', 'aria-selected': String(k2 === i),
              onmousedown: e => { e.preventDefault(); pick(it); } }, h('strong', null, it.name), it.label ? h('span', { class: 'muted' }, it.label) : null))); };
          const pick = it => { inp.value = it.name; a[k] = it.name; items = []; paint(); };
          inp.addEventListener('input', () => { a[k] = inp.value; clearTimeout(timer); const my = ++seq;
            timer = setTimeout(async () => { const r = inp.value.trim() ? await PLACES.suggest(inp.value.trim()) : []; if (my !== seq) return; items = r; i = 0; paint(); }, 250); });
          inp.addEventListener('keydown', e => { const open = !list.classList.contains('hidden');
            if (e.key === 'ArrowDown' && open) { e.preventDefault(); i = (i + 1) % items.length; paint(); }
            else if (e.key === 'ArrowUp' && open) { e.preventDefault(); i = (i - 1 + items.length) % items.length; paint(); }
            else if (e.key === 'Enter' && open) { e.preventDefault(); pick(items[i]); }
            else if (e.key === 'Escape' && open) { e.stopPropagation(); items = []; paint(); } });
          inp.addEventListener('blur', () => setTimeout(paint, 150));
          return h('div', { class: 'fxg' }, h('span', { class: 'fxl' }, label), h('span', { class: 'ac-wrap' }, inp, list));
        };
        const clip = t => t.length > 34 ? t.slice(0, 33) + '…' : t;
        const fold = (id, title, summary, kids) => { const open = st.fopen === id;
          return h('div', { class: 'fsec fx' }, h('button', { type: 'button', class: 'fxh', 'aria-expanded': String(open), onclick: () => { st.fopen = open ? null : id; draw(); } },
            h('span', null, title, summary ? h('span', { class: 'fsum' }, ' · ' + clip(summary)) : null), ico(open ? FI.up : FI.down, 22)),
            open ? h('div', { class: 'fxb' }, kids) : null); };
        const shape = a.shape || 'any';
        const ends = [shape === 'loop' ? 'loop' : shape === 'open' ? 'open-jaw' : '', a.from && 'from ' + a.from.trim(), shape !== 'loop' && a.to && 'to ' + a.to.trim()].filter(Boolean).join(', ');
        return [h('div', { class: 'nt-ttl' }, 'Tell us about the trip'),
          sec([h('span', null, 'Interests'), h('span', { class: 'fsub' }, 'Pick any')], [
            h('div', { class: 'fpills' }, shown.map(v => pill(cap(v), FI[v], a.loves.indexOf(v) >= 0, () => set('loves', NT.toggle(a.loves, v))))),
            F.loves.length > F.shown ? h('button', { type: 'button', class: 'fmore', onclick: () => { st.more = !st.more; draw(); } }, st.more ? 'Show less' : 'Show more', ico(st.more ? FI.up : FI.down, 16)) : null]),
          sec('Who’s going', h('div', { class: 'fseg', role: 'group', 'aria-label': 'Who’s going' }, F.who.map(([label, v]) => segBtn(label, a.who === v, () => set('who', a.who === v ? null : v))))),
          sec('Pace', h('div', { class: 'fcards' }, F.pace.map(([label, desc, v]) => h('button', { type: 'button', class: 'fc' + (a.pace === v ? ' on' : ''), 'aria-pressed': String(a.pace === v),
            onclick: () => set('pace', a.pace === v ? null : v) }, ico(FI[label], 26), h('span', null, h('b', null, label), h('span', null, desc)))))),
          sec('How active?', h('div', { class: 'fpills' }, F.fitness.map(label => { const v = label.toLowerCase(); return pill(label, FI[label], a.fitness === v, () => set('fitness', a.fitness === v ? null : v)); }))),
          sec([h('span', null, 'Getting around'), h('span', { class: 'fsub' }, 'Pick one, or leave it')], [
            h('div', { class: 'fseg', role: 'group', 'aria-label': 'Getting around' }, F.transport.map(([label, v]) => segBtn(label, a.transport === v, () => set('transport', a.transport === v ? null : v)))),
            h('label', { class: 'fchk' }, h('input', { type: 'checkbox', checked: a.noFly, onchange: e => set('noFly', e.target.checked) }), 'No flights')]),
          fold('ends', 'Start and end points', ends, [
            h('div', { class: 'fxg' }, h('span', { class: 'fxl' }, 'Where it ends'), h('div', { class: 'fseg', role: 'group', 'aria-label': 'Route shape' }, F.shape.map(([v, label]) => segBtn(label, shape === v, () => set('shape', v))))),
            placeField('from', 'Starting in', 'A city, airport or border crossing'),
            shape === 'loop' ? null : placeField('to', 'Ending in', 'Where you fly home from')]),
          fold('must', 'Anything you must do?', (a.must || '').trim(), field('must', '', 'For example: a multi-day hike, a cooking class, one special night somewhere', true)),
          fold('avoid', 'Anything to avoid?', (a.avoid || '').trim(), field('avoid', '', 'For example: long bus days, big cities, early starts', true))];
      }
      function drawFoot2() {
        setFoot([h('button', { type: 'button', class: 'btn', onclick: () => go('where') }, '‹ Back'),
          h('button', { type: 'button', class: 'link-btn empty-start', onclick: () => createTrip({ empty: true }) }, 'Or start with an empty trip')],
          h('button', { type: 'button', class: 'btn primary', onclick: buildRoutes }, 'See my options →'));
      }

      /* ── step 3: three routes, compared in a table ── */
      async function buildRoutes() {
        hideErr(); st.busy = true; st.fopen = null; draw();
        const ask = NT.request(st.ans, ctx());
        const { data, error } = await sb.functions.invoke('draft-trip', { body: ask });
        if (!error && data && data.draft && Array.isArray(data.draft.routes) && data.draft.routes.length) {
          try { st.draft = data.draft; dropMaps(st.routes); st.routes = await prepareRoutes(data.draft.routes); st.busy = false; st.cur = 0; st.tw = null; go('routes'); return; }
          catch (e) { console.warn(e); }
        }
        st.busy = false; go('sentence');
        showErr(await errorOf(error, 'Couldn\'t make routes just now. Try again, or start with an empty trip.'));
      }
      async function errorOf(error, m) {
        try { const j = error && error.context && await error.context.json(); if (j && j.error) m = j.error; } catch (e) { /* keep the plain message */ }
        return m;
      }
      async function prepareRoutes(routes) {
        const total = lengthOf();
        const want = {};
        routes.forEach(r => r.phases.forEach(p => (p.stops || []).forEach(s => { s.place = String(s.place || '').trim(); want[s.place + '|' + (s.country || '')] = s; })));
        const keys = Object.keys(want).slice(0, 40);
        const found = await Promise.all(keys.map(k => PLACES.lookup(want[k].place, want[k].country, { lat: want[k].lat, lng: want[k].lng })));
        const at = {}; keys.forEach((k, i) => { if (found[i]) at[k] = found[i]; });
        await checkLegs(routes, at);
        return routes.map(r => {
          const fit = NT.fitNights(r.phases, total, NT.paceCap(st.ans.pace));
          const L = LAYOUT.fromDraft(r.phases, total).layout;
          const cp = NT.crucialPlans(r.phases, (r.highlights || []).concat(st.draft.shared || []));   // only the fixed days; the rest become ideas
          fillDays(L, cp.days);
          const stops = [];
          r.phases.forEach((p, pi) => (p.stops || []).forEach(s => {
            const f = at[s.place + '|' + (s.country || '')] || {};
            const lp = L.phases[pi] || L.phases[L.phases.length - 1];
            const hl = (r.highlights || []).concat(st.draft.shared || []).filter(x => x && !x.skip && String(x.place || '').toLowerCase() === s.place.toLowerCase()).map(x => x.text);
            stops.push({ place: s.place, n: s.nights, why: s.why, next: s.next || null, colour: lp ? lp.colour : '#3F5675', phase: lp ? lp.id : null, acts: actsOf((s.plans || []).concat(hl)),
              lat: f.lat, lng: f.lng, country: f.country || s.country, label: f.label });
          }));
          return { r, layout: L, stops, left: fit.left, tweak: null, ideas: cp.ideas };
        });
      }
      /* Claude picks each leg's transport from what it knows, so the overland legs are checked against real roads (Mapbox
         Directions, the same account as the maps): no road means it needs a flight or a boat; very long or very far legs, and a
         border crossing on a one-night stop, are marked to check. What's found goes on the stop as leg_flag, which the
         route table lists and the trip's travel line carries ("check locally"). Nothing here is certain, so nothing is changed. */
      const GROUND = { bus: 1.3, drive: 1, train: 1.1 };
      const roadCache = {};
      async function roadHours(a, b) {
        const k = [a.lng, a.lat, b.lng, b.lat].map(v => (+v).toFixed(3)).join(',');
        if (!(k in roadCache)) roadCache[k] = (async () => {
          if (window.SUITCASE_MAP_FAKE || !CFG.mapboxToken) return undefined;
          try {
            const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
            const res = await fetch('https://api.mapbox.com/directions/v5/mapbox/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=false&access_token=' + encodeURIComponent(CFG.mapboxToken), { signal: ctl.signal });
            clearTimeout(t);
            const j = await res.json();
            if (j.code === 'NoRoute' || j.code === 'NoSegment') return null;   // no road between them
            return j.routes && j.routes[0] ? j.routes[0].duration / 3600 : undefined;
          } catch (e) { return undefined; }   // couldn't check
        })();
        return roadCache[k];
      }
      async function checkLegs(routes, at) {
        const jobs = [];
        routes.forEach(r => {
          const list = []; r.phases.forEach(p => (p.stops || []).forEach(s => list.push(s)));
          list.forEach((s, i) => {
            const t = list[i + 1]; s.leg_flag = null; if (!t || !s.next) return; s.leg_to = t.place;
            const a = at[s.place + '|' + (s.country || '')], b = at[t.place + '|' + (t.country || '')];
            const ground = s.next in GROUND, crossing = (s.country || '') && (t.country || '') && s.country !== t.country;
            const flag = m => { if (!s.leg_flag) s.leg_flag = m; };
            if (ground && crossing && t.nights <= 1) flag('border crossing, then one night');
            if (!a || !b || a.lat == null || b.lat == null) return;
            const far = PLACES.km(a, b);
            if (ground && far > 1500) flag(Math.round(far / 100) * 100 + ' km overland');
            if (!ground) return;
            jobs.push(roadHours(a, b).then(hrs => {
              if (hrs === null) { s.leg_flag = 'no road found: may need a flight or boat'; return; }
              if (hrs === undefined) return;
              const by = hrs * GROUND[s.next];
              if (!s.hours) s.hours = Math.round(by * 2) / 2;
              if (by > 12) flag('about ' + Math.round(by) + ' h by ' + (s.next === 'drive' ? 'car' : s.next));
            }));
          });
        });
        await Promise.all(jobs);
      }
      // Put the day-by-day lines into a new layout's days, in order (days past the planned ones stay empty).
      function fillDays(L, lines) {
        let k = 0;
        L.phases.forEach(p => p.days.forEach(d => { const x = lines[k++]; if (x) { d.plan = x.plan; d.notes = x.notes; d.auto = !!(x.auto && x.plan); } }));
      }
      /* "Tweak this route": draft-trip redraws just that one route with the change typed in. */
      async function redraw(k) {
        const text = st.twText.trim(); if (!text) { st.tw = null; draw(); return; }
        const x = st.routes[k], r = x.r;
        const route = { name: r.name, tag: r.tag, pitch: r.pitch, shape: r.shape,
          phases: r.phases.map(p => ({ name: p.name, days: (p.stops || []).reduce((a, s) => a + s.nights, 0), stops: (p.stops || []).map(s => ({ place: s.place, nights: s.nights })) })) };
        hideErr(); st.redraw = k; st.tw = null; draw();
        const { data, error } = await sb.functions.invoke('draft-trip', { body: Object.assign(NT.request(st.ans, ctx()), { tweak: { text: text.slice(0, 300), route } }) });
        st.redraw = null;
        let got = !error && data && data.draft && Array.isArray(data.draft.routes) && data.draft.routes[0];
        // never swap a full route for one that covers much less of the trip
        const nights = r2 => (r2.phases || []).reduce((a, p) => a + (p.stops || []).reduce((b, s) => b + (+s.nights || 0), 0), 0);
        if (got && nights(got) < lengthOf() * 0.8) { console.warn('tweak came back short', nights(got), 'of', lengthOf()); got = null; st.twText = text; }
        if (got) {
          try { const [nx] = await prepareRoutes([got]); nx.tweak = text; dropMaps([st.routes[k]]); st.routes[k] = nx; st.twText = ''; if (st.step === 'routes') draw(); return; }
          catch (e) { console.warn(e); }
        }
        st.tw = k; draw(); showErr(await errorOf(error, 'Couldn\'t redraw that route just now. Try again in a minute.'));
      }
      function routesPart() {
        const R = st.routes;
        const col = (cls, fn) => R.map((x, k) => h('div', { class: 'cx-c ' + cls + (k === st.cur ? ' on' : ''), onclick: () => { if (st.cur !== k) { st.cur = k; if (st.tw !== k) st.tw = null; draw(); } } }, fn(x, k)));
        const row = (label, cls, fn) => [h('div', { class: 'cx-rl ' + cls }, label), ...col(cls, fn)];
        const busy = k => st.redraw === k;
        // each route's phases and stops, as their own row under the maps (no Map / List switch)
        const stopList = x => h('div', { class: 'cx-pl' }, NT.phaseList(x.r.phases, (x.r.highlights || []).concat(st.draft.shared || [])).map(g => h('div', null,
            h('div', { class: 'cx-pgh' }, g.name || 'Phase', h('span', null, plural(g.days, 'day'))),
            g.stops.map(t => h('div', { class: 'cx-ps' }, h('span', { class: 'pd' }, plural(t.nights, 'day')), h('span', null, h('b', null, t.place), t.what ? h('i', null, t.what) : null))))));
        const tweakCell = (x, k) => {
          if (k !== st.cur) return null;
          if (busy(k)) return h('span', { class: 'muted' }, 'Redrawing this route…');
          if (st.tw !== k) return [h('button', { type: 'button', class: 'twb', onclick: e => { e.stopPropagation(); st.tw = k; draw(); setTimeout(() => { const t = body.querySelector('.twt'); if (t) t.focus(); }, 0); } }, ico(FI.pen, 16), 'Tweak this route'),
            x.tweak ? h('span', { class: 'twd' }, 'Changed: ' + x.tweak) : null];
          const ta = h('textarea', { class: 'twt', maxlength: 300, placeholder: 'For example: one more night in ' + (x.stops[1] || x.stops[0] || { place: 'the mountains' }).place + ', skip a stop, end somewhere else',
            'aria-label': 'What would you change?', value: st.twText, oninput: e => { st.twText = e.target.value; }, onclick: e => e.stopPropagation() });
          return h('div', { class: 'twbox', onclick: e => e.stopPropagation() }, h('span', { class: 'twl' }, 'What would you change?'), ta,
            h('div', { class: 'twa' }, h('button', { type: 'button', class: 'btn small', onclick: () => { st.tw = null; st.twText = ''; draw(); } }, 'Cancel'),
              h('button', { type: 'button', class: 'btn small primary', onclick: () => redraw(k) }, 'Redraw this route')));
        };
        const hls = x => (x.r.highlights || []).filter(hl => !hl.skip);
        const skips = x => (x.r.highlights || []).filter(hl => hl.skip).map(hl => NT.tidy(hl.text)).join('; ');
        return [h('div', { class: 'rhdr' }, h('div', { class: 'nt-ttl' }, 'Three ways through ' + destName()), st.draft.description ? h('p', { class: 'lead' }, NT.tidy(st.draft.description)) : null),
          h('div', { class: 'cx-tb' + (R.length === 2 ? ' two' : R.length === 1 ? ' one' : '') },
            row('', 'hd', (x, k) => [h('span', { class: 'cx-nm', role: 'radio', 'aria-checked': String(k === st.cur), tabindex: '0',
              onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.cur = k; draw(); } } }, h('span', { class: 'cx-radio', 'aria-hidden': 'true' }), NT.tidy(x.r.name)),
              x.r.tag ? h('span', null, h('span', { class: 'cx-tag' }, NT.tidy(x.r.tag))) : null]),
            row('', 'mp', x => busy(R.indexOf(x)) ? h('div', { class: 'cx-map none' }, h('div', { class: 'spinner', 'aria-hidden': 'true' })) : routeMap(x)),
            row('Only this one', '', x => h('span', { class: 'cx-only' }, NT.tidy(x.r.only || x.r.pitch))),
            row('Highlights', '', x => hls(x).map(hl => h('span', { class: 'cx-hl' }, svg(hlIcon(hl.kind, 18)), h('span', null, NT.tidy(hl.text))))),
            row('Leaves out', '', x => h('span', { class: 'cx-minus' }, skips(x) || '–')),
            row('Getting around', '', x => h('span', { class: 'cx-meta' }, plural(x.stops.reduce((a, s) => a + s.n, 0), 'night') + (x.left ? ' · ' + plural(x.left, 'day') + ' to plan' : ''),
              h('br'), NT.travelText(x.stops.map(s => ({ next: s.next }))) || 'One base',
              (() => { const fl = []; x.r.phases.forEach(p => (p.stops || []).forEach((s, i, a) => { if (s.leg_flag) fl.push(s); })); if (!fl.length) return null;
                return h('span', { class: 'cx-chk', title: 'Checked against real roads where possible. Worth confirming locally.' }, h('br'), '⚠ ' + plural(fl.length, 'leg') + ' to check: ',
                  fl.map(s => s.place + ' → ' + s.leg_to + ': ' + s.leg_flag).join('; ')); })(),
              h('br'), (() => { const a = x.stops[0], b = x.stops[x.stops.length - 1]; if (!a || !b) return '';
                return x.r.shape === 'loop' || a.place === b.place ? 'Loop from ' + a.place : 'Into ' + a.place + ', out of ' + b.place; })())),
            row('Stops', '', stopList),
            row('', 'ft', tweakCell))];
      }
      /* One Mapbox GL map per route, kept with the route so picking a column or switching Map/List doesn't rebuild it.
         Without GL (no WebGL, or the tests) each route gets a still image instead. */
      let glFailed = false;
      function routeMap(x) {
        if (x.mapEl) { if (x.gl) setTimeout(() => x.gl.resize(), 0); return x.mapEl; }
        const el = x.mapEl = h('div', { class: 'cx-map', 'aria-label': 'Map of ' + NT.tidy(x.r.name), role: 'img' });
        const still = () => { const url = PLACES.staticMap(x.stops, 360, 200, { curve: true });
          el.replaceChildren(url ? h('img', { class: 'cx-img', src: url, alt: 'Map of ' + NT.tidy(x.r.name), width: 360, height: 200, loading: 'lazy' }) : ''); };
        const pts = x.stops.filter(s => s.lat != null);
        if (glFailed || !pts.length) { still(); return el; }
        loadGL().then(mb => {
          if (!el.isConnected) { x.mapEl = null; return; }   // moved on before the map code arrived
          mb.accessToken = CFG.mapboxToken;
          const m = x.gl = new mb.Map({ container: el, style: 'mapbox://styles/mapbox/light-v11', bounds: boundsOf(pts), fitBoundsOptions: { padding: 50, maxZoom: 9 },
            dragRotate: false, pitchWithRotate: false, cooperativeGestures: true, attributionControl: false });
          // The pop-up grows to full width as step 3 opens, so the map is made while its cell is still narrow:
          // follow the cell's size, or the map stays drawn at that first width.
          if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (x.gl === m) m.resize(); }); ro.observe(el); m.on('remove', () => ro.disconnect()); }
          m.addControl(new mb.NavigationControl({ showCompass: false }), 'top-right');
          m.addControl(new mb.AttributionControl({ compact: true }), 'bottom-right');
          const legs = [];
          x.stops.forEach((s, i) => { const t = x.stops[i + 1]; if (t && s.lat != null && t.lat != null)
            legs.push({ type: 'Feature', properties: { mode: s.next || '' }, geometry: { type: 'LineString', coordinates: PLACES.curved([s, t]).map(p => [p[1], p[0]]) } }); });
          const pins = pts.map((s, i) => ({ type: 'Feature', properties: { c: s.colour, end: i === 0 || i === pts.length - 1, name: s.place }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }));
          m.on('load', () => {
            m.resize(); m.fitBounds(boundsOf(pts), { padding: 50, maxZoom: 9, duration: 0 });
            m.addSource('legs', { type: 'geojson', data: { type: 'FeatureCollection', features: legs } });
            m.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: pins } });
            addLegLayers(m, 'legs', 'legs', '#3F5675', 2.5);
            mapDeco(mb, m, legs.map(f => ({ coords: f.geometry.coordinates, mode: f.properties.mode })), pts.map(s => ({ lng: s.lng, lat: s.lat, acts: s.acts })), '#3F5675', true);
            m.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: { 'circle-radius': ['case', ['get', 'end'], 6, 4.5], 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
            m.addLayer({ id: 'names', type: 'symbol', source: 'pins', layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
              paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
          });
        }).catch(e => { glFailed = true; if (!/fake/.test(e.message || '')) console.warn('map', e); still(); });
        return el;
      }
      const boundsOf = pts => {
        let a = [180, 90], b = [-180, -90];
        pts.forEach(p => { a = [Math.min(a[0], p.lng), Math.min(a[1], p.lat)]; b = [Math.max(b[0], p.lng), Math.max(b[1], p.lat)]; });
        if (a[0] === b[0] && a[1] === b[1]) { a = [a[0] - 1, a[1] - 1]; b = [b[0] + 1, b[1] + 1]; }
        return [a, b];
      };
      const dropMaps = list => (list || []).forEach(x => { if (x.gl) { x.gl.remove(); x.gl = null; } x.mapEl = null; });
      box.onClose = () => dropMaps(st.routes);

      function drawFoot3() {
        const x = st.routes[st.cur], idle = st.tw !== st.cur && st.redraw === null;
        setFoot(h('button', { type: 'button', class: 'btn', onclick: () => { st.tw = null; go('sentence'); } }, '‹ Back to your answers'),
          idle ? [h('span', { class: 'muted' }, 'Picked: ', h('b', { class: 'ink' }, NT.tidy(x.r.name))),
            h('button', { type: 'button', class: 'btn primary', onclick: () => createTrip({ route: x }) }, 'Build my trip from this →')] : null);
      }

      /* ── import: pasted rows or a .csv / .xlsx file ── */
      const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,text/csv', style: { display: 'none' },
        onchange: async () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) await readFile(f); } });
      async function readFile(f) {
        const im = st.imp; im.msg = null; im.plan = null;
        try {
          let rows;
          if (/\.xlsx$/i.test(f.name)) rows = await NT.readXlsx(await f.arrayBuffer(), inflate);
          else if (/\.(csv|tsv|txt)$/i.test(f.name) || /text/.test(f.type)) rows = NT.parseDelimited(await f.text());
          else { im.msg = 'Only .csv and .xlsx files for now. PDFs, Word files and links are coming soon.'; draw(); return; }
          im.file = f.name; im.text = '';
          await planFrom(rows);
        } catch (e) { im.file = null; im.msg = e.message || 'Couldn\'t read that file.'; draw(); }
      }
      async function inflate(bytes) {
        const ds = new DecompressionStream('deflate-raw');
        const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
        return new Uint8Array(await out.arrayBuffer());
      }
      let impTimer = null;
      async function planFrom(rows) {
        const im = st.imp, p = NT.planFromRows(rows);
        if (p.error) { im.plan = null; im.msg = p.error; draw(); return; }
        // No phase column: find the places and group them by country, like stops typed into the Planner.
        if (!p.phases.some(ph => ph.name)) {
          const all = []; p.phases.forEach(ph => ph.stops.forEach(s => all.push(s)));
          const uniq = Array.from(new Set(all.map(s => s.place))).slice(0, 40);
          im.msg = 'Finding ' + plural(uniq.length, 'place') + ' on the map…'; draw();
          const found = await Promise.all(uniq.map(n => PLACES.lookup(n)));
          const at = {}; uniq.forEach((n, i) => { if (found[i]) at[n] = found[i]; });
          const phases = [];
          all.forEach(s => {
            const f = at[s.place]; if (f) Object.assign(s, { lat: f.lat, lng: f.lng, country: f.country, label: f.label });
            const name = (f && f.country) || null, last = phases[phases.length - 1];
            if (last && (last.name === name || !name)) last.stops.push(s); else phases.push({ name, stops: [s] });
          });
          p.phases = phases;
        }
        im.plan = p; im.msg = null; draw();
      }
      function importPart() {
        const im = st.imp, p = im.plan;
        const ta = h('textarea', { class: 'input imp-ta', placeholder: 'Paste rows from a spreadsheet, for example:\nLisbon\t3\nPorto\t2', 'aria-label': 'Your plan', value: im.text,
          oninput: e => { im.text = e.target.value; im.file = null; clearTimeout(impTimer);
            impTimer = setTimeout(() => {
              const t = im.text.trim();
              if (!t) { im.plan = null; im.msg = null; draw(); return; }
              if (/^https?:\/\//i.test(t)) { im.plan = null; im.msg = 'Links are coming soon. For a Google Sheet, use File → Download → .csv and upload it here.'; draw(); return; }
              planFrom(NT.parseDelimited(t));
            }, 500); } });
        const drop = h('button', { type: 'button', class: 'impdrop' + (im.file ? ' has' : ''), onclick: () => fileIn.click(),
          ondragover: e => { e.preventDefault(); }, ondrop: e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); } },
          svg('<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>'),
          h('span', null, im.file ? im.file + ' · choose another' : 'Upload a spreadsheet · .csv or .xlsx'));
        let preview = null;
        if (p) {
          const nStops = p.phases.reduce((a, ph) => a + ph.stops.length, 0);
          preview = h('div', { class: 'imp-prev' },
            h('strong', null, 'Found ' + plural(nStops, 'stop') + ' · ' + plural(p.days, 'day') + (p.start ? ' from ' + fmtD(p.start) : '')),
            h('div', { class: 'imp-list' }, p.phases.map(ph => h('div', null, h('b', null, (ph.name || 'Phase') + ': '),
              ph.stops.map(s => s.place + ' (' + s.nights + ')').join(', ')))));
        }
        return [h('div', { class: 'nt-ttl' }, 'Bring in a plan you already have'), ta, drop, fileIn,
          h('p', { class: 'muted imp-help' }, 'Paste rows copied from a spreadsheet, or upload a .csv or .xlsx file. One row per stop with its nights, or one row per day: both work. A “Phase” or “Region” column keeps your own phases. Links, PDFs and Word files are coming soon.'),
          im.msg ? h('div', { class: 'notice' }, im.msg) : null, preview];
      }
      function drawFoot4() {
        setFoot(h('button', { type: 'button', class: 'btn', onclick: () => go('where') }, '‹ Back'),
          h('button', { type: 'button', class: 'btn primary', disabled: !st.imp.plan, onclick: () => createTrip({ plan: st.imp.plan }) }, 'Import plan →'));
      }

      /* ── drawing ── */
      function go(step) { st.step = step; hideErr(); body.scrollTop = 0; draw(); if (step === 'where') setTimeout(() => dest.focus(), 30); }
      function draw() {
        const big = st.step === 'routes' && !st.busy;
        box.classList.toggle('big', big);
        lbl.textContent = st.step === 'import' ? 'New trip · Import a plan' : 'New trip · ' + ({ where: 1, sentence: 2, routes: 3 }[st.step]) + ' of 3';
        if (st.busy) {
          body.replaceChildren(h('div', { class: 'busy' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', null, 'Drawing up three routes…'),
            h('span', { class: 'muted' }, destName() + ', ' + plural(lengthOf(), 'day') + (lengthOf() > 45 ? '. Long trips take a minute or two.' : lengthOf() > 20 ? '. This takes up to a minute.' : '. This takes about 20 seconds.'))));
          foot.replaceChildren(); return;
        }
        if (st.step === 'where') {
          datesBox.replaceChildren(...datesPart().filter(Boolean));
          if (where.parentNode !== body || body.children.length !== 2) body.replaceChildren(where, datesBox);
          if (st.cal) { const p = body.querySelector('.rp-pop'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest' }); }
          drawFoot1();
        } else if (st.step === 'sentence') { body.replaceChildren(...formPart().filter(Boolean)); drawFoot2(); }
        else if (st.step === 'routes') { body.replaceChildren(...routesPart().filter(Boolean)); drawFoot3(); }
        else { const had = document.activeElement && document.activeElement.classList.contains('imp-ta'); const pos = had && document.activeElement.selectionStart;
          body.replaceChildren(...importPart().filter(Boolean)); drawFoot4();
          if (had) { const t = body.querySelector('.imp-ta'); t.focus(); t.setSelectionRange(pos, pos); } }
      }

      /* ── save: the trip, then its phases and days in one apply_layout, and the places found ── */
      async function createTrip(o) {
        hideErr();
        const btns = box.querySelectorAll('button'); btns.forEach(b => { b.disabled = true; });
        const fail = m => { btns.forEach(b => { b.disabled = false; }); draw(); showErr(m); };
        let layout = null, stops = [], name = destName(), start = st.mode === 'exact' ? st.start : null, days = lengthOf(), subtitle = null;
        if (o.route) { layout = o.route.layout; stops = o.route.stops; subtitle = NT.tidy(o.route.r.pitch); }
        if (o.plan) {
          days = o.plan.days; start = o.plan.start || null;
          layout = LAYOUT.fromDraft(o.plan.phases, days).layout;
          fillDays(layout, NT.dayPlans(o.plan.phases, [], { travel: false }));
          o.plan.phases.forEach(ph => ph.stops.forEach(s => stops.push(s)));
          if (!name) name = st.imp.file ? st.imp.file.replace(/\.[^.]+$/, '') : (o.plan.phases[0].name || o.plan.phases[0].stops[0].place);
        }
        const fields = { name: (name || 'New trip').slice(0, 80), start_date: start, length_days: days, owner_id: session.user.id,
          destination: destName() || null, destination_places: st.picks.map(p => ({ name: p.name, kind: p.kind, country: p.country, cc: p.cc, lat: p.lat, lng: p.lng })) };
        if (subtitle) fields.subtitle = subtitle.slice(0, 300);
        let { data, error } = await sb.from('trips').insert(fields).select().single();
        if (error && /destination/.test(error.message || '')) {   // before migration 004
          delete fields.destination; delete fields.destination_places;
          ({ data, error } = await sb.from('trips').insert(fields).select().single());
        }
        if (error) { fail(errText(error)); return; }
        // what they said they like, for "For you" ideas later (needs migration 006; skipped before it)
        const ask = NT.request(st.ans, ctx()), prefs = { loves: ask.loves || [], fitness: ask.fitness || null, who: ask.who || null, pace: ask.pace || null, transport: ask.transport, noFly: ask.noFly };
        // Saved after the plan: apply_layout checks the trip hasn't changed since it was made, and this update would change it.
        // Awaited, so the planner then loads the trip as it now stands.
        const savePrefs = async () => { if (!(prefs.loves.length || prefs.fitness || prefs.transport || prefs.noFly)) return;
          const x = await sb.from('trips').update({ prefs }).eq('id', data.id); if (x && x.error) console.warn('preferences not saved', x.error.message); };
        if (!layout) await savePrefs();
        if (layout) {
          const rows = LAYOUT.toRows(layout);
          const r = await sb.rpc('apply_layout', { p_trip: data.id, p_expect: data.updated_at, p_phases: rows.phases, p_days: rows.days });
          if (r.error) { fail('The trip was made, but its plan couldn\'t be saved: ' + errText(r.error)); return; }
          await savePrefs();
          const seen = {};
          const places = stops.filter(s => s.lat != null && !seen[s.place] && (seen[s.place] = 1))
            .map(s => ({ trip_id: data.id, name: s.place, lat: s.lat, lng: s.lng, country: s.country || null, found_as: s.label || null }));
          if (places.length) sb.from('places').upsert(places, { onConflict: 'trip_id,name' }).then(x => { if (x && x.error) console.warn('places not saved', x.error.message); });
          // Prefilled days are marked (the planner shows an icon until someone edits them), and Claude's other lines are kept as ideas.
          // Both need migration 005; before it they're skipped with a warning and the trip still works.
          const autoIds = layout.phases.flatMap(p => p.days).filter(d => d.auto).map(d => d.id);
          if (autoIds.length) await sb.from('days').update({ plan_auto: true }).in('id', autoIds).then(x => { if (x && x.error) console.warn('prefilled marks not saved', x.error.message); });
          const ideas = (o.route && o.route.ideas || []).slice(0, 400).map((x, i) => ({ trip_id: data.id, place: x.place, text: x.text.slice(0, 300), source: 'route', sort: i, where_name: x.where ? x.where.slice(0, 120) : null,
            phase_id: x.phase != null && layout.phases[x.phase] ? layout.phases[x.phase].id : null }));
          // where_name needs migration 007; before it, the ideas are saved without it
          if (ideas.length) sb.from('stop_ideas').insert(ideas).then(x => { if (x && x.error && /where_name|phase_id/.test(x.error.message || '')) return sb.from('stop_ideas').insert(ideas.map(i => { const c = Object.assign({}, i); delete c.where_name; delete c.phase_id; return c; })); return x; })
            .then(x => { if (x && x.error) console.warn('ideas not saved', x.error.message); });
        } else {
          const one = st.picks.length === 1 && st.picks[0].kind === 'place' && st.dest.split(',').filter(x => x.trim()).length === 1 ? st.picks[0] : null;
          pendingStop = one;
        }
        close(); location.hash = '#/trip/' + data.id;   // close() also removes the route maps
      }

      // Escape closes the calendar or the tweak box before it closes the pop-up.
      box.addEventListener('keydown', e => { if (e.key === 'Escape' && (st.cal || st.tw !== null)) { e.stopPropagation(); st.cal = null; st.tw = null; draw(); } }, true);
      draw();
      box.append(x, lbl, body, err, foot);
    });
  }

  /* ───────────── trip page ───────────── */
  async function loadTrip(id) {
    const [t, d, p, pl, si] = await Promise.all([
      sb.from('trips').select('*').eq('id', id).maybeSingle(),
      sb.from('days').select('*').eq('trip_id', id).order('idx', { ascending: true }),
      sb.from('phases').select('*').eq('trip_id', id).order('sort', { ascending: true }),
      sb.from('places').select('name,lat,lng,country').eq('trip_id', id),
      sb.from('stop_ideas').select('*').eq('trip_id', id).order('sort', { ascending: true })
    ]);
    const err = t.error || d.error || p.error;
    if (err) throw err;
    if (!t.data) return null;
    datesFor(t.data, d.data);
    return { trip: t.data, days: d.data, phases: p.data, places: pl.error ? [] : (pl.data || []), ideas: si.error ? [] : (si.data || []) };   // no stop_ideas table yet (migration 005 not run): no ideas
  }
  // Each day's date (only on the client): the trip's start date + its position. None while the trip has no dates.
  function datesFor(trip, days) {
    days.forEach(d => { d.date = LAYOUT.dateAt(trip.start_date, d.idx); });
  }

  async function tripView(id, tab) {
    if (!tripData || tripData.trip.id !== id) {
      loading(); editingDates = false; settingStart = false; curPhase = 0; lastPhase = 0; addingPhase = false; selDay = null; selIdea = null; resetDraft(); if (pendingStop) { draft.text = pendingStop.name; draft.pick = pendingStop; pendingStop = null; }
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

  /* ───────────── Planner: phase tabs + the picked phase's card + its map ("5b" on the canvas) ─────────────
     The tabs are the phase list (click = pick), each as wide as its phase is long. The picked phase is a card
     with its stops and days; a map of its stops sits on the right. Stops are runs of days with the same place (layout.js). */
  const PLACES = window.SuitcasePlaces;
  let curPhase = 0;          // index of the phase card in focus
  let lastPhase = 0;         // for the slide-in direction
  let addingPhase = false;   // the blank "Add a phase" card is in focus
  let nightsOpen = null;
  let selDay = null;         // the day in focus: the map zooms to its stop and shows that stop's ideas
  let selIdea = null;        // the idea whose details are open in the map card     // the stop whose nights are being changed: phaseId + ':' + its first day
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
    const pick = i => { lastPhase = curPhase; curPhase = i; selDay = null; selIdea = null; addingPhase = false; openMenu = null; renderTrip('planner'); };

    /* timeline */
    const tl = h('div', { class: 'tl', role: 'tablist', 'aria-label': 'Phases' },
      L.phases.map((p, i) => {
        const st = LAYOUT.startIdx(L, i), on = i === curPhase && !blankOn;
        return h('button', { class: 'tl-ph' + (on ? ' on' : ''), role: 'tab', style: { flex: p.days.length, borderTopColor: p.colour || '#888' },
          title: LAYOUT.nameOf(L, i) + ' · ' + span(st, st + p.days.length - 1), 'aria-selected': String(on), onclick: () => pick(i) },
          h('b', null, LAYOUT.nameOf(L, i)), h('span', null, plural(p.days.length, 'day')));
      }),
      L.free.length ? h('button', { class: 'tl-free' + (blankOn ? ' on' : ''), role: 'tab', 'aria-selected': String(blankOn), style: { flex: L.free.length },
        onclick: () => { if (!n) return; lastPhase = curPhase; curPhase = n - 1; addingPhase = true; renderTrip('planner'); } },
        plural(L.free.length, 'day') + ' to plan') : null);

    /* cards */
    const main = blankOn ? startCard(L, fmt) : phaseCard(L, curPhase, fmt, true);
    const focusIdx = blankOn ? n : curPhase;
    const dir = focusIdx > lastPhase ? ' from-r' : focusIdx < lastPhase ? ' from-l' : '';
    lastPhase = focusIdx;
    const stage = h('div', { class: 'stage' }, h('div', { class: 'focus' + dir }, main));

    return h('section', { class: 'planner' },
      h('div', { class: 'planner-meta' }, saveState),
      h('div', { class: 'pl-grid' },
        h('div', { class: 'pl-main' }, tl, stage),
        phaseMap(blankOn ? null : L.phases[curPhase], blankOn ? [] : LAYOUT.stopsOf(L.phases[curPhase]).filter(s => s.place))));
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
    // the stop before this phase, so its first stop can show how you get there
    let prev = null;
    for (let k = i - 1; k >= 0 && !prev; k--) { const ss = LAYOUT.stopsOf(L.phases[k]).filter(x => x.place); if (ss.length) prev = ss[ss.length - 1].place; }
    stops.forEach(s => {
      let leg = null;
      if (s.place) {
        if (prev && prev !== s.place) leg = { from: prev, to: s.place };
        prev = s.place;
        const key = p.id + ':' + s.start, editing = live && nightsOpen === key;
        const n2 = !live ? h('span', { class: 'muted' }, plural(s.n, 'night'))
          : editing ? h('span', { class: 'n-edit' }, nights(s.n, v => tryLayout(LAYOUT.setStopNights(currentLayout(), i, s.start, v)), s.place),
              h('button', { class: 'btn small primary n-done', onclick: () => { nightsOpen = null; renderTrip('planner'); } }, 'Done'))
          : h('button', { class: 'n-btn', title: 'Change nights', 'aria-label': 'Change nights in ' + s.place + ' (' + plural(s.n, 'night') + ')',
              onclick: () => { nightsOpen = key; renderTrip('planner'); } }, plural(s.n, 'night'));
        flow.append(h('div', { class: 'f-stop' },
          h('span', { class: 'f-lbl-w' }, h('span', { class: 'f-lbl', style: { background: p.colour || '#888' } }, s.place),
            h('span', { class: 'muted f-range' }, fmt.span(st + s.start, st + s.start + s.n - 1))), n2));
      }
      // each empty day at a stop gets a different one of the stop's unplanned ideas to pick with one click
      const pool = s.place ? ideasFor(s.place, p.id).filter(x => REC(x) && !planIdx(p, s).has(normIdea(x.text))) : [];
      let emptyN = 0;
      for (let j = s.start; j < s.start + s.n; j++) {
        const sugg = live && s.place && !p.days[j].plan && pool.length ? pool[emptyN++ % pool.length] : null;
        flow.append(flowDay(L, i, j, st + j, fmt, live, !s.place, j === s.start ? leg : null, { place: s.place, sugg, first: j === s.start }));
      }
    });
    if (live) flow.append(stopRow({ placeholder: 'Add next stop', ghostFrom: st + p.days.length, fmt, lastPhase: i === L.phases.length - 1,
      onAdd: (place, pk, nn) => addStopTo(i, place, pk, nn) }));
    return h('section', { class: 'pcard' + (live ? ' live' : ''), 'data-phase': p.id, inert: live ? null : true }, head, h('div', { class: 'pc-body' }, flow));
  }
  const span3 = (fmt, st, len) => fmt.span(st, st + len - 1) + ' · ' + plural(len, 'day');

  const legMode = t => /^hike from\b/i.test(t || '') ? 'hike' : /\b(fly|flight|plane)\b/i.test(t || '') ? 'fly' : /\btrain\b/i.test(t || '') ? 'train' : /\b(bus|coach)\b/i.test(t || '') ? 'bus'
    : /\b(drive|car)\b/i.test(t || '') ? 'drive' : /\b(ferry|boat)\b/i.test(t || '') ? 'boat' : 'any';
  /* How a leg looks on a map, by how you travel it: roads and the rest solid, flights dashed, hikes dotted. */
  function addLegLayers(m, id, src, colour, w) {
    const mode = ['coalesce', ['get', 'mode'], ''], isLine = ['==', ['geometry-type'], 'LineString'];
    m.addLayer({ id, type: 'line', source: src, filter: ['all', isLine, ['!', ['in', mode, ['literal', ['fly', 'hike']]]]], paint: { 'line-color': colour, 'line-width': w }, layout: { 'line-cap': 'round' } });
    m.addLayer({ id: id + '-fly', type: 'line', source: src, filter: ['all', isLine, ['==', mode, 'fly']], paint: { 'line-color': colour, 'line-width': w * .8, 'line-dasharray': [2.5, 2] } });
    m.addLayer({ id: id + '-hike', type: 'line', source: src, filter: ['all', isLine, ['==', mode, 'hike']], paint: { 'line-color': colour, 'line-width': w * 1.2, 'line-dasharray': [0, 2] }, layout: { 'line-cap': 'round' } });   // zero dashes with round caps draw dots
  }
  const setLegColour = (m, id, c) => ['', '-fly', '-hike'].forEach(x => m.setPaintProperty(id + x, 'line-color', c));

  /* What a stop's days are for, as map icons: a day hike there (out and back to the same place) is drawn as a small
     dotted loop off its pin, the other activities as icons beside it. Read from the day lines; travel lines don't count. */
  const ACTS = [['hike', /\b(hikes?|hiking|treks?|trail|walk|summit|circuit|laguna|mirador)\b/i], ['kayak', /\b(kayak|paddl|canoe|raft)/i], ['glacier', /\bglaciers?\b/i],
    ['boat', /\b(boat|cruise|sail)/i], ['hot_springs', /hot springs?|thermal|termas/i], ['wildlife', /\b(penguins?|wildlife|whales?|condors?|birds?)\b/i], ['bike', /\b(bikes?|cycl)/i], ['wine', /\b(wine|vineyards?|winery)\b/i]];
  function actsOf(lines) {
    const out = [];
    (lines || []).forEach(t => String(t || '').split(' · ').forEach(x => { if (!x || /^(hike from|arrive|fly|bus|drive|train|boat from|ferry from|travel|last night)\b/i.test(x.trim())) return;
      const a = ACTS.find(([, re]) => re.test(x)); if (a && !out.includes(a[0])) out.push(a[0]); }));
    return out;
  }
  // Icons beside a map's legs (how you travel) and stops (what you do there), as markers so they keep their size when zooming.
  // legs: [{ coords: [[lng, lat]…], mode }]; stops: [{ lng, lat, acts }]. Returns the markers, to remove on the next draw.
  function mapDeco(mb, m, legs, stops, colour, small) {
    const merc = c => [c[0], -Math.log(Math.tan(Math.PI / 4 + c[1] * Math.PI / 360)) * 180 / Math.PI];
    const unit = (a, b) => { const p = merc(a), q = merc(b), dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const out = [], add = (el, at, off) => out.push(new mb.Marker({ element: el, offset: off }).setLngLat(at).addTo(m));
    const icon = (path, cls, label) => { const el = h('span', { class: 'mdeco ' + cls, title: label, 'aria-hidden': 'true' }); el.innerHTML = '<svg viewBox="0 0 24 24" width="' + (small ? 15 : 19) + '" height="' + (small ? 15 : 19) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>'; return el; };
    const HIKER = 'M14 4.5m-1.6 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M13 8l-2.5 5 3 3v5M10.5 13L8 21M13 8l2.5 3.5 2.5.5M18.5 10L20 21M11 9l-3 1v4';   // a walker with a pole
    const MODE_PATH = { fly: HL_ICONS.flight, train: HL_ICONS.train, boat: HL_ICONS.boat, hike: HIKER };   // no icon on bus or drive legs: they're most legs, a plain line says it
    const NAME = { fly: 'Flight', bus: 'Bus', train: 'Train', drive: 'Drive', boat: 'Boat', hike: 'Hike' };
    legs.forEach(g => {
      const path = MODE_PATH[g.mode]; if (!path || g.coords.length < 3) return;
      const k = Math.floor(g.coords.length / 2), d = unit(g.coords[k - 1], g.coords[k + 1]), o = small ? 11 : 15;
      add(icon(path, 'leg', NAME[g.mode]), g.coords[k], [Math.round(-d[1] * o), Math.round(d[0] * o)]);
    });
    stops.forEach((s, i) => {
      if (!s.acts || !s.acts.length) return;
      // point away from the legs at this stop (up when there are none)
      let vx = 0, vy = 0; [stops[i - 1], stops[i + 1]].forEach(t => { if (t && (t.lng !== s.lng || t.lat !== s.lat)) { const d = unit([s.lng, s.lat], [t.lng, t.lat]); vx += d[0]; vy += d[1]; } });
      const th = vx || vy ? Math.atan2(-vy, -vx) : -Math.PI / 2, deg = th * 180 / Math.PI + 90, R = small ? 26 : 50;
      if (s.acts.includes('hike')) {
        const el = h('span', { class: 'mdeco-loop act', 'aria-hidden': 'true' });
        el.innerHTML = '<svg viewBox="-60 -60 120 120" width="120" height="120"><path transform="rotate(' + deg.toFixed(1) + ')" d="M-3 -9C-22 -' + Math.round(R * .45) + ' -13 -' + R + ' 0 -' + R + 'C13 -' + R + ' 22 -' + Math.round(R * .45) + ' 3 -9" fill="none" stroke="' + colour + '" stroke-width="' + (small ? 2.5 : 3) + '" stroke-linecap="round" stroke-dasharray="0 ' + (small ? 4.5 : 5.5) + '"/></svg>';
        add(el, [s.lng, s.lat], [0, 0]);
        add(icon(HIKER, 'act', 'Day hikes'), [s.lng, s.lat], [Math.round(Math.cos(th) * (R + 9)), Math.round(Math.sin(th) * (R + 9))]);
      }
      s.acts.filter(a => a !== 'hike').slice(0, 2).forEach((a, j) => {
        const t = th + (j ? -1 : 1) * 0.9, r2 = R - 6;
        add(icon(HL_ICONS[a] || HL_ICONS.other, 'act', a.replace('_', ' ')), [s.lng, s.lat], [Math.round(Math.cos(t) * r2), Math.round(Math.sin(t) * r2)]);
      });
    });
    return out;
  }
  const LI = d => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  const LEG_ICON = { fly: LI('M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z'),
    bus: LI('M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2s-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3M9 18h5M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'),
    train: LI('M8 3h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM5 11h14M8 21l2-3M16 21l-2-3M9 15h.01M15 15h.01'),
    drive: LI('M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 14v7M10 12L3.3 10M14 12l6.7-2'),
    boat: LI('M2 18h20a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zM21 14L10 2 3 14h18zM10 2v16'),
    hike: LI('M8 3l4 8 5-5 5 15H2L8 3z'),
    any: LI('M5 12h14M13 6l6 6-6 6') };

  /* Ideas for a stop: the route's other suggestions (stop_ideas), by place. A day's plan can hold several, joined with " · ". */
  const normIdea = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // a stop's ideas: its place, and its phase when the idea has one that still exists (a place visited twice keeps them apart)
  const ideasFor = (place, phaseId) => { const live = new Set((tripData.phases || []).map(p => p.id));
    return (tripData.ideas || []).filter(x => x.place === place && (!phaseId || !x.phase_id || x.phase_id === phaseId || !live.has(x.phase_id))); };
  const planParts = t => String(t || '').split(' · ').map(normIdea).filter(Boolean);
  const planIdx = (p, s) => { const set = new Set(); for (let j = s.start; j < s.start + s.n; j++) planParts(p.days[j].plan).forEach(x => set.add(x)); return set; };
  // "Grey Glacier boat — best on a clear morning (½ day)" → a title, a note and how long it takes
  function ideaParts(t) {
    let x = String(t || '').trim(), len = ''; const m = x.match(/\s*\(([^()]{1,24})\)\s*$/); if (m) { len = m[1]; x = x.slice(0, m.index); }
    const k = x.search(/\s[—–-]\s|:\s/);
    return k > 0 ? { title: x.slice(0, k).trim(), why: x.slice(k).replace(/^\s*[—–:-]\s*/, '').trim(), len } : { title: x, why: '', len };
  }
  const selDayName = idx => (tripData.trip.start_date ? md(LAYOUT.dateAt(tripData.trip.start_date, idx)) : 'Day ' + (idx + 1));
  function setDayPlan(id, v) {
    const row = tripData.days.find(x => x.id === id); if (!row) return;
    row.plan = v || null; const patch = { plan: row.plan };
    if (row.plan_auto) { row.plan_auto = false; patch.plan_auto = false; }
    saveDayField(id, patch); renderTrip('planner');
  }
  // the selected day's phase, stop and position (null when it isn't a day at a stop in the open phase)
  function selInfo() {
    if (!selDay) return null;
    const L = currentLayout(), p = L.phases[curPhase]; if (!p) return null;
    const j = p.days.findIndex(x => x.id === selDay); if (j < 0) return null;
    const s = LAYOUT.stopsOf(p).find(x => j >= x.start && j < x.start + x.n); if (!s || !s.place) return null;
    return { L, p, j, s, st: LAYOUT.startIdx(L, curPhase) };
  }
  function selectDay(id) {
    if (selDay === id) return;
    selDay = id; selIdea = null; selCat = null;
    document.querySelectorAll('.pcard.live .f-row[data-day]').forEach(r => r.classList.toggle('sel', r.dataset.day === id));
    paintSel();
  }
  const placeAt = () => { const at = {}; (tripData.places || []).forEach(x => { if (x.lat != null) at[x.name] = x; }); return at; };

  /* Map of the picked phase's stops, right of the card, with the rest of the trip as muted lines. One Mapbox GL map,
     kept across renders and redrawn when the stops change; a still image without GL (no WebGL, or the tests).
     Selecting a day zooms to its stop and shows the stop's ideas: lettered markers around it and a card to add them. */
  const pmap = { el: null, gl: null, mb: null, key: null, still: false, marks: [], deco: [], bounds: null, zoomed: false, card: null, tag: null };
  function phaseMap(p, stops) {
    if (!p) return h('div', { class: 'pmap empty' }, h('span', { class: 'muted' }, 'Add a stop to see it on the map.'));
    const at = placeAt(), L = currentLayout();
    // each point carries how you get there, read from its stop's first day ("Fly from …", "Hike from …")
    const pts = []; stops.forEach(s => { const x = at[s.place]; if (x && !(pts.length && pts[pts.length - 1].place === s.place)) pts.push({ place: s.place, lat: x.lat, lng: x.lng, mode: legMode(p.days[s.start] && p.days[s.start].plan) }); });
    // what's done at each place this phase, for the map's activity icons (a day hike draws a loop)
    pts.forEach(x => { const lines = []; stops.forEach(s => { if (s.place === x.place) for (let j = s.start; j < s.start + s.n; j++) lines.push(p.days[j].plan); }); x.acts = actsOf(lines); });
    if (!pts.length) return h('div', { class: 'pmap empty' }, h('span', { class: 'muted' }, stops.length ? 'These stops aren’t on the map yet.' : 'Add a stop to see it on the map.'));
    // the whole trip in order, to draw the other phases (and the legs into and out of this one) muted
    const all = []; L.phases.forEach((q, i) => LAYOUT.stopsOf(q).forEach(s => { const x = at[s.place]; if (x && !(all.length && all[all.length - 1].place === s.place)) all.push({ i, place: s.place, lat: x.lat, lng: x.lng, mode: legMode(q.days[s.start] && q.days[s.start].plan) }); }));
    const key = p.id + '|' + p.colour + '|' + pts.map(x => x.place).join('>') + '|' + all.map(x => x.i + x.place + x.mode).join('>') + '|' + pts.map(x => x.acts.join(',')).join('>');
    if (!pmap.el) {
      pmap.el = h('div', { class: 'pmap-in', role: 'img' });
      pmap.tag = h('span', { class: 'pmap-tag' });
      pmap.card = h('div', { class: 'pmi hidden', role: 'region' });
    }
    pmap.el.setAttribute('aria-label', 'Map of the stops in this phase: ' + pts.map(x => x.place).join(', '));
    pmap.phaseTag = LAYOUT.nameOf(L, curPhase);
    pmap.nStops = stops.length;
    const box = h('div', { class: 'pmap' }, pmap.el, pmap.tag, pmap.card);
    const bounds = () => { let a = [180, 90], b = [-180, -90]; pts.forEach(x => { a = [Math.min(a[0], x.lng), Math.min(a[1], x.lat)]; b = [Math.max(b[0], x.lng), Math.max(b[1], x.lat)]; });
      if (a[0] === b[0] && a[1] === b[1]) { a = [a[0] - 1, a[1] - 1]; b = [b[0] + 1, b[1] + 1]; } return [a, b]; };
    pmap.bounds = bounds();
    if (pmap.key === key) { if (pmap.gl) setTimeout(() => pmap.gl.resize(), 0); setTimeout(paintSel, 0); return box; }
    pmap.key = key; pmap.zoomed = false;
    const colour = p.colour || '#3F5675';
    const still = () => { const url = PLACES.staticMap(pts.map(x => Object.assign({ colour }, x)), 380, 560, { curve: true });
      pmap.el.replaceChildren(url ? h('img', { class: 'pmap-img', src: url, alt: '' }) : ''); };
    const line = (a, b) => ({ type: 'Feature', properties: { mode: b.mode }, geometry: { type: 'LineString', coordinates: PLACES.curved([a, b]).map(c => [c[1], c[0]]) } });
    const data = () => ({
      legs: { type: 'FeatureCollection', features: pts.slice(1).map((x, k) => line(pts[k], x)) },
      other: { type: 'FeatureCollection', features: all.slice(1).map((x, k) => (all[k].i === curPhase && x.i === curPhase) || all[k].place === x.place ? null : line(all[k], x)).filter(Boolean)
        .concat(all.filter(x => x.i !== curPhase).map(x => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x.lng, x.lat] } }))) },
      pins: { type: 'FeatureCollection', features: pts.map((x, k) => ({ type: 'Feature', properties: { n: String(k + 1), name: x.place }, geometry: { type: 'Point', coordinates: [x.lng, x.lat] } })) }
    });
    setTimeout(paintSel, 0);
    if (pmap.still) { still(); return box; }
    loadGL().then(mb => {
      pmap.mb = mb;
      const paint = m => { const d = data(); m.getSource('legs').setData(d.legs); m.getSource('pins').setData(d.pins); m.getSource('other').setData(d.other);
        setLegColour(m, 'legs', colour); m.setPaintProperty('pins', 'circle-color', colour);
        m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
        if (!selInfo()) m.fitBounds(pmap.bounds, { padding: 75, maxZoom: 9, duration: pmap.drawn ? 500 : 0 });
        deco(m); pmap.drawn = true; paintSel(); };
      const deco = m => { pmap.deco.forEach(x => x.remove()); const d = data();
        pmap.deco = mapDeco(mb, m, d.legs.features.map((f, k) => ({ coords: f.geometry.coordinates, mode: pts[k + 1].mode })), pts, colour); };
      if (pmap.gl) { if (pmap.gl.loaded()) paint(pmap.gl); else pmap.gl.once('load', () => paint(pmap.gl)); setTimeout(() => pmap.gl.resize(), 0); return; }
      mb.accessToken = CFG.mapboxToken;
      const m = pmap.gl = new mb.Map({ container: pmap.el, style: 'mapbox://styles/mapbox/light-v11', bounds: pmap.bounds, fitBoundsOptions: { padding: 75, maxZoom: 9 },
        dragRotate: false, pitchWithRotate: false, cooperativeGestures: true, attributionControl: false });
      m.addControl(new mb.NavigationControl({ showCompass: false }), 'top-right');
      m.addControl(new mb.AttributionControl({ compact: true }), 'bottom-right');
      if (window.ResizeObserver) new ResizeObserver(() => m.resize()).observe(pmap.el);
      m.on('load', () => {
        const d = data();
        m.addSource('other', { type: 'geojson', data: d.other }); m.addSource('legs', { type: 'geojson', data: d.legs }); m.addSource('pins', { type: 'geojson', data: d.pins });
        addLegLayers(m, 'other', 'other', '#B9C4CC', 2);
        m.addLayer({ id: 'other-dots', type: 'circle', source: 'other', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#B9C4CC' } });
        addLegLayers(m, 'legs', 'legs', colour, 2.5);
        m.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: { 'circle-radius': 10, 'circle-color': colour, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        m.addLayer({ id: 'nums', type: 'symbol', source: 'pins', layout: { 'text-field': ['get', 'n'], 'text-size': 11, 'text-allow-overlap': true }, paint: { 'text-color': '#fff' } });
        m.addLayer({ id: 'names', type: 'symbol', source: 'pins', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
          paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
        deco(m); pmap.drawn = true; m.resize(); paintSel();
      });
    }).catch(e => { pmap.still = true; if (!/fake/.test(e.message || '')) console.warn('map', e); still(); });
    return box;
  }

  // The map's label, its ideas card and markers, and its zoom, for the selected day (or the whole phase).
  /* "Find more" for a stop: For you (from the trip's saved interests) and Top visited. stop-ideas asks Claude once per
     place (shared cache), and the results are kept with the trip in stop_ideas, so opening them again costs nothing. */
  const CATS = { you: { label: 'For you', icon: '✦', sub: 'Picked from what you like' }, top: { label: 'Top visited', icon: '★', sub: 'What most people see here' } };
  const REC = x => !x.source || x.source === 'route' || x.source === 'mine' || x.source === 'claude';
  const prefLabels = () => { const p = tripData.trip.prefs || {}; const out = (p.loves || []).slice();
    if (p.fitness && /hike|trek|adventure/i.test(p.fitness)) out.push(String(p.fitness).toLowerCase());
    return out.map(x => String(x).toLowerCase()).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 8); };
  /* For trips made before interests were saved (or without any): pick them here, once for the whole trip. */
  let prefDraft = null;
  function prefPicker() {
    const p = tripData.trip.prefs || {};
    if (!prefDraft) prefDraft = { loves: (p.loves || []).slice(), fitness: p.fitness || null };
    const NTF = window.SuitcaseNewTrip.FORM;
    const chip = (on, label, fn) => h('button', { type: 'button', class: 'pmi-pref' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, label);
    const save = async () => {
      const prefs = Object.assign({}, p, { loves: prefDraft.loves, fitness: prefDraft.fitness });
      const { error } = await sb.from('trips').update({ prefs }).eq('id', tripData.trip.id);
      if (error) { console.warn('preferences not saved', error.message); }   // still used for this visit
      tripData.trip.prefs = prefs; prefDraft = null; paintSel();
    };
    const any = prefDraft.loves.length || (prefDraft.fitness && /hike|trek|adventure/i.test(prefDraft.fitness));
    return [h('p', { class: 'pmi-why' }, 'Pick a few. They’re saved with this trip and used for For you at every stop.'),
      h('div', { class: 'pmi-prefs' }, ...NTF.loves.map(x => chip(prefDraft.loves.includes(x), x, () => { const i = prefDraft.loves.indexOf(x); if (i < 0) prefDraft.loves.push(x); else prefDraft.loves.splice(i, 1); paintSel(); }))),
      h('div', { class: 'pmi-prefs' }, ...NTF.fitness.map(x => chip(prefDraft.fitness === x, x, () => { prefDraft.fitness = prefDraft.fitness === x ? null : x; paintSel(); }))),
      h('div', null, h('button', { class: 'btn small primary', disabled: !any, onclick: save }, 'Show ideas for me'))];
  }
  let selCat = null;            // the open "Find more" list (you / top), or null for the card's top view
  const moreBusy = {}, moreErr = {};
  async function findMore(S, cat) {
    const k = S.s.place + '|' + cat; if (moreBusy[k]) return;
    moreBusy[k] = true; delete moreErr[k]; paintSel();
    const at = placeAt()[S.s.place] || {}, d0 = LAYOUT.dateAt(tripData.trip.start_date, S.st + S.s.start);
    const have = ideasFor(S.s.place, S.p.id).map(x => x.text);
    const { data, error } = await sb.functions.invoke('stop-ideas', { body: { kind: cat, place: S.s.place, country: at.country || '', month: d0 ? +d0.slice(5, 7) - 1 : null, prefs: cat === 'you' ? prefLabels() : [], have } });
    delete moreBusy[k];
    if (error || !data || !Array.isArray(data.ideas)) {
      let m = 'Couldn’t find ideas just now. Try again in a minute.';
      try { const j = error && error.context && await error.context.json(); if (j && j.error) m = j.error; } catch (e) { /* keep the plain message */ }
      moreErr[k] = m; paintSel(); return;
    }
    const seen = new Set(have.map(normIdea));
    const rows = data.ideas.filter(x => x && x.title && !seen.has(normIdea(x.title)) && seen.add(normIdea(x.title))).map((x, i) => ({ trip_id: tripData.trip.id, place: S.s.place, text: x.title.slice(0, 300),
      note: x.note ? x.note.slice(0, 300) : null, len: x.len ? x.len.slice(0, 40) : null, reason: x.because ? ('You like ' + x.because).slice(0, 80) : null, source: cat, sort: 1000 + i, where_name: x.where ? String(x.where).slice(0, 120) : null, phase_id: S.p.id }));
    if (rows.length) {
      let ins = await sb.from('stop_ideas').insert(rows).select();
      if (ins.error && /where_name|phase_id/.test(ins.error.message || '')) ins = await sb.from('stop_ideas').insert(rows.map(x => { const c = Object.assign({}, x); delete c.where_name; delete c.phase_id; return c; })).select();   // before migration 007
      if (ins.error) { console.warn('ideas not saved', ins.error.message); rows.forEach((x, i) => { x.id = 'tmp-' + cat + '-' + Date.now() + '-' + i; }); }   // still shown this time
      (tripData.ideas = tripData.ideas || []).push(...(ins.error ? rows : ins.data));
    } else moreErr[k] = 'Nothing new turned up for ' + S.s.place + '.';
    paintSel();
  }

  // The map's label, its ideas card and markers, and its zoom, for the selected day (or the whole phase).
  /* Where each idea is: its place name (or, without one, its title) looked up near the stop. Only a match within 40 km
     (25 km by title) counts; the rest stay in the list without a pin. Saved with the idea (migration 007), so it's looked up once. */
  const geoBusy = {};
  async function placeIdeas(place) {
    const at = placeAt()[place]; if (!at || geoBusy[place]) return;
    const todo = ideasFor(place).filter(x => x.lat == null && !x.geo_tried); if (!todo.length) return;
    geoBusy[place] = true;
    for (const x of todo) {
      const q = x.where_name || ideaParts(x.text).title;
      const hit = await PLACES.findNear(q, at, x.where_name ? 40 : 25);
      x.geo_tried = true; if (hit) { x.lat = hit.lat; x.lng = hit.lng; }
      if (!String(x.id).startsWith('tmp-')) sb.from('stop_ideas').update({ lat: x.lat == null ? null : x.lat, lng: x.lng == null ? null : x.lng, geo_tried: true }).eq('id', x.id)
        .then(u => { if (u && u.error && !/geo_tried|lat|column/.test(u.error.message || '')) console.warn('idea place not saved', u.error.message); });
    }
    delete geoBusy[place];
    const S2 = selInfo(); if (S2 && S2.s.place === place) paintSel();
  }

  function paintSel() {
    if (!pmap.card || !pmap.card.isConnected) return;
    const S = selInfo(), all = S ? ideasFor(S.s.place, S.p.id) : [];
    const rec = all.filter(REC).slice(0, 6), cats = S ? ['you', 'top'] : [];
    if (S) setTimeout(() => placeIdeas(S.s.place), 0);
    if (selCat && !cats.includes(selCat)) selCat = null;
    const whole = () => { selDay = null; selIdea = null; selCat = null; document.querySelectorAll('.pcard.live .f-row.sel').forEach(r => r.classList.remove('sel')); paintSel(); };
    pmap.tag.replaceChildren(...[S ? pmap.phaseTag + ' · ' + S.s.place : pmap.phaseTag + ' · ' + plural(pmap.nStops, 'stop'),
      S ? h('button', { class: 'pmap-z', onclick: whole }, 'Whole phase') : null].filter(Boolean));
    let rows = [];
    if (S) {
      const day = S.p.days[S.j], mine = planParts(day.plan), dn = selDayName(S.st + S.j);
      let pin = 0;   // letters go to ideas with a place on the map, in list order
      const row = (x, k, onMap) => {
        const pinned = x.lat != null && x.lng != null;
        const n = normIdea(x.text), here = mine.includes(n), other = [];
        for (let jj = S.s.start; jj < S.s.start + S.s.n; jj++) if (jj !== S.j && planParts(S.p.days[jj].plan).includes(n)) other.push(selDayName(S.st + jj));
        const parts = x.note || x.len ? { title: x.text, why: x.note || '', len: x.len || '' } : ideaParts(x.text);
        return Object.assign({ id: x.id, text: x.text, lat: pinned ? x.lat : null, lng: pinned ? x.lng : null, letter: pinned ? 'ABCDEFGHIJ'[pin++] : '•', reason: x.reason || '', here, other, st: here ? 'here' : other.length ? 'else' : 'new',
          status: here ? 'In ' + dn : other.length ? 'Planned on ' + other.join(', ') : '' }, parts);
      };
      rows = rec.map((x, k) => row(x, k, true));
      const more = selCat ? all.filter(x => x.source === selCat).map((x, k) => row(x, k, false)) : [];
      pmap.morePins = more;   // an open Find more list pins its ideas too
      const add = x => { const cur = tripData.days.find(d => d.id === day.id) || day; if (planParts(cur.plan).includes(normIdea(x.text))) return;   // a double click adds it once
        setDayPlan(day.id, cur.plan ? cur.plan + ' · ' + x.text : x.text); };
      const remove = x => setDayPlan(day.id, String(day.plan || '').split(' · ').filter(t => normIdea(t) !== normIdea(x.text)).join(' · '));
      const mk = x => h('span', { class: 'pmi-l ' + x.st, 'aria-hidden': 'true' }, x.here ? '✓' : x.letter);
      const open = x => { selIdea = x.id; paintSel(); };
      const tag = x => x.reason ? h('span', { class: 'pmi-rs' }, h('span', { 'aria-hidden': 'true' }, '✦ '), x.reason) : null;
      const list = xs => xs.map(x => h('div', { class: 'pmi-r' + (x.here ? ' in' : ''), role: 'button', tabindex: '0', title: 'Details', onclick: () => open(x), onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(x); } },
        mk(x), h('span', { class: 'pmi-c' }, ...[h('span', { class: 'pmi-t' }, x.title), tag(x), h('span', { class: 'pmi-w' }, x.status ? h('b', null, x.status) : null, x.status && (x.why || x.len) ? ' · ' : '', x.why || x.len)].filter(Boolean)),
        h('button', { class: 'f-use', 'aria-label': (x.here ? 'Remove ' : 'Add ') + x.title + (x.here ? ' from ' : ' to ') + dn, onclick: e => { e.stopPropagation(); if (x.here) remove(x); else add(x); } }, x.here ? 'Remove' : 'Add')));
      const cur = rows.concat(more).find(x => x.id === selIdea);
      let kids;
      if (cur) kids = [
        h('button', { class: 'pmi-back', onclick: () => { selIdea = null; paintSel(); } }, selCat ? '‹ ' + CATS[selCat].label : '‹ All ideas'),
        h('div', { class: 'pmi-dt' }, mk(cur), h('strong', null, cur.title)), tag(cur),
        cur.why ? h('p', { class: 'pmi-why' }, cur.why) : null,
        cur.len || cur.status ? h('span', { class: 'pmi-w' }, cur.len ? 'Takes ' + cur.len : '', cur.len && cur.status ? ' · ' : '', cur.status ? h('b', null, cur.status) : null) : null,
        h('div', null, cur.here ? h('button', { class: 'btn small', onclick: () => remove(cur) }, 'Remove from ' + dn)
          : h('button', { class: 'btn small primary', onclick: () => add(cur) }, cur.other.length ? 'Add to ' + dn + ' too' : 'Add to ' + dn))];
      else if (selCat === 'you' && !prefLabels().length) kids = [h('button', { class: 'pmi-back', onclick: () => { selCat = null; paintSel(); } }, '‹ Back'),
        h('div', { class: 'pmi-h' }, h('span', { class: 'f-sgi', 'aria-hidden': 'true' }, '✦'), 'What do you like?'), ...prefPicker()];
      else if (selCat) {
        const k = S.s.place + '|' + selCat, busy = moreBusy[k], err = moreErr[k];
        if (!more.length && !busy && !err) setTimeout(() => findMore(S, selCat), 0);   // first time this list is opened for this stop
        kids = [h('button', { class: 'pmi-back', onclick: () => { selCat = null; paintSel(); } }, '‹ Back'),
          h('div', { class: 'pmi-h' }, h('span', { class: 'f-sgi', 'aria-hidden': 'true' }, CATS[selCat].icon), CATS[selCat].label + ' in ' + S.s.place),
          ...list(more),
          busy || (!more.length && !err) ? h('p', { class: 'pmi-why muted', role: 'status' }, 'Finding ideas…') : null,
          err ? h('p', { class: 'pmi-why', role: 'alert' }, err + ' ', h('button', { class: 'pmi-back', onclick: () => { delete moreErr[k]; findMore(S, selCat); } }, 'Try again')) : null];
      } else kids = [h('div', { class: 'pmi-h' }, h('span', { class: 'f-sgi', 'aria-hidden': 'true' }, '✦'), 'Ideas for ' + dn + ' · ' + S.s.place),
        rows.length ? h('div', { class: 'pmi-sec' }, 'Recommended ', h('span', null, 'from your route')) : null, ...list(rows),
        h('div', { class: 'pmi-sec' }, rows.length ? 'Find more' : 'Find ideas'),
        h('div', { class: 'pmi-cards' }, ...cats.map(c => h('button', { class: 'pmi-card ' + c, title: c === 'you' ? 'From what you said you like: ' + prefLabels().join(', ') : '',
          onclick: () => { selCat = c; selIdea = null; paintSel(); } }, h('span', { class: 'pmi-ci', 'aria-hidden': 'true' }, CATS[c].icon), h('b', null, CATS[c].label),
          h('span', null, c === 'you' && !prefLabels().length ? 'Tell us what you like' : CATS[c].sub))))];
      pmap.card.replaceChildren(...kids.filter(Boolean));   // replaceChildren would print a null
      pmap.card.setAttribute('aria-label', 'Ideas for ' + dn + ' in ' + S.s.place);
      pmap.card.classList.remove('hidden');
    } else { pmap.card.classList.add('hidden'); pmap.card.replaceChildren(); pmap.morePins = []; }
    camera(S, rows);
  }
  function camera(S, rows) {
    const m = pmap.gl; if (!m || !m.loaded() || !pmap.mb) return;
    pmap.marks.forEach(x => x.remove()); pmap.marks = [];
    const pt = S && placeAt()[S.s.place];
    if (!pt) {
      pmap.el.classList.remove('zoomed');
      if (pmap.zoomed) { pmap.zoomed = false; m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); m.fitBounds(pmap.bounds, { padding: 75, maxZoom: 9, duration: 500 }); }
      return;
    }
    pmap.zoomed = true; pmap.el.classList.toggle('zoomed', rows.length > 0);
    // the stop and its pinned ideas fit in the top part of the map, above the ideas card
    const pins = rows.concat(pmap.morePins || []).filter(x => x.lat != null);
    const pad = { top: 60, left: 50, right: 50, bottom: rows.length || pins.length ? Math.round((pmap.el.clientHeight || 600) * .45) + 20 : 50 };
    if (pins.length) {
      let a = [pt.lng, pt.lat], b = [pt.lng, pt.lat];
      pins.forEach(x => { a = [Math.min(a[0], x.lng), Math.min(a[1], x.lat)]; b = [Math.max(b[0], x.lng), Math.max(b[1], x.lat)]; });
      m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      m.fitBounds([a, b], { padding: pad, maxZoom: 12, duration: 600 });
    } else m.easeTo({ center: [pt.lng, pt.lat], zoom: 10, padding: { top: 0, left: 0, right: 0, bottom: pad.bottom }, duration: 600 });
    pins.forEach(x => {
      const el = h('button', { class: 'pmk-i ' + x.st + (selIdea === x.id ? ' on' : ''), title: x.title, 'aria-label': 'Idea: ' + x.title + (x.status ? ' (' + x.status + ')' : ''),
        onclick: e => { e.stopPropagation(); selIdea = selIdea === x.id ? null : x.id; paintSel(); } }, x.here ? '✓' : x.letter);
      pmap.marks.push(new pmap.mb.Marker({ element: el }).setLngLat([x.lng, x.lat]).addTo(m));
    });
  }

  const AUTO_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.6L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
  function flowDay(L, i, j, idx, fmt, live, free, leg, o) {
    o = o || {};
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
    // a plan Suitcase filled in from the route shows a small mark until someone edits it
    const auto = !!(row && row.plan_auto && d.plan);
    const mark = auto ? h('span', { class: 'f-auto', title: 'Filled in from your route · edit it to make it yours', 'aria-label': 'Filled in from your route', role: 'img' }, svg(AUTO_ICON)) : null;
    // the transfer shows on the day it happens: the first day at a new stop. Its mode is read from that day's plan, if it says.
    const xfer = leg ? h('span', { class: 'f-xfer' }, svg(LEG_ICON[legMode(d.plan)]), leg.from + ' → ' + leg.to) : null;
    const rowCls = 'f-row' + (xfer ? ' hasx' : '') + (live && selDay === d.id ? ' sel' : '');
    if (!live) return h('div', { class: rowCls }, box, h('span', { class: 'f-col' }, h('span', { class: 'f-plan' + (d.plan ? '' : ' muted') }, d.plan || 'No plan yet', mark), xfer));
    const plan = h('input', { class: 'f-in', value: d.plan || '', placeholder: 'Add a plan', 'aria-label': 'Plan for ' + fmt.shortDay(idx) });
    plan.addEventListener('input', () => {
      if (!row) return; const v = plan.value.trim() || null; row.plan = v;
      const patch = { plan: v };
      if (row.plan_auto) { row.plan_auto = false; patch.plan_auto = false; if (mark) mark.remove(); }
      clearTimeout(row._tplan); row._tplan = setTimeout(() => saveDayField(row.id, patch), 500);
    });
    plan.addEventListener('keydown', e => { if (e.key === 'Enter') plan.blur(); });
    const field = mark ? h('span', { class: 'f-pw' }, plan, mark) : plan;
    const sugg = o.sugg ? h('span', { class: 'f-sugg', title: 'Suggested in your route' }, h('span', { class: 'f-sgi', 'aria-hidden': 'true' }, '✦'), h('b', null, ideaParts(o.sugg.text).title),
      h('button', { class: 'f-use', 'aria-label': 'Use “' + o.sugg.text + '” for ' + fmt.shortDay(idx), onclick: e => { e.stopPropagation(); setDayPlan(d.id, o.sugg.text); } }, 'Use')) : null;
    const col = xfer || sugg ? h('span', { class: 'f-col' }, field, sugg, xfer) : field;
    // Where you sleep: shown, not working yet (stays come later). The stop's first night carries it, the others a line.
    const stay = live && o.place ? h('span', { class: 'f-stay' + (o.first ? '' : ' cont') }, o.first ? h('span', { class: 'f-stay-b', title: 'Stays are coming soon', 'aria-disabled': 'true' },
      h('span', { class: 'f-bed', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + HL_ICONS.stay + '"/></svg>' }), 'Add a stay') : null) : null;
    const el = h('div', { class: rowCls + (sugg ? ' hass' : '') + (stay ? ' hasstay' : ''), 'data-day': d.id }, ...[box, col, stay, rm].filter(Boolean));
    // focusing a day (typing in it or clicking the row) zooms the map to its stop and shows the stop's ideas
    if (o.place) { el.addEventListener('focusin', () => selectDay(d.id)); el.addEventListener('click', () => selectDay(d.id)); }
    return el;
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
    let { error } = await (layoutQueue = layoutQueue.then(() => sb.from('phases').update({ name: v, auto_name: false }).eq('id', id)));
    // Before migration 003 runs there is no auto_name column: save the name alone.
    if (error && /auto_name/.test(error.message || '')) ({ error } = await sb.from('phases').update({ name: v }).eq('id', id));
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
    const list = tripData.places || (tripData.places = []);   // the phase map reads these
    if (pk.lat != null && !list.some(x => x.name === pk.name)) list.push({ name: pk.name, lat: pk.lat, lng: pk.lng });
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
