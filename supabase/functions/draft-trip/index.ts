// Suitcase · draft-trip: turns the "finish the sentence" answers into three route options with Claude.
// Runs on Supabase (Deno). Needs the secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
// The key never reaches the browser. Only signed-in people can call this, up to DAILY_LIMIT drafts a day.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, SYSTEM, TOOL, KINDS, MODES, userMessage, type Ask } from './prompt.ts';

const DAILY_LIMIT = 20;
const ALLOWED = ['https://packing.boringcase.com', 'http://localhost:8000'];

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req) => {
  const head = cors(req.headers.get('Origin'));
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...head, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: head });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  // Who is asking (the signed-in user's own token, so the database rules apply).
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: who } = await sb.auth.getUser();
  if (!who?.user) return reply(401, { error: 'Sign in first.' });

  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: 'Bad request.' }); }
  const one = (v: unknown, n = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const many = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => one(x)).filter((x): x is string => !!x).slice(0, 10);
  const ask: Ask = {
    destination: one(body.destination, 200) ?? '',
    days: Math.round(Number(body.days)),
    start: /^\d{4}-\d{2}-\d{2}$/.test(body.start ?? '') ? body.start : null,
    who: one(body.who), loves: many(body.loves), pace: one(body.pace), when: one(body.when),
    from: one(body.from), to: one(body.to), must: many(body.must), avoid: one(body.avoid),
  };
  if (!ask.destination || !(ask.days >= 1 && ask.days <= 731)) return reply(400, { error: 'Destination and length are needed.' });

  // Daily limit.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { count } = await sb.from('ai_drafts').select('id', { count: 'exact', head: true }).gte('created_at', since);
  if ((count ?? 0) >= DAILY_LIMIT) return reply(429, { error: `That's ${DAILY_LIMIT} drafts today. Try again tomorrow.` });
  await sb.from('ai_drafts').insert({ kind: 'inspire' });

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return reply(500, { error: 'The AI key isn\'t set up yet.' });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 10000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: userMessage(ask) }],
    }),
  });
  if (!res.ok) {
    console.error('anthropic', res.status, await res.text());
    return reply(502, { error: 'The AI couldn\'t make a draft just now. Try again in a minute.' });
  }
  const out = await res.json();
  const draft = (out.content ?? []).find((c: any) => c.type === 'tool_use')?.input;
  const routes = Array.isArray(draft?.routes) ? draft.routes.filter((r: any) => Array.isArray(r?.phases) && r.phases.length) : [];
  if (!routes.length) return reply(502, { error: 'The AI answer didn\'t make sense. Try again.' });
  // Unknown highlight types and travel modes fall back to ones the app can draw.
  const fixHl = (h: any) => ({ ...h, kind: KINDS.includes(h?.kind) ? h.kind : 'other' });
  routes.forEach((r: any) => {
    r.highlights = (Array.isArray(r.highlights) ? r.highlights : []).map(fixHl);
    r.phases.forEach((p: any) => (p.stops ?? []).forEach((st: any) => { if (st.next && !MODES.includes(st.next)) st.next = 'bus'; }));
  });
  const shared = (Array.isArray(draft.shared) ? draft.shared : []).map(fixHl);
  return reply(200, { draft: { description: String(draft.description ?? ''), shared, routes }, model: MODEL });
});
