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
          window.SUITCASE_MAP_FAKE = true;""")
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
        ok(page.is_visible('.nt-foot button:has-text("Copy / import an existing plan")'), 'import button on the left of the footer')
        page.fill('.modal .dest-in', 'Portugal')
        page.click('.seg-btn:has-text("Not yet")')
        ok(page.is_disabled(nxt) and not page.is_visible('.rp-btn'), 'Next waits for a length; no calendar for Not yet')
        page.click('.len-pill:has-text("Months")')
        page.click('.len-pill.months button[aria-label=More]'); page.click('.len-pill.months button[aria-label=More]')
        ok('3 months' in page.inner_text('.len-pill.months') and page.is_enabled(nxt), 'months counter inside the pill; Next ready')
        page.click('.seg-btn:has-text("Yes, I do")')
        ok(page.is_disabled(nxt) and page.is_visible('.rp-pop') and not page.is_visible('.len-pill'), 'Yes opens the range calendar, lengths hidden')
        for _ in range(5): page.click('.rp-nav[aria-label="Next month"]')
        page.click('.rp-d[data-v="2027-04-05"]')
        ok('Now pick your last day' in page.inner_text('.rp-hd') and page.is_disabled('.rp-d[data-v="2027-04-04"]'), 'first tap = start; days before it are off')
        page.hover('.rp-d[data-v="2027-04-18"]')
        ok('14 days' in page.inner_text('.rp-btn') and len(page.query_selector_all('.rp-d.in')) == 12, 'hovering previews the range')
        page.click('.rp-d[data-v="2027-04-18"]')
        ok(not page.is_visible('.rp-pop') and 'Apr 5, 2027' in page.inner_text('.rp-btn') and 'Apr 18, 2027' in page.inner_text('.rp-btn') and page.is_enabled(nxt), f"second tap = end, calendar closes ({page.inner_text('.rp-btn')!r})")
        page.screenshot(path=str(SHOTS / '04-new-trip.png'))
        page.click(nxt); page.wait_for_selector('.sent')
        ok(page.inner_text('.sent').startswith('A 14-day trip through Portugal') and page.is_visible('.io:has-text("with my partner")'), 'sentence step, first blank open')
        ok(page.is_disabled('.nt-foot button:has-text("See my options")') and '3 blanks left' in page.inner_text('.nt-foot'), 'See my options waits for the blanks')
        ok(not page.is_visible('.addc:has-text("when")'), 'no "when" with exact dates')
        page.screenshot(path=str(SHOTS / '04b-sentence.png'))
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
        page.click('.pcard.start .btn.primary:has-text("Add")'); page.wait_for_selector('.pcard.live .f-place')
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
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.sent'); page.click('.modal .empty-start'); page.wait_for_selector('.planner')
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
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.sent'); page.click('.modal .empty-start'); page.wait_for_selector('.pcard.start')
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
        page.wait_for_selector('.pcard.live .f-place')
        ok(page.input_value('.pcard.live input.pc-name') == 'Peru' and rows() == 4, f'first stop makes the first phase ({rows()} rows)')
        ok('Added Lima (4 nights)' in page.inner_text('#toast'), 'toast says what happened')
        ok('17 days to plan' in page.inner_text('.tl-free'), 'timeline shows the days left to plan')
        page.wait_for_timeout(100)
        ok(page.evaluate("document.activeElement.classList.contains('stop-in')"), '"Add next stop" gets the cursor')
        page.keyboard.type('Cus'); page.wait_for_selector('.ac-i:has-text("Cusco")'); page.keyboard.press('Enter'); page.keyboard.press('Enter')
        page.wait_for_function("document.querySelectorAll('.pcard.live .f-stop:not(.add)').length === 2")
        ok(rows() == 6 and page.is_visible('.pcard.live .f-leg:has-text("Lima → Cusco")'), 'next stop added after Lima, with the leg between')
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
        ok(page.is_visible('.peek.r .pcard.blank'), 'blank "Add a phase" card beside the last phase')
        page.click('.peek.r'); page.wait_for_selector('.pcard.start')
        ok('Add a phase' in page.inner_text('.pcard.start .start-t') and page.is_visible('.peek.l .pcard'), 'Add a phase card, last phase on the left')
        page.click('#firststop'); page.keyboard.type('Toky'); page.wait_for_selector('.ac-i:has-text("Tokyo")'); page.keyboard.press('Enter'); page.keyboard.press('Enter')
        page.wait_for_function("document.querySelectorAll('.tl-ph').length === 2")
        ok(page.input_value('.pcard.live input.pc-name') == 'Japan', 'second phase named after Japan')
        page.screenshot(path=str(SHOTS / '11-planner.png'))
        page.click('.tl-ph >> nth=0'); page.wait_for_timeout(100)
        ok(page.input_value('.pcard.live input.pc-name') == 'Peru' and page.is_visible('.peek.r .pcard'), 'timeline picks the phase')
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

        # 9e. finish the sentence → draft-trip (faked) → three routes → Customize this plan
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .dest-in', 'Patagonia'); page.click('.seg-btn:has-text("Not yet")'); page.click('.len-pill:has-text("3 weeks")')
        page.click('.modal button:has-text("Next →")'); page.wait_for_selector('.sent')
        page.click('.io:has-text("by myself")')
        ok(', and I love' in page.inner_text('.sent') and not page.is_visible('.io:has-text("with my partner")'), 'a single-choice pick fills the blank and closes; solo wording')
        page.click('.blank:has-text("what you love")'); page.click('.io:has-text("nature & adventure")')
        page.fill('.inl .own', 'glaciers'); page.press('.inl .own', 'Enter')
        ok(page.is_visible('.io.on:has-text("glaciers")') and page.is_visible('.okc'), 'type your own adds a pill; several can be picked')
        page.click('.okc')
        page.click('.blank:has-text("at what pace")'); page.click('.io:has-text("slowly")')
        page.click('.addc:has-text("must do")'); page.click('.io:has-text("do a multi-day hike")'); page.click('.okc')
        ok('I must do a multi-day hike.' in page.inner_text('.sent') and 'Next: three routes' in page.inner_text('.nt-foot'), f"optional part added ({page.inner_text('.sent')!r})")
        page.evaluate("localStorage.setItem('fake:draft', 'fail')")
        page.click('.nt-foot button:has-text("See my options")'); page.wait_for_selector('.modal .notice.warn:not(.hidden)')
        ok("couldn't make a draft just now" in page.inner_text('.modal .notice.warn') and page.is_visible('.sent'), 'a failed draft says so and keeps the sentence')
        page.evaluate("localStorage.removeItem('fake:draft')")
        page.click('.nt-foot button:has-text("See my options")')
        ok(page.is_visible('text=Drawing up three routes'), 'shows it is working')
        page.wait_for_selector('.ro.on')
        sent = page.evaluate('window.__lastInvoke')
        ok(sent['name'] == 'draft-trip' and sent['body'] == {'destination': 'Patagonia', 'days': 21, 'start': None, 'who': 'by myself', 'loves': ['nature & adventure', 'glaciers'],
           'pace': 'slowly, 3+ nights per stop', 'when': None, 'from': None, 'to': None, 'must': ['do a multi-day hike'], 'avoid': None}, f'sends the sentence ({sent})')
        ok(page.evaluate("document.querySelector('.modal.newtrip').classList.contains('big')"), 'the pop-up grows for the routes')
        ok(page.inner_text('.rhdr .nt-ttl') == 'Three ways through Patagonia' and len(page.query_selector_all('.ro')) == 3, 'three options')
        r1 = page.inner_text('.ro.on')
        ok('Best for: nature & adventure' in r1 and 'W Trek, 5 days' in r1 and 'trails.' in r1 and '!' not in r1, f'picked route shows best-for and highlights ({r1[:120]!r})')
        ok('El Chaltén · 21 nights' in r1 or '21 nights' in r1, 'a route longer than the trip is cut to fit')
        ok([e.inner_text().split('\n')[0] for e in page.query_selector_all('.mtl .tl-ph')] == ['Central Chile', 'Patagonia'], 'phase timeline above the map')
        ok(page.get_attribute('.rmap-img', 'src').startswith('https://api.mapbox.com/styles/v1/mapbox/light-v11/static/path-3'), 'map falls back to a still image without Mapbox GL')
        page.screenshot(path=str(SHOTS / '13-routes.png'))
        page.click('.ro >> nth=1')
        ok('Volcano hikes' in page.inner_text('.ro.on') and page.is_visible('.ro.on .go') and len(page.query_selector_all('.ro .go')) == 1, 'clicking a card opens it; Customize only on the open one')
        page.click('.nt-foot button:has-text("Back to your sentence")')
        ok(page.is_visible('.sent') and 'glaciers' in page.inner_text('.sent'), 'back keeps the answers')
        page.click('.nt-foot button:has-text("See my options")'); page.wait_for_selector('.ro.on')
        page.click('.ro.on .go'); page.wait_for_selector('.pcard.live')
        ok([e.inner_text().split('\n')[0] for e in page.query_selector_all('.tl-ph')] == ['Central Chile', 'Patagonia'], 'the route is the trip')
        ok(page.input_value('.pcard.live input.pc-name') == 'Central Chile' and page.is_visible('.pcard.live .f-leg:has-text("Santiago → Pucón")'), 'first phase open with its stops')
        page.wait_for_timeout(300)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        t = [x for x in db['trips'] if x['name'] == 'Patagonia'][0]
        ok(t['destination'] == 'Patagonia' and t['subtitle'] == 'Two short flights and most of your time on the trails.' and t['length_days'] == 21, f"trip keeps destination and the route's pitch ({t['subtitle']!r})")
        ok(sorted(p['name'] for p in db['places'] if p['trip_id'] == t['id']) == ['El Chaltén', 'Pucón', 'Puerto Natales', 'Santiago'], 'stops found on the map are kept')
        plans = [d['plan'] for d in sorted([d for d in db['days'] if d['trip_id'] == t['id']], key=lambda d: d['idx'])]
        ok(plans[0] == 'Arrive in Santiago' and plans[3] == 'Fly from Santiago' and plans[8] == 'W Trek, 5 days' and plans[20].endswith('Last night'), f'day plans filled in ({plans[:9]} … {plans[20]})')
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 9f. import: pasted rows, then an .xlsx file
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.click('.nt-foot button:has-text("Copy / import")'); page.wait_for_selector('.imp-ta')
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
