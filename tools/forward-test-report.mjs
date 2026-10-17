/* Forward test of the snapshot's scores against what prices did afterwards.
 *
 *   node tools/forward-test-report.mjs <scores.json> <closes.json> <quotes.json> [out.json]
 *
 *   scores.json  tools/snapshot-scores.mjs output (scores from data/snapshot/ only)
 *   closes.json  { symbol: { t, c: [last N closes] } } read from the local board's
 *                refreshed price store (Polygon, split-adjusted)
 *   quotes.json  { symbol: { status, q: Finnhub /quote } } fetched after the close
 *
 * Start price: the close on START_DAY, the last trading day before the snapshot's
 * asOf, located by counting trading days back from the series' last bar. End
 * price: the Finnhub quote's `c` (the END_DAY close). Price return only, no
 * dividends. Two cross-checks drop a symbol rather than guess: the series' last
 * bar must match the quote's previous close (catches a split or a bad bar), and
 * where the snapshot's own quote was taken after START_DAY's close, it must
 * match the series' START_DAY close (catches a mis-indexed bar). */
import { readFileSync, writeFileSync } from 'node:fs';

const [scoresPath, closesPath, quotesPath, outPath] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const scores = read(scoresPath);
const closes = read(closesPath);
const quotes = read(quotesPath);
const core = read(new URL('../data/snapshot/core.json', import.meta.url));
const assessments = read(new URL('../data/snapshot/assessments.json', import.meta.url)).entries;

const START_DAY = '2026-09-25';
const END_DAY = '2026-10-16';
const TOL = 0.005;   // 0.5%: closes from two providers agree to the cent; a split is 50%+

/* NYSE trading days between the two dates. No exchange holiday falls in this
   span (Columbus Day trades), so weekdays are trading days. */
function tradingDays(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const CAL = tradingDays('2026-09-01', END_DAY);
const closeOn = (s, day) => {
  const iT = CAL.indexOf(s.t); const iD = CAL.indexOf(day);
  if (iT < 0 || iD < 0 || iD > iT) return null;
  const k = s.c.length - 1 - (iT - iD);
  return k >= 0 ? s.c[k] : null;
};
const near = (a, b) => a > 0 && b > 0 && Math.abs(a / b - 1) <= TOL;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const returns = {};
const dropped = [];
for (const sym of [...scores.rows.map((r) => r.symbol), 'SPY']) {
  const s = closes[sym]; const q = quotes[sym]?.q;
  if (!s || !s.c?.length) { dropped.push([sym, 'no price series']); continue; }
  if (!q || !(q.c > 0)) { dropped.push([sym, `no current quote (HTTP ${quotes[sym]?.status ?? '-'})`]); continue; }
  if (day(q.t * 1000) !== END_DAY) { dropped.push([sym, `quote dated ${day(q.t * 1000)}`]); continue; }
  const start = closeOn(s, START_DAY);
  if (start == null) { dropped.push([sym, `series ends ${s.t}`]); continue; }
  // The quote's previous close is the bar before END_DAY; the series' bar for that day must agree.
  const prevDay = CAL[CAL.indexOf(END_DAY) - 1];
  const seriesPrev = closeOn(s, prevDay);
  if (seriesPrev == null || !near(seriesPrev, q.pc)) { dropped.push([sym, `series ${prevDay} ${seriesPrev} vs quote prev close ${q.pc}`]); continue; }
  const snapQ = core.entries[sym];
  let snapCheck = 'n/a';
  if (snapQ && snapQ.at > Date.parse(`${START_DAY}T20:00:00Z`) && snapQ.q?.[0] > 0) {
    if (!near(start, snapQ.q[0])) { dropped.push([sym, `series ${START_DAY} ${start} vs snapshot quote ${snapQ.q[0]}`]); continue; }
    snapCheck = 'ok';
  }
  returns[sym] = { start, end: q.c, ret: q.c / start - 1, snapCheck };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const variance = (a) => { const m = mean(a); return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); };
const ranks = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const pearson = (x, y) => { const mx = mean(x); const my = mean(y); let n = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; } return n / Math.sqrt(dx * dy); };
const spearman = (x, y) => pearson(ranks(x), ranks(y));

/* Sector-neutral return: the stock's return minus its sector's mean (sectors
   with fewer than 3 priced names fold into one "other" group). Shows whether a
   spread is a stock-level effect or a sector bet. */
const bySector = {};
for (const r of scores.rows) if (returns[r.symbol]) (bySector[r.sector || '?'] ??= []).push(returns[r.symbol].ret);
const sectorKey = (sec) => ((bySector[sec || '?'] || []).length >= 3 ? (sec || '?') : 'other');
const sectorMean = {};
for (const r of scores.rows) if (returns[r.symbol]) (sectorMean[sectorKey(r.sector)] ??= []).push(returns[r.symbol].ret);
for (const k of Object.keys(sectorMean)) sectorMean[k] = mean(sectorMean[k]);

