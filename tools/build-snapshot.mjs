/* Build the public demo snapshot from a private storage dump.
 *
 *   node tools/build-snapshot.mjs <dump.json>
 *
 * The dump is what the local board holds (localStorage entries plus the four
 * IndexedDB stores), read from a page on http://localhost:8080 that does not run
 * the app. It is private and never committed. This script decides what of it
 * becomes public, in data/snapshot/:
 *
 *   core.json          watchlist, cached quotes + analyst trends + insider, SEC
 *                      registrant map, plan flags, and the snapshot's own clock
 *   prices.json        daily price series (Technicals, Backtest)
 *   fundamentals.json  SEC facts, trimmed to recent periods (see FX_KEEP_YEARS)
 *   assessments.json   the assessment log, with spend and token usage removed
 *
 * Split so the board paints from core.json (small) while the rest streams in;
 * the app already rescores when prices or fundamentals land.
 *
 * ALLOWLISTED, not blocklisted: only the fields named here are copied. Anything
 * else in the dump — provider API keys among them — cannot reach the output by
 * being forgotten. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../data/snapshot/', import.meta.url));

/* Filing periods ending more than this long before the snapshot are dropped.
   Current fundamentals need the latest trailing year, the prior fiscal year and
   a year-earlier stretch to roll against, plus year-ago balances for averages.
   Four years is margin over all of that; verify-snapshot.mjs proves the scores
   are identical with and without the trim. */
export const FX_KEEP_YEARS = 4;

/* Assessment fields that are published. `usage` (tokens, dollar cost, service
   tier, inference region) is deliberately absent. */
const ASSESS_FIELDS = [
  'v', 'id', 'symbol', 'at', 'via', 'priceAt', 'sector', 'model',
  'brief', 'rating', 'ratingBasis',
  'callNear', 'callNearWhy', 'callLong', 'callLongWhy',
  'entryLevel', 'entryLevelBasis', 'entryLevelRejected', 'entryLevelUncited',
  'entryStance', 'entryStanceDeclared', 'entryLevelPct', 'entryLevelSigmas',
  'directional', 'concerns', 'structural', 'searchStatus', 'coverage',
  'dataQualityFlags', 'dataQualityLed', 'sources', 'scores',
];

export function buildSnapshot(dump) {
  const ls = dump.localStorage;

  const entries = {};
  for (const [k, v] of Object.entries(ls)) {
    if (!k.startsWith('bar.t.')) continue;
    const e = JSON.parse(v);
    if (e && typeof e.at === 'number') entries[k.slice('bar.t.'.length)] = e;
  }

  /* The board as it stood: the newest quote. Everything clock-dependent in the
     app (share-count age, staleness, assessment age) is evaluated at this moment
     in snapshot mode, so the demo does not decay as real time passes. */
  const asOf = Math.max(...Object.values(entries).map((e) => e.at));

  const plan = JSON.parse(ls['bar.plan']);
  const sec = JSON.parse(ls['bar.sec']);
  const series = Object.fromEntries(dump.px);

  const cutoff = new Date(asOf - FX_KEEP_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);
  const facts = {};
  for (const [symbol, rec] of dump.fx) facts[symbol] = trimFacts(rec, cutoff);

  const assessed = dump.assessments.map(([, a]) => pick(a, ASSESS_FIELDS)).sort((a, b) => b.at - a.at);

  const core = {
    format: 'bolt.snapshot', v: 1,
    asOf, builtAt: Date.now(),
    through: coverage({ entries, series, facts, assessments: assessed, gone: sec.gone }),
    watchlist: JSON.parse(ls['bar.watchlist']),
    entries,
    plan: { priceTarget: !!plan.priceTarget, insider: !!plan.insider, candle: !!plan.candle },
    sec: { at: sec.at, cik: sec.cik, gone: sec.gone },
  };

  const prices = { format: 'bolt.snapshot.prices', v: 1, series };
  const fundamentals = { format: 'bolt.snapshot.fundamentals', v: 1, keepFrom: cutoff, facts };
  const assessments = { format: 'bolt.snapshot.assessments', v: 1, entries: assessed };

  return { core, prices, fundamentals, assessments };
}

/* What each part of the snapshot is current through, read from the data rather
   than assumed from the build date. The September snapshot was dated by its
   newest quote while 232 of its quotes were twelve days older and its price
   history stopped three weeks short; nothing on the page said so. The banner
   renders this from core.json, so it is there before the larger files arrive.

   Spans are fetch times (ms) for quotes, analyst trends and filings, and write
   times for assessments. Price history is a bar date: `to` is the date most
   series end on, `behind` how many end before it.

   Symbols SEC lists as gone (no longer registered) are left out of the filing
   span and the price-history count: the app never refetches them, so their
   last record is final rather than stale, and one of them (AVB, October) was
   enough to mark every filing on the board as weeks old. */
export function coverage({ entries, series, facts, assessments, gone = [] }) {
  const live = ([symbol]) => !gone.includes(symbol);
  const span = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && x > 0);
    return v.length ? { from: Math.min(...v), to: Math.max(...v) } : null;
  };
  const tracked = Object.entries(series).filter(live).map(([, s]) => s).filter((s) => s && s.t);
  const ends = {};
  for (const s of tracked) ends[s.t] = (ends[s.t] || 0) + 1;
  const common = Object.entries(ends).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null;
  return {
    quotes: span(Object.values(entries).map((e) => e.at)),
    trends: span(Object.values(entries).map((e) => e.tAt)),
    prices: common ? { to: common, behind: tracked.filter((s) => s.t < common).length } : null,
    fundamentals: span(Object.entries(facts).filter(live).map(([, r]) => r.at)),
    assessments: span(assessments.map((a) => a.at)),
  };
}

/* Rows are newest-first. A row is kept if it ends inside the window OR is among
   the concept's newest FX_KEEP_ROWS regardless of date — annual (20-F) filers
   and stale filers reach further back than any date window, and a date-only trim
   changed four scores (BKNG, NU, SPOT, WIX). verify-snapshot.mjs checks it. */
export const FX_KEEP_ROWS = 16;

export function trimFacts(rec, cutoff, keepRows = FX_KEEP_ROWS) {
  const f = {};
  for (const [concept, rows] of Object.entries(rec.f || {})) {
    f[concept] = rows.filter((r, i) => r.e >= cutoff || i < keepRows);
  }
  return { cik: rec.cik, at: rec.at, f };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dumpPath = process.argv[2];
  if (!dumpPath) { console.error('usage: node tools/build-snapshot.mjs <dump.json>'); process.exit(1); }
  const built = buildSnapshot(JSON.parse(readFileSync(dumpPath, 'utf8')));
  mkdirSync(OUT, { recursive: true });
  let raw = 0; let gz = 0;
  for (const [name, obj] of Object.entries(built)) {
    const text = JSON.stringify(obj);
    writeFileSync(OUT + `${name}.json`, text);
    const z = gzipSync(text).length;
    raw += text.length; gz += z;
    console.log(`${name}.json`.padEnd(20), `${(text.length / 1e6).toFixed(2)} MB`, `gzip ${(z / 1e6).toFixed(2)} MB`);
  }
  console.log('total'.padEnd(20), `${(raw / 1e6).toFixed(2)} MB`, `gzip ${(gz / 1e6).toFixed(2)} MB`);
  console.log('as of', new Date(built.core.asOf).toISOString(), '| symbols', Object.keys(built.core.entries).length,
    '| series', Object.keys(built.prices.series).length, '| facts', Object.keys(built.fundamentals.facts).length,
    '| assessments', built.assessments.entries.length);
}
