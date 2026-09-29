/* Prove the fundamentals trim changes no score.
 *
 *   node tools/verify-snapshot.mjs <dump.json>
 *
 * Loads the real app.js in a sandbox (as the test suite does), scores every
 * symbol's fundamentals from the FULL filing history and again from the trimmed
 * history the snapshot publishes, and fails on any difference. The clock is
 * pinned to the snapshot's own moment for both runs. */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, trimFacts } from './build-snapshot.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dump = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const snap = buildSnapshot(dump);
const asOf = snap.core.asOf;

function loadApp() {
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
  return { run: (s) => runInContext(s, ctx), ctx };
}

const app = loadApp();
const state = app.run('state');
const fundamentalsFor = app.run('fundamentalsFor');
const cutoff = snap.fundamentals.keepFrom;

let compared = 0; let scored = 0; const diffs = [];
for (const [symbol, full] of dump.fx) {
  const price = snap.core.entries[symbol]?.q?.[0] ?? null;
  state.fx.facts.set(symbol, full);
  const a = JSON.stringify(fundamentalsFor(symbol, price));
  state.fx.facts.set(symbol, trimFacts(full, cutoff));
  const b = JSON.stringify(fundamentalsFor(symbol, price));
  compared++;
  if (JSON.parse(a).accruals != null || JSON.parse(a).earnYield != null) scored++;
  if (a !== b) diffs.push({ symbol, full: a, trimmed: b });
}
console.log(`compared ${compared} symbols (${scored} with a fundamentals score), trim from ${cutoff}: ${diffs.length} differ`);
for (const d of diffs.slice(0, 5)) console.log(d);
process.exit(diffs.length ? 1 : 0);