function quintiles(items) {   // items: [{ score, ret, rel }], split into equal fifths by score
  const sorted = [...items].sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const fifths = [0, 1, 2, 3, 4].map((q) => sorted.slice(Math.round((q * n) / 5), Math.round(((q + 1) * n) / 5)));
  const rows = fifths.map((f, q) => ({
    fifth: q + 1, n: f.length,
    scoreLo: f[0].score, scoreHi: f[f.length - 1].score,
    mean: mean(f.map((x) => x.ret)), median: median(f.map((x) => x.ret)),
  }));
  const top = fifths[4]; const bot = fifths[0];
  const diff = (key) => {
    const t = top.map((x) => x[key]); const b = bot.map((x) => x[key]);
    const spread = mean(t) - mean(b);
    const se = Math.sqrt(variance(t) / t.length + variance(b) / b.length);
    return { spread, se, t: spread / se };
  };
  const ic = spearman(sorted.map((x) => x.score), sorted.map((x) => x.ret));
  return { n, rows, raw: diff('ret'), sectorNeutral: diff('rel'), ic, icSe: 1 / Math.sqrt(n - 1) };
}

const LABELS = {
  overall: 'Overall', technicals: 'Technicals (mom12, the score in Overall)',
  fundamentals: 'Fundamentals (accruals, the score in Overall)',
  fundamentalsHeadline: 'Fundamentals (earnings yield, the tab\'s first column)',
  analyst: 'Analyst',
};
const results = {};
for (const key of Object.keys(LABELS)) {
  const items = scores.rows
    .filter((r) => r[key] != null && returns[r.symbol])
    .map((r) => ({ score: r[key], ret: returns[r.symbol].ret, rel: returns[r.symbol].ret - sectorMean[sectorKey(r.sector)] }));
  results[key] = { label: LABELS[key], ...quintiles(items) };
}

/* AI ratings: the latest rated assessment per symbol written at or before asOf. */
const latest = {};
for (const a of assessments) {
  if (a.at > scores.asOf || a.rating == null) continue;
  if (!latest[a.symbol] || a.at > latest[a.symbol].at) latest[a.symbol] = a;
}
const rated = Object.values(latest).filter((a) => returns[a.symbol]);
const groups = {};
for (const a of rated) (groups[a.rating <= 4 ? '<=4' : String(a.rating)] ??= []).push(returns[a.symbol].ret);
const hi = rated.filter((a) => a.rating >= 6).map((a) => returns[a.symbol].ret);
const lo = rated.filter((a) => a.rating <= 5).map((a) => returns[a.symbol].ret);
const ai = {
  rated: Object.keys(latest).length, priced: rated.length,
  dates: [...new Set(Object.values(latest).map((a) => day(a.at)))].sort(),
  groups: Object.fromEntries(Object.entries(groups).sort().map(([k, v]) => [k, { n: v.length, mean: mean(v), median: median(v) }])),
  hiVsLo: { nHi: hi.length, nLo: lo.length, spread: mean(hi) - mean(lo), se: Math.sqrt(variance(hi) / hi.length + variance(lo) / lo.length) },
  ic: spearman(rated.map((a) => a.rating), rated.map((a) => returns[a.symbol].ret)),
  icSe: 1 / Math.sqrt(rated.length - 1),
};
ai.hiVsLo.t = ai.hiVsLo.spread / ai.hiVsLo.se;

const allRet = Object.entries(returns).filter(([s]) => s !== 'SPY').map(([, r]) => r.ret);
const out = {
  window: { start: START_DAY, end: END_DAY, snapshotAsOf: scores.asOfIso },
  spy: returns.SPY ?? null,
  universe: { scoredRows: scores.rows.length, priced: allRet.length, mean: mean(allRet), median: median(allRet),
    sd: Math.sqrt(variance(allRet)), snapCheckOk: Object.values(returns).filter((r) => r.snapCheck === 'ok').length },
  dropped, results, ai,
};
console.log(JSON.stringify({ window: out.window, spy: out.spy, universe: out.universe, dropped: dropped.length }, null, 1));
for (const r of Object.values(results)) {
  console.log(`\n${r.label}: n=${r.n}  spread ${(r.raw.spread * 100).toFixed(2)}% ± ${(r.raw.se * 100).toFixed(2)} (t ${r.raw.t.toFixed(2)})`
    + `  sector-neutral ${(r.sectorNeutral.spread * 100).toFixed(2)}% ± ${(r.sectorNeutral.se * 100).toFixed(2)}  IC ${r.ic.toFixed(3)} ± ${r.icSe.toFixed(3)}`);
  for (const q of r.rows) console.log(`  Q${q.fifth} n=${q.n} score ${q.scoreLo.toFixed(1)}-${q.scoreHi.toFixed(1)}  mean ${(q.mean * 100).toFixed(2)}%  median ${(q.median * 100).toFixed(2)}%`);
}
console.log('\nAI', JSON.stringify(ai));
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 1));
