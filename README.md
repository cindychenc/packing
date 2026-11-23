# Suitcase (packing.boringcase.com)

The trip manager for Suitcase: sign in, create trips, plan days and phases. The group sees trips in Carryon (carryon.boringcase.com).
Spec: `suitcase/SPEC.md` in the South America Trip Planning project.

- Plain HTML/CSS/JS, no build step. `index.html`, `app.css`, `app.js`, `config.js` (Supabase URL + publishable key, safe to be public).
- `layout.js` the Planner's rules for phases and days (pure functions: new phase, resize, move, remove a day, trip length). Plan: `suitcase/PLAN-planner.md`.
- `lib/` self-hosted supabase-js 2.119.2 · `fonts/` Inter (OFL).
- `supabase/migrations/` database setup, run in order in the Supabase SQL Editor (`001_schema.sql`, then `002_planner.sql`: optional dates, days by position, `apply_layout`).
- Tests: `node tests/layout.test.js` (layout rules) and `python3 tests/run.py` runs the app in headless Chrome against an in-memory fake backend (`tests/fake-supabase.js`). Screenshots go to `/tmp/shots`.
- Local preview: `python3 -m http.server 8000`, then http://localhost:8000 (allowed as a sign-in redirect in Supabase).

After changing `app.js` / `app.css`, bump the `?v=` in `index.html` so browsers fetch the new files.
