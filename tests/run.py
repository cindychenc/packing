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
        page.wait_for_selector('.planner .tray.alone'); page.mouse.move(5, 5)
        tt = page.inner_text('.tray.alone'); ok("Let's plan the first few days" in tt and len(page.query_selector_all('.tray-day')) == 14, f'new trip opens on the Planner, empty ({tt[:60]!r})')
        ok(page.is_visible('.fnav .fn.on:has-text("Planner")') and page.is_visible('.fnav .fn.off:has-text("Bookings")'), 'bottom nav: Planner on, Bookings soon')
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('.itin-empty')
        ok('Nothing on the itinerary yet' in page.inner_text('.itin-empty'), 'empty itinerary')
        ok('Mon, Apr 5 – Sun, Apr 18, 2027 · 14 days' in page.inner_text('.trip-head .meta'), f"header meta ({page.inner_text('.trip-head .meta')!r})")
        page.click('.itin-empty a:has-text("Start planning")'); page.wait_for_selector('.tray.alone')
        ok(True, 'Start planning goes to the Planner')
        page.locator('.tray-day').nth(4).click(); page.wait_for_selector('.pcol')
        page.wait_for_function("document.activeElement && document.activeElement.classList.contains('pname')")
        page.keyboard.type('Lisbon & Sintra'); page.keyboard.press('Enter'); page.wait_for_timeout(200)

        # 4. Itinerary grouped by phase: type a location, autosave
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('table.itin.grouped')
        ok(page.input_value('.ghead .gname') == 'Lisbon & Sintra' and 'Apr 5 – Apr 9 · 5 days' in page.inner_text('.ghead'), 'phase header row')
        ok(len(page.query_selector_all('table.itin tbody tr[data-id]')) == 5, '5 day rows under the phase')
        ok('9 more days to plan' in page.inner_text('.freebox') and 'Apr 10 – Apr 18' in page.inner_text('.freebox'), 'days to plan folded into one box')
        loc = lambda i: page.locator('table.itin tbody tr[data-id]').nth(i).locator('textarea').nth(0)
        loc(0).click(); page.keyboard.type('Lisbon'); loc(1).click()
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
        page.goto(U + '#/trip/' + tid + '/phases'); page.wait_for_selector('.pcol')
        ok(page.url.endswith('#/trip/' + tid), 'old Phases link opens the Planner')
        page.locator('.pcol').nth(0).locator('button[aria-label^="More for"]').click()
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
        ok('Portugal in spring' in page.inner_text('.trip-card'), 'trip card shown')
        page.screenshot(path=str(SHOTS / '08-trips.png'))

        # 9b. a trip without dates, from the pop-up ("Not yet" · 2 weeks)
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .big-name', 'Someday Japan'); page.click('.len-pill:has-text("2 weeks")')
        page.click('.modal button[type=submit]'); page.wait_for_selector('.planner')
        ok('14 days · no dates yet' in page.inner_text('.trip-head .meta'), 'rough trip created without dates')
        page.click('a.crumb'); page.wait_for_selector('.trip-card >> nth=1')
        card = page.inner_text('.trip-card:has-text("Someday Japan")')
        ok('no dates yet' in card.lower() and '14 days · dates open' in card, f'undated trip card ({card!r})')
        page.click('.trip-card:has-text("Someday Japan")'); page.wait_for_selector('.planner')
        ok(page.is_visible('.tray-day:has-text("DAY")') and len(page.query_selector_all('.tray-day')) == 14, 'undated trip: days are DAY 1, DAY 2…')
        page.click('.fnav a:has-text("Itinerary")'); page.wait_for_selector('.itin-empty')
        ok('14 days · no dates yet' in page.inner_text('.itin-empty'), 'undated empty itinerary')
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

        # 9d. the Planner
        page.click('.page-head .btn.primary'); page.wait_for_selector('.modal.newtrip')
        page.fill('.modal .big-name', 'Planner test'); page.click('.len-pill:has-text("3 weeks")')
        page.click('.modal button[type=submit]'); page.wait_for_selector('.tray.alone')
        days = page.locator('.tray-day')
        days.nth(3).hover()
        ok('Let\'s plan the first 4 days' in page.inner_text('.tray-title') and 'Day 1 – Day 4' in page.inner_text('.tray-hint'), 'hover previews the first phase')
        page.screenshot(path=str(SHOTS / '10-planner-empty.png'))
        days.nth(3).click()
        page.wait_for_selector('.pcol')
        ok(len(page.query_selector_all('.pcol .dcard')) == 4 and len(page.query_selector_all('.tray-day')) == 17, 'first phase from the tray (4 days, 17 left)')
        ok('Added Phase 1 (4 days)' in page.inner_text('#toast'), 'toast says what happened')
        page.wait_for_timeout(400)
        ok(page.evaluate("document.activeElement.classList.contains('pname')"), 'phase name gets the cursor')
        ph = page.get_attribute('.pcol .pname', 'placeholder')
        ok(ph and ('area to explore'.startswith(ph[-5:]) or 'First' in ph or ph.startswith('F') or ph.startswith('e.g')), f'animated placeholder ({ph!r})')
        page.keyboard.type('Tokyo'); page.keyboard.press('Enter')
        page.fill('input[aria-label="Where are you on Day 1"]', 'Tokyo')
        page.click('input[aria-label="Where are you on Day 3"]')
        page.wait_for_selector('.again')
        ok(len(page.query_selector_all('.again')) == 1 and 'Tokyo again' in page.inner_text('.again'), '"↓ Tokyo again" on the next day only')
        ok(page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Where are you on Day 3', 'cursor kept after redraw')
        page.click('.again'); page.wait_for_timeout(700)
        ok(page.input_value('input[aria-label="Where are you on Day 2"]') == 'Tokyo' and page.is_visible('input[aria-label="Plan for Day 2"]'), 'suggestion fills the place; plan field appears')
        page.click('.pcol .add-day')
        page.wait_for_function("document.querySelectorAll('.pcol .dcard').length === 5")
        ok('Tokyo +1 day' in page.inner_text('#toast'), 'add a day')
        page.locator('.tray-day').nth(2).click()
        page.wait_for_function("document.querySelectorAll('.pcol').length === 2")
        page.wait_for_function("document.activeElement && document.activeElement.classList.contains('pname')")
        page.keyboard.type('Kyoto'); page.keyboard.press('Enter')
        ok([len(c.query_selector_all('.dcard')) for c in page.query_selector_all('.pcol')] == [5, 3], 'second phase from the tray')
        # ••• Move left
        page.locator('.pcol').nth(1).locator('button[aria-label^="More for"]').click()
        page.click('.pmenu:not(.hidden) button:has-text("Move left")')
        page.wait_for_timeout(200)
        nm = [page.input_value(x) for x in ['.pcol >> nth=0 >> .pname', '.pcol >> nth=1 >> .pname']]
        ok(nm == ['Kyoto', 'Tokyo'], f'move left ({nm}, {page.inner_text("#toast")!r})')
        ok(page.input_value('input[aria-label="Where are you on Day 4"]') == 'Tokyo', 'days move with their phase')
        page.click('#toast button:has-text("Undo")'); page.wait_for_timeout(200)
        ok(page.input_value('.pcol >> nth=0 >> .pname') == 'Tokyo', 'undo puts it back')
        # remove a day
        page.locator('.pcol').nth(0).locator('.dcard').nth(4).hover()
        page.click('button[aria-label="Remove Day 5"]')
        page.wait_for_function("document.querySelectorAll('.pcol')[0].querySelectorAll('.dcard').length === 4")
        ok('Removed a day from Tokyo · Kyoto moved 1 day earlier' in page.inner_text('#toast'), f'remove a day ({page.inner_text("#toast")!r})')
        # trip bar: drag Tokyo's right edge 2 days to the right
        edge = page.locator('.tb-phase').nth(0).locator('.tb-edge')
        page.locator('.tb-phase').nth(0).hover()
        bb = edge.bounding_box(); bar = page.locator('.tripbar').bounding_box()
        dayw = bar['width'] / 21
        page.mouse.move(bb['x'] + 4, bb['y'] + 10); page.mouse.down()
        page.mouse.move(bb['x'] + 4 + dayw, bb['y'] + 10, steps=4); page.mouse.move(bb['x'] + 4 + 2 * dayw, bb['y'] + 10, steps=4); page.mouse.up()
        page.wait_for_function("document.querySelectorAll('.pcol')[0].querySelectorAll('.dcard').length === 6")
        ok('Tokyo +2 days' in page.inner_text('#toast'), 'drag the edge to resize')
        # trip bar: drag Kyoto to the front
        kb = page.locator('.tb-phase').nth(1).bounding_box()
        page.mouse.move(kb['x'] + 10, kb['y'] + 20); page.mouse.down()
        page.mouse.move(kb['x'] - 40, kb['y'] + 20, steps=4); page.mouse.move(bar['x'] + 5, kb['y'] + 20, steps=6); page.mouse.up()
        page.wait_for_timeout(300)
        ok(page.input_value('.pcol >> nth=0 >> .pname') == 'Kyoto', f'drag a block to reorder ({page.input_value(".pcol >> nth=0 >> .pname")!r} {page.inner_text("#toast")!r})')
        page.screenshot(path=str(SHOTS / '11-planner.png'))
        # colour & photo
        page.locator('.pcol').nth(0).locator('button[aria-label^="More for"]').click()
        page.click('.pmenu:not(.hidden) button:has-text("Colour & photo")')
        page.click('.cp-swatches button[aria-label="Cherry"]')
        page.fill('.modal input[type=url]', 'http://nope'); page.click('.modal button[type=submit]')
        ok(page.is_visible('text=has to start with https://'), 'photo link must be https')
        page.fill('.modal input[type=url]', 'https://example.com/kyoto.jpg'); page.click('.modal button[type=submit]')
        page.wait_for_timeout(300)
        # delete phase
        page.locator('.pcol').nth(1).locator('button[aria-label^="More for"]').click()
        page.click('.pmenu:not(.hidden) button:has-text("Delete phase")')
        page.wait_for_function("document.querySelectorAll('.pcol').length === 1")
        page.wait_for_timeout(500)
        db = page.evaluate("JSON.parse(localStorage.getItem('fake:db'))")
        tid = [t for t in db['trips'] if t['name'] == 'Planner test'][0]['id']
        tdays = sorted([d for d in db['days'] if d['trip_id'] == tid], key=lambda d: d['idx'])
        tph = [p for p in db['phases'] if p['trip_id'] == tid]
        ok(len(tdays) == 21 and [d['idx'] for d in tdays] == list(range(21)) and len(tph) == 1 and tph[0]['name'] == 'Kyoto'
           and tph[0]['colour'] == '#C2002F' and tph[0]['photo_url'] == 'https://example.com/kyoto.jpg', f'saved layout matches the screen ({len(tdays)}, {[(p["name"], p["colour"], p["photo_url"]) for p in tph]})')
        ok(sum(1 for d in tdays if d['phase_id']) == 3 and tdays[0]['phase_id'] == tph[0]['id'], 'Kyoto is days 1–3, the rest to plan')
        page.reload(); page.wait_for_selector('.pcol')
        ok(len(page.query_selector_all('.pcol')) == 1 and page.input_value('.pcol .pname') == 'Kyoto', 'survives a reload')
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
