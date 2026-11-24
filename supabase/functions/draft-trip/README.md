# draft-trip

Makes the three route options for step 3 of the new trip pop-up.
- The browser sends step 1 (destination, length, start date if set) and the "finish the sentence" answers: who, what you love, pace, and any of when, start point, end point, must do and rather avoid.
- This function asks Claude for three routes and sends them back. Each route has a name, tag, pitch, "best for", 2–4 highlights (the last one is its trade-off) and phases with stops.
- Nothing is saved until you press "Customize this plan" in the app.
- One set of three counts as one of the 20 drafts per day.

- **`prompt.ts`**: the whole prompt. It holds the model, the rules and voice for every draft (from `suitcase/VOICE.md`), the message built from your answers, and the shape of the answer. Edit it to change how drafts come out.
- **`index.ts`**: sign-in check, a daily limit (20 drafts per person), and the call to the Anthropic API.

## Set up (once)

1. **Run the migration.** Run `supabase/migrations/004_new_trip.sql` in the Supabase SQL Editor. It adds the trip destination and the `ai_drafts` table used for the daily limit.
2. **Add the API key.**
   - Create an API key at console.anthropic.com and set a monthly spend limit there.
   - In Supabase, go to **Edge Functions → Secrets → Add new secret**.
   - Name it `ANTHROPIC_API_KEY` and paste the key as its value.
   - Never put the key in the repo, `config.js` or a chat.
3. **Deploy the function.** Use either of these:
   - **Dashboard:**
     - Go to **Edge Functions → Deploy a new function → Via editor**.
     - Name it `draft-trip`.
     - Create two files, `index.ts` and `prompt.ts`, and paste in the contents of the files in this folder.
     - Deploy.
   - **Command line:**
     ```
     npx supabase login
     npx supabase functions deploy draft-trip --project-ref uebwqwyecdlbtmuxnwdm
     ```

Leave **Verify JWT** on (the default), so only signed-in people can call it.

## After editing the prompt

Redeploy the same way: paste the new `prompt.ts` in the dashboard editor, or run the deploy command again.

The app draws an icon for each highlight type. If you add a type to `KINDS` in `prompt.ts`, add its icon to `HL_ICONS` in `app.js` too.

**Deploy the function and the site together.** The app and this function changed shape together (three routes instead of one draft), so an old app with the new function, or the reverse, shows "The AI answer didn't make sense".
