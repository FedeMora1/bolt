/* The spend ceiling is only as good as costOf. Under-report and the guard fires
   late, which is the failure it exists to prevent.
   Run with:  node --test  */
import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, PRICING, WEB_SEARCH_USD } from './pricing.mjs';

const OPUS = 'claude-opus-4-5-20251101';

test('the web search fee is counted — it is not in the token usage', () => {
  /* The whole point of this test. $10 per 1,000 searches arrives as
     `server_tool_use.web_search_requests`, nowhere near the token fields, so a
     cost function that walked only the token counts would miss every search on
     every call and the ledger would drift under the truth all day. */
  const noSearch = costOf(OPUS, { input_tokens: 20000, output_tokens: 1500 });
  const withSearch = costOf(OPUS, {
    input_tokens: 20000, output_tokens: 1500,
    server_tool_use: { web_search_requests: 4 },
  });

  const delta = withSearch.usd - noSearch.usd;
  assert.ok(Math.abs(delta - 4 * WEB_SEARCH_USD) < 1e-9,
    `four searches must add exactly $${(4 * WEB_SEARCH_USD).toFixed(2)}, added $${delta.toFixed(6)}`);
  assert.ok(delta > 0, 'the fee must move the total at all');

  // And it is a real share of the bill, not a rounding detail.
  assert.ok(delta / withSearch.usd > 0.1,
    'four searches are over 10% of a typical assessment — silently dropping them would matter');
});

test('every priced component lands in the total', () => {
  const p = PRICING[OPUS];
  const one = (field, rate) => {
    const c = costOf(OPUS, { [field]: 1_000_000 }).usd;
    assert.ok(Math.abs(c - rate) < 1e-9, `${field} priced at ${c}, expected ${rate}`);
  };
  one('input_tokens', p.in);
  one('output_tokens', p.out);
  one('cache_creation_input_tokens', p.cacheWrite);
  one('cache_read_input_tokens', p.cacheRead);

  /* Cache reads must be cheaper than fresh input or caching is pointless, and
     writes dearer — if these ever invert, the pricing table was mistyped. */
  assert.ok(p.cacheRead < p.in, 'a cache read is cheaper than fresh input');
  assert.ok(p.cacheWrite > p.in, 'a cache write costs a premium over fresh input');
});

test('an unknown model meters high, never free', () => {
  /* The guard's quietest failure: a model string the table has never seen would
     cost $0.00 forever, the ledger would never move, and the daily ceiling would
     be silently disabled by a typo or a model upgrade. */
  const unknown = costOf('claude-something-not-yet-released', {
    input_tokens: 20000, output_tokens: 1500,
    server_tool_use: { web_search_requests: 3 },
  });
  assert.ok(unknown.usd > 0, 'an unknown model must never meter as free');
  assert.equal(unknown.unknownModel, true, 'and must say it fell back');

  // Priced at least as high as the dearest model in the table, so it trips early.
  const dearest = Math.max(...Object.values(PRICING).map((p) => p.in));
  assert.ok(unknown.usd >= (20000 / 1e6) * dearest,
    'the fallback must not undercut a known rate');

  const known = costOf(OPUS, { input_tokens: 20000, output_tokens: 1500 });
  assert.equal(known.unknownModel, false);
});

test('a response with no usage costs nothing and does not throw', () => {
  // Error bodies carry no usage; an errored search is not billed either.
  assert.deepEqual(costOf(OPUS, null), { usd: 0, unknownModel: false });
  assert.deepEqual(costOf(OPUS, undefined), { usd: 0, unknownModel: false });
  assert.equal(costOf(OPUS, {}).usd, 0);
  assert.equal(costOf(OPUS, { server_tool_use: {} }).usd, 0);
});

test('a realistic assessment prices where the estimate said it would', () => {
  /* Reported to the user as $0.12-0.23. If a rate is mistyped this drifts by an
     order of magnitude and the number quoted alongside the button is wrong. */
  const usd = costOf(OPUS, {
    input_tokens: 22000,
    output_tokens: 1500,
    cache_creation_input_tokens: 950,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 3 },
  }).usd;
  assert.ok(usd > 0.10 && usd < 0.25, `expected roughly $0.12-0.23, got $${usd.toFixed(4)}`);

  // Haiku on identical usage must be materially cheaper, or the lever is fake.
  const haiku = costOf('claude-haiku-4-5-20251001', {
    input_tokens: 22000, output_tokens: 1500,
    server_tool_use: { web_search_requests: 3 },
  }).usd;
  assert.ok(haiku < usd / 2, `Haiku should be well under half: $${haiku.toFixed(4)} vs $${usd.toFixed(4)}`);
  assert.ok(haiku > 3 * WEB_SEARCH_USD,
    'but not below the search fees, which are the same whichever model runs');
});
