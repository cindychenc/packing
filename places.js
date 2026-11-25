/* Suitcase · place lookup (Mapbox Geocoding v6) and phase names from places.
 * suggest(text) → Promise<[{ name, label, kind, country, cc, lat, lng }]>   kind: 'country' | 'region' | 'place'
 * phaseNameFor(place) → the country for a city or region, the continent for a country.
 * The token is a public pk. token limited to packing.boringcase.com and localhost:8000 (config.js).
 * Tests set window.SUITCASE_PLACES_FAKE to a list of places, so no request leaves the page.
 */
(function (root) {
  'use strict';

  // ISO 3166-1 alpha-2 country codes by continent.
  const CONT = {
    'South America': 'AR BO BR CL CO EC FK GF GY PE PY SR UY VE',
    'North America': 'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI',
    'Europe': 'AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK',
    'Asia': 'AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
    'Africa': 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW',
    'Oceania': 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
    'Antarctica': 'AQ BV GS HM TF'
  };
  const BY_CC = {};
  Object.keys(CONT).forEach(c => CONT[c].split(' ').forEach(cc => { BY_CC[cc] = c; }));
  const continentOf = cc => BY_CC[(cc || '').toUpperCase()] || null;

  function phaseNameFor(p) {
    if (!p) return null;
    if (p.kind === 'country') return continentOf(p.cc) || p.name;
    return p.country || null;
  }

  const KIND = { country: 'country', region: 'region', district: 'region', place: 'place', locality: 'place', neighborhood: 'place', poi: 'place' };
  function fromFeature(f) {
    const pr = f.properties || {}, ctx = pr.context || {}, co = ctx.country || {};
    const kind = KIND[pr.feature_type] || 'place';
    const coords = pr.coordinates || {};
    const geo = (f.geometry && f.geometry.coordinates) || [];
    return {
      name: pr.name,
      label: pr.place_formatted || pr.full_address || '',
      kind,
      country: kind === 'country' ? pr.name : (co.name || null),
      cc: ((kind === 'country' ? (pr.country_code || co.country_code) : co.country_code) || '').toUpperCase() || null,
      lat: coords.latitude != null ? coords.latitude : geo[1],
      lng: coords.longitude != null ? coords.longitude : geo[0]
    };
  }

  let ctrl = null;
  async function suggest(text) {
    const q = (text || '').trim();
    if (q.length < 2) return [];
    const fake = root.SUITCASE_PLACES_FAKE;
    if (fake) { const k = q.toLowerCase(); return fake.filter(p => p.name.toLowerCase().startsWith(k)).slice(0, 6); }
    const token = (root.SUITCASE_CONFIG || {}).mapboxToken;
    if (!token) return [];
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const url = 'https://api.mapbox.com/search/geocode/v6/forward?q=' + encodeURIComponent(q) +
      '&autocomplete=true&limit=6&types=country,region,place,locality&language=en&access_token=' + encodeURIComponent(token);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.features || []).map(fromFeature).filter(p => p.name);
    } catch (e) { return []; }
  }


  // Country name → ISO code ("Kyrgyzstan" → "KG"), from the browser's own country names plus a few other spellings.
  let NAME_CC = null;
  function ccFor(country) {
    if (!country) return null;
    if (!NAME_CC) {
      NAME_CC = { 'kyrgyz republic': 'KG', 'turkey': 'TR', 'türkiye': 'TR', 'usa': 'US', 'united states of america': 'US', 'uk': 'GB',
        'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'russia': 'RU', 'south korea': 'KR', 'north korea': 'KP', 'vietnam': 'VN',
        'laos': 'LA', 'czech republic': 'CZ', 'czechia': 'CZ', 'ivory coast': 'CI', 'burma': 'MM', 'myanmar': 'MM', 'holland': 'NL' };
      try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); Object.keys(BY_CC).forEach(cc => { const n = dn.of(cc); if (n) NAME_CC[n.toLowerCase()] = cc; }); }
      catch (e) { /* older browsers: the list above only */ }
    }
    const k = String(country).trim().toLowerCase();
    return NAME_CC[k] || (/^[a-z]{2}$/.test(k) && BY_CC[k.toUpperCase()] ? k.toUpperCase() : null);
  }
  const km = (a, b) => { const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) / 2 * r), y = (b.lat - a.lat) * r; return Math.sqrt(x * x + y * y) * 6371; };

  /* Where a drafted stop is, or null. Searches only inside its country, so "Song-Kol, Kyrgyzstan" can't land in Vietnam.
     near = the rough { lat, lng } Claude gave: a match much further away than that is wrong, and lakes, valleys and
     passes (which the geocoder doesn't know) fall back to it, marked approx. */
  async function lookup(name, country, near) {
    const fake = root.SUITCASE_PLACES_FAKE;
    if (fake) { const k = (name || '').toLowerCase(); return fake.find(p => p.name.toLowerCase() === k) || null; }
    const token = (root.SUITCASE_CONFIG || {}).mapboxToken;
    const cc = ccFor(country);
    const ok = near && isFinite(near.lat) && isFinite(near.lng) && Math.abs(near.lat) <= 90 && Math.abs(near.lng) <= 180 && !(near.lat === 0 && near.lng === 0);
    const rough = ok ? { name, label: country || '', kind: 'place', country: country || null, cc, lat: +near.lat, lng: +near.lng, approx: true } : null;
    if (!token || !String(name || '').trim()) return rough;
    try {
      const res = await fetch('https://api.mapbox.com/search/geocode/v6/forward?q=' + encodeURIComponent(name) + (cc ? '&country=' + cc.toLowerCase() : '') +
        (ok ? '&proximity=' + (+near.lng) + ',' + (+near.lat) : '') +
        '&limit=1&types=place,locality,region,district&language=en&access_token=' + encodeURIComponent(token));
      if (!res.ok) return rough;
      const f = ((await res.json()).features || [])[0];
      const p = f ? fromFeature(f) : null;
      if (!p || p.lat == null) return rough;
      if (cc && p.cc && p.cc.toUpperCase() !== cc) return rough;
      if (ok && km(p, near) > 250) return rough;
      return p;
    } catch (e) { return rough; }
  }

  // Google's encoded polyline (precision 5), as Mapbox Static Images wants for path overlays.
  function polyline(points) {
    let out = '', pLat = 0, pLng = 0;
    const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    points.forEach(([lat, lng]) => { const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5); out += enc(a - pLat) + enc(b - pLng); pLat = a; pLng = b; });
    return out;
  }
  // A static map image of the stops joined in order: [{ lat, lng, colour }].
  /* Each leg bowed into a gentle arc (a quadratic curve, sampled), so the static map's path reads like the wireframe's. */
  function curved(pts) {
    const out = [];
    pts.forEach((p, i) => {
      out.push([p.lat, p.lng]); const q = pts[i + 1]; if (!q) return;
      const dx = q.lng - p.lng, dy = q.lat - p.lat, b = 0.18;
      const c = [(p.lat + q.lat) / 2 + dx * b, (p.lng + q.lng) / 2 - dy * b];
      for (let t = 1; t < 8; t++) { const u = t / 8, v = 1 - u; out.push([v * v * p.lat + 2 * v * u * c[0] + u * u * q.lat, v * v * p.lng + 2 * v * u * c[1] + u * u * q.lng]); }
    });
    return out;
  }
  function staticMap(stops, w, hgt, opts) {
    const token = (root.SUITCASE_CONFIG || {}).mapboxToken;
    const pts = stops.filter(p => p.lat != null && p.lng != null);
    if (!token || !pts.length) return null;
    const hex = c => (c || '#3F5675').replace('#', '').toLowerCase();
    const r6 = v => Math.round(v * 1e4) / 1e4;
    const over = [];
    if (pts.length > 1) over.push('path-3+3f5675-0.75(' + encodeURIComponent(polyline(opts && opts.curve ? curved(pts) : pts.map(p => [p.lat, p.lng]))) + ')');
    pts.forEach(p => over.push('pin-s+' + hex(p.colour) + '(' + r6(p.lng) + ',' + r6(p.lat) + ')'));
    return 'https://api.mapbox.com/styles/v1/mapbox/light-v11/static/' + over.join(',') + '/auto/' + (w || 600) + 'x' + (hgt || 320) +
      '@2x?padding=40&access_token=' + encodeURIComponent(token);
  }

  const api = { suggest, lookup, ccFor, km, staticMap, curved, polyline, phaseNameFor, continentOf, fromFeature };
  root.SuitcasePlaces = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
