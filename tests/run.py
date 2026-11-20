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

        # 3. new trip
        page.click('.empty .btn.primary')
        page.fill('.modal input:not([type=date])', 'Portugal in spring')
        dates = page.query_selector_all('.modal input[type=date]')
        dates[0].fill('2027-04-05'); dates[1].fill('2027-04-03')
        ok('before the start' in page.inner_text('.modal .count') or page.input_value('.modal input[type=date] >> nth=1') == '2027-04-05', 'end-before-start handled')
        dates[1].fill('2027-04-18')
        ok('14 days · 13 nights' in page.inner_text('.modal .count'), 'day count shown')
        page.screenshot(path=str(SHOTS / '04-new-trip.png'))
        page.click('.modal button[type=submit]')
        page.wait_for_selector('table.itin')
        rows = page.query_selector_all('table.itin tbody tr')
        ok(len(rows) == 14, f'14 day rows created ({len(rows)})')

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
        byDate = {d['date']: d for d in db['days']}
        ok(byDate['2027-04-07']['location'] == 'Sintra' and byDate['2027-04-08']['plan'] == 'Roman temple' and byDate['2027-04-09']['location'] == 'Monsaraz', 'multi-row paste saved')
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

        # 8. change dates so days with plans fall outside
        page.click('a.tab:has-text("Itinerary")'); page.wait_for_selector('table.itin')
        page.click('button[aria-label="Trip menu"]'); page.click('.menu button:has-text("Change dates")')
        page.locator('.modal input[type=date]').nth(0).fill('2027-04-08')
        page.click('.modal button[type=submit]')
        ok(page.is_visible('text=outside the new dates'), 'warns about days with plans')
        page.screenshot(path=str(SHOTS / '07-dates-warn.png'))
        page.click('.modal button[type=submit]')
        page.wait_for_function("document.querySelectorAll('table.itin tbody tr').length === 11")
        ok(True, 'dates changed to 11 days')

        # 9. My trips card
        page.click('a.crumb'); page.wait_for_selector('.trip-card')
        ok('Portugal in spring' in page.inner_text('.trip-card'), 'trip card shown')
        page.screenshot(path=str(SHOTS / '08-trips.png'))

        # 10. delete
        page.click('.trip-card'); page.wait_for_selector('table.itin')
        page.click('button[aria-label="Trip menu"]'); page.click('.menu button:has-text("Delete trip")')
        page.click('.modal .btn.danger'); page.wait_for_selector('.empty')
        ok(True, 'trip deleted')

        # narrow window
        page.set_viewport_size({'width': 420, 'height': 860}); page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / '09-narrow.png'))
        b.close()
finally:
    server.terminate()

print('\nERRORS:' if errors else '\nAll good.', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
