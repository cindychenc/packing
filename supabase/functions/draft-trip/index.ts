// Suitcase · draft-trip: turns the "finish the sentence" answers into three route options with Claude.
// Runs on Supabase (Deno). Needs the secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
// The key never reaches the browser. Only signed-in people can call this, up to DAILY_LIMIT drafts a day.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, KINDS, MODES, OUTLINE_SYSTEM, OUTLINE_TOOL, outlineMessage, STOPS_SYSTEM, STOPS_TOOL, stopsMessage, repairMessage, nightsFor, type Ask } from './prompt.ts';

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
    shape: body.shape === 'loop' || body.shape === 'open' ? body.shape : null,
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
  const stopTokens = Math.min(20000, 3000 + ask.days * 200);
  const tidyPhases = (r: any, got: any) => {
    const list = Array.isArray(got?.phases) ? got.phases : [];
    return r.phases.map((p: any, j: number) => {
      const m = list.find((g: any) => g?.name === p.name) ?? list[j];
      const stops = (Array.isArray(m?.stops) ? m.stops : []).filter((s: any) => s && String(s.place ?? '').trim());
      stops.forEach((st: any) => {
        st.nights = Math.max(1, Math.round(+st.nights) || 1);
        if (st.next && !MODES.includes(st.next)) st.next = 'bus';
        st.plans = (Array.isArray(st.plans) ? st.plans : []).map((x: unknown) => String(x ?? '').slice(0, 120));
        st.rest = st.rest === true;
        if (!(Math.abs(+st.lat) <= 90 && Math.abs(+st.lng) <= 180)) { delete st.lat; delete st.lng; }
      });
      return { name: p.name, stops };
    });
  };
  const shortOf = (r: any, phases: any[]) => phases.map((p: any, j: number) => ({ name: p.name, want: r.phases[j].days,
    have: p.stops.reduce((a: number, s: any) => a + s.nights, 0) })).filter((x: any) => x.have < x.want);
  const missing = (s: any[]) => s.reduce((a: number, x: any) => a + x.want - x.have, 0);

  const first = await Promise.all(routes.map((r: any) => ask_(STOPS_SYSTEM, STOPS_TOOL, stopsMessage(ask, r), stopTokens)));
  const filled = routes.map((r: any, i: number) => tidyPhases(r, first[i]));
  // Step 3, only where needed: routes with a phase short by 2+ nights get one more try (in parallel), kept if it's closer.
  const redo = routes.map((r: any, i: number) => ({ i, short: shortOf(r, filled[i]) })).filter((x: any) => missing(x.short) >= 2);
  if (redo.length) {
    redo.forEach((x: any) => console.warn('short', routes[x.i].name, JSON.stringify(x.short)));
    const again = await Promise.all(redo.map((x: any) => ask_(STOPS_SYSTEM, STOPS_TOOL, repairMessage(ask, routes[x.i], filled[x.i], x.short), stopTokens)));
    redo.forEach((x: any, k: number) => {
      const next = tidyPhases(routes[x.i], again[k]);
      if (next.every((p: any) => p.stops.length) && missing(shortOf(routes[x.i], next)) < missing(x.short)) filled[x.i] = next;
      else console.warn('repair did not help', routes[x.i].name);
    });
  }
  // Last step: make every phase add up exactly, so no days are left unplanned.
  // Too many nights come off the end of the phase. Missing nights go to its shortest stays first, up to 2 past the pace
  // (remote areas like the Pamirs don't have enough towns for 2-3 nights each), then round and round if still short.
  // Each added night gets a "Spare day" line, so it's clear it was added.
  const [, hi] = nightsFor(ask.pace);
  filled.forEach((phases: any[], i: number) => phases.forEach((p: any, j: number) => {
    const want = routes[i].phases[j].days, stops = p.stops;
    if (!stops.length) return;
    let have = stops.reduce((a: number, s: any) => a + s.nights, 0);
    for (let k = stops.length - 1; k >= 0 && have > want; k--) {
      const cut = Math.min(stops[k].nights - 1, have - want); stops[k].nights -= cut; stops[k].plans = stops[k].plans.slice(0, stops[k].nights); have -= cut;
    }
    if (have < want) console.warn('filled', routes[i].name, p.name, want - have, 'nights');
    for (let cap = hi + 2; have < want; cap = Infinity) {
      let grew = false;
      while (have < want) {
        // Rest stops and bigger stays take spare nights first; on long trips they're where a buffer belongs.
        const rest = stops.filter((s: any) => s.rest && s.nights < cap + 1);
        const room = rest.length ? rest : stops.filter((s: any) => s.nights < cap); if (!room.length) break;
        const low = Math.min(...room.map((s: any) => s.nights));
        for (const s of room) { if (have >= want) break; if (s.nights === low) { s.nights++; have++; grew = true; s.plans.push('Spare day: rest or a day trip from ' + s.place); } }
      }
      if (!grew && cap === Infinity) break;
    }
  }));
  const ready: any[] = [];
  routes.forEach((r: any, i: number) => {
    const phases = filled[i].filter((p: any) => p.stops.length);
    if (phases.length) ready.push({ ...r, phases, highlights: (Array.isArray(r.highlights) ? r.highlights : []).map(fixHl) });
  });
  if (!ready.length) return fail();
  const shared = (Array.isArray(outline.shared) ? outline.shared : []).map(fixHl);
  return reply(200, { draft: { description: String(outline.description ?? ''), shared, routes: ready }, model: MODEL });
});

// Unknown highlight types fall back to one the app can draw.
function fixHl(h: any) { return { ...h, kind: KINDS.includes(h?.kind) ? h.kind : 'other' }; }
