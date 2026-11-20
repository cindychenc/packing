# Suitcase (packing.boringcase.com)

The trip manager for Suitcase: sign in, create trips, plan days and phases. The group sees trips in Carryon (carryon.boringcase.com).
Spec: `suitcase/SPEC.md` in the South America Trip Planning project.

- Plain HTML/CSS/JS, no build step. `index.html`, `app.css`, `app.js`, `config.js` (Supabase URL + publishable key, safe to be public).
- `lib/` self-hosted supabase-js 2.119.2 · `fonts/` Inter (OFL).
- `supabase/migrations/` database setup, run in the Supabase SQL Editor.
- Tests: `python3 tests/run.py` runs the app in headless Chrome against an in-memory fake backend (`tests/fake-supabase.js`). Screenshots go to `/tmp/shots`.
- Local preview: `python3 -m http.server 8000`, then http://localhost:8000 (allowed as a sign-in redirect in Supabase).

After changing `app.js` / `app.css`, bump the `?v=` in `index.html` so browsers fetch the new files.
