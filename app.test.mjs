/* Unit tests for the scoring and backtest maths.
   Run with:  node --test

   These load the real app.js rather than re-implementing any of it, so a change
   to the scoring code changes what the tests see. Nothing here touches the
   network, the DOM or a real browser: everything under test is a pure function
   over numbers.

   Tickers are invented on purpose. A real symbol in a fixture reads as a live
   quote to anyone skimming the file, and these numbers are made up. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Evaluate universe.js and app.js in one sandbox and hand back their innards.

    app.js is a browser script — no exports, and it ends by calling `init()`,
    which builds the entire UI. Everything above that line is declarations, so
    the loader drops that one trailing call and evaluates the rest. If the file
    stops ending that way the loader fails loudly rather than silently testing
    a half-initialised sandbox.

    Top-level `const` does not become a property of the sandbox object, so the
    values are pulled out by evaluating an expression in the same context,
    which can see the global lexical scope. */
function loadApp(seed = {}, { fakeClock = false } = {}) {
  const store = new Map(Object.entries(seed));

  /* A controllable clock, for the one thing in this file that is about time
     rather than arithmetic: the rate limiter. Real timers would spend a minute
     of wall clock asserting something that is pure scheduling, and a limiter
     nobody tests because testing it is slow is how the burst got in.

     Opt-in per instance. A fake Date leaks into every TTL, every `at` stamp and
     every freshness test in here, so the other 238 tests keep the real one. */
  let now = Date.parse('2026-09-01T12:00:00Z');
  const timers = [];
  const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const clock = {
    /** Run every timer due within `ms`, in order, moving the clock to each.
        Microtasks are drained around every step: `sleep` resolves a promise and
        the code waiting on it continues on the microtask queue, so a timer that
        fires without that drain leaves its continuation unrun and the next
        timer is scheduled against a clock nobody has advanced yet. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await drain();
        const due = timers
          .filter((t) => !t.fired && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.fired = true;
        due.fn();
      }
      now = target;
      await drain();
    },
  };

  const sandbox = {
    console,
    setTimeout: fakeClock
      ? (fn, ms) => timers.push({ at: now + (Number(ms) || 0), fn, fired: false })
      : setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    /* get() builds its URL against the page origin now that Finnhub is reached
       through the same-origin proxy rather than by absolute URL. `URL` is a
       host global, not a JS builtin, so a bare vm context has neither of these.
       Without both, every call fails as a ReferenceError — which has no
       `.status`, so a test asserting on an API error sees `undefined` and one
       asserting a soft failure passes for entirely the wrong reason. */
    location: { origin: 'http://localhost:8080' },
    URL,
    fetch: () => { throw new Error('tests must not reach the network'); },
  };
  /* Date.parse and the rest come through by inheritance; only `now` and a
     bare `new Date()` need to answer to the fake clock. */
  if (fakeClock) {
    sandbox.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  }

  sandbox.window = sandbox;
  const ctx = createContext(sandbox);

  runInContext(readFileSync(join(here, 'universe.js'), 'utf8'), ctx, { filename: 'universe.js' });

  const src = readFileSync(join(here, 'app.js'), 'utf8');
  const body = src.replace(/\ninit\(\);\s*$/, '\n');
  assert.notEqual(body, src, 'app.js no longer ends with init(); — update the test loader');
  runInContext(body, ctx, { filename: 'app.js' });

  const api = runInContext(`({
    combine, bandBuckets, quintileBuckets, bucketSpread,
    technicalsFor, technicalsAsOf, backtestRun, backtestStartDays,
    needsPrices, dayAtIndex, fetchRange, fetchSeries, pxFloorDay,
    isoDay, shiftDay,
    mean, state, SCORE_FIELDS, QUINTILE_LABELS, BACKTEST_BUCKETS, BUCKETING,
    MOM_LOOKBACK, MA_WINDOW, RANGE_WINDOW, PX_MAX_BARS, PX_YEARS,
    SCORE_DOMAINS, STATUS, boardColumns, sortKeysFor, defaultSortFor,
    passesFilters, activeFilters, seriesReturn, BENCHMARK,
    allScores, primaryScore, overallScores, overallFor, normaliseScore,
    sectionIds, detailTabFor, defaultDetailTab, OVERALL,
    dataColumns, filtersApply, rowPassesActiveFilters,
    allControls, sectionControls, passesSectionControls,
    capPerSector, sectorOf, SECTOR_CAP_DEFAULT,
    canonicalScore, overallDomains,
    coverageNote, backtestTabTitle, plainLabel, esc,
    applyCrossSectionalScores, cohortIneligible,
    extractFundamentals, FX_CONCEPTS, FX_FORMS, fundamentalsFor, SHARES_MAX_AGE_DAYS,
    registeredNotCountedHTML, fundamentalsBreakdownHTML, SUBSCORE_TERMS,
    ASSESS_CONCERNS, ASSESS_STRUCTURAL, ASSESS_MAX_SEARCHES, assessRequest, assessFlags, coverageBand,
    scanDirectional, DIRECTIONAL_PATTERNS, ASSESS_MODELS, ASSESS_MODEL_DEFAULT, loadAssessModel,
    batchPlan, parseSymbolList, assessModelShort,
    assessClick, queueDrop, queued, queuePosition, assessing,
    drainQueue, assessRun, assessBtnLabel, ASSESS_GLYPH,
    enqueuePlan, ASSESS_QUEUE_MAX, ASSESS_RECENT_N,
    ratingStats, ratingObservations, spearman, sampleSd,
    RATING_BUCKETS, RATING_VALUES, validRating, RATING_HORIZONS, RATING_MIN_DAYS,
    STATUS, STATUS_RULES, rules,
    summariseInsider, insiderContext, VOL_PIVOT, VOL_LOG_K, subScores, HOLDER_THRESHOLD,
    predatesRating, ASSESS_ENTRY_V, ratingDiagnosticsHTML, medianSplit, splitSpread,
    assessExport, assessImport, ASSESS_EXPORT_V, fxTTM, fxPaired,
    fxRollTTM, fxReconcile, fxPeriod, fxGateReasons, FX_RECONCILE_TOL,
    FX_FIX_AT, predatesFxFix,
    predatesProvenance, assessVia, ASSESS_REPEAT_WINDOW_MS,
    sameBoardContext, repeatPairs, humanAgo, humanWindow,
    PX_BASIS, DD_WINDOW, intradayCoverage, intradayBasisNote, paddedIntraday,
    firstIntradayDay, stampIntraday, maxDrawdown, realisedVol,
    DIRECTIONAL_FIELDS, ASSESS_PROSE_FIELDS, assessSchemaFields,
    CALL_NEAR_HORIZONS, CALL_LONG_HORIZONS, CALL_LONG_MIN_DAYS,
    validCall, validEntryLevel, entryLevelRejection, predatesCalls,
    entryLevelOutcomes, entryLevelStats, longSectionHTML, nearSectionHTML,
  })`, ctx);

  /* Function declarations become writable properties of the sandbox global, so
     a test can swap one out and the code under test picks up the replacement.
     That is how the network and the database are kept out of these tests
     without threading dependencies through the real code. */
  api.run = (src) => runInContext(src, ctx);
  api.advance = clock.advance;
  return api;
}

const app = loadApp();

/** Replace getFrom and writeSeries for one test: responses come from `pages`
    in order, and writes land in the in-memory Map only. Returns the recorded
    request URLs so a test can assert what was actually asked for. */
function stubPolygon(...pages) {
  const asked = [];
  app.run(`
    globalThis.__asked = [];
    globalThis.__pages = [];
    getFrom = async (id, path) => { __asked.push(path); return __pages.shift() || { results: [] }; };
    writeSeries = async (symbol, series) => { state.px.series.set(symbol, series); };
  `);
  app.run('__pages').push(...pages);
  return { asked: app.run('__asked'), urls: () => [...app.run('__asked')] };
}

/** A Polygon aggregates response: consecutive UTC days from `startDay`. */
const polygonBars = (startDay, closes) => ({
  results: closes.map((c, i) => ({
    t: Date.parse(`${startDay}T00:00:00Z`) + i * 86_400_000,
    c,
  })),
});

/** A Polygon response carrying intraday extremes, as the real one always did.

    `bars` are `{ c, h, l }`; a missing h/l models a bar the vendor returned
    without them. `polygonBars` above deliberately omits both, which is the
    shape a close-only test expects and must keep working. */
const polygonOHLC = (startDay, bars) => ({
  results: bars.map((b, i) => ({
    t: Date.parse(`${startDay}T00:00:00Z`) + i * 86_400_000,
    c: b.c, h: b.h, l: b.l,
  })),
});

/** Score/return pairs, for the bucketing functions. */
const pairs = (...scores) => scores.map((score, i) => ({ score, ret: i }));

/** Structural copy into this realm.

    Arrays and objects built inside the sandbox carry that context's own
    Array.prototype, so deepStrictEqual rejects them against a literal written
    here — "same structure but not reference-equal" — however well the contents
    match. Comparing copies sidesteps a realm boundary that has nothing to do
    with what is being tested. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A deterministic rising close series, `n` bars long. */
function rising(n, from = 100, step = 0.5) {
  return Array.from({ length: n }, (_, i) => from + i * step);
}

// ── combine ─────────────────────────────────────────────────────────

test('combine averages the two scores', () => {
  assert.equal(app.combine(80, 40), 60);
  assert.equal(app.combine(10, 10), 10);
});

test('combine withholds a score unless both sides exist', () => {
  assert.equal(app.combine(80, null), null);
  assert.equal(app.combine(null, 40), null);
  assert.equal(app.combine(null, null), null);
});

test('combine treats a zero score as a score, not as missing', () => {
  // `0 || null` would swallow this; the guard has to be an explicit null check.
  assert.equal(app.combine(0, 0), 0);
  assert.equal(app.combine(0, 50), 25);
});

// ── bandBuckets ─────────────────────────────────────────────────────

test('band edges are inclusive at the bottom of each band', () => {
  const buckets = app.bandBuckets(pairs(100, 80, 79.99, 60, 40, 20, 19.99, 0));
  const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.returns.length]));
  assert.equal(byLabel['80 – 100'], 2);   // 100 and exactly 80
  assert.equal(byLabel['60 – 80'], 2);    // 79.99 and exactly 60
  assert.equal(byLabel['40 – 60'], 1);
  assert.equal(byLabel['20 – 40'], 1);
  assert.equal(byLabel['0 – 20'], 2);     // 19.99 and 0
});

test('bandBuckets keeps every entry', () => {
  const entries = pairs(95, 71, 55, 33, 8, 50, 50);
  const kept = app.bandBuckets(entries).reduce((n, b) => n + b.returns.length, 0);
  assert.equal(kept, entries.length);
});

// ── quintileBuckets ─────────────────────────────────────────────────

test('quintiles are five equal groups when the count divides', () => {
  const buckets = app.quintileBuckets(pairs(...Array.from({ length: 100 }, (_, i) => i)));
  assert.equal(buckets.length, 5);
  assert.deepEqual(plain(buckets.map((b) => b.returns.length)), [20, 20, 20, 20, 20]);
});

