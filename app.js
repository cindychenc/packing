/* Suitcase manager · v1 (sign-in, My trips, New trip, trip page with Itinerary + Phases)
 * Plain JS, no build step. Data lives in Supabase; row-level security decides what each person sees.
 */
(function () {
  'use strict';

  const CFG = window.SUITCASE_CONFIG;
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
  let selection = new Set(); // day ids ticked in the Itinerary
  let anchor = null;         // last ticked day index, for shift-click ranges

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

  /* ───────────── toast + modal ───────────── */
  let toastTimer;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2600);
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
  function show(...nodes) { app.replaceChildren(...nodes); window.scrollTo(0, 0); }
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
      sb.from('trips').select('*').order('start_date', { ascending: true }),
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
      const total = diffDays(trip.start_date, trip.end_date) + 1;
      let kicker, pill = null;
      if (today < trip.start_date) { const n = diffDays(today, trip.start_date); kicker = n === 1 ? 'Tomorrow' : 'In ' + n + ' days'; }
      else if (today <= trip.end_date) { kicker = 'Day ' + (diffDays(trip.start_date, today) + 1) + ' of ' + total; pill = h('span', { class: 'pill now dot' }, 'On the trip'); }
      else kicker = 'Finished';
      const phaseCount = p.data.filter(x => x.trip_id === trip.id).length;
      return h('a', { class: 'trip-card', href: '#/trip/' + trip.id },
        stripFor(trip),
        h('div', { class: 'body' },
          h('div', { class: 'kicker' }, kicker),
          h('div', { class: 'name' }, trip.name),
          h('div', { class: 'dates' }, range(trip.start_date, trip.end_date)),
          h('div', { class: 'foot' }, pill, h('span', { class: 'pill' }, plural(total, 'day')),
            phaseCount ? h('span', { class: 'pill' }, plural(phaseCount, 'phase')) : null)));
    };
    const live = trips.filter(x => !x.archived && x.end_date >= today);
    const past = trips.filter(x => !x.archived && x.end_date < today).reverse();
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

  /* ───────────── trip dates form (new trip + change dates) ───────────── */
  function dateFields(start, end) {
    const s = h('input', { class: 'input', type: 'date', required: true, value: start || '' });
    const e = h('input', { class: 'input', type: 'date', required: true, value: end || '' });
    const count = h('div', { class: 'count' });
    const check = () => {
      count.classList.remove('bad');
      if (s.value && (!e.value || e.value < s.value) && document.activeElement === s) e.min = s.value;
      if (!s.value || !e.value) { count.textContent = ''; return false; }
      const n = diffDays(s.value, e.value) + 1;
      if (n < 1) { count.textContent = 'The end date is before the start date.'; count.classList.add('bad'); return false; }
      if (n > MAX_DAYS) { count.textContent = 'A trip can be at most two years long.'; count.classList.add('bad'); return false; }
      count.textContent = plural(n, 'day') + ' · ' + plural(n - 1, 'night');
      return true;
    };
    s.addEventListener('input', () => { if (s.value && (!e.value || e.value < s.value)) e.value = s.value; check(); });
    e.addEventListener('input', check);
    check();
    return { s, e, count, check,
      nodes: [h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'Start'), s),
                                       h('label', { class: 'field' }, h('span', null, 'End'), e)), count] };
  }

  function newTripModal() {
    modal((box, close) => {
      const name = h('input', { class: 'input', placeholder: 'e.g. Portugal in spring', maxlength: 80, required: true });
      const dates = dateFields();
      const create = h('button', { class: 'btn primary', type: 'submit' }, 'Create trip');
      const err = h('div', { class: 'notice warn hidden' });
      box.append(h('h2', null, 'New trip'), h('p', { class: 'lead' }, 'Start with a name and dates. Everything else comes after.'),
        h('form', { onsubmit: async ev => {
          ev.preventDefault();
          if (!name.value.trim()) { name.focus(); return; }
          if (!dates.check()) return;
          create.disabled = true; create.textContent = 'Creating…';
          const { data, error } = await sb.from('trips')
            .insert({ name: name.value.trim(), start_date: dates.s.value, end_date: dates.e.value, owner_id: session.user.id })
            .select().single();
          if (error) { err.textContent = errText(error); err.classList.remove('hidden'); create.disabled = false; create.textContent = 'Create trip'; return; }
          close(); location.hash = '#/trip/' + data.id;
        } },
          h('label', { class: 'field' }, h('span', null, 'Trip name'), name), dates.nodes, err,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), create)));
    });
  }

  /* ───────────── trip page ───────────── */
  async function loadTrip(id) {
    const [t, d, p] = await Promise.all([
      sb.from('trips').select('*').eq('id', id).maybeSingle(),
      sb.from('days').select('*').eq('trip_id', id).order('date', { ascending: true }),
      sb.from('phases').select('*').eq('trip_id', id).order('sort', { ascending: true })
    ]);
    const err = t.error || d.error || p.error;
    if (err) throw err;
    if (!t.data) return null;
    return { trip: t.data, days: d.data, phases: p.data };
  }

  async function tripView(id, tab) {
    if (!tripData || tripData.trip.id !== id) {
      loading(); selection = new Set(); anchor = null;
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
  function phaseSpan(phase) {
    const days = tripData.days.filter(d => d.phase_id === phase.id);
    if (!days.length) return null;
    return { start: days[0].date, end: days[days.length - 1].date, n: days.length };
  }
  function orderedPhases() {
    return tripData.phases.slice().sort((a, b) => {
      const sa = phaseSpan(a), sb2 = phaseSpan(b);
      if (sa && sb2 && sa.start !== sb2.start) return sa.start < sb2.start ? -1 : 1;
      if (sa && !sb2) return -1;
      if (!sa && sb2) return 1;
      return (a.sort || 0) - (b.sort || 0);
    });
  }
  const dot = c => 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="' + (c || '#C9C9C9') + '"/></svg>') + '")';

  function renderTrip(tab) {
    const { trip, days } = tripData;
    const total = days.length, today = todayIso();
    let when;
    if (today < trip.start_date) { const n = diffDays(today, trip.start_date); when = n === 1 ? 'Starts tomorrow' : 'Starts in ' + n + ' days'; }
    else if (today <= trip.end_date) when = 'Day ' + (diffDays(trip.start_date, today) + 1) + ' today';
    else when = 'Finished';

    const menuBox = h('div', { class: 'menu hidden' },
      h('button', { onclick: () => { hideMenu(); renameModal(); } }, 'Rename'),
      h('button', { onclick: () => { hideMenu(); datesModal(); } }, 'Change dates'),
      h('button', { onclick: () => { hideMenu(); toggleArchive(); } }, trip.archived ? 'Unarchive' : 'Archive'),
      h('hr'),
      h('button', { class: 'danger', onclick: () => { hideMenu(); deleteTrip(); } }, 'Delete trip'));
    const hideMenu = () => menuBox.classList.add('hidden');
    const menuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Trip menu', onclick: e => { e.stopPropagation(); menuBox.classList.toggle('hidden'); } }, svg(ICON.more));
    document.onclick = () => hideMenu();

    const counts = [];
    days.forEach(d => { const last = counts[counts.length - 1]; if (last && last.id === (d.phase_id || '')) last.n++; else counts.push({ id: d.phase_id || '', n: 1 }); });
    const used = orderedPhases().filter(p => phaseSpan(p));

    const tabs = h('nav', { class: 'tabs' },
      h('a', { class: 'tab' + (tab === 'itinerary' ? ' on' : ''), href: '#/trip/' + trip.id }, 'Itinerary'),
      h('a', { class: 'tab' + (tab === 'phases' ? ' on' : ''), href: '#/trip/' + trip.id + '/phases' }, 'Phases'),
      ['Bookings', 'Checklist', 'Share'].map(n => h('span', { class: 'tab soon', title: 'Coming soon' }, n, h('span', { class: 'soon-tag' }, 'Soon'))));

    show(topbar([h('a', { class: 'crumb', href: '#/' }, 'My trips'), h('span', { class: 'crumb-sep' }, '/'), h('span', { class: 'crumb-current' }, trip.name)]),
      h('main', null,
        h('div', { class: 'trip-head' },
          h('div', null, h('h1', null, trip.name),
            h('div', { class: 'sub' }, range(trip.start_date, trip.end_date) + ' · ' + plural(total, 'day'),
              h('span', { class: 'pill' + (when.startsWith('Day') ? ' now dot' : '') }, when),
              trip.archived ? h('span', { class: 'pill' }, 'Archived') : null),
            trip.subtitle ? h('div', { class: 'muted', style: { marginTop: '4px' } }, trip.subtitle) : null),
          h('div', { class: 'spacer' }),
          h('div', { class: 'menu-wrap' }, menuBtn, menuBox)),
        used.length ? [
          h('div', { class: 'phase-bar', 'aria-hidden': 'true' }, counts.map(c => {
            const p = c.id && phaseById(c.id);
            return h('span', { style: { flex: c.n, background: p ? p.colour || '#C9C9C9' : 'transparent' }, title: p ? p.name : '' });
          })),
          h('div', { class: 'phase-legend' }, used.map(p => h('span', null, h('i', { style: { background: p.colour || '#C9C9C9' } }), p.name)))
        ] : null,
        tabs,
        tab === 'phases' ? phasesTab() : itineraryTab()));
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
  const dayRow = d => ({ id: d.id, trip_id: d.trip_id, date: d.date, phase_id: d.phase_id || null,
    location: d.location || null, plan: d.plan || null, notes: d.notes || null });

  function itineraryTab() {
    const { days } = tripData;
    const today = todayIso();
    saveState = h('span', { class: 'save-state' });
    const timers = {};

    const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    const cellSave = (d, field, ta, now) => {
      const key = d.id + field;
      clearTimeout(timers[key]);
      const run = () => {
        const v = ta.value.replace(/\s+$/, '');
        if ((d[field] || '') === v) return;
        d[field] = v || null;
        saveDays([dayRow(d)]);
      };
      if (now) run(); else { setSave('saving', 'Editing…'); timers[key] = setTimeout(run, 700); }
    };

    const table = h('table', { class: 'itin' });
    const head = h('tr', null, h('th', { class: 'c-day' }, 'Day'), h('th', { class: 'c-date' }, 'Date'), h('th', { class: 'c-phase' }, 'Phase'),
      h('th', { class: 'c-loc' }, 'Location'), h('th', null, 'Plan'), h('th', { class: 'c-notes notes-col' }, 'Notes'));
    const body = h('tbody');
    table.append(h('colgroup', null, h('col', { class: 'c-day' }), h('col', { class: 'c-date' }), h('col', { class: 'c-phase' }),
      h('col', { class: 'c-loc' }), h('col'), h('col', { class: 'c-notes' })), h('thead', null, head), body);

    const tools = h('div', { class: 'grid-tools' });
    const renderTools = () => {
      const n = selection.size;
      const kids = [];
      if (n) {
        const sel = h('select', { 'aria-label': 'Phase for the selected days' },
          h('option', { value: '' }, 'No phase'),
          orderedPhases().map(p => h('option', { value: p.id }, p.name)),
          h('option', { value: '__new' }, '+ New phase…'));
        kids.push(h('div', { class: 'selbar' }, plural(n, 'day') + ' selected', h('span', { class: 'muted', style: { color: '#BBB', fontWeight: 500 } }, 'Phase:'), sel,
          h('button', { class: 'btn small', onclick: async () => {
            let pid = sel.value || null;
            if (pid === '__new') { pid = await addPhase(); if (!pid) return; }
            const rows = days.filter(d => selection.has(d.id));
            rows.forEach(d => { d.phase_id = pid; });
            selection = new Set(); anchor = null;
            if (await saveDays(rows.map(dayRow))) renderTrip('itinerary');
          } }, 'Set phase'),
          h('button', { class: 'btn small ghost', style: { color: '#fff' }, onclick: () => { selection = new Set(); anchor = null; refreshSel(); } }, 'Clear')));
      } else {
        kids.push(h('span', { class: 'muted' }, 'Tick days to give them a phase. Paste rows from a spreadsheet into Location, Plan or Notes.'));
      }
      kids.push(h('div', { class: 'spacer' }), saveState);
      tools.replaceChildren(...kids);
    };
    const refreshSel = () => {
      body.querySelectorAll('tr').forEach(tr => tr.classList.toggle('sel', selection.has(tr.dataset.id)));
      renderTools();
    };

    const fieldBoxes = {};   // `${index}:${field}` -> textarea, for Enter-to-move and paste
    days.forEach((d, i) => {
      const prev = days[i - 1];
      const p = d.phase_id && phaseById(d.phase_id);
      const tr = h('tr', { 'data-id': d.id, class: [selection.has(d.id) ? 'sel' : '', d.date === today ? 'today' : '',
        prev && prev.phase_id !== d.phase_id ? 'phase-start' : ''].join(' ').trim() || null });

      const dayCell = h('div', { class: 'cell-day', role: 'checkbox', 'aria-checked': String(selection.has(d.id)), tabindex: '0',
        title: 'Select (shift-click for a range)',
        onclick: e => tick(i, e.shiftKey), onkeydown: e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tick(i, e.shiftKey); } } },
        h('span', { class: 'tick' }), String(i + 1));

      const phaseSel = h('select', { class: 'phase-select' + (p ? '' : ' none'), 'aria-label': 'Phase for ' + md(d.date),
        style: { backgroundImage: p ? dot(p.colour) : dot('#E0E0E0') } },
        h('option', { value: '' }, 'No phase'),
        orderedPhases().map(ph => h('option', { value: ph.id, selected: ph.id === d.phase_id }, ph.name)),
        h('option', { value: '__new' }, '+ New phase…'));
      phaseSel.addEventListener('change', async () => {
        let pid = phaseSel.value || null;
        if (pid === '__new') { pid = await addPhase(); if (!pid) { phaseSel.value = d.phase_id || ''; return; } }
        d.phase_id = pid;
        if (await saveDays([dayRow(d)])) renderTrip('itinerary');
      });

      const cells = DAY_FIELDS.map((f, j) => {
        const ta = h('textarea', { class: 'edit' + (f === 'location' ? ' loc' : ''), rows: 1, spellcheck: f !== 'location',
          'aria-label': f[0].toUpperCase() + f.slice(1) + ' for ' + md(d.date),
          placeholder: f === 'location' ? (prev && prev.location ? '' : 'Where are you?') : f === 'plan' ? '' : '' });
        ta.value = d[f] || '';
        fieldBoxes[i + ':' + f] = ta;
        ta.addEventListener('input', () => { autosize(ta); cellSave(d, f, ta, false); });
        ta.addEventListener('blur', () => cellSave(d, f, ta, true));
        ta.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            const next = fieldBoxes[(i + 1) + ':' + f]; if (next) next.focus(); else ta.blur();
          } else if (e.key === 'Escape') ta.blur();
          else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            const to = fieldBoxes[(i + (e.key === 'ArrowUp' ? -1 : 1)) + ':' + f]; if (to) to.focus();
          }
        });
        ta.addEventListener('paste', e => {
          const text = (e.clipboardData || window.clipboardData).getData('text');
          if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;   // a single value: normal paste
          e.preventDefault();
          const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
          const changed = new Map();
          lines.forEach((line, r) => {
            const day = days[i + r]; if (!day) return;
            line.split('\t').forEach((val, c) => {
              const field = DAY_FIELDS[j + c]; if (!field) return;
              day[field] = val.trim() || null;
              const box = fieldBoxes[(i + r) + ':' + field];
              if (box) { box.value = day[field] || ''; autosize(box); }
              changed.set(day.id, day);
            });
          });
          const skipped = Math.max(0, i + lines.length - days.length);
          saveDays([...changed.values()].map(dayRow)).then(ok => {
            if (ok) toast('Pasted into ' + plural(changed.size, 'day') + (skipped ? ' · ' + plural(skipped, 'row') + ' past the last day left out' : ''));
          });
        });
        return h('td', { class: f === 'notes' ? 'notes-col' : null }, ta);
      });

      tr.append(h('td', null, dayCell),
        h('td', null, h('div', { class: 'cell-date' }, h('span', { class: 'wd' }, wd(d.date)), md(d.date))),
        h('td', null, h('div', { class: 'cell-phase' }, phaseSel)),
        ...cells);
      body.append(tr);
    });

    function tick(i, shift) {
      const id = days[i].id;
      if (shift && anchor != null) {
        const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
        for (let k = a; k <= b; k++) selection.add(days[k].id);
      } else if (selection.has(id)) selection.delete(id);
      else selection.add(id);
      anchor = i;
      refreshSel();
      body.querySelectorAll('.cell-day').forEach((c, k) => c.setAttribute('aria-checked', String(selection.has(days[k].id))));
    }

    renderTools();
    requestAnimationFrame(() => body.querySelectorAll('textarea').forEach(autosize));
    return h('section', null, tools, table);
  }

  /* ───────────── Phases tab ───────────── */
  async function addPhase(name) {
    const used = tripData.phases.map(p => (p.colour || '').toUpperCase());
    const colour = (PALETTE.find(c => used.indexOf(c[1]) < 0) || PALETTE[tripData.phases.length % PALETTE.length])[1];
    const sort = tripData.phases.reduce((m, p) => Math.max(m, p.sort || 0), 0) + 1;
    const { data, error } = await sb.from('phases')
      .insert({ trip_id: tripData.trip.id, name: name || 'Phase ' + (tripData.phases.length + 1), colour, sort }).select().single();
    if (error) { toast('Couldn\'t add the phase: ' + errText(error), true); return null; }
    tripData.phases.push(data);
    return data.id;
  }
  async function savePhase(p, patch) {
    Object.assign(p, patch);
    const { error } = await sb.from('phases').update(patch).eq('id', p.id);
    if (error) { toast('Couldn\'t save: ' + errText(error), true); return false; }
    return true;
  }

  function phasesTab() {
    const list = h('div', { class: 'phase-list' });
    const phases = orderedPhases();
    if (!phases.length) {
      return h('section', null, h('div', { class: 'empty', style: { margin: '28px 0', maxWidth: '880px' } },
        h('h2', null, 'Split the trip into phases'),
        h('p', null, 'A phase is a stretch of the trip, like "Patagonia" or "Lisbon & coast". Each gets a colour in Carryon.'),
        h('button', { class: 'btn primary', onclick: async () => { if (await addPhase()) renderTrip('phases'); } }, svg(ICON.plus), 'Add a phase')));
    }
    phases.forEach(p => {
      const span = phaseSpan(p);
      const name = h('input', { class: 'name-input', value: p.name, maxlength: 60, 'aria-label': 'Phase name' });
      name.addEventListener('change', async () => {
        const v = name.value.trim();
        if (!v) { name.value = p.name; return; }
        if (await savePhase(p, { name: v })) toast('Saved');
      });
      name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });

      const swatch = h('button', { class: 'swatch-btn', style: { background: p.colour || '#C9C9C9' }, 'aria-label': 'Colour for ' + p.name });
      const pal = h('div', { class: 'palette hidden' }, PALETTE.map(([label, c]) =>
        h('button', { title: label, 'aria-label': label, class: (p.colour || '').toUpperCase() === c ? 'on' : null, style: { background: c },
          onclick: async e => { e.stopPropagation(); pal.classList.add('hidden'); if (await savePhase(p, { colour: c })) renderTrip('phases'); } })));
      swatch.addEventListener('click', e => { e.stopPropagation(); document.querySelectorAll('.palette').forEach(x => x !== pal && x.classList.add('hidden')); pal.classList.toggle('hidden'); });
      document.addEventListener('click', () => pal.classList.add('hidden'));

      const url = h('input', { class: 'input', type: 'url', placeholder: 'Header photo URL (https://…), optional', value: p.photo_url || '' });
      const credit = h('input', { class: 'input', placeholder: 'Photo credit', value: p.photo_credit || '', style: { maxWidth: '200px' } });
      url.addEventListener('change', async () => {
        const v = url.value.trim();
        if (v && !/^https:\/\//i.test(v)) { toast('The photo link has to start with https://', true); url.value = p.photo_url || ''; return; }
        if (await savePhase(p, { photo_url: v || null })) toast('Saved');
      });
      credit.addEventListener('change', async () => { if (await savePhase(p, { photo_credit: credit.value.trim() || null })) toast('Saved'); });

      const del = h('button', { class: 'icon-btn', 'aria-label': 'Delete ' + p.name, title: 'Delete phase', onclick: () =>
        confirmBox('Delete "' + p.name + '"?', span ? 'Its ' + plural(span.n, 'day') + ' keep their plans but won\'t have a phase.' : 'No days use this phase yet.',
          'Delete phase', async () => {
            const { error } = await sb.from('phases').delete().eq('id', p.id);
            if (error) { toast('Couldn\'t delete: ' + errText(error), true); return; }
            tripData.phases = tripData.phases.filter(x => x.id !== p.id);
            tripData.days.forEach(d => { if (d.phase_id === p.id) d.phase_id = null; });
            renderTrip('phases');
          }, true) }, svg(ICON.trash));

      list.append(h('div', { class: 'phase-row' },
        h('div', { class: 'swatch-wrap' }, swatch, pal),
        name,
        h('div', { class: 'span' + (span ? '' : ' none') }, span ? range(span.start, span.end) + ' · ' + plural(span.n, 'day') : 'No days yet'),
        del,
        h('div', null),
        h('div', { class: 'photo' }, url, credit)));
    });
    return h('section', null,
      list,
      h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn', onclick: async () => { if (await addPhase()) renderTrip('phases'); } }, svg(ICON.plus), 'Add a phase')),
      h('p', { class: 'phase-hint' }, 'A phase\'s dates come from its days. To change them, go to Itinerary, tick the days and choose the phase.'));
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

  function datesModal() {
    const t = tripData.trip;
    modal((box, close) => {
      const dates = dateFields(t.start_date, t.end_date);
      const warn = h('div', { class: 'notice warn hidden' });
      const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save dates');
      let confirmed = null;   // ids of days with content the user agreed to delete
      box.append(h('h2', null, 'Change dates'), h('p', { class: 'lead' }, 'Days are added or removed to match. Plans on the days you keep stay as they are.'),
        h('form', { onsubmit: async e => {
          e.preventDefault();
          if (!dates.check()) return;
          const s = dates.s.value, en = dates.e.value;
          const outside = tripData.days.filter(d => (d.date < s || d.date > en) && (d.location || d.plan || d.notes));
          if (outside.length && (!confirmed || confirmed.join() !== outside.map(d => d.id).join())) {
            warn.textContent = plural(outside.length, 'day') + ' outside the new dates ' + (outside.length === 1 ? 'has' : 'have') + ' plans: ' +
              outside.slice(0, 6).map(d => md(d.date)).join(', ') + (outside.length > 6 ? '…' : '') + '. Saving deletes ' + (outside.length === 1 ? 'it' : 'them') + '.';
            warn.classList.remove('hidden');
            save.textContent = 'Delete ' + plural(outside.length, 'day') + ' and save';
            save.classList.replace('primary', 'danger');
            confirmed = outside.map(d => d.id);
            return;
          }
          save.disabled = true;
          if (confirmed && confirmed.length) {
            const { error } = await sb.from('days').delete().in('id', confirmed);
            if (error) { save.disabled = false; return toast(errText(error), true); }
          }
          const { error } = await sb.from('trips').update({ start_date: s, end_date: en }).eq('id', t.id);
          if (error) { save.disabled = false; return toast(/DAYS_WITH_CONTENT/.test(error.message) ? 'Some days outside the new dates still have plans. Reload and try again.' : errText(error), true); }
          close(); tripData = null; tripView(t.id, currentTab()); toast('Dates changed');
        } }, dates.nodes, warn,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save)));
      [dates.s, dates.e].forEach(inp => inp.addEventListener('input', () => {
        confirmed = null; warn.classList.add('hidden'); save.textContent = 'Save dates'; save.classList.replace('danger', 'primary');
      }));
    });
  }

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
  function currentTab() { return /\/phases$/.test(location.hash) ? 'phases' : 'itinerary'; }
  function route() {
    if (!authReady) return;
    const hash = location.hash;
    if (/access_token=|error_code=|type=magiclink/.test(hash)) return;   // the auth library is reading the link
    if (!session) { signInView(); return; }
    const m = hash.match(/^#\/trip\/([0-9a-f-]{36})(\/phases)?$/i);
    if (m) tripView(m[1], m[2] ? 'phases' : 'itinerary');
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
