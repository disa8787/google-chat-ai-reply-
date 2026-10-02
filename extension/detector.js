/*
 * Load offer detector.
 *
 * Decides whether a chat message (or several consecutive messages) is a
 * freight load offer from a broker, e.g.:
 *
 *   UF-6212077119 • Hammond, IN → Terrell, TX
 *   Live pickup: Oct 02, 2026, 00:01 - 23:59 CDT
 *   Live dropoff: Oct 05, 2026, 08:00 - 17:00 CDT
 *   Dry van
 *   11387 lbs
 *   $2460
 *
 * Works both as a content script (global `LoadOfferDetector`) and in Node
 * (`require('./detector')`) for tests.
 */
(function (root) {
  'use strict';

  const STATES =
    'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY' +
    '|ON|QC|BC|AB|MB|SK|NS|NB';

  // "Hammond, IN", "CHICAGO IL", "Winston-Salem, NC 27101"
  const PLACE = `[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}(?:,\\s*|\\s+)(?:${STATES})\\b(?:\\s+\\d{5})?`;
  const ROUTE_SEP = '\\s*(?:→|->|-->|=>|⇒|➔|➜|➡️?|>|–|—|-|\\bto\\b|\\bTO\\b)\\s*';

  const ROUTE_RE = new RegExp(`(${PLACE})${ROUTE_SEP}(${PLACE})`, 'u');
  const PLACE_RE = new RegExp(PLACE, 'g');

  // Each signal adds its weight to the score once.
  const SIGNALS = [
    { name: 'pickup', weight: 2, re: /\b(?:pick\s?-?ups?|p\/u|pu|shipper|origin|loading)\b/i },
    { name: 'delivery', weight: 2, re: /\b(?:drop\s?-?offs?|deliver(?:y|ies)?|del|dlv|consignee|destination|dest|receiver|unloading)\b/i },
    {
      name: 'equipment',
      weight: 2,
      re: /\b(?:dry\s?van|vans?|reefers?|flat\s?beds?|step\s?decks?|conestoga|power\s?only|hot\s?shot|box\s?truck|ftl|ltl|partial|tanker|lowboy|rgn|sprinter|(?:53|48)\s?(?:'|ft|foot|feet))(?![a-z])/i,
    },
    {
      name: 'weight',
      weight: 2,
      re: /(?:\b\d[\d,.]*\s*k?\s*(?:lbs?|pounds)\b|\b\d{1,3}(?:,\d{3})+\s?#|\b\d{2}(?:\.\d)?\s?k\b(?!m))/i,
    },
    {
      name: 'rate',
      weight: 2,
      re: /(?:\$\s?\d[\d,.]{2,}|\b\d[\d,]{2,}\s?(?:\$|usd)(?![a-z])|\b(?:all[\s-]?in|rpm|per\s?mile|flat\s?rate|paying)\b)/i,
    },
    {
      name: 'date',
      weight: 1,
      re: /(?:\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}:\d{2}\b|\b(?:today|tomorrow|tmrw|tonight|asap|appt|fcfs)\b)/i,
    },
    {
      name: 'loadId',
      weight: 1,
      re: /(?:\bUF-\d{5,}\b|\b(?:load|ld|ref|pro|order|po)\s*(?:#|no\.?|number)?\s*:?\s*#?\s*[A-Z0-9-]*\d{4,}[A-Z0-9-]*|#\s?\d{5,}\b)/i,
    },
    { name: 'miles', weight: 1, re: /\b\d{2,4}\s?(?:mi|miles)\b/i },
    {
      name: 'cargo',
      weight: 1,
      re: /\b(?:pallets?|commodity|hazmat|skids?|floor\s?loaded|tarps?|team|drop\s?trailer|live\s?(?:load|unload|pickup|pick\s?up|dropoff|drop\s?off)|packaging)\b/i,
    },
    {
      name: 'loadWord',
      weight: 1,
      re: /\b(?:loads?|available|need\s+(?:a\s+)?truck|can\s+you\s+(?:cover|take|do)|covered\?|capacity)\b/i,
    },
  ];

  // Words that show up after a load is booked (tracking, paperwork).
  // An offer almost never contains them.
  const NEGATIVE_RE =
    /\b(?:rate\s?con(?:firmation)?|rc\s+attached|booked|dispatched|tracking|check\s?call|eta|delivered|pod|bol\s+attached|signed|detention|lumper|invoice|paid)\b/i;

  const LOAD_ID_RE = /\bUF-\d{5,}\b|\b(?:load|ld|ref|pro|order|po)\s*(?:#|no\.?|number)?\s*:?\s*#?\s*([A-Z0-9-]*\d{4,}[A-Z0-9-]*)/i;

  function normalize(text) {
    return String(text || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function compact(text) {
    return normalize(text).toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
  }

  function extractLoadId(text) {
    const m = LOAD_ID_RE.exec(text);
    if (!m) return '';
    return (m[1] || m[0]).toUpperCase().replace(/\s+/g, '');
  }

  /**
   * @param {string} text  message text (several messages may be joined by "\n")
   * @returns {{isOffer: boolean, score: number, signals: string[], route: string, loadId: string, fingerprint: string}}
   */
  function analyze(text) {
    const t = normalize(text);
    const result = { isOffer: false, score: 0, signals: [], route: '', loadId: '', fingerprint: '' };
    if (t.length < 15 || t.length > 5000) return result;

    let score = 0;
    const signals = [];

    const route = ROUTE_RE.exec(t);
    const places = t.match(PLACE_RE) || [];
    if (route) {
      score += 3;
      signals.push('route');
      result.route = `${normalize(route[1])} → ${normalize(route[2])}`;
    } else if (places.length >= 2) {
      score += 1;
      signals.push('places');
    }

    const has = {};
    for (const s of SIGNALS) {
      if (s.re.test(t)) {
        score += s.weight;
        signals.push(s.name);
        has[s.name] = true;
      }
    }

    if (NEGATIVE_RE.test(t)) {
      score -= 4;
      signals.push('-booked');
    }

    result.score = score;
    result.signals = signals;
    result.loadId = extractLoadId(t);
    result.isOffer = score >= 6 && (Boolean(route) || (has.pickup && has.delivery));

    if (result.isOffer) {
      const date = SIGNALS.find((s) => s.name === 'date').re.exec(t);
      if (result.loadId) result.fingerprint = `id:${result.loadId}`;
      else if (result.route) result.fingerprint = `route:${compact(result.route)}|${date ? compact(date[0]) : ''}`;
      else result.fingerprint = `text:${compact(t).slice(0, 120)}`;
    }
    return result;
  }

  const api = { analyze, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LoadOfferDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