test('quintile group sizes differ by at most one when the count does not divide', () => {
  for (const n of [7, 13, 99, 381, 397]) {
    const sizes = app.quintileBuckets(pairs(...Array.from({ length: n }, (_, i) => i)))
      .map((b) => b.returns.length);
    assert.equal(sizes.reduce((a, b) => a + b, 0), n, `n=${n} loses entries`);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} sizes ${sizes}`);
  }
});

test('quintiles run best score first', () => {
  // ret is the index, so entry {score: 90} carries ret 0 and is the best score.
  const buckets = app.quintileBuckets([
    { score: 90, ret: 1 }, { score: 10, ret: -1 },
    { score: 70, ret: 2 }, { score: 30, ret: -2 }, { score: 50, ret: 0 },
  ]);
  assert.deepEqual(plain(buckets.map((b) => b.returns)), [[1], [2], [0], [-2], [-1]]);
  assert.equal(buckets[0].label, app.QUINTILE_LABELS[0]);
});

test('quintiles of nothing are five empty groups, not a crash', () => {
  const buckets = app.quintileBuckets([]);
  assert.equal(buckets.length, 5);
  assert.ok(buckets.every((b) => b.returns.length === 0));
});

/* The reason the quintile cut exists. Averaging two scores that disagree pulls
   the result toward the middle, so the fixed bands catch far fewer names at the
   extremes for the average than for either input — which made the combined
   spread a two-symbol measurement. Ranking is immune to that contraction. */
test('averaging contracts the bands but not the quintiles', () => {
  const n = 400;
  const longs = Array.from({ length: n }, (_, i) => (i * 37) % 101);
  const shorts = Array.from({ length: n }, (_, i) => (i * 61) % 101);
  const combined = longs.map((l, i) => app.combine(l, shorts[i]));

  const extremes = (scores) => {
    const b = app.bandBuckets(pairs(...scores));
    return b[0].returns.length + b[b.length - 1].returns.length;
  };

  assert.ok(extremes(combined) < extremes(longs) / 2,
    'the combined bands should be far emptier at the extremes than the inputs');

  const sizes = (scores) => app.quintileBuckets(pairs(...scores)).map((b) => b.returns.length);
  assert.deepEqual(sizes(combined), sizes(longs),
    'quintile group sizes must not depend on how the score is distributed');
});

// ── bucketSpread ────────────────────────────────────────────────────

test('bucketSpread is top average minus bottom average', () => {
  const buckets = [
    { returns: [10, 20] },  // top, mean 15
    { returns: [] }, { returns: [] }, { returns: [] },
    { returns: [1, 3] },    // bottom, mean 2
  ];
  assert.equal(app.bucketSpread(buckets), 13);
});

test('bucketSpread is null when either end is empty', () => {
  const some = { returns: [5] };
  const none = { returns: [] };
  assert.equal(app.bucketSpread([none, some, some, some, some]), null);
  assert.equal(app.bucketSpread([some, some, some, some, none]), null);
  assert.equal(app.bucketSpread([some, none, none, none, some]), 0);
});

test('bucketSpread reports an inversion as a negative number', () => {
  const buckets = [{ returns: [-5] }, { returns: [] }, { returns: [] }, { returns: [] }, { returns: [15] }];
  assert.ok(app.bucketSpread(buckets) < 0);
});

// ── technicalsFor / combinedScore ────────────────────────────────────

test('a full series scores every factor it can, and combined tracks the combinables', () => {
  const row = app.technicalsFor({ c: rising(300) });

  for (const field of ['blendScore', 'mom12Only', 'mom6Only', 'lowVolOnly']) {
    assert.ok(row[field] != null, `${field} should score on a 300-bar series`);
  }
  /* zBlendScore is cross-sectional and technicalsFor sees one symbol, so it is
     null here by design — applyCrossSectionalScores fills it over a cohort. */
  assert.equal(row.zBlendScore, null, 'a cross-sectional score needs a cohort, not a series');
  /* A strictly rising series has no local extreme in it, so there is no
     support level below the price and the experimental factor is null. That
     is the honest answer for it rather than a manufactured one. */
  assert.equal(row.supportOnly, null, 'a monotonic series has no support levels');

  // mom12 is the only combinable score now, so Combined is mom12 itself. The
  // averaging machinery is kept for a third input — see docs/NOTES.md.
  assert.ok(Math.abs(row.combinedScore - row.mom12Only) < 1e-9);
});

test('a series too short for the twelve-month factors yields no blend', () => {
  /* 40 bars: enough for RSI and 52-week range position, which are display-only
     now, and far short of the 253 that both blend terms need. */
  const row = app.technicalsFor({ c: rising(40) });

  assert.equal(row.blendScore, null);
  assert.equal(row.mom12Only, null, 'twelve-month momentum needs 253 bars');
  assert.equal(row.lowVolOnly, null, 'so does twelve-month realised volatility');
  assert.ok(row.rsi14 != null, 'the demoted indicators still compute for display');
  assert.equal(row.combinedScore, null);
});

test('an empty series yields nulls rather than a plausible number', () => {
  const row = app.technicalsFor({ c: [] });
  for (const field of ['blendScore', 'zBlendScore', 'mom12Only', 'mom6Only', 'lowVolOnly',
                       'supportOnly', 'combinedScore']) {
    assert.equal(row[field], null, `${field} must be null, not a default`);
  }
  assert.equal(row.bars, 0);
});

/* The README's lookahead claim, which had no test behind it. */
test('a score is unchanged by bars that come after it', () => {
  const peak = rising(300);
  const atPeak = app.technicalsFor({ c: peak });

  const crashed = [...peak];
  for (let i = 0; i < 30; i++) crashed.push(crashed[crashed.length - 1] * 0.9);

  const asOfPeak = app.technicalsAsOf({ c: crashed }, peak.length - 1);
  assert.deepEqual(asOfPeak, atPeak, 'appending a crash changed an earlier score');
});

// ── backtestRun ─────────────────────────────────────────────────────

/** Point the shared state at a synthetic board and run one backtest. */
function runBacktest(series, startDay, holdMonths) {
  app.state.symbols = [...series.keys()];
  app.state.px.series = series;
  return app.backtestRun(startDay, holdMonths);
}

test('backtestRun buckets a symbol by its score and measures its forward return', () => {
  const series = new Map([
    ['ZZTOPA', { f: '2024-01-01', t: '2025-12-31', c: rising(500) }],
    ['ZZTOPB', { f: '2024-01-01', t: '2025-12-31', c: rising(500, 100, -0.1) }],
  ]);
  const run = runBacktest(series, '2025-06-01', 3);

  assert.equal(run.all.length, 2, 'both symbols should be measured');
  for (const field of app.SCORE_FIELDS) {
    const bucketed = run[field][app.BUCKETING.BANDS]
      .reduce((n, b) => n + b.returns.length, 0);
    assert.equal(bucketed, run[field].n, `${field} lost entries between scoring and bucketing`);
    assert.deepEqual(
      run[field][app.BUCKETING.QUINTILES].reduce((n, b) => n + b.returns.length, 0),
      run[field].n,
      `${field} lost entries in the quintile cut`,
    );
  }
});

test('backtestRun counts one-sided symbols and leaves them out of combined', () => {
  /* What decides a score is how many bars precede the start date, not how long
     the series is: technicalsAsOf slices there. Both span the same dates, so
     2025-06-01 falls ~70% along each — around bar 350 of ZZFULL, and around
     bar 210 of ZZTHIN. That is past six-month momentum's 127 bars and short of
     the 253 the twelve-month factors need, which is exactly the one-sided
     case: it scores on a factor, but not on the blend. */
  const series = new Map([
    ['ZZFULL', { f: '2024-01-01', t: '2025-12-31', c: rising(500) }],
    ['ZZTHIN', { f: '2024-01-01', t: '2025-12-31', c: rising(300) }],
  ]);
  const run = runBacktest(series, '2025-06-01', 3);

  assert.equal(run.all.length, 2, 'both scored on something, so both are measured');
  assert.equal(run.mom6Only.n, 2, 'six-month momentum reaches both');
  assert.equal(run.blendScore.n, 1, 'only the full series has twelve months behind it');
  assert.equal(run.oneSided, 1, 'the thin series is scored on one side only');
  assert.equal(run.combinedScore.n, 1, 'and so belongs in no combined bucket');
});

// ── Benchmark ───────────────────────────────────────────────────────

test('seriesReturn measures a stored series between two days', () => {
  app.state.px.series = new Map([['ZZBM', {
    f: '2025-01-01', t: '2025-12-31', c: rising(200, 100, 1),
  }]]);
  // Same series, so the return is whatever the two located bars give — the
  // point is that it is positive, finite, and uses the same lookup as a bucket.
  const r = app.seriesReturn('ZZBM', '2025-03-01', '2025-09-01');
  assert.ok(Number.isFinite(r) && r > 0);
  assert.equal(app.seriesReturn('ZZMISSING', '2025-03-01', '2025-09-01'), null);
});

test('seriesReturn refuses a window its series does not cover', () => {
  app.state.px.series = new Map([['ZZBM', { f: '2025-01-01', t: '2025-06-30', c: rising(120) }]]);
  assert.equal(app.seriesReturn('ZZBM', '2024-01-01', '2024-06-01'), null, 'before the series');
  assert.equal(app.seriesReturn('ZZBM', '2025-03-01', '2026-03-01'), null, 'past the series');
});

test('a run records the benchmark return and keeps it out of the buckets', () => {
  const span = { f: '2024-01-01', t: '2025-12-31' };
  const series = new Map([
    ['ZZONE', { ...span, c: rising(500) }],
    ['ZZTWO', { ...span, c: rising(500, 100, 0.4) }],
    [app.BENCHMARK, { ...span, c: rising(500, 50, 0.2) }],
  ]);
  // The benchmark is deliberately NOT in state.symbols.
  app.state.symbols = ['ZZONE', 'ZZTWO'];
  app.state.px.series = series;
  const run = app.backtestRun('2025-06-01', 3);

  assert.ok(Number.isFinite(run.bench), 'the window return is recorded');
  assert.equal(run.all.length, 2, 'the benchmark must not be measured as a symbol');
  const bucketed = run.blendScore.bands.reduce((n, b) => n + b.returns.length, 0);
  assert.ok(bucketed <= 2, 'the benchmark must not land in a bucket');
});

test('a run with no benchmark series reports null rather than zero', () => {
  app.state.symbols = ['ZZONE'];
  app.state.px.series = new Map([
    ['ZZONE', { f: '2024-01-01', t: '2025-12-31', c: rising(500) }],
  ]);
  const run = app.backtestRun('2025-06-01', 3);
  assert.equal(run.bench, null, 'a missing benchmark is unknown, not flat');
});

/* Why the spread table carries context columns instead of a "vs benchmark"
   one: the spread is a difference of two returns, so a benchmark common to
   both ends cancels exactly. Subtracting it would produce a copy of the
   column beside it. */
test('the bucket spread is already benchmark-neutral', () => {
  const buckets = [
    { returns: [12, 18] },                              // top, mean 15
    { returns: [] }, { returns: [] }, { returns: [] },
    { returns: [1, 3] },                                // bottom, mean 2
  ];
  const bench = 9;
  const shifted = buckets.map((b) => ({ returns: b.returns.map((v) => v - bench) }));

  assert.equal(app.bucketSpread(buckets), 13);
  assert.equal(app.bucketSpread(shifted), 13,
    'subtracting a common benchmark from both ends leaves the spread unchanged');
});

// ── The new factor maths ────────────────────────────────────────────

test('momentum 12−1 reads the two bars its definition names', () => {
  const c = rising(300);                       // 100, 100.5, 101, …
  const expected = (c[300 - 1 - 21] / c[300 - 1 - 252] - 1) * 100;

  assert.ok(Math.abs(app.run('momentum12m1m')(c) - expected) < 1e-9);
  assert.equal(app.run('momentum12m1m')(rising(252)), null, '252 bars is one short of enough');
});

test('a series with a constant daily return has no volatility', () => {
  // Every return is exactly +0.1%, so the standard deviation is zero.
  const c = Array.from({ length: 300 }, (_, i) => 100 * 1.001 ** i);
  assert.ok(Math.abs(app.run('realisedVol')(c)) < 1e-9);
});

test('realised volatility annualises the daily standard deviation', () => {
  /* Returns alternate exactly ±1%, so the daily sd is ~0.01 and the annualised
     figure is ~0.01 × √252 = 15.9%. Checked against the closed form rather than
     a recorded number, so the test says why it expects what it does. */
  const c = [100];
  for (let i = 1; i <= 300; i++) c.push(c[i - 1] * (i % 2 ? 1.01 : 0.99));

  const vol = app.run('realisedVol')(c);
  assert.ok(vol > 15.5 && vol < 16.3, `expected ~15.9% annualised, got ${vol}`);
});

test('max drawdown measures peak to trough, not first to last', () => {
  // Flat at 100, a trough at 60, recovering to 80. Deepest fall is 40%.
  const c = Array.from({ length: 300 }, () => 100);
  c[150] = 60;
  for (let i = 151; i < 300; i++) c[i] = 80;

  assert.ok(Math.abs(app.run('maxDrawdown')(c) - 40) < 1e-9);
  assert.equal(app.run('maxDrawdown')(rising(300)), 0, 'a series that only rises never draws down');
});

test('a support level needs two touches inside the band', () => {
  const twice = Array.from({ length: 100 }, () => 100);
  twice[20] = 90;
  twice[50] = 90;   // two local minima that agree on 90

  const levels = app.run('srLevels')(twice);
  assert.equal(levels.length, 1, 'the two troughs are one level');
  assert.equal(levels[0].touches, 2);
  assert.ok(Math.abs(app.run('supportDistance')(twice) - 10) < 1e-9,
    'the last close of 100 sits 10% above support at 90');

  const once = Array.from({ length: 100 }, () => 100);
  once[20] = 90;    // a single touch is not a level
  assert.deepEqual([...app.run('srLevels')(once)], []);
  assert.equal(app.run('supportDistance')(once), null);
});

test('a name at its low has no support beneath it to measure', () => {
  const falling = Array.from({ length: 100 }, (_, i) => 100 - i * 0.5);
  assert.equal(app.run('supportDistance')(falling), null,
    'null is the honest answer, not a manufactured distance');
});

/* The three inverted factors must read "lower is better" the same way, or a
   calm name would score well on one and badly on another for no reason. */
test('volatility and drawdown score higher the lower the reading', () => {
  const parts = (r) => app.run('subScores')(r);

  assert.ok(parts({ realisedVol: 15 }).volScore > parts({ realisedVol: 45 }).volScore);
  assert.ok(parts({ maxDD: 10 }).ddScore > parts({ maxDD: 50 }).ddScore);
  assert.ok(parts({ srDist: 2 }).srScore > parts({ srDist: 20 }).srScore,
    'sitting on support scores above being far off it');

  // At the pivot each reads exactly neutral.
  assert.ok(Math.abs(parts({ realisedVol: 30 }).volScore - 50) < 1e-9);
  assert.ok(Math.abs(parts({ maxDD: 30 }).ddScore - 50) < 1e-9);
});

test('a missing reading is null, not the pivot', () => {
  const parts = app.run('subScores')({});
  for (const k of ['volScore', 'ddScore', 'srScore', 'mom6Score', 'mom12Score']) {
    assert.equal(parts[k], null, `${k} must not score an unmeasurable name as neutral`);
  }
});

test('the blend is the equal-weighted mean of its two factors', () => {
  const row = app.technicalsFor({ c: rising(300) });
  const parts = app.run('subScores')(row);

  assert.ok(Math.abs(row.blendScore - (parts.mom12Score + parts.volScore) / 2) < 1e-9);
  assert.ok(Math.abs(row.mom12Only - parts.mom12Score) < 1e-9);
  assert.ok(Math.abs(row.lowVolOnly - parts.volScore) < 1e-9);
});

// ── The variance-normalised blend ───────────────────────────────────

/** A cohort of `n` rows whose two blend components have very different spreads,
    mirroring the real board (sd 16.2 momentum vs 26.9 volatility). */
function cohort(n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    mom12m1m: -20 + i * 1.0,      // narrow spread
    realisedVol: 10 + i * 0.9,    // wide spread
  }));
}

test('the plain blend is dominated by its wider component', () => {
  const rows = cohort();
  const parts = rows.map((r) => app.run('subScores')(r));
  const sd = (v) => { const m = v.reduce((a,b)=>a+b,0)/v.length;
    return Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/(v.length-1)); };

  const sdMom = sd(parts.map((p) => p.mom12Score));
  const sdVol = sd(parts.map((p) => p.volScore));
  assert.ok(sdVol > sdMom * 1.3,
    'the fixture reproduces the real imbalance the z-blend exists to correct');
});

test('the z-blend gives its two components equal influence', () => {
  const rows = cohort();
  app.run('applyCrossSectionalScores')(rows);

  const sd = (v) => { const m = v.reduce((a,b)=>a+b,0)/v.length;
    return Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/(v.length-1)); };
  const corr = (xs, ys) => {
    const mx = xs.reduce((a,b)=>a+b,0)/xs.length, my = ys.reduce((a,b)=>a+b,0)/ys.length;
    let sxy=0, sxx=0, syy=0;
    for (let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy;}
    return sxy/Math.sqrt(sxx*syy);
  };

  const parts = rows.map((r) => app.run('subScores')(r));
  const z = rows.map((r) => r.zBlendScore);
  assert.ok(z.every((v) => v != null), 'every row in the cohort scores');

  const cMom = Math.abs(corr(z, parts.map((p) => p.mom12Score)));
  const cVol = Math.abs(corr(z, parts.map((p) => p.volScore)));
  assert.ok(Math.abs(cMom - cVol) < 0.05,
    `z-blend should track both halves alike, got mom ${cMom.toFixed(3)} vol ${cVol.toFixed(3)}`);
  assert.ok(sd(z) > 0, 'and it must actually vary');
});

test('a cohort too small to standardise scores nothing', () => {
  const rows = cohort(5);                       // under Z_MIN_COHORT
  app.run('applyCrossSectionalScores')(rows);
  assert.ok(rows.every((r) => r.zBlendScore === null),
    'a mean and sd over five names describe noise, not the cohort');
});

test('a row missing either component gets no z-blend', () => {
  const rows = cohort();
  rows[0].realisedVol = null;                   // one leg only
  app.run('applyCrossSectionalScores')(rows);

  assert.equal(rows[0].zBlendScore, null,
    'a one-legged z-blend is just that leg, which defeats the purpose');
  assert.ok(rows[1].zBlendScore != null, 'and its neighbours are unaffected');
});

// ── Portfolio risk figures ──────────────────────────────────────────

test('a steadier bucket earns a higher Sharpe at the same return', () => {
  /* Two paths ending at the same place: one straight, one zig-zagging there.
     Equal return, unequal volatility, so Sharpe must separate them. */
  /* The calm path still has to wobble: a perfectly constant return has zero
     volatility, and a Sharpe with zero on the bottom is null, not infinite. */
  const steady = [100];
  for (let i = 1; i <= 130; i++) steady.push(steady[i - 1] * (i % 2 ? 1.003 : 1.001));
  const jumpy = [100];
  for (let i = 1; i <= 130; i++) jumpy.push(jumpy[i - 1] * (i % 2 ? 1.05 : 0.9543));

  app.state.px.series = new Map([
    ['ZZCALM', { f: '2025-01-01', t: '2025-07-01', c: steady }],
    ['ZZWILD', { f: '2025-01-01', t: '2025-07-01', c: jumpy }],
  ]);

  const calm = app.run('portfolioStats')(['ZZCALM'], '2025-01-01', '2025-07-01');
  const wild = app.run('portfolioStats')(['ZZWILD'], '2025-01-01', '2025-07-01');

  assert.ok(calm.vol < wild.vol, 'the zig-zag path is the more volatile one');
  assert.ok(calm.sharpe > wild.sharpe, 'and so earns less per unit of risk');
  assert.ok(calm.days > 100 && wild.days > 100, 'both measured over the same window');
});

test('an empty bucket reports null risk, never zero', () => {
  app.state.px.series = new Map();
  const stats = app.run('portfolioStats')([], '2025-01-01', '2025-07-01');

  assert.deepEqual([stats.annReturn, stats.vol, stats.sharpe], [null, null, null],
    'zero volatility would rank an empty bucket as the safest thing on the board');
});

test('a two-symbol bucket is equal-weighted, not concatenated', () => {
  const up = [100], flat = [100];
  for (let i = 1; i <= 130; i++) { up.push(up[i - 1] * 1.004); flat.push(100); }
  app.state.px.series = new Map([
    ['ZZUP', { f: '2025-01-01', t: '2025-07-01', c: up }],
    ['ZZFLAT', { f: '2025-01-01', t: '2025-07-01', c: flat }],
  ]);

  const both = app.run('portfolioStats')(['ZZUP', 'ZZFLAT'], '2025-01-01', '2025-07-01');
  const solo = app.run('portfolioStats')(['ZZUP'], '2025-01-01', '2025-07-01');

  assert.ok(Math.abs(both.annReturn - solo.annReturn / 2) < 1e-6,
    'half the portfolio earns nothing, so the return halves');
});

// ── The score registry ──────────────────────────────────────────────

/* The Technicals domain is organised one factor per score. Every id here is
   named rather than counted, so adding a seventh factor breaks this test
   loudly instead of letting a registry change pass unnoticed. */
const FUND_SCORE_IDS = ['earnYield', 'bookToMkt', 'roe', 'accruals'];
const TECH_SCORE_IDS = ['mom12', 'blend', 'zblend', 'momband', 'momscreen', 'mom6', 'lowvol', 'support'];

/** A sandbox whose `id` score has been demoted to failed.

    Nothing in the shipped registry is failed any more — every factor is
    untested by design — so the tests for what `failed` does have to create one.
    `rules()` reads `status` at call time, so flipping it here is enough. */
function withFailedScore(id = 'support') {
  const a = loadApp();
  a.run(`allScores().find((s) => s.id === '${id}').status = STATUS.FAILED`);
  return a;
}

test('a domain owns its scores, and a section is not a score', () => {
  assert.deepEqual(plain(app.SCORE_DOMAINS.map((d) => d.id)), ['technicals', 'fundamentals', 'analyst']);
  const tech = app.SCORE_DOMAINS.find((d) => d.id === 'technicals');
  assert.deepEqual(plain(tech.scores.map((s) => s.id)), TECH_SCORE_IDS,
    'Technicals is one section owning several scores');
  assert.equal(app.primaryScore(tech).id, 'mom12', 'the headline score leads');
  assert.deepEqual(plain(app.allScores().map((s) => s.id)),
    [...TECH_SCORE_IDS, ...FUND_SCORE_IDS, 'analyst']);
});

test('nothing is validated or failed, and external is not a promotion', () => {
  const statuses = new Set(app.allScores().map((s) => s.status));
  for (const s of statuses) {
    assert.ok(s === 'untested' || s === 'external',
      `nothing on this board has been measured, so ${s} has no business in the registry`);
  }

  /* `external` must buy no capability that `untested` does not. It records
     whose evidence a score rests on, not what it is allowed to do — if the two
     ever diverge, borrowed evidence would start granting privileges here. */
  const rules = (id) => app.run(`STATUS_RULES['${id}']`);
  for (const prop of ['sortable', 'backtest', 'filterable']) {
    assert.equal(rules('external')[prop], rules('untested')[prop],
      `external and untested must agree on ${prop}`);
  }
});

/* An `external` score has to say what the evidence IS and what would move it.
   The tag alone reads the same on momentum, which has decades of replication
   and accumulating windows, as on the analyst score, which rests on a
   weak-to-negative literature and cannot be backtested at all. */
test('every external score carries its evidence and its path out', () => {
  const external = app.allScores().filter((s) => s.status === 'external');
  assert.ok(external.length, 'the fixture is pointless if nothing is external');

  for (const s of external) {
    assert.ok(s.evidence && s.evidence.length > 40, `${s.id} must say what it rests on`);
    assert.ok(s.pathOut && s.pathOut.length > 40, `${s.id} must say what would move it`);
  }
});

/* A blend inherits its components' data, not their evidence. */
test('a locally assembled blend does not inherit an external tag', () => {
  const byId = Object.fromEntries(app.allScores().map((s) => [s.id, s]));
  for (const id of ['blend', 'zblend']) {
    assert.equal(byId[id].status, 'untested',
      `${id} was assembled here; nobody published it`);
  }
  for (const id of ['mom12', 'mom6', 'lowvol']) {
    assert.equal(byId[id].status, 'external', `${id} is a replicated factor`);
  }
});

/* The analyst score cannot be backtested, so its path out is forward-only.
   Status and testability are separate gates and this is the score where they
   come apart. */
test('the analyst score is external but not measurable here', () => {
  const analyst = app.allScores().find((s) => s.id === 'analyst');
  assert.equal(analyst.status, 'external');
  assert.equal(analyst.domain.pointInTime, false,
    'no consensus history means no past to score against');
  assert.ok(!app.SCORE_FIELDS.includes('composite'),
    'so it gets no backtest tab, whatever its status says');
});

test('status decides sorting, filtering and backtest tabs', () => {
  // Untested participates; failed is display only.
  assert.ok(app.sortKeysFor('technicals').includes('mom12Only'));
  assert.ok(app.sortKeysFor('analyst').includes('composite'));
  assert.ok(!app.sortKeysFor('technicals').includes('composite'),
    "a section cannot sort by another domain's score, because it does not show it");
  assert.ok(app.SCORE_FIELDS.includes('mom12Only'));

  const failed = withFailedScore('support');
  assert.ok(!failed.sortKeysFor('technicals').includes('supportOnly'),
    'a failed score must not be able to order the board');

  /* The backtest tab list is derived the same way but frozen at load, so it
     cannot be checked by demoting a score afterwards. Assert the derivation
     instead: every field offered belongs to a score the status admits, in a
     domain whose data can be re-scored in the past. */
  const backtestable = new Set(app.allScores()
    .filter((s) => s.status !== 'failed' && s.domain.pointInTime)
    .map((s) => s.field));
  for (const field of app.SCORE_FIELDS) {
    if (field === 'combinedScore') continue;   // apparatus, not a domain
    assert.ok(backtestable.has(field), `${field} has no business in the backtest`);
  }
  assert.ok(app.SCORE_FIELDS.includes('mom12Only'));
});

// ── Overall ─────────────────────────────────────────────────────────

test('Overall takes one score per domain, and excludes failed ones', () => {
  assert.deepEqual(plain(app.overallScores().map((s) => s.id)), ['mom12', 'accruals', 'analyst']);

  /* Demoting the canonical score takes the whole domain out of Overall — a
     domain speaks through one score, so there is no fallback to a sibling. */
  const failed = withFailedScore('mom12');
  assert.deepEqual(plain(failed.overallScores().map((s) => s.id)), ['accruals', 'analyst'],
    'a failed canonical score excludes its domain');
});

/* Combination is at the DOMAIN level. Technicals registers eight scores — four
   single-factor views of the same price series, two blends of those, and two
   momentum-primary alternatives to blending — so counting scores instead of
   domains would drown the analyst domain eight to one while looking like an
   even blend of two. */
test('a domain contributes once however many scores it registers', () => {
  const tech = app.SCORE_DOMAINS.find((d) => d.id === 'technicals');
  assert.equal(tech.scores.length, TECH_SCORE_IDS.length, 'Technicals owns eight scores');

  /* Every registered technical field, taken from the registry rather than
     written out. The literal list here had a duplicated `mom12Only` key and a
     `drawdownOnly` that stopped existing when drawdown was demoted to a
     display-only column — so it was feeding one score twice and one not at
     all, and still passed, because the assertion only counts domains. */
  const every = Object.fromEntries(tech.scores.map((s) => [s.field, 80]));
  /* Fundamentals registers four scores and, like Technicals, must contribute
     exactly one — feeding all four must not buy it four votes. */
  const fund = Object.fromEntries(app.SCORE_DOMAINS.find((d) => d.id === 'fundamentals')
    .scores.map((s) => [s.field, 80]));
  const contributors = app.overallFor({ ...every, ...fund, analystPct: 50 });
  assert.equal(contributors.parts.length, 3, 'but each contributes one value');
  assert.deepEqual(plain(contributors.parts.map((p) => p.domain.id)),
    ['technicals', 'fundamentals', 'analyst']);
  for (const p of contributors.parts) {
    assert.ok(Math.abs(p.share - 1 / 3) < 1e-9,
      `every domain carries a third, got ${p.share} for ${p.domain.id}`);
  }
});

/* Registering a domain used to enrol it in Overall automatically, which would
   have decided the weighting question by default the moment the domain existed.
   `inOverall: false` is the opt-out, and this is what holds it. */
test('inOverall is an opt-out that still works, though nothing currently uses it', () => {
  /* Every registered domain is now IN Overall, so this holds the mechanism
     rather than an instance of it. Kept because the flag is what stopped
     Fundamentals enrolling itself the moment it was registered, and the next
     domain will land in the same position — registered and scored before the
     weighting question has been answered. */
  const sandbox = loadApp();
  sandbox.run(`SCORE_DOMAINS.find((d) => d.id === 'fundamentals').inOverall = false;`);
  assert.ok(!sandbox.overallDomains().some((d) => d.id === 'fundamentals'),
    'a domain flagged out must not appear among the Overall domains');
  assert.deepEqual(plain(sandbox.overallScores().map((s) => s.id)), ['mom12', 'analyst']);

  // And with the flag absent it participates, which is the shipped state.
  assert.ok(app.overallDomains().some((d) => d.id === 'fundamentals'));

  const fund = app.SCORE_DOMAINS.find((d) => d.id === 'fundamentals');
  assert.ok(app.sectionIds().includes('fundamentals'));
  assert.equal(fund.scores.length, 4);
  assert.equal(app.canonicalScore(fund).id, 'accruals',
    'canonical is accruals: least entangled with the other three, widest coverage, no sign gate');
  for (const s of fund.scores) {
    assert.equal(s.status, 'external', 'the literature is external, the measurement is not ours');
    assert.ok(s.evidence && s.pathOut, `${s.id} must say what it rests on and what would move it`);
  }
});

test('a non-canonical score cannot move Overall', () => {
  const flat = { mom12Only: 80, analystPct: 50 };
  const base = { ...flat, blendScore: 0, zBlendScore: 0, mom6Only: 0, lowVolOnly: 0, supportOnly: 0 };
  const swung = { ...flat, blendScore: 100, zBlendScore: 100, mom6Only: 100, lowVolOnly: 100, supportOnly: 100 };
  assert.equal(app.overallFor(base).value, app.overallFor(swung).value,
    'swinging every non-canonical score end to end must change nothing');
});

/* The two alternatives to the blend, added 2026-09-01. What each has to
   guarantee is the property the blend fails: momentum's ordering survives. */

test('the momentum band score never lets volatility cross a band', () => {
  const band = app.run('momBandScore');
  const W = app.run('MOM_BAND');

  // Best possible volatility one band down still loses to the worst above it.
  const lowerBandBestVol = band({ mom12Score: 69.9, volScore: 100 });
  const upperBandWorstVol = band({ mom12Score: 70.0, volScore: 0 });
  assert.ok(upperBandWorstVol > lowerBandBestVol,
    `a full band of momentum must outrank any volatility edge (${upperBandWorstVol} vs ${lowerBandBestVol})`);

  // Within one band, volatility is the whole ordering.
  const calm = band({ mom12Score: 72, volScore: 90 });
  const wild = band({ mom12Score: 78, volScore: 10 });
  assert.ok(calm > wild, 'inside a band the calmer name ranks higher despite lower momentum');

  /* Bounds. The top is 99, not 100: the tiebreaker deliberately leaves a tenth
     of each band empty so a band boundary can never be tied across. */
  assert.equal(band({ mom12Score: 100, volScore: 100 }), 99);
  assert.equal(band({ mom12Score: 0, volScore: 0 }), 0);
  for (const m of [0, 12.5, 50, 87.3, 99.9, 100]) {
    for (const v of [0, 50, 100, null]) {
      const s = band({ mom12Score: m, volScore: v });
      assert.ok(s >= 0 && s <= 100, `out of range at mom=${m} vol=${v}: ${s}`);
    }
  }

  assert.equal(band({ mom12Score: null, volScore: 50 }), null,
    'no momentum means no band, so no score');
  assert.equal(band({ mom12Score: 40, volScore: null }), band({ mom12Score: 40, volScore: 50 }),
    'a missing volatility reading sits mid-band rather than withholding the score');
});

test('the volatility screen drops a decile and leaves momentum unadjusted', () => {
  const screen = app.run('volScreenCohort');

  // 100 names, volScore 0..99, momentum deliberately anti-correlated with it.
  const parts = Array.from({ length: 100 }, (_, i) => ({ volScore: i, mom12Score: 100 - i }));
  const out = screen(parts);

  const kept = out.filter((v) => v != null).length;
  assert.equal(kept, 90, 'exactly the worst decile is excluded');

  // The excluded ones are the LOW volScore names — volScore is inverted vol,
  // so low means most volatile.
  for (let i = 0; i < 100; i++) {
    if (out[i] == null) assert.ok(i <= 10, `excluded a name at volScore ${i}, which is not the worst decile`);
  }

  // Survivors carry momentum untouched — no volatility term at all.
  for (let i = 0; i < 100; i++) {
    if (out[i] != null) assert.equal(out[i], parts[i].mom12Score, 'a surviving name is scored on momentum alone');
  }

  // Too small a cohort cannot define a decile, so nothing is scored.
  const tiny = screen(Array.from({ length: 10 }, (_, i) => ({ volScore: i, mom12Score: 50 })));
  assert.ok(tiny.every((v) => v == null), 'a cohort below the minimum withholds the score');
});

/* The whole point of both: they must not reproduce the blend's failure of
   going flat across the top of the momentum ranking. */
test('the alternatives stay monotone in momentum where the blend does not', () => {
  const band = app.run('momBandScore');
  const screen = app.run('volScreenCohort');

  /* Volatility U-shaped in momentum, which is what the board actually shows:
     inverted vol peaks mid-ranking and falls away at both ends. */
  const parts = Array.from({ length: 100 }, (_, i) => {
    const mom = i;
    return { mom12Score: mom, volScore: 100 - Math.abs(mom - 50) * 2 };
  });

  const blend = parts.map((p) => (p.mom12Score + p.volScore) / 2);
  const bands = parts.map(band);
  const screened = screen(parts);

  // Across the top half, the blend falls while momentum rises. That is the bug.
  assert.ok(blend[99] < blend[50], 'fixture reproduces the blend going backwards up the ranking');

  // The band score must not.
  assert.ok(bands[99] > bands[50], 'the band score rises with momentum across the top half');
  for (let i = 10; i < 100; i++) {
    assert.ok(bands[i] >= bands[i - 10] - 1e-9,
      `band score fell from index ${i - 10} to ${i} — a full band of momentum was reversed`);
  }

  const top = screened.filter((v, i) => v != null && i >= 50);
  assert.ok(top.every((v, i, a) => i === 0 || v >= a[i - 1]),
    'the screened score is momentum, so it is monotone by construction wherever it exists');
});

// ── Single-bar anomalies and missing bars ───────────────────────────

/** A 500-bar series drifting gently upward, so any spike is unambiguous. */
const calmSeries = (n = 500, start = 100) =>
  Array.from({ length: n }, (_, i) => start * (1 + 0.0004 * i) * (1 + 0.004 * Math.sin(i / 3)));

test('a dominating bar is flagged per factor, not per symbol', () => {
  const anomalyFor = app.run('anomalyFor');
  const c = calmSeries();

  // Spike near the end, inside the volatility window but past the momentum
  // endpoint — the MRNA case, where momentum reads only c[n-1-21] and earlier.
  const spiked = [...c];
  for (let i = 492; i < spiked.length; i++) spiked[i] *= 2.77;

  const a = anomalyFor(spiked);
  assert.ok(a, 'a 177% bar must be flagged');
  assert.equal(a.at, 492);
  assert.ok(a.inflation > app.run('VOL_INFLATION_FLAG'),
    `inflation ${a.inflation} must clear the threshold`);

  assert.ok('realisedVol' in a.exBar, 'volatility reads the bar and must be annotated');
  assert.ok(!('mom12m1m' in a.exBar),
    'the bar is past the momentum endpoint, so mom12 must NOT be flagged');
  assert.ok(!('mom6m1m' in a.exBar), 'nor mom6');

  // The ex-bar volatility is the calm series' own, not the inflated one.
  assert.ok(a.volExBar < a.volReported / 2,
    `one bar should carry most of the reported vol (${a.volReported} vs ${a.volExBar})`);
});

test('a bar inside the momentum span does flag momentum', () => {
  const anomalyFor = app.run('anomalyFor');
  const c = calmSeries();

  // Same spike, but placed well inside the 12−1 window this time.
  const spiked = [...c];
  for (let i = 300; i < spiked.length; i++) spiked[i] *= 2.77;

  const a = anomalyFor(spiked);
  assert.ok(a, 'still flagged');
  assert.ok('mom12m1m' in a.exBar, 'a bar between the momentum endpoints must flag mom12');
  assert.ok(Math.abs(a.exBar.mom12m1m) < Math.abs(app.run('momentum12m1m')(spiked)),
    'the ex-bar momentum must be the smaller, undistorted figure');
});

test('an ordinary earnings gap is not flagged', () => {
  const anomalyFor = app.run('anomalyFor');
  const c = calmSeries();
  const spiked = [...c];
  // A 25% move — large, real, and nowhere near dominating a year of volatility.
  for (let i = 400; i < spiked.length; i++) spiked[i] *= 1.25;

  assert.equal(anomalyFor(spiked), null,
    'the screen must target factor domination, not merely a big move');
  assert.equal(anomalyFor(c), null, 'and a clean series is never flagged');
});

test('series covering the same span must hold the same number of bars', () => {
  const seriesGaps = app.run('seriesGaps');
  const span = { f: '2024-08-30', t: '2026-08-28' };

  // Eight symbols over one span; one is short by three bars.
  const m = new Map();
  for (const s of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG']) {
    m.set(s, { ...span, c: calmSeries(500) });
  }
  m.set('SHORT', { ...span, c: calmSeries(497) });

  const gaps = seriesGaps(m);
  assert.equal(gaps.size, 1, 'only the short series is a gap');
  assert.ok(gaps.has('SHORT'));
  assert.match(gaps.get('SHORT'), /3 bars missing/);

  // A cohort too small to vote is not judged by the mode.
  const tiny = new Map([['ONLY', { ...span, c: calmSeries(497) }]]);
  assert.equal(tiny.size, 1);
  assert.ok(!app.run('seriesGaps')(tiny).has('ONLY'),
    'one symbol over a span cannot be checked against a cohort, and 497 bars is '
    + 'well inside the weekday fallback');
});

test('a flat weekday deficit would misjudge short histories', () => {
  const weekdaysBetween = app.run('weekdaysBetween');

  /* The reason the cohort check exists. Measured across the real board on
     2026-09-01 the weekday deficit ran 3.70% to 4.78% with no gaps present,
     because a short window can hold a holiday-dense stretch. Anything at or
     below the observed ceiling must not be treated as a gap. */
  const long = weekdaysBetween('2024-08-30', '2026-08-28');
  const short = weekdaysBetween('2024-08-30', '2025-03-25');
  assert.ok(long > 500 && short > 141, 'weekday counts exceed bar counts, as holidays require');

  const deficit = (bars, wd) => (wd - bars) / wd;
  assert.ok(deficit(141, short) > deficit(500, long),
    'the short history shows the larger deficit with no gap in either — which is '
    + 'exactly why a flat threshold cannot be used');
  assert.ok(deficit(141, short) < app.run('GAP_DEFICIT_MAX'),
    'and it must still sit under the fallback ceiling');
});

// ── Analyst percentile, snapshot archive, pre-move flag ─────────────

test('the analyst score is a percentile of the cohort, not a rescaled rating', () => {
  const cohort = app.run('analystPercentileCohort');

  // 100 names whose composites are crushed into a narrow band at the top, which
  // is what the real board looks like: top fifteen span 0.063 of a rating point.
  const rows = Array.from({ length: 100 }, (_, i) => ({ composite: 3.5 + i * 0.005 }));
  const out = cohort(rows.map(() => ({})), rows);

  assert.equal(out.filter((v) => v != null).length, 100);
  assert.ok(Math.min(...out) >= 0 && Math.max(...out) <= 100, 'stays on 0–100');
  assert.ok(out[99] > out[0], 'and orders the same way the rating does');

  /* The point of the change: a 0.005 gap in rating becomes a full percentile
     step, so the top of the board is separable where the rating could not
     separate it. */
  assert.ok(out[99] - out[98] >= 0.9,
    'adjacent names at the top must be a percentile apart, not 0.005 of a rating');

  // Ties share a percentile rather than being ordered arbitrarily.
  const tied = Array.from({ length: 40 }, () => ({ composite: 4.0 }))
    .concat(Array.from({ length: 40 }, (_, i) => ({ composite: 3 + i * 0.01 })));
  const tout = cohort(tied.map(() => ({})), tied);
  const first40 = new Set(tout.slice(0, 40));
  assert.equal(first40.size, 1, 'identical ratings must get one identical percentile');

  // Below the minimum cohort a percentile describes noise, so there is none.
  const tiny = Array.from({ length: 10 }, (_, i) => ({ composite: 3 + i * 0.1 }));
  assert.ok(cohort(tiny.map(() => ({})), tiny).every((v) => v == null));

  /* And the display must not undo the work. The saturation rails exist for
     tanh scores that genuinely run out of resolution; a percentile does not, so
     rendering 99.9 and 99.7 both as ">99" would rebuild the flat top this score
     was introduced to remove. */
  const scoreHTML = app.run('scoreHTML');
  assert.match(scoreHTML(99.9, { rails: false }), /99\.9/);
  assert.match(scoreHTML(99.7, { rails: false }), /99\.7/);
  assert.notEqual(scoreHTML(99.9, { rails: false }), scoreHTML(99.7, { rails: false }),
    'two different percentiles must render differently');
  assert.match(scoreHTML(99.9), /&gt;99/, 'a curve-based score still shows its rail');

  // An unrated name stays unrated rather than landing at the bottom.
  const mixed = Array.from({ length: 40 }, (_, i) => ({ composite: i < 5 ? null : 3 + i * 0.01 }));
  const mout = cohort(mixed.map(() => ({})), mixed);
  assert.ok(mout.slice(0, 5).every((v) => v == null), 'no rating means no percentile');
});

test('Overall declares itself relative once any input is cross-sectional', () => {
  const analyst = app.allScores().find((s) => s.id === 'analyst');
  assert.equal(analyst.crossSectional, true, 'the analyst score is now cohort-relative');
  assert.ok(app.overallScores().some((s) => s.crossSectional),
    'so Overall has a cross-sectional input and cannot be compared across days');

  const title = app.run('overallColumn()').title;
  assert.match(title, /NOT COMPARABLE ACROSS DAYS/,
    'and the column must say so rather than leaving it to be inferred');
});

test('the snapshot archive is append-only and point-in-time', () => {
  const merge = app.run('mergeSnapshots');
  const trend = (period, d) => ({ period, strongBuy: d[0], buy: d[1], hold: d[2], sell: d[3], strongSell: d[4] });

  const first = merge(null, [trend('2026-08-01', [13, 22, 3, 0, 0]),
                             trend('2026-07-01', [13, 22, 3, 0, 0])], 1000);
  assert.equal(first.added, 2);
  assert.equal(first.rows.length, 2);
  assert.equal(first.rows[0].p, '2026-08', 'newest first, and stored as YYYY-MM');

  // Re-observing the same months adds nothing — this is what makes the cadence
  // monthly however often the board refreshes.
  const again = merge(first.rows, [trend('2026-08-01', [13, 22, 3, 0, 0])], 2000);
  assert.equal(again.added, 0);
  assert.equal(again.revised, 0);
  assert.equal(again.rows.length, 2);

  // A restatement of an already-recorded month must NOT overwrite what was
  // first knowable — that would import hindsight into a forward validation.
  const revised = merge(first.rows, [trend('2026-08-01', [14, 22, 2, 0, 0])], 3000);
  assert.equal(revised.revised, 1);
  const aug = revised.rows.find((r) => r.p === '2026-08');
  assert.deepEqual(plain(aug.d), [13, 22, 3, 0, 0], 'the first-seen value is preserved');
  assert.deepEqual(plain(aug.dl), [14, 22, 2, 0, 0], 'and the restatement is kept beside it');
  assert.equal(aug.rev, 1);

  // A new month appends without disturbing the archive.
  const grown = merge(revised.rows, [trend('2026-09-01', [15, 21, 2, 0, 0])], 4000);
  assert.equal(grown.added, 1);
  assert.equal(grown.rows.length, 3);
  assert.equal(grown.rows[0].p, '2026-09');

  // Malformed periods are dropped rather than stored under a junk key.
  assert.equal(merge(null, [trend('nonsense', [1, 1, 1, 1, 1])], 5000).added, 0);
});

test('the archive never evicts one symbol to make room for another', () => {
  const merge = app.run('mergeSnapshots');
  const cap = app.run('SNAP_MAX_MONTHS');

  // Well past the per-symbol bound, oldest-first input.
  const many = Array.from({ length: cap + 24 }, (_, i) => {
    const m = ((i % 12) + 1).toString().padStart(2, '0');
    return { period: `${2000 + Math.floor(i / 12)}-${m}-01`,
             strongBuy: i, buy: 1, hold: 1, sell: 0, strongSell: 0 };
  });
  const out = merge(null, many, 1000);
  assert.equal(out.rows.length, cap, 'trimmed to the per-symbol retention bound');
  assert.equal(out.rows[0].p > out.rows[out.rows.length - 1].p, true, 'newest kept, oldest dropped');

  /* The bound is per symbol and applied inside one record. There is no shared
     budget, so nothing here can look at another symbol at all — which is the
     property `bar.history` lacks and the reason this store exists. */
  assert.equal(typeof cap, 'number');
  assert.ok(cap >= 120, 'ten years of monthly rows, far beyond any testable horizon');
});

test('a rating is flagged when the price has left the period it was formed in', () => {
  const moved = app.run('movedSincePeriod');
  const series = { f: '2026-01-01', t: '2026-09-01', c: Array.from({ length: 170 }, () => 100) };

  // Flat price, so no move since the period began.
  const flat = moved({ price: 100, latest: { period: '2026-08-01' } }, series);
  assert.ok(Math.abs(flat) < 0.001, 'a stock that has not moved is not flagged');

  // Same series, price now well below it.
  const down = moved({ price: 90, latest: { period: '2026-08-01' } }, series);
  assert.ok(down < -9 && down > -11, `expected about -10%, got ${down}`);
  assert.ok(Math.abs(down) >= app.run('PRE_MOVE_FLAG'), 'and that clears the flag threshold');

  // Guards: no price, no period, or a period outside the stored history.
  assert.equal(moved({ price: null, latest: { period: '2026-08-01' } }, series), null);
  assert.equal(moved({ price: 100, latest: null }, series), null);
  assert.equal(moved({ price: 100, latest: { period: '2020-01-01' } }, series), null,
    'a period older than the stored history cannot be measured against');
  assert.equal(moved({ price: 100, latest: { period: '2026-08-01' } }, null), null);
});

// ── Fundamentals extraction ─────────────────────────────────────────

/** Build a companyfacts-shaped response from a compact list. */
const facts = (tag, rows, taxonomy = 'us-gaap') => ({
  facts: { [taxonomy]: { [tag]: { units: { USD: rows } } } },
});
const fact = (end, val, filed, form = '10-Q', start = null) =>
  ({ end, val, filed, form, start, accn: `${filed}-${val}` });

test('the knowable value is the earliest filing, and restatements are kept beside it', () => {
  const extract = app.run('extractFundamentals');

  /* JPM moved its 2009 assets by $88bn six months after first reporting them.
     A backtest taking the latest value would be reading a number that did not
     exist on the date it claims to be scoring. */
  const out = extract(facts('Assets', [
    fact('2009-12-31', 2031989, '2010-02-24', '10-K'),
    fact('2009-12-31', 2031989, '2010-05-10'),
    fact('2009-12-31', 2119673, '2010-08-06'),
  ]));

  assert.equal(out.assets.length, 1, 'one period, however many times it was filed');
  const a = out.assets[0];
  assert.equal(a.v, 2031989, 'the value carried is the one first knowable');
  assert.equal(a.f, '2010-02-24', 'dated by min(filed), not by the newest filing');
  assert.deepEqual(plain(a.r), [{ v: 2119673, f: '2010-08-06' }],
    'and the restatement is recorded rather than discarded or substituted');

  // Order of arrival must not matter — EDGAR does not guarantee it.
  const shuffled = extract(facts('Assets', [
    fact('2009-12-31', 2119673, '2010-08-06'),
    fact('2009-12-31', 2031989, '2010-02-24', '10-K'),
  ]));
  assert.equal(shuffled.assets[0].v, 2031989);
  assert.equal(shuffled.assets[0].f, '2010-02-24');
});

test('the revenue chain resolves per period, not per company', () => {
  const extract = app.run('extractFundamentals');

  /* AAPL reports under SalesRevenueNet before ASC 606 and
     RevenueFromContractWithCustomer after, so a filer crosses the boundary
     mid-history and a per-company choice would lose one era or the other. */
  const merged = {
    facts: {
      'us-gaap': {
        SalesRevenueNet: { units: { USD: [fact('2017-09-30', 229234, '2017-11-03', '10-K')] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [fact('2019-09-28', 260174, '2019-10-31', '10-K')] },
        },
      },
    },
  };
  const out = extract(merged);
  assert.equal(out.revenue.length, 2, 'both eras survive');
  assert.deepEqual(plain(out.revenue.map((r) => r.e)), ['2019-09-28', '2017-09-30'],
    'newest first');

  // Where both tags cover the SAME period, the earlier chain entry wins.
  const overlap = {
    facts: {
      'us-gaap': {
        SalesRevenueNet: { units: { USD: [fact('2019-09-28', 111, '2019-10-31', '10-K')] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [fact('2019-09-28', 999, '2019-10-31', '10-K')] },
        },
      },
    },
  };
  assert.equal(extract(overlap).revenue[0].v, 999,
    'the first populated tag in the chain wins the period');
});

test('a foreign private issuer is not silently empty', () => {
  const extract = app.run('extractFundamentals');

  /* Measured: restricting to 10-K/10-Q left ARM, WIX and SPOT with nothing at
     all — none of them files a 10-K. SPOT additionally reports under
     `ifrs-full` rather than `us-gaap`. */
  const twentyF = extract(facts('Assets', [fact('2025-12-31', 500, '2026-03-01', '20-F')]));
  assert.equal(twentyF.assets?.length, 1, '20-F must be accepted');

  const ifrs = extract(facts('ProfitLoss', [fact('2025-12-31', 42, '2026-03-01', '20-F')], 'ifrs-full'));
  assert.equal(ifrs.netIncome?.length, 1, 'an IFRS filer resolves through the same chain');

  // A form that is not a periodic report stays out.
  assert.equal(extract(facts('Assets', [fact('2025-12-31', 500, '2026-03-01', 'S-1')])).assets, undefined);
});

/* Berkshire's newest share fact in any accepted form is 2015-09-30. Priced
   against a current quote that gave a $0.83B market cap and a 9,531% earnings
   yield, which sorted it to rank 1 of the value ranking — the worst place for a
   broken number to land, because it reads as the strongest signal on the board. */
test('a stale share count yields no market cap rather than a spectacular one', () => {
  const fundamentalsFor = app.run('fundamentalsFor');
  const maxAge = app.run('SHARES_MAX_AGE_DAYS');
  const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

  const build = (sharesEnd) => new Map([['X', { cik: 1, at: Date.now(), f: {
    netIncome: [{ e: day(30), s: day(395), v: 1e9, f: day(20), u: 'USD', r: [] }],
    equity: [{ e: day(30), s: null, v: 5e9, f: day(20), u: 'USD', r: [] }],
    assets: [{ e: day(30), s: null, v: 2e10, f: day(20), u: 'USD', r: [] }],
    operatingCF: [{ e: day(30), s: day(395), v: 1.2e9, f: day(20), u: 'USD', r: [] }],
    shares: [{ e: sharesEnd, s: null, v: 1e8, f: sharesEnd, u: 'shares', r: [] }],
  } }]]);

  const before = app.state.fx.facts;

  app.state.fx.facts = build(day(60));                       // fresh count
  const fresh = fundamentalsFor('X', 50);
  assert.ok(fresh.earnYield > 0, 'a current share count prices a market cap');
  assert.ok(fresh.bookToMkt > 0);

  app.state.fx.facts = build(day(maxAge + 200));             // long stale
  const stale = fundamentalsFor('X', 50);
  assert.equal(stale.earnYield, null, 'a stale count must not price a market cap');
  assert.equal(stale.bookToMkt, null);

  /* The two that need no price are untouched, so a filer that stopped tagging
     shares keeps its quality scores instead of vanishing from the domain. */
  assert.ok(stale.roe > 0, 'return on equity needs no market cap');
  assert.ok(stale.accruals != null, 'nor do accruals');

  app.state.fx.facts = before;
});

// ── Assessment ──────────────────────────────────────────────────────

test('the concern enum contains only events, never standing traits', () => {
  const events = app.run('ASSESS_CONCERNS');
  const structural = app.run('ASSESS_STRUCTURAL');

  /* The rule that makes "did flagged names underperform" answerable. A trait
     that is permanently true of a company sits in the array forever and makes
     the question meaningless, so traits live in their own field. */
  for (const t of structural) {
    assert.ok(!events.includes(t), `${t} is a standing trait and must not be in the event enum`);
  }
  assert.ok(structural.includes('single_product_dependency'),
    'single-product dependency is a trait, not an event');

  // No value may appear twice across the two lists.
  const all = [...events, ...structural];
  assert.equal(new Set(all).size, all.length, 'no value may appear in both lists');

  /* `none_found` is deliberately absent: a sentinel inside a list of real
     values forces every consumer to special-case it, and the distinction it
     was meant to carry lives in search_status instead. */
  assert.ok(!events.includes('none_found'),
    'an empty array plus search_status carries this, without a sentinel in the enum');
  assert.ok(!events.includes('sector_wide_move'),
    'a sector move describes the explanation, not the company — and is computable from the board');
});

test('the request forbids a direction and caps what it can spend', () => {
  const row = {
    symbol: 'TEST', name: 'Test Co', sector: 'Tech', price: 100, changePct: 1,
    overall: 50, overallParts: 3, overallOf: 3, latest: { period: '2026-08-01' },
  };
  const req = app.run('assessRequest')(row);

  assert.equal(req.model, 'claude-opus-4-5-20251101', 'the dated ID — structured outputs are listed against it');
  assert.equal(req.tools[0].max_uses, app.run('ASSESS_MAX_SEARCHES'),
    'the search tool must be capped: each search is billed and its results re-enter context every turn');
  assert.equal(req.tools[0].type, 'web_search_20250305',
    'Opus 4.5 predates the 20260209 variant');

  /* Prompt caching is prefix-matched, so the breakpoint must sit on the system
     block and the system block must carry nothing symbol-specific. */
  assert.equal(req.system[0].cache_control.type, 'ephemeral');
  assert.ok(!req.system[0].text.includes('TEST'), 'no symbol may leak into the cached prefix');

  const sys = req.system[0].text;
  for (const forbidden of ['buy, sell, or hold', 'price target', 'undervalued', 'worth watching']) {
    assert.ok(sys.includes(forbidden), `the prohibition on "${forbidden}" must be explicit`);
  }
  assert.ok(sys.includes('LEAD WITH DATA QUALITY'));

  /* AMENDED 2026-08-31: the rule went from "no directional field of any kind"
     to "exactly one, and it is `rating`".
     AMENDED 2026-09-01: to four, split by horizon — see docs/NOTES.md.

     THIS IS NOW AN ALLOWLIST, AND THAT IS THE POINT. It was a substring
     blacklist scanning for rating|recommendation|target|direction|outlook|
     conviction, which by construction only catches fields somebody already
     thought of. `call_near`, `call_long` and `entry_level` contain none of
     those substrings: the guard written to stop a second directional field
     arriving unnoticed would have waved all three through in silence.

     The assertion is now on the COMPLETE property set. Any new field — of any
     kind, directional or not — fails this test until it is added to
     DIRECTIONAL_FIELDS or ASSESS_PROSE_FIELDS, which makes the next one a
     decision with a name and a date on it rather than an omission. */
  const props = Object.keys(req.output_config.format.schema.properties).sort();
  // Spread: the list is built inside the vm, so its prototype is the sandbox's.
  assert.deepEqual(props, [...app.run('assessSchemaFields')()].sort(),
    'the schema must expose exactly the enumerated fields — add a new one to '
    + 'DIRECTIONAL_FIELDS or ASSESS_PROSE_FIELDS, deliberately, before it ships');

  /* The registry is not a rubber stamp: every directional field must name a
     basis line that the schema actually carries, or the judgment lands with no
     record of what drove it. */
  const dir = app.run('DIRECTIONAL_FIELDS');
  for (const [name, cfg] of Object.entries(dir)) {
    assert.ok(props.includes(name), `${name} is sanctioned but absent from the schema`);
    assert.ok(props.includes(cfg.basis), `${name} must ship its basis field ${cfg.basis}`);
    assert.ok(cfg.since, `${name} must record when it was sanctioned`);
  }

  /* The substring scan is KEPT, demoted to a second net over the prose half.
     A `price_target` field added to ASSESS_PROSE_FIELDS would satisfy the
     allowlist above while being exactly what the prohibition forbids. */
  for (const bad of ['rating', 'recommendation', 'target', 'direction', 'outlook', 'conviction', 'call', 'entry']) {
    const offenders = app.run('ASSESS_PROSE_FIELDS').filter((p) => p.includes(bad));
    assert.deepEqual([...offenders], [],
      `"${bad}" appears in a field listed as PROSE — a directional field must be `
      + 'declared in DIRECTIONAL_FIELDS, where the scoring rule applies to it');
  }

  /* `entry_stance` joined on 2026-09-01. It was first put in ASSESS_PROSE_FIELDS
     as a qualifier like `search_status`, and the substring net above rejected
     it — correctly: `at_market` means "buy at the current price", and the
     harness scores it as a buy-now case. The demoted blacklist caught a
     misclassification the allowlist could not, which is the argument for
     keeping both. */
  assert.deepEqual(Object.keys(dir).slice().sort(),
    ['call_long', 'call_near', 'entry_level', 'entry_stance', 'rating'],
    'and the sanctioned set must actually be present — a field that silently '
    + 'stopped being emitted would leave the harness with nothing to score');
});

/* The rule the allowlist enforces, from docs/NOTES.md as amended 2026-09-01: a
   directional field must be scoreable IN PRINCIPLE and logged so that it can
   be scored, even where its horizon means no result exists for a long time.
   `call_long` meets that and will report nothing for a year; `entry_level`
   meets it through a different join, which is why its `scored` is null rather
   than absent. */
test('every sanctioned directional field is scoreable, or says how instead', () => {
  const dir = app.run('DIRECTIONAL_FIELDS');
  for (const [name, cfg] of Object.entries(dir)) {
    assert.ok('scored' in cfg, `${name} must state its horizons or declare null`);
    if (cfg.scored === null) {
      /* Both exceptions are measured, just not by bucketing a 1-10 value:
         `entry_level` by whether it filled and what waiting earned, and
         `entry_stance` by the at-market arm of the same join — an at_market
         entry is scored on the forward return from the day it declined to wait.
         The list is exhaustive on purpose: null scoring is not a general escape
         hatch, and a third name here would need its own measurement first. */
      assert.ok(['entry_level', 'entry_stance'].includes(name),
        `${name} declares null scoring but is neither bucket-scored nor separately `
        + 'measured — that exception has to be earned, not asserted');
      continue;
    }
    assert.ok(Array.isArray(cfg.scored) && cfg.scored.length,
      `${name} must name at least one horizon`);
    for (const h of cfg.scored) {
      assert.ok(Number.isFinite(h.days) && h.days > 0, `${name} horizon needs days`);
    }
  }
  /* The horizons are the split, so they must actually differ. Two fields on
     the same horizons would be two names for one measurement. */
  const near = dir.call_near.scored.map((h) => h.months);
  const long = dir.call_long.scored.map((h) => h.months);
  assert.deepEqual([...near], [1, 3], 'the near call is scored on the quarter it claims');
  assert.deepEqual([...long], [12, 24, 36], 'the long call on one to three years');
  assert.equal(near.filter((m) => long.includes(m)).length, 0,
    'and they must not overlap, or one result would answer both questions');
});

/* The wording of this flag put two briefs onto the wrong factor. `fxBasis`
   describes the ACCRUALS PAIRING only; earnings yield and return on equity come
   from a plain TTM of net income, which is on four quarters for 558 of the 561
   symbols with filings. The old text said "FUNDAMENTALS ARE ON A FISCAL-YEAR
   BASIS ... these figures may be up to twelve months old", which reads as all
   four and is wrong for three of them. */
test('the fiscal-year flag names accruals only, and says which date', () => {
  const flags = app.run('assessFlags');

  const common = flags({ symbol: 'X', fxBasis: 'FY', fxEnd: '2025-12-31',
    fxNiBasis: 'TTM', fxNiEnd: '2026-06-30' }).join(' ');
  assert.match(common, /ACCRUALS COVER THE FILED FISCAL YEAR/,
    'the flag must name the one factor it applies to');
  assert.ok(!/FUNDAMENTALS ARE ON A FISCAL-YEAR BASIS/.test(common),
    'and must not indict the whole domain');
  assert.match(common, /2025-12-31/, 'the actual period end, not "up to twelve months"');
  assert.match(common, /accruals only/, 'scope stated, not left to be inferred');
  assert.match(common, /NOT affected/,
    'and must say explicitly that earnings yield and ROE are current');
  assert.match(common, /2026-06-30/, 'naming the date they DO rest on');

  const rare = flags({ symbol: 'X', fxBasis: 'FY', fxEnd: '2025-12-31',
    fxNiBasis: 'FY', fxNiEnd: '2025-12-31' }).join(' ');
  assert.match(rare, /same year/, 'there the wider claim IS correct and must be made');
  assert.ok(!/NOT affected/.test(rare));

  /* A rolled TTM is twelve months to the most recent quarter. It is not a
     staleness condition and must raise nothing — a flag on 500 of 542 symbols
     would be noise, which is how the previous wording earned its place here. */
  assert.ok(!flags({ symbol: 'X', fxBasis: 'TTM', fxEnd: '2026-06-30' })
    .some((f) => /FISCAL YEAR/i.test(f)));
});

/* Three states, and the whole point is that they are three and not two.
   "Checked and passed", "could not be checked" and "checked and refused" are
   different claims; collapsing the middle one into either neighbour is the
   error this test exists to prevent. */
test('unverified fundamentals read as unconfirmed, never as failed', () => {
  const flags = app.run('assessFlags');

  const unver = flags({ symbol: 'X', fxBasis: 'TTM', fxNiVerified: false }).join(' ');
  assert.match(unver, /NET INCOME IS UNVERIFIED/);
  assert.match(unver, /did NOT fail/, 'the brief must not report an absent check as a failure');
  assert.match(unver, /could not be run/, 'and must say why there is no check');
  assert.match(unver, /unconfirmed rather than as suspect/,
    'the model needs telling how to weigh it, or it will pick one of the two extremes');

  const ok = flags({ symbol: 'X', fxBasis: 'TTM', fxNiVerified: true });
  assert.ok(!ok.some((f) => /UNVERIFIED|WITHHELD/.test(f)),
    'a verified symbol raises nothing — a flag on every row is not a flag');

  /* THE CASH-FLOW LEG MUST NOT BE A PER-ROW FLAG. It is unreconciled for 545 of
     561 symbols because filers publish only Q1 of cash flow discretely, and a
     warning that fires on 97% of the board trains its reader to skip it —
     which is exactly how the fiscal-year flag came to mislead three briefs.
     It belongs in the standing context, and it is asserted there below. */
  const ocfOnly = flags({ symbol: 'X', fxBasis: 'TTM', fxNiVerified: true, fxOcfVerified: false });
  assert.ok(!ocfOnly.some((f) => /UNVERIFIED/.test(f)),
    'a condition holding on 97% of the board is a property of the source, not a per-row flag');

  const held = flags({ symbol: 'X', fxNiVerified: false,
    fxWithheld: 'failed reconciliation — disagrees by 25.0%' });
  assert.ok(held.some((f) => /WITHHELD/.test(f)));
  assert.ok(!held.some((f) => /UNVERIFIED/.test(f)), 'the two must not both fire');
  assert.match(held.find((f) => /WITHHELD/.test(f)), /Do not describe this symbol as lacking filings/,
    'a refused number is a finding about the filings, not an absence of them');

  // No fundamentals at all is a third thing again, and must not read as unverified.
  assert.ok(!flags({ symbol: 'X', fxNiVerified: null }).some((f) => /UNVERIFIED/.test(f)));

  /* The universal condition is carried in the standing context instead, where
     it is stated once and told explicitly not to be remarked upon — otherwise
     the model dutifully raises it on every name and the briefs fill with a
     caveat that distinguishes nothing. */
  const ctx = app.run('assessContext')({ symbol: 'X', name: 'X Co', sector: 'S', price: 1,
    fxBasis: 'TTM', fxOcfVerified: false, latest: {} });
  assert.match(ctx, /cash-flow half of accruals is unreconciled/);
  assert.match(ctx, /standing limit of EDGAR, not a defect of this symbol/);
  assert.match(ctx, /NOT worth remarking on/);
  assert.ok(!app.run('assessContext')({ symbol: 'X', name: 'X Co', sector: 'S', price: 1,
    fxBasis: 'TTM', fxOcfVerified: true, latest: {} }).includes('unreconciled'));
});

test('data-quality flags are passed in explicitly, with the ex-bar values', () => {
  const flags = app.run('assessFlags');
  const clean = flags({ symbol: 'X' });
  assert.ok(Array.isArray(clean));

  const anomalous = flags({
    symbol: 'X',
    pxAnomaly: { at: 10, barPct: 177, inflation: 117, volReported: 192, volExBar: 75,
      exBar: { realisedVol: 75.11, maxDD: 41.15 } },
  });
  const text = anomalous.join(' ');
  assert.match(text, /177%/, 'the size of the bar');
  assert.match(text, /117 points/, 'what it did to volatility');
  assert.match(text, /75\.11/, 'and what the factor reads WITHOUT it — the part that lets the brief be right');
  assert.match(text, /NOT established/, 'without claiming the cause is known');
});

/* The detector is only worth having if it stays quiet on the sentences the
   brief is SUPPOSED to contain. A flag that fires on "2 strong buy, 7 buy" or
   "the company expects revenue of $4B" is noise within a day, and noise in the
   log is worse than no flag at all. */
test('the directional scan ignores legitimate reporting', () => {
  const scan = app.run('scanDirectional');
  const clean = [
    'The distribution is 2 strong buy, 7 buy, 18 hold, 2 sell and 1 strong sell.',
    'The company expects revenue of roughly $4B for the year.',
    'Analysts raised their price target following the result.',
    'Consensus upside of 12% is implied by the mean analyst target.',
    'Momentum 12−1 scores 94 of 100; low volatility scores 0.',
    'Management guided to a decline in the second half.',
    'Coverage fell by three analysts over the quarter.',
    'The stock fell 6.7% on the day of the announcement.',
    'Reuters reported on 2026-08-17 that the trial met its primary endpoint.',
  ];
  for (const text of clean) {
    const r = scan({ board_says: text });
    assert.equal(r.flagged, false,
      `false positive on legitimate reporting: "${text}" matched ${JSON.stringify(r.matches)}`);
  }
});

test('the directional scan catches the model making the call itself', () => {
  const scan = app.run('scanDirectional');
  const dirty = [
    ['The shares look undervalued relative to peers.', 'valuation_verdict'],
    ['This is an attractive entry for long-term holders.', 'valuation_verdict'],
    ['Investors should consider trimming the position.', 'recommendation'],
    ['Worth watching into the print.', 'recommendation'],
    ['We recommend waiting for the next quarter.', 'recommendation'],
    ['The stock should outperform its sector over the next year.', 'relative_call'],
    ['Shares are poised to rally once the overhang clears.', 'price_forecast'],
    ['My fair value of $180 implies meaningful room.', 'price_target'],
  ];
  for (const [text, expected] of dirty) {
    const r = scan({ board_says: text });
    assert.equal(r.flagged, true, `missed a directional statement: "${text}"`);
    assert.ok(r.matches.some((m) => m.pattern === expected),
      `"${text}" matched ${r.matches.map((m) => m.pattern)}, expected ${expected}`);
  }
});

test('the directional scan records where and what, not just whether', () => {
  const scan = app.run('scanDirectional');
  const r = scan({
    board_says: 'Momentum is strong and volatility is high.',
    uncertain: 'It is unclear whether the shares are undervalued.',
  });
  assert.equal(r.flagged, true);
  assert.equal(r.matches[0].section, 'uncertain',
    'the section matters — a hedge in the uncertainty section reads differently from a verdict up top');
  assert.ok(r.matches[0].context.includes('undervalued'),
    'the surrounding text is stored so a human can judge whether it is a real violation');
  assert.ok(r.matches[0].phrase.length < r.matches[0].context.length);

  // Multiple sections are all scanned — a shared /g regex would skip some.
  const many = scan({
    board_says: 'The shares look undervalued.',
    recent_events: 'Nothing notable.',
    what_could_break: 'This is an attractive entry.',
    uncertain: 'Investors should wait.',
  });
  assert.equal(new Set(many.matches.map((m) => m.section)).size, 3,
    'every section must be scanned independently');
});

/* The scanner exists to catch the model making the call in prose that is
   supposed to be descriptive. The rating IS a call, by design and by
   instruction — so if it could ever reach the scanner, every single assessment
   would flag and the flag would stop meaning anything. This test defends the
   boundary from both sides: the schema must offer a rating, and the scanned
   payload must not contain it. */
test('the rating cannot reach the directional scanner', () => {
  const scan = app.run('scanDirectional');

  /* A rating_basis phrased the way one naturally would — this is exactly the
     text the scanner is built to catch, and exactly the text it must not see. */
  const basis = 'The shares look undervalued and should outperform the sector.';
  assert.equal(scan({ board_says: basis }).flagged, true,
    'sanity: this text IS directional — the test is worthless if it is not');

  /* The four sections the runner actually passes. Named here rather than read
     from the code so that adding the rating to `briefText` breaks this test
     instead of silently widening what gets scanned. */
  const SCANNED = ['board_says', 'recent_events', 'what_could_break', 'uncertain'];
  const r = scan(Object.fromEntries(SCANNED.map((k) => [k, 'Momentum scores 94 of 100.'])));
  assert.equal(r.flagged, false);

  const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const brief = src.match(/const briefText = \{([\s\S]*?)\};/);
  assert.ok(brief, 'the scanned payload must still be built in one literal');
  for (const bad of ['rating', 'rating_basis']) {
    assert.ok(!brief[1].includes(bad),
      `${bad} must not be in the object handed to scanDirectional — a 1-10 rating is `
      + 'directional by construction, so scanning it would flag every assessment ever run');
  }
  for (const k of SCANNED) assert.ok(brief[1].includes(k), `${k} must still be scanned`);
});

/* The prompt has to carry the rating AND keep the prohibition on the prose.
   Adding a directional field is the obvious moment for the older instruction to
   get softened by accident, so both halves are asserted together. */
test('the prompt sanctions the rating without loosening the prose rule', () => {
  const sys = app.run('ASSESS_SYSTEM');
  assert.match(sys, /rating/i, 'the rating must be instructed, not just schema-required');
  /* Plural since 2026-09-01: four sanctioned fields rather than one. The
     assertion still pins the CARVE-OUT LANGUAGE, which is the thing that must
     not soften — "the only places" is a boundary, "these fields are for" is not. */
  assert.match(sys, /ONLY places? a directional judgment belongs/i,
    'and scoped explicitly to the enumerated fields');
  assert.match(sys, /still apply to all four prose sections without exception/i,
    'the prose prohibition must be restated, not assumed to survive');

  /* Each sanctioned field must be NAMED in the prompt, not merely present in
     the schema. A field the model is required to emit but never told how to
     reason about gets filled in by guesswork. */
  for (const f of Object.keys(app.run('DIRECTIONAL_FIELDS'))) {
    assert.ok(sys.includes(`\`${f}\``), `${f} must be instructed by name`);
  }
  /* The conditions that make entry_level admissible at all.

     REWORDED 2026-09-01. This asserted "ARITHMETIC ON A FIGURE ALREADY IN THE
     BOARD CONTEXT", which the prompt said and the context could not support:
     until price anchors shipped, the only price in the whole context was the
     current one, so the instruction was unsatisfiable and the test passed
     anyway. A test on prompt text can only confirm the text exists. */
  assert.match(sys, /arithmetic on the figures under PRICE ANCHORS/i,
    'entry_level must be gated on citing the anchors, not on "the board context" in general');
  assert.match(sys, /found in your web search/i,
    'the prompt must name the actual failure mode — a real figure fetched from outside');
  assert.match(sys, /ONE SIGMA below the current price/i,
    'a level with no horizon bound is one the quarter never reaches');
  assert.match(sys, /return null/i,
    'null has to stay an expected answer, or the model invents a level to avoid it');
  assert.match(sys, /allowed to disagree/i,
    'the calls must be told they may diverge, or the split collapses back into one view');

  const schema = app.run('assessRequest')(
    { symbol: 'T', name: 'T', sector: 'S', price: 1, latest: {} },
    app.run('ASSESS_MODEL_DEFAULT'));
  const props = schema.output_config.format.schema.properties;
  assert.equal(props.rating.type, 'integer', 'an integer, so buckets are exact');

  /* MEASURED AGAINST THE LIVE API, 2026-08-31. This first shipped as
     `minimum: 1, maximum: 10`, and every call 400'd with "For 'integer' type,
     properties maximum, minimum are not supported" — for `number` too. The
     original test asserted the minimum and maximum were present, which is to
     say it confirmed my own assumption and told me nothing about what the API
     accepts. An explicit value list is the only way to bound a number in this
     dialect. */
  assert.deepEqual(props.rating.enum, app.run('RATING_VALUES'),
    'the range must be an enum — this schema dialect has no minimum/maximum');
  assert.equal(props.rating.minimum, undefined,
    'minimum is rejected outright by the API, and a 400 costs a whole batch');
  assert.equal(props.rating.maximum, undefined);
  assert.ok(schema.output_config.format.schema.required.includes('rating'));
  assert.ok(schema.output_config.format.schema.required.includes('rating_basis'));

  // The four sections and the categorical fields are untouched by the addition.
  for (const k of ['board_says', 'recent_events', 'what_could_break', 'uncertain',
    'concerns', 'structural', 'search_status', 'distinct_sources', 'data_quality_led']) {
    assert.ok(props[k], `${k} must survive the rating being added`);
  }
});

