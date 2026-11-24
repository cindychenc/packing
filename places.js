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


  // The best match for a name, or null (used to place the stops of a drafted trip).
  async function lookup(name, country) {
    const q = [name, country].filter(Boolean).join(', ');
    const fake = root.SUITCASE_PLACES_FAKE;
    if (fake) { const k = (name || '').toLowerCase(); return fake.find(p => p.name.toLowerCase() === k) || null; }
    const token = (root.SUITCASE_CONFIG || {}).mapboxToken;
    if (!token || !q.trim()) return null;
    try {
      const res = await fetch('https://api.mapbox.com/search/geocode/v6/forward?q=' + encodeURIComponent(q) +
        '&limit=1&types=place,locality,region,country&language=en&access_token=' + encodeURIComponent(token));
      if (!res.ok) return null;
      const f = ((await res.json()).features || [])[0];
      return f ? fromFeature(f) : null;
    } catch (e) { return null; }
  }

  // Google's encoded polyline (precision 5), as Mapbox Static Images wants for path overlays.
  function polyline(points) {
    let out = '', pLat = 0, pLng = 0;
    const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    points.forEach(([lat, lng]) => { const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5); out += enc(a - pLat) + enc(b - pLng); pLat = a; pLng = b; });
    return out;
  }
  // A static map image of the stops joined in order: [{ lat, lng, colour }].
  function staticMap(stops, w, hgt) {
    const token = (root.SUITCASE_CONFIG || {}).mapboxToken;
    const pts = stops.filter(p => p.lat != null && p.lng != null);
    if (!token || !pts.length) return null;
    const hex = c => (c || '#3F5675').replace('#', '').toLowerCase();
    const r6 = v => Math.round(v * 1e4) / 1e4;
    const over = [];
    if (pts.length > 1) over.push('path-3+3f5675-0.75(' + encodeURIComponent(polyline(pts.map(p => [p.lat, p.lng]))) + ')');
    pts.forEach(p => over.push('pin-s+' + hex(p.colour) + '(' + r6(p.lng) + ',' + r6(p.lat) + ')'));
    return 'https://api.mapbox.com/styles/v1/mapbox/light-v11/static/' + over.join(',') + '/auto/' + (w || 600) + 'x' + (hgt || 320) +
      '@2x?padding=40&access_token=' + encodeURIComponent(token);
  }

  const api = { suggest, lookup, staticMap, polyline, phaseNameFor, continentOf, fromFeature };
  root.SuitcasePlaces = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
