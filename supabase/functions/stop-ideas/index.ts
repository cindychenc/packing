// Suitcase · stop-ideas: more ideas for one stop, for "Find more" in the planner's ideas card.
//   kind 'you': a mix drawn from what the traveller said they like, each with the reason ("You like markets").
//   kind 'top': what most visitors do there.
// Lists are shared by place in public.place_ideas, so each one is asked of Claude only once; they hold no trip data.
// Runs on Supabase (Deno). Needs ANTHROPIC_API_KEY. SUPABASE_SERVICE_ROLE_KEY (set by Supabase) is used only here,
// for the shared cache and the usage log. Only signed-in people can call it, up to DAILY_LIMIT calls to Claude a day.
import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = 'claude-haiku-5-5';   // small lists, so the small model
const DAILY_LIMIT = 60;
const ALLOWED = ['https://packing.boringcase.com', 'http://localhost:8000'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function cors(origin: string | null) {
  return { 'Access-Control-Allow-Origin': origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
}

// Kept the same on every call, so it's cached by the API too.
const SYSTEM = `You suggest things to do at one stop of a trip, for a trip-planning app. Answer with the ideas tool only.
Rules:
- 4 ideas, each a real thing at or near that place (a day trip is fine), that a traveller can put into a day.
- title: under 7 words, the thing itself ("Laguna de los Tres hike", "Mercado Central lunch"). No hotels.
- note: under 12 words, one concrete fact that helps decide or plan (best time, how to get there, booking). No adjectives like "stunning".
- len: how long it takes, short ("2 h", "Half day", "Evening").
- If a month is given, only suggest what works then.
- Don't repeat anything in "Already have".
- For "for you" lists: each idea must fit one of the listed interests; put that interest, copied exactly, in "because".
- For "top" lists: the things most visitors to this place do, best known first.`;

const TOOL = {
  name: 'ideas', description: 'Return the ideas.',
  input_schema: { type: 'object', required: ['ideas'], properties: { ideas: { type: 'array', minItems: 1, maxItems: 5, items: {
    type: 'object', required: ['title', 'note', 'len'], properties: {
      title: { type: 'string' }, note: { type: 'string' }, len: { type: 'string' },
      because: { type: 'string', description: 'For "for you" lists: the interest it fits, copied exactly from the list.' } } } } } },
};

Deno.serve(async (req) => {
  const head = cors(req.headers.get('Origin'));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...head, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: head });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const sb = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await sb.auth.getUser();
  if (!who?.user) return reply(401, { error: 'Sign in first.' });
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let b: any;
  try { b = await req.json(); } catch { return reply(400, { error: 'Bad request.' }); }
  const one = (v: unknown, n = 80) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : '');
  const kind = b.kind === 'you' ? 'you' : b.kind === 'top' ? 'top' : null;
  const place = one(b.place, 120), country = one(b.country, 60);
  const month = Number.isInteger(b.month) && b.month >= 0 && b.month < 12 ? MONTHS[b.month] : '';
  const prefs = (Array.isArray(b.prefs) ? b.prefs : []).map((x: unknown) => one(x, 40).toLowerCase()).filter(Boolean).slice(0, 8).sort();
  const have = (Array.isArray(b.have) ? b.have : []).map((x: unknown) => one(x, 80)).filter(Boolean).slice(0, 30);
  if (!kind || !place) return reply(400, { error: 'Which stop, and which kind of ideas?' });
  if (kind === 'you' && !prefs.length) return reply(400, { error: 'No interests saved for this trip.' });

  // The shared list for this place, if someone asked before.
  const key = [kind, place, country, month, kind === 'you' ? prefs.join(',') : ''].join('|').toLowerCase();
  const hit = await admin.from('place_ideas').select('items').eq('key', key).maybeSingle();
  if (hit.data?.items) return reply(200, { ideas: hit.data.items, cached: true });

  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { count } = await admin.from('ai_drafts').select('id', { count: 'exact', head: true }).eq('user_id', who.user.id).eq('kind', 'ideas').gte('created_at', since);
  if ((count ?? 0) >= DAILY_LIMIT) return reply(429, { error: 'That\'s a lot of ideas for one day. Try again tomorrow.' });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return reply(500, { error: 'The AI key isn\'t set up yet.' });
  // Only the place, the month and the interests are sent, never the trip.
  const message = [`Place: ${place}${country ? ', ' + country : ''}`, month ? `Month: ${month}` : '',
    kind === 'you' ? `List: for you. Interests: ${prefs.join('; ')}` : 'List: top',
    have.length ? `Already have: ${have.join('; ')}` : ''].filter(Boolean).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, tools: [TOOL], tool_choice: { type: 'tool', name: 'ideas' },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: message }] }),
  });
  if (!res.ok) { console.error('anthropic', res.status, await res.text()); return reply(502, { error: 'Couldn\'t find ideas just now. Try again in a minute.' }); }
  const out = await res.json();
  await admin.from('ai_drafts').insert({ user_id: who.user.id, kind: 'ideas', tokens_in: out.usage?.input_tokens ?? null, tokens_out: out.usage?.output_tokens ?? null });
  const raw = (out.content ?? []).find((c: any) => c.type === 'tool_use')?.input?.ideas ?? [];
  // The reason must be one of the traveller's own interests; anything else is dropped.
  const ideas = (Array.isArray(raw) ? raw : []).slice(0, 5).map((x: any) => {
    const because = one(x?.because, 40).toLowerCase();
    return { title: one(x?.title, 80), note: one(x?.note, 160), len: one(x?.len, 30), because: kind === 'you' && prefs.includes(because) ? because : null };
  }).filter((x: any) => x.title);
  if (!ideas.length) return reply(502, { error: 'Couldn\'t find ideas just now. Try again in a minute.' });
  await admin.from('place_ideas').upsert({ key, items: ideas, model: MODEL });
  return reply(200, { ideas, cached: false });
});