/* The rating is the only thing on the board with no external evidence, and the
   status system is where that claim has to be enforced rather than merely
   written down. */
test('the rating status is weaker than untested, and cannot sort or backtest', () => {
  const STATUS = app.run('STATUS');
  const RULES = app.run('STATUS_RULES');
  const u = RULES[STATUS.UNSUPPORTED];
  assert.ok(u, 'the status must be registered, not a bare string in one template');
  assert.equal(u.sortable, false, 'an unvalidated opinion must not order the board');
  assert.equal(u.filterable, false);
  assert.equal(u.backtest, false, 'and must not enter the backtest as if it were a factor');
  assert.match(u.title, /no external evidence/i);

  /* It must stay off every registered score. The moment a domain adopts it, the
     "exactly one field" claim in the UI and in docs/NOTES.md becomes false. */
  for (const s of app.run('allScores()')) {
    assert.notEqual(s.status, STATUS.UNSUPPORTED,
      `${s.field} claims UNSUPPORTED — that status belongs to the model rating alone`);
  }
});

test('the chosen model reaches the request, and is recorded on the entry', () => {
  const row = { symbol: 'TEST', name: 'Test Co', sector: 'Tech', price: 100, latest: {} };

  /* The whole point of the selector: without this the model parameter existed
     but nothing set it, and every assessment ran on the default. */
  for (const id of Object.keys(app.run('ASSESS_MODELS'))) {
    const req = app.run('assessRequest')(row, id);
    assert.equal(req.model, id, 'the chosen model must reach the request body');
    assert.equal(req.tools[0].type, app.run('ASSESS_MODELS')[id].search,
      'and carry that model\'s own search tool version');
  }

  // Every registry entry needs what the selector renders and the ledger prices.
  for (const [id, cfg] of Object.entries(app.run('ASSESS_MODELS'))) {
    for (const field of ['label', 'in', 'out', 'search', 'approx']) {
      assert.ok(cfg[field] != null, `${id} is missing ${field}`);
    }
    assert.match(id, /^claude-/, 'a dated model id, not an alias');
  }
});

test('a stored model choice is validated, never trusted', () => {
  const good = loadApp({ 'bar.assessModel': 'claude-haiku-4-5-20251001' });
  assert.equal(good.state.assessModel, 'claude-haiku-4-5-20251001',
    'a valid stored choice survives the load');

  /* A retired model, or this table edited, would otherwise be sent to the API
     and rejected once per call rather than once. */
  for (const bad of ['claude-opus-3', '', 'null', 'not-a-model']) {
    const s = loadApp({ 'bar.assessModel': bad });
    assert.equal(s.state.assessModel, app.run('ASSESS_MODEL_DEFAULT'),
      `"${bad}" must fall back to the default`);
  }
  assert.equal(loadApp().state.assessModel, app.run('ASSESS_MODEL_DEFAULT'),
    'and no stored choice means the default');
});

// ── Batch assessment ────────────────────────────────────────────────

