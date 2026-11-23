"""Headless browser test for the Suitcase manager, against the in-memory fake backend.
Run from the repo root:  python3 tests/run.py   (serves the folder on :8000, writes screenshots to /tmp/shots)
"""
import os, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path('/tmp/shots'); SHOTS.mkdir(exist_ok=True)
FAKE = (ROOT / 'tests' / 'fake-supabase.js').read_text()

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

        # 3. new trip pop-up: "Not yet" first, then "Yes, I do"
        page.click('.empty .btn.primary')
        page.wait_for_selector('.modal.newtrip')
        ok(page.get_attribute('.seg-btn:has-text("Not yet")', 'aria-pressed') == 'true', 'defaults to Not yet')
        ok(page.get_attribute('.len-pill:has-text("1 week")', 'aria-pressed') == 'true', 'defaults to 1 week')
        page.click('.len-pill:has-text("Months")')
        page.click('.len-pill.months button[aria-label=More]'); page.click('.len-pill.months button[aria-label=More]')
        ok('3 months' in page.inner_text('.len-pill.months'), 'months counter inside the pill')
        page.click('.modal button[type=submit]')
        ok(page.is_visible('text=Give your trip a name'), 'name required')
        ok(page.is_visible('text=Already have a plan? Import it') and page.is_visible('.import-row .soon-tag'), 'import shown as Soon')
        page.click('.seg-btn:has-text("Yes, I do")')
        page.fill('.modal .big-name', 'Portugal in spring')
        page.click('.modal button[type=submit]')
        ok(page.is_visible('text=Pick a start date'), 'exact needs a start date')
        page.fill('.modal input[type=date]', '2027-04-05')
        for _ in range(7): page.click('.exact-row button[aria-label=Less]')
        ok('14 days' in page.inner_text('.exact-row'), 'length stepper')
        ok('Back on Sun, Apr 18, 2027' in page.inner_text('.back-on'), f"back-on line ({page.inner_text('.back-on')!r})")
        page.screenshot(path=str(SHOTS / '04-new-trip.png'))
        page.click('.modal button[type=submit]')
        page.wait_for_selector('table.itin')
        rows = page.query_selector_all('table.itin tbody tr')
        ok(len(rows) == 14, f'14 day rows created ({len(rows)})')
        ok('Mon, Apr 5 – Sun, Apr 18, 2027 · 14 days' in page.inner_text('.trip-head .meta'), f"header meta ({page.inner_text('.trip-head .meta')!r})")

        # 4. type a location, Enter moves down, autosave
        loc = lambda i: page.locator('table.itin tbody tr').nth(i).locator('textarea').nth(0)
        loc(0).click(); page.keyboard.type('Lisbon'); page.keyboard.press('Enter')
        ok(page.evaluate("document.activeElement.getAttribute('aria-label')").startswith('Location for Apr 6'), 'Enter moves to next day')
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

        # 6. tick days 1–5 (shift-click), set a new phase
        page.locator('.cell-day').nth(0).click(); page.locator('.cell-day').nth(4).click(modifiers=['Shift'])
        ok('5 days selected' in page.inner_text('.selbar'), 'range selection')
        page.select_option('.selbar select', '__new'); page.click('.selbar .btn:has-text("Set phase")')
        page.wait_for_selector('.phase-bar')
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(len(db['phases']) == 1 and sum(1 for d in db['days'] if d['phase_id']) == 5, 'phase created and assigned to 5 days')
        # second phase via the row dropdown
        page.locator('.phase-select').nth(5).select_option('__new')
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / '05-itinerary.png'), full_page=True)

        # 7. phases tab: rename + colour
        page.click('a.tab:has-text("Phases")'); page.wait_for_selector('.phase-row')
        n = page.locator('.phase-row .name-input').first
        n.fill('Lisbon & Sintra'); n.press('Enter'); page.wait_for_timeout(200)
        page.locator('.swatch-btn').first.click(); page.locator('.palette:not(.hidden) button').nth(2).click()
        page.wait_for_timeout(200)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        ok(any(ph['name'] == 'Lisbon & Sintra' and ph['colour'] == '#C24A00' for ph in db['phases']), 'phase renamed and recoloured')
        ok('Apr 5 → Apr 9, 2027 · 5 days' in page.inner_text('.phase-row'), 'phase dates from its days')
        page.screenshot(path=str(SHOTS / '06-phases.png'), full_page=True)

        # 8a. Edit dates: move the start date — the whole trip moves, plans stay on their day of the trip
        page.click('a.tab:has-text("Itinerary")'); page.wait_for_selector('table.itin')
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
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr').length === 15")
        page.click('.dates-editor button[aria-label="One day less"]')
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr').length === 14")
        page.evaluate("""() => { const db = JSON.parse(localStorage.getItem('fake:db')); db.days.find(d => d.idx === 13).plan = 'Fly home'; localStorage.setItem('fake:db', JSON.stringify(db)); }""")
        page.reload(); page.wait_for_selector('table.itin')
        page.click('.trip-head .link-btn:has-text("Edit dates")')
        page.click('.dates-editor button[aria-label="One day less"]')
        ok(page.is_visible('.modal:has-text("has plans")'), 'warns before deleting a day with plans')
        page.screenshot(path=str(SHOTS / '07-dates-warn.png'))
        page.click('.modal .btn.danger')
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr').length === 13")
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
        ok('Portugal in spring' in page.inner_text('.trip-card'), 'trip card shown')
        page.screenshot(path=str(SHOTS / '08-trips.png'))

        # 9b. a trip without dates, from the pop-up ("Not yet" · 2 weeks)
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .big-name', 'Someday Japan'); page.click('.len-pill:has-text("2 weeks")')
        page.click('.modal button[type=submit]'); page.wait_for_selector('table.itin')
        ok('14 days · no dates yet' in page.inner_text('.trip-head .meta'), 'rough trip created without dates')
        page.click('a.crumb'); page.wait_for_selector('.trip-card >> nth=1')
        card = page.inner_text('.trip-card:has-text("Someday Japan")')
        ok('no dates yet' in card.lower() and '14 days · dates open' in card, f'undated trip card ({card!r})')
        page.click('.trip-card:has-text("Someday Japan")'); page.wait_for_selector('table.itin')
        ok(len(page.query_selector_all('table.itin tbody tr')) == 14 and page.is_visible('textarea[aria-label="Location for Day 3"]'), 'undated trip opens with Day N labels')
        page.click('a.crumb'); page.wait_for_selector('.trip-card')

        # 9c. apply_layout in the fake backend (same rules as the database)
        res = page.evaluate("""async () => {
            const db = JSON.parse(localStorage.getItem('fake:db')); const t = db.trips.find(x => x.name === 'Someday Japan');
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

        # 10. delete
        page.click('.trip-card:has-text("Portugal")'); page.wait_for_selector('table.itin')
        page.click('button[aria-label="Trip menu"]'); page.click('.menu button:has-text("Delete trip")')
        page.click('.modal .btn.danger'); page.wait_for_selector('.trip-card')
        ok('Portugal' not in page.inner_text('main'), 'trip gone from My trips')
        ok(True, 'trip deleted')

        # narrow window
        page.set_viewport_size({'width': 420, 'height': 860}); page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / '09-narrow.png'))
        b.close()
finally:
    server.terminate()

print('\nERRORS:' if errors else '\nAll good.', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
