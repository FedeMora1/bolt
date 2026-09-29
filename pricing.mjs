/* What a Claude API call cost, computed from the usage the API returns.
 *
 * Its own module so it can be tested without starting a server — serve.mjs
 * listens on import, so anything defined in there is unreachable from a test.
 * The spend ceiling is only as good as this function: under-report and the
 * guard fires late, which is the failure mode the ceiling exists to prevent.
 *
 * Rates verified against platform.claude.com/docs/en/about-claude/pricing
 * on 2026-09-01. USD per million tokens.
 */

export const PRICING = {
  'claude-opus-4-5-20251101':  { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-opus-5':             { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5,  cacheWrite: 1.25, cacheRead: 0.10 },
};

/* $10 per 1,000 searches. NOT part of token usage — it arrives separately as
   `usage.server_tool_use.web_search_requests`, so a cost function that only
   walked the token fields would miss it entirely and under-report every call
   that searched. Errored searches are not billed and are not counted in that
   field, so no adjustment is needed for them. */
export const WEB_SEARCH_USD = 0.01;

/* An unknown model must not meter as free. A model string this table has never
   seen would otherwise cost $0.00 forever and the daily ceiling would never
   fire — the guard would be silently disabled by a typo or a model upgrade.
   Priced at the highest known rate instead, so an unknown model over-reports
   and trips the ceiling early rather than never. */
const UNKNOWN = { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50, unknown: true };

/** Cost in USD. Returns `{ usd, unknownModel }` so a caller can surface the
    fallback rather than quietly trusting a guessed rate. */
export function costOf(model, usage) {
  if (!usage) return { usd: 0, unknownModel: false };
  const p = PRICING[model] || UNKNOWN;
  const m = (n, rate) => ((n || 0) / 1e6) * rate;

  const usd = m(usage.input_tokens, p.in)
    + m(usage.output_tokens, p.out)
    + m(usage.cache_creation_input_tokens, p.cacheWrite)
    + m(usage.cache_read_input_tokens, p.cacheRead)
    + (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;

  return { usd, unknownModel: !!p.unknown };
}