const ROWS = (n) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}` }));
const OPUS = 'claude-opus-4-5-20251101';

/* The quote a user reads before consenting to a charge is the one number in
   this feature that must never be recovered by parsing a display string —
   `approx` is "~$0.15" and Number("~$0.15") is NaN, which would render the
   total as NaN or, worse, coerce to a plausible-looking zero. */
test('the batch quote uses the numeric estimate, never the display string', () => {
  for (const [id, cfg] of Object.entries(app.run('ASSESS_MODELS'))) {
    assert.equal(typeof cfg.est, 'number', `${id} needs a numeric est for arithmetic`);
    assert.ok(cfg.est > 0, `${id} must not price at zero — a free call disables the guard`);
    assert.ok(Number.isNaN(Number(cfg.approx)),
      'and `approx` must stay a display string, so nothing is tempted to compute with it');
  }

  const plan = app.run('batchPlan')({ rows: ROWS(10), n: 10, model: OPUS });
  assert.equal(plan.symbols.length, 10);
  assert.ok(Number.isFinite(plan.total) && plan.total > 0, 'the total must be a real number');
  assert.equal(plan.total.toFixed(2), (app.run('ASSESS_MODELS')[OPUS].est * 10).toFixed(2));
});

test('the batch quote prefers what calls actually cost over the price table', () => {
  const plan = app.run('batchPlan');
  const hist = (usd) => usd.map((u) => ({ model: OPUS, usage: { usd: u } }));

  // Under three observations the table wins — two calls is not a distribution.
  const thin = plan({ rows: ROWS(4), n: 4, model: OPUS, history: hist([0.9, 0.9]) });
  assert.match(thin.basis, /list prices/);

  /* Median, not mean. One runaway search-heavy call must not set the estimate
     for twenty ordinary ones: the mean here is 0.60, the median 0.20. */
  const seen = plan({ rows: ROWS(4), n: 4, model: OPUS, history: hist([0.1, 0.2, 0.3, 1.8]) });
  assert.equal(seen.perCall, 0.25, 'the median, so one outlier cannot set the quote');
  assert.ok(seen.perCall < 0.6, 'the mean here is 0.60 — three times what the next call costs');
  assert.match(seen.basis, /median of 4/);

  // Another model's calls say nothing about this one's cost.
  const other = plan({
    rows: ROWS(4), n: 4, model: OPUS,
    history: [{ model: 'claude-haiku-4-5-20251001', usage: { usd: 0.01 } },
      { model: 'claude-haiku-4-5-20251001', usage: { usd: 0.01 } },
      { model: 'claude-haiku-4-5-20251001', usage: { usd: 0.01 } }],
  });
  assert.match(other.basis, /list prices/, 'estimates must not cross models');
});

/* "It will stop early" is something a user needs before starting, not at name
   fourteen. The +1 is the proxy's own behaviour: it refuses once OVER the
   ceiling, so one call that carries the total past the line is admitted. */
test('the batch quote says in advance when the ceiling will cut it short', () => {
  const plan = app.run('batchPlan');

  /* Headroom is derived from the table rather than written as a literal. It used
     to be `spend: { usd: 4.7 }` with `affordable: 3`, which was arithmetic on a
     $0.15 estimate — so re-baselining that estimate to $0.23 broke a test whose
     subject is the +1 overshoot rule and not the price. Two calls' worth of
     headroom must buy two calls plus the one that goes over, at whatever the
     estimate happens to be. */
  const est = app.run('ASSESS_MODELS')[OPUS].est;
  const p = plan({
    rows: ROWS(20), n: 20, model: OPUS,
    history: [], spend: { usd: 5 - est * 2, ceiling: 5 },
  });
  assert.equal(p.symbols.length, 20, 'the plan still names what was asked for');
  assert.equal(p.headroom.toFixed(4), (est * 2).toFixed(4));
  assert.equal(p.affordable, 3, 'two calls of headroom buys two, plus the one that overshoots');
  assert.equal(p.shortfall, 17);

  const room = plan({ rows: ROWS(5), n: 5, model: OPUS, spend: { usd: 0, ceiling: 5 } });
  assert.equal(room.shortfall, 0, 'and says nothing when the batch fits');

  const over = plan({ rows: ROWS(5), n: 5, model: OPUS, spend: { usd: 5, ceiling: 5 } });
  assert.equal(over.affordable, 0, 'at the ceiling, nothing is affordable — not even one');

  // No spend endpoint (proxy down) must not silently claim infinite headroom.
  const blind = plan({ rows: ROWS(5), n: 5, model: OPUS, spend: null });
  assert.equal(blind.headroom, null);
  assert.equal(blind.shortfall, 0);
});

test('the batch never asks for more rows than the board holds', () => {
  const plan = app.run('batchPlan');
  assert.equal(plan({ rows: ROWS(3), n: 50, model: OPUS }).symbols.length, 3);
  assert.equal(plan({ rows: ROWS(30), n: 0, model: OPUS }).symbols.length, 0);
  assert.equal(plan({ rows: ROWS(30), n: -5, model: OPUS }).symbols.length, 0);
  assert.equal(plan({ rows: ROWS(30), n: 2.9, model: OPUS }).symbols.length, 2,
    'a fractional count floors rather than rounding up into an extra charge');
  assert.deepEqual(plan({ rows: ROWS(3), n: 3, model: OPUS }).symbols, ['S0', 'S1', 'S2'],
    'and takes them from the top, in board order');
});

/* ── Naming a run by hand ────────────────────────────────────────────
   "Top n as sorted" answers one question. Re-running a retest pair, or the two
   names a stopped batch never reached, meant sorting the board until the names
   you wanted happened to be the first few rows. */

test('a typed list splits on anything a ticker cannot contain, and keeps the dot', () => {
  const parse = app.run('parseSymbolList');
  assert.deepEqual([...parse('S0, S1  S2')], ['S0', 'S1', 'S2']);
  assert.deepEqual([...parse('s0,s1')], ['S0', 'S1'], 'case is not part of a ticker');
  assert.deepEqual([...parse('S0\nS1\r\nS2')], ['S0', 'S1', 'S2'], 'pasted a column');
  assert.deepEqual([...parse('  , ,, S0 ,')], ['S0'], 'and empty fields are not symbols');
  assert.deepEqual([...parse('')], []);
  assert.deepEqual([...parse(null)], [], 'an unset box is an empty list, never "NULL"');

  /* BRK.B is on this board. A splitter that ate the dot would turn one real
     symbol into two names that are not, and both would be reported as typos. */
  assert.deepEqual([...parse('BRK.B, BF-B')], ['BRK.B', 'BF-B']);
});

/* ── The queue ───────────────────────────────────────────────────────
   A click starts an assessment, which is what it always did. What changed is
   the SECOND click: `assessSymbol` holds a mutex, so a click while one was in
   flight used to be refused outright — the mutex's constraint leaking into the
   interface, making the user wait at the API's pace to record a decision they
   had already made. Now it lines up, and the runner takes it when it is free.

   `assessSymbol` is a function declaration, so it is a writable property of the
   sandbox global and a test can swap it for a controllable one. That is how the
   runner is exercised without a key, a network or a clock. */

/** Run `fn` with `assessSymbol` replaced, and restore it afterwards. */
async function withAssess(s, impl, fn) {
  const real = s.run('assessSymbol');
  s.run('globalThis').assessSymbol = impl;
  /* The repaint path reaches IndexedDB and the DOM, and neither exists here.
     Stubbed out rather than tolerated: this is a test of the runner's control
     flow, and a swallowed exception from the repainter would look like a
     runner that stopped early. */
  const realChanged = s.run('assessmentsChanged');
  s.run('globalThis').assessmentsChanged = async () => {};
  try { return await fn(); } finally {
    s.run('globalThis').assessSymbol = real;
    s.run('globalThis').assessmentsChanged = realChanged;
  }
}

const priced = (symbol) => ({ symbol, usage: { usd: 0.1 }, coverage: { distinctSources: 3 },
  concerns: [], model: OPUS });

test('the first click runs immediately; a click during that one lines up behind it', async () => {
  const s = loadApp();
  const order = [];
  let release;

  await withAssess(s, async (sym) => {
    order.push(sym);
    /* AAA is held open, which is the whole point: the second and third clicks
       land while it is still in flight. */
    if (sym === 'AAA') await new Promise((r) => { release = r; });
    return priced(sym);
  }, async () => {
    const click = s.run('assessClick');

    assert.equal(click('AAA'), 'queued', 'the first click starts it');
    await Promise.resolve();
    assert.equal(s.run('assessing')('AAA'), true, 'and it is in flight, not waiting');
    assert.deepEqual([...s.run('state.assessQueue')], [],
      'the name being assessed is not also sitting in the queue');

    click('BBB');
    click('CCC');
    assert.deepEqual([...s.run('state.assessQueue')], ['BBB', 'CCC'],
      'clicks during a run line up rather than being refused');
    assert.equal(s.run('queuePosition')('CCC'), 2);

    release();
    /* Let the runner finish AAA and work through what was queued behind it. */
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.deepEqual(order, ['AAA', 'BBB', 'CCC'], 'in click order, one at a time');
    assert.deepEqual([...s.run('state.assessQueue')], [], 'and the queue drains itself');
    assert.equal(s.run('assessRun').draining, false);
  });
});

test('clicking a waiting name takes it out; clicking the live one cannot', async () => {
  const s = loadApp();
  const ran = [];
  let release;

  await withAssess(s, async (sym) => {
    ran.push(sym);
    if (sym === 'AAA') await new Promise((r) => { release = r; });
    return priced(sym);
  }, async () => {
    const click = s.run('assessClick');
    click('AAA');
    await Promise.resolve();
    click('BBB');
    click('CCC');

    assert.equal(click('BBB'), 'removed', 'a second click on a waiting name drops it');
    assert.deepEqual([...s.run('state.assessQueue')], ['CCC']);
    assert.equal(s.run('queuePosition')('CCC'), 1, 'and everything after it renumbers');

    /* The call is sent and paid for. Cancelling would spend the money and throw
       away the brief, which is the rule Stop follows too. */
    assert.equal(click('AAA'), 'running', 'the one in flight cannot be taken back');

    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.deepEqual(ran, ['AAA', 'CCC'], 'the dropped name is never assessed');
  });
});

/* The three ways a run ends, and they must not be confused. A ceiling refusal
   retried nineteen more times is nineteen wasted round trips; a network blip
   that aborts the drain discards eighteen names that would have worked. */
test('the drain stops on the ceiling, survives one bad name, and can be halted', async () => {
  const drain = async (s, impl, queue) => {
    s.run('state.assessQueue').push(...queue);
    await withAssess(s, impl, () => s.run('drainQueue')());
  };

  // One name fails; the rest still run.
  const flaky = loadApp();
  const seen = [];
  await drain(flaky, async (sym) => {
    seen.push(sym);
    if (sym === 'B') throw new Error('network');
    return priced(sym);
  }, ['A', 'B', 'C']);
  assert.deepEqual(seen, ['A', 'B', 'C'], 'a failure on one name must not abort the rest');
  assert.deepEqual([...flaky.run('state.assessQueue')], [], 'and the queue still empties');

  // The ceiling ends it, and the name it refused goes back to the front.
  const capped = loadApp();
  const tried = [];
  await drain(capped, async (sym) => {
    tried.push(sym);
    if (tried.length === 2) { const e = new Error('ceiling'); e.ceiling = true; throw e; }
    return priced(sym);
  }, ['A', 'B', 'C', 'D']);
  assert.deepEqual(tried, ['A', 'B'], 'nothing is attempted past the ceiling');
  assert.deepEqual([...capped.run('state.assessQueue')], ['B', 'C', 'D'],
    'B was refused and never ran, so it is still waiting — not silently dropped');

  // Stop takes effect before the NEXT call, never mid-flight.
  const halted = loadApp();
  const ran = [];
  await drain(halted, async (sym) => {
    ran.push(sym);
    halted.run('assessRun').stop = true;   // as if the user clicked during this call
    return priced(sym);
  }, ['A', 'B', 'C']);
  assert.deepEqual(ran, ['A'], 'the in-flight call completes; the next one never starts');
  assert.deepEqual([...halted.run('state.assessQueue')], ['B', 'C'],
    'and what it never reached is still queued, in order');
});

/* One runner, however many callers. Two drains would submit two calls against a
   ceiling checked before each of them — the overshoot the sequential rule
   exists to prevent — and one would be refused with `err.busy` for no reason
   the user could see. */
test('a second drain over the same queue is a no-op, not a second runner', async () => {
  const s = loadApp();
  const ran = [];
  let release;
  await withAssess(s, async (sym) => {
    ran.push(sym);
    if (sym === 'A') await new Promise((r) => { release = r; });
    return priced(sym);
  }, async () => {
    s.run('state.assessQueue').push('A', 'B');
    const first = s.run('drainQueue')();
    await Promise.resolve();
    await s.run('drainQueue')();          // returns at once; must not start anything
    assert.deepEqual(ran, ['A'], 'the re-entrant call did not submit a second call');
    release();
    await first;
    assert.deepEqual(ran, ['A', 'B']);
  });
});

/* The button label IS the state. Three of them, and the initial render and the
   repainter have to agree about which — they are different code paths over the
   same three cases. */
test('the row button reads as idle, waiting, or in flight', async () => {
  const s = loadApp();
  const label = s.run('assessBtnLabel');
  const glyph = s.run('ASSESS_GLYPH');
  let release;

  await withAssess(s, async (sym) => {
    if (sym === 'AAA') await new Promise((r) => { release = r; });
    return priced(sym);
  }, async () => {
    assert.equal(label('AAA'), glyph, 'nothing doing');
    s.run('assessClick')('AAA');
    await Promise.resolve();
    assert.equal(label('AAA'), '…', 'in flight, and not a position');

    s.run('assessClick')('BBB');
    s.run('assessClick')('CCC');
    assert.equal(label('BBB'), '1', 'waiting names carry their place in line');
    assert.equal(label('CCC'), '2');

    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(label('AAA'), glyph, 'and every one of them goes back to idle');
    assert.equal(label('CCC'), glyph);
  });
});

test('the queue will not grow without bound', async () => {
  const s = loadApp();
  const max = s.run('ASSESS_QUEUE_MAX');
  let release;
  /* The runner is parked on the first name for the whole test, so the queue
     behind it is what the clicks built and nothing drains out from under the
     assertions. */
  await withAssess(s, async () => { await new Promise((r) => { release = r; }); return priced('X'); },
    async () => {
      const click = s.run('assessClick');
      for (let i = 0; i <= max; i++) click(`S${i}`);
      assert.equal(s.run('state.assessQueue').length, max,
        'one is in flight and the rest wait, up to the cap');
      assert.equal(click('OVER'), 'full', 'and it says so rather than ignoring the click');
      assert.equal(s.run('queued')('OVER'), false);
      release();
      s.run('assessRun').stop = true;    // let the drain end without running the rest
      for (let i = 0; i < 50; i++) await Promise.resolve();
    });
});

/* The box is a keyboard route into the SAME list, not a second run list. */
test('typing sorts every name into added, already, unknown or overflow', () => {
  const plan = app.run('enqueuePlan');
  const board = new Set(['AAA', 'BBB', 'CCC']);

  const p = plan('aaa, nope bbb, AAA', { queue: ['BBB'], onBoard: board });
  assert.deepEqual([...p.added], ['AAA'], 'once, however many times it was typed');
  /* Measured against the queue as it WAS. A name typed twice in one go is one
     name and nothing worth saying; a name already in the queue is a fact the
     user may want, because the run already covered it. */
  assert.deepEqual([...p.already], ['BBB'], 'and not the name this same string just added');
  assert.deepEqual([...p.unknown], ['NOPE']);
  assert.deepEqual([...p.overflow], []);

  /* The cap reports the names it left out. A list that half arrives with no
     word about the other half is the shape of bug this feature exists around. */
  const full = plan('AAA, BBB, CCC', { queue: ['ZZZ'], onBoard: board, max: 2 });
  assert.deepEqual([...full.added], ['AAA'], 'one slot left, one name takes it');
  assert.deepEqual([...full.overflow], ['BBB', 'CCC']);

  assert.deepEqual([...plan('', { queue: [], onBoard: board }).added], [],
    'an empty box adds nothing and reports nothing');
});

/* ── Recent analyses ─────────────────────────────────────────────────
   A chip is a way to OPEN a brief, and the detail panel shows a symbol's newest
   entry — `assessBriefHTML` reads `log[0]`. A chip for an older run of the same
   name would promise one brief and open a different one. */
test('the recent strip is one chip per symbol, newest first', async () => {
  const s = loadApp();
  const n = s.run('ASSESS_RECENT_N');
  const at = Date.parse('2026-09-02T12:00:00Z');

  /* Newest first, which is the order loadAssessments returns. AAA appears
     twice — the older run must not take a second chip. */
  const log = [
    { symbol: 'AAA', at, model: OPUS, rating: 7 },
    { symbol: 'BBB', at: at - 1000, model: OPUS, rating: 5 },
    { symbol: 'AAA', at: at - 2000, model: OPUS, rating: 3 },
    ...Array.from({ length: n + 4 }, (_, i) => ({ symbol: `S${i}`, at: at - 3000 - i, model: OPUS, rating: 6 })),
  ];
  s.run('globalThis').loadAssessments = async () => log;
  await s.run('refreshAssessCache')();

  const recent = [...s.run('state.assessRecent')];
  assert.equal(recent.length, n, 'capped — past eight this stops being "what did I just run"');
  assert.deepEqual(recent.slice(0, 2).map((e) => e.symbol), ['AAA', 'BBB'], 'newest first');
  assert.equal(recent[0].rating, 7, 'and AAA shows the run the panel will open, not the older one');
  assert.equal(new Set(recent.map((e) => e.symbol)).size, n, 'one chip per symbol');
});

/* ── Which model wrote the reading ───────────────────────────────────
   The board cell shows ONE entry out of however many a symbol carries, and the
   choice is not "newest" — so two rows showing 7 can be two different models. */

test('every model has a short name for the cell, and it is not the bare id', () => {
  for (const [id, cfg] of Object.entries(app.run('ASSESS_MODELS'))) {
    assert.equal(typeof cfg.short, 'string');
    assert.ok(cfg.short.length > 0 && cfg.short.length <= 8,
      `${id}: the column is one word wide`);
    assert.notEqual(cfg.short, id);
  }
  const short = app.run('assessModelShort');
  assert.equal(short('claude-opus-4-5-20251101'), 'Opus');
  assert.equal(short('claude-haiku-4-5-20251001'), 'Haiku');
  /* A model retired from the table still has to render as something. The id is
     ugly, and it is the only true answer left. */
  assert.equal(short('claude-something-unknown'), 'claude-something-unknown');
  assert.equal(short(undefined), undefined);
});

/* ── Repeat guard ────────────────────────────────────────────────────
   `history` was passed into batchPlan from the first version and read only for
   its costs, so the quote knew every name it was about to re-assess and said
   nothing. Two batch-shaped runs 44 minutes apart shared 8 of their 10 names. */

const HAIKU = 'claude-haiku-4-5-20251001';
const NOW = Date.parse('2026-09-01T12:00:00Z');
const ago = (mins, over = {}) => ({ at: NOW - mins * 60000, usage: { usd: 0.05 }, ...over });

test('the batch names the repeats it is about to re-run', () => {
  const plan = app.run('batchPlan')({
    rows: ROWS(3), n: 3, model: OPUS, now: NOW,
    history: [ago(40, { symbol: 'S0', model: OPUS, rating: 6 })],
  });
  assert.equal(plan.sameModelRepeats.length, 1);
  assert.equal(plan.sameModelRepeats[0].symbol, 'S0');
  assert.equal(plan.sameModelRepeats[0].rating, 6);
  assert.equal(app.run('humanAgo')(plan.sameModelRepeats[0].agoMs), '40m');

  /* Flagging is not skipping. The default must still run everything asked for,
     or the guard would remove rows from a run the user priced and confirmed. */
  assert.deepEqual(plan.symbols, ['S0', 'S1', 'S2']);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.total.toFixed(2), (app.run('ASSESS_MODELS')[OPUS].est * 3).toFixed(2));
});

test('a repeat on a different model is a comparison pair, and is never skipped', () => {
  const plan = app.run('batchPlan')({
    rows: ROWS(2), n: 2, model: OPUS, skipRepeats: true, now: NOW,
    history: [ago(30, { symbol: 'S0', model: HAIKU, rating: 5 })],
  });
  assert.equal(plan.sameModelRepeats.length, 0, 'a different model is not a same-model repeat');
  assert.equal(plan.repeats.length, 1, 'but it is still reported');
  assert.equal(plan.repeats[0].sameModel, false);
  assert.deepEqual(plan.symbols, ['S0', 'S1'],
    'skipping must not remove the second half of a deliberate retest pair');
});

test('skipping shortens the run and reprices it, and does not backfill', () => {
  const plan = app.run('batchPlan')({
    rows: ROWS(4), n: 3, model: OPUS, skipRepeats: true, now: NOW,
    history: [ago(10, { symbol: 'S0', model: OPUS }), ago(90, { symbol: 'S2', model: OPUS })],
  });
  /* Spread first: `skipped` is built inside the vm, so its prototype is the
     sandbox's Array and a strict deep-equal fails on that alone. `symbols`
     below descends from the host array `ROWS` returned, so it compares as is. */
  assert.deepEqual([...plan.skipped], ['S0', 'S2']);
  assert.deepEqual(plan.symbols, ['S1'], 'S3 must NOT be pulled up to refill the count');
  assert.deepEqual(plan.requested, ['S0', 'S1', 'S2'], 'and what was asked for is still reported');
  assert.equal(plan.total.toFixed(2), app.run('ASSESS_MODELS')[OPUS].est.toFixed(2),
    'the quote prices what will actually run');
});

test('the repeat window has an edge, and entries outside it are not repeats', () => {
  const plan = app.run('batchPlan');
  const win = app.run('ASSESS_REPEAT_WINDOW_MS');
  const inside = plan({ rows: ROWS(1), n: 1, model: OPUS, now: NOW,
    history: [{ at: NOW - win + 1000, symbol: 'S0', model: OPUS, usage: { usd: 0.1 } }] });
  assert.equal(inside.sameModelRepeats.length, 1);

  const outside = plan({ rows: ROWS(1), n: 1, model: OPUS, now: NOW,
    history: [{ at: NOW - win - 1000, symbol: 'S0', model: OPUS, usage: { usd: 0.1 } }] });
  assert.equal(outside.sameModelRepeats.length, 0, 'older than the window is not "recent"');
});

test('only the newest prior run of a name is reported, not every one', () => {
  const plan = app.run('batchPlan')({
    rows: ROWS(1), n: 1, model: OPUS, now: NOW,
    history: [ago(10, { symbol: 'S0', model: OPUS, rating: 8 }),
      ago(200, { symbol: 'S0', model: OPUS, rating: 4 }),
      ago(300, { symbol: 'S0', model: OPUS, rating: 3 })],
  });
  assert.equal(plan.sameModelRepeats.length, 1, 'four runs of one name is still one warning');
  assert.equal(plan.sameModelRepeats[0].rating, 8, 'and it is the most recent one');
});

/* The guard is about what the log holds, not about how the run was named, so a
   listed run has to reach it exactly as a top-n one does. */

/* ── Provenance ──────────────────────────────────────────────────────
   Both call paths reach one function, so up to v2 every entry is identical in
   origin and the only way to ask "did the batch do this?" was to infer it from
   the gaps between timestamps. */

test('a missing provenance reads as unknown, never as a value', () => {
  const predates = app.run('predatesProvenance');
  const via = app.run('assessVia');

  assert.equal(predates({ v: 2, rating: 5 }), true);
  assert.equal(via({ v: 2, rating: 5 }), null,
    'a v2 entry has no origin — defaulting it to "single" would invent the fact');
  assert.equal(via({ v: 1 }), null);

  assert.equal(predates({ v: 3, via: 'batch' }), false);
  assert.equal(via({ v: 3, via: 'batch' }), 'batch');
  assert.equal(via({ v: 3, via: 'single' }), 'single');
});

test('the entry version was bumped with the field, so the gap stays readable', () => {
  assert.ok(app.run('ASSESS_ENTRY_V') >= 3,
    'v3 is what makes an absent `via` mean "never recorded" rather than "dropped"');
});

/* ── Test-retest: what counts as a measurement ───────────────────────
   A repeat measures the model's own noise only if the model saw the same
   inputs twice. Where the board moved, the rating was entitled to move with it
   and the difference is model noise plus board movement, inseparably. */

const CTX = (over = {}) => ({ mom12: 50, analyst: 60, accruals: 40, overall: 55, ...over });
const RTE = (symbol, atISO, rating, scores) => ({
  symbol, model: HAIKU, at: Date.parse(atISO), rating, v: 3, via: 'batch', scores,
});

test('a repeat over an unchanged board is clean; one over a moved board is not', () => {
  const pairs = app.run('repeatPairs')([
    RTE('AAA', '2026-09-01T04:00:00Z', 5, CTX()),
    RTE('AAA', '2026-09-01T05:00:00Z', 6, CTX()),
    RTE('BBB', '2026-09-01T04:00:00Z', 5, CTX()),
    RTE('BBB', '2026-09-01T05:00:00Z', 7, CTX({ mom12: 51 })),
  ]);
  const byS = Object.fromEntries(pairs.map((p) => [p.symbol, p]));
  assert.equal(byS.AAA.clean, true, 'identical stored scores, same side of the fix');
  assert.equal(byS.AAA.diff, 1);
  assert.equal(byS.BBB.clean, false, 'one score moved, so this measures the board too');
});

/* The boundary is checked on its own rather than trusted to show up as a
   numeric difference: a name whose fundamentals were null on BOTH sides passes
   an exact score comparison while still spanning a change in what the board
   meant. */
test('a pair straddling the fundamentals fix is excluded even when its scores match', () => {
  const nulls = CTX({ earnYield: null, roe: null, accruals: null });
  const [pair] = app.run('repeatPairs')([
    RTE('CCC', '2026-09-01T02:35:00Z', 6, nulls),   // before 03:10Z
    RTE('CCC', '2026-09-01T03:20:00Z', 6, nulls),   // after
  ]);
  assert.equal(pair.sameCtx, true, 'the stored numbers really are identical');
  assert.equal(pair.straddles, true);
  assert.equal(pair.clean, false, 'and the boundary alone is enough to exclude it');
});

test('a pair with no recorded board context is not clean', () => {
  const [pair] = app.run('repeatPairs')([
    RTE('DDD', '2026-09-01T04:00:00Z', 5, undefined),
    RTE('DDD', '2026-09-01T05:00:00Z', 5, undefined),
  ]);
  assert.equal(pair.clean, false, 'an unrecorded context is not a matching one');
});

test('pairs are consecutive, so three runs of a name give two of them', () => {
  const pairs = app.run('repeatPairs')([
    RTE('EEE', '2026-09-01T04:00:00Z', 4, CTX()),
    RTE('EEE', '2026-09-01T05:00:00Z', 6, CTX()),
    RTE('EEE', '2026-09-01T06:00:00Z', 5, CTX()),
  ]);
  assert.equal(pairs.length, 2);
  assert.deepEqual([...pairs.map((p) => p.diff)], [2, 1]);
});

test('different models on one symbol are not a retest pair', () => {
  const pairs = app.run('repeatPairs')([
    RTE('FFF', '2026-09-01T04:00:00Z', 5, CTX()),
    { ...ENTRY('FFF', '2026-09-01T05:00:00Z', 8, CTX()), model: OPUS },
  ]);
  assert.equal(pairs.length, 0, 'that is a model comparison, not a measure of noise');
});

/* ── The horizon split ───────────────────────────────────────────────
   Two calls on two horizons, allowed to disagree. The failure to guard against
   is not the model disagreeing with itself — that is the point — but the
   harness quietly scoring one of them on the other's horizon. */

test('an entry from before the split is a gap, not a refusal', () => {
  const pre = app.run('predatesCalls');
  assert.equal(pre({ v: 3, rating: 7, via: 'batch' }), true,
    'a v3 entry has no calls because the fields did not exist');
  assert.equal(pre({ v: 4, callNear: null }), false,
    'a v4 entry with a null call was ASKED and refused — a different fact');
  assert.equal(pre({ v: 4, callNear: 6 }), false);
  assert.equal(pre(null), false);
});

test('the near call is scored on its own horizons and never on the rating’s', () => {
  const obsFor = app.run('ratingObservations');
  const DAY = 86400000;
  const now = Date.parse('2027-06-01T00:00:00Z');
  const at = now - 400 * DAY;                       // old enough for every horizon
  const entries = [{ v: 4, symbol: 'AAA', at, priceAt: 100, rating: 9, callNear: 3, callLong: 8 }];
  const closeAt = () => 110;

  const near = obsFor(entries, closeAt, {
    now, field: 'callNear',
    horizons: app.run('CALL_NEAR_HORIZONS'), predates: app.run('predatesCalls'),
  });
  assert.deepEqual([...near.byHorizon.keys()], [1, 3],
    'the near call must not carry a 6-month column it never claimed');
  assert.equal(near.byHorizon.get(1)[0].rating, 3,
    'and the value scored must be the near call, not the rating on the same entry');

  const long = obsFor(entries, closeAt, {
    now, minDays: app.run('CALL_LONG_MIN_DAYS'), field: 'callLong',
    horizons: app.run('CALL_LONG_HORIZONS'), predates: app.run('predatesCalls'),
  });
  assert.deepEqual([...long.byHorizon.keys()], [12, 24, 36]);
  assert.equal(long.byHorizon.get(12)[0].rating, 8);
  assert.equal(long.byHorizon.get(24).length, 0, '400 days is not yet 24 months');
});

test('the rating arm is untouched by the split', () => {
  const obsFor = app.run('ratingObservations');
  const DAY = 86400000;
  const now = Date.parse('2026-12-01T00:00:00Z');
  const entries = [{ v: 4, symbol: 'AAA', at: now - 200 * DAY, priceAt: 100, rating: 7, callNear: 2 }];
  const { byHorizon } = obsFor(entries, () => 110, { now });
  assert.deepEqual([...byHorizon.keys()], [1, 3, 6], 'default horizons unchanged');
  assert.equal(byHorizon.get(1)[0].rating, 7, 'and the default field is still the rating');
});

/* ── entry_level: the gate ───────────────────────────────────────────
   The condition is that the level be arithmetic on a figure already in the
   board context. A number that cannot name its source has not met it, and is
   rejected exactly like one out of range. */

test('a level without a cited board figure is not a level', () => {
  const ok = app.run('validEntryLevel');
  const why = app.run('entryLevelRejection');

  assert.equal(ok(118.4, 'support at 118.40 from the 52-week range position'), true);
  assert.equal(ok(118.4, null), false, 'a number from nowhere is refused');
  assert.equal(ok(118.4, '   '), false, 'and whitespace is not a citation');
  assert.equal(ok(0, 'support'), false);
  assert.equal(ok(-5, 'support'), false);
  assert.equal(ok(NaN, 'support'), false);

  /* "Not offered" and "offered and refused" are different facts, and only the
     second says the gate is doing work. */
  assert.equal(why(null, null), null, 'a null level is a correct answer, not a fault');
  assert.equal(why(118.4, null), 'no board figure cited');
  assert.equal(why(-1, 'support'), 'not a positive price');
  assert.equal(why(118.4, 'support at 118.40'), null);
});

/* ── entry_level: did waiting beat buying on the day? ────────────────
   Fixed end date on both arms. Comparing a later fill held to the same day
   against a purchase on day 0 held to that day is the comparison a person
   actually faces. */

const LDAY = 86400000;
const lvlEntry = (over = {}) => ({
  v: 6, symbol: 'AAA', at: Date.parse('2026-01-01T00:00:00Z'), priceAt: 100,
  callNear: 6, entryLevel: 90, entryLevelBasis: 'support at 90', entryLevelRejected: null,
  /* v6. A fixture left at v4 with a null level now lands in `preStance` rather
     than in the bucket a test means to exercise — which is the version gap
     working as designed, and the reason the default carries a stance. */
  entryStance: 'level', ...over,
});
const LNOW = Date.parse('2026-06-01T00:00:00Z');

test('a level that filled is measured from the level, to the same end date', () => {
  const bars = [
    { day: '2026-01-15', close: 95 },
    { day: '2026-01-20', close: 88 },      // the fill
    { day: '2026-01-25', close: 92 },
  ];
  const { rows } = app.run('entryLevelOutcomes')(
    [lvlEntry()], () => bars, () => 120, { now: LNOW });

  const m1 = rows.find((r) => r.months === 1);
  assert.equal(m1.reached, true);
  assert.equal(m1.reachedOn, '2026-01-20');
  assert.equal(m1.daysToReach, 19);
  /* Bought at the LEVEL, not at the close that triggered it: the level is the
     limit price, and 88 is only evidence that 90 was available. */
  assert.equal(m1.retFromLevel.toFixed(2), (120 / 90 * 100 - 100).toFixed(2));
  assert.equal(m1.retFromAssessment.toFixed(2), '20.00');
  assert.ok(m1.advantage > 0, 'waiting for 90 beat paying 100 for the same exit');
});

test('a level that never filled earns nothing, and says so as null', () => {
  const bars = [{ day: '2026-01-15', close: 99 }, { day: '2026-01-25', close: 97 }];
  const { rows } = app.run('entryLevelOutcomes')(
    [lvlEntry()], () => bars, () => 120, { now: LNOW });
  const m1 = rows.find((r) => r.months === 1);
  assert.equal(m1.reached, false);
  assert.equal(m1.retFromLevel, null, 'you cannot earn the return from a price you never paid');
  assert.equal(m1.advantage, null, 'and the advantage is null, never zero');
  assert.equal(m1.retFromAssessment.toFixed(2), '20.00',
    'while the return foregone by waiting is still recorded');
});

test('the assessment day is not a fill', () => {
  /* A close at or below the level ON the day of the assessment would mean the
     level was already available when it was named, which is the degenerate
     case below — not a fill earned by waiting. */
  const bars = [{ day: '2026-01-01', close: 85 }, { day: '2026-01-20', close: 95 }];
  const { rows } = app.run('entryLevelOutcomes')(
    [lvlEntry()], () => bars, () => 120, { now: LNOW });
  assert.equal(rows.find((r) => r.months === 1).reached, false);
});

test('a level at or above the price on the day claims nothing, and is flagged', () => {
  const { rows } = app.run('entryLevelOutcomes')(
    [lvlEntry({ entryLevel: 105 })], () => [], () => 120, { now: LNOW });
  const m1 = rows.find((r) => r.months === 1);
  assert.equal(m1.degenerate, true, '105 was buyable at 100 — waiting was never asked for');
  assert.equal(m1.daysToReach, 0);
  assert.equal(m1.advantage < 0, true, 'and paying 105 for a 120 exit beats nothing');
});

test('the ledger separates a refused level from one never offered', () => {
  const out = app.run('entryLevelOutcomes')([
    lvlEntry({ symbol: 'A' }),
    lvlEntry({ symbol: 'B', entryLevel: null, entryLevelBasis: null, entryStance: 'no_anchor' }),
    lvlEntry({ symbol: 'C', entryLevel: null, entryLevelRejected: 'no board figure cited' }),
    { v: 3, symbol: 'D', at: lvlEntry().at, rating: 5 },
    lvlEntry({ symbol: 'E', entryLevel: null, entryStance: 'outside_band' }),
    /* v4: had the field, but from before a null had to say what it meant. Its
       null is genuinely ambiguous and must not be read as either answer. */
    { v: 4, symbol: 'F', at: lvlEntry().at, callNear: 6, entryLevel: null },
  ], () => [], () => 120, { now: LNOW });

  assert.equal(out.skipped.noLevel, 1, 'B had nothing to cite, which is a correct answer');
  assert.equal(out.skipped.rejected, 1, 'C offered one and had it refused, which is a fault');
  assert.equal(out.skipped.preField, 1, 'D predates the field entirely');
  assert.equal(out.skipped.outsideBand, 1, 'E wanted lower but could not name a level');
  assert.equal(out.skipped.preStance, 1,
    'F predates the stance, so its null cannot be read as either meaning');
});

test('entry-level stats keep the unfilled half of the ledger', () => {
  const st = app.run('entryLevelStats')([
    { months: 1, day: 'd1', reached: true, daysToReach: 10, advantage: 5, retFromAssessment: 2, degenerate: false },
    { months: 1, day: 'd1', reached: true, daysToReach: 20, advantage: 7, retFromAssessment: 3, degenerate: false },
    { months: 1, day: 'd2', reached: false, daysToReach: null, advantage: null, retFromAssessment: 11, degenerate: false },
  ]);
  assert.equal(st.n, 3);
  assert.equal(st.nFilled, 2);
  assert.equal(st.nUnfilled, 1);
  assert.equal(st.medianDaysToFill, 15);
  assert.equal(st.meanAdvantage, 6);
  assert.equal(st.meanMissed, 11,
    'a field that fills rarely can look good on its fills while losing overall');
  assert.equal(st.days, 2, 'and distinct days are counted here too');
});

/* ── The long call does not render an empty table ────────────────────
   An empty table with the same headings as a measured one is a result-shaped
   object containing no result, and the cells are the only thing distinguishing
   them. */
test('the long call shows a date, not a table, until it can report', () => {
  const html = app.run('longSectionHTML');

  const none = html([{ v: 4, symbol: 'A', at: Date.now(), callLong: null }]);
  assert.match(none, /No assessment carries a long-term call yet/);
  assert.ok(!none.includes('<table'), 'and no table at all');

  const waiting = html([{ v: 4, symbol: 'A', at: Date.now() - 10 * LDAY, callLong: 7 }]);
  assert.match(waiting, /Nothing can be reported here until \d{4}-\d{2}-\d{2}/,
    'the date a result becomes possible is the useful thing to show');
  assert.ok(!waiting.includes('<table'),
    'an empty table would read as a measured result whose cells happen to be blank');
  assert.match(waiting, /355 days away/, 'counted from the oldest call, not from today');
});

/* ── Concurrency ─────────────────────────────────────────────────────
   The per-row button disabled only the button it was clicked on, which stops a
   double-click on one row and nothing else. Eleven rows have eleven buttons,
   and the log holds the run that proves it: 2026-09-01T02:38:33Z to 02:39:03Z,
   eleven assessments in thirty seconds when one call takes twenty. The proxy
   checks the ceiling BEFORE each call, so overlapping calls can all pass a
   check only one of them should have passed. */
test('a second assessment is refused while one is in flight', async () => {
  const s = loadApp();
  const g = s.run('globalThis');
  /* `state` is a const, so it is NOT a property of the sandbox global — only
     function declarations are. It reaches the test through the exported api,
     which is the same object. */
  s.state.rows = new Map([['AAA', { symbol: 'AAA', price: 10 }], ['BBB', { symbol: 'BBB', price: 20 }]]);

  let release;
  const hang = new Promise((r) => { release = r; });
  let started = 0;
  g.fetch = () => { started++; return hang; };

  const first = g.assessSymbol('AAA', OPUS, { via: 'single' });
  first.catch(() => {});           // settled at the end; not the assertion here

  await assert.rejects(() => g.assessSymbol('BBB', OPUS, { via: 'single' }),
    (err) => err.busy === true,
    'a click on a different row must be refused, not run alongside');
  assert.equal(started, 1, 'and refused BEFORE the network, so nothing is charged');

  // The flag must not outlive the run, or every later assessment wedges.
  release({ ok: false, status: 500, json: async () => ({ error: 'stop' }) });
  await first.catch(() => {});
  await assert.rejects(() => g.assessSymbol('BBB', OPUS, { via: 'single' }),
    (err) => err.busy !== true,
    'once the first call ends, the next one gets through to fail on its own merits');
});

/* The three ways a run ends moved from `runBatch` to `drainQueue` when the two
   runners became one — see "the drain stops on the ceiling…" above, which is
   the same three cases against the surviving runner. The mutex test above is
   what makes single-flight worth having. */

// ── Volatility scoring ──────────────────────────────────────────────

/* The failure this replaced: 82 names above 50% annualised vol occupied 6.46
   points of the 0–100 range, and MRNA at 191.9% and SMCI at 91.3% both scored
   0.0 despite a 100-point gap. The factor stopped distinguishing volatile from
   extremely volatile. */
test('the volatility curve still separates names deep in the tail', () => {
  const sub = app.run('subScores');
  const score = (v) => sub({ realisedVol: v }).volScore;

  // Strictly decreasing all the way out, with gaps a reader can act on.
  const tail = [50, 60, 70, 80, 90, 120, 192].map(score);
  for (let i = 1; i < tail.length; i++) {
    assert.ok(tail[i] < tail[i - 1], `${tail[i]} must be below ${tail[i - 1]}`);
  }
  assert.ok(score(91) - score(192) > 1.5,
    'SMCI at 91% and MRNA at 192% must not both round to zero — they did under the linear curve');
  assert.ok(score(60) - score(80) > 3,
    'a third of the volatility apart must be more than a rounding difference');

  /* Multiplicative, which is the property a linear curve cannot express: equal
     RATIOS should cost roughly equal score, so 15→30 and 30→60 are comparable
     steps rather than one costing 29 points and the other 48. */
  const a = score(15) - score(30);
  const b = score(30) - score(60);
  assert.ok(Math.abs(a - b) < 1,
    `equal doublings must cost equal score: got ${a.toFixed(1)} and ${b.toFixed(1)}`);

  assert.equal(Math.round(score(app.run('VOL_PIVOT'))), 50, 'the pivot still scores 50');
});

test('volatility scoring survives the values that break a logarithm', () => {
  const sub = app.run('subScores');
  assert.equal(sub({ realisedVol: null }).volScore, null);
  /* log(0) is −Infinity and would propagate through the blend to NaN, which
     sorts unpredictably rather than sinking like a null. A flat line is not a
     safe stock; it is a series with no information. */
  assert.equal(sub({ realisedVol: 0 }).volScore, null);
  assert.equal(sub({ realisedVol: -5 }).volScore, null);
  assert.ok(Number.isFinite(sub({ realisedVol: 0.001 }).volScore));
  assert.ok(Number.isFinite(sub({ realisedVol: 5000 }).volScore));
});

// ── Insider activity, split by filer type ───────────────────────────

const f4 = (name, code, change, share) =>
  ({ name, transactionCode: code, change, share, transactionPrice: 100 });

/* FANG's −10,177,667 was 98.3% one filing by a holder of 26% of the company.
   Merged into a single figure it read as nineteen insiders losing faith. */
test('a large holder is never merged into the officer figure', () => {
  const out = app.run('summariseInsider')({ data: [
    f4('Greth Lyndal', 'S', -10_000_000, 74_036_722),   // 26.4% of the company
    f4('Meloy Charles', 'S', -116_700, 920_326),        // 0.33%
    f4('Wesson Daniel', 'S', -7_562, 839_982),
    f4('Someone', 'P', 5_000, 12_000),
  ] }, 280_000_000);

  assert.equal(out.holder.net, -10_000_000);
  assert.equal(out.holder.trades, 1);
  assert.equal(out.officer.net, -116_700 - 7_562 + 5_000,
    'the officer figure must exclude the block entirely');
  assert.equal(out.officer.trades, 3);
  assert.equal(out.unknown.net, null, 'nothing unclassified when a share count exists');

  /* The direction of the two disagreeing is the case worth seeing, and the old
     single number could not express it. */
  const mixed = app.run('summariseInsider')({ data: [
    f4('Big Holder', 'S', -5_000_000, 30_000_000),
    f4('An Officer', 'P', 10_000, 50_000),
  ] }, 100_000_000);
  assert.ok(mixed.holder.net < 0 && mixed.officer.net > 0,
    'an officer buying while a holder sells must survive as two facts');
});

test('without a share count nothing is classified as an officer', () => {
  const rows = { data: [f4('Someone', 'S', -900, 1_000), f4('Other', 'S', -100, 500)] };

  const blind = app.run('summariseInsider')(rows, null);
  assert.equal(blind.unknown.trades, 2, 'no denominator means no classification');
  assert.equal(blind.officer.net, null,
    'guessing officer would reintroduce exactly the conflation this split removes');
  assert.equal(blind.holder.net, null);

  // A stale or zero share count is the same as none.
  assert.equal(app.run('summariseInsider')(rows, 0).unknown.trades, 2);
});

test('compensation mechanics stay excluded, and no trades is not a zero net', () => {
  const out = app.run('summariseInsider')({ data: [
    f4('A', 'A', 50_000, 60_000),   // grant
    f4('B', 'M', 20_000, 30_000),   // option exercise
    f4('C', 'F', -8_000, 20_000),   // withheld for tax
    f4('D', 'G', -2_700, 10_000),   // gift
  ] }, 100_000_000);
  for (const g of ['officer', 'holder', 'unknown']) {
    assert.equal(out[g].net, null, `${g}: a grant is not a purchase`);
    assert.equal(out[g].trades, 0);
  }
});

/* The brief reasoned about a $2B stake rebalance as conviction because it was
   handed one signed number with no way to know what was in it. */
test('the brief is told the two filer types apart, and told what is missing', () => {
  const ctx = app.run('insiderContext')({ insider: {
    officer: { net: -119_262, bought: 5_000, sold: 124_262, trades: 3 },
    holder: { net: -10_000_000, bought: 0, sold: 10_000_000, trades: 1 },
    unknown: { net: null, bought: 0, sold: 0, trades: 0 },
  } });

  assert.match(ctx, /Officers and directors: net -119,262/);
  assert.match(ctx, /Beneficial owners above 10%: net -10,000,000/);
  assert.match(ctx, /must NOT be added together/,
    'the model will sum two numbers under one heading unless told not to');
  assert.match(ctx, /13F\/13G/, 'the coverage gap must be stated, not left to be discovered');
  assert.match(ctx, /Absence of selling here is not evidence/,
    'the gap is about what CANNOT appear, which is the part a reader gets wrong');

  assert.match(app.run('insiderContext')({ insider: null }), /no Form 4 data/);
});

// ── The TTM roll and its reconciliation gate ────────────────────────

/* One fiscal year of facts as EDGAR actually files them: Q1/Q2/Q3 discrete,
   six- and nine-month cumulatives, an annual — and NO discrete Q4, which is the
   whole reason the old `slice(0, 4)` was wrong.

   VALUES ARE IN DOLLARS, at the scale filings actually use. An earlier version
   of this fixture counted in single digits and the reconciliation test passed
   against a deliberately corrupted figure: `fxReconcile` floors its denominator
   at $1M so that a quarter netting near zero cannot turn rounding into an
   enormous relative error, and at a scale of 10 the floor swallowed the whole
   discrepancy. A fixture has to run at the magnitude the code runs at. */
const B = 1e9;
const fy = (yr, { q1, q2, q3, q4, quarters = true }) => {
  const y = [
    { s: `${yr}-01-01`, e: `${yr}-12-31`, v: (q1 + q2 + q3 + q4) * B, f: `${yr + 1}-02-01` },
    { s: `${yr}-01-01`, e: `${yr}-09-30`, v: (q1 + q2 + q3) * B, f: `${yr}-10-25` },
    { s: `${yr}-01-01`, e: `${yr}-06-30`, v: (q1 + q2) * B, f: `${yr}-07-25` },
    { s: `${yr}-01-01`, e: `${yr}-03-31`, v: q1 * B, f: `${yr}-04-25` },
  ];
  if (quarters) {
    y.push({ s: `${yr}-07-01`, e: `${yr}-09-30`, v: q3 * B, f: `${yr}-10-25` });
    y.push({ s: `${yr}-04-01`, e: `${yr}-06-30`, v: q2 * B, f: `${yr}-07-25` });
  }
  return y;
};
// Newest first, as the extraction stores it.
const series = (...years) => years.flat().sort((a, b) => (a.e < b.e ? 1 : a.e > b.e ? -1 : 0));

test('the roll reconstructs a true twelve months, not four scattered quarters', () => {
  const arr = series(
    fy(2026, { q1: 10, q2: 11, q3: 12, q4: 0 }).filter((x) => x.e <= '2026-09-30'),
    fy(2025, { q1: 5, q2: 6, q3: 7, q4: 8 }),
  );
  const r = app.run('fxRollTTM')(arr);

  /* Nine months of 2026 (33) + all of 2025 (26) − nine months of 2025 (18) = 41,
     which is Q1+Q2+Q3 of 2026 plus Q4 of 2025 — the true trailing year. */
  assert.equal(r.v, 41 * B);
  assert.equal(r.end, '2026-09-30');
  assert.equal(r.basis, 'TTM');

  /* What the old code did, for contrast: the newest four DISCRETE quarters are
     2026 Q3, Q2, Q1 and then 2025 Q3 — because 2025 Q4 is not filed as a
     quarter — giving 12+11+10+7 = 40 over a 15-month span. Close enough to look
     right, wrong by a whole quarter, and wrong in a direction that varies. */
  const quarters = arr.filter((x) => {
    const d = Math.round((Date.parse(x.e) - Date.parse(x.s)) / 86400000);
    return d >= 80 && d <= 100;
  });
  assert.equal(quarters.slice(0, 4).reduce((a, x) => a + x.v, 0), 40 * B,
    'the old path double-counts a Q3 and omits Q4');
});

test('a filed annual is returned untouched — a year needs no reconstruction', () => {
  const arr = series(fy(2025, { q1: 5, q2: 6, q3: 7, q4: 8 }));
  const r = app.run('fxRollTTM')(arr);
  assert.equal(r.basis, 'FY');
  assert.equal(r.v, 26 * B, 'the filed figure exactly, not a sum of its parts');
  assert.equal(r.end, '2025-12-31');
});

test('the roll refuses rather than guessing when a piece is missing', () => {
  const partial = series(fy(2026, { q1: 10, q2: 11, q3: 12, q4: 0 })
    .filter((x) => x.e <= '2026-09-30'));
  assert.equal(app.run('fxRollTTM')(partial), null,
    'no prior fiscal year to roll from — a partial year is not a trailing year');
  assert.equal(app.run('fxRollTTM')([]), null);
  assert.equal(app.run('fxRollTTM')(null), null);
});

/* The gate compares two independently FILED numbers, so it is a real test and
   not an arithmetic identity: a differenced cumulative against the discrete
   quarter covering the same period. 20,024 of 21,698 such checks on the live
   board are exactly zero. */
test('a figure that fails its own reconciliation is withheld, not shipped', () => {
  const good = series(
    fy(2026, { q1: 10, q2: 11, q3: 12, q4: 0 }).filter((x) => x.e <= '2026-09-30'),
    fy(2025, { q1: 5, q2: 6, q3: 7, q4: 8 }),
  );
  assert.equal(app.run('fxTTM')(good, 'GOOD').v, 41 * B, 'a consistent filer passes');
  assert.equal(app.run('fxTTM')(good, 'GOOD').verified, true,
    'and is marked as actually checked against something');

  // Corrupt one filed quarter so the cumulative and the quarter disagree.
  const bad = good.map((x) => (x.s === '2026-04-01' ? { ...x, v: 99 * B } : x));
  assert.equal(app.run('fxTTM')(bad, 'BAD'), null,
    'a number whose own inputs contradict each other must not reach the board');
  assert.match(app.run('fxGateReasons').get('BAD'), /failed reconciliation/);

  /* Absence of a check is not a pass. A filer with no discrete quarters gives
     the gate nothing to compare, and that must be visible rather than folded in
     with the verified. */
  const unverifiable = series(
    fy(2026, { q1: 10, q2: 11, q3: 12, q4: 0, quarters: false }).filter((x) => x.e <= '2026-09-30'),
    fy(2025, { q1: 5, q2: 6, q3: 7, q4: 8, quarters: false }),
  );
  const u = app.run('fxTTM')(unverifiable, 'UNV');
  assert.equal(u.v, 41 * B);
  assert.equal(u.verified, false, 'unchecked must not claim to be checked');
});

test('accruals refuse to pair two different periods', () => {
  const ni = series(
    fy(2026, { q1: 10, q2: 11, q3: 12, q4: 0 }).filter((x) => x.e <= '2026-09-30'),
    fy(2025, { q1: 5, q2: 6, q3: 7, q4: 8 }),
  );
  // Cash flow reported only to mid-year — six months behind net income.
  const ocf = series(
    fy(2026, { q1: 4, q2: 5, q3: 0, q4: 0 }).filter((x) => x.e <= '2026-06-30'),
    fy(2025, { q1: 3, q2: 3, q3: 3, q4: 3 }),
  );
  assert.equal(app.run('fxPaired')(ni, ocf, 'MISMATCH'), null,
    'a difference between two different periods is not an accrual — this is the '
    + 'Apple bug the pairing was created for, and matching ends were never sufficient');
  assert.match(app.run('fxGateReasons').get('MISMATCH'), /different periods/);

  // Same window: pairs cleanly and reports the shared basis and end.
  const aligned = series(
    fy(2026, { q1: 4, q2: 5, q3: 6, q4: 0 }).filter((x) => x.e <= '2026-09-30'),
    fy(2025, { q1: 3, q2: 3, q3: 3, q4: 3 }),
  );
  const p = app.run('fxPaired')(ni, aligned, 'OK');
  assert.equal(p.end, '2026-09-30');
  assert.equal(p.basis, 'TTM');
  assert.equal(p.ni, 41 * B);
  assert.equal(p.ocf, (15 + 12 - 9) * B);
});

/* The log records what the model was SHOWN. Repairing stored scores would turn
   a faithful record into a reconstruction that never happened, so the boundary
   is applied at read time instead. */
test('assessments logged before the fundamentals fix are marked, never rewritten', () => {
  const cut = app.run('FX_FIX_AT');
  assert.equal(app.run('predatesFxFix')({ at: cut - 1 }), true);
  assert.equal(app.run('predatesFxFix')({ at: cut }), false, 'the boundary is inclusive forward');
  assert.equal(app.run('predatesFxFix')({ at: cut + 1 }), false);
  assert.equal(app.run('predatesFxFix')(null), false);

  /* Derived from `at`, which every entry has always carried — so entries
     written before the flag existed are classified correctly without a
     migration, which is the point of not storing it. */
  const old = { id: 'A|1', symbol: 'A', at: cut - 86400000, brief: {}, scores: { accrualsOnly: 90 } };
  const r = app.run('assessImport')(app.run('assessExport')([old]), []);
  assert.equal(r.add[0].scores.accrualsOnly, 90,
    'the stored score must survive a round trip unaltered');
  assert.equal(app.run('predatesFxFix')(r.add[0]), true);
});

// ── Assessment log export / import ──────────────────────────────────

const ENTRY = (id, over = {}) => ({
  id, symbol: id.split('|')[0], at: 1756598400000, brief: { board_says: 'x' },
  rating: 7, model: OPUS, ...over,
});

test('an export round-trips through import with nothing added or lost', () => {
  const entries = [ENTRY('AAA|1'), ENTRY('BBB|2'), ENTRY('CCC|3', { rating: null })];
  const file = app.run('assessExport')(entries, { origin: 'http://localhost:8080' });

  assert.equal(file.format, 'bolt.assessments', 'a named format, so import can refuse a stranger');
  assert.equal(file.v, 1, 'and a version, so a newer file can be refused rather than silently truncated');
  assert.equal(file.count, 3);

  // Through JSON, as it actually travels — a Map or a Set would not survive.
  const parsed = JSON.parse(JSON.stringify(file));
  const r = app.run('assessImport')(parsed, []);
  assert.equal(r.ok, true);
  assert.equal(r.add.length, 3);
  assert.equal(r.rated, 2, 'entries without a usable rating are counted apart — they add rows, not measurements');
  assert.equal(r.symbols, 3);
  assert.deepEqual([...r.add.map((e) => e.id)], ['AAA|1', 'BBB|2', 'CCC|3']);
});

/* An assessment is a dated observation, not a current value. An import that
   overwrote one would rewrite history from a file whose provenance nobody
   checked — and a genuine re-run gets a new timestamp, so it merges anyway. */
test('import is add-only: nothing already held is overwritten', () => {
  const held = [ENTRY('AAA|1', { rating: 2 })];
  const file = app.run('assessExport')([
    ENTRY('AAA|1', { rating: 9 }),        // same id, different content
    ENTRY('AAA|2', { rating: 9 }),        // a genuine re-run on the same symbol
  ]);
  const r = app.run('assessImport')(file, held);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, 1);
  assert.deepEqual([...r.add.map((e) => e.id)], ['AAA|2'],
    'the held id is skipped and the re-run is merged');
  assert.equal(held[0].rating, 2, 'and the held entry is untouched');

  // Duplicates WITHIN one file must not both be written either.
  const dup = app.run('assessImport')(
    app.run('assessExport')([ENTRY('ZZZ|9'), ENTRY('ZZZ|9')]), []);
  assert.equal(dup.add.length, 1);
  assert.equal(dup.duplicate, 1);
});

test('import refuses a file it cannot vouch for, rather than guessing', () => {
  const imp = app.run('assessImport');
  for (const [file, why] of [
    [null, 'null'],
    ['a string', 'a bare string'],
    [{ entries: [] }, 'no format marker'],
    [{ format: 'something.else', entries: [] }, 'another app\'s export'],
    [{ format: 'bolt.assessments', v: 1 }, 'no entries array'],
    [{ format: 'bolt.assessments', v: 99, entries: [] }, 'a version this build does not understand'],
  ]) {
    const r = imp(file, []);
    assert.equal(r.ok, false, `must refuse ${why}`);
    assert.ok(r.error && r.error.length > 10, `and say why it refused ${why}`);
  }

  /* A newer version is refused rather than partially read: this build would
     drop fields it does not know about on the next export, quietly shrinking
     a log the user believes they are round-tripping. */
  assert.match(imp({ format: 'bolt.assessments', v: 2, entries: [] }, []).error, /version 2/);
});

test('an entry that cannot be joined is dropped and counted, not written', () => {
  const file = app.run('assessExport')([
    ENTRY('OK|1'),
    { id: 'X|1', symbol: 'X', at: 1, brief: null },        // nothing to read
    { id: 'Y|1', symbol: 'Y', brief: { a: 1 } },           // undateable
    { id: 'Z|1', at: 1, brief: { a: 1 } },                 // unattributable
    { symbol: 'W', at: 1, brief: { a: 1 } },               // unkeyable
    null,
  ]);
  const r = app.run('assessImport')(file, []);
  assert.equal(r.ok, true, 'one bad entry must not reject the whole file');
  assert.deepEqual([...r.add.map((e) => e.id)], ['OK|1']);
  assert.equal(r.malformed, 5,
    'each is counted — silently writing them would grow the log without adding a measurement');
});

// ── Rating harness ──────────────────────────────────────────────────

const obs = (pairs, day = '2026-01-05') =>
  pairs.map(([rating, ret], i) => ({ rating, ret, excess: ret - 2, day, symbol: `S${i}` }));

/* Ties are the normal case, not an edge case: 41 ratings took six distinct
   values with 30 of them a 5 or a 6, so the tie rule decides the group sizes. */
test('the median split states its tie rule instead of tuning it', () => {
  const split = app.run('medianSplit');

  // The real distribution: 3x1, 4x2, 5x15, 6x15, 7x7, 8x1.
  const real = [3, 4, 4, ...Array(15).fill(5), ...Array(15).fill(6), ...Array(7).fill(7), 8];
  const s = split(real);
  assert.equal(s.median, 6, 'the 21st of 41 sorted values is a 6');
  assert.equal(s.nHigh, 23, '>= median is high: the fifteen 6s go up');
  assert.equal(s.nLow, 18);
  assert.ok(s.balance < 0.5 && s.balance > 0.4,
    'ties make an exactly even split impossible, and the imbalance is reported');

  // A degenerate split is refused rather than reported as n vs 0.
  assert.equal(split(Array(20).fill(5)), null,
    'every value identical is no split — 20 vs 0 would give a spread against an empty group');
  assert.equal(split([7]), null);
  assert.equal(split([]), null);

  // Even counts interpolate, and the high group still takes the median.
  assert.equal(split([1, 2, 3, 4]).median, 2.5);
  assert.equal(split([1, 2, 3, 4]).nHigh, 2);
});

/* Without the control the rating arm is uninterpretable: the rating correlates
   +0.71 with the canonical composite, so a spread that merely matches the
   board's is the rating measuring the board. */
test('the control splits the board over the identical observations', () => {
  const obs = (rating, overall, ret) => ({ rating, overall, ret, excess: ret - 1, day: 'd', symbol: `S${ret}` });

  /* Rating and Overall rank the names identically — which is close to what the
     +0.71 correlation implies — so the two arms must return the same spread. */
  const twin = [
    obs(4, 20, -10), obs(5, 30, -5), obs(7, 70, 12), obs(8, 90, 20),
  ];
  const st = app.run('ratingStats')(twin, 'raw');
  assert.ok(st.control.rating && st.control.board, 'both arms must compute');
  assert.equal(st.control.rating.value, st.control.board.value,
    'identical orderings must give identical spreads — a control measured differently is not a control');
  assert.equal(st.control.difference.value, 0);
  assert.equal(st.control.difference.beatsBoard, false);

  /* Now the case that would actually argue for the rating: it separates
     returns and Overall does not. */
  const better = [
    obs(4, 90, -20), obs(4, 70, -10), obs(8, 30, 10), obs(8, 20, 20),
  ];
  const st2 = app.run('ratingStats')(better, 'raw');
  assert.ok(st2.control.rating.value > 0, 'the rating separates them');
  assert.ok(st2.control.board.value < 0, 'Overall gets them backwards');
  assert.equal(st2.control.difference.beatsBoard, true);

  // The SE on the difference is flagged as an upper bound, not a test statistic.
  assert.ok(st2.control.difference.seUpperBound > 0);
  assert.ok(!('t' in st2.control.difference),
    'no t-ratio on the difference — the two arms share observations, so it would be wrong');
});

test('the control drops entries with no stored Overall without dropping them from the rating arm', () => {
  const obs = (rating, overall, ret) =>
    ({ rating, overall, ret, excess: ret, day: 'd', symbol: `S${rating}${ret}` });
  const mixed = [
    obs(4, null, -10), obs(5, null, -5),      // older entries, before Overall was stored
    obs(7, 70, 12), obs(8, 90, 20), obs(4, 20, -8), obs(5, 30, -2),
  ];
  const st = app.run('ratingStats')(mixed, 'raw');
  assert.equal(st.control.rating.nHigh + st.control.rating.nLow, 6,
    'the rating arm uses every observation');
  assert.equal(st.control.board.nHigh + st.control.board.nLow, 4,
    'the control uses only those that carry a board score');

  const none = app.run('ratingStats')([obs(4, null, -1), obs(8, null, 5)], 'raw');
  assert.equal(none.control.board, null, 'no board scores at all means no control, not a zero');
  assert.equal(none.control.difference, null);
});

test('the rating buckets partition 1-10 exactly once', () => {
  const buckets = app.run('RATING_BUCKETS');
  const covered = [];
  for (const b of buckets) for (let r = b.min; r <= b.max; r++) covered.push(r);
  assert.deepEqual(covered.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'every rating lands in exactly one bucket — a gap silently drops observations '
    + 'and an overlap counts them twice');

  /* The schema's value list and the buckets must be the same set, or the model
     can legally return a number that lands in no bucket. Such a row passes
     validation, counts toward `n`, and appears in none of the rows on screen —
     a discrepancy nothing in the display would reveal. */
  /* Spread into an array of THIS realm before comparing. `RATING_VALUES` is
     built inside the vm sandbox, so it carries the sandbox's Array.prototype
     and deepStrictEqual fails on identical contents. */
  assert.deepEqual([...app.run('RATING_VALUES')].sort((a, b) => a - b), covered,
    'the schema enum and the buckets must cover exactly the same values');
});

/* Defence behind the schema, for the cases the schema cannot cover: a model
   that ignores the enum, an entry written by an older version of this file, or
   a schema edited without this being updated. */
test('a rating outside the buckets is stored as absent, never as a number', () => {
  const ok = app.run('validRating');
  for (const good of app.run('RATING_VALUES')) assert.equal(ok(good), true);
  for (const bad of [0, 11, -1, 7.5, '7', null, undefined, NaN, Infinity]) {
    assert.equal(ok(bad), false, `${String(bad)} must not be accepted as a rating`);
  }

  /* And the harness must treat it as missing rather than counting it. An
     11 that reaches `n` but no bucket makes the totals disagree with the rows
     underneath them, which is the one failure mode nothing on screen shows. */
  const now = Date.parse('2026-08-31T00:00:00Z');
  const DAY = 86400000;
  const { byHorizon, skipped } = app.run('ratingObservations')(
    [{ symbol: 'A', rating: 11, at: now - 200 * DAY, priceAt: 100 },
      { symbol: 'B', rating: 7, at: now - 200 * DAY, priceAt: 100 }],
    () => 110, { now });
  assert.equal(byHorizon.get(1).length, 1, 'only the valid rating is measured');
  assert.equal(skipped.noRating, 1, 'and the invalid one is counted as unrated, not dropped silently');
});

/* The point of the whole view. A spread computed without its standard error is
   a number that will be believed. */
test('the spread carries the standard error OF THE DIFFERENCE, not of one end', () => {
  const st = app.run('ratingStats')(obs([
    [1, 0], [2, 10], [3, -10],       // bottom: mean 0
    [9, 20], [10, 30], [9, 10],      // top: mean 20
  ]));
  assert.equal(st.spread.value, 20);

  const top = st.buckets[3];
  const bottom = st.buckets[0];
  const expected = Math.sqrt(top.se ** 2 + bottom.se ** 2);
  assert.ok(Math.abs(st.spread.se - expected) < 1e-9,
    'sqrt(se_top^2 + se_bottom^2) — quoting one end alone understates it by up to sqrt(2), '
    + 'which is exactly the direction that flatters the result');
  assert.ok(st.spread.se > top.se, 'and the difference is always noisier than either end');

  /* The measured numbers say what this costs. Bucket sd here is 10 points; on
     this board the real six-month figure is 30.7, so three names a side gives
     SE ~25 and only a spread past ~50 points would clear it. This synthetic
     case is deliberately tamer than reality and still barely clears. */
  assert.ok(Math.abs(st.spread.se - 8.165) < 0.01);
  assert.equal(st.spread.insideNoise, false, 'a 20-point spread against SE 8.2 does clear 2 SE');

  /* The same 20-point spread with realistic within-bucket dispersion does NOT,
     which is the reading this view will actually produce for a long time. */
  const real = app.run('ratingStats')(obs([
    [1, -30], [2, 30], [3, 0],
    [9, -10], [10, 50], [9, 20],
  ]));
  assert.equal(real.spread.value, 20);
  assert.ok(real.spread.se > 15, 'sd of ~30 a side puts the SE past the spread itself');
  assert.equal(real.spread.insideNoise, true,
    'and the honest reading of a 20-point spread on six names is that it says nothing');
});

test('an empty end bucket makes the spread unmeasurable, not zero', () => {
  const st = app.run('ratingStats')(obs([[5, 10], [6, 12], [7, 30]]));
  assert.equal(st.spread, null,
    'no 9-10 observations means there is no top-minus-bottom to report — a 0 here '
    + 'would read as "no effect measured" rather than "nothing measured"');
  assert.equal(st.buckets[0].mean, null, 'and an empty bucket has no mean');
  assert.equal(st.buckets[0].se, null);
});

test('a single observation reports no dispersion rather than certainty', () => {
  const st = app.run('ratingStats')(obs([[1, -5], [10, 25]]));
  assert.equal(st.buckets[0].n, 1);
  assert.equal(st.buckets[0].sd, null, 'one point has no sd; 0 would read as certainty');
  assert.equal(st.buckets[0].se, null);
  assert.equal(st.spread.se, null, 'so the spread cannot claim an error either');
  assert.equal(st.spread.insideNoise, true, 'and an unmeasurable error is not a pass');
});

/* Twenty names assessed in one batch share one market window. `n` says 20 and
   the effective sample is nearer 1 — the same overlapping-window trap the
   backtest already warns about, arriving through a different door. */
test('the harness counts distinct assessment days, not just rows', () => {
  const same = app.run('ratingStats')(obs([[1, 0], [10, 20], [5, 5]], '2026-01-05'));
  assert.equal(same.n, 3);
  assert.equal(same.days, 1, 'three rows from one batch are one market window');

  const spread = app.run('ratingStats')([
    ...obs([[1, 0]], '2026-01-05'),
    ...obs([[10, 20]], '2026-03-05'),
    ...obs([[5, 5]], '2026-06-05'),
  ]);
  assert.equal(spread.days, 3);
});

test('rank correlation midranks ties and reports its own error', () => {
  const sp = app.run('spearman');

  const perfect = sp([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.equal(perfect.rho.toFixed(4), '1.0000');
  const inverse = sp([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  assert.equal(inverse.rho.toFixed(4), '-1.0000');

  /* Ties are the normal case here, not an edge case: ratings take ten values
     across what may be two dozen names. Naive ranking would order tied ratings
     by array position and invent a correlation out of input order. */
  const tied = sp([5, 5, 5, 5, 9, 9], [1, 2, 3, 4, 5, 6]);
  const shuffled = sp([5, 5, 5, 5, 9, 9], [4, 3, 2, 1, 5, 6]);
  assert.equal(tied.rho.toFixed(6), shuffled.rho.toFixed(6),
    'reordering within a tied group must not change rho');

  assert.equal(sp([7, 7, 7, 7], [1, 2, 3, 4]), null,
    'every rating identical is undefined, not zero — zero would read as "no relationship found"');
  assert.equal(sp([1, 2], [1, 2]), null, 'and two points is not a correlation');

  assert.ok(Math.abs(perfect.se - 0.5) < 1e-9, 'SE = 1/sqrt(n-1): rho=1.0 on n=5 is not a result');
});

/* An entry younger than the shortest horizon cannot be scored against anything,
   and an entry old enough for six months is also old enough for one and three.
   Discarding the shorter horizons to honour a single cutoff would throw away
   most of a sample that is already too small. */
test('each horizon gates itself on maturity, rather than one cutoff for all', () => {
  const DAY = 86400000;
  const now = Date.parse('2026-08-31T00:00:00Z');
  const closeAt = (sym, day) => (sym === app.run('BENCHMARK') ? 100 : 100 + day.length);

  const entry = (days, rating) => ({
    symbol: 'AAA', rating, at: now - days * DAY, priceAt: 100, model: OPUS,
  });

  const { byHorizon, skipped } = app.run('ratingObservations')(
    [entry(200, 8), entry(100, 3), entry(40, 5), entry(10, 9), { symbol: 'B', at: now - 200 * DAY }],
    closeAt, { now });

  assert.equal(byHorizon.get(1).length, 3, '200, 100 and 40 days old all have a 1-month return');
  assert.equal(byHorizon.get(3).length, 2, 'only 200 and 100 have three months behind them');
  assert.equal(byHorizon.get(6).length, 1, 'and only 200 has six');
  assert.equal(skipped.tooYoung, 1, 'the 10-day-old entry cannot be scored at all');
  assert.equal(skipped.preRating, 1, 'an entry logged before the field existed is not a failure');
  assert.equal(skipped.noRating, 0, 'and must not be counted as one');
});

/* An absent field and a refused one are different facts, and the log could not
   tell them apart: `v` stayed at 1 when the rating shipped, so two JAZZ entries
   written before the field existed were indistinguishable from entries whose
   rating had been dropped. The version field's whole job is to answer this. */
test('an entry from before the rating is distinguished from one that lost it', () => {
  const pre = app.run('predatesRating');
  const now = Date.parse('2026-08-31T00:00:00Z');
  const DAY = 86400000;

  assert.equal(pre({ v: 1, symbol: 'A', at: 1 }), true, 'v1 with no key predates the field');
  assert.equal(pre({ symbol: 'A', at: 1 }), true, 'a missing version is v1 by assumption');
  assert.equal(pre({ v: 2, symbol: 'A', at: 1, rating: null }), false,
    'v2 with a null rating was ASKED and refused — that is a fault, not a gap');
  assert.equal(pre({ v: 1, symbol: 'A', at: 1, rating: 7 }), false,
    'a rating that is present was obviously not missing, whatever the version says');
  assert.equal(pre(null), false);

  /* New entries must carry the bumped version, or the same ambiguity returns.
     Pinned to a literal on purpose: this assertion is meant to fail whenever
     the entry shape changes, so that the bump is a decision rather than an
     omission. 3 = `via`, added when provenance stopped being inferable.
     4 = the horizon split: callNear/callLong and entryLevel.
     5 = price anchors, the 1-sigma bound, and the provenance check:
     entryLevelUncited, entryLevelSigmas, and entryLevelBasis kept on refusal.
     6 = entryStance/entryStanceDeclared, splitting a null level into the four
     things it could have meant. */
  assert.equal(app.run('ASSESS_ENTRY_V'), 6);
  const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(/v: ASSESS_ENTRY_V/.test(src),
    'the entry must stamp the constant, not a literal that will go stale again');

  // The two are counted separately all the way through to the harness.
  const closeAt = () => 100;
  const { skipped } = app.run('ratingObservations')([
    { v: 1, symbol: 'A', at: now - 200 * DAY, priceAt: 100 },
    { v: 2, symbol: 'B', at: now - 200 * DAY, priceAt: 100, rating: null },
    { v: 2, symbol: 'C', at: now - 200 * DAY, priceAt: 100, rating: 99 },
  ], closeAt, { now });
  assert.equal(skipped.preRating, 1);
  assert.equal(skipped.noRating, 2, 'a null and an out-of-range rating are both faults');
});

test('the forward return uses the price the model was shown', () => {
  const DAY = 86400000;
  const now = Date.parse('2026-08-31T00:00:00Z');
  /* The series says 50 at every date — as it would after a 2-for-1 split
     back-adjusted the history. `priceAt` says 100, which is what the model
     actually saw. Using the series for the denominator would report a −50%
     return on a stock that did not move. */
  const closeAt = () => 50;
  const { byHorizon } = app.run('ratingObservations')(
    [{ symbol: 'AAA', rating: 7, at: now - 200 * DAY, priceAt: 100 }], closeAt, { now });
  const o = byHorizon.get(1)[0];
  assert.equal(o.ret, -50, 'the stored price is the denominator, not a re-derived one');
  assert.equal(o.excess, -50,
    'the benchmark did not move, so excess equals the raw return — the split artefact '
    + 'is in the stock alone and excess does not launder it away');
});

test('the log entry is joinable against future prices', () => {
  const band = app.run('coverageBand');
  assert.equal(band(0), 'none');
  assert.equal(band(2), 'thin');
  assert.equal(band(5), 'moderate');
  assert.equal(band(20), 'rich');

  /* The band is derived and may be re-cut later; the raw count is the record.
     An entry that stored only the band could not survive a threshold change. */
  assert.notEqual(band(2), band(5), 'the band must actually discriminate');
});

// ── Cohort eligibility ──────────────────────────────────────────────

test('cohort eligibility works with no EDGAR data at all', () => {
  const bad = app.run('cohortIneligible');

  /* The point of the second rule. `state.sec.gone` is only written by
     secResolve, which needs the proxy — on a page served without one it is
     empty forever, and a rule keyed only on it would silently do nothing. */
  assert.equal(app.state.sec.gone.length, 0, 'this sandbox has no EDGAR data, as intended');
  assert.match(bad({ symbol: 'DEAD', pxNote: 'no current quote' }), /no current market data/,
    'a dead name must be caught from cached price state alone');
  assert.match(bad({ symbol: 'DEAD', pxNote: 'price history stops at 2026-08-04' }), /no current market data/,
    'including one that is only days stale rather than months');
  assert.equal(bad({ symbol: 'LIVE', pxNote: null }), null);

  // And the EDGAR rule still wins when the data does exist.
  const seeded = loadApp({ 'bar.sec': JSON.stringify({ at: Date.now(), cik: {}, gone: ['GONE'] }) });
  assert.match(seeded.run('cohortIneligible')({ symbol: 'GONE', pxNote: null }),
    /no longer an SEC registrant/);
});

test('an ineligible row is both uncounted and unscored, for every cross-sectional score', () => {
  const cross = app.allScores().filter((s) => s.crossSectional);
  assert.ok(cross.length >= 2, 'more than one cross-sectional score must exist for this to mean anything');

  /* Each row gets its OWN series, with volatility varying across the set. An
     identical series for every row makes every volScore identical, which puts
     the whole cohort on the wrong side of momscreen's decile cut and excludes
     everyone — a fixture artefact, not a finding. */
  const seriesFor = (k) => Array.from({ length: 300 },
    (_, i) => 100 * (1 + 0.0012 * i) * (1 + (0.002 + 0.0004 * k) * Math.sin(i / 3)));
  const tech = (k) => app.technicalsFor({ f: '2024-01-01', t: '2026-01-01', c: seriesFor(k) });

  // 60 live rows, then 20 dead ones placed at the bottom of the analyst range.
  const live = Array.from({ length: 60 }, (_, i) => ({
    symbol: `L${i}`, ...tech(i), composite: 3.5 + i * 0.01, pxNote: null,
  }));
  const dead = Array.from({ length: 20 }, (_, i) => ({
    symbol: `D${i}`, ...tech(i), composite: 2.5 + i * 0.01, pxNote: 'no current quote',
  }));

  const rows = [...dead, ...live];
  app.applyCrossSectionalScores(rows);

  for (const s of cross) {
    for (const d of dead) {
      assert.equal(d[s.field], null,
        `${s.id} scored a row with no current market data (${d.symbol})`);
    }
    assert.ok(live.some((l) => l[s.field] != null),
      `${s.id} must still score the eligible rows`);
  }

  /* Uncounted as well as unscored. With 20 dead rows admitted to the cohort the
     live rows would be ranked against 80 names instead of 60, which moves every
     one of their percentiles. */
  const top = live[live.length - 1];
  assert.ok(top.analystPct > 99,
    `the best live name should sit at the top of a 60-name cohort, got ${top.analystPct}`);
});

/* A hole in a price series invalidates price-derived factors and says nothing
   about analyst consensus. Nothing on the board currently trips this, so the
   test is the only thing holding the distinction in place. */
test('a price-series gap gates the price scores only, not the analyst percentile', () => {
  const bad = app.run('cohortIneligible');
  const byId = Object.fromEntries(app.allScores().map((s) => [s.id, s]));
  const gapped = { symbol: 'GAPPY', pxGap: '3 bars missing', pxNote: '3 bars missing' };

  assert.equal(bad(gapped), null,
    'a gap is not a universal exclusion, so the header count must not claim it is');
  assert.equal(bad(gapped, byId.analyst), null,
    'the analyst percentile reads no prices and must not care about a price gap');

  for (const id of ['zblend', 'momscreen']) {
    assert.match(bad(gapped, byId[id]), /missing bars/,
      `${id} is price-derived and must exclude a gapped series`);
  }

  /* The distinction has to survive the gap also setting pxNote, which it does:
     a gapped row would otherwise be caught by the market-data rule and excluded
     from everything, which is the behaviour being removed here. */
  assert.equal(bad({ symbol: 'X', pxNote: 'no current quote', pxGap: null }, byId.analyst),
    'no current market data', 'a genuine market-data fault still excludes everywhere');
});

test('the gap separation survives a real cohort pass', () => {
  const seriesFor = (k) => Array.from({ length: 300 },
    (_, i) => 100 * (1 + 0.0012 * i) * (1 + (0.002 + 0.0004 * k) * Math.sin(i / 3)));
  const tech = (k) => app.technicalsFor({ f: '2024-01-01', t: '2026-01-01', c: seriesFor(k) });

  const rows = Array.from({ length: 60 }, (_, i) => ({
    symbol: `S${i}`, ...tech(i), composite: 3.5 + i * 0.01, pxNote: null, pxGap: null,
  }));
  // One row with a gap, otherwise perfectly healthy.
  rows[0].pxGap = '3 bars missing';
  rows[0].pxNote = '3 bars missing';

  app.applyCrossSectionalScores(rows);

  assert.notEqual(rows[0].analystPct, null,
    'the gapped row keeps its analyst percentile — its consensus data is intact');
  assert.equal(rows[0].zBlendScore, null, 'but loses the price-derived cross-sectional scores');
  assert.equal(rows[0].momScreenScore, null);

  assert.ok(rows.slice(1).every((r) => r.analystPct != null), 'everyone else is unaffected');
});

test('removing the cohort padding moves the bottom, not the top', () => {
  const cohort = app.run('analystPercentileCohort');
  const mk = (n, lo, hi) => Array.from({ length: n }, (_, i) => ({ composite: lo + (hi - lo) * (i / (n - 1)) }));

  const live = mk(561, 2.60, 4.229);
  const dead = mk(14, 2.53, 2.59);
  const all = [...dead, ...live];

  const before = cohort(all.map(() => ({})), all);
  const after = cohort(live.map(() => ({})), live);

  // Index of the best live name in each run.
  const topBefore = before[all.length - 1];
  const topAfter = after[live.length - 1];
  assert.ok(Math.abs(topAfter - topBefore) < 0.05,
    `the top of the board must barely move, got ${(topAfter - topBefore).toFixed(3)}`);

  const bottomBefore = before[dead.length];      // worst LIVE name
  const bottomAfter = after[0];
  assert.ok(bottomAfter < bottomBefore - 2,
    `the bottom is where the padding was, expected a drop over 2 pts, got ${(bottomAfter - bottomBefore).toFixed(3)}`);

  /* Direction matters and is counter-intuitive: dropping names from BELOW you
     lowers your percentile, because you are a smaller fraction of the way up a
     shorter list. Nothing goes up. */
  for (let i = 0; i < live.length; i++) {
    assert.ok(after[i] <= before[dead.length + i] + 1e-9,
      'no live name may gain percentile when names below it are removed');
  }
});

// ── EDGAR resolution of the universe ────────────────────────────────

test('an EDGAR ticker alias never changes the symbol the board trades on', () => {
  const alias = app.run('SEC_TICKER_ALIAS');
  const secTicker = app.run('secTicker');

  assert.equal(secTicker('BRK.B'), 'BRK-B', 'SEC writes class shares with a dash');
  assert.equal(secTicker('AAPL'), 'AAPL', 'anything without an alias passes through');

  /* The alias is applied only when talking to EDGAR. The universe's own ticker
     is what Finnhub and Polygon answer to, so renaming it there would trade a
     failed EDGAR lookup for a broken price feed. */
  const universe = app.run('DEFAULT_WATCHLIST');
  for (const from of Object.keys(alias)) {
    assert.ok(universe.includes(from),
      `${from} must still be the universe's own ticker, not rewritten to its EDGAR spelling`);
    assert.ok(!universe.includes(alias[from]),
      `${alias[from]} is EDGAR's spelling and must not appear in the universe`);
  }
});

