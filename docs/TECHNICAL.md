# Bolt — technical reference

> This is the detailed reference, written while Bolt ran only behind
> `serve.mjs`. Since then the app also runs as a **static site** (GitHub Pages):
> with no server behind it, the visitor enters their own Finnhub key in the page,
> and Fundamentals and Assess are switched off. Statements below such as "any
> other static server no longer works" describe **local mode** only. See the
> [main README](../README.md) for both ways of running it. Some sections refer to
> `NOTES.md`, the author's private working notes, which are not in this repo.

A browser dashboard for Wall Street analyst ratings across ~580 liquid US-listed
names. Rank the whole board by a composite score, filter by sector, and open any name
to see its buy/hold/sell distribution and how that distribution has shifted month
over month.

No build step and no dependencies — a handful of files plus `serve.mjs`, a
single-file Node server that holds the API key and proxies Finnhub, SEC EDGAR
and Anthropic. Everything else runs in the browser.

## Running it

Double-click **`Bolt.bat`** — it starts the local server and opens the app.
Closing its console window stops the server. There is a shortcut to it on the
Desktop.

Or run the server directly:

```powershell
$env:FINNHUB_API_KEY="your-key"    # not needed if you used setx once
$env:BOLT_ANTHROPIC_KEY="sk-ant-…" # optional, only for Assess
node serve.mjs                     # http://localhost:8080
node serve.mjs 8081                # a different port, but see below
```

**Opening `index.html` from the filesystem no longer works, and neither does any
other static server.** The page reaches Finnhub, SEC EDGAR and Anthropic through
paths that `serve.mjs` proxies; under a plain file server all three 404 and the
board comes up empty with no explanation. `Bolt.bat` ran `npx http-server` until
2026-09-01 and did exactly that.

**Serve on 8080 unless you mean not to.** `localStorage` and IndexedDB are keyed
by origin, so a different port presents an empty board — every cached price,
analyst trend and consensus snapshot lives under `http://localhost:8080`. This is
why `Bolt.bat` no longer walks to the next free port when 8080 is busy: silently
moving you to 8081 looks exactly like data loss.

Static responses carry `Cache-Control: no-store`. These files are edited while
the server is running, and without it the browser had no ETag, no
`Last-Modified` and no cache directive to work from — so it was free to keep
serving an old copy indefinitely. That is how a newly added button can be
missing from a page that reloads fine. **Restart the server after changing
`serve.mjs` itself.**

## Tests

```powershell
node --test
```

293 tests in `app.test.mjs` and `pricing.test.mjs`, covering the scoring and
backtest maths, the price-history merge, the per-call cost estimator, the
assessment context's price anchors and citation check, the assessment runner
(a click runs, clicks during a run line up, the ceiling ends a drain and puts
the refused name back), and the Finnhub rate limiter: the
combined score, both bucketings, the spread, the point-in-time guarantee, what
each run excludes, what the backfill asks for at each end of a stored series,
and that the limiter spaces its grants rather than releasing a whole window at
once. No dependencies and no `package.json` — Node's built-in runner, matching
the rest of the project.

The limiter tests take an opt-in fake clock (`loadApp(seed, { fakeClock: true })`)
that swaps `Date.now` and `setTimeout` for a controllable pair, so a minute of
scheduling is asserted in milliseconds. It is opt-in because a fake `Date` leaks
into every TTL and freshness test in the file.

The IndexedDB layer itself is not unit-tested: the sandbox has no `indexedDB`,
and stubbing one convincingly would test the stub. It is verified in a real
browser against real stored data instead.

The tests load the real `universe.js` and `app.js` into a `node:vm` sandbox
rather than re-implementing anything, so a change to the scoring code changes
what they see. `app.js` is a browser script with no exports that ends by calling
`init()`; the loader drops that one trailing call, stubs `localStorage` and
`document`, and reads the functions back out. It asserts that the file still
ends that way, so the day it stops the tests fail loudly instead of quietly
checking a half-built sandbox.

Two things to know before adding a test. Top-level `const` does not become a
property of the sandbox object, so values are pulled out by evaluating an
expression inside the same context. And anything built in that context has its
own `Array.prototype`, so `deepStrictEqual` against a literal written in the
test file fails as "not reference-equal" however well the contents match —
compare through the `plain()` helper.

Nothing here reaches the network or a browser; `fetch` throws if called. The
numbers are invented, and so are the tickers — a real symbol in a fixture reads
as a live quote to anyone skimming the file.

## API key

