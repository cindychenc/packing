# stop-ideas

"Find more" in the planner's ideas card: more ideas for one stop.

- `kind: 'you'`: For you. A mix that fits what the traveller said they like when they made the trip (`trips.prefs`).
  Each idea comes back with the interest it fits, which the app shows as "You like …".
- `kind: 'top'`: Top visited. What most visitors to that place do.

What it sends to Claude: the place, its country, the month (when the trip has dates), the interests, and the titles the
stop already has. Never the trip itself.

Cost:
- Lists are cached by place (plus month and interests) in `public.place_ideas`, shared by everyone, so each list is asked
  of Claude once. The app also keeps each trip's copy in `stop_ideas`, so opening a list again makes no call at all.
- It uses Haiku, at most 700 output tokens, and a cached system prompt.
- Up to 60 calls to Claude per person per day (cache hits don't count). Each call is logged in `ai_drafts`
  (kind `ideas`, with tokens in and out), separate from the draft-trip limit.

## Set up

1. Run `supabase/migrations/006_more_ideas.sql` in the SQL Editor.
2. Deploy the function, either way:
   - Dashboard: **Edge Functions → Deploy a new function → Via editor**, name it `stop-ideas`, paste `index.ts`, deploy.
   - Command line: `supabase functions deploy stop-ideas --project-ref uebwqwyecdlbtmuxnwdm`
3. It uses the same `ANTHROPIC_API_KEY` secret as draft-trip. `SUPABASE_SERVICE_ROLE_KEY` is set by Supabase itself.