/* The trap this whole check nearly walked into. BRK.B failed EDGAR lookup on a
   single character while trading normally with a full 500 bars and ranked #1 on
   Low vol. Treating "absent from company_tickers.json" as "delisted" without
   the alias would have marked the board's best low-volatility name as dead. */
test('a punctuation mismatch is not a delisting', () => {
  const secTicker = app.run('secTicker');
  const alias = app.run('SEC_TICKER_ALIAS');
  assert.equal(alias['BRK.B'], 'BRK-B');
  assert.notEqual(secTicker('BRK.B'), 'BRK.B',
    'BRK.B must be translated before lookup, not reported as missing');
});

test('the registry survives a boot with no proxy behind it', () => {
  const gone = ['ALTR', 'DFS', 'HES'];
  const seeded = loadApp({
    'bar.sec': JSON.stringify({ at: Date.now(), cik: { AAPL: 320193 }, gone }),
  });
  assert.deepEqual(plain(seeded.state.sec.gone), gone,
    'the last good answer must survive a load that cannot reach EDGAR');
  assert.equal(seeded.run('notRegistered')('ALTR'), true);
  assert.equal(seeded.run('notRegistered')('AAPL'), false);

  // Garbage, and absence, both fall back to "nothing known" rather than throwing.
  for (const bad of ['not json', '{}', 'null', '{"at":"soon"}']) {
    const s = loadApp({ 'bar.sec': bad });
    assert.deepEqual(plain(s.state.sec.gone), [], `"${bad}" must degrade to an empty registry`);
    assert.equal(s.run('notRegistered')('ALTR'), false,
      'an unreadable registry must not mark anything delisted');
  }
});

test('a delisting is reported as the cause, ahead of its symptoms', () => {
  const seeded = loadApp({ 'bar.sec': JSON.stringify({ at: Date.now(), cik: {}, gone: ['ALTR'] }) });
  const why = seeded.run('priceUnusableReason');

  /* A delisted name has no quote either, so both tests would fire. The one that
     names the company rather than the missing field has to win, or the board
     says a quote is missing when what is missing is the issuer. */
  assert.match(why({ symbol: 'ALTR', price: null }, null, null), /no longer an SEC registrant/);
  assert.match(why({ symbol: 'LIVE', price: null }, null, null), /no current quote/);
  assert.equal(why({ symbol: 'LIVE', price: 10 }, { c: [1], t: '2026-08-28' }, '2026-08-28'), null);
});

/* Which score speaks for a domain is a named choice, not an accident of array
   order — reordering `scores` must not silently change what Overall means. */
test('the canonical score is named, not positional', () => {
  for (const d of app.SCORE_DOMAINS) {
    assert.equal(typeof d.overallScore, 'string', `${d.id} must declare overallScore`);
    const canon = app.canonicalScore(d);
    assert.equal(canon.id, d.overallScore);
    assert.ok(d.scores.some((s) => s.id === canon.id), 'and it must be one of its own scores');
  }
  assert.equal(app.canonicalScore(app.SCORE_DOMAINS.find((d) => d.id === 'technicals')).id, 'mom12');
});

