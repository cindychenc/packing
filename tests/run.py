"""Headless browser test for the Suitcase manager, against the in-memory fake backend.
Run from the repo root:  python3 tests/run.py   (serves the folder on :8000, writes screenshots to /tmp/shots)
"""
import os, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path('/tmp/shots'); SHOTS.mkdir(exist_ok=True)
FAKE = (ROOT / 'tests' / 'fake-supabase.js').read_text()
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')

server = subprocess.Popen([sys.executable, '-m', 'http.server', '8000', '--bind', '127.0.0.1'], cwd=ROOT,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
errors = []
ok = lambda cond, msg: print(('PASS ' if cond else 'FAIL ') + msg) or (cond or errors.append(msg))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 1360, 'height': 900})
        page.route('**/lib/supabase-*.js', lambda r: r.fulfill(body=FAKE, content_type='application/javascript'))
        page.route('https://api.mapbox.com/**', lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if '/static/' in r.request.url
                   else (errors.append('called Mapbox: ' + r.request.url), r.abort()))
        page.add_init_script("""window.SUITCASE_PLACES_FAKE = [
          { name: 'Lisbon', label: 'Portugal', kind: 'place', country: 'Portugal', cc: 'PT', lat: 38.72, lng: -9.14 },
          { name: 'Lima', label: 'Peru', kind: 'place', country: 'Peru', cc: 'PE', lat: -12.05, lng: -77.04 },
          { name: 'Cusco', label: 'Cusco, Peru', kind: 'place', country: 'Peru', cc: 'PE', lat: -13.53, lng: -71.97 },
          { name: 'Peru', label: '', kind: 'country', country: 'Peru', cc: 'PE', lat: -9.2, lng: -75 },
          { name: 'Tokyo', label: 'Japan', kind: 'place', country: 'Japan', cc: 'JP', lat: 35.68, lng: 139.69 },
          { name: 'Japan', label: '', kind: 'country', country: 'Japan', cc: 'JP', lat: 36, lng: 138 },
          { name: 'Santiago', label: 'Chile', kind: 'place', country: 'Chile', cc: 'CL', lat: -33.45, lng: -70.67 },
          { name: 'Pucón', label: 'Chile', kind: 'place', country: 'Chile', cc: 'CL', lat: -39.28, lng: -71.95 },
          { name: 'Puerto Natales', label: 'Chile', kind: 'place', country: 'Chile', cc: 'CL', lat: -51.73, lng: -72.5 },
          { name: 'El Chaltén', label: 'Argentina', kind: 'place', country: 'Argentina', cc: 'AR', lat: -49.33, lng: -72.89 },
          { name: 'Porto', label: 'Portugal', kind: 'place', country: 'Portugal', cc: 'PT', lat: 41.15, lng: -8.61 } ];
          window.SUITCASE_MAP_FAKE = true;
          // where ideas are: Milodon Cave is near Puerto Natales; a far-away 'Grey Glacier boat' must not be pinned
          window.SUITCASE_IDEAS_FAKE = { 'milodon cave': { lat: -51.57, lng: -72.62 }, 'grey glacier boat': { lat: -45.0, lng: -72.0 } };""")
        page.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        U = 'http://127.0.0.1:8000/'

        # 1. signed out → sign-in page
        page.goto(U); page.evaluate('localStorage.clear()'); page.reload()
        page.wait_for_selector('.signin-card')
        page.screenshot(path=str(SHOTS / '01-signin.png'))
        page.fill('input[type=email]', 'not-an-email'); page.click('button[type=submit]')
        ok(page.is_visible('text=doesn\'t look like an email'), 'bad email rejected')
        page.fill('input[type=email]', 'cindy@example.com'); page.click('button[type=submit]')
        page.wait_for_selector('text=Check your email')
        page.screenshot(path=str(SHOTS / '02-sent.png'))

        # expired link
        page.goto(U + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
        page.reload(); page.wait_for_selector('.signin-card')
        ok(page.is_visible('text=expired or was already used'), 'expired-link notice')

        # 2. signed in, no trips
        page.evaluate("localStorage.setItem('fake:signedin','1')"); page.goto(U + '#/'); page.reload()
        page.wait_for_selector('.empty')
        ok(page.is_visible('text=Your first trip starts here'), 'empty state')
        page.screenshot(path=str(SHOTS / '03-empty.png'))

        # 3. new trip pop-up: where + dates (range calendar), Next, the sentence, or an empty trip
        page.click('.empty .btn.primary')
        page.wait_for_selector('.modal.newtrip')
        nxt = '.nt-foot button:has-text("Next →")'
        ok(page.inner_text('.nt-lbl') == 'NEW TRIP · 1 OF 3' or page.inner_text('.nt-lbl').upper() == 'NEW TRIP · 1 OF 3', 'step label')
        ok(page.is_disabled(nxt) and not page.query_selector('.seg-btn[aria-pressed=true]'), 'nothing picked; Next waits for answers')
        ok(page.is_visible('.nt-foot button:has-text("Import a plan you have")'), 'import button on the left of the footer')
        page.fill('.modal .dest-in', 'Portugal')
        page.click('.seg-btn:has-text("Not yet")')
        ok(page.is_disabled(nxt) and not page.is_visible('.rp-btn'), 'Next waits for a length; no calendar for Not yet')
        page.click('.fp:has-text("Spring")'); page.click('.fp:has-text("Summer")')
        ok(len(page.query_selector_all('.fp.on')) == 2, 'several seasons at once')
        page.click('.fp:has-text("Not sure yet")')
        ok([e.inner_text() for e in page.query_selector_all('.fp.on')] == ['Not sure yet'], '"Not sure yet" clears the seasons')
        page.click('.fp:has-text("Fall")')
        page.click('.len-pill:has-text("Months")')
        page.click('.len-pill.months button[aria-label=More]'); page.click('.len-pill.months button[aria-label=More]')
        ok('3 months' in page.inner_text('.len-pill.months') and page.is_enabled(nxt), 'months counter inside the pill; Next ready')
        page.click('.seg-btn:has-text("Yes, I do")')
        ok(page.is_disabled(nxt) and page.is_visible('.rp-pop') and not page.is_visible('.len-pill') and not page.is_visible('.fp:has-text("Spring")'), 'Yes opens the range calendar, lengths and seasons hidden')
        for _ in range(5): page.click('.rp-nav[aria-label="Next month"]')
        page.click('.rp-d[data-v="2027-04-05"]')
        ok('Now pick your last day' in page.inner_text('.rp-hd') and page.is_disabled('.rp-d[data-v="2027-04-04"]'), 'first tap = start; days before it are off')
        page.hover('.rp-d[data-v="2027-04-18"]')
        ok('14 days' in page.inner_text('.rp-btn') and len(page.query_selector_all('.rp-d.in')) == 12, 'hovering previews the range')
        page.click('.rp-d[data-v="2027-04-18"]')
        ok(not page.is_visible('.rp-pop') and 'Apr 5, 2027' in page.inner_text('.rp-btn') and 'Apr 18, 2027' in page.inner_text('.rp-btn') and page.is_enabled(nxt), f"second tap = end, calendar closes ({page.inner_text('.rp-btn')!r})")
        page.screenshot(path=str(SHOTS / '04-new-trip.png'))
        page.click(nxt); page.wait_for_selector('.fsec')
        ok(page.inner_text('.nt-body .nt-ttl') == 'Tell us about the trip' and len(page.query_selector_all('.fsec .fpills >> nth=0 >> .fp')) == 6, 'form step: 6 interests shown')
        ok(page.is_enabled('.nt-foot button:has-text("See my options")') and 'left' not in page.inner_text('.nt-foot'), 'every answer optional, no hint')
        page.click('.fmore'); ok(len(page.query_selector_all('.fsec >> nth=0 >> .fp')) == 15 and page.inner_text('.fmore').startswith('Show less'), 'Show more lists all 15')
        page.screenshot(path=str(SHOTS / '04b-form.png'))
        page.click('.modal .empty-start')
        page.wait_for_selector('.planner .pcard.start'); page.mouse.move(5, 5)
        tt = page.inner_text('.pcard.start'); ok("Let's get started." in tt and '14 days to plan' in tt, f'new trip opens on the Planner, empty ({tt[:60]!r})')
        ok(page.is_visible('.fnav .fn.on:has-text("Planner")') and page.is_visible('.fnav .fn.off:has-text("Bookings")'), 'bottom nav: Planner on, Bookings soon')
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('.itin-empty')
        ok('Nothing on the itinerary yet' in page.inner_text('.itin-empty'), 'empty itinerary')
        ok('Mon, Apr 5 – Sun, Apr 18, 2027 · 14 days' in page.inner_text('.trip-head .meta'), f"header meta ({page.inner_text('.trip-head .meta')!r})")
        page.click('.itin-empty a:has-text("Start planning")'); page.wait_for_selector('.pcard.start')
        ok(True, 'Start planning goes to the Planner')
        page.click('#firststop'); page.keyboard.type('Lisb'); page.wait_for_selector('.ac-i:has-text("Lisbon")'); page.keyboard.press('Enter')
        ok(page.inner_text('.pcard.start .start-t') == 'Portugal', 'phase name previews the country')
        for _ in range(3): page.click('.pcard.start button[aria-label="One night more"]')
        page.click('.pcard.start .btn.primary:has-text("Add")'); page.wait_for_selector('.pcard.live .f-lbl')
        ok(page.input_value('.pcard.live input.pc-name') == 'Portugal', 'first stop names the phase after the country')
        page.wait_for_function("document.activeElement.classList.contains('stop-in')")
        page.fill('.pcard.live input.pc-name', 'Lisbon & Sintra'); page.keyboard.press('Enter')
        page.wait_for_function("document.querySelector('.tl-ph b') && document.querySelector('.tl-ph b').textContent === 'Lisbon & Sintra'")

        # 4. Itinerary grouped by phase: type a location, autosave
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('table.itin.grouped')
        ok(page.input_value('.ghead .gname') == 'Lisbon & Sintra' and 'Apr 5 – Apr 9 · 5 days' in page.inner_text('.ghead'), 'phase header row')
        ok(len(page.query_selector_all('table.itin tbody tr[data-id]')) == 5, '5 day rows under the phase')
        ok('9 more days to plan' in page.inner_text('.freebox') and 'Apr 10 – Apr 18' in page.inner_text('.freebox'), 'days to plan folded into one box')
        loc = lambda i: page.locator('table.itin tbody tr[data-id]').nth(i).locator('textarea').nth(0)
        loc(0).fill(''); loc(0).fill('Lisbon'); loc(1).click()
        page.wait_for_selector('.save-state.saved', timeout=3000)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(any(d['location'] == 'Lisbon' for d in db['days']), 'location saved')

        # 5. paste rows from a spreadsheet (location + plan)
        loc(2).click()
        page.evaluate("""() => { const dt = new DataTransfer(); dt.setData('text/plain', 'Sintra\\tPena Palace · Quinta da Regaleira\\nÉvora\\tRoman temple\\nMonsaraz\\tSunset walk\\n');
            document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""")
        page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        byIdx = {d['idx']: d for d in db['days']}   # Apr 5 = day 0
        ok(byIdx[2]['location'] == 'Sintra' and byIdx[3]['plan'] == 'Roman temple' and byIdx[4]['location'] == 'Monsaraz', 'multi-row paste saved')
        ok(loc(3).input_value() == 'Évora', 'pasted values shown in grid')
        ok(byIdx[2]['phase_id'] and byIdx[4]['phase_id'], 'paste keeps days in their phase')

        # 6. + Add a day to the phase, + Add new phase
        page.click('.add-row-btn:has-text("Add a day to Lisbon & Sintra")')
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr[data-id]').length === 6")
        ok('8 more days to plan' in page.inner_text('.freebox'), 'add a day takes one from the days to plan')
        page.click('#toast button:has-text("Undo")')
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr[data-id]').length === 5")
        page.click('.freebox button:has-text("Add new phase")')
        page.wait_for_function("document.querySelectorAll('tr.ghead').length === 2")
        page.wait_for_function("document.activeElement && document.activeElement.classList.contains('gname')")
        page.keyboard.type('Alentejo'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(len(db['phases']) == 2 and any(p['name'] == 'Alentejo' for p in db['phases']) and sum(1 for d in db['days'] if d['phase_id']) == 6, 'new 1-day phase, named')
        page.screenshot(path=str(SHOTS / '05-itinerary.png'), full_page=True)

        # 7. old Phases link goes to the Planner; colour from the ••• menu
        tid = db['trips'][0]['id']
        page.goto(U + '#/trip/' + tid + '/phases'); page.wait_for_selector('.pcard.live')
        ok(page.url.endswith('#/trip/' + tid), 'old Phases link opens the Planner')
        page.click('.pcard.live button[aria-label^="More for"]')
        page.click('.pmenu:not(.hidden) button:has-text("Colour & photo")')
        page.click('.cp-swatches button[aria-label="Tangerine"]'); page.click('.modal button[type=submit]'); page.wait_for_timeout(200)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(any(ph['name'] == 'Lisbon & Sintra' and ph['colour'] == '#C24A00' for ph in db['phases']), 'phase recoloured')
        page.screenshot(path=str(SHOTS / '06-planner.png'), full_page=True)

        # 8a. Edit dates: move the start date — the whole trip moves, plans stay on their day of the trip
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('table.itin')
        page.click('.trip-head .link-btn:has-text("Edit dates")')
        page.screenshot(path=str(SHOTS / '06b-edit-dates.png'))
        page.fill('.dates-editor input[type=date]', '2027-04-08'); page.dispatch_event('.dates-editor input[type=date]', 'change')
        page.wait_for_selector('textarea[aria-label="Location for Apr 8"]')
        ok(page.input_value('textarea[aria-label="Location for Apr 8"]') == 'Lisbon', 'start moved, plans moved with their days')
        ok(page.is_visible('#toast button:has-text("Undo")'), 'toast offers Undo')
        ok('null' not in page.inner_text('#toast'), 'toast text clean')
        page.click('#toast button:has-text("Undo")')
        page.wait_for_selector('textarea[aria-label="Location for Apr 5"]')
        ok(True, 'undo puts the start date back')
        # 8b. length: + adds a day at the end, – removes it; a day with plans asks first
        page.click('.dates-editor button[aria-label="One day more"]')
        page.wait_for_function("document.querySelector('.trip-head .meta').textContent.includes('· 15 days')")
        page.click('.dates-editor button[aria-label="One day less"]')
        page.wait_for_function("document.querySelector('.trip-head .meta').textContent.includes('· 14 days')")
        page.evaluate("""() => { const db = JSON.parse(localStorage.getItem('fake:db')); db.days.find(d => d.idx === 13).plan = 'Fly home'; localStorage.setItem('fake:db', JSON.stringify(db)); }""")
        page.reload(); page.wait_for_selector('table.itin')
        page.click('.trip-head .link-btn:has-text("Edit dates")')
        page.click('.dates-editor button[aria-label="One day less"]')
        ok(page.is_visible('.modal:has-text("has plans")'), 'warns before deleting a day with plans')
        page.screenshot(path=str(SHOTS / '07-dates-warn.png'))
        page.click('.modal .btn.danger')
        page.wait_for_function("document.querySelector('.trip-head .meta').textContent.includes('· 13 days')")
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        t = db['trips'][0]
        ok(t['length_days'] == 13 and t['end_date'] == '2027-04-17' and len(db['days']) == 13, 'trip shortened to 13 days')
        # 8c. remove the start date, then set it again
        page.click('.dates-editor .link-btn:has-text("Remove start date")')
        page.wait_for_selector('text=13 days · no dates yet')
        ok(page.is_visible('textarea[aria-label="Location for Day 1"]'), 'no dates: days are Day 1, Day 2…')
        page.click('.dates-editor button:has-text("Set start date")')
        page.fill('.dates-editor input[type=date]', '2027-04-05'); page.dispatch_event('.dates-editor input[type=date]', 'change')
        page.wait_for_selector('textarea[aria-label="Location for Apr 5"]')
        page.click('.dates-editor button:has-text("Done")')
        ok(not page.is_visible('.dates-editor'), 'Done closes the date editor')

        # 9. My trips card
        page.click('a.crumb'); page.wait_for_selector('.trip-card')
        ok('Portugal' in page.inner_text('.trip-card'), 'trip card shown')
        page.screenshot(path=str(SHOTS / '08-trips.png'))

        # 9b. a trip without dates, from the pop-up ("Not yet" · 2 weeks)
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.click('.modal .dest-in'); page.keyboard.type('Toky'); page.wait_for_selector('.ac-i:has-text("Tokyo")'); page.keyboard.press('Enter')
        page.click('.seg-btn:has-text("Not yet")'); page.click('.len-pill:has-text("2 weeks")')
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.fsec'); page.click('.modal .empty-start'); page.wait_for_selector('.planner')
        ok(page.input_value('#firststop') == 'Tokyo' and page.inner_text('.start-t') == 'Japan', 'a single city becomes the first stop, ready to add')
        ok('14 days · no dates yet' in page.inner_text('.trip-head .meta'), 'rough trip created without dates')
        page.click('a.crumb'); page.wait_for_selector('.trip-card >> nth=1')
        card = page.inner_text('.trip-card:has-text("Tokyo")')
        ok('no dates yet' in card.lower() and '14 days · dates open' in card, f'undated trip card ({card!r})')
        page.click('.trip-card:has-text("Tokyo")'); page.wait_for_selector('.planner')
        page.click('#firststop')
        ok(page.is_visible('.f-row.gh .f-day:has-text("DAY")') and len(page.query_selector_all('.f-row.gh')) == 2, 'undated trip: days are DAY 1, DAY 2…')
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('.itin-empty')
        ok('14 days · no dates yet' in page.inner_text('.itin-empty'), 'undated empty itinerary')
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 9c. apply_layout in the fake backend (same rules as the database)
        res = page.evaluate("""async () => {
            const db = JSON.parse(localStorage.getItem('fake:db')); const t = db.trips.find(x => x.name === 'Tokyo');
            const rows = db.days.filter(d => d.trip_id === t.id).map(d => ({ id: d.id, idx: d.idx, phase_id: null }));
            const L = SuitcaseLayout; let lay = L.fromRows([], rows); lay = L.insertPhaseAt(lay, 0, 4).layout; lay = L.insertPhaseAt(lay, 1, 3).layout;
            const r = L.toRows(lay); const c = supabase.createClient();
            const ok1 = await c.rpc('apply_layout', { p_trip: t.id, p_expect: t.updated_at, p_phases: r.phases, p_days: r.days });
            const stale = await c.rpc('apply_layout', { p_trip: t.id, p_expect: t.updated_at, p_phases: r.phases, p_days: r.days });
            const bad = await c.rpc('apply_layout', { p_trip: t.id, p_expect: null, p_phases: r.phases, p_days: r.days.map((d, i) => Object.assign({}, d, { phase_id: i === 6 ? r.phases[0].id : d.phase_id })) });
            const db2 = JSON.parse(localStorage.getItem('fake:db'));
            return [ok1.error, stale.error && stale.error.message, bad.error && bad.error.message, db2.phases.filter(p => p.trip_id === t.id).length];
        }""")
        ok(res[0] is None and res[1] == 'LAYOUT_CHANGED' and res[2].startswith('BAD_LAYOUT') and res[3] == 2, f'apply_layout rules ({res})')

        # 9d. the Planner: phase timeline + phase cards
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .dest-in', 'Planner test'); page.click('.seg-btn:has-text("Not yet")'); page.click('.len-pill:has-text("3 weeks")')
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.fsec'); page.click('.modal .empty-start'); page.wait_for_selector('.pcard.start')
        rows = lambda: len(page.query_selector_all('.pcard.live .f-row:not(.gh)'))
        ok(not page.is_visible('.f-ghosts .f-row'), 'no free-day rows until the input is used')
        page.click('#firststop')
        ok(len(page.query_selector_all('.f-row.gh')) == 2, 'focus shows the free-day rows for the nights')
        ok(not page.is_visible('.pcard.start .btn.primary:has-text("Add")'), 'Add hidden until a place is typed')
        page.keyboard.type('Lim'); page.wait_for_selector('.ac-i:has-text("Lima")')
        ok(page.is_visible('.pcard.start .btn.primary:has-text("Add")'), 'Add shows once a place is typed')
        page.keyboard.press('Enter')
        ok(page.input_value('#firststop') == 'Lima' and page.inner_text('.start-t') == 'Peru', 'autocomplete picks Lima; title previews Peru')
        for _ in range(2): page.click('.pcard.start button[aria-label="One night more"]')
        ok(len(page.query_selector_all('.f-row.gh')) == 4, 'nights change the free-day rows')
        page.screenshot(path=str(SHOTS / '10-planner-empty.png'))
        page.click('.pcard.start .btn.primary:has-text("Add")')
        page.wait_for_selector('.pcard.live .f-lbl')
        ok(page.input_value('.pcard.live input.pc-name') == 'Peru' and rows() == 4, f'first stop makes the first phase ({rows()} rows)')
        ok('Added Lima (4 nights)' in page.inner_text('#toast'), 'toast says what happened')
        ok('17 days to plan' in page.inner_text('.tl-free'), 'timeline shows the days left to plan')
        page.wait_for_timeout(100)
        ok(page.evaluate("document.activeElement.classList.contains('stop-in')"), '"Add next stop" gets the cursor')
        page.keyboard.type('Cus'); page.wait_for_selector('.ac-i:has-text("Cusco")'); page.keyboard.press('Enter'); page.keyboard.press('Enter')
        page.wait_for_function("document.querySelectorAll('.pcard.live .f-stop:not(.add)').length === 2")
        ok(rows() == 6 and page.is_visible('.pcard.live .f-row.hasx .f-xfer:has-text("Lima → Cusco")') and not page.query_selector('.f-leg'), 'next stop added after Lima; the transfer shows on its first day')
        ok(page.inner_text('.pcard.live .f-stop:not(.add) .f-lbl >> nth=0') == 'Lima' and not page.query_selector('.pcard.live .f-stop:not(.add) svg') and not page.is_visible('button[aria-label="One night more in Lima"]'),
           'stop is a label in the phase colour; nights are behind a button')
        page.click('.n-btn[aria-label^="Change nights in Lima"]')
        ok(page.is_visible('.n-done'), 'the button opens – / + and Done')
        page.click('button[aria-label="One night more in Lima"]')
        page.wait_for_function("document.querySelectorAll('.pcard.live .f-row:not(.gh)').length === 7")
        ok('Lima +1 night · everything after moved 1 day later' in page.inner_text('#toast'), f'stop nights + ({page.inner_text("#toast")!r})')
        page.click('#toast button:has-text("Undo")'); page.wait_for_function("document.querySelectorAll('.pcard.live .f-row:not(.gh)').length === 6")
        page.fill('input[aria-label="Plan for Day 1"]', 'Arrive · ceviche'); page.wait_for_timeout(800)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(any(d['plan'] == 'Arrive · ceviche' for d in db['days']), 'plan typed in the row is saved')
        page.hover('.pcard.live .f-row >> nth=5'); page.click('button[aria-label="Remove Day 6"]')
        page.wait_for_function("document.querySelectorAll('.pcard.live .f-row:not(.gh)').length === 5")
        ok('Removed a day from Peru · 1 more day to plan' in page.inner_text('#toast'), f'remove a day ({page.inner_text("#toast")!r})')
        # a second phase from the blank card
        page.click('.n-done'); ok(not page.query_selector('.n-done') and page.is_visible('.n-btn[aria-label^="Change nights in Lima"]'), 'Done closes the stepper')
        ok(not page.query_selector('.peek') and page.get_attribute('.tl-ph >> nth=0', 'aria-selected') == 'true', 'tabs; no phases peeking in at the sides')
        ok(page.is_visible('.pmap img.pmap-img') and 'Peru · 2 stops' in page.inner_text('.pmap-tag'), 'a map of the phase on the right')
        page.click('.tl-free'); page.wait_for_selector('.pcard.start')
        ok('Add a phase' in page.inner_text('.pcard.start .start-t'), 'the days-to-plan tab opens Add a phase')
        page.click('#firststop'); page.keyboard.type('Toky'); page.wait_for_selector('.ac-i:has-text("Tokyo")'); page.keyboard.press('Enter'); page.keyboard.press('Enter')
        page.wait_for_function("document.querySelectorAll('.tl-ph').length === 2")
        ok(page.input_value('.pcard.live input.pc-name') == 'Japan', 'second phase named after Japan')
        page.screenshot(path=str(SHOTS / '11-planner.png'))
        page.click('.tl-ph >> nth=0'); page.wait_for_timeout(100)
        ok(page.input_value('.pcard.live input.pc-name') == 'Peru', 'a tab picks the phase')
        page.fill('.pcard.live input.pc-name', 'Peru & Bolivia'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(any(p['name'] == 'Peru & Bolivia' and p['auto_name'] is False for p in db['phases']), 'rename stops auto-naming')
        page.click('.pcard.live button[aria-label^="More for"]'); page.click('.pmenu:not(.hidden) button:has-text("Move later")'); page.wait_for_timeout(200)
        ok(page.inner_text('.tl-ph >> nth=0').startswith('Japan'), f'move later ({page.inner_text("#toast")!r})')
        page.click('#toast button:has-text("Undo")'); page.wait_for_timeout(200)
        ok(page.inner_text('.tl-ph >> nth=0').startswith('Peru'), 'undo puts it back')
        # colour & photo
        page.click('.tl-ph >> nth=0'); page.click('.pcard.live button[aria-label^="More for"]')
        page.click('.pmenu:not(.hidden) button:has-text("Colour & photo")')
        page.click('.cp-swatches button[aria-label="Cherry"]')
        page.fill('.modal input[type=url]', 'http://nope'); page.click('.modal button[type=submit]')
        ok(page.is_visible('text=has to start with https://'), 'photo link must be https')
        page.fill('.modal input[type=url]', 'https://example.com/peru.jpg'); page.click('.modal button[type=submit]')
        page.wait_for_timeout(300)
        # delete the last phase
        page.click('.tl-ph >> nth=1'); page.click('.pcard.live button[aria-label^="More for"]')
        page.click('.pmenu:not(.hidden) button:has-text("Delete phase")')
        page.wait_for_function("document.querySelectorAll('.tl-ph').length === 1")
        page.wait_for_timeout(500)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        tid = [t for t in db['trips'] if t['name'] == 'Planner test'][0]['id']
        tdays = sorted([d for d in db['days'] if d['trip_id'] == tid], key=lambda d: d['idx'])
        tph = [p for p in db['phases'] if p['trip_id'] == tid]
        ok(len(tdays) == 21 and [d['idx'] for d in tdays] == list(range(21)) and len(tph) == 1 and tph[0]['name'] == 'Peru & Bolivia'
           and tph[0]['colour'] == '#C2002F' and tph[0]['photo_url'] == 'https://example.com/peru.jpg', f'saved layout matches the screen ({len(tdays)}, {[(p["name"], p["colour"], p["photo_url"]) for p in tph]})')
        ok([d['location'] for d in tdays if d['phase_id']] == ['Lima'] * 4 + ['Cusco'], 'Peru is Lima ×4 then Cusco')
        ok(any(pl['name'] == 'Cusco' and pl['country'] == 'Peru' for pl in db.get('places', [])), 'picked places are kept for the map')
        page.reload(); page.wait_for_selector('.pcard.live')
        ok(len(page.query_selector_all('.tl-ph')) == 1 and page.input_value('.pcard.live input.pc-name') == 'Peru & Bolivia', 'survives a reload')
        page.set_viewport_size({'width': 420, 'height': 860}); page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / '12-planner-phone.png'), full_page=True)
        page.set_viewport_size({'width': 1360, 'height': 900})
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 9e. the form → draft-trip (faked) → three routes in a table → tweak one → Build my trip
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .dest-in', 'Patagonia'); page.click('.seg-btn:has-text("Not yet")'); page.click('.len-pill:has-text("3 weeks")'); page.click('.fp:has-text("Fall")')
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.fsec')
        page.click('.fsg:has-text("Solo")'); page.click('.fp:has-text("Outdoor adventure")'); page.click('.fmore'); page.click('.fp:has-text("Markets")'); page.click('.fmore')
        ok(page.is_visible('.fp.on:has-text("Markets")') and len(page.query_selector_all('.fsec >> nth=0 >> .fp')) == 7, 'Show less keeps a picked interest visible')
        page.click('.fc:has-text("Slow and immersive")'); page.click('.fp:has-text("Multi-day treks")')
        page.click('.fsg:has-text("Buses & trains")'); page.check('.fchk input')
        ok(page.is_visible('.fsg.on:has-text("Solo")') and len(page.query_selector_all('.fsec >> nth=0 >> .fp.on')) == 2, 'picks show as on')
        page.click('.fxh:has-text("Start and end points")'); page.click('.fsg:has-text("End somewhere else")')
        page.click('.fin[aria-label="Starting in"]'); page.keyboard.type('Lisb'); page.wait_for_selector('.fxb .ac-i:has-text("Lisbon")')
        ok(True, 'start point suggests places')
        page.fill('.fin[aria-label="Starting in"]', 'Santiago'); page.fill('.fin[aria-label="Ending in"]', 'Buenos Aires')
        page.click('.fxh:has-text("Anything you must do?")')
        ok('open-jaw, from Santiago, to Bueno' in page.inner_text('.fx >> nth=0'), f"folded row shows a summary ({page.inner_text('.fx >> nth=0')!r})")
        page.fill('.fta', 'the W Trek')
        page.evaluate("localStorage.setItem('fake:draft', 'fail')")
        page.click('.nt-foot button:has-text("See my options")'); page.wait_for_selector('.modal .notice.warn:not(.hidden)')
        ok("couldn't make a draft just now" in page.inner_text('.modal .notice.warn') and page.is_visible('.fsg.on:has-text("Solo")'), 'a failed draft says so and keeps the answers')
        page.evaluate("localStorage.removeItem('fake:draft')")
        page.click('.nt-foot button:has-text("See my options")')
        ok(page.is_visible('text=Drawing up three routes'), 'shows it is working')
        page.wait_for_selector('.cx-tb')
        sent = page.evaluate('window.__lastInvoke')
        ok(sent['name'] == 'draft-trip' and sent['body'] == {'destination': 'Patagonia', 'days': 21, 'start': None, 'who': 'by myself', 'loves': ['outdoor adventure', 'markets'],
           'pace': 'slowly, 3+ nights per stop', 'fitness': 'multi-day treks', 'when': 'in autumn', 'from': 'Santiago', 'to': 'Buenos Aires', 'shape': 'open', 'must': ['the W Trek'], 'avoid': None,
           'transport': 'public', 'noFly': True}, f'sends the answers ({sent})')
        ok(page.evaluate("document.querySelector('.modal.newtrip').classList.contains('big')"), 'the pop-up grows for the routes')
        ok(page.inner_text('.rhdr .nt-ttl') == 'Three ways through Patagonia' and len(page.query_selector_all('.cx-c.hd')) == 3, 'three routes side by side')
        heads = [e.inner_text() for e in page.query_selector_all('.cx-rl')]
        ok([x for x in heads if x] == ['ONLY THIS ONE', 'HIGHLIGHTS', 'LEAVES OUT', 'GETTING AROUND', 'STOPS'] or [x.upper() for x in heads if x] == ['ONLY THIS ONE', 'HIGHLIGHTS', 'LEAVES OUT', 'GETTING AROUND', 'STOPS'], f'one row per question ({heads})')
        col = lambda k: page.evaluate('k => Array.from(document.querySelectorAll(".cx-c")).filter((e, i) => i % 3 === k).map(e => e.innerText).join(" | ")', k)
        c1 = col(0)
        ok('The big treks' in c1 and 'Only the big treks has the W Trek.' in c1 and 'W Trek, 5 days' in c1 and 'Skips the lakes' in c1 and '21 nights' in c1 and '2 flights · 1 bus' in c1 and 'Into Santiago, out of El Chaltén' in c1 and '!' not in c1, f'first column ({c1[:300]!r})')
        page.wait_for_selector('img.cx-img')
        ok(page.get_attribute('img.cx-img >> nth=0', 'src').startswith('https://api.mapbox.com/styles/v1/mapbox/light-v11/static/path-3') and len(page.query_selector_all('img.cx-img')) == 3, 'a map per route (a still image without Mapbox GL)')
        ok('Picked: The big treks' in page.inner_text('.nt-foot') and page.is_visible('.nt-foot button:has-text("Build my trip from this")'), 'footer: picked route and Build')
        page.screenshot(path=str(SHOTS / '13-routes.png'))
        ok(not page.query_selector('.cx-bar') and len(page.query_selector_all('img.cx-img')) == 3, 'no Map / List switch: maps and stops together')
        ok(len(page.query_selector_all('.cx-pl')) == 3 and 'Puerto Natales' in page.inner_text('.cx-pl >> nth=0') and 'W Trek, 5 days' in page.inner_text('.cx-pl >> nth=0') and '6 days' in page.inner_text('.cx-pl >> nth=0'), 'a Stops row under Getting around: phases and stops with days and what to do')
        page.click('.cx-c.hd >> nth=1')
        ok('Picked: Lakes first' in page.inner_text('.nt-foot') and page.is_visible('.cx-c.ft.on .twb') and len(page.query_selector_all('.twb')) == 1, 'picking a column; Tweak only under the picked one')
        page.click('.twb')
        ok(page.is_visible('.twt') and not page.is_visible('.nt-foot button:has-text("Build my trip")'), 'tweak box open; Build hides meanwhile')
        page.fill('.twt', 'make it short'); page.click('button:has-text("Redraw this route")'); page.wait_for_selector('.modal .notice.warn:not(.hidden)')
        ok("Couldn't redraw that route" in page.inner_text('.modal .notice.warn') and page.input_value('.twt') == 'make it short' and '21 nights' in page.inner_text('.cx-c.on >> nth=5'),
           'a redraw that covers much less of the trip is refused; the route and the typed change stay')
        page.fill('.twt', 'end in Buenos Aires'); page.click('button:has-text("Redraw this route")')
        page.wait_for_selector('.twd')
        tw = page.evaluate('window.__lastInvoke')['body']
        ok(tw['tweak']['text'] == 'end in Buenos Aires' and tw['tweak']['route']['name'] == 'Lakes first' and tw['tweak']['route']['phases'][0]['stops'][0]['place'] == 'Pucón', 'tweak sends the route and the change')
        ok('Changed: end in Buenos Aires' in page.inner_text('.cx-c.ft.on') and 'out of Buenos Aires' in page.inner_text('.cx-c.on >> nth=5') and 'The big treks' in page.inner_text('.cx-c.hd >> nth=0'), 'only that route is redrawn')
        page.click('.nt-foot button:has-text("Back to your answers")')
        ok(page.is_visible('.fsg.on:has-text("Solo")') and page.is_visible('.fp.on:has-text("Markets")'), 'back keeps the answers')
        page.click('.nt-foot button:has-text("See my options")'); page.wait_for_selector('.cx-tb')
        page.click('.nt-foot button:has-text("Build my trip from this")'); page.wait_for_selector('.pcard.live')
        ok([e.inner_text().split('\n')[0] for e in page.query_selector_all('.tl-ph')] == ['Central Chile', 'Patagonia'], 'the route is the trip, no review step')
        ok(page.input_value('.pcard.live input.pc-name') == 'Central Chile' and page.is_visible('.pcard.live .f-xfer:has-text("Santiago → Pucón")'), 'first phase open with its stops')
        page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        t = [x for x in db['trips'] if x['name'] == 'Patagonia'][0]
        ok(t['destination'] == 'Patagonia' and t['subtitle'] == 'Two short flights and most of your time on the trails.' and t['length_days'] == 21, f"trip keeps destination and the route's pitch ({t['subtitle']!r})")
        ok(sorted(p['name'] for p in db['places'] if p['trip_id'] == t['id']) == ['El Chaltén', 'Pucón', 'Puerto Natales', 'Santiago'], 'stops found on the map are kept')
        plans = [d['plan'] for d in sorted([d for d in db['days'] if d['trip_id'] == t['id']], key=lambda d: d['idx'])]
        ok(plans[0] == 'Arrive in Santiago' and plans[1] is None and plans[3] == 'Fly from Santiago' and plans[7] == 'Fly from Pucón' and plans[8] == 'Start W Trek (5 days)'
           and plans[10] == 'W Trek, day 3 of 5' and plans[12] == 'Finish W Trek' and plans[13] == 'Bus from Puerto Natales' and plans[14] == 'Fitz Roy day hikes' and plans[15] is None and plans[20] == 'Last night',
           f'only the fixed days are filled in ({plans})')
        autos = [d['plan'] for d in sorted([d for d in db['days'] if d['trip_id'] == t['id']], key=lambda d: d['idx']) if d.get('plan_auto')]
        ok(len(autos) == len([x for x in plans if x]), f'every prefilled day is marked ({len(autos)})')
        ideas = sorted((i['place'], i['text']) for i in db.get('stop_ideas', []) if i['trip_id'] == t['id'])
        ok(ideas == [('Puerto Natales', 'Grey Glacier boat'), ('Puerto Natales', 'Milodon Cave')], f"the stop's other lines are kept as ideas ({ideas})")
        ok(len(page.query_selector_all('.pcard.live .f-auto')) >= 2, 'prefilled plans show the mark')
        page.screenshot(path=str(SHOTS / '13c-prefilled.png'))
        page.fill('.pcard.live .f-in >> nth=0', 'Arrive, then the Lastarria walk'); page.wait_for_timeout(700)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        d0 = [d for d in db['days'] if d['trip_id'] == t['id'] and d['idx'] == 0][0]
        ok(d0['plan'] == 'Arrive, then the Lastarria walk' and d0['plan_auto'] is False, 'editing a prefilled plan makes it yours')

        # a day's stop ideas: select a day in Puerto Natales, see its ideas on the map, add one, open another's details
        page.click('.tl-ph:has-text("Patagonia")'); page.wait_for_selector('.pcard.live .f-stop:has-text("Puerto Natales")')
        pn = page.evaluate('''() => { const out = []; let on = false; for (const el of document.querySelectorAll('.pcard.live .flow > *')) {
          if (el.classList.contains('f-stop')) on = el.textContent.includes('Puerto Natales'); else if (on && el.dataset.day) out.push(el.dataset.day); } return out; }''')
        ok(not page.is_visible('.pmi'), 'no ideas card until a day is picked')
        sugg = page.inner_text('.pcard.live .f-sugg') if page.query_selector('.pcard.live .f-sugg') else ''
        page.click(f'.f-row[data-day="{pn[0]}"] .f-in'); page.wait_for_selector('.pmi:not(.hidden)')
        ok('Grey Glacier boat' in page.inner_text('.pmi') and 'Milodon Cave' in page.inner_text('.pmi') and 'Puerto Natales' in page.inner_text('.pmap-tag')
           and page.is_visible('.pmap-z') and page.query_selector(f'.f-row.sel[data-day="{pn[0]}"]'), "picking a day shows its stop's ideas on the map")
        page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        mc = [x for x in db['stop_ideas'] if x['text'] == 'Milodon Cave'][0]; gg = [x for x in db['stop_ideas'] if x['text'] == 'Grey Glacier boat'][0]
        ok(mc.get('lat') == -51.57 and mc.get('geo_tried') and gg.get('lat') is None and gg.get('geo_tried'), f'ideas are placed only when found near the stop ({mc.get("lat")}, {gg.get("lat")})')
        ok(page.inner_text('.pmi-r:has-text("Milodon Cave") .pmi-l') == 'A' and page.inner_text('.pmi-r:has-text("Grey Glacier boat") .pmi-l') == '•', 'only placed ideas get a map letter')
        page.click('.pmi-r:has-text("Grey Glacier boat") .f-use'); page.wait_for_timeout(400)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        dd = [d for d in db['days'] if d['id'] == pn[0]][0]
        ok(dd['plan'] == 'Fly from Pucón · Grey Glacier boat' and dd['plan_auto'] is False, f"an idea is added to the day's plan ({dd['plan']!r})")
        ok('In ' in page.inner_text('.pmi-r:has-text("Grey Glacier boat")') and page.is_visible('.pmi-r:has-text("Grey Glacier boat") .pmi-l.here'), 'the idea shows it is in this day')
        page.click('.pmi-r:has-text("Milodon Cave")'); page.wait_for_selector('.pmi-back')
        ok(page.is_visible('.pmi button:has-text("Add to")'), 'an idea opens its details')
        page.click('.pmi button:has-text("Add to")'); page.wait_for_timeout(400)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok([d for d in db['days'] if d['id'] == pn[0]][0]['plan'] == 'Fly from Pucón · Grey Glacier boat · Milodon Cave', 'a day can hold several ideas')
        page.screenshot(path=str(SHOTS / '13d-ideas.png'))
        page.click('.pmi-back'); page.click('.pmi-r:has-text("Grey Glacier boat") .f-use:has-text("Remove")'); page.wait_for_timeout(400)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok([d for d in db['days'] if d['id'] == pn[0]][0]['plan'] == 'Fly from Pucón · Milodon Cave', 'remove takes just that idea out')
        # Find more: For you (from the trip's saved interests) and Top visited, each its own list with a way back
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        tp = [t for t in db['trips'] if t['name'] == 'Patagonia'][0]
        ok(tp.get('prefs', {}).get('loves') == ['outdoor adventure', 'markets'], f"the trip keeps what they said they like ({tp.get('prefs')!r})")
        ok(page.is_visible('.pmi-card.you') and page.is_visible('.pmi-card.top') and 'recommended' in page.inner_text('.pmi').lower(), 'the card shows Recommended, then For you and Top visited')
        ok(page.query_selector('.f-row[data-day] .f-stay-b') is not None and 'Add a stay' in page.inner_text('.f-stay-b >> nth=0'), 'each stop shows where you sleep (not working yet)')
        page.click('.pmi-card.you'); page.wait_for_selector('.pmi-r:has-text("Puerto Natales market")')
        inv = page.evaluate('window.__lastInvoke')
        ok(inv['name'] == 'stop-ideas' and inv['body']['kind'] == 'you' and inv['body']['place'] == 'Puerto Natales' and inv['body']['prefs'] == ['outdoor adventure', 'markets', 'multi-day treks']
           and 'Grey Glacier boat' in inv['body']['have'], 'For you asks for that stop with their interests, and what it has')
        ok('You like outdoor adventure' in page.inner_text('.pmi') and not page.query_selector('.pmi-r:has-text("Grey Glacier boat")') and page.is_visible('.pmi-back'),
           'each idea says why, ones the stop already has are left out, and there is a way back')
        page.click('.pmi-r:has-text("Sea kayak in the fjord") .f-use'); page.wait_for_timeout(400)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok([d for d in db['days'] if d['id'] == pn[0]][0]['plan'].endswith('· Sea kayak in the fjord') and any(x['source'] == 'you' and x['reason'] == 'You like outdoor adventure' for x in db['stop_ideas']),
           'a For you idea is added to the day and kept with the trip')
        n = len(db['stop_ideas']); page.click('.pmi-back'); page.click('.pmi-card.you'); page.wait_for_timeout(300)
        ok(len(page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")['stop_ideas']) == n and page.is_visible('.pmi-r:has-text("Sea kayak")'), 'opening it again uses what was kept')
        page.click('.pmi-back'); page.click('.pmi-card.top'); page.wait_for_selector('.pmi-r:has-text("Mirador Dorotea hike")')
        ok(page.evaluate('window.__lastInvoke')['body']['kind'] == 'top', 'Top visited asks for the top list')
        page.click('.pmi-back')
        page.click('.pmap-z'); page.wait_for_timeout(100)
        ok(not page.is_visible('.pmi') and not page.query_selector('.f-row.sel'), 'whole phase clears the day')
        # a stop the route gave no ideas: Top visited stands in, and its empty days suggest from it
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        have = {x['place'] for x in db['stop_ideas'] if x['source'] == 'route'}
        ec = page.evaluate('''() => { const out = []; let on = false; for (const el of document.querySelectorAll('.pcard.live .flow > *')) {
          if (el.classList.contains('f-stop')) on = el.textContent.includes('El Chaltén'); else if (on && el.dataset.day) out.push(el.dataset.day); } return out; }''')
        if 'El Chaltén' not in have and ec:
            page.click(f'.f-row[data-day="{ec[-1]}"] .f-in'); page.wait_for_selector('.pmi-r:has-text("Mirador Dorotea hike")')
            ok('most visited here' in page.inner_text('.pmi').lower(), 'no route ideas: Top visited stands in')
            page.click('.pmap-z')
        else: ok(True, '(El Chaltén has route ideas in this run)')
        ok(sugg == '', 'no suggestion while every day at the stop is planned')
        page.fill(f'.f-row[data-day="{pn[2]}"] .f-in', ''); page.wait_for_timeout(700); page.click('.tl-ph:has-text("Central Chile")'); page.click('.tl-ph:has-text("Patagonia")')
        ok(page.inner_text(f'.f-row[data-day="{pn[2]}"] .f-sugg').startswith('✦') and 'Grey Glacier boat' in page.inner_text(f'.f-row[data-day="{pn[2]}"] .f-sugg'), 'an empty day suggests an idea not yet planned')
        page.click(f'.f-row[data-day="{pn[2]}"] .f-use'); page.wait_for_timeout(400)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok([d for d in db['days'] if d['id'] == pn[2]][0]['plan'] == 'Grey Glacier boat' and not any(page.query_selector(f'.f-row[data-day="{d}"] .f-sugg') for d in pn), 'use puts it on the day')
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 9f. import: pasted rows, then an .xlsx file
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.click('.nt-foot button:has-text("Import a plan you have")'); page.wait_for_selector('.imp-ta')
        ok('IMPORT A PLAN' in page.inner_text('.nt-lbl').upper() and page.is_disabled('.nt-foot button:has-text("Import plan")'), 'import screen; Import waits for a plan')
        page.fill('.imp-ta', 'https://docs.google.com/spreadsheets/d/abc'); page.wait_for_selector('.newtrip .notice')
        ok('Links are coming soon' in page.inner_text('.newtrip .notice'), 'links: coming soon, with the .csv tip')
        page.fill('.imp-ta', 'Place\tNights\nLisbon\t3\nPorto\t2\nTokyo\t4'); page.wait_for_selector('.imp-prev')
        ok('Found 3 stops · 9 days' in page.inner_text('.imp-prev') and 'Portugal: Lisbon (3), Porto (2)' in page.inner_text('.imp-prev'), f"pasted rows grouped by country ({page.inner_text('.imp-prev')!r})")
        import io, zipfile
        buf = io.BytesIO(); z = zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED)
        z.writestr('xl/sharedStrings.xml', '<sst><si><t>Date</t></si><si><t>Location</t></si><si><t>Region</t></si><si><t>Lima</t></si><si><t>Cusco</t></si><si><t>Coast</t></si><si><t>Andes</t></si></sst>')
        z.writestr('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
          + '<row r="2"><c r="A2" s="1"><v>46482</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" t="s"><v>5</v></c></row><row r="3"><c r="A3" s="1"><v>46483</v></c><c r="B3" t="s"><v>3</v></c><c r="C3" t="s"><v>5</v></c></row>'
          + '<row r="4"><c r="A4" s="1"><v>46484</v></c><c r="B4" t="s"><v>4</v></c><c r="C4" t="s"><v>6</v></c></row></sheetData></worksheet>')
        z.close()
        page.set_input_files('.newtrip input[type=file]', files=[{'name': 'Peru plan.xlsx', 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buffer': buf.getvalue()}])
        page.wait_for_selector('.imp-prev:has-text("Andes")')
        pv = page.inner_text('.imp-prev')
        ok('Found 2 stops · 3 days from Apr 5, 2027' in pv and 'Coast: Lima (2)' in pv and 'Andes: Cusco (1)' in pv and 'Peru plan.xlsx' in page.inner_text('.impdrop'), f'xlsx: one row per day, own phases, start date ({pv!r})')
        page.screenshot(path=str(SHOTS / '14-import.png'))
        page.click('.nt-foot button:has-text("Import plan")'); page.wait_for_selector('.pcard.live')
        ok([e.inner_text().split('\n')[0] for e in page.query_selector_all('.tl-ph')] == ['Coast', 'Andes'] and 'Apr 5 – Apr 7, 2027' in page.inner_text('.trip-head .meta').replace('Mon, ', '').replace('Wed, ', ''), f"imported trip ({page.inner_text('.trip-head .meta')!r})")
        ok(page.inner_text('.trip-head h1') == 'Peru plan' if page.query_selector('.trip-head h1') else True, 'named after the file')
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 10. delete
        page.click('.trip-card:has-text("Portugal")'); page.wait_for_selector('.planner')
        page.click('button[aria-label="Trip menu"]'); page.click('.menu button:has-text("Delete trip")')
        page.click('.modal .btn.danger'); page.wait_for_selector('.trip-card')
        ok('Portugal' not in page.inner_text('main'), 'trip gone from My trips')
        ok(True, 'trip deleted')

        # narrow window
        page.set_viewport_size({'width': 420, 'height': 860}); page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / '09-narrow.png'))
        b.close()
except Exception:
    print('\nERRORS so far:', *errors, sep='\n  ')
    raise
finally:
    server.terminate()

print('\nERRORS:' if errors else '\nAll good.', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
