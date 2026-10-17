/* Score every symbol exactly as the published snapshot board does.
 *
 *   node tools/snapshot-scores.mjs [out.json]
 *
 * Loads the real app.js in a sandbox (as verify-snapshot.mjs does), with the
 * clock pinned to the snapshot's asOf, and feeds it ONLY data/snapshot/ — the
 * same steps loadSnapshot() takes in the browser: entries -> rows, then price
 * series and SEC facts, then one rescore. Nothing fetched after the snapshot
 * reaches a score. Used by the forward test (docs/forward-test-2026-10.md). */
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'));
const core = read('data/snapshot/core.json');
const prices = read('data/snapshot/prices.json');
const fundamentals = read('data/snapshot/fundamentals.json');
const asOf = core.asOf;

const store = new Map();
class PinnedDate extends Date {
  constructor(...a) { super(...(a.length ? a : [asOf])); }
  static now() { return asOf; }
}
const sandbox = {
  console, setTimeout, clearTimeout, URL, Date: PinnedDate,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
  },
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  location: { origin: 'http://localhost:8080' },
  fetch: () => { throw new Error('no network'); },
};
sandbox.window = sandbox;
const ctx = createContext(sandbox);
runInContext(readFileSync(root + 'universe.js', 'utf8'), ctx);
runInContext(readFileSync(root + 'app.js', 'utf8').replace(/\ninit\(\);\s*$/, '\n'), ctx);

sandbox.__snap = { core, prices, fundamentals };
const rows = runInContext(`(() => {
  const { core, prices, fundamentals } = __snap;
  state.snapshot = { asOf: core.asOf, entries: core.entries, assessments: [] };
  Object.assign(PLAN, core.plan || {});
  if (core.sec) state.sec = { at: core.sec.at || 0, cik: core.sec.cik || {}, gone: core.sec.gone || [] };
  state.symbols = core.watchlist.filter((s) => core.entries[s]);
  state.symbolSet = new Set(state.symbols);
  state.rows.clear();
  for (const symbol of state.symbols) loadFromCache(symbol);
  for (const [symbol, series] of Object.entries(prices.series || {})) {
    if (usableSeries(series)) state.px.series.set(symbol, series);
  }
  state.px.hydrated = true;
  for (const [symbol, rec] of Object.entries(fundamentals.facts || {})) state.fx.facts.set(symbol, rec);
  state.fx.hydrated = true;
  applyTechnicals();
  applyOverall();

  const fields = {
    overall: 'overall',
    technicals: canonicalScore(domain('technicals')).field,
    fundamentals: canonicalScore(domain('fundamentals')).field,
    fundamentalsHeadline: primaryScore(domain('fundamentals')).field,
    analyst: canonicalScore(domain('analyst')).field,
  };
  return { fields, rows: [...state.rows.values()].map((r) => {
    const o = { symbol: r.symbol, sector: r.sector ?? null, price: r.price ?? null, overallParts: r.overallParts };
    for (const [k, f] of Object.entries(fields)) o[k] = r[f] ?? null;
    return o;
  }) };
})()`, ctx);

const out = { asOf, asOfIso: new Date(asOf).toISOString(), fields: rows.fields, rows: rows.rows };
const counts = Object.fromEntries(Object.keys(rows.fields).map((k) => [k, out.rows.filter((r) => r[k] != null).length]));
console.log('as of', out.asOfIso, '| rows', out.rows.length, '| scored', JSON.stringify(counts), '| fields', JSON.stringify(rows.fields));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out));