/* Two bugs of the same shape, both found on 2026-09-01, both silent.

   `renderBoardMeta` counted `r.longScore` / `r.shortScore` to report how many
   names had scored. Those fields went away in the 2026-08-31 restructure, so
   `!= null` was false every time and the meta line read "0 scored long · 0
   short" on every render. A wrong count just renders; nothing throws.

   `renderBacktest` looked a tab's tooltip up with `SCORE_DOMAINS.find((x) =>
   x.field === field)`. `field` belongs to a SCORE — no domain has ever carried
   one — so the lookup returned undefined for all seven tabs and every one of
   them showed the generic Combined blurb.

   Both are the rule in docs/NOTES.md: anything that asks about a score must ask the
   registry. These pin the two properties that were violated. */
test('the board meta counts names that actually scored', () => {
  const tech = app.SCORE_DOMAINS.find((d) => d.id === 'technicals');
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.3);
  const scored = app.technicalsFor({ f: '2024-01-01', t: '2026-01-01', c: closes });

  // Three names that scored, one that could not.
  const rows = [{ ...scored }, { ...scored }, { ...scored }, {}];
  const note = app.coverageNote(tech, rows);

  assert.match(note, /^3 scored /, `counted the wrong number of scored names: ${note}`);
  assert.ok(!/\b0 scored/.test(note),
    'a field name left over from a retired score reads as "0 scored" and never throws');
  assert.ok(!/&[a-zA-Z]+;/.test(note), `the meta line is textContent, so it must carry no entities: ${note}`);

  assert.equal(app.coverageNote(tech, []), app.coverageNote(tech, [{}]),
    'an unscored row and no row at all are both zero');
});

test('every backtest tab describes its own score, not Combined', () => {
  const combined = app.backtestTabTitle('combinedScore');

  for (const field of app.SCORE_FIELDS) {
    if (field === 'combinedScore') continue;   // apparatus, deliberately not a score
    const title = app.backtestTabTitle(field);
    const s = app.allScores().find((x) => x.field === field);

    assert.notEqual(title, combined,
      `${field} falls through to the Combined blurb instead of describing itself`);
    assert.ok(title.includes(s.status), `${field} must show its own status`);
    assert.ok(!/&[a-zA-Z]+;/.test(title), `${field} title carries a raw entity: ${title}`);
  }

  // The lookup must be by score. No domain has ever carried a `field`.
  for (const d of app.SCORE_DOMAINS) {
    assert.equal(d.field, undefined,
      'a domain must not carry `field` — that is what made the bad lookup look plausible');
  }
});

/* Registry labels carry HTML entities for typography (`Mom&nbsp;12&minus;1`).
   Passing one through esc() escapes its ampersand, and the browser then prints
   the entity instead of the character — which is what the backtest tabs, the
   filter panel and the snapshot stats all did. plainLabel decodes first. */
test('a score label survives escaping without showing its entities', () => {
  const esc = app.run('esc');
  const plainLabel = app.run('plainLabel');

  for (const s of app.allScores()) {
    const rendered = esc(plainLabel(s.label));
    assert.ok(!/&amp;[a-zA-Z]+;/.test(rendered),
      `${s.id} renders a literal entity: ${rendered}`);
    assert.ok(!/&[a-zA-Z]+;/.test(plainLabel(s.label)),
      `${s.id} has an entity plainLabel does not know: ${s.label}`);
  }

  /* The decoding is real, not just entity-stripping: the expected string holds
     an actual U+00A0 and U+2212, so `&nbsp;` stays non-breaking rather than
     collapsing to an ordinary space. */
  assert.equal(plainLabel('Mom&nbsp;12&minus;1'), 'Mom 12−1');
  assert.equal(plainLabel('Blend'), 'Blend', 'a label with no entities is untouched');
});

test('a domain naming a score it does not own fails loudly', () => {
  const fake = { id: 'bogus', overallScore: 'nope', scores: [{ id: 'real' }] };
  assert.throws(() => app.canonicalScore(fake), /not one of its scores/);
});

test('weights are renormalised over the domains that scored the symbol', () => {
  // All three present: a third each.
  const all = app.overallFor({ mom12Only: 80, accrualsOnly: 60, analystPct: 50 });
  assert.equal(all.parts.length, 3);
  for (const p of all.parts) assert.ok(Math.abs(p.share - 1 / 3) < 1e-9);

  /* Two of three: the pair splits the whole weight rather than each keeping a
     third and the total silently coming to two thirds. */
  const two = app.overallFor({ mom12Only: 80, analystPct: 50 });
  assert.deepEqual(plain(two.parts.map((p) => p.share)), [0.5, 0.5]);
  assert.equal(two.of, 3, 'and the breakdown reports three domains were possible');

  const one = app.overallFor({ analystPct: 100 });
  assert.equal(one.parts.length, 1);
  assert.equal(one.parts[0].share, 1, 'the surviving domain carries the whole weight');
  assert.equal(one.value, 100);
  assert.equal(one.of, 3);
});

test('each Overall part exposes its contribution and its weight', () => {
  const o = app.overallFor({ mom12Only: 90, analystPct: 75 });
  for (const p of o.parts) {
    assert.equal(typeof p.raw, 'number');
    assert.equal(typeof p.norm, 'number');
    assert.equal(typeof p.weight, 'number');
    assert.equal(typeof p.share, 'number');
    assert.ok(p.domain && p.score, 'and names the domain and the score it came from');
  }
  // Long 90 → 90; Analyst 4 of 1–5 → 75. Even weights → 82.5.
  assert.equal(o.value, 82.5);
});

/* The whole reason for normalising: Analyst is 1–5 and Long is 0–100. Averaging
   the raw numbers would make the 1–5 domain almost invisible and the ranking
   would quietly be the 0–100 one. */
test('each domain is normalised onto 0–100 by its own scale', () => {
  assert.equal(app.normaliseScore(0, { min: 0, max: 100 }), 0);
  assert.equal(app.normaliseScore(100, { min: 0, max: 100 }), 100);
  assert.equal(app.normaliseScore(1, { min: 1, max: 5 }), 0, 'the bottom of the analyst scale');
  assert.equal(app.normaliseScore(5, { min: 1, max: 5 }), 100, 'the top of it');
  assert.equal(app.normaliseScore(3, { min: 1, max: 5 }), 50);
  assert.equal(app.normaliseScore(null, { min: 0, max: 100 }), null);
});

test('Overall is the mean of the normalised contributions', () => {
  // Mom 80 → 80; Analyst 50 → 50. Two of three present, so the mean is 65.
  const o = app.overallFor({ mom12Only: 80, analystPct: 50, shortScore: 0 });
  assert.equal(o.value, 65);
  assert.equal(o.parts.length, 2);
  assert.equal(o.of, 3);

  // With Fundamentals present too: 80, 60, 50 → 63.33.
  const all = app.overallFor({ mom12Only: 80, accrualsOnly: 60, analystPct: 50 });
  assert.ok(Math.abs(all.value - 190 / 3) < 1e-9, `expected 63.33, got ${all.value}`);
  assert.equal(all.of, 3);
});

test('a failed score cannot move Overall', () => {
  const a = app.overallFor({ mom12Only: 80, analystPct: 50, shortScore: 0 });
  const b = app.overallFor({ mom12Only: 80, analystPct: 50, shortScore: 100 });
  assert.equal(a.value, b.value, 'Short swinging 0 to 100 must change nothing');
});

test('Overall falls back to the domains that did score, and says how many', () => {
  const o = app.overallFor({ mom12Only: null, analystPct: 100 });
  assert.equal(o.value, 100, 'scored on analyst alone');
  assert.equal(o.parts.length, 1);
  assert.equal(o.of, 3, 'and reports that one of three domains contributed');

  /* The count is what stops a one-domain 100 reading like a three-domain 100.
     Fundamentals has the widest coverage of the three, so it is often the one
     still standing when the others are absent. */
  assert.equal(app.overallFor({ accrualsOnly: 90 }).parts.length, 1);
  assert.equal(app.overallFor({ accrualsOnly: 90 }).of, 3);
});

test('Overall is null when nothing scored the symbol', () => {
  assert.equal(app.overallFor({}).value, null);
});

test('each Overall contribution carries its status for display', () => {
  const o = app.overallFor({ mom12Only: 80, analystPct: 50 });
  assert.deepEqual(
    plain(o.parts.map((p) => [p.score.domain.label, p.score.status])),
    [['Technicals', 'external'], ['Analyst', 'external']],
  );
});

// ── Sections and detail tabs ────────────────────────────────────────

test('Overall leads the sections and is not a domain', () => {
  assert.deepEqual(plain(app.sectionIds()), ['overall', 'technicals', 'fundamentals', 'analyst']);
  assert.ok(!app.SCORE_DOMAINS.some((d) => d.id === app.OVERALL));
});

/* Overall is the cross-domain summary: its own number plus one column per
   CONTRIBUTING domain, so you can see the score and what fed it. A failed score
   fed nothing, so it is not here. */
test('Overall shows its score and each contributing domain, and nothing else', () => {
  const cols = app.boardColumns('overall').filter((c) => c.key);
  assert.deepEqual(plain(cols.map((c) => c.key)),
    ['symbol', 'name', 'price', 'changePct', 'overall', 'mom12Only', 'accrualsOnly', 'analystPct']);

  /* Every column here fed the number, so none carries the "not counted" mark.
     The mark exists for a domain flagged out of Overall; with none flagged out
     it must not appear, or it would label a contributor as excluded. */
  assert.ok(cols.every((c) => !c.notCounted),
    'nothing is marked "not counted" while every registered domain contributes');

  const keys = cols.map((c) => c.key);
  assert.ok(!keys.includes('shortScore'), 'a failed score fed nothing, so it is not shown');
  assert.ok(!keys.includes('rsi14'), "Overall shows scores, not a domain's workings");
  assert.ok(!keys.includes('earnYieldOnly'),
    'one column per domain — the canonical score, not all four');
});

/* Holds the marking machinery rather than an instance of it. A domain flagged
   out of Overall is invisible in the Overall chip by construction — the chip
   lists contributions — so it needs both a marked column and a detail strip.
   Nothing is flagged out today; the next domain to arrive will be. */
test('a domain flagged out of Overall is shown and marked, not hidden', () => {
  const sandbox = loadApp();
  sandbox.run(`SCORE_DOMAINS.find((d) => d.id === 'fundamentals').inOverall = false;`);

  const cols = sandbox.boardColumns('overall').filter((c) => c.key);
  const aside = cols.filter((c) => c.notCounted).map((c) => c.key);
  assert.deepEqual(plain(aside), ['accrualsOnly'],
    'the left-out domain still gets a column, marked');
  assert.ok(!cols.filter((c) => !c.notCounted).map((c) => c.key).includes('accrualsOnly'),
    'and is never counted among the contributors');

  const html = sandbox.run('registeredNotCountedHTML')({
    symbol: 'X', earnYieldOnly: 71.2, bookToMktOnly: 40, roeOnly: 55, accrualsOnly: 62.5,
  });
  assert.match(html, /not in Overall/, 'the strip must say plainly that it is not counted');
  assert.match(html, /62\.5/, 'and carry the actual readings');
  assert.match(sandbox.run('registeredNotCountedHTML')({ symbol: 'Y' }), /no reading/);

  // With nothing flagged out — the shipped state — the strip renders nothing.
  assert.equal(app.run('registeredNotCountedHTML')({ symbol: 'X', accrualsOnly: 60 }), '',
    'no strip when every domain contributes');
});

/* Each domain tab is the standalone view it was before the registry: its own
   scores, its own workings, nothing from a neighbour. */
test('a domain section shows only its own data', () => {
  const tech = app.boardColumns('technicals').filter((c) => c.key).map((c) => c.key);
  assert.deepEqual(plain(tech), [
    'symbol', 'name', 'price', 'changePct',
    // one column per registered factor…
    'mom12Only', 'blendScore', 'zBlendScore', 'momBandScore', 'momScreenScore',
    'mom6Only', 'lowVolOnly', 'supportOnly',
    // …then the raw readings, including the three demoted to display only
    'mom12m1m', 'mom6m1m', 'realisedVol', 'maxDD', 'srDist',
    'maGap', 'rsi14', 'rangePos', 'bars',
  ]);

  const analyst = app.boardColumns('analyst').filter((c) => c.key).map((c) => c.key);
  assert.deepEqual(plain(analyst), [
    'symbol', 'name', 'price', 'changePct',
    'analystPct', 'composite', 'movedSince', 'raw', 'momentum', 'coverageChange', 'upside', 'insiderNet', 'analysts',
  ]);

  for (const k of ['blendScore', 'lowVolOnly', 'rsi14', 'bars']) {
    assert.ok(!analyst.includes(k), `the Analyst tab must not show ${k}`);
  }
  for (const k of ['analystPct', 'composite', 'analysts', 'upside']) {
    assert.ok(!tech.includes(k), `the Technicals tab must not show ${k}`);
  }
  assert.ok(!tech.includes('overall') && !analyst.includes('overall'),
    'Overall belongs to its own tab');
});

/* Header and cells are built from one list, so a column cannot render a heading
   with nothing under it. */
test('every data column declares how to draw its cell', () => {
  for (const section of app.sectionIds()) {
    for (const col of app.dataColumns(section)) {
      assert.equal(typeof col.cell, 'function',
        `${section}: column ${col.key || col.label} has no cell renderer`);
    }
  }
});

test('clicking from Overall opens Technicals; from a section, that section', () => {
  assert.equal(app.detailTabFor('overall'), 'technicals');
  assert.equal(app.detailTabFor('technicals'), 'technicals');
  assert.equal(app.detailTabFor('analyst'), 'analyst');
  assert.equal(app.defaultDetailTab(), 'technicals');
});

test('every domain declares a detail view', () => {
  for (const d of app.SCORE_DOMAINS) {
    assert.equal(typeof d.detail, 'function', `${d.id} must declare its own detail view`);
  }
});

/* Status and data availability are separate gates. The analyst domain is
   untested — which permits a tab — but nothing stores what it scored in the
   past, so it must not get one anyway. */
test('a domain with no point-in-time data gets no backtest tab', () => {
  const analyst = app.SCORE_DOMAINS.find((d) => d.id === 'analyst');
  assert.equal(analyst.pointInTime, false);
  assert.ok(!app.SCORE_FIELDS.includes('composite'));
});

test('a failed score still renders a column', () => {
  const failed = withFailedScore('support');
  const col = failed.boardColumns('technicals').find((c) => c.key === 'supportOnly');
  assert.ok(col, 'the column is shown — seeing the number is how you notice a change');
  assert.equal(col.unsortable, true, 'but it is a reading, not a control');
});

test('the default sort never lands on a failed score', () => {
  assert.equal(app.defaultSortFor('technicals').by, 'mom12Only');
  assert.equal(app.defaultSortFor('analyst').by, 'analystPct');

  // With the canonical score demoted, the default must move to a live one.
  const failed = withFailedScore('mom12');
  assert.notEqual(failed.defaultSortFor('technicals').by, 'mom12Only',
    'a failed score cannot be the default sort');
});

/* Loading with an EMPTY localStorage is a weaker check than it looks, and this
   test exists because that gap shipped a blank page on 2026-09-01.

   `normalizeSort` short-circuits on a missing saved sort — `if (!sort || ...)`
   — so a fresh load never walks loadSort → sortKeysFor → boardColumns →
   dataColumns → scoreColumn. Every helper reached only through that chain is
   therefore untested at load time. A `const` declared below scoreColumn is fine
   for a first-time visitor and fatal for a returning one, whose saved sort
   forces the chain and hits the constant's temporal dead zone.

   That is exactly what happened: `plainLabel` was defined ~2000 lines below its
   first use, all 118 tests passed, and the real page rendered nothing at all —
   no board, no tabs, an empty dropdown — because the script died mid-evaluation.
   `clamp` carries a note about the same trap for the same reason.

   So load the app the way a returning user has it. Any load-time error — TDZ or
   otherwise — throws out of loadApp and fails here. */
test('the app loads for a returning user, not just a fresh one', () => {
  const returning = loadApp({
    'bar.boardMode': 'technicals',
    'bar.sort': JSON.stringify({
      overall: { by: 'overall', dir: 'desc' },
      technicals: { by: 'mom12Only', dir: 'desc' },
      analyst: { by: 'analystPct', dir: 'desc' },
    }),
    'bar.filters': JSON.stringify({ mom12: { on: true, min: 60 } }),
  });

  assert.equal(returning.state.boardMode, 'technicals');
  assert.equal(returning.state.sort.technicals.by, 'mom12Only',
    'a saved sort must survive the load that validates it');
  assert.equal(returning.state.filters.mom12.on, true);

  /* The board must actually be buildable — sortKeysFor is the chain that dies,
     so call it rather than trusting that construction alone proved it. */
  for (const id of returning.sectionIds()) {
    assert.ok(returning.sortKeysFor(id).length, `${id} must offer something to sort by`);
  }

  // And a saved sort naming a field that no longer exists still falls back.
  const stale = loadApp({ 'bar.sort': JSON.stringify({ technicals: { by: 'longScore', dir: 'desc' } }) });
  assert.equal(stale.state.sort.technicals.by, 'mom12Only',
    'a retired field in a saved sort must fall back, not stick');
});

// ── Filters ─────────────────────────────────────────────────────────

/** Set the filter state directly, bypassing localStorage.

    Keyed by SCORE id, not domain id — filters are per score, and Technicals
    owns two. Iterating domains here silently wrote keys nothing reads and left
    the real ones set from the previous test. */
function setFilters(spec) {
  for (const s of app.allScores()) {
    app.state.filters[s.id] = { on: false, min: s.filterDefault };
  }
  for (const [id, cfg] of Object.entries(spec)) {
    assert.ok(app.state.filters[id], `no score with id "${id}"`);
    Object.assign(app.state.filters[id], cfg);
  }
}

test('no active filter passes everything', () => {
  setFilters({});
  assert.equal(app.passesFilters({ mom12Only: 1, analystPct: 1 }), true);
  assert.equal(app.passesFilters({}), true, 'an unscored row is not excluded by a filter nobody set');
});

test('filters intersect — a symbol must clear every active threshold', () => {
  setFilters({ mom12: { on: true, min: 60 }, analyst: { on: true, min: 80 } });
  assert.equal(app.passesFilters({ mom12Only: 70, analystPct: 92 }), true);
  assert.equal(app.passesFilters({ mom12Only: 70, analystPct: 71 }), false, 'fails analyst');
  assert.equal(app.passesFilters({ mom12Only: 55, analystPct: 92 }), false, 'fails momentum');
});

/* "No score" is not "passes". A symbol an active domain cannot score has not
   cleared its bar, and treating a blank as a pass would quietly admit exactly
   the names the filter exists to exclude. */
test('an unscored symbol fails an active filter rather than passing it', () => {
  setFilters({ mom12: { on: true, min: 60 } });
  assert.equal(app.passesFilters({ mom12Only: null, analystPct: 100 }), false);
  assert.equal(app.passesFilters({ analystPct: 100 }), false);
});

test('a threshold on an inactive domain is not consulted', () => {
  setFilters({ mom12: { on: false, min: 99 } });
  assert.equal(app.passesFilters({ mom12Only: 1 }), true);
});

/* Boot with filters already stored. The default path never touches `clamp`,
   because an absent value short-circuits to the domain default — so a fresh
   sandbox loaded app.js happily while a browser with a saved threshold died on
   "Cannot access 'clamp' before initialization". Seeding the store is what
   makes the initialisation order actually get exercised. */
test('a persisted filter loads, and an out-of-range one is clamped', () => {
  const seeded = loadApp({
    'bar.filters': JSON.stringify({
      mom12: { on: true, min: 999 },     // above the 0–100 scale
      analyst: { on: true, min: -5 },    // below the 0–100 scale
      support: { on: true, min: 80 },
    }),
  });

  assert.equal(seeded.state.filters.mom12.min, 100, 'clamped to the top of its scale');
  assert.equal(seeded.state.filters.mom12.on, true);
  assert.equal(seeded.state.filters.analyst.min, 0, 'clamped to the bottom of its scale');

  /* Nothing ships failed, so demote one and reload the filters to prove a
     stored `on` cannot resurrect it. */
  seeded.run(`allScores().find((s) => s.id === 'support').status = STATUS.FAILED;
              state.filters = loadFilters();`);
  assert.equal(seeded.state.filters.support.on, false,
    'a failed score cannot be switched on from storage');
});

test('a garbled stored filter falls back to the default rather than NaN', () => {
  const seeded = loadApp({ 'bar.filters': '{"mom12":{"on":true,"min":"banana"}}' });
  const mom12 = seeded.allScores().find((s) => s.id === 'mom12');
  assert.equal(seeded.state.filters.mom12.min, mom12.filterDefault);
});

/* Filtering is cross-domain, so it belongs to the one cross-domain view. A
   technical threshold quietly removing rows from the Analyst tab made that tab
   misreport its own coverage. */
test('filters apply on Overall and nowhere else', () => {
  setFilters({ mom12: { on: true, min: 99 } });
  const row = { mom12Only: 1, composite: 5 };

  app.state.boardMode = 'overall';
  assert.equal(app.filtersApply(), true);
  assert.equal(app.rowPassesActiveFilters(row), false, 'excluded on Overall');

  for (const section of ['technicals', 'fundamentals', 'analyst']) {
    app.state.boardMode = section;
    assert.equal(app.filtersApply(), false, `${section} does not filter`);
    assert.equal(app.rowPassesActiveFilters(row), true,
      `${section} shows every symbol it can score`);
  }
  app.state.boardMode = 'overall';
});

// ── Sector cap ──────────────────────────────────────────────────────

/** Entries whose symbols map to known sectors, for cap tests. */
const sectorPairs = (spec) => spec.map(([symbol, score], i) => ({ symbol, score, ret: i }));

test('the cap keeps the highest-scoring N per sector', () => {
  // Real universe symbols, so sectorOf resolves. AAPL/MSFT/NVDA/AMD are all
  // Information Technology; JPM/BAC are Financials.
  const entries = sectorPairs([
    ['AAPL', 90], ['MSFT', 80], ['NVDA', 70], ['AMD', 60], ['JPM', 50], ['BAC', 40],
  ]);
  const kept = app.capPerSector(entries, 3).map((e) => e.symbol).sort();
  assert.deepEqual(plain(kept), ['AAPL', 'BAC', 'JPM', 'MSFT', 'NVDA'],
    'three best tech names plus both financials');
  assert.ok(!kept.includes('AMD'), 'the fourth tech name is capped out');
});

test('a cap of zero or less is off', () => {
  const entries = sectorPairs([['AAPL', 90], ['MSFT', 80], ['NVDA', 70], ['AMD', 60]]);
  assert.equal(app.capPerSector(entries, 0).length, 4);
  assert.equal(app.capPerSector(entries, null).length, 4);
});

/* The cap applies to a bucket, not to the universe, so it cannot move a name
   from one bucket to another — only drop it from the one it was already in. */
test('the cap trims buckets without reassigning anything', () => {
  const entries = sectorPairs([
    ['AAPL', 99], ['MSFT', 98], ['NVDA', 97], ['AMD', 96], ['ORCL', 95],
  ]);
  const uncapped = app.quintileBuckets(entries);
  const capped = app.quintileBuckets(entries, 3);
  assert.equal(uncapped.reduce((n, b) => n + b.returns.length, 0), 5);
  // One name per fifth here, so a 3-per-sector cap removes nothing.
  assert.equal(capped.reduce((n, b) => n + b.returns.length, 0), 5);

  // All five in one band, though, and the cap bites.
  const band = app.bandBuckets(entries, 3);
  const top = band.find((b) => b.label === '80 – 100');
  assert.equal(top.returns.length, 3, 'capped to three of one sector');
  assert.equal(top.capped, 2, 'and reports what it dropped');
});

test('the cap reports how many it removed', () => {
  const entries = sectorPairs([['AAPL', 99], ['MSFT', 98], ['NVDA', 97], ['AMD', 96]]);
  const uncapped = app.bandBuckets(entries, 0).find((b) => b.label === '80 – 100');
  assert.equal(uncapped.capped, 0);
});

// ── Section controls ────────────────────────────────────────────────

/* A control that filters on one domain's data belongs to that domain's section.
   Coverage is an analyst-domain fact, so a thinly covered name is no reason to
   hide a row from Technicals, which has no opinion about analysts, or from
   Overall, which filters through the filter panel instead. */
test('a section control appears only in its own domain section', () => {
  app.state.boardMode = 'analyst';
  assert.deepEqual(plain(app.sectionControls().map((c) => c.id)), ['minAnalysts']);

  for (const section of ['overall', 'technicals']) {
    app.state.boardMode = section;
    assert.deepEqual(plain(app.sectionControls().map((c) => c.id)), [],
      `${section} must not carry an analyst-domain control`);
  }
  app.state.boardMode = 'overall';
});

test('a section control excludes rows only in its own section', () => {
  app.state.controls.minAnalysts = 10;
  const thin = { analysts: 3, composite: 5, mom12Only: 90 };
  const covered = { analysts: 40, composite: 5, mom12Only: 90 };

  app.state.boardMode = 'analyst';
  assert.equal(app.passesSectionControls(thin), false, 'excluded on Analyst');
  assert.equal(app.passesSectionControls(covered), true);

  for (const section of ['overall', 'technicals']) {
    app.state.boardMode = section;
    assert.equal(app.passesSectionControls(thin), true,
      `${section} has no opinion on analyst coverage`);
  }
  app.state.boardMode = 'overall';
});

test('a control set to zero excludes nothing', () => {
  app.state.boardMode = 'analyst';
  app.state.controls.minAnalysts = 0;
  assert.equal(app.passesSectionControls({ analysts: 0 }), true);
  assert.equal(app.passesSectionControls({}), true, 'and an unknown count is not excluded');
  app.state.controls.minAnalysts = 10;
  app.state.boardMode = 'overall';
});

test('every declared control can be rendered and applied', () => {
  for (const c of app.allControls()) {
    for (const k of ['id', 'label', 'title']) {
      assert.equal(typeof c[k], 'string', `control ${c.id} needs a ${k}`);
    }
    for (const k of ['active', 'passes', 'describe']) {
      assert.equal(typeof c[k], 'function', `control ${c.id} needs ${k}()`);
    }
    assert.ok(c.min <= c.default && c.default <= c.max, `${c.id}: default outside its range`);
    assert.ok(c.domain, `${c.id} must know which section it belongs to`);
  }
});

test('the legacy min-analysts value migrates into the controls store', () => {
  const seeded = loadApp({ 'bar.minAnalysts': '25' });
  assert.equal(seeded.state.controls.minAnalysts, 25);
});

test('a garbled or out-of-range control value falls back sanely', () => {
  assert.equal(loadApp({ 'bar.controls': '{"minAnalysts":"banana"}' })
    .state.controls.minAnalysts, 10, 'falls back to the default');
  assert.equal(loadApp({ 'bar.controls': '{"minAnalysts":999}' })
    .state.controls.minAnalysts, 99, 'clamped to the declared maximum');
});

test('a failed score cannot be filtered on, however it got switched on', () => {
  const failed = withFailedScore('support');
  failed.run('state.filters.support = { on: true, min: 90 };');

  // activeFilters is the gate: it only ever yields filterable scores.
  assert.ok(!failed.activeFilters().some((s) => s.id === 'support'),
    'a failed score never reaches the active list');
  assert.equal(failed.passesFilters({ supportOnly: 10 }), true, 'a failed score has no veto');
});

test('a symbol with no forward window is skipped, not measured over less time', () => {
  const series = new Map([
    ['ZZSTOP', { f: '2024-01-01', t: '2025-06-15', c: rising(400) }],
  ]);
  // Exit falls past the last stored bar.
  const run = runBacktest(series, '2025-06-01', 3);

  assert.equal(run.all.length, 0);
  assert.equal(run.skipped.noForward, 1);
});

test('a symbol whose history begins after the start date is skipped', () => {
  const series = new Map([
    ['ZZLATE', { f: '2025-09-01', t: '2025-12-31', c: rising(80) }],
  ]);
  const run = runBacktest(series, '2025-06-01', 3);

  assert.equal(run.all.length, 0);
  assert.equal(run.skipped.tooEarly, 1);
});

// ── needsPrices: what the widened window re-asks for ─────────────────

/** Put one series in the store and ask whether it needs a call. */
function needs(series) {
  app.state.px.series = new Map(series ? [['ZZNEED', series]] : []);
  return app.needsPrices('ZZNEED');
}

const FLOOR = () => app.pxFloorDay();
const fresh = () => Date.now();

test('an unstored symbol needs prices', () => {
  assert.equal(needs(null), true);
});

test('a migrated series with no bf is picked up once', () => {
  // Everything stored under the old two-year window arrives without `bf`.
  assert.equal(needs({ f: '2024-01-01', t: '2026-01-01', c: [1, 2], at: fresh() }), true);
});

test('a series never asked back to the floor is picked up', () => {
  const short = app.shiftDay(FLOOR(), 30); // asked from a month after the floor
  assert.equal(needs({ f: short, t: '2026-01-01', c: [1, 2], at: fresh(), bf: short }), true);
});

/* The regression the `bf` field exists to prevent. A symbol listed well after
   the ten-year floor will never have bars back to it, so testing the oldest
   bar held would mark it short on every pass, forever, at one Polygon call a
   time. What settles the question is what was ASKED for. */
test('a symbol listed after the floor is not re-asked forever', () => {
  const series = {
    f: '2023-04-01',          // no bars anywhere near the floor
    t: '2026-01-01',
    c: [1, 2],
    at: fresh(),
    bf: app.shiftDay(FLOOR(), -5),  // but the floor was requested
  };
  assert.equal(needs(series), false);
});

test('a fully covered but stale series is refreshed', () => {
  const series = {
    f: '2016-01-01', t: '2026-01-01', c: [1, 2],
    at: Date.now() - 48 * 60 * 60 * 1000,
    bf: app.shiftDay(FLOOR(), -5),
  };
  assert.equal(needs(series), true);
});

// ── dayAtIndex ──────────────────────────────────────────────────────

test('dayAtIndex interpolates between the first and last bar', () => {
  const series = { f: '2020-01-01', t: '2020-01-11', c: rising(11) };
  assert.equal(app.dayAtIndex(series, 0), '2020-01-01');
  assert.equal(app.dayAtIndex(series, 10), '2020-01-11');
  assert.equal(app.dayAtIndex(series, 5), '2020-01-06');
});

test('dayAtIndex falls back to f rather than inventing a date', () => {
  assert.equal(app.dayAtIndex({ f: '2020-01-01', t: '2020-01-01', c: [1] }, 0), '2020-01-01');
});

// ── fetchRange: the merge ───────────────────────────────────────────

/** Run one fetchRange against a stubbed response and read back what was stored. */
async function fetched(existing, page, [from, to, side]) {
  app.state.px.series = new Map(existing ? [['ZZMRG', existing]] : []);
  const stub = stubPolygon(page);
  await app.fetchRange('ZZMRG', from, to, side);
  return { stored: app.state.px.series.get('ZZMRG'), urls: stub.urls() };
}

test('a cold fetch becomes the whole series', async () => {
  const { stored } = await fetched(
    null, polygonBars('2020-01-01', [10, 11, 12]), ['2020-01-01', '2020-01-03', null]);

  assert.deepEqual(plain(stored.c), [10, 11, 12]);
  assert.equal(stored.f, '2020-01-01');
  assert.equal(stored.t, '2020-01-03');
  assert.equal(stored.bf, '2020-01-01', 'bf records the oldest date requested');
});

test('older bars are prepended and move f back, leaving t alone', async () => {
  const existing = { f: '2020-01-04', t: '2020-01-06', c: [20, 21, 22], at: 1, bf: '2020-01-04' };
  const { stored } = await fetched(
    existing, polygonBars('2020-01-01', [10, 11, 12]), ['2020-01-01', '2020-01-03', 'before']);

  assert.deepEqual(plain(stored.c), [10, 11, 12, 20, 21, 22]);
  assert.equal(stored.f, '2020-01-01');
  assert.equal(stored.t, '2020-01-06', 'a backward extension must not touch the newest bar');
  assert.equal(stored.bf, '2020-01-01');
});

test('newer bars are appended and move t forward, leaving f and bf alone', async () => {
  const existing = { f: '2020-01-01', t: '2020-01-03', c: [10, 11, 12], at: 1, bf: '2019-06-01' };
  const { stored } = await fetched(
    existing, polygonBars('2020-01-04', [20, 21]), ['2020-01-04', '2020-01-05', 'after']);

  assert.deepEqual(plain(stored.c), [10, 11, 12, 20, 21]);
  assert.equal(stored.f, '2020-01-01');
  assert.equal(stored.t, '2020-01-05');
  assert.equal(stored.bf, '2019-06-01', 'a forward fetch must not narrow the requested floor');
});

/* Truncation keeps the newest bars. On a prepend that means the incoming head
   is what gets trimmed — trimming the tail instead would discard the bars the
   call was made for. */
test('a prepend past the cap trims the incoming head and dates f from what survives', async () => {
  const cap = app.PX_MAX_BARS;
  const existing = {
    f: '2021-01-01', t: '2021-06-01', c: rising(cap - 2), at: 1, bf: '2021-01-01',
  };
  const { stored } = await fetched(
    existing, polygonBars('2020-01-01', [1, 2, 3, 4, 5]), ['2020-01-01', '2020-01-05', 'before']);

  assert.equal(stored.c.length, cap, 'the series must not grow past the cap');
  assert.deepEqual(plain(stored.c.slice(0, 2)), [4, 5], 'the newest of the incoming bars survive');
  assert.equal(stored.f, '2020-01-04', 'f is the real date of the oldest surviving bar');
});

/* A bar whose close is unusable is dropped. Reading the date off the raw
   response while the closes came from a separately filtered array would shift
   every date by one position. */
test('dropping an unusable bar does not shift the dates', async () => {
  const page = polygonBars('2020-01-01', [null, 11, 12]);
  const { stored } = await fetched(null, page, ['2020-01-01', '2020-01-03', null]);

  assert.deepEqual(plain(stored.c), [11, 12]);
  assert.equal(stored.f, '2020-01-02', 'f is the first bar actually kept, not the first returned');
});

test('an empty older window stamps the series instead of destroying it', async () => {
  const existing = { f: '2023-01-01', t: '2023-06-01', c: [10, 11], at: 1, bf: '2023-01-01' };
  const { stored } = await fetched(existing, { results: [] }, ['2016-01-01', '2022-12-31', 'before']);

  assert.deepEqual(plain(stored.c), [10, 11], 'the stored bars survive an empty response');
  assert.equal(stored.bf, '2016-01-01', 'the window was asked for, so record it and stop asking');
  assert.ok(stored.at > 1);
});

// ── Intraday extremes: capture, alignment, and the stamp ─────────────

/* The extremes were always in the response and were being discarded. The one
   property that must hold through every merge path is that index i of c, h and
   l is the same bar — so each of these asserts alignment, not just presence. */

test('a cold fetch keeps the extremes the response always carried', async () => {
  const { stored } = await fetched(null, polygonOHLC('2020-01-01', [
    { c: 10, h: 11, l: 9 }, { c: 11, h: 12, l: 10 }, { c: 12, h: 13, l: 11 },
  ]), ['2020-01-01', '2020-01-03', null]);

  assert.deepEqual(plain(stored.c), [10, 11, 12]);
  assert.deepEqual(plain(stored.h), [11, 12, 13]);
  assert.deepEqual(plain(stored.l), [9, 10, 11]);
  assert.equal(stored.lf, '2020-01-01', 'the stamp names the first bar with extremes');
});

