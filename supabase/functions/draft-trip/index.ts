// Suitcase · draft-trip: turns the "finish the sentence" answers into three route options with Claude.
// Runs on Supabase (Deno). Needs the secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
// The key never reaches the browser. Only signed-in people can call this, up to DAILY_LIMIT drafts a day.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, KINDS, MODES, OUTLINE_SYSTEM, OUTLINE_TOOL, outlineMessage, STOPS_SYSTEM, STOPS_TOOL, stopsMessage, type Ask } from './prompt.ts';

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

  // One forced tool call; returns the tool's input, or null.
  async function ask_(system: string, tool: any, message: string, maxTokens: number): Promise<any> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, tools: [tool], tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: message }] }),
    });
    if (!res.ok) { console.error('anthropic', tool.name, res.status, await res.text()); return null; }
    const out = await res.json();
    if (out.stop_reason === 'max_tokens') console.warn(tool.name, 'cut off at max_tokens');
    return (out.content ?? []).find((c: any) => c.type === 'tool_use')?.input ?? null;
  }
  const fail = () => reply(502, { error: 'The AI couldn\'t make a draft just now. Try again in a minute.' });

  // Step 1: three outlines (phases with days).
  const outline = await ask_(OUTLINE_SYSTEM, OUTLINE_TOOL, outlineMessage(ask), 6000);
  const routes = Array.isArray(outline?.routes) ? outline.routes.filter((r: any) => Array.isArray(r?.phases) && r.phases.length) : [];
  if (!routes.length) return fail();
  // Phase days must add up to the trip: fix it here, where it's a handful of numbers.
  routes.forEach((r: any) => {
    r.phases.forEach((p: any) => { p.days = Math.max(1, Math.round(+p.days || 1)); });
    let sum = r.phases.reduce((a: number, p: any) => a + p.days, 0);
    if (sum !== ask.days) {
      console.warn('outline days', r.name, sum, 'of', ask.days);
      const k = ask.days / sum;
      r.phases.forEach((p: any) => { p.days = Math.max(1, Math.round(p.days * k)); });
      sum = r.phases.reduce((a: number, p: any) => a + p.days, 0);
      const big = r.phases.reduce((a: any, p: any) => (p.days > a.days ? p : a), r.phases[0]);
      big.days = Math.max(1, big.days + ask.days - sum);
    }
  });

  // Step 2: the stops for each route, all three at once.
  const filled = await Promise.all(routes.map((r: any) => ask_(STOPS_SYSTEM, STOPS_TOOL, stopsMessage(ask, r), Math.min(20000, 3000 + ask.days * 200))));
  const ready: any[] = [];
  routes.forEach((r: any, i: number) => {
    const got = Array.isArray(filled[i]?.phases) ? filled[i].phases : [];
    const phases = r.phases.map((p: any, j: number) => {
      const m = got.find((g: any) => g?.name === p.name) ?? got[j];
      const stops = (Array.isArray(m?.stops) ? m.stops : []).filter((s: any) => s && String(s.place ?? '').trim());
      const n = stops.reduce((a: number, s: any) => a + (Math.round(+s.nights) || 1), 0);
      if (n !== p.days) console.warn('stop nights', r.name, p.name, n, 'of', p.days);
      return { name: p.name, stops };
    }).filter((p: any) => p.stops.length);
    if (!phases.length) return;
    phases.forEach((p: any) => p.stops.forEach((st: any) => {
      if (st.next && !MODES.includes(st.next)) st.next = 'bus';
      st.plans = (Array.isArray(st.plans) ? st.plans : []).map((x: unknown) => String(x ?? '').slice(0, 120));
    }));
    ready.push({ ...r, phases, highlights: (Array.isArray(r.highlights) ? r.highlights : []).map(fixHl) });
  });
  if (!ready.length) return fail();
  const shared = (Array.isArray(outline.shared) ? outline.shared : []).map(fixHl);
  return reply(200, { draft: { description: String(outline.description ?? ''), shared, routes: ready }, model: MODEL });
});

// Unknown highlight types fall back to one the app can draw.
function fixHl(h: any) { return { ...h, kind: KINDS.includes(h?.kind) ? h.kind : 'other' }; }