Data comes from [Finnhub](https://finnhub.io/register). Register for a free key and
set it **on the server**, not in the app:

```powershell
setx FINNHUB_API_KEY "your-key"     # once, per Windows account
```

Then start Bolt normally. `serve.mjs` reads it at startup and prints whether it
found one; the app has no key field any more and will tell you if the server has
none. Everything the app uses is on the free tier:

| Endpoint | Used for |
| --- | --- |
| `/stock/recommendation` | Analyst buy / hold / sell counts by month |
| `/quote` | Current price, day change, open / high / low |
| `/stock/profile2` | Logo, industry, market cap — lazily, only when a row is opened |
| `/stock/price-target` | Mean/high/low target → Upside % column (**premium**) |
| `/stock/insider-transactions` | Net open-market insider shares, 3 months (**premium**) |
| `/search` | Ticker autocomplete |
| `/stock/candle` | Six months of daily closes for the detail chart (**premium**) |

That table is also the allowlist. `serve.mjs` proxies those seven paths and
refuses everything else, so the proxy is not a key-bearing open relay for any
tab on the machine.

### Why the key is on the server

It used to live in this browser's `localStorage` and go to Finnhub as a `token`
query parameter. A key in a query string is in every console line, every
devtools network row, every HAR export and every screenshot of any of them —
readable by anyone the screen or the log reaches. Since 2026-09-01 the key is
`FINNHUB_API_KEY` on the server, attached to each upstream request as an
`X-Finnhub-Token` header, and never sent to the page at all.

Finnhub supports that header directly, but the page cannot use it: `finnhub.io`
answers a CORS preflight with no `Access-Control-Allow-Headers` at all, so a
browser blocks any request carrying a custom header. Server-side there is no
preflight. That is the whole reason this needs a proxy rather than a one-line
change to `fetch`.

If an older version left a key in this browser, the key panel offers to copy it
to the clipboard and delete it. It is never displayed on screen — putting it
there is the exposure this change exists to remove.

The other five provider keys below are **unchanged**: still in `localStorage`,
still in their query strings. The same argument applies to them and the same fix
would work; each just has its own host, auth convention and quota accounting, so
it is five proxies rather than one. Use free keys, not paid ones tied to billing
you care about.

### Rate limiting

Two limiters, both sliding windows of 55 calls a minute with a minimum 1091ms
between grants:

- **`acquireSlot` in `app.js`** bounds what one page sends.
- **`waitForFinnhubSlot` in `serve.mjs`** bounds what this machine sends, across
  every tab. That is the one that matters: the quota is per key, not per page,
  so two tabs — or a reload partway through a load — each start with an empty
  window and spend the same allowance twice.

The minimum gap is not decoration. A sliding window alone bounds the
sixty-second *average* and nothing else, so against an empty window it released
all 55 slots on a single millisecond, and `loadAll` hands it up to 60 calls at
once (15 symbols × 4 endpoints). Spacing them costs no throughput — those calls
were followed by a 60-second wait either way.

If Finnhub still returns 429s, both ends now say why. The app logs a `[rate]`
line at the end of a load with how full *this tab's* window was when the first
429 arrived; `serve.mjs` logs a `[finnhub]` line with how many browser contexts
have been spending the key. A first 429 at 3/55 slots, or a context count above
one, means another tab — not the limiter.

### The Anthropic key is `BOLT_ANTHROPIC_KEY`, not `ANTHROPIC_API_KEY`

Only the Assess control needs it; the board loads fine without one, and the
spend line beside the control says so rather than failing silently.

```powershell
setx BOLT_ANTHROPIC_KEY "sk-ant-…"     # once, per Windows account
```

**The name is deliberate and it is not the provider's usual one.**
`ANTHROPIC_API_KEY` is read by Claude Code's own auth, where it **takes
precedence over a claude.ai login** — so setting it machine-wide for Bolt
silently moves that session onto API billing, which nothing announces and which
has nothing to do with this server. A variable only this project reads cannot do
that.

`ANTHROPIC_API_KEY` is still honoured as a **fallback**, so an existing setup
keeps working across the rename. It is second, not a peer: the startup log names
which variable supplied the key, and a key found under the old name prints a
warning, because that machine still has the collision live. The fix is to move
the key to `BOLT_ANTHROPIC_KEY` and unset the old one.

`ANTHROPIC_DAILY_USD` — the daily spend ceiling, $5 by default — keeps its name.
Claude Code does not read it, so it collides with nothing.

### Additional sources (all optional)

The key panel has a slot for each provider in the `PROVIDERS` registry at the top
of `app.js`. Each is a separate free account with its own quota, so connecting
several genuinely adds up — unlike holding several keys for *one* provider, which
they all forbid and defeat anyway by rate-limiting per IP as well as per key.

| Provider | Free tier | What it is for |
| --- | --- | --- |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) | 250/day | Fundamentals, ratios, earnings calendar, analyst estimates, news. The best first choice. |
| [Twelve Data](https://twelvedata.com/pricing) | 800/day, 8/min | Quotes, time series, ~100 server-side technical indicators. Largest daily budget. |
| [Polygon](https://polygon.io/dashboard/signup) | 5/min, no daily cap | EOD price history, **2 years back on the free plan** (10 years is configured, but needs a paid one — see [History depth](#history-depth-is-a-plan-limit)). Powers the [Technicals board](#the-technicals-board) — the only source that can cover all 579 names. Now branded **Massive**; the same key and account work, and `api.polygon.io` still answers. |
| [NewsAPI](https://newsapi.org/register) | 100/day | Headlines by ticker. **Localhost only**, articles delayed 24h. |
| [Alpha Vantage](https://www.alphavantage.co/support/#api-key) | 25/day | Fundamentals, earnings surprises. Smallest budget here by a wide margin. |

All but Polygon are on-demand sources for one symbol at a time. Their daily
budgets are orders of magnitude short of what 579 symbols costs — a single FMP
pass over the board would take five days of quota — so none of them can feed
the board itself.

Polygon is the exception, and the reason is the shape of its limit rather than
its size: metered per minute with no daily ceiling, it can cover all 579 names
given time. That is what the [Technicals board](#the-technicals-board) runs on.

#### Why these five and not others

**A provider that does not send CORS headers is unusable here, whatever its data
or your key.** These five are called from the page, not through `serve.mjs`, so
the browser is the one deciding — and it refuses. Probed from a real browser
origin in Aug 2026. (Finnhub itself no longer appears in this table's reasoning:
it goes through the proxy, where CORS does not apply. Routing one of these five
the same way would lift the constraint for that provider too, at the cost of a
proxy each.)

| Reachable | Blocked by CORS |
| --- | --- |
| Finnhub, Alpha Vantage, FMP, Polygon, NewsAPI, Twelve Data | Tiingo, EODHD, FRED, SEC EDGAR |

The blocked four are not in the registry and cannot be made to work by adding a
key. Reaching them needs a proxy — `serve.ps1` is the obvious place — which is a
different change.

#### What the client does with a budget

Everything in `getFrom()` exists to keep quota from leaking:

| | |
| --- | --- |
| Daily counter | One per provider, persisted to `bar.usage.<id>`, reset at 00:00 UTC. At zero the client refuses the call rather than spending it. Each panel shows what is left. |
| Response cache | `bar.p.<id>.<path>.<params>`, 24h TTL, so a page reload costs nothing. **Clear cached data** is the only way to force a refetch before then; it does not reset the counters, which belong to the providers. |
| Separate limiters | One sliding window per provider. Sharing Finnhub's 55/min limiter would let board traffic starve a budget of 25 a day. |
| The server's verdict | A quota reply zeroes that provider's counter immediately — the provider is the authority on its own limit, not our arithmetic. |

Saving a key spends one request to verify it, which each panel says up front. A
failed check restores the previous key rather than emptying the slot.

#### Adding a sixth provider

Add an entry to `PROVIDERS`. The panel, the limiter, the counter, the cache
namespace and the key storage all follow from it; there is no second place to
edit. The fields that differ between providers are the ones that have to be
supplied:

- `base` + `keyParam` — where the request goes and what the key is called
  (`apikey`, `apiKey`, `token`… no two agree).
- `pathAsParam` — set only for Alpha Vantage, which names the endpoint in a
  query parameter instead of the URL path.
- `dailyCap` / `rate` — `null` cap means metered per minute only.
- `verify` + `ok` — a cheap call that proves the key, and what a good answer
  looks like.
- `fault(status, data)` — **the important one.** HTTP status is not a reliable
  signal in this corner of the world: Alpha Vantage answers `200` for a rejected
  key, Twelve Data reports `429` inside a `200` body, NewsAPI puts everything in
  `status: "error"`. Each provider says what an error looks like for itself, and
  flags `quota: true` when the failure means the budget is gone.

## The board and its loading budget

The default board is the whole universe in `universe.js` — **579 tickers**: S&P 500
constituents plus widely covered mid-caps and high-profile listings, across all 11
GICS sectors. Use the sector dropdown to narrow it.

Each ticker costs **2 API calls** (quote + recommendation trend). Company names are
hardcoded in `universe.js` and the company profile is fetched lazily when you open a
row, which avoids a third call per ticker.

At Finnhub's free-tier ceiling of 60 calls/minute, that is the arithmetic:

```
579 tickers × 2 calls = 1,158 calls ÷ 55 calls/min ≈ 21 minutes
```

**A cold first load takes about 21 minutes.** There is no way around it on the free
tier — it is a hard consequence of the rate limit, not the batching strategy. What
the app does about it:

- Results are cached in `localStorage` per ticker, so this is a once-a-day cost at
  most. A fully warm load is instant and makes zero API calls, and a day-old one
  refetches only the parts that have actually expired — usually just the quote.
- Rows appear as they arrive; the board is sortable and usable throughout.
- A progress bar shows `done / total` and a running ETA, with a **Stop** button.
  Stopping keeps everything already loaded.
- Interrupted loads resume: whatever got cached is not refetched.

If 21 minutes is too long, cut `DEFAULT_WATCHLIST` down in `app.js` — the load time
scales linearly with the number of tickers.

### Premium endpoints

`/stock/price-target`, `/stock/insider-transactions` and `/stock/candle` are **not on
Finnhub's free tier** — they return 403 there. The app does not assume either way: it
tries each once, and on a 403 disables that endpoint for the session, shows a one-time
notice, leaves that part of the UI empty, and carries on. A plan restriction never
aborts a load and never triggers the "key rejected" gate.

`/stock/candle` is the odd one out: it is **not part of the bulk load at all**. Six
months of daily closes are fetched only for a symbol whose row is actually opened, so
candles never enter the per-symbol call budget below. Once one symbol has proved the
endpoint off-plan, later rows skip the call entirely.

So a **cold** load is 2 calls per symbol on a free key and 4 on a paid one — roughly
21 and 42 minutes respectively.

Warm loads are much cheaper, because the recommendation trend and insider data both
cache for 7 days while quotes expire in 24 hours. On a typical day only the quote has
expired:

| | Free key | Paid key |
| --- | --- | --- |
| Cold load | 2 calls/symbol (~21 min) | 4 calls/symbol (~42 min) |
| Typical day | 1 call/symbol (~11 min) | 2 calls/symbol (~21 min) |
| One day in 7 | 2 calls/symbol (~21 min) | 4 calls/symbol (~42 min) |

The ETA reflects this: it is computed from the calls the cached-out symbols actually
still need (`pendingCallsFor`), not from a cold-load assumption.

### Rate limiting

`BATCH_SIZE` (15 tickers) and `BATCH_DELAY_MS` (1000 ms) control how often progress
updates and rows appear. They do **not** enforce the rate limit and cannot: 15
tickers is 30 calls, so a fixed 1-second gap between batches would run at roughly
1,800 calls/minute, about 30× over the ceiling.

The actual ceiling is enforced by a sliding-window limiter (`acquireSlot`) that every
network request passes through, capped at 55 calls per 60 seconds. It throttles
whatever the batch settings ask for, so no pacing mistake upstream can breach the
limit.

### Caching and staleness

Cache entries are one `localStorage` key per ticker (`bar.t.AAPL`). Each entry holds
four **independently aged** parts, so a stale price target does not throw away a
fresh quote:

| Part | Contents | TTL | Why |
| --- | --- | --- | --- |
| `at` / `q` | Quote | 24 hours | Prices move all day |
| `tAt` / `t` | Recommendation trend | 7 days | Finnhub publishes one row per month |
| `ptAt` / `pt` | Target mean, high, low | 24 hours | Revised on news |
| `inAt` / `in` | Insider net, bought, sold | 7 days | Form 4s trickle in over weeks |

Each TTL tracks how fast that source actually changes. The recommendation trend is
the reason this matters: it is a **monthly** series, so refetching it every 24 hours
spent a call per symbol per day to receive the same six rows back. At 7 days it
costs a call per symbol per week instead.

Only the expired parts are refetched and the result is merged in — on a normal day
that means one `/quote` call per symbol and nothing else. On a quota error the oldest
half is evicted and the write is retried.

Measured, 60 symbols, both plans:

| State | quote | rec | target | insider | Calls/symbol |
| --- | --- | --- | --- | --- | --- |
| Cold load (paid) | 60 | 60 | 60 | 60 | 4.00 |
| Immediate reload | 0 | 0 | 0 | 0 | **0.00** |
| +25h — quotes stale only | 60 | 0 | 0 | 0 | 1.00 |
| +8d — everything stale | 0 | 60 | 0 | 60 | 2.00 |
| Free plan, +25h | 60 | 0 | 0 | 0 | 1.00 |
| **Boot or Refresh**, quotes over an hour old | 60 | 0 | 0 | 0 | 1.00 |

**The steady state is one call per symbol per day**, and that call is the quote. At
579 tickers over a 55/min ceiling that is ~10.5 minutes, which is the floor for
refreshing a board this size — it is the rate limit, not redundant fetching. Shorten
the watchlist or lengthen `QUOTE_TTL_MS` to go faster; nothing else will.

### Remembering what is not on your plan

A 403 is a fact about the account, not about the tab, so the `PLAN` flags are
persisted to `bar.plan` and reloaded on boot.

Without this the flags reset to optimistic on every page load, and because a 403
endpoint never writes a `ptAt`, **every symbol failed `loadFromCache`'s "is the price
target fresh?" test on every load** and the whole board joined the fetch queue to
re-probe an endpoint that was not on the plan — 39 batches of pacing delay for 30
doomed calls. The flags are re-probed weekly so a plan upgrade is picked up on its
own, and **Clear cached data** forces the re-probe immediately.

Batch pacing is also skipped for any batch that made no network calls, so a run
served from cache no longer sleeps its way through `BATCH_DELAY_MS` per batch.

The 24h `QUOTE_TTL_MS` is how long the **store** keeps a quote meaningful, not how old a
price a load will settle for. Both boot and **Refresh** pass `PRICE_STALE_MS` (1 hour) as
their quote horizon, so a load refetches exactly the prices the board is already greying
out. Any price older than an hour is greyed, with the fetch time on hover and in the
detail panel; `at` is what that timestamp reads, which is why the quote keeps the
unprefixed key and why a trend-only refetch does not advance it.

The two measures used to disagree, and Refresh looked broken: it cleared only the
60-second in-memory response cache behind `get()`, while the prices come from the
per-symbol `localStorage` entries — which stayed inside their 24h TTL, so every symbol
short-circuited in `loadFromCache` and no `/quote` call went out. Yesterday's close
survived a Refresh, on a row that had been marked stale since an hour after it was
fetched.

The other three parts keep their own TTLs. They do not move intraday and they are three
of the four calls per symbol, so forcing them would quadruple a load's cost for no
fresher price. Clicking Refresh again inside the hour is nearly free, since the prices it
just wrote are still fresh by that same measure.

### The board is drawn before it is refreshed

`loadFromCache` answers two questions that used to be one: **is there something to
render**, and **does anything still need fetching**. Collapsing them into a single early
return meant a symbol with a stale quote never reached `state.rows`, so it had no row at
all until its refetch landed — a board that emptied itself for ten minutes rather than
showing hour-old prices while the new ones arrived.

Pass 1 now draws every entry the cache holds, however old, and returns only the verdict
on whether a call is needed. Pass 2 replaces those rows in place. A stale row is visibly
stale, not absent.

**Pass 2 fetches what is on screen first.** `prioritiseOnScreen` reads the rendered
`<tr data-symbol>` elements against the viewport and splits the queue into three tiers:
visible, rendered but scrolled off, then whatever the filters, thresholds or sector cap
keep off the board. Without it the queue is the watchlist's own order, which has nothing
to do with how the board is sorted or where it is scrolled — and the far end of 579 names
is ten minutes away. It is ordered *after* the pass-1 render, so it measures the board the
user is actually looking at; with no DOM to measure, the given order stands.

**Clear cached data** (in the key panel) forces a genuine cold reload.

Entries cached before the trend had its own timestamp carry `t` but no `tAt`; those fall
back to `at`, which is when they were in fact fetched, so the change needs no cache
reset. Since a Refresh can now refetch a quote on its own — and a quote write advances
`at` — such an entry has `tAt` backfilled from the old `at` at that moment. Without it
every Refresh would push a legacy trend's 7-day TTL forward and the trend would never
expire.

Tickers that return no analyst coverage are dropped from the board silently and
counted in the header (`… · 38 dropped (no coverage)`). Tickers whose request errors
are not cached, so they retry on the next load.

### Insider transactions

Only **open-market trades** count: Form 4 transaction codes `P` (purchase) and `S`
(sale). Grants (`A`), option exercises (`M`), tax withholding (`F`) and gifts (`G`)
are compensation mechanics — including them made routine vesting read as insider
buying, often by an order of magnitude more shares than any real trade.

The column shows direction only (▲ buying / ▼ selling / flat), because raw share
counts differ by orders of magnitude between names and don't compare usefully; the
tooltip carries bought, sold, net and the trade count. A name with no qualifying
trades shows `none`, which is distinct from `flat` (trades that netted to zero).

Because this changed what the numbers mean, insider cache entries carry a version
(`inV`); entries written under the old rules are treated as stale and refetched.

## Sections and the score registry

The board is a set of **sections**: **Overall** first, then one tab per
registered domain — today Technicals and Analyst, with Fundamentals and News
expected to follow.

Every domain is declared in `SCORE_DOMAINS` in `app.js` and nowhere else. The
section tabs, the detail panel's tabs, which columns can be sorted, which tabs
the backtest offers, and which threshold controls the filter panel renders are
all derived from that list — so **a new domain is added by appending one entry**,
and removed by deleting one.

### A domain is not a score

The two were the same thing in an earlier version and it did not survive
contact with Technicals, which owns **six** scores — one per factor. So:

- A **score** is one number with a `status`, a `scale`, a field on the row, and
  a cell renderer.
- A **domain** is a section that owns one or more scores, plus the columns that
  show its workings and the detail view that explains them.

`scores[0]` is the domain's headline score: the one it sorts by, the one whose
status stands for the domain in a tab, and the one that feeds Overall. A domain
with six live scores therefore still contributes once.

An entry declares its `id`, `label`, `blurb`, `needsPrices`, `pointInTime`, its
`scores`, its `columns`, and its `detail` view. Behaviour that used to branch on
"which board am I on" branches on a declared capability instead —
`needsPrices` for the backfill and the price chart, `pointInTime` for the
backtest — so adding a domain does not mean hunting for the places that
enumerate them.

### What each section shows

| Section | Columns | Filters |
| --- | --- | --- |
| **Overall** | Identity, the Overall score, and one column per **contributing** domain — Blend and Analyst today. The other five technical factors are absent: a domain contributes once. | **Yes** |
| **Technicals** | Blend, Mom 12−1, Mom 6−1, Low vol, Max DD, S/R, then the readings: Mom 12−1, Mom 6−1, Vol 12m, Max DD, To supp, vs 200d, RSI 14, 52w pos, Bars | No |
| **Analyst** | Analyst, Raw rating, Mom., Cov Δ, Upside %, Insider, Distribution, Analysts | No |

**A domain section shows only its own data.** Each tab is a standalone view of
one way of looking at a symbol — the view it was before there was a registry.
Mixing every score into every tab turned three views into three arrangements of
the same twelve columns.

**Cross-domain filtering belongs to Overall**, because filtering across domains
is a cross-domain act and Overall is the cross-domain view. A technical
threshold silently removing rows from the Analyst tab made that tab misreport
its own coverage.

**A control that filters on one domain's data belongs to that domain's
section.** *Min analysts* is the first: analyst coverage is analyst-domain data,
so a thinly covered name is no reason to hide a row from Technicals, which has
no opinion about analysts, or from Overall, which filters through the panel
instead. It is declared in the analyst domain's `controls`, beside the columns
it acts on:

```js
controls: [{
  id: 'minAnalysts', label: 'Min analysts',
  min: 0, max: 99, step: 1, default: 10,
  active:   (v) => v > 0,
  passes:   (row, v) => (row.analysts ?? 0) >= v,
  describe: (v, excluded) => `${excluded} below ${v} analysts`,
}]
```

The board renders it, applies it, persists it and reports what it excluded
without knowing what "min analysts" means — `describe` is what puts *"177 below
25 analysts"* in the meta line. A new domain brings its own controls with it,
and they appear on its tab and nowhere else.

The header and the cells are generated from one column list, so a section
cannot render a heading with nothing under it; a test asserts every data column
declares its own cell renderer.

### Overall

The top section ranks every symbol by one number: the mean of every domain's
headline score, **each normalised to 0–100 by its own declared scale** before
anything is averaged. That normalisation is the whole trick — Analyst runs 1–5
and Blend runs 0–100, so averaging the raw numbers would make the analyst domain
almost invisible and the ranking would quietly be the technical one.

**Combination happens at the domain level, not the score level.** A domain
contributes **exactly one value however many scores it registers**, and it says
which by name:

```js
{ id: 'technicals', overallScore: 'blend', overallWeight: 1, scores: [ … ] }
```

This matters because Technicals registers **six** scores, five of them
single-factor views of the same price series. Counting *scores* would drown the
analyst domain six to one while looking like an even blend of two domains.
Naming the canonical score rather than taking `scores[0]` also means reordering
the array cannot quietly change what Overall means — and a domain naming a score
it does not own throws at load rather than falling back to something plausible.

**Every domain whose canonical score is not `failed` is included,
automatically.** Today that is Technicals → Blend and Analyst → Analyst; the
other five technical factors never reach Overall. A domain registered tomorrow
joins on its own.

**Weights are declared and shown.** `overallWeight` defaults to 1, so domains
are evenly weighted, and the weights are renormalised over the domains that
actually scored the symbol. The breakdown shows each domain's contribution *and*
its share — `Technicals 96 50% validated · Analyst 78 50% untested` — so when a
domain is missing and the other's share rises to 100%, that is visible rather
than silent.

Each contribution carries its status wherever the breakdown appears — the chip
beside the detail panel's tabs reads `Overall 87.3 · Technicals 96 validated ·
Analyst 78 untested` — so an untested input is visibly untested rather than
laundered into a single confident number.

Two honest limits, both surfaced rather than hidden:

- **Overall is averaged over the domains that scored the symbol**, not over all
  of them, so a name with no price history still ranks on what is known. That
  means rows can rest on different numbers of inputs, so the count travels with
  the score and the column shows `2/2`, `1/2` and so on.
- **Overall itself has never been backtested.** It is a way of asking "which
  names look good on everything I have", not evidence that the blend ranks
  better than its parts. `NOTES.md` records what happened the last
  time a weak input was averaged into a strong one. The filter panel remains the
  tool for "must clear every bar"; Overall is the tool for "rank everything at
  once". They answer different questions.

### The detail panel

Clicking a symbol anywhere opens **one panel with a tab per domain**. Each
domain declares its detail view once, in its registry entry, and that view
renders identically however the symbol was reached — Technicals always shows the
price chart and the Blend breakdown, Analyst always shows the recommendation
trend and the composite behind it.

Only the **opening tab** depends on where you clicked: from a domain section it
opens on that domain, and from Overall — which implies no domain — it opens on
Technicals. Data is fetched per open tab rather than per board, so switching
tabs loads lazily and a tab never spends an API call for a panel that is not on
screen.

### Status

`status` is the domain's standing as evidence, and it is load-bearing:

| Status | Sorts the board | Filterable | Backtest tab | Means |
| --- | --- | --- | --- | --- |
| `validated` | yes | yes | yes | measured here, and it held up |
| `external` | yes | yes | yes* | replicated in published work, never measured here |
| `untested` | yes | yes | yes* | nobody has measured it, here or elsewhere |
| `failed` | **no** | **no** | **no** | measured here and it did not hold up |

\* if it also has `pointInTime` data — see below.

**`failed` means display only.** The column still renders, because seeing the
number is how you would notice it starting to behave; but it cannot order the
board, cannot filter it, and gets no backtest tab, so it cannot quietly become
a signal again. Rehabilitating one is a one-word edit, which is deliberately
the same edit that records the decision.

**`external` grants nothing that `untested` does not.** The two rows above are
identical on every capability, and a test asserts they stay that way. It records
*whose* evidence a score rests on, not what the score is allowed to do —
borrowed evidence must not buy privileges here. It is also not a step toward
`validated`: only a measurement made on this board reaches that.

Every `external` score therefore carries two notes, enforced by test and shown
in the detail panel:

- **`evidence`** — what the outside support actually is.
- **`pathOut`** — what would move it, which differs sharply. `mom12`, `mom6` and
  `lowvol` are measurable and accumulate a window every six months of stored
  history. `analyst` is **not measurable at all**: the provider serves only the
  current recommendation trend, so it can only ever be validated forward from
  snapshots. Same tag, different exit.

A blend does not inherit its components' evidence: `blend` and `zblend` are
built from `external` factors and are themselves `untested`, because nobody
published those particular combinations — they were assembled here.

**Nothing holds `validated` and nothing is `failed`.** That is the honest state
of the evidence rather than an oversight; the reasoning and the numbers are in
`NOTES.md`, including a first measurement in which no score beat SPY
on a risk-adjusted basis.

One consequence worth knowing: with no failed score shipping, the `failed`
machinery has no live instance, so the tests that cover it demote a score inside
their own sandbox rather than relying on the registry to supply one.

**Status is not the same as testability.** `pointInTime` says whether the data
needed to score a past date exists at all. The analyst domain is `untested`,
which permits a backtest tab, but the app stores only the *current*
recommendation trend — there is no archive of what a symbol scored in 2024 — so
it gets no tab regardless. That is exactly why it is untested. A domain needs
both gates to be measurable.

### The filter panel, and the absence of a master composite

There is deliberately **no score that combines domains**. A number made from an
analyst rating and an RSI reading means nothing in either domain, and deciding
how much a 4.4 rating is worth against a 71 trend score is a question with no
honest answer.

What replaces it is intersection. Each filterable domain contributes an
independent threshold, and a symbol is shown when it clears every threshold
that is switched on — each domain keeps its own units and its own veto, and
none of them is ever put on a shared axis. The panel reports how many symbols
each filter passes and how many pass all of them together.

Two details:

- **An inactive filter is not a pass at zero — it is not asked.** A domain whose
  filter is off has no opinion.
- **"No score" is not "passes".** A symbol an active domain cannot score fails
  that filter. Treating a blank as a pass would admit exactly the names the
  filter exists to exclude.

The panel lives on the **Overall** tab, alongside a column for the Overall score
and one for each contributing domain — so the comparison it invites is on screen
next to the thresholds setting it. Domain sections do not filter; see
[What each section shows](#what-each-section-shows).

## The Technicals board

The top of the board card switches between two modes over the same symbols:
**Analyst** (everything above) and **Technicals**. They share a watchlist, the
sector filter and the first five columns; nothing else. The analyst composite
and the technical score are computed from different data on different scales
and are never averaged, blended or compared — a number made from both would
mean nothing in either domain.

| Column | What it is | Bars needed |
| --- | --- | --- |
| Mom 12−1 | Return over twelve months, ending one month ago | 253 |
| Mom 6−1 | Return over six months, ending one month ago | 127 |
| Vol 12m | Annualised standard deviation of daily returns over twelve months | 253 |
| Max DD | Largest peak-to-trough fall in closes over twelve months | 252 |
| To supp | Percent above the nearest support level below the price | 11 |
| vs 200d | *Display only.* Percent above (+) or below (−) the 200-day average | 200 |
| RSI 14 | *Display only.* 14-day relative strength index, Wilder's smoothing | 15 |
| 52w pos | *Display only.* Where the last close sits in its 52-week closing range | 2 |
| Blend, Mom 12−1, Mom 6−1, Low vol, Max DD, S/R | the six scores, 0–100 | — |

Every column sorts, and each mode remembers its own sort. **Min analysts does
not apply here** — it is an analyst-domain exclusion, and this board has no
opinion on how many analysts cover a name.

**Why momentum skips the most recent month.** Short-horizon reversal runs
against medium-horizon momentum: the last few weeks of a move tend to give
some of it back, and including them muddies what the previous five months
actually showed. Dropping the newest month is the standard 12−1 construction,
applied to a six-month window. The measured span is therefore ~5 months: it
opens 126 bars back and closes 21 bars back.

`52w pos` uses closing prices, not intraday highs and lows — those are not
stored, and keeping them would triple the storage budget below for a cosmetic
gain.

### One factor, one score

The domain is organised around **factors**, each registered as its own score so
it can be measured on its own. An earlier arrangement — a three-part `Long` and
a two-part `Short` — mixed factors of very different evidential standing inside
one number, so a weak component could neither be seen nor removed without
rebuilding the score.

| Score | Factor | Why it is here |
| --- | --- | --- |
| **Blend** | 0.5 × Mom 12−1 + 0.5 × Low vol | canonical; the two best-replicated factors, and they correlate 0.010 |
| Mom 12−1 | twelve-month return, last month dropped | the canonical momentum construction |
| Mom 6−1 | six-month return, last month dropped | the shorter horizon, kept as a control |
| Low vol | realised volatility, inverted | the low-volatility anomaly |
| Max DD | maximum drawdown, inverted | downside risk specifically |
| S/R | distance to nearest support | **experimental** — see below |

Four are single-term by design. A one-term weighted score looks redundant but is
not: it puts every factor through the same registry, the same renormalisation
and the same backtest tab, which is what makes the correlation matrix and the
spread comparisons like-for-like.

**Every score is `untested`.** Nothing here has been validated on this board.
`NOTES.md` records what the first measurement actually found, and it is not
flattering to the blend.

**RSI, vs 200d and 52w pos are display-only.** They were demoted out of the
scoring model: weak standalone evidence, and the 200-day gap correlated 0.76
with six-month momentum, so it was largely restating it. They render as columns
and nothing else — not registered scores, so they cannot sort, filter or be
backtested.

Every score is **absolute**. Each input is mapped onto a fixed 0–100 scale
before any weighting, so a given momentum figure produces the same number today,
tomorrow, and on a board of five names or five hundred. An earlier version
ranked cross-sectionally, which made a score meaningless to compare against
yesterday's.

The unbounded percentages go through a tanh curve —
`50 + 50 × tanh(value / k)`, with `MOM_K = 55`, `MOM12_K = 95` and `MA_K = 23`:

| Raw | Mom 6−1 → | Raw | vs 200d → |
| --- | --- | --- | --- |
| −80% | 5.2 | −40% | 3.0 |
| −40% | 18.9 | −25% | 10.2 |
| −20% | 32.6 | −15% | 21.3 |
| **0%** | **50.0** | **0%** | **50.0** |
| +20% | 67.4 | +15% | 78.7 |
| +40% | 81.1 | +25% | 89.8 |
| +80% | 94.8 | +40% | 97.0 |
| +150% | 99.6 | +60% | 99.5 |

That fixes what 50 means for a momentum factor: flat over the window. Above 50
is up.

### The three inverted factors

Volatility, drawdown and distance-to-support are all "lower is better", so each
is scored as **pivot minus reading**, through the same curve. The pivot is the
value that scores exactly 50; `k` is the distance either side reaching ~76.

| Factor | Pivot | k | 
| --- | --- | --- |
| Realised volatility | 30% annualised | 15 |
| Maximum drawdown | 30% peak-to-trough | 15 |
| Distance to support | 8% above support | 6 |

| Vol 12m | 10% | 15% | 20% | **30%** | 40% | 50% | 60% |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Low vol score | 96.4 | 90.5 | 76.2 | **50.0** | 23.8 | 9.5 | 3.6 |

Expressing the inversion once, in the sub-score, means every consumer downstream
can treat all six factors identically as higher-is-better. The null guards
matter here: `pivot − null` is `pivot`, not null, which would silently score an
unmeasurable name as if it had come in exactly average.

The pivots are assumptions, not measurements — set near where a broad US
large-cap board sits rather than at a round number. They should be revisited
against the board's real distribution.

### Support and resistance is experimental

A local extreme is a close that is the highest — or lowest — of the five bars on
each side. Extremes within 2% of each other merge into one level, and a level
counts only once **two** extremes agree on it. The score is the distance from
the price down to the nearest qualifying level; sitting on support scores high.

Three reasons it carries the `experimental` flag:

1. **No volume weighting.** The published construction weights levels by volume
   traded at them. The series store keeps closes and nothing else, so touch
   count stands in for volume. Adding real volume needs a schema change and a
   two-hour re-backfill, and was judged not worth it for a factor this weak.
2. **Closes, not intraday.** The literature's evidence is mostly intraday, where
   the levels actually form.
3. **It measured badly.** Its spread flips sign across the two windows — the
   same pattern that condemned the retired Short score.

A name at its lowest point in the window has no support beneath it, so the
factor is null rather than zero. That is 34 of 579 names on the current board.

**Why a curve and not a clamped ramp.** A clamp ties everything past its cap.
The earlier version capped momentum at ±60%, so every name up 60% or more
scored an identical 100 and stopped being distinguishable at exactly the end of
the range where the differences are largest. tanh compresses the tails instead
of amputating them: +80% and +150% still separate, and no input can ever reach
0 or 100 exactly. Signed square root was the alternative and was rejected — it
still ties at whatever reference it is clamped to.

`MOM12_K = 95` is larger than `MOM_K = 55` because twelve-month returns span
twice the window: the same `k` would push most of the board into the tails. It
reaches ~76 at +100%, roughly where +50% sits on the six-month scale.

```
Blend = 0.5 × mom12Score + 0.5 × volScore
```

Both terms gate on 253 bars, so in practice they are present together or absent
together and the renormalisation never quietly reduces the blend to one factor.

**Equal weights because nothing measured here justifies anything else.** A
fitted weight over one independent window would be curve-fitting, not tuning.

**The blend is not equally influenced by its halves, though.** It correlates
0.858 with its volatility term and 0.522 with its momentum term, because
volatility is the more dispersed of the two on this board. Equal weights on the
sub-scores do not buy equal influence — a term's weight does not determine its
influence, its *variance across the actual data* does. That lesson is older than
this arrangement: it is why the momentum and MA-gap curves exist at all.

### A term's weight is not its influence

The retired Short score is the cautionary case, kept here because the failure
mode generalises. It passed RSI and range position through raw:
`0.55 × (100 − RSI) + 0.45 × rangePos`, and ranked names at their highs as the
best entries — the exact opposite of its purpose:

```
extended (RSI 50, range 95):  0.55×50 + 0.45×95 = 70.3   ← won
pullback (RSI 35, range 70):  0.55×65 + 0.45×70 = 67.3
```

Real RSI clusters near 50, so the inverted term varied by only ~22 points across
the board while range varied by the full 45. Range decided the ranking despite
the smaller weight, and decided it in favour of being extended.

The current blend has the same shape of problem in milder form — see the
correlation figures above — and it is worth checking on any new pairing before
trusting the weights written in the source.

### Partial rows

Each indicator gates on its own window, so a symbol short of history shows the
columns it can support and blanks for the rest rather than disappearing. A
score is renormalised over whatever inputs exist, and withheld entirely below
`SCORE_MIN_WEIGHT` (0.5) of its weight — too little left to mean anything.

| History | Blend | Mom 12−1 | Mom 6−1 | Low vol | Max DD | S/R |
| --- | --- | --- | --- | --- | --- | --- |
| 300 bars | full | ✓ | ✓ | ✓ | ✓ | ✓ |
| 253 bars | full | ✓ | ✓ | ✓ | ✓ | ✓ |
| 252 bars | **none** | — | ✓ | — | ✓ | ✓ |
| 130 bars | **none** | — | ✓ | — | — | ✓ |
| 20 bars | **none** | — | — | — | — | ✓ |
| 3 bars | **none** | — | — | — | — | — |

Both blend terms need 253 bars, so the blend is present or absent as a whole
rather than quietly renormalising down to a single factor. The bar count is
shown in every row, greyed when it is below 200, with a tooltip naming what each
window needs.

### Symbols that are not scored at all

A partial row is one that cannot support every indicator. Separately, a symbol
can be excluded from scoring entirely because its data does not describe the
present:

| Condition | Shown as |
| --- | --- |
| No current quote — the board has no price for it | every column blank, bar count marked `· stale` |
| Price history stops more than 10 days behind the rest of the board | same, with the last bar's date in the tooltip |

Both mean the same thing in practice: the symbol has been delisted, halted or
renamed, and the data provider has stopped answering for it while the stored
series sits there looking complete. **A delisted name whose last print was a
takeover premium reads as 100% of its 52-week range forever**, with a full bar
count and a healthy-looking score, which is exactly the kind of row that scores
well and cannot be acted on.

The bar count is still reported, because when everything else in the row is
blank it is the only thing that explains why. The board meta line counts them
(`… · 2 not scored (no current data)`).

Note this guard is about presenting a *current* score. The backtest deliberately
does not apply it: there, a series that ended is legitimate history. What the
backtest does instead is exclude any symbol without a complete forward window,
which is its own — documented — source of survivorship bias.

The board meta line reports how many names sit out where the curve compresses
hardest — beyond ±60% momentum or ±25% on the MA gap (`… · 12 beyond ±60%
momentum`). These are the same names the old clamped ramps tied to an identical
0 or 100. The readout is kept after the switch to tanh because it is the
measurement that justifies the curve: a handful and a clamp would have been
fine, a crowd and it was not.

## Backtest

Does a high score at some past date actually precede a better return? The
**Backtest** view in the top bar answers that against the stored price history.

Pick a holding period and a spacing, and it runs the study at every start date
the history supports, newest first. Each run buckets symbols by their score
**at that date** and reports count, average and median forward return, plus the
gap to an all-symbols baseline. Each backtestable score gets its own tab — Blend,
Mom 12−1, Mom 6−1, Low vol, Max DD, S/R — plus Combined.
Several start dates are shown at once deliberately: one table is an anecdote,
and a pattern that holds across a dozen spaced runs is worth more than a big
number in any single one.

**The header says how many of the windows are independent.** When `Every` is
smaller than `Hold` the windows overlap — at a six-month hold and a one-month
spacing, five sixths of each window is the previous one — so the run count
reports rows rather than trials. The header then reads *"8 start dates ·
overlapping, 2 independent"* and is highlighted, because a ten-row reading of
two years once got mistaken for ten tests. Set `Every` equal to `Hold` for a
sample you can count.

How many windows you get is set by how deep the stored history actually is,
which is a **plan** question rather than a settings one — see
[History depth is a plan limit](#history-depth-is-a-plan-limit). At a six-month
hold and a six-month spacing, ten years of stored bars yields **18
non-overlapping windows** (2017-08 to 2026-02); Polygon's free two years yields
**two**. The run cap is 24, so the three-month setting fills it rather than
being cut short.

**The oldest start date leaves room for the longest indicator.** The floor sits
ten months after the first stored bar, not one — the 200-day average needs
about that long before it says anything, and a start date closer to the
beginning scores Short and nothing else, producing a run with Long and Combined
blank in it. That trade costs two windows and buys eighteen where every column
is populated, which is what the comparison across the three scores needs.

### The combined score

> **Currently degenerate, and deliberately kept.** Combined is the plain average
> of every score marked `combinable: true`. Today `blend` is the only one — the
> analyst rating is on a 1–5 scale that does not average with a 0–100 one — so
> **Combined is presently identical to Blend**. It is apparatus waiting for a
> second combinable domain, not a signal. See `NOTES.md`.

The rest of this section describes what it is for.

**Combined** is the machinery for averaging comparable scores and asking whether
the average ranks better than its inputs. That machinery is what a newly
registered domain gets tested with — fundamentals being the likely candidate —
which is why it stays in the Backtest view rather than being tidied away.

It has been exercised twice on this board and **lost both times**: the retired
Long+Short average lost to Long alone, and the current momentum+volatility Blend
lost to momentum alone. The second result is the more informative, because those
two factors are genuinely uncorrelated (ρ = 0.010), which was supposed to be the
condition under which averaging helps.

It is defined **only when every combinable score exists**. Falling back to
whichever one is present would file a partially-scored name into the same bucket
as a fully-scored one, and the bucket would stop meaning a single thing.
One-sided names are counted and named in the run header instead.

Note that this is a different question from mixing the analyst composite with a
technical score, which the app never does — those two are computed from
different data on different scales, and their average would mean nothing in
either domain.

### Spread, and why the buckets can be cut two ways

Above the per-date tables is one row per start date and one column per score,
each cell the **top bucket's average return minus the bottom bucket's**. That
is the single number saying whether a score ranked the period at all: positive
means the names it liked most beat the names it liked least, and negative is an
**inversion** — the ranking ran backwards. The footer gives the average spread
and counts how many periods inverted, which is the comparison the combined
column exists for.

**This table does not follow the tab, and that is deliberate.** It already shows
every score as its own column, so there is nothing for a tab to switch; the tab
picks which score gets the per-date bucket tables *below*. Because "I clicked a
tab and the top table did not change" reads as a bug, the selected score's
column is highlighted — the tab visibly points at a column already on screen
rather than at nothing.

The footer is taken over the start dates where **all three** scores exist, and
says so when that is fewer than the dates shown. Short outlives the other two at
the old end of the history — RSI needs 15 bars where six-month momentum needs
127, so the earliest runs score Short and nothing else, and Combined needs both.
Averaging those extra dates into one column would put three different samples on
a row whose entire purpose is comparing them.

That comparison only works if the columns describe comparable groups, and with
the fixed bands they do not. Averaging two scores that disagree as often as
Long and Short pulls the result toward 50 — roughly a √2 contraction — so the
80–100 and 0–20 bands catch a handful of names for the average where they catch
dozens for either input. Measured on this board at 2026-05-28: a combined top
band of **2** symbols against a bottom band of 12, next to Long's 38 against 32,
which produced an apparent +77% spread out of pure sampling noise.

So the **Buckets** control offers both cuts:

| | |
| --- | --- |
| **Equal fifths** (default) | Ranks each score and cuts it into five groups of the same size. Thresholds stop being comparable — a quintile boundary sits at a different score for each — but the group sizes match, which is what has to hold before two spreads can be set side by side. |
| **Score bands** | The fixed 80–100, 60–80, 40–60, 20–40, 0–20 ranges. The same score always lands in the same row, which is what you want when reading one score on its own. Read down a column, not across. |

Switching between them re-renders from the cached runs; it changes how a run is
cut, not what it measured.

### The sector cap

**Max/sector** keeps at most N symbols per sector in any one group, taking the
highest-scoring in each. It applies to the board and to every backtest bucket
from one setting, so "with it" and "without it" mean the same thing in both
places. `0` turns it off, which is the default — it changes what is being
measured, so it should be a deliberate choice.

It applies to a **group**, not to the universe: on the board the group is the
sorted result, in the backtest it is each bucket, and the fifths are cut
*before* the cap so it never moves a name from one bucket to another — only
drops it from the one it was already in. Capped buckets therefore stop being
equal-sized, and the count of what each dropped is reported alongside.

**A caveat for backtest use**, measured and recorded in `NOTES.md`:
taking the highest-scoring per sector in *every* bucket keeps the best names in
the top bucket but the *least bad* ones in the bottom, which shifts the bottom
bucket's mean score upward and inflates the spread. On the board — where you
want the best names shown — highest-scoring is unambiguously the right rule.

### Benchmarks

Each run table carries two comparison columns, and they answer different
questions:

| Column | Asks |
| --- | --- |
| `vs all` | Did this bucket beat the rest of the board over the same window? |
| `vs SPY` | Did it beat simply holding the index? |

A bucket can clear the first and fail the second — the board is 579 individual
stocks and can drift well away from the market — which is why both are shown.
The footer adds an `SPY` row giving the raw index return, so the numbers the
subtractions come from are visible rather than implied.

**SPY is not in the universe.** `universe.js` is 579 individual stocks and holds
no ETFs, so the benchmark is fetched as *reference data*: it lives in the same
IndexedDB series store, costs one extra Polygon call at the front of the
backfill, and is deliberately excluded from `state.symbols`. That exclusion is
what every board and backtest loop iterates, so the benchmark can never appear
as a row, be scored, be filtered, or land in a bucket. Adding it to the
watchlist instead would have failed twice: Finnhub's `/stock/recommendation`
returns nothing for an ETF, so it would be dropped as uncovered, and a yardstick
has no business being ranked among the things it measures.

Set `BENCHMARK` to `null` to run without one; the columns disappear rather than
showing zeroes. They also stay hidden until the backfill has actually stored the
benchmark, since a column of dashes is noise.

#### Why the spread table is not benchmarked

The spread is top-bucket return **minus** bottom-bucket return, so any benchmark
common to both ends cancels exactly: `(top − SPY) − (bottom − SPY)` is the same
number as `top − bottom`. A "vs SPY" spread column would be a copy of the column
beside it. The spread is already market-neutral by construction, which is
precisely what makes it the right thing to read across periods.

What a benchmark adds there is **context**, not subtraction. The spread table's
last two columns give the all-symbols and SPY returns for each window, so a
+20% top bucket in a quarter when everything rose 18% reads as what it is. They
are set off by a rule and are not scores — per-bucket benchmarking, where the
subtraction does not cancel, is in the run tables.

**The point-in-time guarantee.** `technicalsAsOf` slices the close series at
the start bar and hands the ordinary indicator code a shorter array. Future
bars are not hidden from the scoring — they are not in the array at all, which
is the only kind of lookahead guarantee worth having. `app.test.mjs` covers it:
it scores a series at its peak, appends a crash, and asserts the score at the
original last bar is unchanged.

**Both ends of the holding period are located the same way.** The entry and
exit bars each come from `barIndexOn`, so the period is a true calendar span in
that symbol's own series. Converting months to a fixed bar count instead would
assume ~252 trading days a year and quietly overrun the end of any series
holding fewer — a halted name, or one the backfill has not finished.

**What is excluded, and why:**

| | |
| --- | --- |
| No stored history | Nothing to measure. |
| History starts after the start date | A recent listing has no score at that date; measuring it from its first bar instead would silently compare different periods. |
| No complete forward window | A part-elapsed period measured against full ones flatters whichever bucket got less time. |
| No score at the start date | Too little history for the indicators that score needs. |

Each is counted separately and the total is shown per run (`120 symbols · 8
skipped`).

**A caveat that does not go away.** Bar positions are interpolated between the
first and last stored dates, because per-bar dates are not stored (see the
storage table above). Trading days are near-uniform, so the error is a handful
of bars across ten years — immaterial at bucket level, but this is not a
tick-accurate backtest. Nor is it a strategy: there are no costs, no slippage,
no survivorship correction, and the sample is one watchlist over whatever
window the history happens to cover.

### Backfilling the price history

Polygon is the only connected source with no daily ceiling, so it is the only
one that can cover the whole board: 5 calls a minute, one call per symbol for
the entire **ten-year** range. The lack of a daily cap is what makes ten years
affordable at all — only the per-minute rate matters, and that is a question of
patience rather than budget.

**579 symbols is about 116 minutes for a cold pass**, unchanged by the wider
window: it is one call per symbol either way, just a larger response. It runs
in the background with its own progress bar and ETA, stopping is safe, and
starting again resumes at the first symbol that still needs bars. Switching to
a domain that declares `needsPrices` starts it automatically if a Polygon key is connected and
anything is missing. Rows fill in as they arrive.

#### Only what is missing

A stored series can be short at **either end**, and each gap is its own
request, so neither re-downloads bars already held:

| Gap | When | Asked for |
| --- | --- | --- |
| Older | The window widened from two years to ten, or the series came through the migration | The floor up to the day before the first stored bar |
| Newer | Time passed | The day after the last stored bar up to today |

On a typical day there is no gap at all and no call. A symbol checked within 12
hours is skipped entirely, so a weekend does not re-ask for all 579.

#### History depth is a plan limit

`PX_YEARS = 10`, but **Polygon's free plan serves two years and refuses the
rest.** A request whose whole window is older than that comes back `403
NOT_AUTHORIZED` — *"Your plan doesn't include this data timeframe"* — which is
exactly the shape of the backward-extension request, so on a free key every
migrated symbol's older gap is refused.

A request that merely *starts* too early is not refused; it is silently clipped.
Asking for 2016→today on a free key returns HTTP 200 with 500 bars beginning
two years ago, not an error. That is worth knowing before trusting a `from`
date: the only way to find the real depth is to ask for a window entirely
inside the disallowed range and read the 403.

The client learns the limit rather than fighting it. The first 403 on an older
window sets `state.px.historyLimited`, and from then on the run stamps each
remaining symbol's `bf` at the floor **without spending a call** — the plan has
already given its answer, and confirming it 400 more times at five calls a
minute would cost an hour and a half to learn nothing. A 403 on the older
window does not stop the newer one being fetched, and it is not treated as a
failure in the run summary, because nothing failed: the plan served everything
it has.

Two consequences worth stating plainly:

- **On a free key the backtest has two years to work with, not ten.** That is
  ~2 non-overlapping six-month windows, not ~18. The ten-year figures elsewhere
  in this file describe a paid plan.
- **After upgrading a plan, clear the price history.** Stamped symbols record
  the floor as already requested, so they will not re-ask on their own. Clearing
  and re-running is the way to pull the deeper history in.

**`bf` is what stops the older gap re-asking forever.** It records the oldest
date ever *requested* for a symbol, which is not the same as the oldest bar
held. A 2021 listing has no 2016 bars and never will, so testing the first
stored bar against the floor would mark it short on every single pass and spend
a call each time. Recording what was asked for settles it once — including when
the answer is an empty response, which is a valid "not listed yet".

Two details in the merge worth knowing, both covered by tests:

- **Truncation keeps the newest bars**, so prepending more than the cap allows
  would discard exactly the bars the call was made for. The incoming head is
  trimmed instead, and `f` is taken from the oldest bar that actually survives —
  its real date, straight off the response.
- **Date and close are carried and filtered together.** Reading the date off the
  raw response while the closes come from a separately filtered array lets one
  dropped bar shift every date by one position.

#### Only closes are stored

Measured across 579 symbols at two years:

| Encoding | Size | |
| --- | --- | --- |
| `[{t, c}]` objects | 17.3 MB | over budget |
| `[t, c]` pairs | 12.7 MB | over budget |
| **closes only** | **3.7 MB** | fits |

The timestamps were the entire problem, and not one of the four indicators
needs a calendar date — they all work in positions along the series. So a
record holds `{ f, t, c, at, bf }`: the first and last bar's date, the closes
between them, when the symbol was last checked, and the oldest date ever
requested for it. The dates are there so an incremental fetch knows where to
resume, not for the maths.

The raw Polygon response is deliberately **never** cached. It carries open,
high, low, volume and VWAP for every bar — roughly ten times what the series
store keeps.

#### Why the series live in IndexedDB

Closes alone were enough at two years. They are not at ten: 579 symbols ×
~2,520 bars is **18.4 MB**, and localStorage tops out at **9.7 MB** on this
origin — probed by growing a scratch key until it threw, not assumed.

Compression does not rescue it. Delta-encoding the closes as cents in base36
was measured at **1.89×** over 29,667 real bars with an exact round-trip, which
lands at 9.6 MB: under the ceiling on paper, and with 99% of the budget spent
and nothing left for the Finnhub symbol cache, unusable in practice.

So the series moved to **IndexedDB**, which is quota-managed against the
origin's storage budget — gigabytes rather than megabytes. Some things fell out
of that move for free: IndexedDB stores structured clones, so an array of
numbers goes in as an array of numbers with no `JSON.stringify` on write and no
parse on read, and the same 446 series that took 2.78 MB of localStorage
occupy 2.03 MB there.

**Only persistence is async.** `state.px.series` is still a plain in-memory
`Map`, filled once at boot and read synchronously by every indicator, the board
and the backtest. Nothing downstream of the storage functions changed.

The read does not block the first paint. `hydrateSeries()` is deliberately not
awaited by `init()` — the wiring and the first render happen while IndexedDB is
still opening, and the board and backtest re-render when the series land.
Until they do, `state.px.hydrated` is false and the backfill refuses to start,
because an empty `Map` makes every symbol look uncovered and would refetch a
board that is already stored.

**Migration is one-way and runs itself.** Anything still under a `bar.px.*`
localStorage key is moved on first load, ordered so an interruption repeats
work rather than losing it: every record is written and the transaction
committed *before* a single localStorage key is removed. Rebuilding instead
would cost one Polygon call per symbol at five a minute — about 90 minutes to
recover bars already on disk. Migrated records carry no `bf`, which is what
enrols each of them in exactly one backward extension.

## Views

**The table's horizontal scrollbar is at the top.** With ~580 rows the bottom of
the board is thousands of pixels down, so a scrollbar rendered there was
effectively unreachable — you had to scroll the page to its end to scroll the
table sideways. `.table-scroll` is flipped vertically and its contents flipped
back, which puts the scrollbar at the visual top with the content upright.
`rotateX` mirrors the Y axis only, so left/right scrolling is unaffected.

The caveat, noted in the CSS: the transform creates a containing block, so a
`position: sticky` element *inside* the scroll container would anchor to it
rather than to the viewport. Nothing there is sticky today. If a sticky column
header is ever wanted, this needs replacing with a synced scrollbar element.

The board, the score history and one symbol's detail are **three mutually exclusive
views** of the main column, switched through `showView()`. None of them stacks under
another, because with ~580 rows on the board anything appended below it opens some
27,000px off-screen and the click reads as a no-op.

Leaving the board saves the scroll position; coming back restores it, so opening a
symbol two-thirds of the way down the list and backing out returns you to the same
place rather than the top. **← Board** in the panel header and the **Esc** key both go
back (Esc is ignored while typing in the search box, which already uses it to dismiss
the suggestion list).

## The detail panel

Clicking a row opens a panel. **What it shows follows the board's mode**, because
on the Technicals board the analyst breakdown describes a model the board is not
using. The header — logo, name, price, day change — is shared; the body is
replaced, not appended to.

### In Analyst mode

Four stacked sections plus a snapshot sidebar.

**Price · 6 months** — a line chart of daily closes from `/stock/candle`, drawn as
inline SVG with no charting library. Coloured by net direction over the window, with
the period change, high, low and session count above it. Premium endpoint, so it
degrades to a message rather than an empty box: *"not available on your Finnhub
plan"* after a 403, *"no price history available"* when the symbol returns nothing.

**Recommendation trend** — the stacked bar chart, unchanged.

**Monthly records** — the numbers behind those bars. One row per month Finnhub
returned (up to six), newest first: the analyst count in each bucket, the total, that
month's own raw weighted mean, and its standard deviation. The month momentum is
measured against is tagged `base` and shaded, so the momentum term in the breakdown
can be checked by eye against the two rows it comes from.

**Score breakdown** — every term of the composite and what it contributed:

| Term | Input | |
| --- | --- | --- |
| Level (base) | raw 4.23 over 26 analysts, shrunk toward 3.8 (m=5) | 4.16 |
| Momentum | +0.31 vs May 2026, capped at ±0.25 | +0.25 |
| Agreement | 83% (σ 0.35), 75% pivot × 0.5 | −0.09 |
| Upside | +14.5% to 265.00, capped at ±0.30 | +0.15 |
| **Composite** | sum of the terms above | **4.47** |

The column adds up. Each row states its own input and cap, so a surprising score can
be traced to the term responsible without reading `rate()`. When a name's adjustments
carry it past the 1–5 clamp, the total row shows the unclamped value and a note
explains the bound.

The sidebar keeps what the breakdown does not cover: price target, insider activity,
coverage, sector, industry, market cap and the day's quote.

Company profile and candles are fetched lazily, on first open, and held **in memory
only** — unlike the per-symbol cache, they are not written to `localStorage`. They are
cheap to refetch and only ever touched for names actually looked at, which is not
worth spending the storage budget the score log now needs.

### In Technicals mode

Two sections and a snapshot, all of it drawn from data already on disk.

**Price · N stored bars** — the same inline-SVG chart, but fed from the stored
Polygon series rather than `/stock/candle`. It reaches ten years back instead of
six months, it costs no API call, and it does not depend on a premium endpoint —
so the Finnhub candle request is skipped entirely while this panel is the one on
screen.

**Score breakdown** — each factor, its reading, its 0–100 sub-score, its weight,
and what it actually contributed. For the canonical Blend:

| Factor | Reading | Sub-score | Weight | Contribution |
| --- | --- | --- | --- | --- |
| Momentum 12−1 | +41.2% over 252 bars, last 21 excluded · tanh k=95 | 69.9 | 50% | 35.0 |
| Realised volatility 12m | 24.8% annualised · inverted about 30%, tanh k=15 · calmer scores high | 60.0 | 50% | 30.0 |
| Momentum 6−1 | +26.5% — the shorter horizon, left out of the canonical blend | — | 0% | — |
| Max drawdown 12m | −18.4% — expected to restate volatility; out until the matrix says otherwise | — | 0% | — |
| **Blend** | sum of the contributions above | — | 100% | **65.0** |

The contribution column adds up to the score on the board. `weightedScore`
renormalises over the weights actually present, so when a factor is short of
bars the weight column shows the shift — `50% → 100%` — and a note says why.
That is the only thing that makes the column trustworthy on a partial row.

**Excluded factors are listed and explicitly zeroed** rather than omitted. They
are on the board, so their absence from this table would read as an oversight
rather than as the decision it is — and the `excluded` line on each says which
decision. Seeing what a model left out is as informative as seeing what it used.

The sidebar carries every score, all the indicator values, the bar count and
roughly how many years it covers, the span the stored series covers, the oldest
date ever requested for it, and whether the symbol is being scored at all — a
stale or unpriceable series says so here rather than showing blank columns.

## Score history

Every time a ticker is fetched from the API, one record is appended to
`localStorage` under `bar.history`:

```
[symbol, ISO timestamp, composite, raw consensus, analyst count, price]
```

At most **one record per symbol per calendar day** (local time) — a second fetch the
same day is skipped. The **History** button in the top bar opens a per-symbol table of
past readings with the price change from each one to the current price, preselecting
the last symbol you opened. If the symbol is no longer on the board, the comparison
falls back to its most recent recorded price.

Records are written only on a genuine API fetch, never on a load served entirely from
cache — replaying yesterday's reading under today's date would record a price that was
never observed today. A refetched quote alone still counts, since the price is new
even when the trend was reused. In normal use the 24h quote TTL means each symbol is
fetched about once a day, so history accrues at roughly one record per symbol per day.

The log is capped at `HISTORY_MAX` (18,000) records, oldest dropped first.

> **The cap is about a month of history.** At ~580 symbols logging daily, 18,000
> records fills in `18000 / 580 ≈ 31` days, after which the oldest days fall off.
> That is roughly 1.1 MB of the ~5 MB `localStorage` budget, alongside ~200 KB of
> symbol cache. A shorter watchlist stretches the same cap proportionally further —
> a 100-ticker board gets about six months out of it.

Writes are batched to the end of each load batch, with a final flush on `pagehide`.
**Clear history** in the History view empties the log.

### Score buckets

The History view has two tabs. **By symbol** is the table above — one name's
readings over time. **Score buckets** is the aggregate, and it asks the only
question that tests the model: on some past day, did the names it scored highly
go on to beat the ones it scored poorly?

Pick a date from the dropdown. For every symbol logged that day, the return is
measured from its logged price to its current board price, and the symbols are
grouped by what they scored *that day*:

| Composite band | Symbols | Avg return | Median return |
| --- | --- | --- | --- |
| 4.2 + | 41 | +6.81% | +5.30% |
| 4.0 – 4.2 | 88 | +3.91% | +3.44% |
| 3.8 – 4.0 | 132 | +2.05% | +1.90% |
| below 3.8 | 154 | +1.62% | +0.98% |
| **All symbols** | **415** | **+2.74%** | **+2.11%** |

The bands are half-open — `4.2+` is `>= 4.2`, `4.0 – 4.2` is `>= 4.0` and
`< 4.2` — and their edges sit where the board actually clusters. `PRIOR` is 3.8,
so a name with no signal of its own shrinks into the bottom band; 4.2+ is
roughly the top decile. Wider bands would put most of the universe in one row
and answer nothing.

The **All symbols** row is the control. A band's return means nothing on its
own — the whole market moved over the window — so the claim being tested is
whether the top band beats *that* row and the bottom band trails it. Median sits
beside average because a single name that doubled will carry a bucket's mean on
its own; when the two disagree, the median is the one describing the typical
symbol.

The dates come from the log, so the horizons on offer are whatever has been
recorded — the list starts empty and grows one entry per day the board is
loaded, up to the ~31 days the record cap holds. The oldest date is selected by
default, being the longest horizon on file.

A symbol contributes only if the board is currently pricing it. Names that have
since been removed from the watchlist, or dropped for losing coverage, have no
second price to measure against; they are excluded and counted in the header
(`… · 8 skipped (not on the board)`) rather than folded in as zero. Records with
no composite or no price at the time they were logged are not measurable either
and are left out silently.

This is a description of what happened, not a backtest. The window is whatever
the log happens to span, the sample is one board, there is no benchmark beyond
the board's own average, and survivors are the only names measured. It answers
"did the high scorers outperform here", not "does the score work".

## How the scoring works

Each rating bucket carries a weight: Strong Buy 5, Buy 4, Hold 3, Sell 2, Strong
Sell 1. The **raw score** is the plain weighted mean of the current month's ratings —
what the analysts literally said — and it drives the Buy/Hold/Sell chip:

> ≥4.5 Strong Buy · ≥3.5 Buy · ≥2.5 Hold · ≥1.5 Sell · else Strong Sell

The **composite** is what the board ranks by. A raw mean is a bad ranking key on its
own: analyst ratings skew bullish market-wide, and a name covered by two analysts is
not comparable to one covered by forty.

**The composite is not a weighted average.** `level` is the base, and the other
three terms are additive adjustments to it. There are no percentage weights
anywhere in the model — a term's influence is set by the size of the adjustment
it is allowed to make, which is why each one below is described by its range
rather than by a share.

### 1. Level — the base

The raw mean shrunk toward a prior, so thin coverage is pulled back rather than
scoring a spurious 5.00:

```
level = (raw × n + PRIOR × m) / (n + m)        PRIOR = 3.8, m = SHRINK_M = 5
```

`PRIOR = 3.8` approximates the market-wide average rating (analysts really are that
bullish). `SHRINK_M = 5` is the shrink strength in "pseudo-analysts": a name with 5
analysts sits halfway between its own mean and the prior; at 40 analysts the pull is
slight. Two analysts unanimously at Strong Buy give `raw = 5.00` but `level = 4.14`.

`shrink()` and `rate()` both take `m` as an optional last argument, so the same
cached data can be rescored at a different shrink strength to compare tunings
without refetching.

Note that changing `m` does **not** move the thinnest names the most. The shift is
`(raw − prior) × [n/(n+m₂) − n/(n+m₁)]`, which peaks at `n = √(m₁·m₂)` — around 7
analysts for a change between 10 and 5. Very thin names stay heavily shrunk under
either setting; it is the *moderately* covered names that move furthest.

### Coverage threshold

The **Min analysts** control excludes thinly covered names, defaulting to **10**.
Clear the box for no threshold; the setting persists in `localStorage`.

It appears **only on the Analyst tab**, because analyst coverage is
analyst-domain data — see [What each section shows](#what-each-section-shows).
Technicals and Overall are unaffected by it, so a name too thin for a
recommendation consensus still shows up where it is being scored on price.

### 2. Momentum — capped at ±0.25

`level` now, minus `level` at the trend record closest to **3 months** earlier
(records at least 2 months back only, matched on date rather than array index so
sparse months don't skew it). Positive means net upgrades.

The adjustment is the drift itself, clamped to **±0.25**. It is a tiebreaker, not a
driver: an earlier version used a ×3 multiplier and a ±1.00 clamp, which let a
Hold-rated name with one upgrade wave score above genuinely Buy-rated names and run
off the top of the scale.

> **What this actually resolves to, measured 2026-09-01.** Finnhub returns
> exactly **four consecutive months** for every symbol on the board — 575 of
> 575. So the eligible baselines are the record 2 months back and the one 3
> months back, and the second always wins. The baseline is **always** the oldest
> of the four, never "usually": the date-matching search has never once chosen
> between candidates. It is kept for a sparse history that this provider does
> not produce.
>
> The 3-month lookback is not real either. Consensus is sticky — 74% of symbols
> carry a duplicate consecutive month, 42% have a newest month identical to the
> one before — so the genuine separation between the two records averages
> **1.72 months**. The momentum term is correspondingly small: median magnitude
> **0.036** rating points, exactly zero for 80 of 575 names, and reaching the
> ±0.25 cap for 23. Treat this score as the shrunk level; the momentum term is
> close to inert. See `NOTES.md`.

### 3. Agreement — spans −0.375 to +0.125

`1 − σ / 2`, where σ is the population standard deviation of the rating distribution
on the 1–5 scale and 2 is its maximum (half at Strong Sell, half at Strong Buy).
Unanimous coverage scores 1.0; a 20/20 split scores 0.0.

That figure is then turned into an adjustment as `(agreement − 0.75) × 0.5`, so
the pivot is at 75% agreement: above it the term helps, below it the term hurts.
The range is deliberately lopsided — unanimity earns at most +0.125, while a
badly split book can cost −0.375. It is a nudge, not a lever.

### 4. Upside — capped at ±0.30

`(targetMean − price) / price`, from `/stock/price-target`, used directly and
clamped. A name needs +30% implied upside to earn the full +0.30, so it nudges the
ranking without overturning the analyst consensus. A missing target contributes
**zero**, not a penalty.

### Combining

Level is the **base**; the other three are **additive adjustments** to it:

```
composite = clamp(
    level + clamp(momentum, ±0.25) + ((agreement − 0.75) × 0.5) + clamp(upside, ±0.30),
    1, 5)
```

A symbol with no usable baseline simply gets no momentum adjustment — zero, not a
penalty, and nothing is redistributed to the other terms.

Taken together the three adjustments can move a name at most **+0.675 / −0.925**
off its level, against a level that itself sits between 1 and 5. The base is
meant to dominate, and it does.

An earlier version averaged all four as absolute scores on a [0, 1] axis. That
compressed everything toward the prior, because momentum and agreement sit near
their own midpoints for almost every name and so dominated the mean. As adjustments
they move a name off its level instead of diluting it — across a representative set
of cases the spread widened from 1.63 rating points to 3.38.

**The composite is held to 1–5**, the same axis as the raw mean, so it is always
readable against the rating it came from. The unclamped sum is kept alongside it
(`compositeUnclamped`), and the detail panel's **Score breakdown** shows it, with
a note, on the rare name where the bound actually bites. The composite is a
ranking key rather than a rating: the Buy/Hold/Sell label still comes from the
raw mean, not from this.

### Caveats

- Agreement rewards unanimity, which thin coverage achieves trivially — it partly
  offsets the shrinkage penalty it is meant to complement. At the current 0.10 weight
  a 2-analyst unanimous Strong Buy still scores about the same as a 60-analyst
  bullish mega-cap. Weighting agreement by a confidence factor `n / (n + m)` would
  close that gap.
- Every analyst counts equally. Finnhub's free tier gives aggregate monthly counts,
  not per-analyst calls, so there is no way to weight by track record here.
- Momentum needs history. The free tier returns roughly 4 monthly records, so the
  baseline is usually the oldest one available.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and layout |
| `styles.css` | Design tokens, light/dark themes, all styling |
| `universe.js` | The 579-ticker list with names and GICS sectors |
| `app.js` | API client, rate limiter, cache, scoring, rendering |
| `app.test.mjs` | Unit tests for the scoring and backtest maths (`node --test`) |
| `docs/NOTES.md` (private, not in the repo) | What was tried and what it turned out to be worth — the backtest verdict on each signal |
| `serve.ps1` | Optional local static server |
| `Bolt.bat` | Double-click launcher: starts `serve.ps1`, opens the browser |

`universe.js` is a point-in-time snapshot. Tickers get acquired, renamed and
delisted; anything Finnhub no longer recognises returns no data and is dropped
silently, so the list degrades quietly rather than breaking.

## Not investment advice

Analyst ratings are opinions, are frequently stale, and are skewed toward *Buy*
across the market as a whole. This is a data viewer, nothing more.