test('appending to a close-only series pads the old bars rather than misaligning', async () => {
  // The shape every stored series has today: closes, no extremes.
  const existing = { f: '2020-01-01', t: '2020-01-03', c: [10, 11, 12], at: 1, bf: '2020-01-01' };
  const { stored } = await fetched(existing, polygonOHLC('2020-01-04', [
    { c: 20, h: 21, l: 19 }, { c: 21, h: 22, l: 20 },
  ]), ['2020-01-04', '2020-01-05', 'after']);

  assert.deepEqual(plain(stored.c), [10, 11, 12, 20, 21]);
  assert.deepEqual(plain(stored.h), [null, null, null, 21, 22]);
  assert.deepEqual(plain(stored.l), [null, null, null, 19, 20],
    'the old bars keep nulls so index i is the same bar in all three arrays');
  assert.equal(stored.c.length, stored.l.length);
  assert.equal(stored.lf, '2020-01-04', 'and the stamp moves to where the extremes start');
});

test('prepending extremes to a close-only series aligns at the front', async () => {
  const existing = { f: '2020-01-04', t: '2020-01-06', c: [20, 21, 22], at: 1, bf: '2020-01-04' };
  const { stored } = await fetched(existing, polygonOHLC('2020-01-01', [
    { c: 10, h: 11, l: 9 }, { c: 11, h: 12, l: 10 }, { c: 12, h: 13, l: 11 },
  ]), ['2020-01-01', '2020-01-03', 'before']);

  assert.deepEqual(plain(stored.c), [10, 11, 12, 20, 21, 22]);
  assert.deepEqual(plain(stored.l), [9, 10, 11, null, null, null]);
  /* THE HOLE IS NOW IN THE MIDDLE-TO-END, which is exactly the arrangement a
     tail-aligned array with an offset gets wrong. */
  assert.equal(stored.lf, '2020-01-01');
});

test('a dropped bar shifts neither the dates nor the extremes', async () => {
  const { stored } = await fetched(null, polygonOHLC('2020-01-01', [
    { c: null, h: 99, l: 98 },        // unusable close: the whole bar goes
    { c: 11, h: 12, l: 10 },
    { c: 12, h: 13, l: 11 },
  ]), ['2020-01-01', '2020-01-03', null]);

  assert.deepEqual(plain(stored.c), [11, 12]);
  assert.deepEqual(plain(stored.l), [10, 11], 'the surviving bars keep THEIR own lows');
  assert.equal(stored.f, '2020-01-02');
});

/* A low above its own close is a broken bar. Dropping the whole bar would
   shift every date after it; keeping the close and voiding the extremes loses
   the least. */
test('an incoherent bar loses its extremes and keeps its close', async () => {
  const { stored } = await fetched(null, polygonOHLC('2020-01-01', [
    { c: 10, h: 11, l: 9 },
    { c: 11, h: 12, l: 15 },          // low above the close
    { c: 12, h: 9, l: 8 },            // high below the close
    { c: 13, h: 14, l: 12 },
  ]), ['2020-01-01', '2020-01-04', null]);

  assert.deepEqual(plain(stored.c), [10, 11, 12, 13], 'every close survives');
  assert.deepEqual(plain(stored.l), [9, null, null, 12]);
  assert.deepEqual(plain(stored.h), [11, null, null, 14]);
});

test('a series written before capture has no stamp, and is not pretended otherwise', async () => {
  const { stored } = await fetched(
    null, polygonBars('2020-01-01', [10, 11, 12]), ['2020-01-01', '2020-01-03', null]);
  assert.deepEqual(plain(stored.l), [null, null, null]);
  assert.equal(stored.lf, null, 'no extremes means no stamp, not a stamp of the first day');
});

// ── The stamp is readable, not merely stored ─────────────────────────

test('a factor can say which regime its window came from', () => {
  const cov = app.run('intradayCoverage');
  const B = app.run('PX_BASIS');
  const S = (l) => ({ f: '2020-01-01', t: '2020-01-05', c: [1, 2, 3, 4, 5], l });

  assert.equal(cov(S(null), 5).basis, B.CLOSES, 'no array at all');
  assert.equal(cov(S([null, null, null, null, null]), 5).basis, B.CLOSES);
  assert.equal(cov(S([1, 2, 3, 4, 5]), 5).basis, B.INTRADAY);

  const mixed = cov(S([null, null, 3, 4, 5]), 5);
  assert.equal(mixed.basis, B.MIXED, 'the case a boolean cannot express');
  assert.equal(mixed.known, 3);
  assert.equal(mixed.bars, 5);
  assert.equal(mixed.from, '2020-01-03', 'and it names where the regime changes');

  /* The window is the question, not the series. The same series is wholly
     intraday over its last three bars and mixed over all five. */
  assert.equal(cov(S([null, null, 3, 4, 5]), 3).basis, B.INTRADAY);
  assert.equal(cov({ c: [] }, 5).basis, B.NONE);
});

test('a wrong-length extremes array is discarded, never trusted', () => {
  const pad = app.run('paddedIntraday');
  const out = pad({ c: [1, 2, 3], l: [9, 9], h: [1, 2, 3] });
  assert.deepEqual(plain(out.l), [null, null, null],
    'a misaligned low is worse than an absent one');
  assert.deepEqual(plain(out.h), [1, 2, 3], 'a correctly sized one survives');
});

// ── Drawdown: the bias this was for ──────────────────────────────────

test('drawdown reads deeper from intraday extremes than from closes', () => {
  const dd = app.run('maxDrawdown');
  const c = [100, 90, 100];
  const h = [110, 90, 100];
  const l = [100, 80, 100];

  const closeOnly = dd(c, 3);
  const intraday = dd(c, 3, l, h);
  assert.equal(closeOnly.toFixed(2), '10.00', 'peak 100 to trough 90');
  assert.equal(intraday.toFixed(2), '27.27', 'peak HIGH 110 to trough LOW 80');
  assert.ok(intraday > closeOnly,
    'close-to-close is understated, and always in this direction');
});

test('a bar with no extremes falls back to its own close, not to a guess', () => {
  const dd = app.run('maxDrawdown');
  const c = [100, 90, 100];
  // The middle bar is from before capture; the outer two are not.
  const mixed = dd(c, 3, [100, null, 100], [110, null, 100]);
  assert.equal(mixed.toFixed(2), '18.18', 'peak HIGH 110 to the middle bar’s CLOSE 90');
  assert.ok(mixed > dd(c, 3) && mixed < dd(c, 3, [100, 80, 100], [110, 90, 100]),
    'a mixed window lands between the two pure readings — which is why it is named');
});

test('the row carries the basis, so a copied row does not lose it', () => {
  const B = app.run('PX_BASIS');
  const W = app.run('DD_WINDOW');
  const mk = (l) => ({ f: '2020-01-01', t: '2024-01-01', c: rising(W), l });

  assert.equal(app.technicalsFor(mk(null)).ddBasis, B.CLOSES);
  assert.equal(app.technicalsFor(mk(rising(W))).ddBasis, B.INTRADAY);

  const half = rising(W).map((v, i) => (i < W / 2 ? null : v));
  const row = app.technicalsFor(mk(half));
  assert.equal(row.ddBasis, B.MIXED);
  assert.equal(row.ddCoverage.known, W / 2, 'and the coverage travels with the number');

  // Too short to have a drawdown at all: absent, not close-to-close.
  assert.equal(app.technicalsFor({ f: 'a', t: 'b', c: [1, 2] }).ddBasis, B.NONE);
});

// ── Entry fills now use the low ──────────────────────────────────────

test('a level the stock traded through counts as filled, even closing above', () => {
  const at = Date.parse('2026-01-01T00:00:00Z');
  const entry = {
    v: 4, symbol: 'AAA', at, priceAt: 100, callNear: 6,
    entryLevel: 90, entryLevelBasis: 'support at 90', entryLevelRejected: null,
  };
  // Closes never reach 90; the low on the 20th does.
  const bars = [
    { day: '2026-01-15', close: 95, low: 94 },
    { day: '2026-01-20', close: 93, low: 89 },
    { day: '2026-01-25', close: 92, low: 91 },
  ];
  const { rows } = app.run('entryLevelOutcomes')(
    [entry], () => bars, () => 120, { now: Date.parse('2026-06-01T00:00:00Z') });

  const m1 = rows.find((r) => r.months === 1);
  assert.equal(m1.reached, true, 'a limit order at 90 would have filled on the low');
  assert.equal(m1.reachedOn, '2026-01-20');
  assert.equal(m1.fillBasis, app.run('PX_BASIS').INTRADAY);
  /* The fill is at the LEVEL, not at the low: a limit at 90 fills at 90. */
  assert.equal(m1.retFromLevel.toFixed(2), (120 / 90 * 100 - 100).toFixed(2));
});

test('a window without lows says so, and still uses closes', () => {
  const at = Date.parse('2026-01-01T00:00:00Z');
  const entry = {
    v: 4, symbol: 'AAA', at, priceAt: 100, callNear: 6,
    entryLevel: 90, entryLevelBasis: 'support at 90', entryLevelRejected: null,
  };
  const bars = [
    { day: '2026-01-15', close: 95, low: null },
    { day: '2026-01-20', close: 93, low: null },
  ];
  const { rows } = app.run('entryLevelOutcomes')(
    [entry], () => bars, () => 120, { now: Date.parse('2026-06-01T00:00:00Z') });

  const m1 = rows.find((r) => r.months === 1);
  assert.equal(m1.reached, false, 'no close reached 90, and no low was known');
  assert.equal(m1.fillBasis, app.run('PX_BASIS').CLOSES,
    'so the verdict is the weak one and must say so');
});

// ── fetchSeries: only what is missing ────────────────────────────────

test('a stored series short at the old end is extended backwards, then forwards', async () => {
  const today = app.isoDay(Date.now());
  const existing = {
    f: '2024-01-01', t: app.shiftDay(today, -3), c: [10, 11], at: 1,
    // No bf: the shape a migrated series arrives in.
  };
  app.state.px.series = new Map([['ZZBOTH', existing]]);
  const stub = stubPolygon(
    polygonBars('2016-01-04', [1, 2]),      // the backward gap
    polygonBars(app.shiftDay(today, -2), [30, 31]),  // the forward gap
  );
  await app.fetchSeries('ZZBOTH');

  const urls = stub.urls();
  assert.equal(urls.length, 2, 'one call per gap, and no more');
  assert.ok(urls[0].includes(`/${app.pxFloorDay()}/`), 'the older gap is asked for first');
  assert.ok(urls[0].includes('/2023-12-31'), 'the older gap stops the day before the stored first bar');

  const stored = app.state.px.series.get('ZZBOTH');
  assert.deepEqual(plain(stored.c), [1, 2, 10, 11, 30, 31]);
  assert.equal(stored.bf, app.pxFloorDay());
});

/* Polygon's free plan serves two years and answers 403 NOT_AUTHORIZED for a
   window older than that. The backward extension asks for exactly such a
   window, so every migrated symbol hit it — and because the error was flattened
   to 400 the run failed all 579 one at a time instead of learning once. */
test('a 403 on the older window is learned once, not re-asked per symbol', async () => {
  const today = app.isoDay(Date.now());
  const existing = { f: '2024-08-30', t: today, c: [10, 11], at: 1 };
  app.state.px.series = new Map([['ZZOLD', { ...existing }], ['ZZTWO', { ...existing }]]);
  app.state.px.historyLimited = null;

  app.run(`
    globalThis.__asked = [];
    getFrom = async (id, path) => {
      __asked.push(path);
      const err = new Error("Polygon: Your plan doesn't include this data timeframe.");
      err.status = 403;
      throw err;
    };
    writeSeries = async (symbol, series) => { state.px.series.set(symbol, series); };
  `);

  await app.fetchSeries('ZZOLD');
  await app.fetchSeries('ZZTWO');

  assert.equal(app.run('__asked').length, 1,
    'the second symbol must not spend a call on a limit already discovered');
  assert.match(String(app.state.px.historyLimited), /timeframe/);

  for (const sym of ['ZZOLD', 'ZZTWO']) {
    const s = app.state.px.series.get(sym);
    assert.equal(s.bf, app.pxFloorDay(), `${sym} should record the floor as requested`);
    assert.deepEqual(plain(s.c), [10, 11], `${sym} must keep the bars it already had`);
  }

  // And once stamped, neither symbol queues for another attempt.
  assert.equal(app.needsPrices('ZZOLD'), false);
});

test('a 403 on the older window does not stop the forward fetch', async () => {
  const today = app.isoDay(Date.now());
  app.state.px.series = new Map([['ZZFWD', {
    f: '2024-08-30', t: app.shiftDay(today, -2), c: [10, 11], at: 1,
  }]]);
  app.state.px.historyLimited = null;

  app.run(`
    globalThis.__asked = [];
    globalThis.__pages = [];
    getFrom = async (id, path) => {
      __asked.push(path);
      if (__asked.length === 1) {
        const err = new Error('Polygon: plan does not include this timeframe.');
        err.status = 403;
        throw err;
      }
      return __pages.shift() || { results: [] };
    };
    writeSeries = async (symbol, series) => { state.px.series.set(symbol, series); };
  `);
  app.run('__pages').push(polygonBars(app.shiftDay(today, -1), [30]));

  await app.fetchSeries('ZZFWD');

  assert.equal(app.run('__asked').length, 2, 'the newer window is still worth asking for');
  const s = app.state.px.series.get('ZZFWD');
  assert.deepEqual(plain(s.c), [10, 11, 30], 'the new bar landed despite the older window failing');
});

/* A non-403 must still propagate: a rate limit or a network drop is temporary,
   and swallowing it would silently mark the symbol as fully extended. */
test('a non-403 failure on the older window still throws', async () => {
  app.state.px.series = new Map([['ZZERR', { f: '2024-08-30', t: '2026-08-28', c: [10], at: 1 }]]);
  app.state.px.historyLimited = null;
  app.run(`
    getFrom = async () => { const e = new Error('Polygon: Rate limited.'); e.status = 429; throw e; };
    writeSeries = async (symbol, series) => { state.px.series.set(symbol, series); };
  `);

  await assert.rejects(() => app.fetchSeries('ZZERR'), /Rate limited/);
  assert.equal(app.state.px.historyLimited, null, 'a rate limit is not a plan limit');
  assert.equal(app.state.px.series.get('ZZERR').bf, undefined,
    'a temporary failure must not record the floor as answered');
});

test('a fully covered, up-to-date series costs no calls', async () => {
  const today = app.isoDay(Date.now());
  app.state.px.series = new Map([['ZZDONE', {
    f: '2016-01-04', t: today, c: [10, 11], at: 1, bf: app.pxFloorDay(),
  }]]);
  const stub = stubPolygon();
  await app.fetchSeries('ZZDONE');

  assert.deepEqual(stub.urls(), [], 'nothing was missing, so nothing was asked for');
});

/* ── Quote freshness ─────────────────────────────────────────────────
   Refresh was clearing only the in-memory response cache, so the durable
   per-symbol entries stayed inside their 24h TTL and no /quote call went out.
   The horizon is a parameter now, and both Refresh and boot pass
   PRICE_STALE_MS; the 24h default is what the store keeps, not what a load
   settles for. */

test('the quote horizon is a parameter, not the fixed 24h store TTL', () => {
  const now = Date.now();
  const app = loadApp({
    'bar.t.TEST1': JSON.stringify({
      at: now - 3 * 60 * 60 * 1000,          // three hours ago
      q: [10, 0, 0, 10, 10, 10, 10],
      tAt: now,
      t: [['2026-08-01', 1, 1, 1, 0, 0]],
    }),
  });

  assert.equal(app.run("cacheState('TEST1').quoteFresh"), true,
    'inside the 24h store TTL, which is the default horizon');
  assert.equal(app.run("cacheState('TEST1', PRICE_STALE_MS).quoteFresh"), false,
    'past PRICE_STALE_MS, so Refresh must refetch it');
  assert.equal(app.run("loadFromCache('TEST1', PRICE_STALE_MS)"), false,
    'and it must not short-circuit in pass 1');
  assert.equal(app.run("pendingCallsFor('TEST1', PRICE_STALE_MS)") >= 1, true,
    'the ETA must count the quote call it is about to make');
});

test('a quote-only refetch preserves a legacy trend fetch time', async () => {
  const now = Date.now();
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  const app = loadApp({
    // Written before `tAt` existed: `at` is the trend's fetch time too.
    'bar.t.TEST2': JSON.stringify({
      at: now - twoDays,
      q: [10, 0, 0, 10, 10, 10, 10],
      t: [['2026-08-01', 1, 1, 1, 0, 0]],
    }),
  });

  app.run(`
    get = async (path) => (path === '/quote'
      ? { c: 11, d: 1, dp: 10, o: 10, h: 11, l: 10, pc: 10 }
      : []);
  `);

  // Quote is two days old, trend is two days old against a 7-day TTL: the
  // quote is refetched on its own, which is exactly when `at` moves and the
  // trend's only timestamp would move with it.
  await app.run("fetchSymbol('TEST2')");

  const entry = JSON.parse(app.run("localStorage.getItem('bar.t.TEST2')"));
  assert.equal(entry.at >= now, true, 'the quote timestamp advanced');
  assert.equal(entry.tAt, now - twoDays,
    'the trend kept its real fetch time instead of being pinned fresh');
});

/* ── The daily change comes from one quote response ──────────────────
   `c` and `pc` are two slots of the same `q` array, written whole by
   encodeQuote from a single /quote body and read back whole by decodeEntry.
   These tests fail if that pairing is ever broken — if a refetch could leave a
   new price beside a previous close from an earlier fetch, or update one
   without the other. */

test('a quote refetch moves price and prevClose together', async () => {
  const now = Date.now();
  const app = loadApp({
    'bar.t.TEST3': JSON.stringify({
      at: now - 26 * 60 * 60 * 1000,        // quote stale, trend fresh
      q: [10, 1, 11.11, 9, 10, 9, 9],       // fetch #1: c = 10, pc = 9
      tAt: now,
      t: [['2026-08-01', 5, 3, 2, 0, 0]],
    }),
  });

  app.run(`
    get = async (path) => (path === '/quote'
      ? { c: 11, d: 1, dp: 10, o: 10, h: 11, l: 10, pc: 10 }   // fetch #2
      : []);
  `);
  await app.run("fetchSymbol('TEST3')");

  const q = JSON.parse(app.run("localStorage.getItem('bar.t.TEST3')")).q;
  assert.equal(q[0], 11, 'the price is fetch #2');
  assert.equal(q[6], 10,
    'and so is the previous close — 9 here would mean the pair was split across fetches');
});

test('a trend-only refetch leaves the price/prevClose pair untouched', async () => {
  const now = Date.now();
  const app = loadApp({
    'bar.t.TEST4': JSON.stringify({
      at: now,                                 // quote fresh
      q: [10, 1, 11.11, 9, 10, 9, 9],
      tAt: now - 8 * 24 * 60 * 60 * 1000,      // trend stale, 7-day TTL
      t: [['2026-08-01', 5, 3, 2, 0, 0]],
    }),
  });

  app.run(`
    get = async (path) => {
      if (path === '/quote') throw new Error('the quote was fresh — it must not be refetched');
      return [];
    };
  `);
  await app.run("fetchSymbol('TEST4')");

  const q = JSON.parse(app.run("localStorage.getItem('bar.t.TEST4')")).q;
  assert.deepEqual([q[0], q[6]], [10, 9],
    'neither half moved: the pair updates together or not at all');
});

/* ── A stale entry is drawn, not dropped ─────────────────────────────
   loadFromCache answers two questions now: "is there something to render"
   and "does anything still need fetching". Collapsing them into one early
   return meant a Refresh emptied the board for the length of the refetch. */

test('a stale quote still renders a row instead of being dropped', () => {
  const now = Date.now();
  const threeHours = 3 * 60 * 60 * 1000;
  const app = loadApp({
    'bar.t.TEST6': JSON.stringify({
      at: now - threeHours,                    // past PRICE_STALE_MS
      q: [10, 1, 11.11, 9, 10.5, 9, 9],
      tAt: now,
      t: [['2026-08-01', 5, 3, 2, 0, 0]],
      ptAt: now, pt: [12, 14, 10],
      inAt: now, inV: 2, in: [0, 0, 0, 0],
    }),
  });

  assert.equal(app.run("loadFromCache('TEST6', PRICE_STALE_MS)"), false,
    'the quote is past PRICE_STALE_MS, so the symbol still needs a refetch');
  assert.equal(app.run('state.rows.size'), 1,
    'but it is on the board rather than dropped while that refetch runs');
  assert.equal(app.run("state.rows.get('TEST6').price"), 10,
    'showing the cached price');
  assert.equal(app.run(`Date.now() - state.rows.get('TEST6').fetchedAt > PRICE_STALE_MS`), true,
    'carrying an age that commonCellsHTML greys out, so it reads as old, not current');
});

test('an entry with no usable trend is still not rendered', () => {
  const app = loadApp({
    'bar.t.TEST7': JSON.stringify({ at: Date.now(), q: [10, 1, 11.11, 9, 10.5, 9, 9] }),
  });

  assert.equal(app.run("loadFromCache('TEST7', PRICE_STALE_MS)"), false);
  assert.equal(app.run('state.rows.size'), 0,
    'no analyst coverage means there is genuinely nothing to draw');
});

test('the fetch queue keeps every symbol when there is no board to measure', () => {
  const app = loadApp();
  const queue = [...app.run("prioritiseOnScreen(['TEST1', 'TEST2', 'TEST3'])")];

  assert.deepEqual(queue, ['TEST1', 'TEST2', 'TEST3'],
    'with no rendered rows the given order stands, and nothing is lost');
});

/* Six rendered rows 100px tall, in a 250px window scrolled to the third.
   TEST3 and TEST4 are fully visible and TEST5 is cut off by the bottom edge;
   TEST1 and TEST2 have scrolled past the top. TEST9 needs fetching but the
   filters keep it off the board, so it has no row to measure. */
test('the fetch queue puts the rows on screen first', () => {
  const app = loadApp();
  app.run(`
    innerHeight = 250;
    document = {
      querySelector: () => null,
      addEventListener() {},
      querySelectorAll: () => ['TEST1', 'TEST2', 'TEST3', 'TEST4', 'TEST5', 'TEST6']
        .map((symbol, i) => ({
          dataset: { symbol },
          getBoundingClientRect: () => ({ top: i * 100 - 200, bottom: i * 100 - 100 }),
        })),
    };
  `);

  // Handed to it worst-first, to prove the board's order is what comes back.
  const queue = [...app.run(
    "prioritiseOnScreen(['TEST6', 'TEST5', 'TEST4', 'TEST3', 'TEST2', 'TEST1', 'TEST9'])")];

  assert.deepEqual(queue, ['TEST3', 'TEST4', 'TEST5', 'TEST1', 'TEST2', 'TEST6', 'TEST9'],
    'visible rows in board order, then the rest of the board, then the unrendered');
});

/* The board shows Finnhub's own `dp`. `dp` here disagrees with (c - pc) / pc,
   which would be 10% — so this fails the moment anyone computes it locally. */
test('the day change is the provider figure, not one computed from c and pc', () => {
  const changePct = loadApp().run(`buildRow('TEST5',
    { c: 11, d: 1, dp: 42, pc: 10 },
    [{ period: '2026-08-01', strongBuy: 5, buy: 3, hold: 2, sell: 0, strongSell: 0 }],
    Date.now()).changePct`);

  assert.equal(changePct, 42, "the provider's dp is passed through as-is");
});

/* ── The Finnhub rate limiter ─────────────────────────────────────────

   These use the fake clock (see loadApp). The limiter is the one piece here
   whose whole behaviour is scheduling, and it shipped a fault that no amount of
   arithmetic testing would have caught: the sliding window bounded the
   sixty-second average and nothing else, so against an empty window it released
   every slot it had on a single millisecond. */

test('the limiter spaces its grants instead of releasing the window in one tick', async () => {
  const rl = loadApp({}, { fakeClock: true });
  const gap = rl.run('RATE_MIN_GAP_MS');

  /* Twelve at once is the shape loadAll presents: a batch of symbols under
     Promise.allSettled, each firing several endpoints under Promise.all. Before
     the fix every one of these resolved on the same millisecond. */
  rl.run(`
    globalThis.__grants = [];
    for (let i = 0; i < 12; i++) acquireSlot().then(() => __grants.push(Date.now()));
  `);
  await rl.advance(60_000);

  const grants = [...rl.run('__grants')];
  assert.equal(grants.length, 12, 'every waiter is eventually admitted');

  const gaps = grants.slice(1).map((t, i) => t - grants[i]);
  assert.ok(Math.min(...gaps) >= gap,
    `closest pair of grants was ${Math.min(...gaps)}ms apart, expected at least ${gap}ms`);
});

/* Waiters released by one timer all wake in the same tick. The gap each of them
   reads must be the one left AFTER the earlier wakers took theirs — which is
   what the `continue` in acquireSlot is for, and what "concurrent callers each
   pass a check only one of them should have passed" looks like here. */
test('waiters released together do not each consume the same gap', async () => {
  const rl = loadApp({}, { fakeClock: true });
  const gap = rl.run('RATE_MIN_GAP_MS');

  rl.run('globalThis.__grants = []; acquireSlot().then(() => __grants.push(Date.now()));');
  await rl.advance(0);
  assert.equal([...rl.run('__grants')].length, 1, 'the first call is admitted immediately');

  // Five arrivals inside the first gap: all must queue, none may slip through.
  rl.run('for (let i = 0; i < 5; i++) acquireSlot().then(() => __grants.push(Date.now()));');
  await rl.advance(gap - 1);
  assert.equal([...rl.run('__grants')].length, 1, 'nothing else is admitted before the gap elapses');

  await rl.advance(gap * 6);
  const grants = [...rl.run('__grants')];
  assert.equal(grants.length, 6);
  assert.equal(new Set(grants).size, 6, 'no two grants landed on the same millisecond');
});

test('no more than RATE_LIMIT.calls are admitted in any sixty-second window', async () => {
  const rl = loadApp({}, { fakeClock: true });
  const limit = rl.run('RATE_LIMIT.calls');

  rl.run(`
    globalThis.__grants = [];
    for (let i = 0; i < 130; i++) acquireSlot().then(() => __grants.push(Date.now()));
  `);
  await rl.advance(4 * 60_000);

  const grants = [...rl.run('__grants')];
  assert.ok(grants.length > limit, 'the run has to pass one full window to test one');

  for (let i = 0; i + limit < grants.length; i++) {
    const span = grants[i + limit] - grants[i];
    assert.ok(span >= 60_000,
      `${limit + 1} calls inside ${span}ms, starting at grant ${i}`);
  }
});

/* The field that tells the two over-admission stories apart. A 429 arriving
   while this tab has used 1 of its 55 slots is not this tab's doing, and that
   is the whole reason the number is recorded rather than just the count. */
test('a 429 records how full this tab window was when the first one arrived', async () => {
  const rl = loadApp({}, { fakeClock: true });
  rl.run(`
    fetch = async () => ({
      status: 429, ok: false,
      headers: { get: () => null },
      json: async () => ({}),
    });
  `);

  const status = rl.run("get('/quote', { symbol: 'TEST1' }, 0).then(() => 'resolved', (e) => e.status)");
  await rl.advance(1);

  assert.equal(await status, 429);
  assert.equal(rl.run('rate429.count'), 1);
  assert.equal(rl.run('rate429.windowAtFirst'), 1,
    "one slot used — this tab's own — so the ceiling was not what refused it");
});

/* A proxy refusal is not a statement about the Finnhub account, and
   fetchOptional must not write it down as one: a server started with no
   FINNHUB_API_KEY would otherwise mark price targets, insider data and candles
   off-plan in localStorage, for a week, on an account that has all three. */
test('a proxy refusal never turns a premium endpoint off', async () => {
  const rl = loadApp({}, { fakeClock: true });
  rl.run(`
    fetch = async () => ({
      status: 503, ok: false,
      headers: { get: (h) => (h === 'X-Bolt-Proxy-Error' ? '1' : null) },
      json: async () => ({ error: 'FINNHUB_API_KEY is not set on the server.', via: 'serve.mjs' }),
    });
  `);

  const result = rl.run(
    "fetchOptional('/stock/price-target', { symbol: 'TEST1' }, 'priceTarget', 'Price targets')");
  await rl.advance(1);

  assert.equal(await result, null, 'the call still fails softly');
  assert.equal(rl.run('PLAN.priceTarget'), true, 'but the plan flag survives it');
  assert.equal(rl.run("localStorage.getItem(LS.plan)"), null, 'and nothing is persisted');
});

/* The same shape from Finnhub itself MUST turn it off, or the board re-probes
   an endpoint the account does not have on every symbol of every load. */
test('a real 403 from Finnhub still turns a premium endpoint off', async () => {
  const rl = loadApp({}, { fakeClock: true });
  rl.run(`
    toast = () => {};
    fetch = async () => ({
      status: 403, ok: false,
      headers: { get: () => null },
      json: async () => ({}),
    });
  `);

  const result = rl.run(
    "fetchOptional('/stock/price-target', { symbol: 'TEST1' }, 'priceTarget', 'Price targets')");
  await rl.advance(1);

  assert.equal(await result, null);
  assert.equal(rl.run('PLAN.priceTarget'), false);
});

/* ── The per-call estimator ───────────────────────────────────────────
   One estimator behind the dropdown, the row tooltip, the toast and the batch
   quote. It was one behind the quote alone, while the other three read a
   hardcoded string — which is how the label went on saying ~$0.15 against a
   logged median of $0.234 over eleven calls. */

test('the estimate falls back to the table until three calls are logged', () => {
  const est = app.run('perCallEstimate');
  const models = app.run('ASSESS_MODELS');

  for (const n of [0, 1, 2]) {
    const e = est(OPUS, Array(n).fill(0.9));
    assert.equal(e.usd, models[OPUS].est, `${n} observations must not set the estimate`);
    assert.equal(e.observed, false);
    assert.match(e.basis, /list prices/);
    assert.equal(e.n, n);
  }

  /* The third one flips it, and the basis has to say so — a number that changed
     its source without saying is the whole defect being fixed here. */
  const three = est(OPUS, [0.9, 0.9, 0.9]);
  assert.equal(three.usd, 0.9);
  assert.equal(three.observed, true);
  assert.match(three.basis, /median of 3/);
});

test('the estimate is the median, so one heavy call cannot set the quote', () => {
  const est = app.run('perCallEstimate');

  // Mean 0.60, median 0.25. Three times the price of the next ordinary call.
  const e = est(OPUS, [0.1, 0.2, 0.3, 1.8]);
  assert.equal(e.usd, 0.25);
  assert.ok(e.usd < 0.6);

  // Unsorted input must not change the answer.
  assert.equal(est(OPUS, [1.8, 0.3, 0.1, 0.2]).usd, 0.25, 'the input order is not the caller\u2019s problem');

  // The observed range is reported, so a median cannot hide a wide spread.
  assert.match(e.basis, /\$0\.10.\$1\.80/);
});

test('refused and errored calls never reach the estimate', () => {
  const observed = app.run('observedCosts');
  const history = [
    { model: OPUS, usage: { usd: 0.2 } },
    { model: OPUS, usage: { usd: 0 } },          // a 400: no usage block, never billed
    { model: OPUS, usage: { usd: null } },
    { model: OPUS },                              // no usage at all
    { model: 'claude-haiku-4-5-20251001', usage: { usd: 0.05 } },
    { model: OPUS, usage: { usd: 0.4 } },
  ];
  assert.deepEqual(plain(observed(history, OPUS)), [0.2, 0.4],
    'a call that cost nothing is not a cheap call, it is not a call');
});

/* The quote and the label must be the same number, computed the same way. This
   is the regression that started it: they were two numbers for one quantity and
   only one of them moved. */
test('the batch quote and the dropdown label agree', () => {
  const plan = app.run('batchPlan');
  const est = app.run('perCallEstimate');
  const history = [0.21, 0.24, 0.29, 0.30].map((usd) => ({ model: OPUS, usage: { usd } }));

  const quoted = plan({ rows: ROWS(4), n: 4, model: OPUS, history });
  const labelled = est(OPUS, app.run('observedCosts')(history, OPUS));

  assert.equal(quoted.perCall, labelled.usd);
  assert.equal(quoted.basis, labelled.basis);
});

test('the displayed estimate is never parsed back into a number', () => {
  const text = app.run('estimateText');
  assert.equal(text({ usd: 0.234 }), '~$0.23');
  assert.ok(Number.isNaN(Number(text({ usd: 0.234 }))),
    'it carries a tilde and a currency symbol on purpose — est.usd is the number');
});

/* `approx` is a display string and `est` is the number, deliberately separate.
   Separate is not permission to disagree: both were re-baselined together on
   2026-09-01 and a drift between them would put two different prices on screen. */
test('every model\u2019s approx rounds to its est', () => {
  const models = app.run('ASSESS_MODELS');
  for (const [id, cfg] of Object.entries(models)) {
    assert.equal(cfg.approx, `~$${cfg.est.toFixed(2)}`,
      `${id}: approx and est must name the same price`);
  }
});

/* ── The horizon split renders ────────────────────────────────────────
   The fields were requested, validated, stored and never shown, which looks
   from the outside exactly like a field that was refused. */

test('the horizon split renders both calls with their basis lines', () => {
  const html = app.run('horizonSplitHTML')({
    callNear: 5, callNearWhy: 'Momentum offset by insider selling.',
    callLong: 8, callLongWhy: 'Low-cost operator with durable margins.',
    entryLevel: null, entryLevelBasis: null, entryLevelRejected: null,
  });

  assert.match(html, /Near-term/);
  assert.match(html, /Momentum offset by insider selling\./);
  assert.match(html, /Long-term/);
  assert.match(html, /Low-cost operator with durable margins\./);
  assert.match(html, />5</, 'the near-term number itself, not only its prose');
  assert.match(html, />8</);
  assert.doesNotMatch(html, /Entry level/, 'no level was offered, so nothing is said about one');
});

test('an accepted entry level shows its basis and its distance from the price', () => {
  const html = app.run('horizonSplitHTML')({
    callNear: 5, callNearWhy: 'x', callLong: 6, callLongWhy: 'y',
    entryLevel: 134.3, entryLevelBasis: '52-week low at $134.30 from raw technicals.',
    entryLevelPct: -33.894, priceAt: 203.16, entryLevelRejected: null,
  });

  assert.match(html, /\$134\.30/);
  assert.match(html, /-33\.9%/);
  assert.match(html, /\$203\.16 at assessment/, 'the percentage needs the price it is against');
  assert.match(html, /52-week low/);
});

