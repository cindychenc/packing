# draft-trip

Makes the rough trip draft for **Inspire me** in the new trip pop-up.
- The browser sends the destination, length, start date (if set), what you love and pace.
- This function asks Claude for a draft and sends it back.
- Nothing is saved until you press "Looks good" in the app.

- **`prompt.ts`**: the whole prompt. It holds the model, the rules for every draft, the message built from your answers, and the shape of the answer. Edit it to change how drafts come out.
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
