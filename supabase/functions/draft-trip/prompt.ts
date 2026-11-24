// The words sent to Claude for "Inspire me". Edit freely: this file is the whole prompt.
// After editing, redeploy the function (see README.md in this folder).

export const MODEL = 'claude-haiku-5-5';   // fast and cheap; try 'claude-sonnet-5-5' for better routes

// The system prompt: who Claude is in this job and the rules for every draft.
export const SYSTEM = `You plan rough first drafts of trips for a trip-planning app.
The traveller will edit your draft, so aim for a sensible starting shape, not a final itinerary.

Rules:
- Use exactly the number of days given. The nights of all stops must add up to that number.
- Group stops into 1–6 phases. A phase is a region or a country the traveller moves through,
  named the way a traveller would say it ("Patagonia", "Northern Peru", "Kyoto & Kansai").
- Each stop is one base, usually a town or city, where the traveller sleeps one or more nights.
  Use the place's common English name, as it appears on a map. No hotels, trails or neighbourhoods as stops.
- Order stops along a realistic route with no backtracking unless there's no other way.
  Keep travel days in mind: long transfers eat into a stop.
- Pace: "Slow" means 3+ nights at most stops; "Mixed" means 2–4; "Packed" means 1–2.
- Match the traveller's interests. If they love hiking, put them near the trails.
- Think about the season: if dates are given, avoid places that are closed, snowed in or at their worst then.
- For each stop, give one short sentence on why it's in the trip, written to the traveller ("Base for the W Trek…").
- Write a 1–2 sentence description of the whole trip.
- Use the make_draft tool to answer. Don't write anything else.`;

// The message for one request, built from what the traveller picked in the pop-up.
export function userMessage(r: {
  destination: string; days: number; start?: string | null; loves: string[]; pace: string;
}): string {
  const when = r.start ? `starting ${r.start}` : 'dates not set yet';
  return [
    `Destination: ${r.destination}`,
    `Length: ${r.days} days (${when})`,
    `Loves: ${r.loves.length ? r.loves.join(', ') : 'anything'}`,
    `Pace: ${r.pace}`,
  ].join('\n');
}

// The shape Claude must answer in (a tool with a JSON schema, so the answer is always valid JSON).
export const TOOL = {
  name: 'make_draft',
  description: 'Return the drafted trip.',
  input_schema: {
    type: 'object',
    required: ['description', 'phases'],
    properties: {
      description: { type: 'string', description: '1–2 sentences about the whole trip.' },
      phases: {
        type: 'array', minItems: 1, maxItems: 6,
        items: {
          type: 'object', required: ['name', 'stops'],
          properties: {
            name: { type: 'string' },
            stops: {
              type: 'array', minItems: 1,
              items: {
                type: 'object', required: ['place', 'country', 'nights', 'why'],
                properties: {
                  place: { type: 'string', description: 'Town or city, common English name.' },
                  country: { type: 'string' },
                  nights: { type: 'integer', minimum: 1 },
                  why: { type: 'string', description: 'One short sentence.' },
                },
              },
            },
          },
        },
      },
    },
  },
};