test('a refused entry level says so instead of vanishing', () => {
  const html = app.run('horizonSplitHTML')({
    callNear: 5, callNearWhy: 'x', callLong: 6, callLongWhy: 'y',
    entryLevel: null, entryLevelBasis: null,
    entryLevelRejected: 'no board figure cited',
  });

  assert.match(html, /refused/i);
  assert.match(html, /no board figure cited/);
});

/* An entry written before the split carries none of these keys. It must render
   nothing rather than a header over three blanks. */
test('an assessment predating the split renders no split at all', () => {
  assert.equal(app.run('horizonSplitHTML')({ rating: 6, ratingBasis: 'x' }), '');
});

/* ── Price anchors ────────────────────────────────────────────────────
   The factors above all reduce a price to a percentage and discard the price.
   `entry_level` needs the price back, and until 2026-09-01 the assessment
   context carried exactly one — the current one — while the prompt demanded
   arithmetic on figures that were therefore not there. */

test('the 52-week endpoints are the ones rangePos reduces away', () => {
  const closes = rising(300, 100, 0.5);
  closes[290] = 60;                       // a low inside the window
  closes[291] = 400;                      // and a high

  const { low, high } = app.run('rangePrices')(closes);
  assert.equal(low, 60);
  assert.equal(high, 400);

  /* The endpoints and the position must describe the same window, or the model
     is handed two readings of one thing that disagree. */
  const pos = app.run('rangePos')(closes);
  const last = closes[closes.length - 1];
  assert.ok(Math.abs(pos - ((last - low) / (high - low)) * 100) < 1e-9);
});

test('the 200-day mean is the price maGap measures the gap from', () => {
  const closes = rising(300, 100, 0.5);
  const ma = app.run('ma200Price')(closes);
  const gap = app.run('maGap')(closes);
  const last = closes[closes.length - 1];

  assert.ok(Number.isFinite(ma));
  assert.ok(Math.abs(gap - ((last / ma - 1) * 100)) < 1e-9,
    'the anchor and the percentage must be the same computation');

  // Too short a series has no mean, and must say so rather than average what it has.
  assert.equal(app.run('ma200Price')(rising(50)), null);
});

test('support comes back as a price, and resistance comes back at all', () => {
  const closes = rising(300, 100, 0.5);
  const { support, resistance } = app.run('srPrices')(closes);
  const last = closes[closes.length - 1];

  if (support != null) {
    assert.ok(support < last, 'support is below the price by definition');
    const dist = app.run('supportDistance')(closes);
    assert.ok(Math.abs(dist - ((last - support) / last) * 100) < 1e-9,
      'the price and the distance must agree — they are one level read two ways');
  }
  if (resistance != null) assert.ok(resistance > last);

  assert.deepEqual(plain(app.run('srPrices')([])), { support: null, resistance: null });
});

test('a quarter of sigma is half a year of it', () => {
  const sq = app.run('sigmaQuarter');
  // 32% annual on a $200 price: 200 * 0.32 * sqrt(0.25) = $32.
  assert.ok(Math.abs(sq(200, 32) - 32) < 1e-9);
  assert.equal(app.run('ENTRY_HORIZON_YEARS'), 0.25);

  // Nothing usable in, null out — never a zero band, which would admit anything.
  assert.equal(sq(200, 0), null);
  assert.equal(sq(200, null), null);
  assert.equal(sq(0, 32), null);
});

test('the level is recorded in sigmas, the unit its bound is written in', () => {
  const sig = app.run('entryLevelSigmas');
  // $200 price, 32% vol -> $32 sigma. A level at $184 is half a sigma down.
  assert.ok(Math.abs(sig(184, 200, 32) - -0.5) < 1e-9);
  assert.ok(Math.abs(sig(168, 200, 32) - -1) < 1e-9);
  assert.equal(sig(184, 200, null), null, 'no volatility, no band, no reading');
});

/* ── Provenance ───────────────────────────────────────────────────────
   The check the field always claimed to have. FANG's two levels cited $134.30
   and $216.90, which no context this board produced ever contained. */

test('a price the context never supplied is caught', () => {
  const uncited = app.run('uncitedPrices');
  const context = 'Current price $203.16. 52-week closing range $150.00 to $216.90.';

  // The real FANG basis, against the context that was actually sent then.
  const bad = uncited(
    '52-week low at $134.30 from raw technicals; the lower boundary of the range.',
    'Price 203.16, 52-week position 80.0%.', 134.30);
  assert.deepEqual(plain(bad), [134.3], 'the figure was never in what the model was shown');

  // The same citation against a context that does carry the endpoint.
  assert.deepEqual(plain(uncited('52-week low at $134.30, taken directly.',
    'Current price $203.16. 52-week closing range $134.30 to $216.90.', 134.30)), []);

  // Arithmetic across two supplied anchors, with the level as the result.
  assert.deepEqual(plain(uncited(
    '52-week low 150.00 plus 28% of the range to 216.90 = 168.73.', context, 168.73)), [],
    'a derived level is allowed to be new when the line shows what it was derived from');

  /* The exemption is EARNED, not automatic. A line whose only price is a level
     the context never contained has shown no work — and this is the exact shape
     that the first version of this check waved through, because it exempted the
     level by value and the level was the fabricated figure. */
  assert.deepEqual(plain(uncited('support around 168.73.', context, 168.73)), [168.73],
    'a bare level citing nothing is the fabrication, not an exempt result');

  /* A supplied anchor beside a fabricated one. BOTH are flagged now: 134.30 was
     never supplied, and 142.15 does not follow from 150.00 by anything the line
     shows. Under the old exemption 142.15 was waved through for the sole reason
     that SOMETHING in the line checked out — which is exactly how JAZZ's 209.14
     escaped while its correct intermediates were blamed. */
  assert.deepEqual(plain(uncited(
    '52-week low 150.00 and support at 134.30 give 142.15.', context, 142.15)),
  [134.3, 142.15]);
});

test('the scan skips what is not a price, and errs toward letting it through', () => {
  const prices = app.run('pricesIn');

  assert.deepEqual(plain(prices('support at 118.40 and 0.28 of the 52-week range, 15% below')),
    [118.4], 'a coefficient below one, a bare count and a percentage are not price claims');
  assert.deepEqual(plain(prices('$95 at the low')), [95], 'a currency symbol makes it a price');
  assert.deepEqual(plain(prices('roughly 118 at support')), [],
    'KNOWN GAP: no decimal and no symbol, so a fabricated round number is not caught');
  assert.deepEqual(plain(prices('a band of 1,250.50')), [1250.5], 'thousands separators survive');
});

test('a refused level keeps a reason that says which rule it broke', () => {
  const why = app.run('entryLevelRejection');
  const ok = app.run('validEntryLevel');

  assert.equal(why(null, null), null, 'none offered is not a refusal');
  assert.equal(why(-5, 'x'), 'not a positive price');
  assert.equal(why(100, '   '), 'no board figure cited');
  assert.match(why(100, 'support at 134.30', [134.3]), /did not supply/);
  assert.match(why(100, 'support at 134.30', [134.3]), /134\.30/,
    'the offending figure has to be in the reason, or the refusal cannot be audited');

  assert.equal(ok(100, 'support at 118.40'), true);
  assert.equal(ok(100, 'support at 134.30', [134.3]), false,
    'a level citing a price the board never gave is not a level');
});

/* The end-to-end claim of the whole change: the figure the prompt tells the
   model to cite is now actually in the string the model is given. */
test('the context carries the anchors a level is allowed to cite', () => {
  const s = loadApp();
  const closes = rising(300, 100, 0.5);
  closes[290] = 60;
  s.run('state').px.series.set('TEST1', { c: closes });

  const row = {
    symbol: 'TEST1', name: 'Test One', sector: 'Energy',
    price: closes[closes.length - 1], changePct: 0.5,
    overall: 50, overallParts: 3, overallOf: 3,
    realisedVol: 32, latest: {}, insider: null,
  };
  const context = s.run('assessContext')(row);

  assert.match(context, /PRICE ANCHORS/);
  assert.match(context, /\$60\.00/, 'the 52-week low is present as a price');
  assert.match(context, /one-sigma band/i);

  /* And the check agrees: citing the low against this context is clean, while
     citing a number from nowhere is not. */
  const uncited = s.run('uncitedPrices');
  assert.deepEqual(plain(uncited('52-week low at $60.00, taken directly.', context, 60)), []);
  /* Below the 52-week low of this series, so it cannot collide with an anchor
     by accident — the point is that it is absent, not that it is implausible. */
  assert.deepEqual(plain(uncited('support at $12.34 from the chart.', context, 12.34)), [12.34]);
});

/* One figure named three times is one unsupported claim. The count goes into a
   refusal reason a reader will take at face value. */
test('a repeated fabrication is counted once', () => {
  const uncited = app.run('uncitedPrices');
  const basis = '52-week low 134.30 plus 28% of (216.90 - 134.30) + 134.30 = 172.36.';
  assert.deepEqual(plain(uncited(basis, 'Current price $203.16.', 172.36)),
    [134.3, 216.9, 172.36]);
  assert.match(app.run('entryLevelRejection')(172.36, basis, [134.3, 216.9, 172.36]),
    /cites 3 prices/);
});

/* ── The entry stance ─────────────────────────────────────────────────
   A null `entry_level` used to mean two opposite things at once: "I could not
   derive a level" and "no level is needed, this price is fine". Nothing reading
   the log could tell a model that declined to answer from one that answered
   NOW. */

test('the level decides the stance, and the declaration is kept beside it', () => {
  const stance = app.run('entryStance');

  assert.equal(stance('at_market', true), 'level',
    'a surviving level is the more specific claim and it is what gets scored');
  assert.equal(stance('level', false), 'no_anchor',
    'a declared level with no level is not a level');
  assert.equal(stance('at_market', false), 'at_market');
  assert.equal(stance('outside_band', false), 'outside_band');
  assert.equal(stance(undefined, false), 'no_anchor', 'a missing stance is not a buy-now case');
  assert.equal(stance('whatever', false), 'no_anchor', 'and neither is an unknown one');
});

test('an at-market entry is scored as a buy-now case, not dropped', () => {
  const bars = [{ day: '2026-01-15', close: 95 }, { day: '2026-01-20', close: 88 }];
  const { rows, skipped } = app.run('entryLevelOutcomes')(
    [lvlEntry({ entryLevel: null, entryLevelBasis: null, entryStance: 'at_market' })],
    () => bars, () => 120, { now: LNOW });

  assert.equal(skipped.noLevel, 0, 'it is a position, not missing data');
  const m1 = rows.find((r) => r.months === 1);
  assert.ok(m1, 'and it produces a row');

  assert.equal(m1.atMarket, true);
  assert.equal(m1.stance, 'at_market');
  assert.equal(m1.level, 100, 'the effective level is the price on the day');
  assert.equal(m1.reached, true, 'the position was opened immediately');
  assert.equal(m1.daysToReach, 0);
  assert.equal(m1.advantage, 0, 'waiting earned exactly nothing, by construction');
  assert.equal(m1.degenerate, false,
    'a declared buy-now is not the inferred one — a level at or above the price is a mistake, this is an answer');
});

/* The zero above is a definition, not a measurement. Averaging it into the
   wait-versus-buy figure would drag that figure toward zero and shrink its
   error while adding no evidence — the more often the model said "buy now",
   the more confident the number would look. */
test('at-market zeros stay out of the wait-versus-buy average', () => {
  const st = app.run('entryLevelStats')([
    { months: 1, day: 'd1', reached: true, daysToReach: 10, advantage: 5, retFromAssessment: 2, degenerate: false, atMarket: false },
    { months: 1, day: 'd1', reached: true, daysToReach: 20, advantage: 7, retFromAssessment: 3, degenerate: false, atMarket: false },
    { months: 1, day: 'd2', reached: false, daysToReach: null, advantage: null, retFromAssessment: 11, degenerate: false, atMarket: false },
    { months: 1, day: 'd2', reached: true, daysToReach: 0, advantage: 0, retFromAssessment: 9, degenerate: false, atMarket: true },
    { months: 1, day: 'd3', reached: true, daysToReach: 0, advantage: 0, retFromAssessment: 1, degenerate: false, atMarket: true },
  ]);

  assert.equal(st.n, 5);
  assert.equal(st.nWait, 3);
  assert.equal(st.nAtMarket, 2);

  assert.equal(st.meanAdvantage, 6, 'the two zeros must not pull this toward 0');
  assert.equal(st.nFilled, 2, 'and must not count as fills of a level');
  assert.ok(Math.abs(st.fillRate - 2 / 3) < 1e-9, 'the fill rate is over the wait arm only');

  // The at-market arm is scored on the only question it can answer.
  assert.equal(st.meanAtMarketReturn, 5, 'mean of 9 and 1');
  assert.ok(Math.abs(st.meanWaitReturn - 16 / 3) < 1e-9,
    'and the wait arm reports the same figure, so the two are comparable');
});

test('a stance that predates the field is not read as either meaning', () => {
  const { rows, skipped } = app.run('entryLevelOutcomes')(
    [{ v: 4, symbol: 'AAA', at: Date.parse('2026-01-01T00:00:00Z'), priceAt: 100,
      callNear: 6, entryLevel: null }],
    () => [], () => 120, { now: LNOW });

  assert.equal(rows.length, 0);
  assert.equal(skipped.preStance, 1);
  assert.equal(skipped.noLevel, 0,
    'guessing no_anchor would be a guess; guessing at_market would invent a buy-now case');
});

test('the stance is a directional field and ships its basis', () => {
  const dir = app.run('DIRECTIONAL_FIELDS');
  assert.ok(dir.entry_stance, 'at_market is a position, so the field is directional');
  assert.equal(dir.entry_stance.basis, dir.entry_level.basis,
    'one decision, one explanation — the basis line covers the stance too');

  /* Sharing a basis must not put the name in `required` twice: the schema
     property list would no longer match the field list, which is the assertion
     that holds the whole registry together. */
  const fields = [...app.run('assessSchemaFields')()];
  assert.equal(fields.length, new Set(fields).size, 'no duplicate required names');
  assert.ok(fields.includes('entry_stance'));
});

test('every stance the prompt offers is one the schema accepts', () => {
  const req = app.run('assessRequest')(
    { symbol: 'T', name: 'T', sector: 'S', price: 1, latest: {} },
    app.run('ASSESS_MODEL_DEFAULT'));
  const stances = [...req.output_config.format.schema.properties.entry_stance.enum];
  assert.deepEqual(stances, ['level', 'at_market', 'outside_band', 'no_anchor']);

  const sys = app.run('ASSESS_SYSTEM');
  for (const s of stances) {
    assert.ok(sys.includes(`\`${s}\``), `the prompt must define ${s}, or the model cannot choose it`);
  }
});

/* â”€â”€ Derivability â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   The JAZZ regression. The line cited three real anchors and showed correct
   arithmetic; the old check exempted the level BECAUSE something checked out,
   waved through the one figure with no derivation, and reported the three
   correct intermediates as fabrications. */

const JAZZ_BASIS = '200-day moving average $203.54 plus 10% of range to current price '
  + '($243.71 âˆ’ $203.54 = $40.17, 10% = $4.02) gives 207.56, rounded to 209.14 to stay '
  + 'comfortably inside the one-sigma band floor of $198.54.';
const JAZZ_CONTEXT = 'Current price $243.71. 200-day moving average $203.54. '
  + 'One quarter is $45.17 of price movement (1 sigma), giving a one-sigma band of $198.54 to $288.88.';

test('shown working is not mistaken for fabrication', () => {
  const uncited = app.run('uncitedPrices');
  const flagged = plain(uncited(JAZZ_BASIS, JAZZ_CONTEXT, 209.14));

  /* 243.71 - 203.54 = 40.17; 10% of that is 4.02; 203.54 + 4.02 = 207.56.
     Every one follows from anchors the board did supply. */
  for (const ok of [40.17, 4.02, 207.56]) {
    assert.ok(!flagged.some((n) => Math.abs(n - ok) < 0.02),
      `${ok} is arithmetic on supplied anchors and must not be called a fabrication`);
  }

  /* 209.14 is not in the context and follows from nothing: it is 1.58 above the
     figure it claims to round, and the stated reason â€” staying above a floor of
     198.54 that 207.56 already cleared by nine dollars â€” is incoherent. */
  assert.deepEqual(flagged, [209.14],
    'the one figure with no derivation is the one that should be refused');
});

test('the refusal names both tests the figure failed', () => {
  const why = app.run('entryLevelRejection')(209.14, JAZZ_BASIS, [209.14]);
  assert.match(why, /209\.14/);
  assert.match(why, /did not supply/);
  assert.match(why, /does not follow from the working shown/,
    'being absent from the context is not the fault on a line that shows its working');
});

test('derivability clears a fraction of the way between two anchors', () => {
  const uncited = app.run('uncitedPrices');
  // 150 + 0.28 * (216.90 - 150) = 168.73, with only the endpoints supplied.
  assert.deepEqual(plain(uncited(
    '52-week low 150.00 plus 28% of the range to 216.90 = 168.73.',
    'range $150.00 to $216.90.', 168.73)), []);

  // The same shape with a result that does not follow is still caught.
  assert.deepEqual(plain(uncited(
    '52-week low 150.00 plus 28% of the range to 216.90 = 171.00.',
    'range $150.00 to $216.90.', 171)), [171]);
});

/* The limit of the claim, asserted so nobody reads a pass as a proof. */
test('derivability is sound against assertion, not against constructed arithmetic', () => {
  const uncited = app.run('uncitedPrices');
  /* 203.54 + 40.17 = 243.71 is real arithmetic on real anchors landing on a
     number that is also real. A fabricator who writes plausible working gets
     through, and the code says so rather than claiming otherwise. */
  assert.deepEqual(plain(uncited(
    'support at 203.54 plus the 40.17 range gives 243.71.',
    'Current price $243.71. 200-day moving average $203.54.', 243.71)), [],
  'a pass means no fault found, never verified');
});

/* A refused level must not erase the answer to "would you buy now". */
test('a refused level keeps the stance the model declared', () => {
  const html = app.run('horizonSplitHTML')({
    callNear: 5, callNearWhy: 'x', callLong: 6, callLongWhy: 'y',
    entryLevel: null, entryLevelBasis: JAZZ_BASIS,
    entryLevelRejected: 'cites 209.14, which the board did not supply and which does not follow from the working shown',
    entryStance: null, entryStanceDeclared: 'level',
  });
  assert.match(html, /refused/i);
  assert.match(html, /wait for a better price/,
    'the price was refused; the intent was not, and it was already stored');
  assert.match(html, /209\.14/, 'and the reason still names the figure');
});


/* â”€â”€ Which assessment the board shows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   One column, so one entry per symbol, and the order is fixed rather than
   "newest wins". Rule 2 does not fire anywhere in the real log â€” measured
   2026-09-01, no symbol carries both an Opus and a Haiku entry with the split
   â€” so these fixtures are the only thing exercising it. */

const OPUS_M = 'claude-opus-4-5-20251101';
const HAIKU_M = 'claude-haiku-4-5-20251001';
const AT = Date.parse('2026-09-01T12:00:00Z');
const ent = (over = {}) => ({ symbol: 'AAA', at: AT, model: OPUS_M, rating: 6, ...over });

test('an entry with the horizon split beats a newer one without it', () => {
  const pick = app.run('pickAssessment');
  const chosen = pick([
    ent({ at: AT + 5000, rating: 7 }),                          // newer, rating only
    ent({ at: AT, rating: 5, callNear: 4, callLong: 8 }),       // older, has the split
  ]);
  assert.equal(chosen.rating, 5,
    'a pre-split entry cannot fill the cell, so newness must not win over it');
  assert.equal(chosen.callNear, 4);
});

test('with the split on both, Opus wins over Haiku even when Haiku is newer', () => {
  const pick = app.run('pickAssessment');
  const chosen = pick([
    ent({ model: HAIKU_M, at: AT + 5000, rating: 9, callNear: 9, callLong: 9 }),
    ent({ model: OPUS_M, at: AT, rating: 5, callNear: 4, callLong: 8 }),
  ]);
  assert.equal(chosen.model, OPUS_M);
  assert.equal(chosen.rating, 5);
});

test('with the split and the tier equal, the newest wins', () => {
  const pick = app.run('pickAssessment');
  const chosen = pick([
    ent({ at: AT, rating: 5, callNear: 4, callLong: 8 }),
    ent({ at: AT + 5000, rating: 6, callNear: 5, callLong: 6 }),
  ]);
  assert.equal(chosen.rating, 6);
});

test('an entry carrying neither a rating nor a split is not shown at all', () => {
  const pick = app.run('pickAssessment');
  // The two JAZZ v1 entries: written before the rating existed.
  assert.equal(pick([ent({ rating: null })]), null);
  assert.equal(pick([]), null);
  assert.equal(pick(undefined), null);

  // But one usable entry beside an unusable one still shows.
  assert.equal(pick([ent({ rating: null }), ent({ at: AT - 5000, rating: 4 })]).rating, 4);
});

/* 542 of 575 rows have no assessment. A dash repeated 542 times asserts a value
   where none exists, and reads as one at a glance. */
test('a symbol with no assessment renders an empty cell, not a placeholder', () => {
  const s = loadApp();
  s.run("state.assessBySymbol = {};");
  const html = s.run("assessedCellHTML({ symbol: 'TEST1' })");
  assert.match(html, /assessed-col/, 'the cell still exists, so the column keeps its width');

  /* Asserted on the CELL CONTENT, not the markup. A character-class test over
     the whole string fails on the hyphen in its own class name — the stylesheet
     hook, which no reader ever sees. */
  const content = html.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '');
  assert.equal(content, '', 'and renders nothing at all: not a dash, not a zero');
});

test('the cell degrades from split to rating-only rather than emptying', () => {
  const s = loadApp();
  s.run(`state.assessBySymbol = {
    FULL: { symbol: 'FULL', at: Date.now(), model: '${OPUS_M}', rating: 6, callNear: 5, callLong: 7 },
    THIN: { symbol: 'THIN', at: Date.now(), model: '${OPUS_M}', rating: 6 },
  };`);

  /* Asserted on the parts, not on the joined string: the separator is a middle
     dot, and pinning a test to one non-ASCII character makes it a test of this
     file's encoding as much as of the cell. */
  const body = (html) => html.replace(/^[\s\S]*?<span class="score-weak">/, '').replace(/<\/span>[\s\S]*$/, '');

  const full = body(s.run("assessedCellHTML({ symbol: 'FULL' })"));
  assert.ok(full.startsWith('6'), 'the rating leads');
  assert.ok(full.includes('5/7'), 'and both calls follow it');

  const thin = body(s.run("assessedCellHTML({ symbol: 'THIN' })"));
  assert.ok(thin.startsWith('6'));
  assert.ok(!thin.includes('/'), 'no calls to show, and nothing invented in their place');
});

/* pickAssessment does not pick the newest — it prefers a horizon split, then
   Opus — so two rows showing 6 can be two different models, and until the name
   was in the cell the board said nothing about which. */
test('the cell names the model that wrote the reading', () => {
  const s = loadApp();
  s.run(`state.assessBySymbol = {
    O: { symbol: 'O', at: Date.now(), model: '${OPUS_M}', rating: 6 },
    H: { symbol: 'H', at: Date.now(), model: '${HAIKU_M}', rating: 6 },
  };`);
  const by = (html) => (html.match(/<span class="assessed-by">([^<]*)<\/span>/) || [])[1];

  assert.equal(by(s.run("assessedCellHTML({ symbol: 'O' })")), 'Opus');
  assert.equal(by(s.run("assessedCellHTML({ symbol: 'H' })")), 'Haiku');

  /* The short name only. The full label carries a version number that is the
     same on every row here, and the column is one word wide. */
  assert.ok(!s.run("assessedCellHTML({ symbol: 'O' })").includes('>Opus 4.5<'));

  /* An empty cell stays empty: provenance for an assessment that does not
     exist is the placeholder this column refuses to render. */
  s.run("state.assessBySymbol = {};");
  assert.ok(!s.run("assessedCellHTML({ symbol: 'O' })").includes('assessed-by'));
});

test('an entry past the shortest scoring horizon is marked stale', () => {
  const s = loadApp();
  const days = s.run('ASSESS_STALE_DAYS');
  assert.equal(days, s.run('RATING_MIN_DAYS'),
    'the staleness threshold is the point an entry first becomes scoreable, not a taste');

  s.run(`state.assessBySymbol = {
    FRESH: { symbol: 'FRESH', at: Date.now() - 2 * 86400000, model: '${OPUS_M}', rating: 6 },
    OLD: { symbol: 'OLD', at: Date.now() - ${days + 5} * 86400000, model: '${OPUS_M}', rating: 6 },
  };`);
  assert.doesNotMatch(s.run("assessedCellHTML({ symbol: 'FRESH' })"), /assessed-stale/);
  assert.match(s.run("assessedCellHTML({ symbol: 'OLD' })"), /assessed-stale/);
});

/* The claim belongs to the field, not to each row that happens to carry a
   value: 33 populated cells would otherwise repeat it 33 times, and the 542
   empty ones would not carry it at all. */
test('the UNSUPPORTED claim sits on the column header, once', () => {
  const cols = app.run('boardColumns')();
  const col = cols.find((c) => c.special === 'assessed');
  assert.ok(col, 'the column is registered');
  assert.equal(col.unsortable, true, 'it must not sort');
  assert.equal(col.key, undefined, 'and must not be a persisted sort target');
  assert.match(col.title, /no external evidence/i);
  assert.match(col.title, /cannot sort, filter or enter the backtest/i);

  assert.ok(!app.run('sortKeysFor')(app.run('OVERALL')).includes('assessed'),
    'and it is not offered as a sort key anywhere');

  // Not in the score registry, so it cannot reach the filters or the backtest.
  assert.ok(!app.run('allScores')().some((s) => s.field === 'assessed'));
});



/* ── Static mode (GitHub Pages) ───────────────────────────────────────
   With no serve.mjs behind the page, Finnhub is called directly with the
   browser's key. The two things that must hold: the request is a SIMPLE one
   (any custom header and Finnhub's preflight kills it), and proxy mode — the
   default, and what every other test here runs in — is untouched. */

const okResponse = (data) => ({
  ok: true, status: 200, headers: { get: () => null }, json: async () => data,
});

function recordFetches(s, respond = () => okResponse({ c: 1 })) {
  const g = s.run('globalThis');
  const calls = [];
  g.fetch = async (url, opts = {}) => { calls.push({ url: String(url), headers: opts.headers || {} }); return respond(url); };
  return calls;
}

test('static mode calls Finnhub directly, with the token, and no custom header', async () => {
  const s = loadApp({ 'bar.apiKey': 'TESTKEY' });
  s.state.proxy = false;
  const calls = recordFetches(s);

  await s.run('get')('/quote', { symbol: 'ZZQ' }, 0);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://finnhub.io/api/v1/quote');
  assert.equal(url.searchParams.get('token'), 'TESTKEY');
  assert.equal(url.searchParams.get('symbol'), 'ZZQ');
  assert.deepEqual(Object.keys(calls[0].headers), ['Accept'],
    'X-Bolt-Context would make the request non-simple, and Finnhub fails every preflight');
});

test('static mode keeps the key out of the response cache', async () => {
  const s = loadApp({ 'bar.apiKey': 'TESTKEY' });
  s.state.proxy = false;
  recordFetches(s);
  await s.run('get')('/quote', { symbol: 'ZZQ' }, 60_000);
  const ids = [...s.state.cache.keys()];
  assert.equal(ids.length, 1);
  assert.ok(!ids[0].includes('TESTKEY'), 'the cache id is taken before the token goes on');
});

test('proxy mode is unchanged: same-origin path, no token, context header', async () => {
  const s = loadApp({ 'bar.apiKey': 'TESTKEY' });
  assert.equal(s.state.proxy, true, 'proxy is the default until detectServer says otherwise');
  const calls = recordFetches(s);

  await s.run('get')('/quote', { symbol: 'ZZQ' }, 0);

  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'http://localhost:8080/finnhub/quote');
  assert.equal(url.searchParams.get('token'), null,
    'a legacy key in the browser must never be sent in proxy mode');
  assert.ok('X-Bolt-Context' in calls[0].headers);
});

test('detectServer: only serve.mjs\'s own answer means proxy mode', async () => {
  const cases = [
    ['serve.mjs answers', async () => okResponse({ bolt: true }), true],
    ['a static host 404s', async () => ({ ok: false, status: 404, json: async () => ({}) }), false],
    ['something else answers JSON', async () => okResponse({ hello: 1 }), false],
    ['the request fails', async () => { throw new TypeError('network'); }, false],
    ['the 404 page is HTML', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }), false],
  ];
  for (const [label, respond, expected] of cases) {
    const s = loadApp();
    const g = s.run('globalThis');
    g.document.documentElement = { dataset: {} };
    g.fetch = respond;
    assert.equal(await s.run('detectServer')(), expected, label);
    assert.equal(s.state.proxy, expected, label);
    assert.equal(g.document.documentElement.dataset.server, expected ? 'proxy' : 'static', label);
  }
});

test('static mode with no key spends no call to find that out', async () => {
  const s = loadApp();
  s.state.proxy = false;
  const calls = recordFetches(s);
  assert.equal(await s.run('checkFinnhubKey')(), false);
  assert.equal(calls.length, 0);
  assert.equal(s.state.finnhub.checked, true);
});

test('static mode refuses Assess before anything is queued', () => {
  const s = loadApp();
  s.state.proxy = false;
  assert.equal(s.run('assessClick')('ZZQ'), 'unavailable');
  assert.equal(s.state.assessQueue.length, 0);
});

/* ── Snapshot mode ────────────────────────────────────────────────────
   Static mode with no key draws the board from data/snapshot/. The contract:
   cached reads come from the snapshot and never from this browser's storage,
   and nothing is spent — except a key being checked in the gate. */

function snapshotApp(extra = {}) {
  const s = loadApp({ 'bar.t.ZZLOCAL': JSON.stringify({ at: 1, q: [1] }) });
  s.state.proxy = false;
  s.state.snapshot = {
    asOf: Date.parse('2026-09-20T12:00:00Z'),
    entries: { ZZSNAP: { at: 5, q: [42, 0, 0, 42, 42, 42, 42], t: [] } },
    assessments: [
      { symbol: 'ZZSNAP', at: 100, rating: 5 },
      { symbol: 'ZZOTHER', at: 300, rating: 6 },
      { symbol: 'ZZSNAP', at: 200, rating: 7 },
    ],
    ...extra,
  };
  return s;
}

test('snapshot: cached reads come from the snapshot, not this browser', () => {
  const s = snapshotApp();
  assert.equal(s.run('readEntry')('ZZSNAP').q[0], 42);
  assert.equal(s.run('readEntry')('ZZLOCAL'), null,
    "a visitor's own cache must not leak into a published board");
});

test('snapshot: the assessment log is the published one, newest first', async () => {
  const s = snapshotApp();
  const all = await s.run('loadAssessments')();
  assert.deepEqual(plain(all.map((a) => a.at)), [300, 200, 100]);
  const one = await s.run('loadAssessments')('ZZSNAP');
  assert.deepEqual(plain(one.map((a) => a.rating)), [7, 5]);
});

test('snapshot: Finnhub is never called without a key', async () => {
  const s = snapshotApp();
  const g = s.run('globalThis');
  let calls = 0;
  g.fetch = async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; };
  await assert.rejects(() => s.run('get')('/search', { q: 'ZZ' }, 0), /snapshot/i);
  assert.equal(calls, 0);
});

test('snapshot: a key being checked in the gate does reach Finnhub', async () => {
  const s = snapshotApp();
  s.state.browserKey = 'TESTKEY';
  const g = s.run('globalThis');
  const urls = [];
  g.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ c: 1 }) }; };
  assert.equal(await s.run('checkFinnhubKey')(), true);
  assert.match(urls[0], /^https:\/\/finnhub\.io\/api\/v1\/quote\?.*token=TESTKEY/);
});

test('snapshot clock: "now" is the snapshot moment, and time still passes', () => {
  const s = loadApp();
  const asOf = Date.parse('2026-09-20T12:00:00Z');
  s.run('installSnapshotClock')(asOf);
  const now = s.run('Date.now()');
  assert.ok(now >= asOf && now - asOf < 5_000, `Date.now() ${now} should sit at the snapshot moment`);
  assert.ok(Math.abs(s.run('new Date().getTime()') - now) < 5_000, 'and a bare new Date() agrees');
  assert.equal(s.run('new Date(0).getTime()'), 0, 'dates with an argument are untouched');
  assert.equal(s.run("Date.parse('2026-01-01T00:00:00Z')"), Date.parse('2026-01-01T00:00:00Z'));
});

test('snapshot: share-count age is judged at the snapshot date, not today', () => {
  /* The reason the clock exists. A share count 400 days old at the snapshot is
     inside SHARES_MAX_AGE_DAYS; the same count read a few months later is not,
     and earnings yield would silently vanish from a published board. */
  const s = loadApp();
  const asOf = Date.parse('2026-09-20T12:00:00Z');
  const sharesEnd = new Date(asOf - 400 * 86_400_000).toISOString().slice(0, 10);
  s.state.fx.facts.set('ZZFX', { f: { shares: [{ e: sharesEnd, v: 1_000_000, f: sharesEnd }] } });
  s.run('installSnapshotClock')(asOf);
  s.run('fundamentalsFor')('ZZFX', 10);
  const ageDays = (s.run('Date.now()') - Date.parse(`${sharesEnd}T00:00:00Z`)) / 86_400_000;
  assert.ok(ageDays <= s.SHARES_MAX_AGE_DAYS, `age ${ageDays.toFixed(1)}d must be under the gate at the snapshot`);
});

/* The snapshot's status line is for a visitor: shown and scored, nothing else.
   The local line carries maintenance counts (names beyond the momentum and MA
   edges, single-bar flags, the cohort), which a visitor has no use for and which
   made the line long enough to run off the edge of the card. */
test('snapshot: the board status line is shown and scored only', () => {
  const s = loadApp();
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.3);
  const scored = s.technicalsFor({ f: '2024-01-01', t: '2026-01-01', c: closes });
  const rows = [
    { ...scored, symbol: 'ZZFA', mom6m1m: 95, maGap: 70, pxAnomaly: true },
    { ...scored, symbol: 'ZZFB' },
    { symbol: 'ZZFC' },
  ];
  s.state.boardMode = 'technicals';
  for (const r of rows) s.state.rows.set(r.symbol, r);
  s.state.symbolSet = new Set(rows.map((r) => r.symbol));
  const parts = () => s.run('boardMetaParts')(3);

  const local = parts();
  assert.ok(local.some((p) => /beyond ±\d+% momentum/.test(p)), `local keeps its diagnostics: ${local}`);
  assert.ok(local.some((p) => /single bar/.test(p)), `local keeps its diagnostics: ${local}`);

  s.state.snapshot = { asOf: Date.parse('2026-09-20T12:00:00Z'), entries: {}, assessments: [] };
  const snap = parts();
  assert.equal(snap.length, 2, `snapshot line: ${snap.join(' · ')}`);
  assert.equal(snap[0], '3 shown');
  assert.match(snap[1], /^2 scored /);
});
