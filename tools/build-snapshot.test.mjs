/* What the public snapshot may contain. The dump it is built from holds
   provider API keys and per-call spend; neither may reach data/snapshot/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, trimFacts } from './build-snapshot.mjs';

const dump = () => ({
  localStorage: {
    'bar.t.ZZAA': JSON.stringify({ at: 1_790_000_000_000, q: [10], t: [['2026-09-01', 1, 2, 3, 0, 0]] }),
    'bar.watchlist': JSON.stringify(['ZZAA']),
    'bar.plan': JSON.stringify({ at: 1, priceTarget: false, insider: true, candle: true }),
    'bar.sec': JSON.stringify({ at: 1, cik: { ZZAA: 123 }, gone: [] }),
    'bar.key.polygon': 'SECRET-POLYGON-KEY',
    'bar.apiKey': 'SECRET-FINNHUB-KEY',
  },
  px: [['ZZAA', { f: '2026-01-01', t: '2026-09-01', c: [1, 2] }]],
  fx: [['ZZAA', { cik: 123, at: 1, f: { netIncome: [
    { e: '2026-06-30', v: 5, f: '2026-08-01', r: [] },
    { e: '2010-12-31', v: 1, f: '2011-02-01', r: [] },
  ] } }]],
  assessments: [['ZZAA|x', {
    v: 6, id: 'ZZAA|x', symbol: 'ZZAA', at: 1, model: 'claude-test', rating: 5,
    brief: { board_says: 'text' },
    usage: { input_tokens: 100, output_tokens: 10, usd: 0.42, inference_geo: 'us', service_tier: 'standard' },
    someFutureField: 'not allowlisted',
  }]],
  consensus: [['ZZAA', [{ p: '2026-09', d: [1, 2, 3, 0, 0] }]]],
});

test('no API key from the dump reaches any snapshot file', () => {
  const text = JSON.stringify(buildSnapshot(dump()));
  assert.doesNotMatch(text, /SECRET/);
});

test('assessments are published without spend or token usage', () => {
  const [entry] = buildSnapshot(dump()).assessments.entries;
  assert.equal(entry.usage, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /usd|input_tokens|inference_geo|service_tier/);
  assert.equal(entry.someFutureField, undefined, 'fields are allowlisted: a new one is not published by default');
  assert.equal(entry.rating, 5, 'and what IS allowlisted survives');
});

test('the snapshot clock is the newest quote', () => {
  assert.equal(buildSnapshot(dump()).core.asOf, 1_790_000_000_000);
});

test('the snapshot records what each part is current through, from the data', () => {
  const d = dump();
  d.localStorage['bar.t.ZZAB'] = JSON.stringify({ at: 1_789_000_000_000, tAt: 1_788_000_000_000, q: [5], t: [] });
  d.localStorage['bar.watchlist'] = JSON.stringify(['ZZAA', 'ZZAB']);
  d.px.push(['ZZAB', { f: '2026-01-01', t: '2026-09-01', c: [1] }], ['ZZAC', { f: '2025-01-01', t: '2025-03-25', c: [1] }]);
  const { through } = buildSnapshot(d).core;
  assert.deepEqual(through.quotes, { from: 1_789_000_000_000, to: 1_790_000_000_000 }, 'the oldest quote is kept, not just the newest');
  assert.deepEqual(through.trends, { from: 1_788_000_000_000, to: 1_788_000_000_000 }, 'entries with no trend fetch are skipped');
  assert.deepEqual(through.prices, { to: '2026-09-01', behind: 1 }, 'the date most series end on, and how many stop earlier');
  assert.deepEqual(through.fundamentals, { from: 1, to: 1 });
  assert.deepEqual(through.assessments, { from: 1, to: 1 });

  // A symbol SEC lists as gone is final, not stale: it must not age the filings or the price count.
  d.localStorage['bar.sec'] = JSON.stringify({ at: 1, cik: { ZZAA: 123 }, gone: ['ZZAC', 'ZZGN'] });
  d.fx.push(['ZZGN', { cik: 9, at: 0.5, f: {} }]);
  d.fx[0][1].at = 2;
  const gone = buildSnapshot(d).core.through;
  assert.deepEqual(gone.fundamentals, { from: 2, to: 2 });
  assert.deepEqual(gone.prices, { to: '2026-09-01', behind: 0 });
});

test('the fundamentals trim keeps recent periods and the newest rows', () => {
  const rec = { cik: 1, at: 1, f: { x: [{ e: '2026-06-30' }, { e: '2020-12-31' }, { e: '2010-12-31' }] } };
  assert.deepEqual(trimFacts(rec, '2022-01-01', 0).f.x.map((r) => r.e), ['2026-06-30']);
  assert.deepEqual(trimFacts(rec, '2022-01-01', 2).f.x.map((r) => r.e), ['2026-06-30', '2020-12-31'],
    'an annual or stale filer keeps its newest rows whatever their date');
});
