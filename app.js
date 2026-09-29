/* Bolt — a browser client for Finnhub's analyst data.
   No build step and no framework. Runs two ways, decided once at boot by
   detectServer(): behind serve.mjs, which holds the keys and proxies Finnhub,
   SEC EDGAR and Anthropic; or as a plain static site (GitHub Pages), where the
   visitor enters their own Finnhub key and the two proxied-only features —
   fundamentals and Assess — are switched off. See API below. */

'use strict';

/* Finnhub is reached through the local proxy, never directly. The key is set as
   FINNHUB_API_KEY on the server and attached there as an `X-Finnhub-Token`
   header, so it is in no URL this page builds — nothing in the console, the
   network panel, a HAR export or a screenshot of any of them carries it.

   The header form cannot be used from the page itself even though Finnhub
   supports it: finnhub.io answers a CORS preflight with no
   Access-Control-Allow-Headers at all, so a browser blocks any request
   carrying a custom header. Server-side there is no preflight, which is why
   this works here and would not work from here. */
const API = '/finnhub';

/* STATIC MODE ONLY. With no serve.mjs behind the page (GitHub Pages), Finnhub
   is called directly with the visitor's own key as a `token` query parameter.
   That is the one form a browser can send: a plain GET with no custom header
   needs no preflight, and finnhub.io answers it with Access-Control-Allow-Origin
   `*` (measured 2026-09-01 — see the probe table in the notes). The cost is the
   exposure the proxy exists to remove: the key is in the visitor's own URLs,
   devtools and HAR exports. Acceptable for a free-tier key the visitor chose to
   paste into their own browser; not a reason to change proxy mode. */
const FINNHUB_DIRECT = 'https://finnhub.io/api/v1';

/* SNAPSHOT MODE: static mode with no key. The board is drawn from a dated copy
   of a real board, published beside the page (tools/build-snapshot.mjs builds
   it), so a first visitor sees a working board with no setup. The key gate
   stays available for live data. Relative, so it resolves under a Pages
   project path (/bolt/data/snapshot/...). */
const SNAPSHOT_BASE = 'data/snapshot/';

/* One id per page load, sent on every proxied call so the proxy can report how
   many browser contexts are spending the key — see the 429 diagnostics below.
   Random per load and never persisted: it names a tab for the life of that tab
   and nothing else. */
const CONTEXT_ID = Math.random().toString(36).slice(2, 10);

/* detectServer()'s answer, as a promise, set by init(). Anything that would call
   a serve.mjs-only path during boot waits on it instead of firing blind: on
   GitHub Pages, `/sec/...` and `/anthropic/...` resolve against the visitor's
   github.io origin and just 404 into their console. Null before init — callers
   treat that as proxy mode, which is what the test sandbox needs. Declared up
   here, above `state`, because code reachable from `state`'s initialiser reads
   it (see the temporal-dead-zone note in docs/NOTES.md). */
let serverDetected = null;

const LS = {
  key:       'bar.apiKey',
  watchlist: 'bar.watchlist',
  theme:     'bar.theme',
  sort:      'bar.sort',
  universe:  'bar.universeVersion',
  entry:     'bar.t.',              // per-symbol cache prefix: bar.t.AAPL
  history:   'bar.history',
  minAnalysts: 'bar.minAnalysts',   // legacy; migrated into LS.controls
  controls: 'bar.controls',         // per-domain section controls, see loadControls
  sectorCap: 'bar.sectorCap',       // max symbols per sector in a group, 0 = off
  plan:      'bar.plan',
  provKey:   'bar.key.',            // secondary provider key:   bar.key.fmp
  provUsage: 'bar.usage.',          // today's spend:            bar.usage.fmp
  provEntry: 'bar.p.',              // response cache: bar.p.fmp.quote.symbol=AAPL
  px:        'bar.px.',             // daily closes:   bar.px.AAPL
  boardMode: 'bar.boardMode',
  filters:   'bar.filters',         // per-domain thresholds, see loadFilters
  sec:       'bar.sec',             // EDGAR resolution of the universe, see secResolve
  assessModel: 'bar.assessModel',   // which model the Assess button uses
  assessSkipRepeats: 'bar.assessSkipRepeats',  // batch: skip names assessed recently
};

/* ── EDGAR ticker aliases ─────────────────────────────────────────────
   The universe's ticker is what the MARKET DATA providers answer to, and it
   must not be changed to suit EDGAR — Finnhub and Polygon both key on it and
   both still serve these names. Where SEC writes a symbol differently, the
   difference is recorded here and applied only when talking to EDGAR.

   Two kinds, and they are not the same thing:

   - PUNCTUATION. SEC writes class shares with a dash. `BRK.B` is not delisted,
     renamed, or in any trouble: it is trading normally, has a full 500 bars,
     and is currently ranked #1 on Low vol. It failed EDGAR lookup purely on a
     character. Anything that treated a failed lookup as a delisting would have
     thrown away the board's best low-volatility name.

   - RENAMES. The company still files; the ticker moved. Verified by exact
     company-name match in company_tickers.json, not by the fuzzy matcher that
     produced obvious nonsense elsewhere (it paired Electronic Arts with
     "Electronic Servitor Publication Network" and Equity Residential with
     "Equity Lifestyle Properties"). All three of these are also absent from the
     board already — no analyst coverage answers to the old ticker — so this
     mapping restores EDGAR lookup, not the row. */
/* ── Which model the Assess button uses ───────────────────────────────
   Declared HERE, well above `state`, because `state`'s initialiser calls
   `loadAssessModel` — and a const declared below `state` is in its temporal
   dead zone at that moment. That is not hypothetical: `plainLabel` was written
   ~2000 lines below its first use, every test passed, and the page rendered
   nothing at all. `clamp` carries a note about the same trap. Anything
   reachable from `state`'s initialiser belongs above it.

   Configurable so the same names can be re-run on a cheaper model and the two
   compared — which is itself measurable once the log exists, and is the only
   comparison in this project that does not need years to mature. */
const ASSESS_MODELS = {
  'claude-opus-4-5-20251101': {
    label: 'Opus 4.5', in: 5, out: 25,
    /* Opus 4.5 predates the 20260209 search tool, which needs 4.6 or later. */
    search: 'web_search_20250305',
    /* `approx` is for the eye; `est` is the number arithmetic uses. Two fields
       for one quantity because a batch estimate must not be recovered by
       parsing a display string — the day that string gains a range or a
       currency symbol, the parse returns NaN and the estimate silently reads
       zero, which is the failure mode a spend guard exists to prevent.

       They must round to the same cent, and a test asserts it. The split is
       there so nothing computes with the string, not so the two can disagree.

       RE-BASELINED 2026-09-01, from $0.15. Eleven logged Opus calls ran
       $0.2085–$0.3021, median $0.234. The old figure came from token prices
       alone, and the gap is the web-search fee: charged per search, not per
       token, so no token-price table could ever have produced the real number.

       This is now only the answer BEFORE there is evidence — see
       perCallEstimate, which prefers the logged median once three calls exist. */
    approx: '~$0.23', est: 0.23,
    /* For the board cell, where the column is one word wide and the version
       number is the half nobody is reading — "Opus" vs "Haiku" is the whole
       question a cell can usefully answer. The full `label` still carries the
       version everywhere there is room for it: the selector, the tooltip, the
       batch quote and every log entry. */
    short: 'Opus',
  },
  'claude-haiku-4-5-20251001': {
    label: 'Haiku 4.5', in: 1, out: 5,
    search: 'web_search_20250305',
    /* Not a fifth of Opus despite a fifth of the token price: the web-search
       fee is the same whichever model runs, and it is a growing share of a
       cheaper call.

       RE-BASELINED 2026-09-01, from $0.05. Thirty-four logged calls ran
       $0.0307–$0.0871, median $0.0657 — understated by the same mechanism as
       Opus. It read as accurate only because $0.05 sat inside the range, which
       is worth remembering: a stale estimate inside the spread looks correct. */
    approx: '~$0.07', est: 0.066,
    short: 'Haiku',
  },
};

/** The name to put in a cell, shortest first. Never the bare id if anything
    better exists: `claude-haiku-4-5-20251001` in a table column is nine
    characters of provenance and thirty of noise. */
const assessModelShort = (model) =>
  ASSESS_MODELS[model]?.short || ASSESS_MODELS[model]?.label || model;
const ASSESS_MODEL_DEFAULT = 'claude-opus-4-5-20251101';

/* ── What one assessment costs ────────────────────────────────────────
   ONE estimator, four callers: the model dropdown, the per-row Assess tooltip,
   the model-change toast and the batch quote.

   It used to be one caller. `batchPlan` computed a median over the log while
   the label, the tooltip and the toast each read `cfg.approx`, a hardcoded
   string — so the quote moved with the evidence and everything the user reads
   first did not. Measured 2026-09-01: the label said ~$0.15 against a median of
   $0.234 over 11 calls, and ~$0.05 against $0.0657 over 34. The Haiku one had
   been wrong the whole time and looked right, because the stale figure sat
   inside the observed range.

   The fix is not a better number, it is one number. Anything that shows a cost
   goes through here, and every caller shows the basis beside it, so a
   disagreement between two of them becomes visible rather than silent. */
const ESTIMATE_MIN_CALLS = 3;

/** Logged per-call costs for one model, in log order.

    Zero and non-finite are dropped. A refused or errored call carries no usage
    and is never billed — the ledger in serve.mjs skips it for the same reason —
    so counting one here would drag the median toward a price nothing costs. */
function observedCosts(history, model) {
  return (history || [])
    .filter((a) => a?.model === model && Number.isFinite(a?.usage?.usd) && a.usage.usd > 0)
    .map((a) => a.usage.usd);
}

/** `{ usd, basis, n, observed }` for one assessment on `model`.

    `costs` defaults to what the log held at the last refresh, so the synchronous
    render paths can call this at all; `batchPlan` passes the history it was
    handed, which is what keeps it unit-testable.

    MEDIAN, NOT MEAN, unchanged and for the original reason: one search-heavy
    call must not set the quote for twenty ordinary ones.

    THREE IS THE FLOOR because two observations are not a distribution — with
    n=2 the "median" is just the mean of whatever two calls happened first, and
    a single expensive one moves it half its own width. */
function perCallEstimate(model, costs) {
  const cfg = ASSESS_MODELS[model];
  const fallback = cfg?.est ?? ASSESS_MODELS[ASSESS_MODEL_DEFAULT].est;
  const s = (costs || state.assessCosts[model] || []).slice().sort((a, b) => a - b);

  if (s.length < ESTIMATE_MIN_CALLS) {
    return {
      usd: fallback,
      n: s.length,
      observed: false,
      basis: s.length
        ? `list prices — only ${s.length} logged call${s.length === 1 ? '' : 's'}, `
          + `${ESTIMATE_MIN_CALLS} needed before the median is used`
        : 'list prices — nothing logged for this model yet',
    };
  }

  const mid = s.length >> 1;
  return {
    usd: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    n: s.length,
    observed: true,
    basis: `median of ${s.length} logged ${cfg?.label || model} call${s.length === 1 ? '' : 's'}`
      + ` ($${s[0].toFixed(2)}–$${s[s.length - 1].toFixed(2)})`,
  };
}

/** The estimate, for the eye. Never parsed back — `est.usd` is the number. */
const estimateText = (est) => `~$${est.usd.toFixed(2)}`;

/* ── Which assessment a symbol shows on the board ─────────────────────
   A symbol can carry several. The board has room for one, and the order is
   fixed rather than "newest wins":

   1. AN ENTRY WITH THE HORIZON SPLIT BEATS ONE WITHOUT. A pre-split entry has
      only a rating, so it cannot fill the cell — preferring it because it is
      newer would show less information for no reason.
   2. Then model tier, Opus over Haiku. Not a claim that Opus is right; it is
      the more expensive read and the one a tie should resolve toward.
   3. Then most recent.

   Rule 2 currently never fires — measured 2026-09-01, no symbol has both an
   Opus and a Haiku entry carrying the split — so it ships exercised only by
   its test. It becomes reachable the first time a split name is re-run on the
   cheaper model. */
const hasHorizonSplit = (e) => !!e && validCall(e.callNear) && validCall(e.callLong);
const isOpusEntry = (e) => /opus/i.test(e?.model || '');

function pickAssessment(entries) {
  const usable = (entries || []).filter((e) => e && (validRating(e.rating) || hasHorizonSplit(e)));
  if (!usable.length) return null;
  return usable.slice().sort((a, b) =>
    (hasHorizonSplit(b) - hasHorizonSplit(a))
    || (isOpusEntry(b) - isOpusEntry(a))
    || (b.at - a.at))[0];
}

/** Re-read the log into the caches the board and the controls render from.

    Every path that displays a cost or an assessment renders synchronously and
    the log lives in IndexedDB, so both are cached rather than read per render.
    Refreshed at boot, after each assessment and after an import — the three
    moments either answer can change. A failure leaves the previous caches
    standing, so an unreadable log degrades to stale rather than to blank. */
let assessCacheSeq = 0;

async function refreshAssessCache() {
  const seq = ++assessCacheSeq;
  try {
    const history = await loadAssessments();
    /* Overtaken while waiting on IndexedDB: a newer read has already started
       and will see a superset of this one, so writing here would put an older
       answer into the cache and leave it there. Reachable during a batch, where
       a refresh fires after every name. */
    if (seq !== assessCacheSeq) return;

    const costs = {};
    for (const id of Object.keys(ASSESS_MODELS)) costs[id] = observedCosts(history, id);
    state.assessCosts = costs;

    const bySymbol = {};
    for (const e of history) (bySymbol[e.symbol] ||= []).push(e);
    const picked = {};
    for (const [symbol, entries] of Object.entries(bySymbol)) {
      const e = pickAssessment(entries);
      if (e) picked[symbol] = e;
    }
    state.assessBySymbol = picked;

    /* The newest analyses, ONE PER SYMBOL. `history` arrives newest first, so
       the first entry seen for a symbol is its newest.

       Deduped because the chip is a way to open the brief, and the detail panel
       shows a symbol's NEWEST entry — `assessBriefHTML` reads `log[0]`. A chip
       for an older run of the same name would promise one brief and open a
       different one. Runs are not lost by this: the full log is on the row. */
    const seen = new Set();
    const recent = [];
    for (const e of history) {
      if (!e?.symbol || seen.has(e.symbol)) continue;
      seen.add(e.symbol);
      recent.push(e);
      if (recent.length >= ASSESS_RECENT_N) break;
    }
    state.assessRecent = recent;
  } catch { /* keep whatever was there */ }
  renderAssessRecent();
}

/** The log changed: re-read it and repaint everything that renders from it.

    ONE FUNCTION FOR ALL THREE CALLERS. A single assessment, a batch and an
    import all change the same two caches, and each used to repaint a different
    subset of what depends on them — a single assess refreshed the cache and the
    spend line but never the board, so the Assessed cell for the row you had
    just paid for stayed empty until something else happened to repaint. A batch
    was worse: it repainted the board at the end without re-reading the log
    first, so it painted the same stale cache it started with.

    `symbol` is optional and only decides whether the open detail panel is
    redrawn; the board is redrawn whenever it is the view on screen. */
async function assessmentsChanged(symbol = null) {
  await refreshAssessCache();
  renderAssessControls();
  if (state.view === VIEW.BOARD) renderBoard();
  if (symbol && state.view === VIEW.DETAIL) renderDetail(symbol);
}

/** The stored choice, validated rather than trusted: an id that no longer
    exists — a model retired, or this table edited — would otherwise be sent to
    the API and rejected once per call. Falls back the way a stale sort does. */
function loadAssessModel() {
  const saved = localStorage.getItem(LS.assessModel);
  return saved && ASSESS_MODELS[saved] ? saved : ASSESS_MODEL_DEFAULT;
}

/* How recently a name must have been assessed for a batch to call it a repeat.

   Twenty-four hours, and the number is a judgement rather than a measurement:
   an assessment is a dated reading of what the model thought, so re-running one
   is never WRONG — it is only unintended, and the cost of an unintended re-run
   is a duplicate row in a log whose whole purpose is comparison. The window
   exists so the dialog can say "you did this one already" at the moment that is
   still actionable. A day covers a working session; anything longer starts
   suppressing repeats a user would now call deliberate. */
const ASSESS_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/* How many names the assessment queue will hold. See the queue section below.

   A ceiling on the CONTROL, not on the money — the daily ceiling is what bounds
   spending and it bites long before this does ($0.23 × 100 is $23 against a $5
   default. This stops a held-down click turning the toolbar into a wall of chips
   with no way back except Clear.

   It is a bound on how far ahead of the runner the clicking can get, not a
   budget: at roughly a minute a call, a hundred waiting names is over an hour
   of queue, and the ceiling will have ended it long before then. */
const ASSESS_QUEUE_MAX = 100;

/* How many names the Recent strip holds. Eight is a number the eye takes in
   without reading — past that it stops being "what did I just run" and becomes
   a log, and the log already exists on the row and in the export. */
const ASSESS_RECENT_N = 8;

/** Whether the batch should drop names it has assessed inside the window.

    Defaults to FALSE — off. The guard's job is to make repeats visible, and a
    default that silently removed rows from a run the user priced and confirmed
    would trade one invisible behaviour for another. Flag first; skipping is the
    user's choice. */
const loadAssessSkipRepeats = () => localStorage.getItem(LS.assessSkipRepeats) === '1';

/** A duration as the coarsest unit that still carries the decision.

    Minutes below an hour, because "0h ago" and "40 minutes ago" answer the
    question "did I just do this?" very differently. */
function humanAgo(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

/** The window itself, for prose: "in the last 24h". */
function humanWindow(ms) {
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)} minutes`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}

const SEC_TICKER_ALIAS = {
  'BRK.B': 'BRK-B',   // punctuation only — actively trading
  'BK':    'BNY',     // Bank of New York Mellon Corp
  'MMC':   'MRSH',    // Marsh & McLennan Companies, Inc.
  'FI':    'FISV',    // Fiserv Inc
};

const secTicker = (symbol) => SEC_TICKER_ALIAS[symbol] || symbol;

/* ── Optional secondary sources ───────────────────────────────────────
   Finnhub above is the board's primary source and stays hardwired. Everything
   in this registry is optional and additive.

   Each provider is a separate account with its own free quota, so connecting
   several genuinely multiplies what the app can pull. That is not the same as
   holding several keys for ONE provider, which they all forbid and defeat
   anyway by rate-limiting per IP as well as per key.

   Two filters decided who is in this list:

     1. CORS. This is a static page with no backend, so a provider that will
        not answer a cross-origin request is unusable however good its data or
        however valid the key. Probed from a browser in Aug 2026: Tiingo,
        EODHD, FRED and SEC EDGAR all fail, and are deliberately absent.
     2. A free tier large enough to be worth the wiring.

   No two of these agree on quota, on how a key is passed, or on what an error
   looks like, so each entry carries its own. Adding a sixth provider means
   adding an entry here and nothing else. */
const PROVIDERS = [
  {
    id: 'fmp',
    name: 'Financial Modeling Prep',
    signup: 'https://site.financialmodelingprep.com/developer/docs',
    quota: '250 requests a day',
    best: 'Fundamentals, ratios, earnings calendar, analyst estimates and company news. The widest free tier here, and the best first choice.',
    base: 'https://financialmodelingprep.com/stable/',
    keyParam: 'apikey',
    dailyCap: 250,
    rate: { calls: 30, windowMs: 60_000 },
    verify: { path: 'quote', params: { symbol: 'AAPL' } },
    ok: (data) => Array.isArray(data) && data.length > 0,
    fault(status, data) {
      if (status === 401 || status === 403) return { message: 'Rejected the key.' };
      if (status === 429) return { message: 'Daily limit reached (250/day).', quota: true };
      const msg = data && (data['Error Message'] || data.error);
      return msg ? { message: String(msg).slice(0, 180) } : null;
    },
  },
  {
    id: 'twelvedata',
    name: 'Twelve Data',
    signup: 'https://twelvedata.com/pricing',
    quota: '800 requests a day, 8 a minute',
    best: 'Quotes, daily and intraday time series, and ~100 technical indicators computed server-side. The largest daily budget of the four.',
    base: 'https://api.twelvedata.com/',
    keyParam: 'apikey',
    dailyCap: 800,
    rate: { calls: 8, windowMs: 60_000 },
    verify: { path: 'quote', params: { symbol: 'AAPL' } },
    ok: (data) => !!(data && data.symbol),
    fault(status, data) {
      const code = data && data.code;
      if (status === 429 || code === 429) return { message: 'Request limit reached (800/day, 8/min).', quota: status === 429 || code === 429 };
      if (status === 401 || code === 401) return { message: 'Rejected the key.' };
      if (data && data.status === 'error') return { message: String(data.message || 'Request failed.').slice(0, 180) };
      return null;
    },
  },
  {
    id: 'polygon',
    name: 'Polygon',
    signup: 'https://polygon.io/dashboard/signup',
    quota: '5 requests a minute, no daily cap',
    best: 'End-of-day price history, two years back, for any ticker. No daily ceiling, so it is the one source here that can backfill the whole board — slowly.',
    base: 'https://api.polygon.io/',
    keyParam: 'apiKey',
    dailyCap: null,               // metered per minute only
    rate: { calls: 5, windowMs: 60_000 },
    verify: { path: 'v2/aggs/ticker/AAPL/prev', params: {} },
    ok: (data) => !!(data && (data.status === 'OK' || data.status === 'DELAYED')),
    fault(status, data) {
      if (status === 401) return { message: 'Rejected the key.' };
      /* 403 is not only a bad key here. Polygon also returns it, as
         NOT_AUTHORIZED, for a request outside the plan's history depth — the
         free plan serves two years and refuses anything older. Its own message
         says which, so pass that through instead of guessing at "bad key". */
      if (status === 403) {
        return { message: String(data?.message || 'Not authorized for this request.').slice(0, 180) };
      }
      if (status === 429) return { message: 'Rate limited (5 requests/minute on the free plan).' };
      if (data && data.status === 'ERROR') return { message: String(data.error || 'Request failed.').slice(0, 180) };
      return null;
    },
  },
  {
    id: 'newsapi',
    name: 'NewsAPI',
    signup: 'https://newsapi.org/register',
    quota: '100 requests a day',
    best: 'Headlines across ~150k sources, searchable by ticker or company name.',
    /* The free plan answers cross-origin requests from localhost ONLY, and its
       articles are 24 hours delayed. Serving this app from anywhere else
       breaks it in a way no key can fix — hence serve.ps1 rather than opening
       index.html off the filesystem. */
    caveat: 'Free plan works only when the app is served from localhost, and articles are delayed 24 hours.',
    base: 'https://newsapi.org/v2/',
    keyParam: 'apiKey',
    dailyCap: 100,
    rate: { calls: 30, windowMs: 60_000 },
    verify: { path: 'everything', params: { q: 'AAPL', pageSize: 1 } },
    ok: (data) => !!(data && data.status === 'ok'),
    fault(status, data) {
      if (data && data.status === 'error') {
        const quota = data.code === 'rateLimited' || data.code === 'maximumResultsReached';
        return { message: String(data.message || 'Request failed.').slice(0, 180), quota };
      }
      if (status === 401 || status === 403) return { message: 'Rejected the key.' };
      return null;
    },
  },
  {
    id: 'av',
    name: 'Alpha Vantage',
    signup: 'https://www.alphavantage.co/support/#api-key',
    quota: '25 requests a day',
    best: 'Company fundamentals and earnings surprise history. Useful, but the smallest budget here by a wide margin — spend it on one symbol at a time.',
    base: 'https://www.alphavantage.co/query',
    keyParam: 'apikey',
    dailyCap: 25,
    rate: { calls: 5, windowMs: 60_000 },
    /* Alone among these, the "path" is a query parameter rather than a URL
       segment, and every reply is HTTP 200 — including rejections. */
    pathAsParam: 'function',
    verify: { path: 'GLOBAL_QUOTE', params: { symbol: 'IBM' } },
    ok: (data) => !!(data && data['Global Quote'] && Object.keys(data['Global Quote']).length),
    fault(status, data) {
      if (!data) return null;
      if (data['Error Message']) return { message: 'Rejected the request — check the key and the symbol.' };
      const notice = data.Information || data.Note;
      if (!notice) return null;
      const text = String(notice);
      if (/\b(rate limit|requests per day|higher API call)\b/i.test(text)) {
        return { message: 'Daily limit reached (25/day).', quota: true };
      }
      return { message: text.slice(0, 180) };
    },
  },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/* Long, because on a 25/day budget every miss is expensive. */
const PROVIDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* The min-analysts threshold now lives in the analyst domain's `controls`, with
   the columns it acts on — see "Section controls". Its default is 10: shrinkage
   already damps thin coverage, but at SHRINK_M = 5 it damps it gently, and a
   3-analyst consensus is a different kind of claim from a 40-analyst one
   however it is scored. */

/* Score history: one record per symbol per day, oldest dropped past the cap.
   At ~580 symbols a day, 18000 records is about a month of history (~1.1 MB of
   the localStorage budget); the whole universe logging daily is the worst case,
   and a shorter watchlist stretches the same cap proportionally further. */
const HISTORY_MAX = 18000;

/* Field offsets into a history record. Declared here because `state` indexes
   the log while initialising, before the history section below is evaluated. */
const H = { SYMBOL: 0, ISO: 1, COMPOSITE: 2, RAW: 3, ANALYSTS: 4, PRICE: 5 };

/* The history section's two tabs: one symbol's readings over time, and the
   aggregate that asks whether a past day's high scorers outperformed its low
   ones. Both read the same log; only the axis they slice it on differs. */
const HTAB = { SYMBOL: 'symbol', BUCKETS: 'buckets' };

/* Composite bands for the aggregate view, half-open [min, max) and ordered
   best first. The edges sit at 3.8, 4.0 and 4.2 because that is where the
   board actually clusters: PRIOR is 3.8, so a name with no signal of its own
   shrinks to the bottom band, and 4.2+ is roughly the top decile. Wider bands
   would put most of the universe in one row and answer nothing. */
const SCORE_BUCKETS = [
  { label: '4.2 +',     min: 4.2,       max: Infinity },
  { label: '4.0 – 4.2', min: 4.0,       max: 4.2 },
  { label: '3.8 – 4.0', min: 3.8,       max: 4.0 },
  { label: 'below 3.8', min: -Infinity, max: 3.8 },
];

/* ── Price history ────────────────────────────────────────────────────
   Polygon is the only source here with no daily ceiling, so it is the only
   one that can cover the whole board: 5 calls a minute, one call per symbol
   for the entire range. It runs in the background, survives being stopped,
   and resumes where it left off.

   Only CLOSES are stored. Measured over 579 symbols at two years:

     [{t, c}] objects    17.3 MB   over budget
     [t, c] pairs        12.7 MB   over budget
     closes only          3.7 MB   fits

   The timestamps were the entire problem, and not one of the four indicators
   needs a calendar date — they all work in positions along the series. The
   first and last bar dates are kept so an incremental fetch knows where to
   resume, and `at` so a quiet weekend does not re-ask every provider on every
   page load.

   TEN years, not two, and that is what moved the store to IndexedDB. Ten years
   of daily closes across the board is ~18.4 MB even keeping closes alone, and
   localStorage tops out at 9.7 MB per origin here — probed, not assumed. Delta
   encoding the closes into base36 was measured at 1.89x on 29,667 real bars,
   which lands at 9.6 MB: under the ceiling on paper and unusable in practice,
   with nothing left for the Finnhub cache. See the storage section below. */
const PX_YEARS = 10;
const PX_MAX_BARS = 2600;                       // ~10y of trading days, plus slack
const PX_REFRESH_MS = 12 * 60 * 60 * 1000;      // don't re-check a symbol sooner

/* ── The benchmark ────────────────────────────────────────────────────
   SPY is NOT in `universe.js` — the board is 579 individual stocks and holds
   no ETFs at all — so it is fetched as reference data rather than added to the
   watchlist. Adding it there would be the wrong fix twice over: Finnhub's
   `/stock/recommendation` returns nothing for an ETF, so it would be dropped
   as uncovered, and a benchmark has no business being scored, ranked, filtered
   or bucketed alongside the names it is the yardstick for.

   So it lives in the same IndexedDB series store, fetched by the same backfill
   at the cost of one extra call, and is excluded from `state.symbols` — which
   is what every board and backtest loop iterates, so it can never appear as a
   row or land in a bucket.

   Set to null to run without a benchmark; every column that uses it then says
   so rather than showing a zero. */
const BENCHMARK = 'SPY';

/* How far a symbol's last bar may lag the rest of the board before its
   indicators stop describing the present. Wide enough to absorb a long
   holiday weekend and a half-finished backfill; narrow enough to catch a
   symbol that has stopped trading altogether. */
const PX_STALE_DAYS = 10;

/* ── Technical indicators ─────────────────────────────────────────────
   All windows are in trading days, because that is what the stored series
   counts in. These are deliberately the plain textbook definitions: the point
   of the technicals board is to be a second opinion that the analyst
   composite cannot contaminate, so nothing here is tuned to agree with it. */
const MOM_LOOKBACK = 126;   // ~6 months back
const MOM12_LOOKBACK = 252; // ~12 months back
const MOM_SKIP = 21;        // ~1 month, excluded — see momentum6m1m()
const MA_WINDOW = 200;
const RSI_WINDOW = 14;
const RANGE_WINDOW = 252;   // 52 weeks
const VOL_WINDOW = 252;     // 12 months of daily returns
const DD_WINDOW = 252;      // 12 months
const SR_WINDOW = 252;      // 12 months
const TRADING_DAYS = 252;   // annualisation factor for realised volatility

/* Each indicator gates on its own window, so a symbol short of history shows
   the columns it can support and blanks for the rest, rather than vanishing.
   The gates live in the indicator functions themselves: 127 bars for momentum,
   200 for the moving average, 15 for RSI, 2 for range position. */

/* ── Scoring ──────────────────────────────────────────────────────────
   Every input is mapped onto a fixed 0–100 scale before any weighting, so a
   given momentum figure produces the same number today, tomorrow, and on a
   board of five names or five hundred. Nothing here looks at the rest of the
   board — an earlier version ranked cross-sectionally, which made a score
   meaningless to compare against yesterday's.

   RSI and 52-week range position are already absolute and bounded, so they
   pass through untouched. The two unbounded percentages go through a tanh
   curve: 50 at zero, asymptotic to 0 and 100. That fixes the meaning of 50 —
   flat over the window, or sitting exactly on the 200-day line.

   A curve rather than a clamped ramp because a clamp TIES everything past its
   cap. Every name up 60% or more scored an identical 100 and stopped being
   distinguishable at exactly the end of the range where the differences are
   largest. tanh compresses the tails instead of amputating them, so +80% and
   +150% still separate. Signed square root was the alternative and was
   rejected: it still ties at whatever reference it is clamped to.

   The scale constants are chosen so the middle of the range tracks the old
   linear ramps almost exactly — +20% momentum scored 66.7 before and 67.4 now
   — and only the tails move. */
const MOM_K = 55;   // momentum scale: +60% → 89.9, +150% → 99.6
const MA_K = 23;    // 200-day gap scale: +25% → 89.8, +60% → 99.5

/* Twelve-month momentum spans twice the window, so the same k would push most
   of the board into the tails. Scaled so the curve reaches ~76 at +100%, which
   is roughly where +50% sits on the six-month scale. */
const MOM12_K = 95;

/* ── Inverted risk measures ───────────────────────────────────────────
   Realised volatility and maximum drawdown are both "lower is better", so
   they are scored as PIVOT − reading rather than the reading itself. The pivot
   is the value that scores 50; k is the distance either side that reaches ~76.

   The pivots are set near where a broad US large-cap board actually sits
   rather than at a round number: ~30% annualised vol and ~30% peak-to-trough
   over twelve months. They are declared here because they are assumptions, not
   measurements — the board's real distribution should be read off it and these
   revisited, which is a reason to keep them in one place. */
const VOL_PIVOT = 30;   // annualised %, scores 50

/* VOLATILITY IS SCORED IN LOG SPACE. `VOL_K = 15` linear was replaced
   2026-09-01 after the tail was measured: 82 names above 50% annualised vol
   occupied 6.46 points of the 0–100 range, and 35 names scored below 1. MRNA at
   191.9% and SMCI at 91.3% both rounded to 0.0 despite a 100-point gap. Ten
   points of volatility was worth 29 score points at the pivot and 0.09 points
   at 80%, so the factor stopped distinguishing volatile from extremely
   volatile — the board's p90 is 57.4% and its max 191.9%, so the whole top
   decile sat inside the saturated region.

   Volatility is multiplicative: the step from 20% to 40% is the same KIND of
   change as 40% to 80%, and a linear curve cannot express that. Only a k so
   large it flattens the middle would reach the tail — measured, and true:
   k = 40 linear gives the top decile 20.2 points and the middle decile 2.7.

   Measured across all ten deciles of the board's own volatility distribution,
   as the score range each decile occupies (even is good, ratio is max/min):

       linear k=15 (old)  ratio 5      tail decile 2.5 points
       linear k=25        ratio 3      MRNA still 0.0
       linear k=40        ratio 7      middle deciles collapse
       log, k=0.693       ratio 3.0
       log, k=0.60        ratio 2.6    <- most even of those tried
       cross-sectional    ratio 1      but see below

   Cross-sectional ranking is perfectly even by construction and was rejected:
   it destroys the absolute meaning of the number, so 25% annualised would score
   differently in a calm year than in a wild one, and it would make the score
   cohort-dependent like the analyst percentile rather than readable on its own.

   A doubling of volatility costs about 41 points at the pivot. Ordering is
   untouched — every option here is a monotone transform of the same number — so
   this changes RESOLUTION, not ranking, and no top-50 anywhere moves. */
const VOL_LOG_K = 0.60;

/* Unchanged, and NOT audited. Max drawdown is display-only since it was
   demoted for correlating 0.751 with inverted volatility, so its curve does not
   feed a score. If it is ever promoted back, check its tail first — it is the
   same shape of quantity and the same trap is available. */
const DD_PIVOT = 30;    // peak-to-trough %, scores 50
const DD_K = 15;

/* ── Support / resistance, experimental ───────────────────────────────
   A local extreme is a close that is the highest (or lowest) of the SR_SWING
   bars either side of it. Extremes within SR_BAND of each other are treated as
   one level, and a level counts only once SR_MIN_TOUCHES of them agree on it.

   SR_PIVOT is the distance-above-support that scores 50: sitting on support
   scores high, being far above it scores low. */
const SR_SWING = 5;
const SR_BAND = 0.02;        // 2%
const SR_MIN_TOUCHES = 2;
const SR_PIVOT = 8;          // percent above support
const SR_K = 6;

/* RSI gets the same treatment, and needed it more. Passed through raw, real
   readings cluster so tightly around 50 that the inverted term barely varied —
   it contributed a near-constant ~27 of its 55 points — and the range term
   decided the short ranking on its own, which is how names at their highs came
   to rank as good entries. The curve spends its range where the data actually
   sits: RSI 30 reads 96.6, RSI 50 reads 50, RSI 70 reads 3.4. */
const RSI_K = 12;

/* ── Range position, read two ways ────────────────────────────────────
   The long score wants "higher is stronger": a name at 95% of its 52-week
   range is in an intact uptrend, which is the whole point of a trend score.

   The short score wants the opposite at the top. It asks how good an ENTRY a
   name is, and a stock at 95% of its range is extended, not attractive. So it
   reads the same indicator through a skewed bell peaking at RANGE_PEAK — high
   enough to require an uptrend, short of the extremes.

   Two widths, because the sides fail differently. Below the peak a name is
   leaving its uptrend, which disqualifies it gradually. Above it a name is
   stretched, which disqualifies it sharply. */
const RANGE_PEAK = 67;
const RANGE_W_BELOW = 38;
const RANGE_W_ABOVE = 22;

/* Not caps — nothing clamps any more. These are the points where compression
   becomes severe, and the board meta line counts how many names sit beyond
   them, which is the diagnostic that justified the curve in the first place. */
const MOM_FLAT = 60;
const MA_FLAT = 25;

/* ── One factor per score ─────────────────────────────────────────────
   The domain is organised around FACTORS now, each registered as its own score
   so it can be measured on its own. The previous arrangement — a three-part
   `long` and a two-part `short` — mixed factors of very different evidential
   standing inside one number, so a weak component could neither be seen nor
   removed without rebuilding the score.

   Four of the five are single-term by design. A one-term weighted score looks
   redundant but is not: it puts every factor through the same registry, the
   same renormalisation and the same backtest tab, which is what makes the
   correlation matrix and the spread comparisons like-for-like.

   `blend` is the exception and the canonical score: an equal-weighted pair of
   twelve-month momentum and inverted volatility, the two factors with the
   strongest independent replication behind them in the literature. Equal
   weights because nothing measured on THIS board justifies anything else — a
   fitted weight over two independent windows would be curve-fitting.

   Both terms gate on 253 bars, so in practice they are present together or
   absent together and the renormalisation never silently reduces the blend to
   one factor. */
const SCORE_WEIGHTS = {
  blendScore:  [['mom12Score', 0.5], ['volScore', 0.5]],
  mom12Only:   [['mom12Score', 1]],
  mom6Only:    [['mom6Score', 1]],
  lowVolOnly:  [['volScore', 1]],
  drawdownOnly:[['ddScore', 1]],
  supportOnly: [['srScore', 1]],
  earnYieldOnly: [['eyScore', 1]],
  bookToMktOnly: [['bmScore', 1]],
  roeOnly:       [['roeScore', 1]],
  accrualsOnly:  [['accScore', 1]],
};

/* ── Equal weight is not equal influence ──────────────────────────────
   `blendScore` weights its two sub-scores 0.5/0.5, and that is NOT what it
   ends up measuring. Across 576 scored names on 2026-08-31:

     sd(mom12Score) = 16.20      sd(volScore) = 26.90      ratio 1.66

   Variance decomposes to **72.7% volatility, 26.4% momentum, 0.9%
   covariance** — an "equal-weighted" blend that is nearly three-quarters one
   input. A term's weight does not set its influence; its spread across the
   actual data does.

   `zBlendScore` is the corrected variant: each component is standardised to
   mean 0 / sd 1 across the cohort BEFORE averaging, so the two contribute
   equally by construction. Both are registered. The plain blend is not wrong,
   it is a different quantity, and which one ranks better is a question for the
   backtest rather than for arithmetic.

   The cost is real and worth stating: **a z-blend is cross-sectional.** Every
   other score here is absolute — a given momentum figure scores the same today,
   tomorrow, and on a board of five names or five hundred — and this one is not.
   It depends on the cohort it is scored against, so it cannot be compared
   across days or across watchlists. In the backtest the cohort is that start
   date's own symbols, which keeps it point-in-time honest (no future bar is in
   scope) but does mean a symbol's z-blend moves when its neighbours do. */
const Z_COMPONENTS = ['mom12Score', 'volScore'];

/* Below this many scored names a cross-sectional mean and sd describe the
   cohort's noise rather than its shape, and the score is withheld. */
const Z_MIN_COHORT = 30;

/* The mean of two standardised components with ρ≈0 has sd ≈ 0.71, so this maps
   ±1 cohort sd to roughly 28–72 — the spread the other 0–100 scores occupy. */
const Z_K = 1.5;

/* With partial rows, a score is renormalised over whatever inputs exist. Below
   this much of its weight there is not enough left to mean anything, and the
   score is withheld rather than computed from a scrap. */
const SCORE_MIN_WEIGHT = 0.5;

/* ── Two alternatives to averaging momentum with volatility ───────────
   Measured 2026-09-01, and the reason both of these exist: volatility is
   U-shaped in momentum — extreme movers in EITHER direction are volatile — so
   inverted volatility is hump-shaped and peaks mid-ranking. Averaging a
   hump-shaped factor with a monotone one flattens the monotone one exactly
   where it discriminates. `blend` runs 52.1 → 56.9 across momentum deciles
   5–10 while `mom12` runs 51.7 → 86.4, and inside the top quintile blend's rank
   correlation with mom12 is −0.19: it reverses the ordering it is built on.

   Both alternatives keep momentum's ordering intact and give volatility a
   narrower job. Neither is an average. */

/* (a) Momentum decides the band; volatility only orders within it.

   A band is MOM_BAND points of mom12Score wide, so volatility can never move a
   name past one that is a full band ahead on momentum. Absolute, not
   cross-sectional: the same pair of readings gives the same score on any board.

   Nine bands rather than ten because the top band has to hold mom12Score = 100
   without the within-band term pushing the total past it.

   The tiebreaker fills only BAND_TIEBREAK of a band, never all of it. At the
   full width the best volatility in band 6 scores exactly the same as the worst
   in band 7 — 69.9/vol 100 and 70.0/vol 0 both land on 70 — which is the very
   crossing this construction exists to forbid. Leaving a tenth of the band
   empty keeps a full band of momentum strictly worth more than any volatility
   edge. The cost is that the score tops out at 99 rather than 100. */
const MOM_BAND = 10;
const BAND_TIEBREAK = 0.9;

function momBandScore(parts) {
  const m = parts.mom12Score;
  if (m == null) return null;
  const band = Math.min(9, Math.floor(m / MOM_BAND));
  /* A name with no volatility reading sits mid-band rather than being withheld:
     momentum, the factor that decides the band, is present. */
  const within = parts.volScore == null ? 50 : parts.volScore;
  return band * MOM_BAND + (within / 100) * MOM_BAND * BAND_TIEBREAK;
}

/* (b) Volatility as a screen, not a term. The worst decile of the cohort is
   dropped; everything surviving is ranked on momentum alone, unadjusted.

   Cross-sectional, because a decile is a property of the cohort. In the
   backtest that cohort is the start date's own symbols, so it stays
   point-in-time honest for the same reason `zblend` does.

   A screened-out name scores null — it is not on the list, which is a different
   statement from "could not be measured". Both render as no score, so the
   detail panel says which. */
const VOL_SCREEN_FRACTION = 0.10;
const SCREEN_MIN_COHORT = 30;

/* ── The analyst percentile ───────────────────────────────────────────
   The composite is a 1–5 rating and its top is almost flat: measured
   2026-09-01 across 575 covered names it spans 2.531 to 4.229, and the TOP
   FIFTEEN NAMES SPAN 0.063 — six hundredths of a rating point deciding the head
   of the board. Rescaling that onto 0–100 does not add resolution it never had;
   it just multiplies the same noise by 25.

   A percentile is the honest reading: it says where a name sits relative to the
   others, which is the only claim the underlying number can support.

   The cost is comparability, and it is not small. This is cross-sectional, so a
   symbol's analyst percentile moves when its neighbours move and cannot be read
   across days or across watchlists — the same caveat `zblend` carries. Because
   this is the score that feeds Overall, OVERALL INHERITS IT: see
   `overallColumn`. */
const PCT_MIN_COHORT = 30;

function analystPercentileCohort(parts, rows) {
  const values = rows.map((r) => (r ? r.composite : null));
  const scored = values.filter((v) => v != null);
  if (scored.length < PCT_MIN_COHORT) return values.map(() => null);

  const sorted = [...scored].sort((a, b) => a - b);
  /* Midpoint of the tied block, so names on an identical rating share one
     percentile instead of being ordered by their position in the array — which
     with a 0.063-wide top fifteen would be pure arbitrariness presented as rank. */
  return values.map((v) => {
    if (v == null) return null;
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < v) lo++;
    let hi = lo;
    while (hi < sorted.length && sorted[hi] === v) hi++;
    return ((lo + hi) / 2 / sorted.length) * 100;
  });
}

function volScreenCohort(parts) {
  const vals = parts.map((p) => p.volScore).filter((v) => v != null);
  if (vals.length < SCREEN_MIN_COHORT) return parts.map(() => null);

  /* The last value still inside the excluded fraction, so `<= cut` drops
     exactly floor(n × fraction) names. Indexing at floor(n × fraction) instead
     — the obvious spelling — is one past the end of the decile and drops
     eleven names in a hundred, not ten.

     Ties at the cut value are excluded with it, so a cohort with many equal
     readings there loses slightly more than a decile. That is the right
     direction for a screen: it cannot let a name through on a coin toss. */
  const sorted = [...vals].sort((a, b) => a - b);
  const lastExcluded = Math.floor(sorted.length * VOL_SCREEN_FRACTION) - 1;
  if (lastExcluded < 0) return parts.map(() => null);
  const cut = sorted[lastExcluded];

  return parts.map((p) => {
    if (p.mom12Score == null || p.volScore == null) return null;
    return p.volScore <= cut ? null : p.mom12Score;
  });
}

/* ── Backtest ─────────────────────────────────────────────────────────
   Does a high score at some past date actually precede a better return? The
   whole exercise is worthless unless the score is computed from bars strictly
   up to the start date, so `technicalsAsOf` slices the series and hands the
   ordinary indicator code a shorter array. The future bars are not hidden from
   it — they are not in the array at all, which is the only kind of lookahead
   guarantee worth having. */
const BACKTEST_BUCKETS = [
  { label: '80 – 100', min: 80, max: Infinity },
  { label: '60 – 80',  min: 60, max: 80 },
  { label: '40 – 60',  min: 40, max: 60 },
  { label: '20 – 40',  min: 20, max: 40 },
  { label: '0 – 20',   min: -Infinity, max: 20 },
];

/* Two ways to cut a run into buckets.

   `bands` are the fixed score ranges above: the same score always lands in the
   same row, which is what you want when reading one score on its own.

   They are the wrong instrument for comparing scores against each other, and
   the combined score is exactly where that bites. Averaging two 0–100 scores
   that disagree pulls the result toward 50 — roughly a √2 contraction — so the
   fixed 80–100 and 0–20 bands catch a handful of names for the average where
   they catch dozens for either input.

   The figures that established this were measured on the retired `long` and
   `short` scores, before the 2026-08-31 restructure: a combined top band of 2
   symbols against a bottom band of 12, next to Long's 38 against 32. They have
   not been re-run against the current registry and should not be quoted as
   current. What survives is the reasoning — the contraction is a property of
   averaging bounded scores, not of which two were averaged.

   `quintiles` cut each score's own ranking into five equal groups instead. The
   thresholds stop being comparable — a quintile boundary sits at a different
   score for each — but the group sizes become identical, which is the thing
   that has to match before two spreads can be set side by side. */
const BUCKETING = { BANDS: 'bands', QUINTILES: 'quintiles' };

const QUINTILE_LABELS = ['Top 20%', '60 – 80%', '40 – 60%', '20 – 40%', 'Bottom 20%'];

/* SCORE_FIELDS and SCORE_LABELS are derived from the score registry, so they
   are declared with it further down — see "The score registry". */

/* Ten years at a six-month spacing is twenty non-overlapping windows, which is
   the point of storing ten years. The cap is above that so the longest setting
   is not silently clipped; the spread table at the top is what makes that many
   runs readable, since it puts one row per date rather than one table. */
const BACKTEST_MAX_RUNS = 24;

/* ── The score registry ───────────────────────────────────────────────
   Every scoring domain is declared here and nowhere else. The board's column
   groups, which columns can be sorted, which tabs the backtest offers, and
   which threshold controls the filter panel renders are all derived from this
   list — so a new domain (fundamentals is the expected next one) is added by
   appending an entry, and removed by deleting one.

   The domains stay independent on purpose. They are computed from different
   data on different scales, and there is deliberately **no master composite**
   averaging them: a number made from an analyst rating and an RSI reading
   means nothing in either domain. What replaces it is the filter panel, which
   intersects per-domain thresholds — each domain keeps its own units and its
   own opinion, and a symbol either clears all the active bars or it does not.

   `status` is the domain's standing as evidence, and it is load-bearing rather
   than decorative:

     validated  measured and it held up      sortable, backtestable, filterable
     untested   plausible, never measured    sortable, backtestable, filterable
     failed     measured and it did not      DISPLAY ONLY

   `failed` is the interesting one. The column still renders, because seeing the
   number is how you notice if it ever starts behaving — but it cannot order the
   board, cannot be filtered on, and gets no backtest tab, so it cannot quietly
   become a signal again. Rehabilitating one is a one-word edit here, which is
   the point: the evidence lives next to the switch it controls. */

/* `external` sits between validated and untested, and the distinction it draws
   is about WHOSE evidence, not about what the score is allowed to do — it has
   exactly the same capabilities as `untested`.

   The point of separating them is that "nobody has ever measured this" and
   "this is replicated in the literature but not here" are different epistemic
   positions, and collapsing them either flatters an idea nobody has checked or
   discounts one that has decades of external support. Neither is a substitute
   for measuring it on this board, which is why `external` is not `validated`.

   A score carrying it must also carry `evidence` — what the outside support
   actually is — and `pathOut`, which says what would move it. Those differ
   sharply: a price factor accumulates windows as history grows, while the
   analyst score cannot be backtested at all and can only ever be validated
   forward. Same status, different way out. */
/* Defined up here, not down with esc(), because `state`'s initialiser reaches
   it: loadSort -> sortKeysFor -> boardColumns -> dataColumns -> scoreColumn,
   whose title calls plainLabel. Declared any later and that chain hits its
   temporal dead zone and stops the whole script — the same trap `clamp` below
   carries a note about. Keep it above the registry. */
/* Registry labels carry HTML entities for typography — `Mom&nbsp;12&minus;1`
   keeps a score's name from wrapping mid-word in a column header. That is right
   in innerHTML and wrong in a textContent node, where the entity shows
   literally. Decodes the ones the registry actually uses. */
const LABEL_ENTITIES = {
  '&nbsp;': ' ', '&minus;': '−', '&Delta;': 'Δ', '&amp;': '&',
};
const plainLabel = (s) =>
  String(s ?? '').replace(/&[a-zA-Z]+;/g, (e) => LABEL_ENTITIES[e] ?? e);

const STATUS = {
  VALIDATED: 'validated',
  EXTERNAL: 'external',
  UNTESTED: 'untested',
  FAILED: 'failed',
  /* Weaker than UNTESTED, and the distinction is the point. Every other number
     on this board — including everything marked `untested` — descends from a
     published effect somebody measured on somebody's data. The model rating
     descends from nothing. It is one model's judgment, and there is no
     literature to fall back on when the board's own evidence runs out.
     Currently held by exactly one field, and it should stay that way. */
  UNSUPPORTED: 'unsupported',
};

const STATUS_RULES = {
  [STATUS.VALIDATED]: { sortable: true,  backtest: true,  filterable: true,
    tag: 'validated', title: 'Measured on the backtest and it held up.' },
  [STATUS.EXTERNAL]:  { sortable: true,  backtest: true,  filterable: true,
    tag: 'external',  title: 'Replicated in published work, never validated on this board. Same standing as untested here — the evidence behind it is somebody else\'s. See the score\'s own note for what that evidence is and what would move it.' },
  [STATUS.UNTESTED]:  { sortable: true,  backtest: true,  filterable: true,
    tag: 'untested',  title: 'Never measured on the backtest, and no external replication claimed. Usable, but nothing has confirmed it.' },
  [STATUS.FAILED]:    { sortable: false, backtest: false, filterable: false,
    tag: 'failed',    title: 'Measured and it did not hold up. Shown for reference only — it cannot sort, filter or be backtested.' },
  /* Cannot sort, filter or enter the backtest — not because it failed, but
     because it has never been anything but an opinion. It is allowed to be
     recorded and to be scored by the rating harness, and nothing else. */
  [STATUS.UNSUPPORTED]: { sortable: false, backtest: false, filterable: false,
    tag: 'unsupported', title: 'No external evidence of any kind, and what has been measured here is bad. Measured on 41 logged ratings (2026-09-01): it correlates +0.71 with the equal-weight composite of the three canonical scores, so half its variance is a restatement of numbers the board already had; repeat assessments of the same symbol on the same model differ by 0.63 on average against a between-symbol spread of 0.99, so roughly two thirds of its range is noise and its reliability is 0.68; and 41 of 41 ratings fell between 3 and 8, leaving the 9-10 bucket empty and the top-minus-bottom spread uncomputable. Not merely unvalidated — currently unvalidatable by its own harness.' },
};

/* A SCORE is one number with a status. A DOMAIN is a section of the app that
   owns one or more scores, plus the columns that show its workings and the
   detail view that explains them. Technicals owns six scores — four
   single-factor views of the same price series, and two blends built from two
   of those four — which is exactly why the two ideas had to be separated: a
   section is not the same thing as a number, and a domain with six scores still
   speaks once in Overall.

   Everything derives from this list. Nothing outside it enumerates domains. */
const SCORE_DOMAINS = [
  {
    id: 'technicals',
    label: 'Technicals',
    blurb: 'Price-derived trend and entry scores, computed from stored daily closes.',
    needsPrices: true,
    pointInTime: true,         // stored closes can be re-scored as of a past bar
    /* Which of this domain's scores speaks for it in Overall. Named, not
       positional: Technicals registers six scores, most of them views of the
       same price series — `blend` correlates 0.858 with `lowvol` and 0.880 with
       `maxDD` — so if this were "whichever is first" then reordering the array
       would quietly re-weight Overall. Exactly one score per domain reaches
       Overall, and this says which. */
    /* PROVISIONAL — see docs/NOTES.md. Momentum 12−1 is canonical because it beat
       both blends on the one independent window the store supports. That window
       was a rising market, which is the regime low volatility is expected to
       lag in, so this is NOT evidence that the volatility half fails. Revisit
       on a deeper store; do not read this line as a verdict. */
    overallScore: 'mom12',
    overallWeight: 1,
    scores: [
      {
        /* The canonical form in the momentum literature: twelve months of
           return with the most recent month dropped, which is what separates
           momentum from short-term reversal. Canonical here provisionally —
           see the note on overallScore above. */
        id: 'mom12',
        label: 'Mom&nbsp;12&minus;1',
        status: STATUS.EXTERNAL,
        evidence: 'Cross-sectional momentum is one of the most replicated effects in the '
          + 'asset-pricing literature — decades of it, across markets and asset classes, '
          + 'and this is its canonical 12−1 construction.',
        pathOut: 'Measurable here, and accumulating. One independent window so far, in '
          + 'which it led the family on raw return and trailed SPY on Sharpe — a difference '
          + 'well inside what one window can resolve. Another window arrives roughly every '
          + 'six months of stored history.',
        field: 'mom12Only',
        blurb: 'Twelve-month return excluding the most recent month — the canonical momentum construction. Canonical for this domain provisionally, on one window.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: true,
        weights: 'mom12Only',
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.mom12Only),
      },
      {
        /* Equal weights on the two factors with the strongest independent
           replication in the literature. Nominally equal — in practice
           volatility carries ~73% of its variance, which is what zblend below
           corrects. Kept registered and scored.

           `untested`, NOT `external`, and the distinction is the point of
           having the status at all. Its two inputs are externally replicated;
           this particular combination of them is not. Nobody published a paper
           on an equal-weighted 50/50 of 12−1 momentum and inverted twelve-month
           realised volatility — it was assembled here. A blend inherits its
           components' data, not their evidence, and letting it inherit the tag
           would launder a local construction into a replicated result. The same
           applies to zblend below. */
        id: 'blend',
        label: 'Blend',
        status: STATUS.UNTESTED,
        field: 'blendScore',
        /* NOT USABLE FOR TOP-OF-BOARD RANKING. Measured 2026-09-01, and this is
           a property of the construction rather than a result that might come
           out differently on more data. */
        topOfBoard: false,
        caveat: 'Do not rank the top of the board with this. Volatility is U-shaped in '
          + 'momentum, so inverted volatility is hump-shaped and peaks mid-ranking; averaging '
          + 'it with a monotone factor flattens that factor exactly where it discriminates. '
          + 'Mean blend by momentum decile runs 21.8, 36.4, 40.0, 46.8, 55.6, 52.1, 55.1, 56.9, '
          + '54.3, 53.0 — monotone to decile 5 and flat after, while mom12 runs 51.7 to 86.4 '
          + 'over deciles 5–10. Inside the top quintile its rank correlation with mom12 is '
          + '−0.19, and across the top 12 names its whole range is 3.3 points. It keeps 2.2× '
          + 'mom12\'s spread in the BOTTOM quintile (12.54 against 5.67), so it may be worth '
          + 'testing as a short screen — that is the one use this measurement supports.',
        blurb: 'Equal-WEIGHTED twelve-month momentum and inverted volatility. Unusable for ranking the top of the board — it is flat across momentum deciles 5–10 and inverts mom12 inside the top quintile. See its caveat.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        // Not combinable alongside mom12: Combined would be averaging the
        // canonical score with a blend that already contains it.
        combinable: false,
        weights: 'blendScore',  // key into SCORE_WEIGHTS, for the detail breakdown
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.blendScore),
      },
      {
        /* The variance-normalised blend: the same two components, standardised
           to mean 0 / sd 1 across the cohort before averaging, so they really
           do contribute equally. Registered ALONGSIDE the plain blend rather
           than replacing it — they are different quantities and the backtest,
           not arithmetic, decides which ranks better.

           The only cross-sectional score in the registry. It depends on the
           cohort it is scored against, so unlike every other score here it is
           not comparable across days or across watchlists. */
        id: 'zblend',
        label: 'Z-blend',
        status: STATUS.UNTESTED,
        field: 'zBlendScore',
        crossSectional: true,
        components: Z_COMPONENTS,
        blurb: 'Twelve-month momentum and inverted volatility standardised to mean 0 / sd 1 across the board, then averaged — so the two contribute equally in variance, not just in weight. Cross-sectional: it depends on the rest of the board.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.zBlendScore),
      },
      {
        /* Alternative (a) to the blend — see the note above MOM_BAND. Momentum
           sets the band, volatility only orders inside it, so the monotone
           factor keeps its ordering and the hump-shaped one cannot flatten it.
           Absolute, so unlike zblend it is comparable across days and boards. */
        id: 'momband',
        label: 'Mom&nbsp;band',
        status: STATUS.UNTESTED,
        field: 'momBandScore',
        derive: momBandScore,
        blurb: 'Twelve-month momentum sets a 10-point band; inverted volatility only orders names WITHIN a band. Volatility can never move a name past one a full band ahead on momentum — the alternative to averaging the two.',
        caveat: 'Built here on 2026-09-01 to replace the blend for top-of-board ranking. '
          + 'Untested: no window has measured whether the tiebreaker adds anything over plain '
          + 'momentum, and the band width of 10 points is a choice, not a fitted value.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.momBandScore),
      },
      {
        /* Alternative (b) — volatility as a gate rather than a term. Everything
           surviving the screen is ranked on momentum alone, so the ordering is
           momentum's, unadjusted. Cross-sectional: a decile needs the cohort. */
        id: 'momscreen',
        label: 'Mom&nbsp;screened',
        status: STATUS.UNTESTED,
        field: 'momScreenScore',
        crossSectional: true,
        cohort: volScreenCohort,
        blurb: 'Twelve-month momentum, with the most volatile decile of the board excluded outright rather than scored down. A screened-out name has no score — it is off the list, not unmeasurable. Cross-sectional: the decile depends on the rest of the board.',
        caveat: 'Built here on 2026-09-01. Untested, and the 10% cut is a choice rather than a '
          + 'fitted threshold. A null here means one of two different things — screened out, or '
          + 'never scored — and only the detail panel distinguishes them.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.momScreenScore),
      },
      {
        /* Kept as the shorter-horizon variant, and as the control the previous
           arrangement used. Its correlation with the twelve-month form is one
           of the numbers the matrix exists to report. */
        id: 'mom6',
        label: 'Mom&nbsp;6&minus;1',
        status: STATUS.EXTERNAL,
        evidence: 'The same momentum literature at a shorter horizon. Well replicated, '
          + 'though 12−1 is the construction most of that work actually tests.',
        pathOut: 'Measurable here, and the cheapest of the family to accumulate: it needs '
          + '127 bars rather than 253, so it reaches two windows where the others reach one.',
        field: 'mom6Only',
        blurb: 'Six-month return excluding the most recent month. The shorter-horizon momentum variant.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        weights: 'mom6Only',
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.mom6Only),
      },
      {
        /* The low-volatility anomaly. Well replicated across markets and
           decades, and the factor here least related to momentum — which is
           what makes it worth pairing with it rather than stacking another
           trend measure. */
        id: 'lowvol',
        label: 'Low&nbsp;vol',
        status: STATUS.EXTERNAL,
        evidence: 'The low-volatility anomaly: low-risk portfolios have historically earned '
          + 'returns at or above high-risk ones, contradicting the textbook risk-return '
          + 'trade-off. Replicated across markets and decades.',
        pathOut: 'Measurable here, but its ONE window was a rising market — the regime the '
          + 'anomaly is expected to lag in — so what this board has measured is close to a '
          + 'worst case for it. What it needs is not more windows but a window containing a '
          + 'real drawdown, and read on Sharpe rather than raw return.',
        field: 'lowVolOnly',
        blurb: 'Annualised standard deviation of daily returns over twelve months, inverted so calmer names rank higher.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        weights: 'lowVolOnly',
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.lowVolOnly),
      },
      {
        /* EXPERIMENTAL. The published evidence for support and resistance is
           mixed and mostly intraday, and this implementation is weaker than
           the literature's in a way that matters: it has no volume to weight
           levels by, because the series store keeps closes and nothing else.
           Touch count stands in for volume. Registered so it can be measured
           and discarded on evidence rather than argued about. */
        id: 'support',
        label: 'S/R',
        status: STATUS.UNTESTED,
        experimental: true,
        field: 'supportOnly',
        blurb: 'EXPERIMENTAL. Distance to the nearest support level below the price, from local extremes in the closes. Mixed published evidence, and no volume weighting — see docs/NOTES.md.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        weights: 'supportOnly',
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.supportOnly),
      },
    ],
    detail: (row, d) => technicalDetailHTML(row, d),
    /* Display-only indicators sit here rather than in `scores`.

       RSI, the 200-day gap and 52-week range position: weak standalone
       evidence, and the MA gap correlates 0.76 with six-month momentum.

       Maximum drawdown was demoted on 2026-08-31 for the same reason, measured
       rather than assumed: it correlates **0.751** with inverted volatility
       (0.772 Spearman), so it was largely restating a factor already in the
       registry. It was never a redundancy of construction — drawdown and
       volatility are different formulas — which is why it took the matrix to
       show it. Keep the column: if that correlation ever falls apart the number
       is how anyone would notice. */
    columns: [
      { key: 'mom12m1m', label: 'Mom&nbsp;12&minus;1', num: true, title: 'Return over twelve months, excluding the most recent month',
        cell: (r) => signedPctHTML(r.mom12m1m) + exBarHTML(r, 'mom12m1m', (v) => `${fmtSigned(v, 1)}%`) },
      { key: 'mom6m1m', label: 'Mom&nbsp;6&minus;1', num: true, title: 'Return over six months, excluding the most recent month',
        cell: (r) => signedPctHTML(r.mom6m1m) + exBarHTML(r, 'mom6m1m', (v) => `${fmtSigned(v, 1)}%`) },
      { key: 'realisedVol', label: 'Vol&nbsp;12m', num: true, title: 'Annualised standard deviation of daily returns over twelve months',
        cell: (r) => (r.realisedVol == null ? '<span class="muted">—</span>' : `${r.realisedVol.toFixed(1)}%`)
          + exBarHTML(r, 'realisedVol', (v) => `${v.toFixed(1)}%`) },
      { key: 'maxDD', label: 'Max&nbsp;DD', num: true, title: 'Display only — demoted from scoring: correlates 0.751 with inverted volatility, and that redundancy holds inside every momentum quintile (0.78–0.86). Largest peak-to-trough fall over twelve months. Computed from intraday extremes where the series carries them and close-to-close where it does not — a close-to-close drawdown is systematically understated, and the cell says which it used',
        cell: (r) => (r.maxDD == null ? '<span class="muted">—</span>' : `&minus;${r.maxDD.toFixed(1)}%${ddBasisTagHTML(r)}`)
          + exBarHTML(r, 'maxDD', (v) => `&minus;${v.toFixed(1)}%`) },
      { key: 'srDist', label: 'To&nbsp;supp', num: true, title: 'Percent above the nearest support level below the price. Experimental — levels come from closes, with no volume weighting',
        cell: (r) => (r.srDist == null ? '<span class="muted">—</span>' : `${r.srDist.toFixed(1)}%`)
          + exBarHTML(r, 'srDist', (v) => `${v.toFixed(1)}%`) },
      { key: 'maGap', label: 'vs&nbsp;200d', num: true, title: 'Display only — demoted from scoring: correlates 0.76 with six-month momentum',
        cell: (r) => signedPctHTML(r.maGap) },
      { key: 'rsi14', label: 'RSI&nbsp;14', num: true, title: "Display only — demoted from scoring: weak standalone evidence. 14-day RSI, Wilder's smoothing",
        cell: (r) => (r.rsi14 == null ? '<span class="muted">—</span>' : r.rsi14.toFixed(0)) },
      { key: 'rangePos', label: '52w&nbsp;pos', num: true, title: 'Display only — demoted from scoring: weak standalone evidence. 0% at the 52-week low, 100% at the high',
        cell: (r) => (r.rangePos == null ? '<span class="muted">—</span>' : `${r.rangePos.toFixed(0)}%`) },
      { key: 'bars', label: 'Bars', num: true, title: 'Daily closes stored for this symbol', cell: barsCellHTML },
    ],
  },
  {
    id: 'fundamentals',
    label: 'Fundamentals',
    blurb: 'Value and quality from SEC EDGAR XBRL filings, point-in-time by first filing date.',
    needsPrices: true,      // earnings yield and book-to-market both need a market cap

    /* The filings ARE point-in-time — every fact carries min(filed), so what was
       knowable on a past date is answerable. This is false only because the
       backtest computes a past row through `technicalsAsOf`, which slices a
       price series and knows nothing about filings. Wiring an as-of
       fundamentals path is its own piece of work; until then the domain gets no
       backtest tab rather than a tab full of blanks. NOT a statement about the
       data, unlike the analyst domain where it is. */
    pointInTime: false,

    /* IN Overall from 2026-09-01, at one third alongside Technicals and
       Analyst. It went in on the strength of the literature and of the
       independence measurement, NOT on the backtest — two windows with Sharpe
       standard errors of 0.10-0.15 cannot distinguish these factors from each
       other or from nothing.

       The independence is what earned the weight. Conditioned on volatility
       quintiles, every fundamentals factor correlates |<=0.32| with momentum —
       re-measured 2026-09-01 on the corrected TTM and still true, worst cell
       0.312. A third of the weight buys a genuinely different view rather than
       more momentum, which is the entire reason for the domain.

       RETRACTED, 2026-09-01 — this comment also claimed "the binned shape is
       monotone or flat rather than hump-shaped, so averaging this in does not
       flatten the factor it is averaged with". That was never established.
       Measured with a standard error on the decile means: book-to-market humps
       at t = -5.4 and accruals — the canonical score, the one that reaches
       Overall — is U-shaped at t = 2.5. The shapes sit at the same strength in
       the pre-fix 15-month figures, so the bad data did not cause them and the
       correction did not reveal them; the original reading overread a weak
       result. Same class of error as `mom12` vs `lowvol` = 0.010.

       THE WEIGHT IS UNCHANGED AND IS NOT SETTLED. One third stands on the
       independence argument alone, where this file recorded it as standing on
       two. Anyone revisiting it should start from: an independence argument
       with no return evidence behind it, on a domain that cannot be backtested
       here at all, whose canonical factor has a shape the original case
       explicitly denied. See docs/NOTES.md, "RETRACTED: no hump was never
       established".

       `overallWeight: 1` on all three domains is what makes it a third each;
       shares are normalised over the domains that actually scored a row, so a
       symbol missing one still gets a sensible number from the other two. */

    /* Canonical is `accruals`, not the obvious `earnYield`, and the reasons are
       measured rather than aesthetic:

       - It is the only one of the four not entangled with another. ey/bm run
         0.51 and bm/roe −0.55 (reaching −0.73 in one momentum quintile) because
         equity and market cap appear in more than one of them; accruals
         correlates ≤0.18 with all three.
       - Widest coverage: 559 scored against 506 for earnings yield. A canonical
         score decides what the domain contributes, and one that nulls 8% of the
         board hands its consumer a hole.
       - No sign gate. Its numerator is a difference and its denominator average
         assets, so negative earnings and negative book value do not remove it —
         and those are exactly the names value cannot speak about.
       - Flattest against momentum (4.6 points across ten deciles), so it adds
         least to double-weighting whenever this domain does join Overall.

       One word to change if the domain should instead lead with value. */
    overallScore: 'accruals',
    overallWeight: 1,

    scores: [
      {
        /* Trailing-twelve-month net income over market cap. Null when earnings
           are negative — see fundamentalsFor. */
        id: 'earnYield',
        label: 'Earn&nbsp;yield',
        status: STATUS.EXTERNAL,
        evidence: 'Earnings yield is the oldest and most replicated value measure in the '
          + 'literature — Basu 1977 onward, and the E/P leg of essentially every value factor '
          + 'since. Replicated across markets and decades.',
        pathOut: 'Measurable here in principle: every fact carries its first filing date, so a '
          + 'point-in-time backtest is possible once the backtest can compute a past row from '
          + 'filings rather than only from prices. Bounded by two years of stored prices, not '
          + 'by the 18.6-year median filing history.',
        field: 'earnYieldOnly',
        weights: 'earnYieldOnly',
        blurb: 'Trailing twelve-month net income over market cap. No score when earnings are negative — a loss is not a low yield.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.earnYieldOnly),
      },
      {
        id: 'bookToMkt',
        label: 'Book/mkt',
        status: STATUS.EXTERNAL,
        evidence: 'Book-to-market is the value leg of Fama-French (1992, 1993) and one of the '
          + 'most examined effects in asset pricing.',
        pathOut: 'Same as earnings yield: the data supports a point-in-time test, the backtest '
          + 'machinery does not reach it yet.',
        field: 'bookToMktOnly',
        weights: 'bookToMktOnly',
        blurb: 'Common equity over market cap. No score when book value is negative — on this board that is mostly buybacks (MCD, SBUX, PM, LOW), not distress, and the ratio is meaningless either way.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.bookToMktOnly),
      },
      {
        id: 'roe',
        label: 'ROE',
        status: STATUS.EXTERNAL,
        evidence: 'Profitability is the quality leg of Novy-Marx (2013) and of the Fama-French '
          + 'five-factor model (2015). Return on equity is its most common expression.',
        pathOut: 'As above. Gated on the sign of AVERAGE equity rather than of the ratio, '
          + 'because negative over negative yields a healthy-looking positive.',
        field: 'roeOnly',
        weights: 'roeOnly',
        blurb: 'Trailing twelve-month net income over average equity. No score when average equity is negative.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.roeOnly),
      },
      {
        id: 'accruals',
        label: 'Accruals',
        status: STATUS.EXTERNAL,
        evidence: 'The accrual anomaly, Sloan (1996): earnings backed by cash predict better '
          + 'subsequent returns than earnings backed by accounting estimates. Widely replicated '
          + 'and one of the more durable quality signals.',
        pathOut: 'As above, and the widest-covered of the four — a difference of two flows over '
          + 'average assets needs no positive denominator, so no sign gate applies.',
        field: 'accrualsOnly',
        weights: 'accrualsOnly',
        blurb: 'Net income minus operating cash flow, over average assets, INVERTED so low accruals score high. Both flows are taken over the same period — mismatching them produced errors of 5x before it was caught.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 60,
        combinable: false,
        format: (v) => v.toFixed(1),
        cell: (r) => scoreHTML(r.accrualsOnly),
      },
    ],
    detail: (row, d) => fundamentalsDetailHTML(row, d),
    columns: [
      { key: 'earnYield', label: 'E/P', num: true, title: 'Trailing twelve-month net income over market cap',
        cell: (r) => (r.earnYield == null ? '<span class="muted">—</span>' : `${(r.earnYield * 100).toFixed(2)}%`) },
      { key: 'bookToMkt', label: 'B/M', num: true, title: 'Common equity over market cap',
        cell: (r) => (r.bookToMkt == null ? '<span class="muted">—</span>' : r.bookToMkt.toFixed(3)) },
      { key: 'roe', label: 'ROE&nbsp;%', num: true, title: 'Trailing twelve-month net income over average equity',
        cell: (r) => (r.roe == null ? '<span class="muted">—</span>' : `${(r.roe * 100).toFixed(1)}%`) },
      { key: 'accruals', label: 'Accr.', num: true, title: 'Net income minus operating cash flow, over average assets. Lower is better',
        cell: (r) => (r.accruals == null ? '<span class="muted">—</span>' : r.accruals.toFixed(3)) },
      { key: 'fxBasis', label: 'Basis', title: 'TTM — twelve months to the most recent quarter, rolled as year-to-date plus prior fiscal year minus the same stretch a year earlier. FY — the newest figures on file are annual, so there is nothing more recent to roll to. Every figure is reconciled against independently filed quarters before it is shown; one that disagrees is withheld rather than displayed',
        /* The basis carries the verification state rather than earning a column
           of its own: a second column that is empty for 533 of 542 rows costs
           width on every row to say something about nine. `?` is deliberately
           quiet — unverified is not a fault, and a warning glyph would read as
           one. A withheld symbol shows why it is blank instead of a dash. */
        cell: (r) => {
          if (r.fxWithheld) {
            return `<span class="fx-withheld" title="${esc(r.fxWithheld)}">withheld</span>`;
          }
          if (!r.fxBasis) return '<span class="muted">—</span>';
          /* Only the rare condition gets a glyph. Marking the cash-flow one
             would put a `?` on 545 of 561 rows, which is decoration. */
          return `<span class="muted">${esc(r.fxBasis)}</span>${r.fxNiVerified === false
            ? `<span class="fx-unverified" title="${esc(
              'Net income unverified — not failed. This filer publishes no discrete quarterly net '
              + 'income, so there is nothing to check the differenced year-to-date cumulations '
              + 'against; the reconciliation could not be run rather than having been run and '
              + 'failed. Only 9 of 561 symbols are in this position. (The cash-flow half of '
              + 'accruals is unreconciled for 545 of 561 — a standing limit of what EDGAR files, '
              + 'not a property of this symbol.)')}">?</span>`
            : ''}`;
        } },
    ],
  },
  {
    id: 'analyst',
    label: 'Analyst',
    blurb: 'Wall Street recommendation trends, shrunk for coverage and adjusted for momentum, agreement and price-target upside.',
    needsPrices: false,
    /* Only the current recommendation trend is stored — there is no archive of
       what a symbol scored two years ago — so this domain cannot be backtested
       however its status reads.

       Note that this is NOT why the score is tagged as it is. Status and
       pointInTime are separate gates: the score is `external` (borrowed
       evidence, thin — see its note) and would be admitted to a backtest tab on
       that alone, and it is this flag that withholds one. Reading the two as one
       thing is the bug the tests pin. */
    pointInTime: false,
    overallScore: 'analyst',
    overallWeight: 1,
    scores: [
      {
        id: 'analyst',
        label: 'Analyst',
        status: STATUS.EXTERNAL,
        /* The caveat matters more than the status here. This score is
           LEVEL-based — a shrunk mean of the current consensus — with a capped
           momentum modifier bolted on. It is not a revision score.

           That distinction decides which literature backs it, and the two are
           not equally kind. Consensus LEVEL is the weak-to-negative side: the
           most favourably-rated names have not reliably outperformed, and some
           work finds the opposite. Consensus REVISION — upgrades and
           downgrades, and drift after them — is the better-supported side, and
           this score only glances at it through a capped adjustment.

           So `external` here is thinner backing than the same tag on momentum
           or low volatility, and must not be read as equivalent. */
        evidence: 'Rests on the analyst-consensus LEVEL literature, which is weak to '
          + 'negative — highly-rated names have not reliably outperformed. The stronger '
          + 'revision literature does not back this score, because it is not a revision '
          + 'score: the revision term is a capped modifier, not the signal.',
        pathOut: 'NOT measurable here, and no amount of price history will change that. '
          + 'The provider serves only the current recommendation trend, so there is no '
          + 'consensus history to score a past date against — hence pointInTime: false. '
          + 'It can only ever be validated FORWARD, from snapshots logged going forward. '
          + 'See docs/NOTES.md: the current history log cannot serve as that archive.',
        field: 'analystPct',
        crossSectional: true,
        cohort: analystPercentileCohort,
        blurb: 'Percentile rank across the board of the shrunk consensus LEVEL. In practice this score is the shrunk level and very little else — see its known limit. Cross-sectional: it moves when the rest of the board moves, and cannot be compared across days or watchlists.',
        caveat: 'Documented as a four-term composite; it is not one. Measured 2026-09-01 '
          + 'across 575 covered names: the price-target term is INERT — Finnhub returns 403 '
          + 'for targets on this plan, so `upside` is null on every single row and contributes '
          + 'exactly nothing. The momentum term is near-inert — median magnitude 0.036 rating '
          + 'points against a ±0.25 cap, exactly zero for 80 names, and reaching the cap for 23 '
          + 'of 575. What remains is the shrunk level plus a small agreement adjustment. '
          + 'Read it as a level score, because that is what it is.',
        scale: { min: 0, max: 100, step: 1, neutral: 50 },
        filterDefault: 80,
        /* Still not combinable, and now for a subtler reason than the old 1–5
           scale: a percentile and an absolute score are different KINDS of
           number even when both run 0–100. Averaging them would produce
           something with no consistent meaning at either end. */
        combinable: false,
        format: (v) => v.toFixed(1),
        // Not curve-based: a percentile resolves evenly to both ends, so no rails.
        cell: (r) => scoreHTML(r.analystPct, { rails: false }),
      },
    ],
    detail: (row, d) => analystDetailHTML(row, d),
    /* A control that filters on this domain's own data, so it lives in this
       domain's section and nowhere else — see `sectionControls`. */
    controls: [
      {
        id: 'minAnalysts',
        label: 'Min analysts',
        title: 'Exclude names covered by fewer analysts than this. Analyst coverage is analyst-domain data, so the threshold applies only on this tab.',
        min: 0,
        max: 99,
        step: 1,
        default: 10,
        legacyKey: 'bar.minAnalysts',   // read once, from before controls were generic
        active: (v) => v > 0,
        passes: (row, v) => (row.analysts ?? 0) >= v,
        describe: (v, excluded) => `${excluded} below ${v} analysts`,
      },
    ],
    columns: [
      /* The 1–5 composite is no longer the score, but it is still the quantity
         the percentile ranks — so it stays on the board as a reading. Losing it
         would leave the percentile with nothing visible behind it. */
      { key: 'composite', label: 'Rating', num: true, title: 'The shrunk consensus level the percentile ranks, on the 1–5 rating axis. Nearly flat at the top: the highest fifteen names span 0.063 of a point, which is why the score itself is a percentile',
        cell: (r) => (r.composite == null ? '<span class="muted">—</span>' : r.composite.toFixed(2)) },
      { key: 'movedSince', label: 'Moved', num: true, title: 'Price change since the start of the latest consensus period. A rating published against a price the stock has since left is describing a different stock',
        cell: (r) => preMoveHTML(r) },
      { key: 'raw', label: 'Raw&nbsp;rating', title: "Unshrunk weighted mean of the current month's ratings",
        cell: (r) => ratingHTML(r) },
      { key: 'momentum', label: 'Mom.', num: true, title: 'Change in shrunk level vs. ~3 months earlier',
        cell: (r) => deltaHTML(r.momentum, 2) },
      { key: 'coverageChange', label: 'Cov&nbsp;&Delta;', num: true, title: 'Change in analyst count vs. ~3 months earlier',
        cell: (r) => deltaHTML(r.coverageChange, 0) },
      { key: 'upside', label: 'Upside&nbsp;%', num: true, title: 'Gap from the current price to the mean analyst price target',
        cell: (r) => upsideHTML(r) },
      { key: 'insiderNet', label: 'Insider', num: true, title: 'Open-market Form 4 activity over the last 3 months, split by filer type: officers and directors first, then beneficial owners above 10% (marked 10%). The two mean opposite things — an officer selling is a judgement about the company, a large holder trimming is portfolio mechanics. Sorts on the officer figure alone. NOT complete: a holder below 10% files 13F/13G rather than Form 4, so a large institutional sale does not appear here at all',
        cell: (r) => insiderHTML(r), cls: 'insider-cell' },
      { label: 'Distribution', cell: (r) => distributionHTML(r.latest), raw: true },
      { key: 'analysts', label: 'Analysts', num: true, cell: (r) => (r.analysts ?? '—') },
    ],
  },
];

/* Back-references, wired once so a score or control always knows its section. */
for (const d of SCORE_DOMAINS) {
  for (const s of d.scores) s.domain = d;
  for (const c of d.controls || []) c.domain = d;
}

const DOMAINS_BY_ID = new Map(SCORE_DOMAINS.map((d) => [d.id, d]));
const domain = (id) => DOMAINS_BY_ID.get(id) || SCORE_DOMAINS[0];

/** Every score in every domain, flattened, in registry order. */
const allScores = () => SCORE_DOMAINS.flatMap((d) => d.scores);
const SCORES_BY_ID = new Map(allScores().map((s) => [s.id, s]));

/** A domain's headline score — the one it is ranked and filtered by, and the
    one whose status stands for the domain in a tab. */
const primaryScore = (d) => d.scores[0];

/** The one score that speaks for a domain in Overall.

    Looked up by the id the domain declares, so it is a stated choice rather
    than an accident of array order. A domain naming a score it does not own is
    a registry bug, not a runtime condition — it throws rather than silently
    falling back, because the quiet fallback is what would let a domain start
    contributing the wrong number. */
function canonicalScore(d) {
  const s = d.scores.find((x) => x.id === d.overallScore);
  if (!s) {
    throw new Error(
      `Domain "${d.id}" declares overallScore "${d.overallScore}", which is not one of its scores (${d.scores.map((x) => x.id).join(', ')}).`);
  }
  return s;
}

/* ── Section controls ─────────────────────────────────────────────────
   A control that filters on ONE domain's data belongs to that domain's
   section, and appears nowhere else. "Min analysts" is the first: analyst
   coverage is an analyst-domain fact, so a name being thinly covered is not a
   reason to hide it from the Technicals board, which has no opinion about
   analysts, nor from Overall, which is deliberately cross-domain and does its
   filtering through the filter panel.

   Declared in the registry beside the columns it acts on, so a new domain
   brings its own controls with it and nothing here enumerates them. */

const allControls = () => SCORE_DOMAINS.flatMap((d) => d.controls || []);
const CONTROLS_BY_ID = new Map(allControls().map((c) => [c.id, c]));

/** The controls on screen: the active domain's, and none on Overall — which
    owns no data of its own to threshold. */
const sectionControls = () =>
  (isOverall(state.boardMode) ? [] : domain(state.boardMode).controls || []);

function loadControls() {
  const saved = readJSON(LS.controls, {}) || {};
  return Object.fromEntries(allControls().map((c) => {
    // Migrate the value from before controls were a general idea.
    const raw = saved[c.id] ?? (c.legacyKey ? localStorage.getItem(c.legacyKey) : null);
    const n = Number(raw);
    return [c.id, raw === null || raw === '' || !Number.isFinite(n)
      ? c.default
      : clamp(Math.floor(n), c.min, c.max)];
  }));
}

const persistControls = () =>
  localStorage.setItem(LS.controls, JSON.stringify(state.controls));

/** Persisted sector cap. Off by default: it changes what the board and the
    backtest are measuring, so it should be a deliberate choice. */
function readSectorCap() {
  const n = Number(localStorage.getItem(LS.sectorCap));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* ── Sector cap ───────────────────────────────────────────────────────
   Keep at most N symbols per sector in any group, taking the highest-scoring
   in each. A top quintile that is 60% semiconductors is measuring a sector bet
   as much as a score, and the cap is how you find out which.

   Applied to a GROUP, not to the universe: on the board the group is the sorted
   result, in the backtest it is each bucket. Capping the universe first would
   change which names land in which bucket, which is a different experiment.

   The cost is that capped buckets stop being equal-sized — a concentrated
   bucket loses more names than a diversified one — so the counts are reported
   alongside. That is the trade the cap makes, not a flaw to hide. */
const SECTOR_CAP_DEFAULT = 3;

const sectorOf = (symbol) => UNIVERSE_SECTORS.get(symbol) || 'Other';

/** Keep the best `cap` entries per sector. `score` orders them; `symbol` names
    the sector. Order within the result is not meaningful — callers re-sort. */
function capPerSector(entries, cap, key = (e) => e.symbol, scoreOf = (e) => e.score) {
  if (!cap || cap < 1) return entries;
  const kept = [];
  const seen = new Map();
  for (const e of [...entries].sort((a, b) => scoreOf(b) - scoreOf(a))) {
    const s = sectorOf(key(e));
    const n = seen.get(s) || 0;
    if (n >= cap) continue;
    seen.set(s, n + 1);
    kept.push(e);
  }
  return kept;
}

/** Whether a row survives the controls of the section on screen. */
function passesSectionControls(row) {
  return sectionControls().every((c) => {
    const v = state.controls[c.id];
    return !c.active(v) || c.passes(row, v);
  });
}

const rules = (s) => STATUS_RULES[s.status];
const scoresWhere = (prop) => allScores().filter((s) => rules(s)[prop]);

/* ── The Overall score ────────────────────────────────────────────────
   One ranking across every domain whose canonical score has not failed. Today
   that is Technicals (via Mom 12−1, `external`) and Analyst (`external`), and a
   domain registered tomorrow joins on its own unless it is marked failed.
   Nothing currently ships `failed`, so the exclusion has no live instance — the
   tests demote a score in their own sandbox to check it.

   Scores arrive on different scales — Analyst is 1–5, Mom 12−1 is 0–100 — so each
   is normalised onto a common 0–100 axis by its own declared `scale` before
   anything is averaged. Without that the 1–5 domain would contribute almost
   nothing and the ranking would silently be the 0–100 one.

   Note what this is and is not. It is a way of asking "which names look good on
   everything I have", and every input keeps its own status, shown beside its
   contribution wherever the breakdown appears — an untested input contributes
   visibly untested. It is NOT evidence that the blend ranks better than its
   parts; nothing has measured that, and docs/NOTES.md is explicit that averaging a
   weak input into a strong one has already gone badly once here. The per-domain
   filter panel remains the tool for "must clear every bar"; Overall is the tool
   for "rank everything at once". They answer different questions. */

/** Map a score onto 0–100 using its own declared range. */
function normaliseScore(value, scale) {
  if (value == null) return null;
  const span = scale.max - scale.min;
  return span ? clamp(((value - scale.min) / span) * 100, 0, 100) : null;
}

/** The scores that feed Overall: exactly one per domain — the canonical one —
    unless it has failed.

    **Combination happens at the domain level, not the score level.** A domain
    contributes one value however many scores it registers, so Technicals
    registering six still counts once. Anything else would weight a domain by
    how many ways it has been sliced: all six are derived from the same stored
    closes — four single-factor, two blends of those — so admitting them all
    would drown the analyst domain six to one while presenting as an even
    two-domain blend. */
const overallDomains = () =>
  SCORE_DOMAINS.filter((d) => d.inOverall !== false && canonicalScore(d).status !== STATUS.FAILED);

const overallScores = () => overallDomains().map(canonicalScore);

/** Overall for one row: the weighted mean of its normalised contributions.

    Averaged over the domains that actually scored the symbol, not over all of
    them, so a name with no price history still ranks on what is known about it.
    Weights are renormalised over the domains present, which is why `share` is
    reported separately from `weight` — with one domain missing, the other's
    declared weight of 1 becomes a share of 100%, and the breakdown says so.

    Rows can therefore rest on different numbers of inputs, which is a real
    comparability limit rather than a detail — so the count travels with the
    score and the board shows it. */
function overallFor(row) {
  const parts = [];
  for (const d of overallDomains()) {
    const s = canonicalScore(d);
    const norm = normaliseScore(row[s.field], s.scale);
    if (norm != null) {
      parts.push({ domain: d, score: s, raw: row[s.field], norm, weight: d.overallWeight ?? 1 });
    }
  }

  const total = parts.reduce((a, p) => a + p.weight, 0);
  for (const p of parts) p.share = total ? p.weight / total : 0;

  return {
    value: total ? parts.reduce((a, p) => a + p.norm * p.weight, 0) / total : null,
    parts,
    of: overallDomains().length,
  };
}

/** Attach Overall to every watchlist row. */
function applyOverall() {
  for (const row of state.rows.values()) {
    const o = overallFor(row);
    row.overall = o.value;
    row.overallParts = o.parts.length;
    row.overallOf = o.of;
  }
}

/** Score fields that may order the board. A failed score's field is absent, so
    a stale saved sort on it falls back rather than resurrecting it. */
const sortableScoreFields = () => scoresWhere('sortable').map((s) => s.field);

/* What the backtest buckets: every domain its status admits, plus Combined.

   A `failed` score gets no tab — that is the whole point of the status.
   Nothing ships failed today, so this gate has no live instance; demoting one
   means changing a single word in the registry, which is deliberately the same
   edit that pulls its column out of sorting and filtering. The evidence and the
   switch live together, which is the property worth keeping.

   Combined is not a domain and does not answer to a status. It is the
   measurement apparatus — the machinery for averaging domains and asking
   whether the average ranks better than its parts — and it is what a newly
   registered domain gets tested with, so it stays regardless.

   Frozen at load: the run cache and the rendered tabs must agree on the field
   list within a session, and a status change is a source edit anyway. */
/* Two separate gates, and conflating them is a bug the tests caught. `status`
   is the score's standing as evidence; `pointInTime` is whether the data needed
   to test it even exists. The analyst domain is where they come apart: its
   score is `external`, which permits a tab, and it gets none — the app stores
   only current recommendation trends, so there is no way to ask what a symbol
   scored in 2024 and no honest backtest to run. Status permitting a tab does
   not conjure the history to fill it. */
const SCORE_FIELDS = [
  ...scoresWhere('backtest').filter((s) => s.domain.pointInTime).map((s) => s.field),
  'combinedScore',
];

const SCORE_LABELS = Object.fromEntries(SCORE_FIELDS.map((f) => [
  f,
  f === 'combinedScore' ? 'Combined' : (allScores().find((s) => s.field === f) || {}).label || f,
]));

/* ── Sections ─────────────────────────────────────────────────────────
   The board's tabs: Overall first, then one per registered domain. Overall is
   not a domain — it owns no data and declares no columns; it is a view over
   whatever the domains produced, which is why it is prepended here rather than
   registered alongside them. */
const OVERALL = 'overall';

const sectionIds = () => [OVERALL, ...SCORE_DOMAINS.map((d) => d.id)];
const isOverall = (id) => id === OVERALL;

/* Behaviour that once branched on "which board am I on" now branches on a
   declared capability — `needsPrices` for the backfill and the price chart,
   `pointInTime` for the backtest, `rules(score).sortable` for the header — so
   adding a domain does not mean finding the places that enumerate them. */

/* Bumping this replaces a watchlist saved from an older, smaller universe. */
const UNIVERSE_VERSION = '2';

/* The default board is the whole universe (see universe.js). */
const DEFAULT_WATCHLIST = UNIVERSE.map(([symbol]) => symbol);

/* ── Bulk loading ─────────────────────────────────────────────────────
   Two API calls per symbol (quote + recommendation); company names come
   from universe.js rather than a third profile call, and the profile is
   fetched lazily when a row is opened.

   Finnhub's free tier allows 60 calls/minute. Batch pacing alone cannot
   guarantee that — 15 symbols is 30 calls, so a fixed 1s gap would run at
   ~1800 calls/min — so every request also passes through a sliding-window
   limiter, which is what actually enforces the ceiling. The batch settings
   below control granularity of progress updates; the limiter controls rate. */
const BATCH_SIZE = 15;              // symbols per batch
const BATCH_DELAY_MS = 2500;        // pause between batches
const RATE_LIMIT = { calls: 55, windowMs: 60_000 };  // 55 not 60, for headroom

/* Minimum gap between two grants, and the reason it exists.

   The sliding window bounds the SIXTY-SECOND AVERAGE and nothing else. Against
   an empty window it hands out all 55 slots inside a single tick, and loadAll
   presents it with up to 60 simultaneous calls — a 15-symbol batch under
   Promise.allSettled, each symbol firing up to four endpoints under
   Promise.all. So opening the board put 55 requests on the wire within a
   millisecond and then went quiet for a minute. The average was legal; the
   instantaneous rate was not bounded at all.

   Spacing the grants makes the instantaneous rate equal the average rate. It
   costs nothing in throughput — those 55 calls were followed by a 60-second
   wait either way — and it removes the burst as a candidate whenever a 429
   shows up, which is worth more than the millisecond it gives back.

   55 x 1091ms is 60.005s, marginally over the window, so the window itself
   will now rarely be what blocks. It stays as the ceiling that holds if this
   gap is ever shortened. */
const RATE_MIN_GAP_MS = Math.ceil(RATE_LIMIT.windowMs / RATE_LIMIT.calls);

/* Cached symbol data older than this is refetched. Each part of a symbol's
   entry ages independently, so a fresh quote does not force a trend or
   price-target refetch and vice versa.

   The TTLs track how fast each source actually moves. Prices move all day.
   Recommendation trends are restated monthly — Finnhub publishes one row per
   month per symbol — so refetching them daily spends a call to receive the
   same six rows back. Insider filings trickle in over weeks. */
const QUOTE_TTL_MS = 24 * 60 * 60 * 1000;        // quotes
const TREND_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // recommendation trends
const TARGET_TTL_MS = 24 * 60 * 60 * 1000;       // price targets
const INSIDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // insider transactions
const INSIDER_LOOKBACK_DAYS = 90;                // ~3 months

/* Prices from a cache entry older than this are shown greyed, as stale. */
const PRICE_STALE_MS = 60 * 60 * 1000;

/* Price targets, insider transactions and candles are premium endpoints on
   Finnhub. Rather than assume, the app tries each once: a 403 flips the flag
   off for the session, that piece of the UI stays empty, and the load carries
   on at two calls per symbol instead of four.

   Candles are not part of the bulk load at all — they are fetched only for a
   symbol whose row is actually opened, so they never enter callsPerSymbol(). */
const PLAN = { priceTarget: true, insider: true, candle: true, warned: {} };

/* A 403 is a fact about the account, not about this tab, so it has to outlive
   the page. Without this, PLAN resets to optimistic on every load, every symbol
   fails the "is the price target fresh?" test in loadFromCache — the endpoint
   never wrote a ptAt and never will — and the whole board joins the fetch queue
   to re-probe an endpoint that is not on the plan.

   Re-probed weekly so upgrading a Finnhub plan is picked up on its own; "Clear
   cached data" forces it immediately. */
const PLAN_FLAGS = ['priceTarget', 'insider', 'candle'];
const PLAN_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

function loadPlan() {
  const saved = readJSON(LS.plan, null);
  if (!saved || typeof saved.at !== 'number') return;
  if (Date.now() - saved.at > PLAN_RECHECK_MS) return;   // stale: probe again
  for (const flag of PLAN_FLAGS) if (saved[flag] === false) PLAN[flag] = false;
}

function persistPlan() {
  const snapshot = { at: Date.now() };
  for (const flag of PLAN_FLAGS) snapshot[flag] = PLAN[flag];
  try {
    localStorage.setItem(LS.plan, JSON.stringify(snapshot));
  } catch { /* a full quota must not break the load */ }
}

/* Six months of daily closes for the detail panel's price chart. */
const CANDLE_DAYS = 182;

/** Calls per symbol for a cold fetch, given what the plan actually allows. */
function callsPerSymbol() {
  return 2 + (PLAN.priceTarget ? 1 : 0) + (PLAN.insider ? 1 : 0);
}

/** Calls one symbol still needs, given what its cache already holds. Because
    the parts age at different rates, a warm daily load is usually far cheaper
    than a cold one — often just the quote — and the ETA should say so. */
function pendingCallsFor(symbol, quoteTtl) {
  const { quoteFresh, trendFresh, targetFresh, insiderFresh } = cacheState(symbol, quoteTtl);
  return (quoteFresh ? 0 : 1)
       + (trendFresh ? 0 : 1)
       + (PLAN.priceTarget && !targetFresh ? 1 : 0)
       + (PLAN.insider && !insiderFresh ? 1 : 0);
}

/* Weights for the consensus score: strong sell = 1 … strong buy = 5.
   `short` is for the monthly table's header, where five full labels plus four
   more columns will not fit beside the snapshot list. */
const BUCKETS = [
  { field: 'strongBuy',  weight: 5, cls: 's5', label: 'Strong Buy',  short: 'S.Buy' },
  { field: 'buy',        weight: 4, cls: 's4', label: 'Buy',         short: 'Buy' },
  { field: 'hold',       weight: 3, cls: 's3', label: 'Hold',        short: 'Hold' },
  { field: 'sell',       weight: 2, cls: 's2', label: 'Sell',        short: 'Sell' },
  { field: 'strongSell', weight: 1, cls: 's1', label: 'Strong Sell', short: 'S.Sell' },
];

/* ── Composite scoring model ──────────────────────────────────────────
   Analyst ratings skew bullish market-wide, and a name covered by two
   analysts is not comparable to one covered by forty. So the composite:

     level      the weighted mean shrunk toward a market prior, so thin
                coverage is pulled back to the prior instead of scoring
                a spurious 5.00
     momentum   how far the shrunk level has moved vs. ~3 months earlier
     agreement  how tightly analysts cluster (low dispersion = high score)

   Level is the BASE and stays on the 1–5 rating axis; momentum and agreement
   are additive adjustments to it:

     composite = level + (momentum × 3) + ((agreement − 0.75) × 0.5)

   Averaging all three as absolute scores compressed everything toward the
   prior, because momentum and agreement both sit near their own midpoints
   for almost every name and so dominated the mean. As adjustments they move
   a name off its level instead of diluting it. */
const PRIOR = 3.8;          // market-wide average rating; the shrink target
const SHRINK_M = 5;         // pseudo-analysts of prior weight
const MAX_SD = 2;           // max dispersion on a 1–5 scale (half at 1, half at 5)
const MOMENTUM_LOOKBACK = 3;

/* Momentum is a tiebreaker, not a driver. At mult 3 / cap 1.0 it could move a
   name by ±3.00 on a 1–5 base, which pushed Hold-rated names with a recent
   upgrade above genuinely Buy-rated ones and off the top of the scale. */
const MOMENTUM_CAP = 0.25;    // caps the adjustment itself, not just the drift
const MOMENTUM_MULT = 1;      // rating points of adjustment per point of drift
const AGREEMENT_PIVOT = 0.75; // agreement above this helps, below it hurts
const AGREEMENT_MULT = 0.5;   // so the term spans roughly −0.375 … +0.125

/* Analyst price targets contribute a fourth adjustment. The upside ratio is
   used directly and clamped, so a name needs +30% implied upside to earn the
   full +0.30 — a nudge against a level that spans four rating points, never
   enough to overturn the consensus itself. */
const UPSIDE_CAP = 0.3;

/* The composite is held on the rating axis. Adjustments can otherwise carry a
   well-covered name past 5, which reads as nonsense next to a 1–5 raw mean. */
const COMPOSITE_MIN = 1;
const COMPOSITE_MAX = 5;

/* The three views that share the main column. Only one is ever visible: with
   ~580 rows on the board, anything appended below it opens thousands of pixels
   off-screen, so the detail panel replaces the board rather than following it —
   the same treatment the history view already had. */
const VIEW = { BOARD: 'board', HISTORY: 'history', DETAIL: 'detail', BACKTEST: 'backtest', RATINGS: 'ratings' };

/* Every column each mode can sort by, and the column set it renders. Declared
   before `state`, which reads them through normalizeSort() while initialising.

   `special` marks the two columns that are not data: the rank number and the
   remove button. Everything else renders from `key`. */
/* Columns every domain shares — who the row is, and what it costs. */
/* `cls` is presentational only — it pins a column width so the text columns
   stop resizing under the numbers. They were content-sized, so any repaint
   that changed a score's digit count shifted Ticker and Company sideways. */
const IDENTITY_COLUMNS = [
  { special: 'rank' },
  { key: 'symbol', label: 'Ticker', cls: 'ticker-col' },
  { key: 'name', label: 'Company', cls: 'company-col' },
  { key: 'price', label: 'Price', num: true },
  { key: 'changePct', label: 'Chg&nbsp;%', num: true },
];

/** One score column per registered domain, always all of them.

    Showing every domain's score at once is what makes the filter panel
    legible: a symbol that clears three bars should let you see the three
    numbers side by side without changing tabs. A failed domain's column
    carries `unsortable`, so it renders as a number and not as a control. */
/** One score's column. */
const scoreColumn = (s) => ({
  key: s.field,
  label: s.label,
  num: true,
  cls: 'composite-cell',
  score: s.id,
  unsortable: !rules(s).sortable,
  cell: s.cell,
  /* plainLabel, not the raw label: this becomes a title attribute, which is
     text. A label carrying `&nbsp;` renders the entity literally once esc()
     has escaped its ampersand. Same everywhere a label meets plain text. */
  title: `${plainLabel(s.label)} (${s.status}) — ${s.blurb}${
    rules(s).sortable ? '' : ' Display only: this column cannot sort or filter the board.'}`,
});

/** The Overall column. The contributor count rides along, because a 72 built
    from one domain is not the same claim as a 72 built from three. */
const overallColumn = () => ({
  key: 'overall',
  label: 'Overall',
  num: true,
  cls: 'composite-cell overall-cell',
  title: `Weighted mean of one score per non-failed domain, each normalised to 0–100 by its own scale: ${
    overallDomains().map((d) => {
      const s = canonicalScore(d);
      return `${d.label} → ${plainLabel(s.label)}${s.crossSectional ? ' [cross-sectional]' : ''} (${s.status}), weight ${d.overallWeight ?? 1}`;
    }).join(' · ')}. A domain contributes once however many scores it registers. Not itself backtested.${
    overallScores().some((s) => s.crossSectional)
      ? ' NOT COMPARABLE ACROSS DAYS OR WATCHLISTS: at least one input is a'
        + ' cross-sectional score, so this number describes a position within THIS board on'
        + ' THIS day. One such input is enough — the mean of an absolute score and a'
        + ' cohort-relative one is cohort-relative.'
      : ''}`,
  cellTitle: (r) => (r.overall == null
    ? 'No domain could score this symbol'
    : `Built from ${r.overallParts} of ${r.overallOf} domains`),
  cell: (r) => (r.overall == null
    ? '<span class="muted">—</span>'
    : `${r.overall.toFixed(1)}${r.overallParts < r.overallOf
        ? `<span class="overall-partial"> ${r.overallParts}/${r.overallOf}</span>` : ''}`),
});

/** The columns between the identity block and the remove button.

    **A domain section shows only its own data.** Its own scores, its own
    workings, and nothing from a neighbouring domain — each tab is a standalone
    view of one way of looking at a symbol, which is what it was before there
    was a registry. Mixing every score into every tab made three views of the
    same twelve columns.

    Overall is the one place the domains meet: its own number, then one column
    per CONTRIBUTING domain — the non-failed headline scores that actually went
    into it. A failed score is not shown here, because this view is about what
    fed the number and a failed score fed nothing.

    A domain that is REGISTERED BUT NOT COUNTED is a third case, and it gets a
    column too, marked. Leaving it off would make a whole scored domain
    invisible from the one view that is meant to show everything at once;
    including it unmarked would imply it fed the number. The `notCounted` flag
    is what the header renders the marker from. */
function dataColumns(sectionId = state.boardMode) {
  if (isOverall(sectionId)) {
    const aside = SCORE_DOMAINS
      .filter((d) => d.inOverall === false && rules(canonicalScore(d)).sortable)
      .map((d) => ({ ...scoreColumn(canonicalScore(d)), notCounted: true,
        title: `${plainLabel(canonicalScore(d).label)} — ${plainLabel(d.label)}'s headline score. `
          + `Registered and scored, and NOT an input to Overall: the number to its left does not `
          + `include it. Shown here so a scored domain is not invisible from the view that shows `
          + `every other one.` }));
    return [overallColumn(), ...overallScores().map(scoreColumn), ...aside];
  }
  const d = domain(sectionId);
  return [...d.scores.map(scoreColumn), ...d.columns];
}

function boardColumns(sectionId = state.boardMode) {
  return [...IDENTITY_COLUMNS, ...dataColumns(sectionId),
    /* No `key`, so it cannot sort and cannot be a persisted sort target;
       `unsortable` keeps it out of sortKeysFor for the same reason. It is not
       a score, so it never reaches the filter panel or the backtest either —
       those are both driven by the score registry, which this is not in.

       The header carries the UNSUPPORTED claim once, for the whole column,
       reusing `.saturated`'s dotted underline: the existing idiom for "a
       qualified value, read the tooltip". */
    { special: 'assessed', label: 'Assessed', num: true, unsortable: true,
      title: `${STATUS_RULES[STATUS.UNSUPPORTED].title} `
        + 'The model that wrote it, then the rating, then near/long calls where the entry '
        + 'carries them, then how old it is. A symbol assessed on more than one model shows '
        + 'one entry — the one with a horizon split, then Opus over Haiku, then the newest — '
        + 'so the model name is what says which. '
        + 'The only column here with no external evidence of any kind behind it: it correlates '
        + '+0.71 with the composite of the scores beside it, repeats move it by two thirds of '
        + 'its range, and nothing in it has been measured against forward returns. '
        + 'It cannot sort, filter or enter the backtest.' },
    { special: 'assess' }, { special: 'remove' }];
}

/** Everything that may order the board, for validating a persisted sort. */
function sortKeysFor(sectionId) {
  return boardColumns(sectionId)
    .filter((c) => c.key && !c.unsortable)
    .map((c) => c.key);
}

/* A section's own headline score is the natural default sort — Overall by
   `overall`, a domain by its primary score — except for a failed one, which
   must not order anything and falls back to the first score that may. */
function defaultSortFor(sectionId) {
  if (isOverall(sectionId)) return { by: 'overall', dir: 'desc' };
  const s = primaryScore(domain(sectionId));
  return {
    by: rules(s).sortable ? s.field : (scoresWhere('sortable')[0] || s).field,
    dir: 'desc',
  };
}

/* Generic enough to belong above `state`, which reads it while initialising:
   loadFilters clamps a persisted threshold into its domain's scale. It used to
   live down in the consensus-math section, which put it in the temporal dead
   zone at that point and stopped the whole script. */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── State ───────────────────────────────────────────────────────────
const state = {
  /* Whether the SERVER has a working Finnhub key. There is no key in this
     object and no key in this browser: `checked` is false until the proxy has
     been asked, which is why the board waits rather than showing the gate on
     first paint. */
  finnhub: { checked: false, ready: false, message: '' },
  /* Whether serve.mjs is behind the page. True until detectServer() says
     otherwise, so everything that runs before boot — and the whole test suite,
     which never boots — behaves exactly as proxy mode always has. */
  proxy: true,
  /* Set by loadSnapshot(): { asOf, entries, assessments }. Null in every live
     mode. While set, cached reads come from the snapshot rather than this
     browser's storage, and nothing calls Finnhub. */
  snapshot: null,
  /* A Finnhub key held in this browser's localStorage. Two roles, by mode:
     - PROXY: a key left by a version that kept it here. The gate offers to hand
       it over and delete it; see legacyKeyHTML. Never sent anywhere.
     - STATIC: the visitor's live key, sent to Finnhub on every call.
     Never rendered as text in either mode — only copied. */
  browserKey: localStorage.getItem(LS.key) || '',
  /* Per-model observed call costs, cached from the log by refreshAssessCache so
     the synchronous render paths can price an assessment. Empty until the first
     refresh lands, which is why perCallEstimate falls back to the table rather
     than to zero — a missing cost must read as "no evidence yet", never as
     "free". */
  assessCosts: {},
  /* symbol -> the one logged assessment the board shows for it, chosen by
     pickAssessment. Empty until the first refresh, which is why a symbol with
     no entry and a board that has not finished loading its cache render
     identically: as nothing. That is the correct shared answer — neither is a
     value, and neither should look like one. */
  assessBySymbol: {},
  /* The newest analyses, one per symbol, for the Recent strip. Rebuilt from the
     log by refreshAssessCache — never appended to by the runner, so the strip
     cannot drift from what the log actually holds. */
  assessRecent: [],
  provKeys: loadProviderKeys(),     // { fmp: 'key', … } for the secondary sources
  provUsage: loadProviderUsage(),   // { fmp: { day, calls }, … } spent today
  symbols: loadWatchlist(),
  symbolSet: new Set(),     // kept in sync with symbols; the board filters on it
  rows: new Map(),          // symbol -> row (see buildRow for the shape)
  boardMode: loadBoardMode(),   // which section is on screen: OVERALL or a domain id
  detailTab: null,              // which domain tab the detail panel has open
  sort: loadSort(),             // { <domainId>: {by, dir} }
  filters: loadFilters(),       // { <domainId>: { on, min } } — see passesFilters
  backtest: {               // score-vs-forward-return study
    /* The first backtestable field, from the registry — not a name written out
       here. This said 'longScore' long after that score was retired; it was
       harmless only because renderBacktest re-checks membership and falls back
       to exactly this value, which made a dead default look like a live one. */
    score: SCORE_FIELDS[0],
    /* Equal-sized groups by default: seven scores are on view at once and the
       fixed bands do not put comparable numbers of symbols in the same row. */
    bucketing: BUCKETING.QUINTILES,
    months: 3,              // holding period
    spacing: 3,             // months between start dates
    cacheKey: null,
    cache: [],
  },
  /* The consensus archive's session counters. The store itself is in its own
     IndexedDB database — see SNAP_DB — and outlives everything here. */
  snap: { added: 0, revised: 0, failed: 0, stats: null },
  /* SEC EDGAR fundamentals. `facts` holds the EXTRACTED form only — the raw
     multi-MB companyfacts response is parsed on receipt and discarded. */
  fx: { facts: new Map(), hydrated: false, running: false, cancelled: false,
        done: 0, failed: 0, total: 0, failures: [] },
  /* EDGAR's answer about which universe symbols are still registrants. Read
     from storage at boot so the last good answer survives a page load with no
     proxy behind it; refreshed weekly by secResolve. */
  sec: loadSecRegistry(),
  /* Which model an Assess click uses. One setting for the board rather than one
     per row — the per-row button is the trigger, this is the choice. */
  assessModel: loadAssessModel(),
  /* Names waiting their turn to be assessed, in the order they were clicked.
     Ordered, not a Set: the order is the run order and it is a choice the user
     made. Starts empty on every load and is never persisted — see the queue
     section for why a restored queue would be a page load that resumes
     spending. */
  assessQueue: [],
  px: {                     // price-history backfill
    series: new Map(),      // symbol -> { f, t, c: [closes], at, bf }, read once at boot
    hydrated: false,        // has IndexedDB handed the stored series over yet
    storeFailed: 0,         // series held in memory because a write did not land
    running: false,
    cancelled: false,
    done: 0,
    total: 0,
    failed: 0,
    failures: [],           // [{ symbol, status, message }] from the last run
    historyLimited: null,   // the plan's message, once it refuses the old window
  },
  sector: 'All sectors',
  controls: loadControls(),     // { <controlId>: value } for section controls
  sectorCap: readSectorCap(),   // 0 = off; else max symbols per sector in a group
  view: VIEW.BOARD,
  boardScroll: 0,           // where the board was when we left it, for the trip back
  selected: null,           // symbol whose detail view is open, null in any other view
  lastViewed: null,         // survives leaving the detail view; seeds the history picker
  cache: new Map(),         // url -> { at, data }
  callsMade: 0,             // cumulative real network calls, for batch pacing
  history: loadHistory(),   // [symbol, isoTimestamp, composite, raw, analysts, price]
  historyDays: new Set(),   // "SYM|YYYY-MM-DD", for the once-a-day guard
  historyDirty: false,
  historySymbol: null,
  historyTab: HTAB.SYMBOL,
  historyDate: null,        // "YYYY-MM-DD" the bucket view measures returns from
  loading: false,
  cancelled: false,
  dropped: 0,               // symbols that returned no usable data
  progress: { done: 0, total: 0, fetched: 0 },
};
state.symbolSet = new Set(state.symbols);
indexHistory();

const $ = (sel) => document.querySelector(sel);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


/** A watchlist saved against an older universe is replaced, not merged. */
function loadWatchlist() {
  if (localStorage.getItem(LS.universe) !== UNIVERSE_VERSION) {
    localStorage.setItem(LS.universe, UNIVERSE_VERSION);
    localStorage.setItem(LS.watchlist, JSON.stringify(DEFAULT_WATCHLIST));
    return [...DEFAULT_WATCHLIST];
  }
  return readJSON(LS.watchlist, DEFAULT_WATCHLIST);
}

/** Drop a persisted sort that names a column this version no longer has. */
function normalizeSort(sort, domainId) {
  /* A saved sort can name a column that no longer sorts — the domain was
     retired, or demoted to `failed` since it was written. Falling back is what
     stops a demoted score from continuing to order the board from localStorage. */
  if (!sort || !sortKeysFor(domainId).includes(sort.by)) return defaultSortFor(domainId);
  return { by: sort.by, dir: sort.dir === 'asc' ? 'asc' : 'desc' };
}

/** Sort state per domain view, one slot per registered domain.

    Migrates two older shapes: a bare `{by, dir}` from before there were modes,
    and the `technical` slot from before the technical board was split into the
    `long` and `short` domains. */
function loadSort() {
  const saved = readJSON(LS.sort, null);
  const perDomain = saved && saved.by ? { analyst: saved } : (saved || {});
  if (perDomain.technical && !perDomain.long) perDomain.long = perDomain.technical;

  if (perDomain.long && !perDomain.technicals) perDomain.technicals = perDomain.long;

  return Object.fromEntries(
    sectionIds().map((id) => [id, normalizeSort(perDomain[id], id)]),
  );
}

/** The sort belonging to the domain currently on screen. */
const activeSort = () => state.sort[state.boardMode] || defaultSortFor(state.boardMode);

/** Which domain's detail columns to show. Migrates the old `technical` value,
    which named a board rather than a domain. */
function loadBoardMode() {
  const saved = localStorage.getItem(LS.boardMode);
  // Two earlier shapes: the pre-registry 'technical' board, and the flat
  // registry where 'long' and 'short' were sections in their own right.
  if (saved === 'technical' || saved === 'long' || saved === 'short') return 'technicals';
  return sectionIds().includes(saved) ? saved : OVERALL;
}

/* ── Filters ──────────────────────────────────────────────────────────
   What replaced the idea of one number ranking everything. Each filterable
   domain contributes an independent threshold, and a symbol is shown when it
   clears every threshold that is switched on. No weighting, no blending, no
   arbitrating between a 4.4 analyst rating and a 71 trend score — the domains
   never have to be put on one axis, which is the only reason they can stay
   independent.

   An inactive filter is not a pass at zero: it is not asked. A domain whose
   filter is off has no opinion, and a symbol it cannot score is only excluded
   when that domain's own filter is on. */
function loadFilters() {
  const saved = readJSON(LS.filters, {}) || {};
  return Object.fromEntries(allScores().map((sc) => {
    const s = saved[sc.id] || {};
    const min = Number(s.min);
    return [sc.id, {
      // A failed score can never be on, however the stored value got there.
      on: rules(sc).filterable ? s.on === true : false,
      min: Number.isFinite(min) ? clamp(min, sc.scale.min, sc.scale.max) : sc.filterDefault,
    }];
  }));
}

function persistFilters() {
  localStorage.setItem(LS.filters, JSON.stringify(state.filters));
}

/** The filters currently switched on, in registry order. */
const activeFilters = () =>
  scoresWhere('filterable').filter((s) => state.filters[s.id]?.on);

/** Whether a row clears every active threshold.

    A row that cannot be scored by an active domain fails it. That is the
    honest reading — "no score" is not "passes" — and it is why the panel
    reports how many symbols each filter excludes for want of a score. */
function passesFilters(row) {
  for (const s of activeFilters()) {
    const v = row[s.field];
    if (v == null || v < state.filters[s.id].min) return false;
  }
  return true;
}

/** Filtering is a cross-domain act, so it belongs to the one cross-domain view.

    A domain section is a standalone look at one way of scoring a symbol; having
    a technical threshold silently removing rows from the Analyst tab made that
    tab lie about its own coverage. On a domain section every symbol it can
    score is shown, ordered by that domain's own score. */
const filtersApply = () => isOverall(state.boardMode);

function rowPassesActiveFilters(row) {
  return !filtersApply() || passesFilters(row);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// ── Networking ──────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* Sliding window of recent request timestamps, plus the time of the last grant.
   Every network call waits here first, so no batching mistake upstream can
   exceed Finnhub's ceiling — in rate OR in burst, see RATE_MIN_GAP_MS.

   This bounds what THIS PAGE sends. The quota is per key, not per page, so a
   second tab or a reload mid-run gets its own empty window to spend against the
   same server-side counter. That is why the proxy in serve.mjs carries a
   limiter of its own: only something outside the page can count every tab. */
const callLog = [];
let lastGrant = 0;

async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    while (callLog.length && now - callLog[0] >= RATE_LIMIT.windowMs) callLog.shift();

    /* Both waits `continue` rather than falling through, so the test that
       admits a call and the push that records it stay in one synchronous run.
       Every waiter re-reads `lastGrant` after waking; without the `continue`,
       fifty waiters released by the same timer would each see the gap that the
       first of them had already consumed. */
    const sinceGrant = now - lastGrant;
    if (sinceGrant < RATE_MIN_GAP_MS) {
      await sleep(RATE_MIN_GAP_MS - sinceGrant);
      continue;
    }
    if (callLog.length >= RATE_LIMIT.calls) {
      // Wait until the oldest call falls out of the window.
      await sleep(RATE_LIMIT.windowMs - (now - callLog[0]) + 50);
      continue;
    }

    callLog.push(now);
    lastGrant = now;
    return;
  }
}

/* ── 429 diagnostics ──────────────────────────────────────────────────
   Two different faults produce the same 429, and the errors alone could not
   tell them apart:

     (a) this page bursting — 429s clustered in the first seconds of a run,
         arriving while this tab's own window is close to full;
     (b) another tab, or a reload mid-run, spending the same key against a
         counter this page cannot see — 429s spread through the run, and
         arriving while this tab's window is nowhere near full.

   `windowAtFirst` is the discriminator. A first 429 at 8/55 slots used is not
   this page's doing. The proxy logs the authoritative version of the same
   question — how many browser contexts are spending the key — since only it can
   see across tabs. */
const rate429 = { count: 0, firstOffsetMs: -1, lastOffsetMs: -1, windowAtFirst: -1 };
let runStartedAt = 0;

function noteRateLimit() {
  const offset = runStartedAt ? Date.now() - runStartedAt : -1;
  rate429.count++;
  rate429.lastOffsetMs = offset;
  if (rate429.firstOffsetMs < 0) {
    rate429.firstOffsetMs = offset;
    rate429.windowAtFirst = callLog.length;
  }
}

function reportRateLimits() {
  if (!rate429.count) return;
  const secs = (ms) => (ms < 0 ? 'outside a run' : `+${(ms / 1000).toFixed(1)}s`);
  console.warn(
    `[rate] ${rate429.count} x 429 from Finnhub this run — first ${secs(rate429.firstOffsetMs)}, `
    + `last ${secs(rate429.lastOffsetMs)}, with ${rate429.windowAtFirst}/${RATE_LIMIT.calls} slots `
    + `used in THIS tab's window at the first one.\n`
    + `  Near ${RATE_LIMIT.calls}: this tab out-ran the limiter. Well under it: something else is `
    + `spending the same key — check the [finnhub] line in the serve.mjs console for the count of `
    + `browser contexts, which is the only place that can see across tabs.`);
}

/** Seconds until `calls` more requests could be made, at the current rate. */
function estimateSeconds(calls) {
  return Math.max(0, Math.ceil((calls / RATE_LIMIT.calls) * (RATE_LIMIT.windowMs / 1000)));
}

/** GET a Finnhub endpoint, with a short-lived in-memory cache — through the
    local proxy, or directly with the browser's key in static mode.

    In proxy mode there is no key here at all. The page cannot tell whether the
    server holds a usable key except by asking it — that is what
    checkFinnhubKey() is for, and loadAll gates on its answer. */
async function get(path, params = {}, ttl = 60_000) {
  const url = state.proxy
    ? new URL(API + path, location.origin)
    : new URL(FINNHUB_DIRECT + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const cacheId = url.toString();   // taken before the token goes on: no key in the cache map

  const hit = state.cache.get(cacheId);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  /* A snapshot spends nothing. The one exception is a key being checked in the
     gate — saveFinnhubKey sets browserKey before its probe, and that call has to
     reach Finnhub to mean anything. */
  if (state.snapshot && !state.browserKey) {
    throw new ApiError(0, 'This is a snapshot. Add a free Finnhub key under Key to use live data.');
  }

  /* No custom header in static mode: X-Bolt-Context would make the request
     non-simple, and Finnhub fails every preflight. Accept is safelisted. */
  if (!state.proxy) url.searchParams.set('token', state.browserKey);
  const headers = state.proxy
    ? { Accept: 'application/json', 'X-Bolt-Context': CONTEXT_ID }
    : { Accept: 'application/json' };

  await acquireSlot();
  state.callsMade++;   // real network calls only; lets loadAll skip idle pacing

  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new ApiError(0, state.proxy
      ? 'Request failed — check your connection, and that serve.mjs is still running.'
      : 'Request failed — check your connection.');
  }

  /* The proxy's own refusals are flagged in a header and re-raised as
     `err.proxy`, because they must never be read as facts about the Finnhub
     account. A 503 here means "no FINNHUB_API_KEY on the server", and
     fetchOptional would otherwise write that down in localStorage as "price
     targets are not on your plan" — for a week, for endpoints that are fine. */
  if (res.headers.get('X-Bolt-Proxy-Error')) {
    const body = await res.json().catch(() => ({}));
    const err = new ApiError(res.status, body.error || `The local proxy returned HTTP ${res.status}.`);
    err.proxy = true;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(res.status,
      'Finnhub rejected the key (invalid, or endpoint not on your plan). '
      + (state.proxy
        ? 'The key is FINNHUB_API_KEY on the server, not in this browser.'
        : 'Check the key under Key.'));
  }
  if (res.status === 429) {
    noteRateLimit();
    throw new ApiError(429, 'Rate limited by Finnhub (60 calls/min on the free tier). Wait a moment.');
  }
  if (!res.ok) {
    throw new ApiError(res.status, `Finnhub returned HTTP ${res.status}.`);
  }

  const data = await res.json();
  state.cache.set(cacheId, { at: Date.now(), data });
  return data;
}

/** Ask the proxy whether it holds a Finnhub key, and whether it works.

    Replaces the old saveKey() probe. The page has no key to verify, so the
    question moved from "is what the user typed valid" to "is the server
    configured" — but it is still answered by a real call, not by the presence
    of an environment variable, because a key that is set and rejected fails in
    exactly the way a missing one does and should say so as plainly. */
async function checkFinnhubKey() {
  /* Static mode with nothing entered: there is no call worth spending to learn
     that an empty token is rejected. */
  if (!state.proxy && !state.browserKey) {
    state.finnhub = { checked: true, ready: false, message: '' };
    return false;
  }
  /* `checked` stays false for the duration of the probe on purpose: the gate
     reads it to decide between "checking…" and a verdict, and flipping it up
     front would show "no usable key" for as long as the call takes. */
  try {
    await get('/quote', { symbol: 'AAPL' }, 0);
    state.finnhub = { checked: true, ready: true, message: '' };
  } catch (err) {
    state.finnhub = { checked: true, ready: false, message: err.message };
  }
  return state.finnhub.ready;
}

/** Is serve.mjs behind this page? Asked once, at boot, before any Finnhub call.

    A dedicated endpoint rather than inferring from the hostname: someone can
    serve these files from localhost with a plain static server, and a Pages
    site can be opened at any address. Anything but serve.mjs's own answer —
    a 404 page, a network error, non-JSON — means static mode. */
async function detectServer() {
  try {
    const res = await fetch('/bolt/ping', { headers: { Accept: 'application/json' } });
    const body = res.ok ? await res.json() : null;
    state.proxy = !!(body && body.bolt === true);
  } catch {
    state.proxy = false;
  }
  document.documentElement.dataset.server = state.proxy ? 'proxy' : 'static';
  return state.proxy;
}

// ── Secondary provider client ───────────────────────────────────────
/* Kept deliberately separate from get(): different hosts, different keys,
   different quotas and different error conventions. Sharing Finnhub's limiter
   would let 55/min of board traffic starve a budget of 25 calls a day. */

/** The day a quota is counted in. UTC, because that is when these reset.
    A declaration, not a const arrow: `state` calls loadProviderUsage() while
    it is initialising, far above this line, and only declarations hoist.

    Deliberately NOT the same boundary as the Anthropic spend ledger in
    serve.mjs, which moved to local midnight on 2026-09-01. These counters track
    ceilings the vendors impose and reset at 00:00 UTC, so matching UTC is the
    entire point; that one is a local policy limit and answers to a local day.
    Two different boundaries because they are two different kinds of thing —
    do not unify them. */
function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function loadProviderKeys() {
  const keys = {};
  for (const p of PROVIDERS) keys[p.id] = localStorage.getItem(LS.provKey + p.id) || '';

  /* One-time migration: Alpha Vantage briefly had its own bespoke keys before
     the registry existed. Cheap to carry, and losing a key the user typed in
     would be worse than the four lines. */
  if (!keys.av) {
    const legacy = localStorage.getItem('bar.avKey');
    if (legacy) {
      keys.av = legacy;
      localStorage.setItem(LS.provKey + 'av', legacy);
      localStorage.removeItem('bar.avKey');
    }
  }
  return keys;
}

function loadProviderUsage() {
  const today = utcDay();
  const usage = {};
  for (const p of PROVIDERS) {
    const saved = readJSON(LS.provUsage + p.id, null);
    usage[p.id] = saved && saved.day === today
      ? { day: today, calls: Number(saved.calls) || 0 }
      : { day: today, calls: 0 };
  }
  return usage;
}

function persistProviderUsage(id) {
  try {
    localStorage.setItem(LS.provUsage + id, JSON.stringify(state.provUsage[id]));
  } catch { /* the counter is a courtesy; a full quota must not break a call */ }
}

/** Roll a counter over at UTC midnight. Called before every budget read. */
function rolloverUsage(id) {
  const today = utcDay();
  if (state.provUsage[id].day !== today) {
    state.provUsage[id] = { day: today, calls: 0 };
    persistProviderUsage(id);
  }
}

/** Requests left today, or Infinity for a provider metered per minute only. */
function budgetLeft(id) {
  const provider = PROVIDER_BY_ID.get(id);
  if (!provider.dailyCap) return Infinity;
  rolloverUsage(id);
  return Math.max(0, provider.dailyCap - state.provUsage[id].calls);
}

function spendCall(id, n = 1) {
  state.provUsage[id].calls += n;
  persistProviderUsage(id);
  renderProviderStatus(id);
}

/* One sliding window per provider — they have nothing to do with each other. */
const providerCallLogs = new Map(PROVIDERS.map((p) => [p.id, []]));

/** The per-minute half of a provider's limit. The daily half is a refusal, not
    a wait: sleeping until tomorrow is not something a click can do. */
async function acquireProviderSlot(id) {
  const { rate } = PROVIDER_BY_ID.get(id);
  const log = providerCallLogs.get(id);
  for (;;) {
    const now = Date.now();
    while (log.length && now - log[0] >= rate.windowMs) log.shift();
    if (log.length < rate.calls) {
      log.push(now);
      return;
    }
    await sleep(rate.windowMs - (now - log[0]) + 50);
  }
}

/** Cache key for one request: provider, path, and sorted parameters. */
function providerCacheKey(id, path, params) {
  const parts = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return `${LS.provEntry}${id}.${path}${parts ? `.${parts}` : ''}`;
}

function readProviderCache(key, ttl) {
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (!hit || typeof hit.at !== 'number' || Date.now() - hit.at > ttl) return null;
    return hit.data;
  } catch {
    return null;
  }
}

function writeProviderCache(key, data) {
  const write = () => localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  try {
    write();
  } catch {
    // Worth evicting symbol cache for: those entries cost one Finnhub call to
    // rebuild, this one costs a slice of a much scarcer daily budget.
    if (evictOldestEntries(0.5)) {
      try { write(); } catch { /* returned to the caller either way */ }
    }
  }
}

/** Every `bar.p.` key, for the cache-clearing path. */
function cachedProviderKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS.provEntry)) keys.push(k);
  }
  return keys;
}

function clearProviderCache() {
  for (const k of cachedProviderKeys()) localStorage.removeItem(k);
}

/** Build the request URL for one provider call, key included. */
function providerUrl(provider, path, params, key) {
  // Alpha Vantage names the endpoint in a query parameter; the rest put it in
  // the path.
  const url = new URL(provider.pathAsParam ? provider.base : provider.base + path);
  if (provider.pathAsParam) url.searchParams.set(provider.pathAsParam, path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set(provider.keyParam, key);
  return url;
}

/** Call one secondary provider. `ttl` of 0 forces a live request.

    The `fault` hook does the work the HTTP status cannot: Alpha Vantage
    answers 200 for a rejected key, Twelve Data reports 429 inside a 200 body,
    and NewsAPI puts everything in `status: "error"`. Each provider says what
    an error looks like for itself, and a quota fault zeroes that provider's
    budget — the server is the authority on its own limit. */
async function getFrom(id, path, params = {}, ttl = PROVIDER_CACHE_TTL_MS) {
  const provider = PROVIDER_BY_ID.get(id);
  if (!provider) throw new ApiError(0, `Unknown provider "${id}".`);

  const key = state.provKeys[id];
  if (!key) throw new ApiError(401, `No ${provider.name} key connected.`);

  const cacheKey = providerCacheKey(id, path, params);
  if (ttl > 0) {
    const cached = readProviderCache(cacheKey, ttl);
    if (cached) return cached;
  }

  if (budgetLeft(id) <= 0) {
    throw new ApiError(429, `${provider.name}'s free daily limit (${provider.dailyCap} requests) is used up. It resets at 00:00 UTC.`);
  }

  await acquireProviderSlot(id);

  let res;
  try {
    res = await fetch(providerUrl(provider, path, params, key), { headers: { Accept: 'application/json' } });
  } catch {
    /* A cross-origin refusal is indistinguishable from being offline here —
       the browser reports both as a bare TypeError, on purpose. Either way
       nothing reached the provider, so nothing was spent. */
    throw new ApiError(0, `Could not reach ${provider.name} — check your connection.`);
  }

  // Anything that reached the provider counts against the day, whatever it says.
  spendCall(id);

  let data = null;
  try {
    data = await res.json();
  } catch { /* some errors come back as HTML; `fault` reads the status alone */ }

  const fault = provider.fault(res.status, data);
  if (fault) {
    if (fault.quota && provider.dailyCap) {
      state.provUsage[id].calls = provider.dailyCap;
      persistProviderUsage(id);
      renderProviderStatus(id);
    }
    /* 401 and 403 keep their real status. They mean the key or the plan, which
       callers act on differently from an ordinary bad request — the price
       backfill stops the whole run, or learns a limit, rather than failing
       every remaining symbol one at a time. Flattening them to 400 made that
       early exit dead code. */
    const status = fault.quota ? 429
      : (res.status === 401 || res.status === 403) ? res.status
      : 400;
    throw new ApiError(status, `${provider.name}: ${fault.message}`);
  }
  if (!res.ok) throw new ApiError(res.status, `${provider.name} returned HTTP ${res.status}.`);
  if (data == null) throw new ApiError(0, `${provider.name} returned a response that was not JSON.`);

  /* ttl 0 means bypass the cache in both directions, not just on the way in.
     The price backfill relies on it: a raw aggs response carries open, high,
     low, volume and VWAP for every bar, roughly ten times what the series
     store keeps, and caching 579 of those would exhaust the quota outright.
     Key verification uses it too, and has no business leaving an entry. */
  if (ttl > 0) writeProviderCache(cacheKey, data);
  return data;
}

// ── Persistent per-symbol cache ─────────────────────────────────────
/* One localStorage key per symbol (bar.t.AAPL), holding a compact encoding of
   the quote and recommendation trend plus the time it was fetched. ~580 keys of
   a few hundred bytes each sits comfortably inside a 5 MB budget, and writing
   one symbol does not require re-serialising the rest. */

/* An entry holds four independently-aged parts:
     at / q       quote                                (24h)
     tAt / t      recommendation trend rows            (7 days)
     ptAt / pt    [targetMean, targetHigh, targetLow]  (24h)
     inAt / in    [net, bought, sold]                  (7 days)
   Merging rather than replacing means a stale price target does not throw away
   a fresh quote.

   `at` doubles as the price's as-of time (see PRICE_STALE_MS), which is why the
   quote keeps the unprefixed key. Entries written before the trend had its own
   timestamp carry `t` but no `tAt`; cacheState falls back to `at` for those,
   which is exactly when they were fetched. */

const encodeQuote = (quote) => ({
  at: Date.now(),
  q: quote ? [quote.c, quote.d, quote.dp, quote.o, quote.h, quote.l, quote.pc] : null,
});

const encodeTrend = (trend) => ({
  tAt: Date.now(),
  t: trend.slice(0, 6).map((r) => [r.period, r.strongBuy, r.buy, r.hold, r.sell, r.strongSell]),
});

/** Every fetched trend also goes to the permanent archive.

    Deliberately fire-and-forget: the archive is the only copy of data that
    cannot be re-fetched, but it must never delay or fail a board refresh. It
    swallows its own errors and counts them. */
function archiveTrend(symbol, trend) {
  if (!Array.isArray(trend) || !trend.length) return;
  recordSnapshot(symbol, trend).then((r) => {
    if (!r) return;
    state.snap.added += r.added;
    state.snap.revised += r.revised;
  }).catch(() => { state.snap.failed++; });
}

const encodeTarget = (t) =>
  ({ ptAt: Date.now(), pt: t ? [t.targetMean ?? null, t.targetHigh ?? null, t.targetLow ?? null] : null });

/* Bumped when the insider summary changes shape or meaning, so entries cached
   under the old rules are treated as stale rather than silently reused.
   v2 = open-market codes (P/S) only.
   v3 = split by filer type — officers/directors apart from >10% owners. */
const INSIDER_VERSION = 3;

/* Two groups and an unclassified remainder, each [net, bought, sold, trades]. */
const encodeInsider = (i) => ({
  inAt: Date.now(), inV: INSIDER_VERSION,
  in: i ? [
    [i.officer.net, i.officer.bought, i.officer.sold, i.officer.trades],
    [i.holder.net, i.holder.bought, i.holder.sold, i.holder.trades],
    [i.unknown.net, i.unknown.bought, i.unknown.sold, i.unknown.trades],
  ] : null,
});

function decodeEntry(entry) {
  const [c, d, dp, o, h, l, pc] = entry.q || [];
  const [targetMean, targetHigh, targetLow] = entry.pt || [];
  const grp = ([net = 0, bought = 0, sold = 0, trades = 0] = []) =>
    ({ net, bought, sold, trades });
  return {
    at: entry.at,
    quote: entry.q ? { c, d, dp, o, h, l, pc } : {},
    trend: (entry.t || []).map(([period, strongBuy, buy, hold, sell, strongSell]) =>
      ({ period, strongBuy, buy, hold, sell, strongSell })),
    target: entry.pt ? { targetMean, targetHigh, targetLow } : null,
    /* GATED ON THE VERSION, not just on presence. A v2 entry stores a flat
       [net, bought, sold, trades] and destructuring its first element as a
       group throws "0 is not iterable" — which is a blank board, from cached
       data, on a machine that had used the previous build. `cacheState` already
       treats a version mismatch as stale so it will be refetched; this makes
       the intervening read return nothing instead of exploding. */
    insider: entry.in && entry.inV === INSIDER_VERSION
      ? { officer: grp(entry.in[0]), holder: grp(entry.in[1]), unknown: grp(entry.in[2]) }
      : null,
  };
}

/** Which parts of a symbol's cache entry are still inside their TTL.

    `quoteTtl` overrides how old a quote may be before it counts as stale. The
    default is the 24h store TTL, which is what a boot load wants. Refresh
    passes PRICE_STALE_MS instead, so the button refetches exactly the prices
    the board is already drawing as stale — see the #refresh handler. */
function cacheState(symbol, quoteTtl = QUOTE_TTL_MS) {
  const entry = readEntry(symbol);
  const now = Date.now();
  // Pre-`tAt` entries fetched the trend alongside the quote, so `at` is its
  // true fetch time rather than a guess.
  const trendAt = entry?.tAt ?? entry?.at;
  return {
    entry,
    quoteFresh:   !!entry?.at   && now - entry.at   < quoteTtl,
    trendFresh:   !!trendAt     && !!entry?.t       && now - trendAt < TREND_TTL_MS,
    targetFresh:  !!entry?.ptAt && now - entry.ptAt < TARGET_TTL_MS,
    insiderFresh: !!entry?.inAt && entry.inV === INSIDER_VERSION
                  && now - entry.inAt < INSIDER_TTL_MS,
  };
}

function readEntry(symbol) {
  if (state.snapshot) {
    const e = state.snapshot.entries[symbol];
    return e && typeof e.at === 'number' ? e : null;
  }
  try {
    const raw = localStorage.getItem(LS.entry + symbol);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.at !== 'number') return null;
    return entry;
  } catch {
    return null;
  }
}

/** Merge `patch` into a symbol's cache entry, leaving untouched parts intact. */
function writeEntry(symbol, patch) {
  const merged = { ...(readEntry(symbol) || {}), ...patch };
  const key = LS.entry + symbol;
  try {
    localStorage.setItem(key, JSON.stringify(merged));
  } catch {
    // Out of quota: drop the oldest half of the cache and try once more.
    if (evictOldestEntries(0.5)) {
      try { localStorage.setItem(key, JSON.stringify(merged)); } catch { /* give up */ }
    }
  }
}

function cachedSymbolKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS.entry)) keys.push(k);
  }
  return keys;
}

function evictOldestEntries(fraction) {
  const entries = cachedSymbolKeys()
    .map((k) => {
      let at = 0;
      try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch { /* treat as oldest */ }
      return { k, at };
    })
    .sort((a, b) => a.at - b.at);

  const cut = Math.ceil(entries.length * fraction);
  if (!cut) return false;
  for (const { k } of entries.slice(0, cut)) localStorage.removeItem(k);
  return true;
}

function clearSymbolCache() {
  for (const k of cachedSymbolKeys()) localStorage.removeItem(k);
}

// ── Score history ───────────────────────────────────────────────────
/* A running log of what each symbol scored, so today's board can be compared
   against past readings. Records are appended only when data is actually
   fetched from the API — a load served entirely from cache is replaying an
   older reading, and stamping it with today's date would be a lie. A refetched
   quote alone still counts: the price is new even when the trend was reused.

   The array is chronological, so capping it is a shift from the front. */

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. Local rather than
    UTC because "once a day" is a human-facing notion. */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function loadHistory() {
  const log = readJSON(LS.history, []);
  return Array.isArray(log) ? log.filter((r) => Array.isArray(r) && r.length >= 6) : [];
}

function indexHistory() {
  state.historyDays = new Set(
    state.history.map((r) => `${r[H.SYMBOL]}|${localDay(r[H.ISO])}`)
  );
}

function persistHistory() {
  if (!state.historyDirty) return;
  try {
    localStorage.setItem(LS.history, JSON.stringify(state.history));
    state.historyDirty = false;
  } catch {
    // Out of quota: drop the oldest half and retry once.
    state.history.splice(0, Math.ceil(state.history.length / 2));
    indexHistory();
    try {
      localStorage.setItem(LS.history, JSON.stringify(state.history));
      state.historyDirty = false;
    } catch { /* give up until the next flush */ }
  }
}

/** Append one reading for `row`, unless this symbol is already logged today.
    Returns true if a record was written. Callers batch the flush. */
function logHistory(row) {
  if (!row || row.composite == null) return false;

  const now = new Date();
  const key = `${row.symbol}|${localDay(now.toISOString())}`;
  if (state.historyDays.has(key)) return false;

  const round = (n, d) => (n == null ? null : Number(n.toFixed(d)));
  state.history.push([
    row.symbol,
    now.toISOString(),
    round(row.composite, 3),
    round(row.raw, 3),
    row.analysts ?? null,
    round(row.price, 4),
  ]);
  state.historyDays.add(key);

  // Chronological order means the oldest records are at the front.
  if (state.history.length > HISTORY_MAX) {
    const excess = state.history.splice(0, state.history.length - HISTORY_MAX);
    for (const r of excess) state.historyDays.delete(`${r[H.SYMBOL]}|${localDay(r[H.ISO])}`);
  }

  state.historyDirty = true;
  return true;
}

/** Every record for one symbol, newest first. */
function historyFor(symbol) {
  return state.history
    .filter((r) => r[H.SYMBOL] === symbol)
    .sort((a, b) => String(b[H.ISO]).localeCompare(String(a[H.ISO])));
}

/** Symbols that have at least one record, alphabetically. */
function historySymbols() {
  return [...new Set(state.history.map((r) => r[H.SYMBOL]))].sort();
}

function clearHistory() {
  state.history = [];
  state.historyDays = new Set();
  state.historyDirty = true;
  state.historyDate = null;
  persistHistory();
}

/* ── Score-bucket aggregate ───────────────────────────────────────────
   The per-symbol table answers "what did this name score, and what has it
   done since". The aggregate asks the question that actually tests the
   model: on some past day, did the names it scored highly go on to beat
   the ones it scored poorly?

   Everything is measured from one chosen day's log against the board's
   current prices, so a symbol with no live price contributes nothing —
   there is no second point to draw the line to. Those are counted and
   reported rather than quietly folded in as zero. */

/** Every calendar day present in the log, newest first, with its record count. */
function historyDates() {
  const counts = new Map();
  for (const r of state.history) {
    const day = localDay(r[H.ISO]);
    if (day) counts.set(day, (counts.get(day) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, records]) => ({ day, records }));
}

/** What each symbol logged on `day` has returned since, against the board's
    current price. Symbols the board no longer prices are excluded and counted;
    so are records with no composite or no price to measure from. */
function returnsForDay(day) {
  const rows = [];
  const seen = new Set();
  let unpriced = 0;

  for (const r of state.history) {
    if (localDay(r[H.ISO]) !== day) continue;

    // The log already guards one record per symbol per day, but a stale index
    // or a hand-edited log should not double-count a name into a bucket.
    const symbol = r[H.SYMBOL];
    if (seen.has(symbol)) continue;
    seen.add(symbol);

    const composite = r[H.COMPOSITE];
    const then = r[H.PRICE];
    if (composite == null || !then) continue;

    const live = state.rows.get(symbol);
    if (!live || live.price == null) { unpriced++; continue; }

    rows.push({
      symbol,
      composite,
      then,
      now: live.price,
      ret: ((live.price - then) / then) * 100,
    });
  }

  return { rows, unpriced };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Middle value, or the average of the middle two on an even count. */
function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `rows` from returnsForDay, split into the composite bands. */
function bucketReturns(rows) {
  return SCORE_BUCKETS.map((bucket) => {
    const rets = rows
      .filter((r) => r.composite >= bucket.min && r.composite < bucket.max)
      .map((r) => r.ret);
    return { label: bucket.label, count: rets.length, avg: mean(rets), med: median(rets) };
  });
}

/** Whole days from a local calendar day to today, for the horizon readout. */
function daysSince(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d);
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((midnight - then) / 86_400_000);
}

// ── Price history: storage ──────────────────────────────────────────
/* One IndexedDB record per symbol, keyed by ticker, holding { f, t, c, at, bf }:
   the first and last bar's calendar date, the closes in between, when the
   symbol was last checked, and the oldest date ever requested for it.

   This lived in localStorage until the window went from two years to ten.
   Ten years across the board is ~18.4 MB of closes and the localStorage
   ceiling here is 9.7 MB, so no encoding saves it — IndexedDB is quota-managed
   against the origin's storage budget, which is measured in gigabytes.

   Only PERSISTENCE is async. `state.px.series` is still a plain in-memory Map,
   filled once at boot and read synchronously by every indicator, the board and
   the backtest. The async surface is the handful of functions in this section;
   nothing downstream of them had to change. IndexedDB also stores structured
   clones, so an array of numbers goes in as an array of numbers — no
   JSON.stringify on write and no parse on read. */

const PX_DB = 'bar.px';
const PX_STORE = 'series';

/* ── The consensus snapshot archive ───────────────────────────────────
   A SEPARATE DATABASE, deliberately. Price bars can be re-fetched from Polygon
   whenever they are lost; analyst consensus cannot be re-fetched at all —
   Finnhub serves a rolling four-month window and nothing older exists anywhere
   this app can reach. Losing this store loses the data permanently, so it does
   not share a database, a quota accounting, or an eviction policy with anything
   that is merely expensive to rebuild.

   It exists because the analyst score can never be backtested: there is no
   consensus history to score a past date against. Forward validation from
   accumulated snapshots is the only path that will ever exist, and the clock on
   it starts when the first snapshot is written.

   `bar.history` cannot serve: it is a daily log under a shared 18,000-record
   cap that evicts oldest-first, which at ~580 symbols is a permanent ~31-day
   window. It churns. This does not.

   CADENCE IS MONTHLY BY CONSTRUCTION, not by a timer. Finnhub labels each
   record with a month, and rows are upserted by (symbol, period) — so however
   often the board refreshes, one month of data occupies exactly one row.

   POINT-IN-TIME: `d` is the distribution AS FIRST SEEN for that period, never
   overwritten. A later revision to an already-recorded month increments `rev`
   and updates `dl` instead, so a future backtest can score on what was actually
   knowable at the time while still being able to detect that a restatement
   happened. Overwriting `d` would quietly import hindsight. */
const SNAP_DB = 'bolt.consensus';
const SNAP_STORE = 'snapshots';

/* Per-symbol retention, and there is no cross-symbol eviction of any kind: a
   busy symbol can never push another symbol's history out. Ten years is far
   beyond any horizon this board can test and exists only so the structure has a
   stated bound rather than an unstated one. */
const SNAP_MAX_MONTHS = 120;

let snapDbPromise = null;

function snapDb() {
  if (snapDbPromise) return snapDbPromise;
  snapDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(SNAP_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAP_STORE)) db.createObjectStore(SNAP_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('consensus archive is blocked by another tab'));
  });
  return snapDbPromise;
}

/** Merge a fetched trend into one symbol's archive.

    Returns what changed, so the caller can report accumulation rather than
    guessing at it. Pure apart from the store: given the same existing rows and
    the same trend it always produces the same result. */
function mergeSnapshots(existing, trend, now = Date.now()) {
  const rows = Array.isArray(existing) ? existing.slice() : [];
  const byPeriod = new Map(rows.map((r) => [r.p, r]));
  let added = 0;
  let revised = 0;

  for (const rec of trend || []) {
    const period = String(rec?.period || '').slice(0, 7);   // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(period)) continue;
    const d = [rec.strongBuy, rec.buy, rec.hold, rec.sell, rec.strongSell]
      .map((n) => (Number.isFinite(n) ? n : 0));

    const prior = byPeriod.get(period);
    if (!prior) {
      const row = { p: period, d, at: now, rev: 0 };
      byPeriod.set(period, row);
      rows.push(row);
      added++;
      continue;
    }
    // Already recorded. `d` is what was first knowable and stays put.
    const latest = prior.dl || prior.d;
    if (latest.join() !== d.join()) {
      prior.dl = d;
      prior.rev = (prior.rev || 0) + 1;
      prior.revAt = now;
      revised++;
    }
  }

  rows.sort((a, b) => (a.p < b.p ? 1 : a.p > b.p ? -1 : 0));   // newest first
  return { rows: rows.slice(0, SNAP_MAX_MONTHS), added, revised };
}

/** Record one symbol's trend. Never throws — a failed archive write must not
    take down a board refresh, but it is counted so the UI can say so. */
async function recordSnapshot(symbol, trend) {
  if (!symbol || !Array.isArray(trend) || !trend.length) return null;
  try {
    const db = await snapDb();
    const read = db.transaction(SNAP_STORE, 'readonly');
    const existing = await idbRequest(read.objectStore(SNAP_STORE).get(symbol));

    const merged = mergeSnapshots(existing, trend);
    if (!merged.added && !merged.revised) return merged;      // nothing new to write

    const write = db.transaction(SNAP_STORE, 'readwrite');
    write.objectStore(SNAP_STORE).put(merged.rows, symbol);
    await txDone(write);
    return merged;
  } catch {
    state.snap.failed++;
    return null;
  }
}

/* ── EDGAR resolution as a standing check ─────────────────────────────
   `company_tickers.json` lists every CURRENT SEC registrant. A universe symbol
   absent from it has almost always stopped being one — acquired, taken private,
   or delisted — and that is a fact about the universe rather than about EDGAR.

   Measured 2026-09-01: 15 of 579 symbols fail to resolve for that reason, and
   every one of them was already carrying a truncated price series onto the
   board. ALTR's last bar is 2025-03-25, 521 days stale. Nothing in the app
   noticed the cause; the price code noticed only the symptom ("no current
   quote") and the analyst code noticed nothing at all, because it needs no
   prices and happily scored a company that no longer exists from cached
   consensus.

   One call answers it for the whole universe, so this runs weekly rather than
   being something anyone has to remember. It degrades quietly and on purpose:
   without the proxy — an old serve.ps1, or the server not running — the check
   simply does not update, and the last good answer stands. */
const SEC_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

function loadSecRegistry() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS.sec) || 'null');
    if (!saved || typeof saved.at !== 'number') return { at: 0, cik: {}, gone: [] };
    return { at: saved.at, cik: saved.cik || {}, gone: Array.isArray(saved.gone) ? saved.gone : [] };
  } catch {
    return { at: 0, cik: {}, gone: [] };
  }
}

/** Resolve every universe symbol against EDGAR, and remember which failed.

    Returns null when the proxy is unreachable, which is not an error worth
    surfacing — it is the normal state of a page served by a serve.ps1 that
    predates the proxy. */
async function secResolve({ force = false } = {}) {
  if (!force && Date.now() - state.sec.at < SEC_RECHECK_MS) return null;
  try {
    const res = await fetch('/sec/www/files/company_tickers.json');
    if (!res.ok) return null;
    const body = await res.json();

    const byTicker = new Map();
    for (const e of Object.values(body || {})) {
      if (e && e.ticker) byTicker.set(String(e.ticker).toUpperCase(), e.cik_str);
    }
    // A response that shape-checks but carries nothing is a bad answer, not an
    // empty universe — treating it as one would mark every symbol delisted.
    if (byTicker.size < 1000) return null;

    const cik = {};
    const gone = [];
    for (const symbol of DEFAULT_WATCHLIST) {
      const hit = byTicker.get(secTicker(symbol).toUpperCase());
      if (hit == null) gone.push(symbol);
      else cik[symbol] = hit;
    }

    state.sec = { at: Date.now(), cik, gone };
    localStorage.setItem(LS.sec, JSON.stringify(state.sec));
    return state.sec;
  } catch {
    return null;   // no proxy, no network, or malformed JSON
  }
}

/** Whether this symbol is known to have stopped being an SEC registrant. */
const notRegistered = (symbol) => state.sec.gone.includes(symbol);

/* ── Per-name assessment, and the log that makes it measurable ────────
   A research layer, not a decision layer. It compresses what is already on the
   board plus a web search into a written brief. It never produces a direction,
   a rating, or a target, and the prompt forbids all three explicitly.

   THE LOG IS THE POINT. Factors here cannot be validated — one independent
   window for the twelve-month technicals, and the analyst domain cannot be
   backtested at all. An assessment log is the one thing in this project that
   accumulates into something scorable: every entry records what was known at a
   moment, so a later pass can join it against subsequent price action and ask
   whether the concerns it raised preceded anything.

   That only works if the record is joinable, which drove three decisions:
   raw counts are stored beside every derived category so a threshold can change
   without invalidating history; the categorical fields come from a FIXED enum,
   because a category added later splits the record; and nothing is ever
   overwritten. */
const ASSESS_DB = 'bolt.assessments';
const ASSESS_STORE = 'assessments';

/* The model registry lives above `state` — see the note on its declaration. */

/* Bound on the search tool. Each search is $0.01 and each one's results land in
   context on every subsequent turn of the same request, so an uncapped search
   loop costs on both axes at once. */
const ASSESS_MAX_SEARCHES = 6;

/* FIXED ENUM. Adding a value later splits the record: entries written before
   the addition cannot be distinguished from entries where the model considered
   the new category and rejected it. Treat this list as append-only at worst,
   and prefer not to touch it.

   Every value names an EVENT — something that happened or is scheduled — never
   a standing characteristic, and never an interpretation. That rule is what
   makes "did flagged names underperform" answerable: a flag that is
   permanently true of a company (a single-product business) or that describes
   the explanation rather than the company (a sector-wide move) would sit in the
   same array and make the question meaningless. */
const ASSESS_CONCERNS = [
  'earnings_imminent',                 // scheduled within ~30 days
  'earnings_result_recent',            // reported within ~30 days
  'guidance_cut',
  'guidance_raised',
  'guidance_withdrawn',
  'pending_litigation',                // private plaintiff, material
  'regulatory_enforcement',            // an agency acting AGAINST the company
  'regulatory_decision_pending',       // approval/clearance the company awaits
  'accounting_or_audit_concern',       // restatement, auditor change, material weakness, allegation
  'merger_or_acquisition_pending',     // either side
  'executive_change',                  // CEO, CFO or board chair only
  'dilution_or_offering',
  'buyback_or_dividend_change',
  'debt_or_liquidity_concern',
  'short_report_or_activist',
  'operational_disruption',            // recall, outage, cyber incident, plant loss
  'key_customer_or_contract_change',
  'index_or_listing_change',
];

/* Standing characteristics live apart from events, deliberately — see above. */
const ASSESS_STRUCTURAL = [
  'single_product_dependency',
  'single_customer_dependency',
  'binary_regulatory_outcome',         // one approval decides the business
  'recent_ipo_or_short_history',
];

let assessDbPromise = null;
function assessDb() {
  if (assessDbPromise) return assessDbPromise;
  assessDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(ASSESS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ASSESS_STORE)) {
        /* Keyed by symbol|timestamp so nothing can overwrite anything. An
           assessment is a dated observation, not a current value. */
        const store = db.createObjectStore(ASSESS_STORE, { keyPath: 'id' });
        store.createIndex('symbol', 'symbol', { unique: false });
        store.createIndex('at', 'at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('assessment log is blocked by another tab'));
  });
  return assessDbPromise;
}

/** Every data-quality flag on this row, as text the model is told to lead with.

    Passed explicitly rather than left to be inferred from the numbers, because
    the numbers look fine — that is the whole failure mode. MRNA's volatility
    reads 192% and nothing about the figure says one bar produced 117 points of
    it. The ex-bar values go in too, so the brief can say what the factor reads
    without the anomaly rather than reasoning from a number that is wrong. */
function assessFlags(row) {
  const flags = [];
  if (notRegistered(row.symbol)) {
    flags.push('NOT A CURRENT SEC REGISTRANT — acquired, delisted or taken private. Any score shown is computed from cached data about a company that no longer trades.');
  }
  if (row.pxNote) flags.push(`PRICE DATA UNUSABLE: ${row.pxNote}. No technical factor is scored.`);
  if (row.pxGap) flags.push(`PRICE SERIES HAS MISSING BARS: ${row.pxGap}. Price-derived factors are withheld.`);
  if (row.pxAnomaly) {
    const a = row.pxAnomaly;
    /* The series may not be hydrated when this runs, and a missing date must
       not cost the whole flag — the flag is the point, the date is a detail. */
    const series = state.px.series.get(row.symbol);
    const day = series ? dayAtIndex(series, a.at) : `bar ${a.at}`;
    flags.push(`A SINGLE BAR DOMINATES SEVERAL FACTORS: ${day} moved ${a.barPct.toFixed(0)}%, which alone `
      + `accounts for ${a.inflation.toFixed(0)} points of annualised volatility (${a.volReported.toFixed(0)}% reported, `
      + `${a.volExBar.toFixed(0)}% without it). Affected: ${Object.keys(a.exBar).join(', ')}. `
      + `Without that bar: ${Object.entries(a.exBar).map(([k, v]) => `${k} = ${v.toFixed(2)}`).join(', ')}. `
      + `Whether the bar is a data fault or a real move is NOT established.`);
  }
  if (row.movedSince != null && Math.abs(row.movedSince) >= PRE_MOVE_FLAG) {
    flags.push(`PRICE HAS MOVED ${row.movedSince > 0 ? '+' : ''}${row.movedSince.toFixed(1)}% since the `
      + `${row.latest?.period} consensus period began — every analyst rating below predates that move.`);
  }
  if (row.earnYield == null) flags.push('NO EARNINGS YIELD: trailing earnings are negative, or there is no current share count. A loss is not a low yield, so the factor is withheld rather than scored badly.');
  if (row.bookToMkt == null) flags.push('NO BOOK-TO-MARKET: book value is negative, or there is no current share count.');
  if (row.roe == null) flags.push('NO RETURN ON EQUITY: average equity is negative, which would make the ratio read positive.');
  /* NAMES ONE FACTOR, NOT FOUR. This read "FUNDAMENTALS ARE ON A FISCAL-YEAR
     BASIS ... these figures may be up to twelve months old", which reads as all
     four and is wrong for three of them: earnings yield and return on equity
     come from a plain TTM of net income, which is on four quarters for 558 of
     561 symbols. Two briefs raised it as though the whole domain were stale
     before the wording was measured against the data. It also said "up to
     twelve months" where the actual date is known, so it is stated. */
  /* Only when the figures really are a filed fiscal year — meaning the newest
     fact on file IS the annual, so there is nothing more recent to roll to.
     A `TTM` basis is twelve months to the most recent quarter and is not a
     staleness condition at all, so it raises nothing. */
  if (row.fxBasis === 'FY') {
    const days = row.fxEnd
      ? Math.round((Date.now() - Date.parse(`${row.fxEnd}T00:00:00Z`)) / 86400000) : null;
    flags.push(`ACCRUALS COVER THE FILED FISCAL YEAR${row.fxEnd ? ` to ${row.fxEnd}`
      + `${days == null ? '' : `, ${days} days ago` }` : ''} — the newest figures on file for this `
      + 'symbol are annual, so there is no more recent quarter to roll to. This applies to '
      + `accruals only.${row.fxNiBasis === 'TTM'
        ? ` Earnings yield and return on equity are NOT affected: both run twelve months to ${row.fxNiEnd}.`
        : ' Net income is annual too, so earnings yield and return on equity cover the same year.'}`);
  }
  /* Withheld beats unverified: if the gate refused the number outright there is
     nothing to be unverified ABOUT, and reporting both would read as two
     separate problems with one figure. */
  if (row.fxWithheld) {
    flags.push(`FUNDAMENTALS WITHHELD BY THE RECONCILIATION GATE — ${row.fxWithheld}. `
      + 'The figures were computed and then refused, so their absence is a finding rather '
      + 'than a gap. Do not describe this symbol as lacking filings.');
  } else if (row.fxNiVerified === false) {
    /* The nine. Raised per row because nine IS rare. The cash-flow equivalent
       holds on 545 of 561 and is stated in the standing context instead — a
       flag that fires on almost every row trains its reader to skip it. */
    flags.push('NET INCOME IS UNVERIFIED — this filer publishes no discrete quarterly net income, '
      + 'so the usual cross-check (a differenced year-to-date cumulation against the separately '
      + 'filed quarter covering the same period) has nothing to compare against. The reconciliation '
      + 'did NOT fail; it could not be run. Only 9 of 561 symbols are in this position, so it is '
      + 'genuinely unusual here. Treat earnings yield and return on equity as unconfirmed rather '
      + 'than as suspect.');
  }
  if (!state.fx.facts.has(row.symbol)) flags.push('NO SEC FILINGS STORED for this symbol — every fundamentals factor is absent.');
  return flags;
}

/** Insider activity for the brief, with the two filer types kept apart and the
    coverage gap stated.

    Separated because the merged figure produced a brief that reported "net
    insider activity of −10.2M shares" for FANG and reasoned about it as
    conviction, when 98.3% of it was one holder trimming a 26% stake. The model
    had no way to know — it was handed a single signed number. */
function insiderContext(row) {
  const i = row.insider;
  if (!i) return '  INSIDER ACTIVITY: no Form 4 data for this symbol.';

  const line = (g, label) => (g && g.net != null
    ? `    ${label}: net ${g.net > 0 ? '+' : ''}${g.net.toLocaleString()} shares `
      + `(bought ${g.bought.toLocaleString()}, sold ${g.sold.toLocaleString()}) across ${g.trades} trade${g.trades === 1 ? '' : 's'}.`
    : `    ${label}: no open-market trades.`);

  return `  INSIDER ACTIVITY, open-market only (Form 4 codes P/S), last ${INSIDER_LOOKBACK_DAYS} days.
${line(i.officer, 'Officers and directors')}
${line(i.holder, 'Beneficial owners above 10%')}
${i.unknown.net != null ? `${line(i.unknown, 'Filer type could not be determined (no current share count)')}\n` : ''}    These two mean different things and must NOT be added together: an officer selling is a judgement about the company, a large holder trimming a stake is portfolio mechanics and can be a hundred times larger. Report them separately or not at all.
    COVERAGE GAP: Form 4 binds officers, directors and holders above 10% ONLY. A holder below 10% — which is most institutions — files 13F/13G instead and does not appear here at all, so a large institutional sale is invisible in these figures. Absence of selling here is not evidence that no large sale occurred.`;
}

/** The board's view of one symbol, as plain text. */
function assessContext(row) {
  const rec = state.fx.facts.get(row.symbol);
  const ni = rec ? fxTTM(rec.f.netIncome) : null;
  const eq = rec ? fxLatest(rec.f.equity) : null;
  const sh = rec ? fxLatest(rec.f.shares) : null;
  const flags = assessFlags(row);
  const pct = (v, d = 1) => (v == null ? 'n/a' : `${v.toFixed(d)}%`);

  /* The price anchors. Two decimals throughout and nowhere else in this
     context, so the provenance check has an unambiguous set of figures to
     match a citation against — see entryLevelUncited. */
  const anchors = priceAnchors(state.px.series.get(row.symbol)?.c, row.price, row.realisedVol);
  const usd = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : 'n/a');
  /* Book value per share is the one price the FUNDAMENTALS half can produce.
     Book-to-market is already scored on exactly this quantity over the market
     cap; the per-share figure is the same number in price units. */
  const bookPerShare = eq && sh && sh.v > 0 ? eq.v / sh.v : null;

  const scores = allScores().map((s) => `  ${plainLabel(s.label)} (${s.domain.label}, ${s.status}): `
    + `${row[s.field] == null ? 'no score' : s.format(row[s.field])}`).join('\n');

  return `SYMBOL: ${row.symbol} — ${row.name} (${row.sector})
Price ${row.price ?? 'n/a'}, ${pct(row.changePct, 2)} today.
Overall ${row.overall == null ? 'n/a' : row.overall.toFixed(1)} of 100, from ${row.overallParts} of ${row.overallOf} domains.

DATA QUALITY FLAGS (${flags.length}) — address these FIRST if any are present:
${flags.length ? flags.map((f) => `  ! ${f}`).join('\n') : '  none'}

FACTOR SCORES (0–100; higher is better; "external" means the evidence is published literature, not measured on this board):
${scores}

RAW TECHNICALS: momentum 12−1 ${pct(row.mom12m1m)}, momentum 6−1 ${pct(row.mom6m1m)}, realised volatility ${pct(row.realisedVol)}, max drawdown ${pct(row.maxDD)}${
  row.ddBasis && row.ddBasis !== PX_BASIS.NONE ? ` (${intradayBasisNote(row.ddCoverage) || 'close-to-close'})` : ''
}, vs 200-day ${pct(row.maGap)}, RSI ${row.rsi14?.toFixed(0) ?? 'n/a'}, 52-week position ${pct(row.rangePos, 0)}, ${row.bars || 0} daily closes stored.

PRICE ANCHORS — the ONLY figures a level may be built from. These are the same quantities as the percentages above, in price units; the percentages are not a second, independent source. Anything not listed here is not available to you, however confidently you can recall it.
  Current price ${usd(row.price)}${anchors.lastClose == null ? '' : `, last stored close ${usd(anchors.lastClose)}`}.
  52-week closing range ${usd(anchors.low52)} to ${usd(anchors.high52)} — closes only, so it excludes intraday extremes and may exclude today.
  200-day moving average ${usd(anchors.ma200)}.
  Nearest support below ${usd(anchors.support)}; nearest resistance above ${usd(anchors.resistance)}. Experimental: clustered from closes, no volume weighting, and "n/a" means nothing qualified rather than nothing exists.
  Book value per share ${usd(bookPerShare)} — the same quantity book-to-market is scored on, per share.
  One quarter at the realised volatility above is ${usd(anchors.sigma)} of price movement (1 sigma), giving a one-sigma band of ${usd(anchors.bandLow)} to ${usd(anchors.bandHigh)}.

RAW FUNDAMENTALS (${row.fxBasis || 'none'} basis${row.fxOcfVerified === false
  ? '; the cash-flow half of accruals is unreconciled — filers publish only Q1 of operating cash flow as a discrete quarter, so 545 of 561 symbols have nothing to cross-check it against. This is a standing limit of EDGAR, not a defect of this symbol, and it is NOT worth remarking on unless something else about the accruals reading is odd'
  : ''}): earnings yield ${row.earnYield == null ? 'n/a' : (row.earnYield * 100).toFixed(2) + '%'}, book-to-market ${row.bookToMkt?.toFixed(3) ?? 'n/a'}, return on equity ${row.roe == null ? 'n/a' : (row.roe * 100).toFixed(1) + '%'}, accruals ${row.accruals?.toFixed(3) ?? 'n/a'}.
${ni ? `  Trailing net income $${(ni.v / 1e9).toFixed(2)}B (${ni.basis} to ${ni.end}, first filed ${ni.filed}).` : ''}
${eq ? `  Equity $${(eq.v / 1e9).toFixed(2)}B as of ${eq.e}.` : ''}

ANALYST CONSENSUS (period ${row.latest?.period ?? 'n/a'}): ${row.composite?.toFixed(2) ?? 'n/a'} of 5 from ${row.analysts ?? 0} analysts.
  Distribution — strong buy ${row.latest?.strongBuy ?? 0}, buy ${row.latest?.buy ?? 0}, hold ${row.latest?.hold ?? 0}, sell ${row.latest?.sell ?? 0}, strong sell ${row.latest?.strongSell ?? 0}.
  Three-month drift ${row.momentum?.toFixed(3) ?? 'n/a'}, coverage change ${row.coverageChange ?? 'n/a'}.
${insiderContext(row)}`;
}

/* The system prompt. Deliberately long and completely stable: it is the cached
   prefix, and prompt caching is prefix-matched, so a single varying byte here
   would cost the cache on every call. Nothing symbol-specific appears in it. */
const ASSESS_SYSTEM = `You produce short research briefs on publicly traded companies for a personal research tool. You are a RESEARCH layer, not a decision layer.

ABSOLUTE PROHIBITIONS. These are not stylistic preferences and there is no phrasing that satisfies them while evading them:
- NEVER give a buy, sell, or hold recommendation, in any wording.
- NEVER give a price target, a price forecast, or a predicted direction.
- NEVER say a stock is cheap, expensive, undervalued, overvalued, attractive, or unattractive.
- NEVER rate, score, or rank the investment merit of the company.
- NEVER advise an action ("worth watching", "one to consider", "avoid") — these are recommendations in softer words.
If you find yourself about to write a conclusion about what someone should do, stop and describe the evidence instead. Compression of research is the value here. Forecasting is not.

You may and should: restate what the factor scores say, report what has happened with dates and sources, identify what could invalidate the picture, and say plainly what you could not determine.

LEAD WITH DATA QUALITY. The board context includes explicit data-quality flags. If any are present, your first section must open with them and say what they mean for the scores that follow — a factor built on a broken input should be named as such before it is discussed. A confident brief about a company whose data is wrong is worse than no brief. Do not soften these; do not bury them.

Four sections, always, in this order:
1. WHAT THE BOARD SAYS — restate the scores plainly, in ordinary language. Name which are strong, which are weak, which are absent and why. Do not interpret them as a verdict.
2. WHAT HAS HAPPENED RECENTLY — from your web search. Every claim needs a date and an attributable source. If the search found little, say so; do not pad.
3. WHAT COULD BREAK THIS — pending earnings, litigation, regulatory action, acquisitions, accounting concerns, anything that would change the picture regardless of the scores. Include data-quality issues here again if they are material.
4. WHAT IS UNCERTAIN — what you could not determine, what the sources disagreed on, what is stale.

Be concise. A section with nothing to say should say that in one sentence rather than filling space. Prefer specifics with dates over general characterisation.

THE DIRECTIONAL FIELDS, AND THEIR BOUNDARY. Separately from the four sections you will give four structured judgments. These are the ONLY places a directional judgment belongs, and they exist so that judgment is recorded in fields that can be scored against subsequent price action later — not so it can spread into the prose.

- \`rating\`: an integer 1–10 with a one-line \`rating_basis\`. Your overall judgment, on no stated horizon. This field predates the two below and is kept unchanged so that entries either side of the split stay comparable.
- \`call_near\`: an integer 1–10 with a one-line \`call_near_why\`. The view over ROUGHLY THE NEXT QUARTER — the horizon the board's factors operate on. Momentum decays over about three months, so this is a judgment about the setup: the technical position, the analyst drift, what is about to happen. It is scored against 1-month and 3-month forward returns.
- \`call_long\`: an integer 1–10 with a one-line \`call_long_why\`. The view over ONE TO THREE YEARS, which is a judgment about the business rather than the setup: competitive position, whether earnings can compound, structural risks to the model. Evidence for this is different evidence — a quarter's momentum is close to irrelevant to it.
- \`entry_level\`: a number, or null. See below.

THE TWO CALLS ARE ALLOWED TO DISAGREE, AND SHOULD WHEN THE EVIDENCE DOES. A strong business at a stretched entry is a low \`call_near\` with a high \`call_long\`, and that combination is the reason the field was split — do not reconcile them into a single view, and do not let one anchor the other. If they agree, they agree because the evidence agreed, not because agreement is tidier.

\`entry_level\` — READ THIS CONDITION EXACTLY. It is a price at which the near-term setup would look materially better, and it applies to \`call_near\` ONLY: a long-term view about a business does not have a limit price attached.

WHERE THE NUMBER MUST COME FROM. It must be arithmetic on the figures under PRICE ANCHORS in the context you were given, and on nothing else. Those are the only prices you have. Do not use a 52-week high or low, a moving average, a support level, a book value or any other price that you know from elsewhere, recall from training, or found in your web search — even if you are confident it is correct, and even if it is correct. A figure that is right but was not supplied is still a fabrication for this purpose, because the record has to say what the board could support. \`entry_level_basis\` must name the anchor and show the arithmetic in one line, for example "support at 118.40, taken directly" or "52-week low 134.30 plus 28% of the range to 216.90 = 157.43". Every price in that line will be checked against the context and a level citing a price that is not there will be rejected on receipt.

HOW FAR IT MAY BE FROM THE CURRENT PRICE. Within ONE SIGMA below the current price, using the one-sigma band given in the context. That band is a quarter's worth of movement at this symbol's own realised volatility, and \`call_near\` is a quarter-horizon judgment, so a level outside it is a level the quarter will almost certainly not reach — which answers no question that was asked. A level two sigma down is not a more conservative version of the same claim; it is a claim about a different horizon. If the anchor you would naturally cite sits below the band, either build a level inside the band from it (a fraction of the range, not the endpoint) or return null. Do not stretch the band to fit an anchor.

If no anchor supports a level inside the band, return null for BOTH fields. A null is a correct and expected answer here and is counted as one — it is not a failure to produce output, and a level invented to avoid returning null is the worst answer available.

\`entry_stance\` — WHICH OF FOUR THINGS YOU ARE SAYING. Always required, including when you gave a level. A null \`entry_level\` used to mean two opposite things at once and nothing reading the record could tell them apart, so say which one it is:
- \`level\` — you are giving a level. \`entry_level\` must be a number.
- \`at_market\` — NO LEVEL IS NEEDED. The current price is an acceptable entry for the near-term view you just gave, and you do not expect a materially better one inside the quarter. This is a POSITION and it is scored as one; it is not a failure to produce a level. It is the right answer whenever you would otherwise invent a level to avoid a null, and it should be common for any name you are neutral to positive on at the current price.
- \`outside_band\` — you would want a lower entry, but every anchor you could cite sits below the one-sigma band, so there is no admissible level. You are saying "wait" without being able to say where.
- \`no_anchor\` — the anchors given do not support a level at all.

Set \`entry_level\` to null for the last three. Do NOT reach for \`no_anchor\` as a default: it says the board gave you nothing to work with, which is a claim about the context and is rarely true now that the anchors are listed. If the honest answer is that this price is fine, say \`at_market\`.

\`entry_level_basis\` explains the ENTRY DECISION, not only the arithmetic, so it is required for three of the four stances. For \`level\`, name the anchor and the arithmetic as described above. For \`at_market\`, say in one line why the current price is acceptable — this is a position that gets scored, and a position with no stated reason is not auditable. For \`outside_band\`, name the anchor you would have used and where it sits. Only \`no_anchor\` may leave it null. Any price you write in this line is checked against the anchors whatever the stance.

The prohibitions above still apply to all four prose sections without exception. Do not justify, preview, hedge, or restate any of these judgments anywhere in them. A section that says "as reflected in the rating below" or "this looks like a 7" has broken the rule, and so has one that mentions an entry price. Write the prose exactly as you would if none of these fields existed, then fill them in.

These are your own judgments and nothing validates them. Do not present them as derived from the factor scores, and do not describe any of them as a recommendation. Each basis line names what drove the number — for example "strong momentum and profitability, offset by a volatility artefact that makes the risk scores unreadable".`;

/** Build the request body. Kept pure so a test can inspect it without a key.

    `context` is a parameter so the caller can hold on to the EXACT string that
    was sent and check the returned citation against it. Rebuilding it after the
    response would re-read `state` — a price that moved mid-call, a fundamentals
    refresh — and check the citation against a context that was never sent. */
function assessRequest(row, model = ASSESS_MODEL_DEFAULT, context = assessContext(row)) {
  const cfg = ASSESS_MODELS[model] || ASSESS_MODELS[ASSESS_MODEL_DEFAULT];
  return {
    model,
    max_tokens: 4000,
    system: [{
      type: 'text',
      text: ASSESS_SYSTEM,
      /* The one stable prefix in the request. On a batch this is read from
         cache for every symbol after the first. */
      cache_control: { type: 'ephemeral' },
    }],
    tools: [{
      type: cfg.search,
      name: 'web_search',
      max_uses: ASSESS_MAX_SEARCHES,
    }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          /* Every field required, including the nullable ones: the API's schema
             subset has no way to say "present or absent", so an optional field
             is one the model may simply omit — and an omitted `entry_level` is
             indistinguishable from a refused one. Required-and-nullable makes
             the refusal explicit and countable. */
          required: assessSchemaFields(),
          properties: {
            board_says: { type: 'string' },
            recent_events: { type: 'string' },
            what_could_break: { type: 'string' },
            uncertain: { type: 'string' },
            /* The one sanctioned directional field. Separate from the prose so
               the prohibition can stay absolute everywhere else, and so the
               judgment lands somewhere a harness can score it.

               ENUM, NOT minimum/maximum. Anthropic's structured-output schema
               subset rejects both keywords outright — "For 'integer' type,
               properties maximum, minimum are not supported", a 400 before any
               token is billed. Measured against the live API on 2026-08-31,
               for `number` as well as `integer`. An explicit value list is the
               only way to bound a number in this schema dialect, and it holds
               the guarantee where it belongs: the model cannot return 0, 11 or
               7.5, so the harness's buckets cannot silently lose a row. */
            rating: { type: 'integer', enum: RATING_VALUES },
            rating_basis: { type: 'string' },
            /* ── The horizon split ──────────────────────────────────────
               Two calls rather than one, because the factors on this board
               operate over about a quarter and a judgment about a business
               operates over years. They are scored on different horizons and
               are allowed to disagree; collapsing them loses the case the
               split exists for, which is a good business at a bad entry.

               Same 1–10 scale and the same enum bound as `rating`, for the
               reason given at `validCall`. */
            call_near: { type: 'integer', enum: RATING_VALUES },
            call_near_why: { type: 'string' },
            call_long: { type: 'integer', enum: RATING_VALUES },
            call_long_why: { type: 'string' },
            /* NULLABLE BY DESIGN, and the null is the common case. The level
               must be arithmetic on a figure already in the board context, so
               a symbol whose context carries no such figure has no level —
               and a model that cannot cite one is required to return null
               rather than estimate. `entry_level_basis` names the figure and
               is checked on receipt: see validEntryLevel. */
            entry_level: { type: ['number', 'null'] },
            entry_level_basis: { type: ['string', 'null'] },
            /* Which of the four things a null level means. Required like
               everything else, so "the model did not say" is impossible rather
               than indistinguishable from "the model said no_anchor". */
            entry_stance: { type: 'string', enum: ENTRY_STANCES },
            /* Events only. Empty means "looked, found none" — see search_status. */
            concerns: { type: 'array', items: { type: 'string', enum: ASSESS_CONCERNS } },
            structural: { type: 'array', items: { type: 'string', enum: ASSESS_STRUCTURAL } },
            /* The distinction you cannot get from an empty array alone. */
            search_status: { type: 'string', enum: ['completed', 'failed', 'not_attempted'] },
            /* Raw counts, so a thinness threshold can be changed later without
               invalidating entries already written. */
            distinct_sources: { type: 'integer' },
            oldest_source_date: { type: ['string', 'null'] },
            newest_source_date: { type: ['string', 'null'] },
            data_quality_led: { type: 'boolean' },
          },
        },
      },
    },
    messages: [{
      role: 'user',
      content: `${context}\n\nSearch for recent news on ${row.name} (${row.symbol}) and produce the brief.`,
    }],
  };
}

/* ── Did it stay non-directional? ─────────────────────────────────────
   The prompt forbids a direction and the schema offers no field to put one in,
   but neither makes the prose comply. This scans the returned brief and records
   what it found. It does not block, rewrite, or retry — a suppressed violation
   is invisible, and the point is a record that can be read later rather than a
   clean-looking log.

   THE HARD PART IS NOT FIRING ON LEGITIMATE REPORTING. The brief is supposed to
   say "the distribution is 2 strong buy, 7 buy" and "the company expects
   revenue of $4B" — a bare /buy/ or /expect/ would fire on both and make the
   flag meaningless within a day. So every pattern requires the MODEL to be the
   one making the claim: a recommendation frame, a valuation verdict, or a
   forecast about the stock rather than a report of someone else's.

   It will still miss things. A boolean from a regex over prose is a smoke
   detector, not a proof, which is why the matched phrases are stored — the
   record is auditable rather than merely trusted. */
const DIRECTIONAL_PATTERNS = [
  // A price target in the model's own voice. "analysts' price target" is
  // reporting, so the negative lookbehind matters more than the pattern.
  /* `citable: true` means the phrase is a normal thing to REPORT about others.
     A price target exists in the world and the brief is supposed to mention
     one; the violation is the model adopting it. These are suppressed when
     their sentence carries an attribution — see ATTRIBUTED below.

     The rest are the model's own voice however they are framed. "Analysts think
     it is undervalued" stays flagged: laundering a verdict through a third
     party is the exact evasion the prohibition names, and the stored sentence
     lets a human overrule it. */
  { id: 'price_target', citable: true,
    re: /\b(price target|target price|fair value of|valued at \$[\d.]+ per share)\b/gi },
  // Valuation verdicts — the model deciding what a price is worth.
  { id: 'valuation_verdict', re: /\b(under-?valued|over-?valued|cheap(?:ly)? (?:at|relative)|expensive (?:at|relative)|attractive (?:entry|valuation|price|level)|compelling value|a bargain|over-?priced|trading below (?:its )?(?:fair|intrinsic))\b/gi },
  // Explicit advice, including the softened forms that are advice in other words.
  { id: 'recommendation', re: /\b(we recommend|I recommend|investors should|worth (?:buying|owning|watching|considering|a look)|one to (?:watch|consider|avoid)|should (?:buy|sell|avoid|accumulate)|steer clear)\b/gi },
  // A forecast about the stock. "the company expects" is excluded by requiring
  // the subject to be the share price or the stock itself.
  /* Both `is` and `are`: an earlier version had only `is` and let "shares are
     poised to rally" through, which a test caught. */
  { id: 'price_forecast', re: /\b(?:(?:stock|shares?|price) (?:should|will|(?:is|are) likely to|(?:is|are) poised to|(?:is|are) set to|could reasonably) (?:rise|fall|climb|drop|outperform|underperform|rally|decline|reach|hit)|(?:expect|anticipate) (?:the )?(?:stock|shares?|price) to)\b/gi },
  { id: 'relative_call', re: /\b(should|will|(?:is|are) likely to) (?:out|under)perform\b/gi },
  // A quantified move — citable, since the brief may report a consensus figure.
  { id: 'implied_move', citable: true,
    re: /\b(?:upside|downside) (?:potential |risk )?of (?:roughly |about |around )?[\d.]+%/gi },
];

/* Marks a sentence as reporting someone else's claim. Tested across the whole
   SENTENCE rather than as a lookbehind: the attribution is usually several
   words from the phrase — "Analysts raised their price target" puts three
   between them — which no fixed-width lookbehind can span. That was a real
   false positive before this replaced it. */
const ATTRIBUTED = /\b(analysts?|consensus|according to|reported(?:ly)?|said|survey|median|mean estimate|raised (?:their|its)|cut (?:their|its)|sell-?side)\b/i;

/** The sentence containing an offset — for attribution, and as stored context. */
function sentenceAt(text, index) {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('\n', index - 1)) + 1;
  let end = text.indexOf('.', index);
  if (end === -1) end = text.length;
  return text.slice(start, end + 1).trim();
}

/** Scan the four prose sections. Returns which section each match came from,
    since a stray "worth watching" in the uncertainty section reads differently
    from a price target in the summary. */
function scanDirectional(brief) {
  const matches = [];
  const suppressed = [];

  for (const [section, text] of Object.entries(brief || {})) {
    if (typeof text !== 'string') continue;
    for (const { id, re, citable } of DIRECTIONAL_PATTERNS) {
      /* Fresh lastIndex per section: these carry /g, and a shared regex object
         would carry `lastIndex` across sections and skip matches. */
      const rx = new RegExp(re.source, re.flags);
      let m;
      while ((m = rx.exec(text)) !== null) {
        // The sentence is the context: enough to judge, and it ends cleanly.
        const hit = { pattern: id, section, phrase: m[0], context: sentenceAt(text, m.index) };
        if (citable && ATTRIBUTED.test(hit.context)) suppressed.push(hit);
        else matches.push(hit);
        if (matches.length + suppressed.length >= 40) break;
      }
    }
  }
  /* Suppressed hits are kept. If the attribution rule turns out to be too
     generous, the evidence for that is in the log rather than discarded. */
  return { flagged: matches.length > 0, count: matches.length, matches, suppressed };
}

/** Derived from raw counts, never stored as the only record of them. */
function coverageBand(sources) {
  if (sources <= 0) return 'none';
  if (sources <= 2) return 'thin';
  if (sources <= 7) return 'moderate';
  return 'rich';
}

/* Is an assessment in flight right now?

   ONE MUTEX FOR BOTH CALL PATHS, and it lives here rather than on the button
   because the button was never the thing that needed serialising. The per-row
   handler disabled the button it was clicked on, which stops a double-click on
   one row and nothing else: eleven rows have eleven buttons, and clicking them
   in sequence fired eleven overlapping calls. The log still shows that run —
   2026-09-01T02:38:33Z to 02:39:03Z, eleven assessments in thirty seconds when
   one call takes twenty.

   Concurrency here is not merely untidy. The proxy checks the daily ceiling
   BEFORE each call, so calls that overlap can all pass a check that only one of
   them should have passed, and the run overshoots by the width of the overlap
   rather than by one call. That is the identical hazard the batch runner was
   made sequential to avoid — see the note above `batchPlan` — and it was
   avoided there and left open here.

   The batch is unaffected: it awaits each name before starting the next, so it
   never contends with itself. What this now also blocks is a row click DURING a
   batch, which was the same overshoot by a third route. */
let assessInFlight = false;

/** Run one assessment and write it to the log. Throws so the caller can report.

    `via` records which path asked — see the note on `via` in the entry below.
    It is a required argument in practice: both callers pass it explicitly, and
    the default is the honest answer for a hand call from the console. */
async function assessSymbol(symbol, model = ASSESS_MODEL_DEFAULT, { via = 'single' } = {}) {
  const row = state.rows.get(symbol);
  if (!row) throw new Error(`${symbol} is not on the board`);

  if (assessInFlight) {
    const err = new Error('An assessment is already running — wait for it to finish.');
    /* Flagged rather than matched on its message: the per-row handler reports
       this differently from a real failure, and a caller should never have to
       parse prose to tell "refused, nothing spent" from "tried, and failed". */
    err.busy = true;
    throw err;
  }
  assessInFlight = true;
  try {
    return await assessOnce(row, symbol, model, via);
  } finally {
    /* In `finally` so a throw anywhere below cannot strand the flag and wedge
       every later assessment behind a run that already ended. */
    assessInFlight = false;
  }
}

/** The body of one assessment. Split out only so the mutex above has a single
    exit — the logic is unchanged and this is never called directly. */
async function assessOnce(row, symbol, model, via) {
  const scoresAtTime = Object.fromEntries(allScores().map((s) => [s.id, row[s.field] ?? null]));
  /* Overall is stored explicitly rather than left to be rebuilt from the
     canonicals later. The harness's control arm splits on it, and
     reconstructing it after the fact would silently use TODAY's domain weights
     and TODAY's canonical choices against a row scored under yesterday's. */
  scoresAtTime.overall = row.overall ?? null;
  scoresAtTime.overallParts = row.overallParts ?? null;
  const flags = assessFlags(row);

  /* Built once and kept. This exact string is what the model was shown, and it
     is what the citation in `entry_level_basis` is checked against — see
     uncitedPrices. Rebuilding it afterwards would validate against a context
     that was never sent. */
  const context = assessContext(row);

  const res = await fetch('/anthropic/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(assessRequest(row, model, context)),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body?.error?.message || body?.error || `HTTP ${res.status}`);
    /* Carried on the error rather than parsed out of its message by the caller.
       The batch runner stops on this and continues on everything else. */
    if (body?.reason === 'ceiling') err.ceiling = true;
    throw err;
  }

  const brief = JSON.parse(body.content.find((b) => b.type === 'text').text);

  /* Sources come from the search result blocks, not from the model's prose —
     a cited URL is a fact about the request, and asking the model to list them
     would let it list ones it did not open. */
  const sources = [];
  for (const block of body.content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;      // an error is an object, not a list
    for (const r of block.content) {
      if (r.url && !sources.some((s) => s.url === r.url)) {
        sources.push({ url: r.url, title: r.title || null, date: r.page_age || null });
      }
    }
  }
  const searches = body.usage?.server_tool_use?.web_search_requests || 0;
  const usd = Number(res.headers.get('X-Bolt-Call-Usd-Est') || 0);

  const briefText = {
    board_says: brief.board_says,
    recent_events: brief.recent_events,
    what_could_break: brief.what_could_break,
    uncertain: brief.uncertain,
  };
  /* Recorded, never enforced. A brief that drifts directional is data about the
     model, and suppressing it would destroy exactly the signal worth keeping.

     SCOPED TO THE PROSE, and `briefText` is exactly the four sections. The
     rating and its basis are deliberately NOT passed: a 1–10 rating is
     directional by definition, and scanning it would flag every assessment and
     destroy the signal the scanner exists for. The prohibition is unchanged
     everywhere it applied before — the rating is a carve-out in its own field,
     not a loosening of the rule. */
  const directional = scanDirectional(briefText);

  /* Checked against the context string that was actually sent, above. */
  const uncited = uncitedPrices(brief.entry_level_basis, context, brief.entry_level);
  const entryLevelOk = validEntryLevel(brief.entry_level, brief.entry_level_basis, uncited);
  const rejection = entryLevelRejection(brief.entry_level, brief.entry_level_basis, uncited);

  const entry = {
    /* SCHEMA VERSION. v1 had no rating; v2 added `rating` and `ratingBasis`.
       This was NOT bumped when the rating shipped, and two JAZZ entries written
       at 01:10 on 2026-09-01 carry `v: 1` with the fields simply absent — while
       every later entry also carries `v: 1` with them present. So the one field
       whose entire job is to answer "what shape is this record" answered
       wrongly, and "written before the field existed" was indistinguishable
       from "written after and the field was dropped".

       That is the difference between a benign gap and a silent failure, and
       nothing in the log could tell them apart. Bump this whenever the entry
       shape changes — it costs one line and it is the only thing that makes an
       absent field readable later. */
    v: ASSESS_ENTRY_V,
    id: `${symbol}|${new Date().toISOString()}`,
    symbol,
    at: Date.now(),
    /* WHICH PATH ASKED: 'single' for a row button, 'batch' for the runner.

       Recorded because it was not, and the absence cost a full analysis. Both
       paths call this one function, so every entry in the log up to v2 is
       silently identical in origin, and the only way to ask "is the batch
       re-assessing names on its own?" was to infer provenance from the gaps
       between timestamps — which can rule a batch OUT (a sequential runner
       cannot produce sub-second gaps) but can never rule one IN, because a
       patient human clicking one row at a time is indistinguishable from it.
       One field ends that guessing for every entry written from here on. */
    via,
    /* Stored so a later join needs only the price series — no refetch, and no
       dependence on the board still holding this row. */
    priceAt: row.price ?? null,
    sector: row.sector ?? null,
    model,
    brief: briefText,
    /* The rating lives OUTSIDE `brief` on purpose. `brief` is the prose the
       scanner sees and the prohibition governs; the rating is a separate
       structured judgment with a separate standing (STATUS.UNSUPPORTED). Nesting
       it inside `brief` would make the two easy to conflate at every later
       call site, including the scanner's. */
    rating: validRating(brief.rating) ? brief.rating : null,
    ratingBasis: brief.rating_basis || null,
    /* The horizon split. Stored beside `rating`, never instead of it: `rating`
       is the baseline these are measured against, and 43 entries already
       depend on it. */
    callNear: validCall(brief.call_near) ? brief.call_near : null,
    callNearWhy: brief.call_near_why || null,
    callLong: validCall(brief.call_long) ? brief.call_long : null,
    callLongWhy: brief.call_long_why || null,
    /* THE GATE IS APPLIED HERE, not trusted to the prompt, and it now checks
       what it always claimed to. A level whose basis cites a price the context
       never contained is stored as null however confidently it arrived — being
       right is not the same as being supported, and the log has to record what
       the board could support. */
    entryLevel: entryLevelOk ? brief.entry_level : null,
    /* The basis is kept even when the level is refused. A rejection reason
       nobody can audit is a second silent failure: without the line it names,
       "cites a price the board did not supply" cannot be checked or appealed. */
    entryLevelBasis: typeof brief.entry_level_basis === 'string'
      ? brief.entry_level_basis.trim() || null : null,
    /* Kept so a rejection is auditable rather than silent. "No level offered"
       and "a level was offered and refused" are different facts about the
       model, and only the second says the gate is doing work. */
    entryLevelRejected: rejection,
    /* The offending figures, not just the count. If this turns out to fire on
       legitimate arithmetic rather than on fabrication, these are what says so
       — and the check is deliberately loose enough that it should not. */
    entryLevelUncited: uncited.length ? uncited : null,
    /* Reconciled, and the model's own answer kept beside it. `entryStance` is
       what the harness reads; `entryStanceDeclared` is what was said, so the
       two disagreeing is a fact in the log rather than something resolved away
       at write time. */
    /* NULL WHEN A LEVEL WAS REFUSED, rather than falling through to
       `no_anchor`. On JAZZ the board supplied two perfectly good anchors and
       the model used them; `no_anchor` would have said the opposite. A null
       with `entryLevelRejected` recorded beside it says what happened without
       inventing a fifth state for it. */
    entryStance: rejection ? null : entryStance(brief.entry_stance, entryLevelOk),
    /* Kept whatever happened to the number. A refused price must not erase the
       answer to "would you buy now" — see the refusal branch in
       horizonSplitHTML, which reads this. */
    entryStanceDeclared: brief.entry_stance ?? null,
    /* The level as a distance from what the model was shown. Stored rather than
       derived later for the same reason `priceAt` is: it fixes the denominator
       to the price at the time, not to a series that may since be adjusted. */
    entryLevelPct: entryLevelOk && Number.isFinite(row.price) && row.price > 0
      ? (brief.entry_level / row.price - 1) * 100 : null,
    /* The same distance in quarterly sigmas, which is the unit the 1-sigma
       bound is written in. Stored so that bound can be reviewed against what
       filled rather than argued about. */
    entryLevelSigmas: entryLevelOk
      ? entryLevelSigmas(brief.entry_level, row.price, row.realisedVol) : null,
    directional,
    concerns: brief.concerns || [],
    structural: brief.structural || [],
    searchStatus: brief.search_status,
    coverage: {
      /* Raw first, derived second. The band is convenience; the counts are the
         record, and only the counts survive a change of threshold. */
      distinctSources: sources.length,
      modelReportedSources: brief.distinct_sources ?? null,
      searches,
      oldestSource: brief.oldest_source_date ?? null,
      newestSource: brief.newest_source_date ?? null,
      band: coverageBand(sources.length),
    },
    dataQualityFlags: flags,
    dataQualityLed: brief.data_quality_led === true,
    sources,
    scores: scoresAtTime,
    usage: { ...(body.usage || {}), usd },
  };

  const db = await assessDb();
  const tx = db.transaction(ASSESS_STORE, 'readwrite');
  tx.objectStore(ASSESS_STORE).put(entry);
  await txDone(tx);
  return entry;
}

/** Fill the model selector from the registry, and show today's spend beside it.

    Built from `ASSESS_MODELS` rather than written into the HTML, so adding a
    model is one entry in one place — the same reason the board's columns come
    from the score registry. */
function renderAssessControls() {
  const sel = $('#assess-model');
  if (!sel) return;

  /* Every option is priced through perCallEstimate, and each carries its own
     basis. The select itself takes the selected model's, so the evidence behind
     the number on screen is one hover away rather than something to be asked
     about later. */
  sel.innerHTML = Object.entries(ASSESS_MODELS).map(([id, cfg]) => {
    const est = perCallEstimate(id);
    return `<option value="${esc(id)}"${id === state.assessModel ? ' selected' : ''} title="${
      esc(est.basis)}">${esc(cfg.label)} ${esc(estimateText(est))}</option>`;
  }).join('');
  const chosen = perCallEstimate(state.assessModel);
  sel.title = `${estimateText(chosen)} per assessment — ${chosen.basis}`;

  /* The day's spend against the ceiling, read from the proxy. Shown next to the
     control that spends it: a ceiling nobody can see is one that only announces
     itself by refusing.

     LABELLED AN ESTIMATE, and the label is not decoration. This figure is
     computed here — token counts from each response multiplied by a pricing
     table typed into pricing.mjs — and is not Anthropic's billing record. It
     will differ, and the ways it differs are listed in the tooltip. Presenting a
     self-computed number in dollars without saying so invites it to be read as
     an invoice. */
  const spend = $('#assess-spend');
  if (!spend) return;
  Promise.resolve(serverDetected ?? true)
    .then((proxy) => (proxy ? fetch('/anthropic/spend') : null))
    .then((r) => (r && r.ok ? r.json() : null)).then((s) => {
    if (!s) return;
    if (!s.hasKey) {
      /* Names the variable, because "no API key" leaves the one actionable fact
         out — and the name is not the obvious one. It is BOLT_ANTHROPIC_KEY
         rather than ANTHROPIC_API_KEY on purpose: Claude Code reads the latter
         and it overrides a claude.ai login, so setting it here would move an
         unrelated tool onto API billing. */
      spend.textContent = 'no BOLT_ANTHROPIC_KEY on the server — Assess is unavailable';
      spend.title = 'Set BOLT_ANTHROPIC_KEY where serve.mjs can read it and restart:\n'
        + '  $env:BOLT_ANTHROPIC_KEY="sk-ant-..."; node serve.mjs\n\n'
        + 'NOT ANTHROPIC_API_KEY — Claude Code reads that name and it takes precedence '
        + 'over a claude.ai login, so setting it switches that session to API billing.';
      spend.classList.remove('assess-spend-over');
      return;
    }
    /* The boundary is read from the server, never restated here. This tooltip
       said "UTC midnight" for as long as the server used it and went on saying
       it afterwards, which is exactly how a boundary nobody can see stays
       wrong. If the server ever stops reporting one, say so rather than
       guessing. */
    const zone = [s.timezone, s.utcOffset].filter(Boolean).join(', ');
    const boundary = s.dayBasis === 'local'
      ? `local midnight${zone ? ` (${zone})` : ''}`
      : s.dayBasis === 'utc' ? 'UTC midnight' : 'a boundary this build could not read';
    const resets = s.resetsAt ? `, next at ${new Date(s.resetsAt).toLocaleString()}` : '';

    /* Dropped, not overwritten: the no-key branch above puts a title on this
       element and the estimate's own tooltip lives on the span inside it, so a
       key appearing mid-session would otherwise leave "no key" advice hovering
       over a working spend line. */
    spend.removeAttribute('title');
    spend.innerHTML = `<span class="assess-est" title="${esc(
      'ESTIMATE, not your bill. Computed locally: the token counts each response '
      + 'reports, multiplied by the list prices in pricing.mjs (verified 2026-09-01), '
      + 'plus $0.01 per web search.\n\n'
      + 'It will differ from what Anthropic charges because:\n'
      + '  • it only counts calls made through THIS proxy — other apps, other machines, '
      + 'or the Console playground on the same key are invisible to it\n'
      + '  • it uses list prices, so any discount on your account is not applied\n'
      + '  • the pricing table is hardcoded and goes stale when prices change\n'
      + '  • an unrecognised model is deliberately priced at the highest known rate\n\n'
      + `The day resets at ${boundary}${resets}.\n`
      + 'It is a day BUCKET, not a 24-hour rolling window: the total drops to zero at that '
      + 'boundary rather than ageing out call by call.\n'
      + 'Refused and errored calls are NOT counted — they carry no usage block and Anthropic '
      + 'does not bill them, so both figures mean billed calls only.\n\n'
      + 'Reconcile against platform.claude.com/cost — see the note in docs/NOTES.md.'
    )}">est.</span> $${s.usd.toFixed(2)} of $${Number(s.ceiling).toFixed(2)} today · ${
      s.calls} call${s.calls === 1 ? '' : 's'}
      <a class="assess-reconcile" href="https://platform.claude.com/cost" target="_blank" rel="noopener"
         title="Anthropic's own daily cost page — the authoritative figure to check this against">reconcile</a>`;
    spend.classList.toggle('assess-spend-over', s.usd >= s.ceiling);
  }).catch(() => { spend.textContent = ''; });
}

/* THE SINGLE-ASSESS PATH IS GONE, and its removal is the point rather than a
   side effect. `runAssessment` sent one call on one click, straight from the
   row, with no quote and no confirm — the only place on this board where money
   left without a number being shown first. Every assessment now goes through
   the queue and the batch runner, which price the run, name the repeats, state
   the remaining headroom and wait for a yes.

   `assessSymbol`'s `via` still defaults to 'single'; nothing passes it any
   more, so every entry written from here on records 'batch'. That is accurate —
   a queue of one name is a batch of one — and the historical 'single' entries
   keep meaning exactly what they meant. See `assessVia`.

   ── Batch assessment ─────────────────────────────────────────────────
   Sequential, never parallel. Three reasons, in order of how much they cost to
   get wrong: the proxy's ceiling is checked before each call, so concurrent
   calls can all pass a check that only one of them should have passed and
   overshoot by the width of the batch rather than by one call; the SEC limiter
   and the Anthropic rate limits both count requests per second; and a run you
   cannot stop halfway is a run whose cost you cannot bound once it starts. */

/** What a batch would cost, before anything is spent.

    Pure, and separated from the runner precisely so the arithmetic can be
    tested without an API key — the numbers a user reads before consenting to a
    charge should not be the one part of this feature that only production
    exercises.

    The per-call figure prefers OBSERVED cost over the table: once the log holds
    calls on this model, the median of what they actually cost is a better
    predictor of the next one than a constant typed in months ago. Median, not
    mean, because one runaway search-heavy call should not drag the estimate for
    twenty ordinary ones.

    IT ALSO NAMES THE REPEATS. `history` was passed in here from the beginning
    and read only for its costs, which meant this function knew every name it
    was about to re-assess and said nothing. Two batch-shaped runs 44 minutes
    apart on 2026-09-01 shared 8 of their 10 names; the dialog priced 10 calls
    and mentioned none of it. A repeat is not an error — it is how a retest pair
    is made — but it has to be VISIBLE before the charge, because a repeat the
    user did not intend costs money and, worse, puts a same-model duplicate into
    a log whose purpose is comparing models. */
/* ── The queue ────────────────────────────────────────────────────────
   A CLICK STARTS AN ASSESSMENT. That was always the gesture and it stays the
   gesture; the queue exists only for what happens to the SECOND click.

   `assessSymbol` holds a mutex — one call at a time, because the proxy checks
   the daily ceiling before each one and concurrent calls can all pass a check
   only one of them should have passed. So a second click while the first was in
   flight used to be refused outright, with a toast saying try again later. That
   is the mutex's constraint leaking into the interface: the user reads the
   board faster than the API answers, and the interface made them wait at the
   API's pace to record a decision they had already made.

   The queue absorbs that. The first click runs immediately. Every click while
   something is running lines that name up, and the runner takes the next one as
   soon as it is free — nothing to press, nothing to confirm, no second gesture.
   Empty queue and idle runner is the resting state, so the whole thing is
   invisible until the moment it is needed.

   NOT PERSISTED, and deliberately. The queue is live work, not a saved
   selection: it exists between the click that filled it and the runner that
   empties it. Restoring one across a reload would mean a page load that resumes
   spending on names chosen before the reload, with nothing pressed. */

/* Membership is asked once per row on every board render — 575 times — so it is
   a Set rebuilt on change rather than an indexOf per row. Position is asked only
   of the rows that are IN it, which is the small number. */
let assessQueueSet = new Set();

/* What the runner is doing, if anything. `symbol` is the name in flight — the
   one call that has already been paid for and cannot be taken back. Module
   scoped rather than on `state` because it must not survive a reload: a stop
   flag or an in-flight marker outliving the run it belonged to would abort or
   mislabel the next one. */
const assessRun = { symbol: null, draining: false, stop: false, stats: null };

const queued = (symbol) => assessQueueSet.has(symbol);
const queuePosition = (symbol) => state.assessQueue.indexOf(symbol) + 1;
const assessing = (symbol) => assessRun.symbol === symbol;

/** Re-index and repaint everything the queue is visible in.

    ONE function for every mutation, for the reason `assessmentsChanged` exists:
    each caller used to be free to forget one of the three, and the one they
    forgot was always the board — leaving a row marked as queued after it had
    been removed from the bar beside it. */
function queueChanged() {
  assessQueueSet = new Set(state.assessQueue);
  renderAssessQueue();
  paintQueueMarks();
  /* The progress line counts what is waiting, so it moves when the queue does
     and not only when the runner takes a new name. Without this, clicking three
     rows during a run left it reading "DDOG…" with no mention of the three. */
  syncRunControls();
}

/** The Stop button and the live progress line.

    Progress is written here only while something is running. When the drain
    ends it is left alone rather than blanked, because the last thing it says is
    the summary of the run that just finished — and a report that erases itself
    the instant it becomes true is no report. */
function syncRunControls() {
  const stop = $('#assess-stop');
  if (stop) {
    stop.hidden = !assessRun.draining;
    stop.disabled = assessRun.stop;
  }
  const prog = $('#assess-progress');
  if (prog && assessRun.symbol) {
    const waiting = state.assessQueue.length;
    prog.textContent = assessRun.stop
      ? `${assessRun.symbol}… stopping after this one`
      : `${assessRun.symbol}…${waiting ? ` · ${waiting} waiting` : ''}`;
  }
}

/** A click on a row's button. Three meanings, decided by what that name is
    already doing:

    IN FLIGHT — nothing. The call is paid for, and Stop follows the same rule:
    what is already sent is allowed to land, because cancelling it would spend
    the money and throw away the brief.

    QUEUED — take it out. The same click that queued it un-queues it, in the
    place the eye is already looking.

    NEITHER — assess it. Immediately if the runner is idle, which is the common
    case and the one that has to stay instant; otherwise it goes to the back of
    the queue and the runner picks it up when it is free. Those are the same
    code path, which is why there is no "start" button anywhere: the queue with
    a runner attached IS the start button. */
function assessClick(symbol) {
  /* Static mode has no Anthropic proxy, and so no key and no spend ceiling.
     The buttons are hidden there too; this is the backstop. */
  if (!state.proxy) {
    toast('Assess needs the local server (serve.mjs) — it is not available on the hosted site.');
    return 'unavailable';
  }
  if (assessing(symbol)) {
    toast(`${symbol} is being assessed now. It cannot be cancelled — the call is already sent.`);
    return 'running';
  }
  const at = state.assessQueue.indexOf(symbol);
  if (at >= 0) {
    state.assessQueue.splice(at, 1);
    queueChanged();
    return 'removed';
  }
  if (state.assessQueue.length >= ASSESS_QUEUE_MAX) {
    toast(`${ASSESS_QUEUE_MAX} names are already waiting. Let some finish first.`);
    return 'full';
  }
  state.assessQueue.push(symbol);
  queueChanged();
  void drainQueue();
  return 'queued';
}

/** Drop names from the queue, wherever they are in it. Silent about names it
    does not hold — every caller is reporting a set that only overlaps it.

    Never touches the name in flight: that one is not in the queue any more, and
    the button and the chip for it both say so rather than offering an × that
    could not do anything. */
function queueDrop(symbols) {
  const gone = new Set(symbols);
  if (!state.assessQueue.some((s) => gone.has(s))) return 0;
  const before = state.assessQueue.length;
  state.assessQueue = state.assessQueue.filter((s) => !gone.has(s));
  queueChanged();
  return before - state.assessQueue.length;
}

/** Assess names off the front of the queue until it is empty.

    ONE runner, however many callers. Re-entrant callers return immediately:
    every path that adds a name calls this, and a second loop would defeat the
    mutex it exists to respect — two drains would submit two calls, both would
    pass a ceiling check only one should have passed, and one would be refused
    with `err.busy` for no reason the user could see.

    Sequential, and the reasons are the batch runner's: the ceiling is checked
    before each call rather than across them, the SEC limiter and the Anthropic
    limits both count requests per second, and a run that cannot be stopped
    halfway is a run whose cost cannot be bounded once it starts.

    A DRAIN is one continuous pass from idle to idle, and the stats belong to
    it. That is what makes the report at the end meaningful: "4 assessed, 1
    failed" is a statement about the run the user just watched, not a session
    total that grows all day. */
async function drainQueue() {
  if (assessRun.draining) return;
  assessRun.draining = true;
  assessRun.stop = false;
  assessRun.stats = { done: 0, failed: [], spent: 0, started: Date.now() };
  syncRunControls();

  while (state.assessQueue.length && !assessRun.stop) {
    const symbol = state.assessQueue.shift();
    assessRun.symbol = symbol;
    queueChanged();
    syncRunControls();

    try {
      const entry = await assessSymbol(symbol, state.assessModel);
      assessRun.stats.done++;
      assessRun.stats.spent += entry.usage?.usd || 0;
      toast(`${symbol} assessed on ${ASSESS_MODELS[entry.model]?.label || entry.model} — `
        + `${entry.coverage.distinctSources} sources, `
        + `${entry.concerns.length} concern${entry.concerns.length === 1 ? '' : 's'}, `
        + `est. $${entry.usage.usd.toFixed(4)}.`
        + `${state.assessQueue.length ? ` ${state.assessQueue.length} still queued.` : ''}`);
      /* The log just gained a call, so the observed median can have moved, the
         row's Assessed cell has something to show and the Recent strip has a
         new head. All three repaint from one place. */
      await assessmentsChanged(symbol);
    } catch (err) {
      /* THE CEILING ENDS THE DRAIN; anything else is this name's problem. A
         ceiling refusal retried once per queued name is that many wasted round
         trips against a limit that will refuse every one of them, and a network
         blip on one name should not discard the rest of the queue.

         `err.busy` cannot happen here — this loop is the only caller and it is
         single-flight — but it is handled rather than counted as a failure,
         because a future second caller would otherwise show up as a mysterious
         failed name instead of as the bug it is. */
      if (err.ceiling) {
        assessRun.stop = true;
        toast(`Stopped at the daily ceiling. ${state.assessQueue.length + 1} name`
          + `${state.assessQueue.length === 0 ? '' : 's'} left unassessed, and nothing was charged for them.`);
        state.assessQueue.unshift(symbol);   // it never ran; it is still waiting
        break;
      }
      if (err.busy) { state.assessQueue.unshift(symbol); break; }
      assessRun.stats.failed.push({ symbol, message: err.message });
      toast(`Assessment failed for ${symbol}: ${err.message}`);
    }
  }

  const stats = assessRun.stats;
  const stopped = assessRun.stop && state.assessQueue.length;
  assessRun.symbol = null;
  assessRun.draining = false;
  assessRun.stats = null;
  queueChanged();
  syncRunControls();

  /* The summary is for a run, not for a click. One name assessed on its own
     already said everything in its own toast, so this would only repeat it. */
  if (stats.done + stats.failed.length > 1 || stopped) {
    const bits = [`${stats.done} assessed`];
    if (stats.failed.length) bits.push(`${stats.failed.length} failed`);
    if (stopped) bits.push(`${state.assessQueue.length} left queued`);
    const prog = $('#assess-progress');
    if (prog) prog.textContent = bits.join(', ');
    /* THE REASON, not just the count — the rule the batch report already
       follows. Seven names failing for one reason is a bug in the request;
       seven failing for seven reasons is the network, and the counts alone
       cannot tell those apart. */
    if (stats.failed.length) {
      const reasons = [...new Set(stats.failed.map((f) => f.message))];
      console.error('[bolt] assessment failures', stats.failed);
      toast(`${bits.join(', ')}. ${reasons.length === 1 ? `All failures: ${reasons[0]}`
        : `${reasons.length} distinct causes — ${reasons[0]} (see console for the rest)`}`);
    } else {
      toast(`${bits.join(', ')}. Est. $${stats.spent.toFixed(3)} spent.`);
    }
    return;
  }
  /* A single name said everything it had to say in its own toast, so the
     progress line goes back to nothing rather than holding one stale ticker. */
  const prog = $('#assess-progress');
  if (prog) prog.textContent = '';
}

/* ── Naming a run by hand ─────────────────────────────────────────────
   "Top n of the board as sorted" answers one question — which names does the
   ranking like — and it is the wrong tool for every other one. Re-running the
   eight names in a retest pair, assessing the three a filing just moved, or
   picking up the two a stopped batch never reached all meant sorting and
   filtering the board until the names you wanted happened to be the first few
   rows, and then trusting that they still were.

   Dots and hyphens survive the split because tickers contain them: BRK.B is on
   this board, and a splitter that ate the dot would turn one real symbol into
   two names that are not. Everything else — commas, whitespace, newlines,
   anything pasted out of a spreadsheet — is a separator. */
const parseSymbolList = (text) => String(text ?? '')
  .toUpperCase().split(/[^A-Z0-9.\-]+/).filter(Boolean);

/* Names are no longer passed in here. `batchPlan` briefly grew a `symbols` mode
   so a typed list could be priced and confirmed like a top-n run; typing now
   assesses on the same terms as a click, so the resolving moved to
   `enqueuePlan` and this went back to the one question it answers: what would
   the top n of the board as currently sorted cost. */
function batchPlan({
  rows, n, model, history = [], spend = null,
  repeatWindowMs = ASSESS_REPEAT_WINDOW_MS, skipRepeats = false, now = Date.now(),
}) {
  const cfg = ASSESS_MODELS[model];
  /* The estimate is no longer computed here. This function was the only caller
     of the median, which is exactly how the dropdown label and the batch quote
     came to disagree — see perCallEstimate. */
  const { usd: perCall, basis } = perCallEstimate(model, observedCosts(history, model));

  const count = Math.max(0, Math.min(Math.floor(n) || 0, rows.length));
  const requested = rows.slice(0, count).map((r) => r.symbol);

  /* The most recent assessment of each requested name inside the window, split
     by whether it used THIS model.

     The split is the whole point. A same-model repeat adds a duplicate reading
     of one thing; a different-model repeat is the deliberate pair that makes a
     comparison possible. Lumping them together would flag the retests the user
     went out of their way to run. Only same-model repeats are skippable. */
  const cutoff = now - repeatWindowMs;
  const wanted = new Set(requested);
  /* symbol -> (model -> newest entry in window). Newest only: "you assessed
     this 40 minutes ago" is the actionable fact, and listing every prior run of
     a name the user has hit four times would bury it. */
  const latest = new Map();
  for (const a of history) {
    if (!a || !wanted.has(a.symbol) || !Number.isFinite(a.at) || a.at < cutoff) continue;
    if (!latest.has(a.symbol)) latest.set(a.symbol, new Map());
    const byModel = latest.get(a.symbol);
    if (!byModel.has(a.model) || a.at > byModel.get(a.model).at) byModel.set(a.model, a);
  }
  const repeats = [];
  for (const symbol of requested) {
    for (const a of (latest.get(symbol)?.values() ?? [])) {
      repeats.push({
        symbol, at: a.at, agoMs: now - a.at, model: a.model,
        label: ASSESS_MODELS[a.model]?.label || a.model,
        rating: Number.isInteger(a.rating) ? a.rating : null,
        sameModel: a.model === model,
      });
    }
  }
  /* Same-model first within a symbol: it is the one that decides the skip. */
  repeats.sort((x, y) => requested.indexOf(x.symbol) - requested.indexOf(y.symbol)
    || (y.sameModel - x.sameModel) || x.at - y.at);
  const sameModelRepeats = repeats.filter((r) => r.sameModel);

  /* Skipping SHORTENS the run; it does not backfill from further down the
     board. Backfilling would quietly assess names the user never saw priced,
     which is the same class of surprise this guard exists to remove. */
  const skipped = skipRepeats ? sameModelRepeats.map((r) => r.symbol) : [];
  const skippedSet = new Set(skipped);
  const symbols = requested.filter((s) => !skippedSet.has(s));
  const total = perCall * symbols.length;

  /* Headroom is what the ceiling still allows, not what the batch wants. A
     batch larger than the headroom is not refused here — the proxy is the
     authority on that and refuses per call — but it is announced, because
     "it will stop early" is the thing a user needs to know BEFORE starting
     rather than discovering at name fourteen. */
  const headroom = spend && Number.isFinite(spend.usd) && Number.isFinite(spend.ceiling)
    ? Math.max(0, spend.ceiling - spend.usd) : null;
  /* The epsilon is not cosmetic: 0.30 / 0.15 is 1.9999999999999998 in binary
     floating point, so a bare floor here quotes two calls where three fit and
     the warning fires on a batch that would have finished. */
  const affordable = headroom == null ? symbols.length
    : Math.min(symbols.length,
        Math.floor(headroom / perCall + 1e-9) + (headroom > 0 ? 1 : 0));

  return {
    symbols, perCall, basis, total, headroom,
    /* +1 above: the guard admits one call that carries the total past the line,
       so the count that can actually run is one more than the count that fits. */
    affordable,
    shortfall: symbols.length - affordable,
    model, label: cfg?.label || model,
    /* What was asked for, before skipping — kept so the dialog can say "10
       requested, 8 running" rather than silently quoting the smaller number. */
    requested,
    repeats,
    sameModelRepeats,
    skipped,
    skipRepeats,
    repeatWindowMs,
  };
}

/* `runBatch` is gone: `drainQueue` is the one runner now, and the two would
   have submitted calls against a ceiling that is checked before each of them
   rather than across them — the exact overshoot the sequential rule exists to
   prevent. Its three behaviours all moved intact and are still tested: the
   ceiling ends the run, one bad name does not abort the rest, and Stop takes
   effect before the NEXT call rather than mid-flight. */

/** The queue, as chips: what is lined up, in what order, and how to take any of
    it back out.

    SHOWN ONLY WHEN IT HOLDS SOMETHING. An empty queue bar is a permanent strip
    of toolbar saying "nothing", on a page whose whole idiom is that an absent
    value renders as absent — see the Assessed cell, which shows nothing rather
    than a dash on the 542 rows with no assessment.

    Every name is named. A row of chips is longer than "4 queued", and it is the
    only form that answers the question a queue actually raises — not how many,
    but WHICH — without hunting the board for marked buttons. */
function renderAssessQueue() {
  const bar = $('#assess-queue');
  if (!bar) return;

  const q = state.assessQueue;
  /* The name in flight is shown here too, first and marked as running. It is no
     longer IN the queue — the runner shifted it off — but the bar's job is "what
     is this thing doing", and a bar that went empty while a call was still out
     would answer that question wrongly at the one moment it matters. */
  const live = assessRun.symbol;
  bar.hidden = !q.length && !live;
  if (bar.hidden) { bar.innerHTML = ''; return; }

  /* What the WAITING names will cost. The one in flight is excluded, because it
     is already spent — a figure that keeps counting money that has left is not
     an estimate of anything. Labelled an estimate for the same reason the spend
     line is: it is computed here from a price table and is not a quoted charge. */
  const est = perCallEstimate(state.assessModel);

  /* The live one first, then the waiting ones in order. No × on the live chip:
     the call is sent and paid for, so an × there would offer to undo something
     that cannot be undone. */
  const liveChip = live ? `<span class="queue-chip queue-chip-live"
      title="${esc(`${live} is being assessed now. The call is already sent and cannot be cancelled.`)}">
      <span class="queue-chip-n">▸</span>${esc(live)}</span>` : '';

  bar.innerHTML = `<span class="assess-queue-label">${live ? 'Assessing' : 'Queued'}</span>`
    + `<span class="assess-queue-chips">${liveChip}${q.map((symbol, i) => {
      /* A queued name can leave the board — removeSymbol takes it out of the
         queue too, so this is the narrow case where a name went while its click
         was still waiting. Marked rather than dropped on sight: the runner
         leaves it out either way, and a chip that vanishes explains nothing. */
      const gone = !state.symbolSet.has(symbol);
      return `<span class="queue-chip${gone ? ' queue-chip-gone' : ''}"${gone
        ? ` title="${esc(`${symbol} is no longer on the board — it will be skipped`)}"` : ''}>
          <span class="queue-chip-n">${i + 1}</span>${esc(symbol)}
          <button class="queue-chip-x" type="button" data-unqueue="${esc(symbol)}"
            aria-label="${esc(`Remove ${symbol} from the queue`)}" title="${esc(`Remove ${symbol} from the queue — nothing has been sent for it`)}">&times;</button>
        </span>`;
    }).join('')}</span>`
    + (q.length ? `<span class="assess-queue-cost" title="${esc(
        `${q.length} waiting × ${estimateText(est)} — ${est.basis}. An ESTIMATE computed here, `
        + 'not a quoted charge. The name already running is not counted: it is spent.')
      }">${estimateText({ usd: est.usd * q.length })}</span>` : '')
    + (q.length ? `<button id="assess-queue-clear" class="btn btn-ghost btn-sm" type="button"
        title="Drop every name still waiting. Nothing has been sent for them. The one running is not affected.">Clear waiting</button>` : '');
}

/** The most recent analyses, as a strip you can click into.

    THE MISSING HALF OF THE FEATURE. A brief is a paragraph of reasoning that
    cost real money to produce, and the only route back to one was to remember
    which ticker it was about, find that row on a 575-row board and open it. The
    Assessed cell says a brief exists; nothing said which briefs are NEW, and a
    run of six left six unmarked needles in the same haystack.

    Newest first, so the thing that just finished is always leftmost — the
    position the eye goes to when a toast says something is done.

    The rating is shown because it is the one part of a brief that fits in a
    chip, and it is shown WEAKLY: it is the field on this board with no external
    evidence behind it (see the Assessed column header), and a strip of bold
    numbers would give it a confidence the column beside it is careful not to. */
function renderAssessRecent() {
  const bar = $('#assess-recent');
  if (!bar) return;

  const recent = state.assessRecent || [];
  bar.hidden = !recent.length;
  if (!recent.length) { bar.innerHTML = ''; return; }

  bar.innerHTML = '<span class="assess-queue-label">Recent</span>'
    + `<span class="assess-recent-chips">${recent.map((e) => {
      const bits = [];
      if (validRating(e.rating)) bits.push(`${e.rating}`);
      if (hasHorizonSplit(e)) bits.push(`${e.callNear}/${e.callLong}`);
      /* A name that has left the board has a brief and no row to open. The chip
         stays — the analysis happened and is still in the log — but it says so
         rather than opening a detail panel with nothing behind it. */
      const gone = !state.symbolSet.has(e.symbol);
      return `<button class="recent-chip${gone ? ' recent-chip-gone' : ''}" type="button"
        ${gone ? 'disabled' : `data-open-assessment="${esc(e.symbol)}"`}
        title="${esc(`${e.symbol} — ${assessModelShort(e.model)}, ${new Date(e.at).toLocaleString()}. `
          + `${validRating(e.rating) ? `Rating ${e.rating}/10. ` : ''}`
          + `${hasHorizonSplit(e) ? `Near ${e.callNear}/10, long ${e.callLong}/10. ` : ''}`
          + (gone ? 'No longer on the board, so there is no row to open.' : 'Click to open the brief.'))}"
        ><span class="recent-chip-sym">${esc(e.symbol)}</span>`
        + `${bits.length ? `<span class="recent-chip-score">${esc(bits.join(' · '))}</span>` : ''}`
        + `<span class="recent-chip-age">${esc(humanAgo(Date.now() - e.at))}</span></button>`;
    }).join('')}</span>`;
}

/* Set by the Recent strip; honoured by the brief's mount, and honoured AGAIN if
   a later render undoes it.

   Two things make this harder than it looks. The brief mounts asynchronously —
   `renderDetail` paints the panel and then fills `#assess-brief` from IndexedDB
   — so scrolling from the click handler would target an element that is still
   empty and has no height. And `renderDetail` runs TWICE for one open: once
   from `showView` and once when `ensureDetailData` resolves. The second rewrite
   destroys the element the first scroll was aimed at and collapses the page
   back to the top, so a request consumed by the first mount scrolls to a brief
   that is about to be thrown away. Measured, not guessed: the first version of
   this scrolled, was silently undone, and left the panel at the top.

   So it is not consumed on use. `showView` clears it whenever the panel moves
   anywhere else, and the mount re-applies it while the page is still at the top
   — which is true exactly when a render has just reset it, and false once the
   user is reading. */
let scrollToBriefFor = null;

/** Open a symbol's detail panel and put the brief in view.

    Uses the same three calls a row click does, so a chip and a row reach an
    identically prepared panel; the only difference is where it is scrolled to. */
function openAssessment(symbol) {
  if (!state.symbolSet.has(symbol)) { toast(`${symbol} is no longer on the board.`); return; }
  scrollToBriefFor = symbol;
  state.detailTab = detailTabFor(state.boardMode);
  showView(VIEW.DETAIL, symbol);
  ensureProfile(symbol);
  ensureDetailData(symbol);
}

/** Every symbol a typed list may name.

    NOT `sortedRows()`. That set is the board as currently sorted, filtered,
    sector-capped and sector-selected, and every one of those is a statement
    about ranking — which is precisely the question a typed list is not asking.
    Resolving "DDOG" against it would refuse the name because the board happens
    to be showing Energy, which is an error message about the wrong thing.

    Removals are still honoured: `symbolSet` is what the board holds, and a row
    the user took off it is not on the board under any reading. */
const namedRunPool = () =>
  [...state.rows.values()].filter((r) => state.symbolSet.has(r.symbol));

/** Move whatever is typed in the ticker box into the queue, and empty the box.

    The box is a KEYBOARD ROUTE INTO THE QUEUE, not a second run list. One list
    that the mouse and the keyboard both fill is a control whose behaviour can
    be stated in one sentence; two lists with a precedence rule between them is
    one whose behaviour has to be discovered.

    Unknown names are caught HERE rather than at the confirm dialog, which is
    the whole reason to resolve at enqueue time: a typo answered in the moment
    it is made is a correction, and the same typo answered three minutes later
    in a dialog about money is an interruption. */
/** What typing `text` would do to `queue`, decided without touching either.

    Split out for the same reason `batchPlan` is: the part that decides is the
    part worth testing, and it should not need a DOM to run. Every name lands in
    exactly one of the four buckets, so the caller can report all of them. */
function enqueuePlan(text, { queue, onBoard, max = ASSESS_QUEUE_MAX }) {
  /* `already` is measured against the queue AS IT WAS, not as it is becoming.
     A name typed twice in one go is one name and nothing worth saying; a name
     that was in the queue before you typed is a fact the user may want to know,
     because it means the run already covered it. Folding the two together
     reported "1 already queued" about a name the user had just added, which is
     an answer to a question nobody asked. */
  const before = new Set(queue);
  const takenNow = new Set();
  const added = [];
  const unknown = [];
  const already = [];
  const overflow = [];
  const push = (list, s) => { if (!list.includes(s)) list.push(s); };

  for (const symbol of parseSymbolList(text)) {
    if (!onBoard.has(symbol)) { push(unknown, symbol); continue; }
    if (before.has(symbol)) { push(already, symbol); continue; }
    if (takenNow.has(symbol)) continue;
    /* The cap is reported name by name rather than as a silent truncation: a
       list that half arrived, with no word about the half that did not, is the
       shape of bug this whole feature exists to avoid. */
    if (queue.length + added.length >= max) { push(overflow, symbol); continue; }
    takenNow.add(symbol);
    added.push(symbol);
  }
  return { added, unknown, already, overflow };
}

function enqueueTyped() {
  const box = $('#assess-symbols');
  if (!box || !box.value.trim()) return 0;

  const plan = enqueuePlan(box.value, {
    queue: state.assessQueue,
    onBoard: new Set(namedRunPool().map((r) => r.symbol)),
  });

  if (plan.added.length) {
    state.assessQueue.push(...plan.added);
    queueChanged();
    /* Typed names run on the same terms as clicked ones: straight away if the
       runner is idle, otherwise in turn. The box is a keyboard route to the
       same gesture, not a way to stage work for later. */
    void drainQueue();
  }

  /* THE BOX KEEPS WHAT DID NOT LAND and clears what did, so the next keystroke
     is a correction rather than a retype. Clearing all of it would throw away
     the one string the user still needs to see. */
  box.value = [...plan.unknown, ...plan.overflow].join(', ');

  /* Every bucket is reported. What landed is visible in the bar anyway, but the
     three that did not are the whole reason this says anything at all. */
  const bits = [];
  if (plan.added.length) bits.push(`${plan.added.length} queued`);
  if (plan.already.length) bits.push(`${plan.already.length} already queued`);
  if (plan.unknown.length) bits.push(`not on the board: ${plan.unknown.join(', ')}`);
  if (plan.overflow.length) bits.push(`queue is full at ${ASSESS_QUEUE_MAX} — left out: ${plan.overflow.join(', ')}`);
  if (bits.length) toast(bits.join(' · '));

  return plan.added.length;
}

/** The top-n button: quote, confirm, then hand the names to the runner.

    STILL TWO CLICKS, and still for the original reason. A row click is one
    name and the user picked it; "the top twenty as the board is currently
    sorted" is twenty names they have not read, and a button that both quotes
    and charges gives no moment to read the quote.

    It does not run anything itself any more. It appends to the same queue the
    row clicks fill and lets `drainQueue` empty it, so there is exactly one
    runner and the two paths cannot collide over `assessSymbol`'s mutex. */
async function onBatchClick() {
  const btn = $('#assess-batch');
  if (!btn || btn.dataset.busy) return;

  const n = Number($('#assess-n')?.value) || 0;
  if (n < 1) { toast('Set how many rows to assess.'); return; }

  btn.dataset.busy = '1';
  try {
    await queueTopN(n);
  } finally {
    delete btn.dataset.busy;
  }
}

async function queueTopN(n) {
  if (!state.proxy) { toast('Assess needs the local server (serve.mjs).'); return; }
  const spend = await fetch('/anthropic/spend')
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (spend && !spend.hasKey) { toast('No API key on the server — Assess is unavailable.'); return; }

  /* Names already waiting or in flight are excluded from the quote rather than
     queued twice: the queue holds each name once, so pricing a duplicate would
     quote money that will never be spent. */
  const held = new Set([...state.assessQueue, assessRun.symbol].filter(Boolean));
  const plan = batchPlan({
    rows: sortedRows().filter((r) => !held.has(r.symbol)),
    n, model: state.assessModel,
    history: await loadAssessments(), spend,
    skipRepeats: $('#assess-skip-repeats')?.checked ?? false,
  });
  if (!plan.requested.length) {
    toast(held.size
      ? 'Every row in that range is already queued or running.'
      : 'No rows on the board to assess.');
    return;
  }
  if (!plan.symbols.length) {
    toast(`All ${plan.requested.length} name${plan.requested.length === 1 ? '' : 's'} `
      + `were assessed on ${plan.label} in the last ${humanWindow(plan.repeatWindowMs)} `
      + 'and "skip repeats" is on. Nothing to run.');
    return;
  }

  /* The quote, in full, before anything is charged. Estimated, and it says so —
     the same honesty the spend line carries, for the same reason. */
  let msg = `Assess ${plan.symbols.length} name${plan.symbols.length === 1 ? '' : 's'} `
    + `from the top of the board on ${plan.label}:\n\n${plan.symbols.join(', ')}\n\n`
    + `Estimated cost: $${plan.total.toFixed(2)} `
    + `($${plan.perCall.toFixed(3)} each, from ${plan.basis}).\n`
    + `This is an ESTIMATE from list prices, not a quoted charge.\n`;

  if (held.size) {
    msg += `\n${held.size} name${held.size === 1 ? ' is' : 's are'} already running or queued and `
      + 'not counted above; the range was taken from the rows below them.\n';
  }

  /* REPEATS, BEFORE THE MONEY LINE IS ACTED ON. Same-model first and named
     individually: "3 repeats" is a number a user scrolls past, and "DDOG 40m
     ago, rated 6" is a fact they can act on. */
  if (plan.sameModelRepeats.length) {
    const already = plan.sameModelRepeats.map((r) => `  ${r.symbol} — ${humanAgo(r.agoMs)} ago`
      + `${r.rating == null ? '' : `, rated ${r.rating}`}`).join('\n');
    if (plan.skipRepeats) {
      msg += `\nSKIPPING ${plan.skipped.length} of ${plan.requested.length} `
        + `already assessed on ${plan.label} within ${humanWindow(plan.repeatWindowMs)}:\n${already}\n`
        + `\nThe run is ${plan.symbols.length} name${plan.symbols.length === 1 ? '' : 's'}, `
        + 'not backfilled from further down the board.\n';
    } else {
      msg += `\nWARNING — ${plan.sameModelRepeats.length} of these ${plan.requested.length} `
        + `${plan.sameModelRepeats.length === 1 ? 'was' : 'were'} already assessed on `
        + `${plan.label} within ${humanWindow(plan.repeatWindowMs)}:\n${already}\n`
        + '\nRe-running them costs money AND writes same-model duplicates into the log, '
        + 'which weakens any model comparison built from it. Tick "skip repeats" to leave them out.\n';
    }
  }
  /* Cross-model repeats are reported, never skipped: this is what a deliberate
     retest pair looks like, and suppressing it would defeat the comparison. */
  const other = plan.repeats.filter((r) => !r.sameModel);
  if (other.length) {
    msg += `\nFor reference, ${other.length} ${other.length === 1 ? 'is' : 'are'} `
      + `assessed recently on a DIFFERENT model (this makes a comparison pair, and is kept):\n`
      + other.map((r) => `  ${r.symbol} — ${r.label}, ${humanAgo(r.agoMs)} ago`).join('\n') + '\n';
  }

  if (plan.headroom != null) {
    msg += `\nToday's remaining headroom: $${plan.headroom.toFixed(2)} of `
      + `$${spend.ceiling.toFixed(2)}.\n`;
    if (plan.shortfall > 0) {
      msg += `\nThis will NOT finish: the ceiling should stop it after about `
        + `${plan.affordable} name${plan.affordable === 1 ? '' : 's'}. `
        + `The rest will be skipped, not charged.\n`;
    }
  }
  msg += '\nQueue them?';
  if (!confirm(msg)) return;

  /* Appended to the same queue a row click fills, and the runner takes it from
     there. Two runners over one mutex would mean two calls submitted against a
     ceiling checked before each of them — the exact overshoot the sequential
     rule exists to prevent. */
  state.assessQueue.push(...plan.symbols.slice(0, ASSESS_QUEUE_MAX - state.assessQueue.length));
  queueChanged();
  void drainQueue();
}


/** Every assessment, newest first. The join surface for later scoring. */
async function loadAssessments(symbol = null) {
  if (state.snapshot) {
    const all = state.snapshot.assessments || [];
    return (symbol ? all.filter((a) => a.symbol === symbol) : [...all]).sort((a, b) => b.at - a.at);
  }
  try {
    const db = await assessDb();
    const tx = db.transaction(ASSESS_STORE, 'readonly');
    const all = await idbRequest(tx.objectStore(ASSESS_STORE).getAll());
    const rows = symbol ? all.filter((a) => a.symbol === symbol) : all;
    return rows.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/* ── The assessment log leaves the browser ────────────────────────────
   Every other number on this board is reproducible: prices refetch, filings
   refetch, scores recompute. The assessment log is the one thing here that
   cannot be recreated at any price — each entry is a dated observation of what
   a model said on a day that has passed, and it is the only input the rating
   harness will ever have. It lives in one IndexedDB, keyed to one origin, one
   browser, one machine. Clearing site data destroys the only evidence that
   could ever validate the rating.

   So: export is a file the user holds, and import merges rather than replaces. */

/* When the fundamentals TTM was corrected. Every assessment logged before this
   carries `scores` computed over a 15-month window — the model was shown
   earnings yields, ROEs and accruals built from four non-consecutive quarters,
   and it reasoned about them in good faith.

   A TIMESTAMP, NOT A MIGRATION. The stored scores are not repaired, and must
   not be: a log entry records what the model was actually shown, and rewriting
   it would turn a faithful record into a reconstruction that never happened.
   The entries stay exactly as written and the boundary is applied at read time,
   so a future join can exclude or segment them without trusting a field that
   older entries were never written with.

   A MOMENT, NOT A DATE. This was first written as 2026-08-31T00:00:00Z, the
   day the fix shipped, and it marked none of the 23 entries then in the log —
   they were all written on 2026-09-01 UTC, hours before the fix went live the
   same day. A date-granular boundary silently classified every contaminated
   entry as clean, which is the failure this constant exists to prevent. The
   newest pre-fix assessment is 2026-09-01T02:39:03Z; the roll went live at
   03:10Z. */
const FX_FIX_AT = Date.parse('2026-09-01T03:10:00Z');

/** Did this entry's stored board context predate the fundamentals fix? */
const predatesFxFix = (entry) => !!entry && entry.at < FX_FIX_AT;

/* Entry schema version. 1 = no rating; 2 = `rating` + `ratingBasis`;
   3 = `via`, recording whether a row button or the batch runner asked;
   4 = the horizon split — `callNear`/`callLong` with their basis lines, and
   `entryLevel` with its cited basis;
   5 = price anchors in the context, the 1-sigma bound, and the provenance
   check — `entryLevelUncited`, `entryLevelSigmas`, and `entryLevelBasis` kept
   on a refusal rather than discarded;
   6 = `entryStance`/`entryStanceDeclared`, splitting a null level into the four
   things it could have meant.

   THE v4 ENTRIES ARE NOT COMPARABLE ON THIS FIELD. Both were produced against a
   context with no price in it but the current one, so their levels cite figures
   the board never supplied and would be refused under v5. They are left exactly
   as written — rewriting them would make the log a reconstruction of what the
   model should have been shown rather than a record of what it was. */
const ASSESS_ENTRY_V = 6;

/** Was this entry written before the calls were split by horizon?

    The same distinction `predatesRating` and `predatesProvenance` draw. A v3
    entry has a `rating` and no calls because the fields did not exist; that is
    a gap, not a refusal, and the harness must not count it as a model declining
    to answer. The 43 entries logged before 2026-09-01 are all of this kind. */
const predatesCalls = (e) => !!e
  && ((e.v ?? 1) < 4) && !Object.prototype.hasOwnProperty.call(e, 'callNear');

/** Was this entry written before a null level had to say what it meant?

    Such an entry with no level is GENUINELY AMBIGUOUS — it could have meant
    either "nothing to cite" or "the price is fine" — and the harness must not
    guess. Reading it as `no_anchor` would be the safer-looking choice and is
    still a guess; reading it as `at_market` would invent a buy-now case that
    nobody claimed. Counted apart instead, the same way every other version gap
    here is. */
const predatesStance = (e) => !!e
  && ((e.v ?? 1) < 6) && !Object.prototype.hasOwnProperty.call(e, 'entryStance');

/** Was this entry written before provenance was recorded?

    The same distinction `predatesRating` draws, for the same reason: a v3 entry
    is one whose origin is KNOWN, and a v1 or v2 entry is one whose origin was
    never captured. Neither is 'single'. Anything that defaulted the missing
    field to a value would invent the very fact the field exists to record, and
    would do it to the 43 entries whose provenance is genuinely unrecoverable. */
const predatesProvenance = (e) => !!e
  && ((e.v ?? 1) < 3) && !Object.prototype.hasOwnProperty.call(e, 'via');

/** How the entry was produced, for display. Null when it was never recorded. */
const assessVia = (e) => (predatesProvenance(e) ? null : (e?.via ?? null));

/** Was this entry written before the rating field existed?

    Distinguishes an absent field from a rejected one, which the log could not
    do on its own — see the note on `v` in assessSymbol. A v1 entry was never
    asked for a rating; a v2 entry with `rating: null` was asked and its answer
    failed validation. Those are different facts and only the second is a fault.

    Falls back to inspecting the key for entries written during the window when
    the version was wrong, which is the two JAZZ records of 2026-09-01T01:10Z. */
const predatesRating = (e) => !!e
  && ((e.v ?? 1) < 2) && !Object.prototype.hasOwnProperty.call(e, 'rating');

const ASSESS_EXPORT_V = 1;

/** Wrap the log for export. Pure, so the shape is testable without a database. */
function assessExport(entries, meta = {}) {
  return {
    format: 'bolt.assessments',
    v: ASSESS_EXPORT_V,
    exportedAt: new Date().toISOString(),
    /* Recorded because an import into a different browser has no other way to
       know what board produced these, and because a log merged from two
       machines should say so. */
    origin: meta.origin ?? null,
    count: entries.length,
    entries,
  };
}

/** Validate and merge an imported file against what is already held.

    Pure: takes the parsed file and the existing entries, returns what to write
    and what it decided. Nothing here touches IndexedDB, so every branch —
    including the ones that reject — is testable.

    THE MERGE RULE IS ADD-ONLY. An id already held is skipped, never
    overwritten, for the same reason the store is keyed by `symbol|timestamp`
    and nothing is ever updated in place: an assessment is an observation, and
    an import that silently replaced one would rewrite history from a file whose
    provenance nobody checked. A genuine re-run on the same symbol gets a
    different timestamp and therefore a different id, so it merges cleanly. */
function assessImport(file, existing) {
  if (!file || typeof file !== 'object') {
    return { ok: false, error: 'Not a JSON object.' };
  }
  if (file.format !== 'bolt.assessments') {
    return { ok: false,
      error: `Not a Bolt assessment export (format is ${JSON.stringify(file.format ?? null)}). `
        + 'Refusing rather than guessing at the shape.' };
  }
  if (file.v > ASSESS_EXPORT_V) {
    return { ok: false,
      error: `This file is version ${file.v}; this build understands ${ASSESS_EXPORT_V}. `
        + 'A newer file may carry fields this build would drop on the next export.' };
  }
  if (!Array.isArray(file.entries)) {
    return { ok: false, error: 'The file has no `entries` array.' };
  }

  const held = new Set(existing.map((e) => e.id));
  const add = [];
  const seen = new Set();
  let duplicate = 0;
  let malformed = 0;

  for (const e of file.entries) {
    /* The minimum an entry needs to be joinable at all. Anything short of this
       cannot be scored, cannot be dated, and cannot be attributed to a symbol —
       so it is dropped and counted rather than written where it would inflate
       the log's size without adding a measurement. */
    if (!e || typeof e.id !== 'string' || typeof e.symbol !== 'string'
        || !Number.isFinite(e.at) || !e.brief) { malformed++; continue; }
    if (held.has(e.id) || seen.has(e.id)) { duplicate++; continue; }
    seen.add(e.id);
    add.push(e);
  }

  return {
    ok: true,
    add,
    duplicate,
    malformed,
    /* Reported separately from the entry count because it is the number that
       decides whether the harness gains anything: importing forty assessments
       that carry no rating adds forty rows and zero measurements. */
    rated: add.filter((e) => validRating(e.rating)).length,
    symbols: new Set(add.map((e) => e.symbol)).size,
  };
}

/** Write the log to a file the user keeps. */
async function downloadAssessments() {
  const entries = await loadAssessments();
  if (!entries.length) { toast('Nothing to export — the assessment log is empty.'); return; }

  const payload = assessExport(entries, { origin: location.origin });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  /* Dated, because these accumulate and an undated one overwrites the last. */
  a.download = `bolt-assessments-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* Revoked on a later tick: revoking synchronously can beat the download in
     some browsers and produce an empty file. */
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  const rated = entries.filter((e) => validRating(e.rating)).length;
  toast(`Exported ${entries.length} assessment${entries.length === 1 ? '' : 's'} `
    + `(${rated} with a rating) across ${new Set(entries.map((e) => e.symbol)).size} symbols.`);
}

/** Merge a file back in. Add-only — see assessImport. */
async function uploadAssessments(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`);
    return;
  }

  const existing = await loadAssessments();
  const result = assessImport(parsed, existing);
  if (!result.ok) { toast(`Import refused: ${result.error}`); return; }

  if (!result.add.length) {
    toast(`Nothing new in ${file.name} — ${result.duplicate} already held`
      + `${result.malformed ? `, ${result.malformed} unusable` : ''}.`);
    return;
  }

  const db = await assessDb();
  const tx = db.transaction(ASSESS_STORE, 'readwrite');
  const store = tx.objectStore(ASSESS_STORE);
  /* `add`, not `put`. If an id somehow slipped past the duplicate check the
     transaction fails loudly rather than overwriting an observation. */
  for (const e of result.add) store.add(e);
  await txDone(tx);

  /* Imported entries carry their own costs, so they count toward the median
     exactly like locally-run ones — the estimate is a claim about what this
     model costs, not about who ran it. They fill Assessed cells too, which is
     why the board is repainted and not just the spend line. */
  await assessmentsChanged();

  const bits = [`${result.add.length} imported`, `${result.rated} with a rating`];
  if (result.duplicate) bits.push(`${result.duplicate} already held`);
  if (result.malformed) bits.push(`${result.malformed} unusable`);
  toast(`${bits.join(', ')} — across ${result.symbols} symbol${result.symbols === 1 ? '' : 's'}.`);

  if (state.view === VIEW.RATINGS) renderRatings();
  if (state.view === VIEW.DETAIL) renderDetail(state.selected);
}

/* ── Rating harness ───────────────────────────────────────────────────
   The rating is the only number on this board with no external evidence behind
   it (STATUS.UNSUPPORTED). This is the only thing that could ever change that,
   and it was built at the same time as the rating deliberately — a judgment
   recorded with no means of checking it is just an opinion with a timestamp.

   MEASURED, before any of it was written. Cross-sectional dispersion of forward
   returns across this board's 560 priced names, from the stored series:

       horizon   sd of forward return
       1 month   12.9 points
       3 months  18.8 points
       6 months  30.7 points

   From which, for the top-minus-bottom spread at 6 months, SE = sqrt(2s²/n):

       n per bucket    SE of the spread
       5               19.4 points
       10              13.7 points
       25               8.7 points
       50               6.1 points
       100              4.3 points

   And, at 80% power, the per-bucket sample needed to detect a spread of a given
   size: 30 points needs 17, 20 points needs 37, 10 points needs 148, 5 points
   needs 592.

   Read that honestly. A few dozen assessments puts roughly ten names in each
   bucket, where the SE on the spread is about 14 points — so anything under a
   ~27-point spread is inside two standard errors and says nothing. An effect of
   the size a genuinely useful rating might have (5–10 points) needs several
   hundred assessments PER BUCKET, which at Opus prices is $90–$360 and six
   months of waiting, and the extreme buckets will be the thinnest because a
   model asked for 1–10 will cluster in the middle.

   So this harness is not going to certify a small effect, and it should not be
   read as trying to. What it can do is catch a LARGE effect or a SIGN ERROR —
   a rating that is systematically backwards — and those are worth catching.
   The standard error is printed beside every number rather than in a footnote
   for exactly this reason. */

/* RETAINED FOR THE OCCUPANCY DIAGNOSTIC ONLY — no longer how the harness
   splits. Measured on 41 ratings: 1–3 held 1, 4–6 held 32, 7–8 held 8 and 9–10
   held ZERO, so top-minus-bottom was not computable and never would be by
   waiting. A model asked for 1–10 answers in the middle of it.

   Still worth printing, because "the top bucket is empty" is a fact about the
   field that a median split would hide by construction. */
const RATING_BUCKETS = [
  { label: '1–3', min: 1, max: 3 },
  { label: '4–6', min: 4, max: 6 },
  { label: '7–8', min: 7, max: 8 },
  { label: '9–10', min: 9, max: 10 },
];

/** Split a set of values at their median, high group inclusive of the median.

    TIES ARE THE PROBLEM HERE, not an edge case. The ratings take six distinct
    values across 41 observations with 30 of them a 5 or a 6, so no threshold
    produces two equal groups and the choice of tie rule decides the sizes. The
    rule is stated rather than tuned: `>= median` is high. Picking the threshold
    that happened to balance best would be choosing a split by looking at the
    data, which is how a spread gets manufactured.

    Returns null when every value is identical — there is no split, and a
    degenerate one reported as 41 vs 0 would produce a spread against an empty
    group rather than an honest refusal. */
function medianSplit(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length < 2) return null;
  const median = v.length % 2
    ? v[(v.length - 1) / 2]
    : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  if (v[0] === v[v.length - 1]) return null;

  const nHigh = v.filter((x) => x >= median).length;
  const nLow = v.length - nHigh;
  if (!nHigh || !nLow) return null;
  return { median, nHigh, nLow,
    /* How far from an even split the ties forced it. Reported, because a
       33/8 split and a 21/20 split support very different readings of the
       same spread. */
    balance: Math.min(nHigh, nLow) / v.length };
}

/* Every value a rating may take, DERIVED from the buckets rather than typed out
   beside them. The schema needs an explicit list (Anthropic's structured-output
   dialect has no minimum/maximum — see assessRequest), and a hand-written list
   that drifted from the buckets would admit a value no bucket contains: it
   would pass validation, count toward `n`, and appear in none of the rows the
   harness prints. A row that is in the sample and in no bucket is the worst
   shape this data can take, because nothing about the display reveals it. */
const RATING_VALUES = RATING_BUCKETS.flatMap(
  (b) => Array.from({ length: b.max - b.min + 1 }, (_, i) => b.min + i));

/** True only for a rating the buckets can actually hold.

    Applied on receipt as well as declared in the schema. The schema is the
    guarantee; this is what happens when the guarantee is wrong — a model
    ignoring an enum, a schema edited without this being updated, or a log entry
    written by an older version of this file. An out-of-range value is stored as
    null, which reads as "no usable rating" everywhere, rather than as a number
    that quietly evaporates between the total and the buckets. */
const validRating = (n) => Number.isInteger(n) && RATING_VALUES.includes(n);

/* The calls share the rating's 1–10 scale deliberately. `rating` stays the
   baseline the new fields are compared against, and a comparison between two
   fields on different scales would need a mapping nobody has justified. Same
   validator, same buckets, same harness arithmetic. */
const validCall = validRating;

/** A usable entry level: a real, positive price.

    A LEVEL WITHOUT A CITED BASIS IS NOT A LEVEL. The condition on this field is
    that it be arithmetic on figures already in the board context — a support
    level, a volatility band, a valuation figure — so that it is derived from
    this board's data rather than produced from nowhere. The basis is therefore
    part of validity, not decoration: a number whose provenance is missing is
    rejected exactly like a number out of range, and for the same reason. */
function validEntryLevel(level, basis, uncited = []) {
  if (!Number.isFinite(level) || level <= 0) return false;
  if (!(typeof basis === 'string' && basis.trim().length > 0)) return false;
  return uncited.length === 0;
}

/** Why an entry level was refused, for the log. Null when it was accepted or
    when none was offered — "not given" and "given and rejected" are different
    facts, and only the second is a fault worth counting.

    Three refusals now, not two, and the third is the one the field always
    claimed to enforce. */
function entryLevelRejection(level, basis, uncited = []) {
  if (level == null) return null;
  if (!Number.isFinite(level) || level <= 0) return 'not a positive price';
  if (!(typeof basis === 'string' && basis.trim().length > 0)) return 'no board figure cited';
  if (uncited.length) {
    /* NAMES BOTH TESTS IT FAILED. "The board did not supply it" was the whole
       reason before, and on a line that showed its working it was the wrong
       accusation — the intermediates were not supplied either, and they were
       fine. What condemns a figure now is failing both: not a board figure AND
       not reachable from the arithmetic the line shows. */
    return uncited.length === 1
      ? `cites ${uncited[0].toFixed(2)}, which the board did not supply and which `
        + 'does not follow from the working shown'
      : `cites ${uncited.length} prices the board did not supply and which do not `
        + `follow from the working shown (${uncited.map((n) => n.toFixed(2)).join(', ')})`;
  }
  return null;
}

/* ── Provenance of a cited level ──────────────────────────────────────
   The check the field claimed to have and did not. `validEntryLevel` tested
   only that the basis was a non-empty string, so a confident citation of a
   number the model got from its own web search passed exactly like a real one.
   That is what happened: FANG's two levels cited $134.30 and $216.90, which no
   context this board has ever produced contained.

   SOUND, NOT COMPLETE, and the asymmetry is deliberate. A false refusal
   destroys a data point on a field that has two; a missed fabrication stays in
   the log with its basis line readable and its numbers recorded. So the scan
   errs toward letting a number through: it checks only figures written in
   price shape, and skips bare integers and percentages. "Support at 118" is
   not caught. Tighten it when the log says over-refusal is not the risk. */

/** Numbers in a line, at face value. Generous on purpose — a figure this misses
    can only cause a missed check, never a refusal of a real citation. */
function numbersIn(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Numbers in a basis line that are written as PRICES, and so have to be
    accounted for: a currency symbol, or a decimal point with a value of at
    least one and no percent sign after it.

    That admits "134.30", "$118.40" and "134.3". It skips coefficients ("0.28"
    is below one), counts ("52-week", "28 touches") and percentages ("15%"),
    none of which is a claim about a price the board supplied. */
function pricesIn(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const re = /(\$\s?)?(\d[\d,]*(?:\.\d+)?)(\s?%)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, dollar, raw, percent] = m;
    if (percent) continue;
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (!dollar && !(raw.includes('.') && n >= 1)) continue;
    out.push(n);
  }
  return out;
}

/* Context prices print to two decimals, so an exact match is the normal case.
   The tolerance covers a citation written as "134.3" and a model that rounds
   the last digit — not a near-miss against a different anchor. */
const samePrice = (a, b) => Math.abs(a - b) < 0.015 || (b !== 0 && Math.abs(a - b) / Math.abs(b) < 0.001);

/** Percentages written in a basis line, as fractions. "10%" -> 0.1. */
function percentsIn(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const re = /(\d[\d,]*(?:\.\d+)?)\s?%/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n / 100);
  }
  return out;
}

/* ── Derivability ─────────────────────────────────────────────────────
   Values reachable from the anchors a line actually cites, by the arithmetic a
   basis line actually performs.

   WHAT THIS CLAIM IS, AND WHAT IT IS NOT. It is sound against the failure that
   has been observed: a price asserted with no derivation at all. It is NOT a
   proof of correctness and it is not sound against constructed arithmetic that
   happens to close — a fabricated figure reachable by any of these operations
   from two real anchors will pass, and nothing here would notice. Treat a pass
   as "no fault found", never as "verified".

   THE OPERATION SET IS DELIBERATELY NARROW, and the first attempt was not.
   Written with sums, midpoints and percentage scalings applied freely across
   two rounds, the reachable set became dense enough that 209.14 — the figure
   this exists to catch — was itself "derivable", along with most numbers in
   range. A closure that clears everything is not a check. Breadth is the enemy
   here: every operation added multiplies the space and buys back a false
   negative.

   So: a difference between two anchors, a fraction of that distance, and a
   fraction of an anchor. Then one more round of anchor ± that, or a fraction
   of it. No sums of two prices (rarely meaningful, hugely expansive) and no
   midpoints. This covers what these lines actually do and little else; for
   n=3 anchors and one percentage it reaches about 120 values rather than
   thousands. */
function derivedFrom(anchors, fractions) {
  const first = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    for (const p of fractions) first.push(a * p);
    for (let j = 0; j < anchors.length; j++) {
      if (i === j) continue;
      const b = anchors[j];
      first.push(Math.abs(b - a));
      // A fraction of the way from one anchor toward another — the commonest
      // construction in these lines, and the one that produced 207.56.
      for (const p of fractions) first.push(a + p * (b - a));
    }
  }

  const second = [];
  for (const v of first) {
    for (const a of anchors) second.push(a + v, a - v);
    for (const p of fractions) second.push(v * p);
  }

  return [...first, ...second].filter((v) => Number.isFinite(v) && v > 0);
}

/** Prices a basis line cites that the board never supplied AND that do not
    follow from the arithmetic the line shows.

    THE LEVEL IS NO LONGER EXEMPT, and removing that exemption is the whole
    point of this version. It was added to stop a derived level being demanded
    of the context, and it did something far worse on JAZZ: the line cited three
    real anchors, so the exemption fired, and the ONE figure with no derivation
    — a level of 209.14 that was neither in the context nor reachable from it —
    was waved through while three correct intermediates (40.17, 4.02, 207.56)
    were reported as fabrications. The guard against a false positive produced a
    false positive and a false negative on the same line.

    Derivability replaces it. An intermediate is cleared because it FOLLOWS;
    a level is cleared for the same reason and on the same evidence. Showing
    the working is now what proves a level rather than what gets it refused,
    which is the incentive the field wanted all along.

    `level` is still in the signature and is deliberately UNUSED. It was the
    exemption's input; keeping the parameter keeps every call site honest about
    what changed, and a future reader who reaches for it finds this note rather
    than reinventing the exemption. */
// eslint-disable-next-line no-unused-vars
function uncitedPrices(basis, context, level) {
  const supplied = numbersIn(context);
  const cited = pricesIn(basis);
  const inContext = (n) => supplied.some((s) => samePrice(n, s));

  const missing = cited.filter((n) => !inContext(n));
  if (!missing.length) return [];

  const anchors = cited.filter(inContext);
  const reach = anchors.length ? derivedFrom(anchors, percentsIn(basis)) : [];

  /* De-duplicated, because a basis that names one figure three times has made
     one unsupported claim, not three, and "cites 6 prices the board did not
     supply" for two distinct numbers overstates the fault in the one place a
     reader will take the count at face value. */
  const distinct = (list) => list.filter((n, i) => !list.slice(0, i).some((p) => samePrice(n, p)));

  return distinct(missing.filter((n) => !reach.some((v) => samePrice(n, v))));
}

/* ── What "no level" meant ────────────────────────────────────────────
   `entry_level` was nullable from the first version, and the null carried two
   opposite meanings under one value: "I could not derive a level" and "no level
   is needed, the price is fine". Nothing downstream could tell a model that
   declined to answer from one that answered NOW — and those are not degrees of
   the same thing, they are contradictory readings of the same setup.

   Same failure as an empty `concerns` array, solved the same way: an enum
   beside the value, because the distinction is not recoverable FROM the value.
   `search_status` exists for exactly this reason and is the precedent.

   Four states rather than three, and the fourth is a consequence of the
   one-sigma bound added the same day: "I want a lower entry but every anchor
   sits outside the band" is a wait claim with no price, which is neither a
   missing anchor nor a willingness to buy. Folding it into `no_anchor` would
   reintroduce the exact ambiguity one level down. */
const ENTRY_STANCES = [
  'level',          // a level is given; entry_level is a number
  'at_market',      // no level needed — the current price is an acceptable entry
  'outside_band',   // a lower entry is wanted, but no anchor yields one inside the band
  'no_anchor',      // the anchors given do not support a level at all
];

/** The stance actually taken, reconciled against the level that survived.

    THE LEVEL DECIDES. A surviving level means `level`, whatever the model
    wrote: the number is the more specific claim and it is what the harness
    scores. A model that returns a properly cited level and labels it
    `at_market` has filled one field carelessly, and throwing away the level
    over it would discard the better evidence to honour the worse.

    The declared value is stored beside this one rather than overwritten, so a
    disagreement stays visible instead of being resolved away silently. */
function entryStance(declared, hasLevel) {
  if (hasLevel) return 'level';
  return ENTRY_STANCES.includes(declared) && declared !== 'level' ? declared : 'no_anchor';
}

/** How far below the price a level sits, in quarterly standard deviations.

    Recorded so the 1-sigma bound can be reviewed against what actually filled
    rather than defended. If levels cluster at the band edge, or nothing ever
    fills, this is the column that says so. */
function entryLevelSigmas(level, price, annualVolPct) {
  const sigma = sigmaQuarter(price, annualVolPct);
  if (!sigma || !Number.isFinite(level)) return null;
  return (level - price) / sigma;
}

/* The maturity floor and the columns are the same list. An entry contributes to
   every horizon it is old enough for, rather than to one horizon chosen by a
   single N — a 200-day-old assessment has a 1-month, a 3-month AND a 6-month
   forward return, and discarding two of them to keep one cutoff would throw
   away most of a sample that is already too small. */
const RATING_HORIZONS = [
  { months: 1, days: 30, label: '1 month' },
  { months: 3, days: 90, label: '3 months' },
  { months: 6, days: 180, label: '6 months' },
];

/* ── The two horizon-split calls ─────────────────────────────────────
   `rating` asks one question over an unstated horizon. These ask two questions
   over stated ones, and they are allowed to disagree: a good business at a bad
   entry point is a real thing, and one number cannot hold both halves of it.

   `call_near` is scored on the horizon the factors actually operate on —
   momentum 12−1 decays over roughly a quarter, so 1 and 3 months are where a
   near-term call can be right or wrong. The 6-month column is deliberately NOT
   here: it is past the decay of the thing the call is about, and including it
   would let a near-term call be graded on a horizon it never claimed. */
const CALL_NEAR_HORIZONS = RATING_HORIZONS.filter((h) => h.months <= 3);

/* `call_long` is about the business rather than the setup, so its shortest
   honest horizon is a year. THIS CANNOT REPORT UNTIL THE LOG IS A YEAR OLD, and
   that is a property of the question, not a defect to be worked around by
   scoring it on something shorter. The field is logged now so the clock starts;
   the table stays absent until it can say something. */
const CALL_LONG_HORIZONS = [
  { months: 12, days: 365, label: '12 months' },
  { months: 24, days: 730, label: '24 months' },
  { months: 36, days: 1095, label: '36 months' },
];

/* Maturity floors, per call. The near floor is the rating's; the long floor is
   its own shortest horizon, for the same reason — below it an entry contributes
   no measurement, so admitting it only inflates `n`. */
const CALL_LONG_MIN_DAYS = 365;

/* ── The sanctioned directional fields, enumerated ───────────────────
   THE ALLOWLIST IS THE RULE. This replaced a substring blacklist that scanned
   property names for rating|recommendation|target|direction|outlook|conviction
   — a list which, by construction, only catches fields somebody already thought
   of. `call_near`, `call_long` and `entry_level` contain none of those
   substrings and would all have been waved through in silence, which is the
   exact failure the guard was written to prevent.

   Every property the assessment schema exposes must appear in this table or in
   ASSESS_PROSE_FIELDS below. A new field of any kind fails the test until it is
   added to one of them, so the next directional field is a DECISION with a name
   and a date attached rather than an omission nobody noticed.

   `scored` is the bar from docs/NOTES.md, amended 2026-09-01: a directional field
   must be scoreable in principle and logged so that it can be scored, even
   where the horizon means no result exists for a long time. `null` means the
   field is not itself scored against returns — `entry_level` is measured by
   whether the level was reached and what waiting for it earned, which is a
   different join, not a bucket spread. */
const DIRECTIONAL_FIELDS = {
  rating: { basis: 'rating_basis', entryKey: 'rating', scored: RATING_HORIZONS,
    label: 'Rating', since: '2026-08-31' },
  call_near: { basis: 'call_near_why', entryKey: 'callNear', scored: CALL_NEAR_HORIZONS,
    label: 'Near-term call', since: '2026-09-01' },
  call_long: { basis: 'call_long_why', entryKey: 'callLong', scored: CALL_LONG_HORIZONS,
    label: 'Long-term call', since: '2026-09-01' },
  entry_level: { basis: 'entry_level_basis', entryKey: 'entryLevel', scored: null,
    label: 'Entry level', since: '2026-09-01' },
  /* DIRECTIONAL, and it was first written into ASSESS_PROSE_FIELDS as though it
     were a qualifier like `search_status`. The substring guard caught it, which
     is the second net doing exactly the job it was demoted to: `at_market` is
     "buy at the current price", and a stance that enters the wait-versus-buy
     comparison as a buy-now case is a position, not a label on someone else's.

     It SHARES `entry_level_basis` rather than adding a second basis field, and
     that shapes what the line means: it is the reason for the entry DECISION,
     not only the arithmetic behind a number. For `level` it names the anchor;
     for `at_market` it says why this price is acceptable; for `outside_band` it
     names the anchor that fell outside. Only `no_anchor` may leave it null. */
  entry_stance: { basis: 'entry_level_basis', entryKey: 'entryStance', scored: null,
    label: 'Entry stance', since: '2026-09-01' },
};

/* The non-directional half of the schema. Listed so the two together are the
   complete property set and the test can assert exactly that. */
const ASSESS_PROSE_FIELDS = ['board_says', 'recent_events', 'what_could_break', 'uncertain',
  'concerns', 'structural', 'search_status', 'distinct_sources',
  'oldest_source_date', 'newest_source_date', 'data_quality_led'];

/** Every schema property name, directional and not.

    DE-DUPLICATED, because two directional fields may legitimately share one
    basis line — `entry_level` and `entry_stance` both point at
    `entry_level_basis`, which is one explanation of one decision. Without this
    the name lands twice in `required` and the schema no longer matches its own
    property list. */
const assessSchemaFields = () => [...new Set([
  ...ASSESS_PROSE_FIELDS,
  ...Object.entries(DIRECTIONAL_FIELDS).flatMap(([k, v]) => [k, v.basis]),
])];

/** The default maturity floor: 30 days, which is the shortest horizon.

    Not a preference — an entry younger than the shortest horizon cannot be
    scored against anything at all, so anything below 30 admits rows that
    contribute no measurement. Above 30 it is a genuine choice, and the control
    exposes it. */
const RATING_MIN_DAYS = 30;

const mean_ = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** Sample standard deviation. n−1, and null below two observations: a single
    point has no dispersion, and reporting 0 for it would read as certainty. */
function sampleSd(v) {
  if (v.length < 2) return null;
  const m = mean_(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}

/** Spearman rank correlation, with midranks for ties.

    Rank rather than Pearson because the rating is an ordinal judgment on a
    1–10 scale, not a measurement — the distance from 7 to 8 is not claimed to
    equal the distance from 2 to 3 — and because forward returns have tails
    heavy enough that one name can carry a Pearson correlation on its own.

    Ties get midranks, which matters here more than usual: ratings take ten
    values across what may be a few dozen names, so ties are the normal case
    rather than an edge case. */
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const mid = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k][1]] = mid;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean_(rx);
  const my = mean_(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;   // every rating identical: undefined, not zero
  const rho = num / Math.sqrt(dx * dy);
  /* SE under the null, the standard approximation. Reported because a rho of
     0.3 on n=12 and a rho of 0.3 on n=200 are not the same claim, and only one
     of them survives being looked at. */
  return { rho, n, se: 1 / Math.sqrt(n - 1) };
}

/** One horizon's worth of measurement, from already-joined observations.

    Takes `{ rating, ret, excess }` rows rather than log entries and a price
    store, so every statistic here is testable against hand-built numbers with
    no IndexedDB, no network and no clock. */
/** High-minus-low return for one median split, with the SE of the difference.

    Shared by the rating arm and the board arm so the two are computed by
    identical code — a control measured a different way is not a control. */
function splitSpread(obs, key, basis) {
  const split = medianSplit(obs.map((o) => o[key]));
  if (!split) return null;

  const pick = (o) => (basis === 'raw' ? o.ret : (o.excess ?? o.ret));
  const high = obs.filter((o) => o[key] >= split.median).map(pick);
  const low = obs.filter((o) => o[key] < split.median).map(pick);
  if (!high.length || !low.length) return null;

  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const se = (a) => {
    const s = sampleSd(a);
    return s == null ? null : s / Math.sqrt(a.length);
  };
  const seH = se(high);
  const seL = se(low);
  const value = m(high) - m(low);
  /* SE of the DIFFERENCE, as everywhere else here. */
  const seDiff = (seH != null && seL != null) ? Math.sqrt(seH * seH + seL * seL) : null;

  return { median: split.median, nHigh: high.length, nLow: low.length,
    balance: split.balance,
    meanHigh: m(high), meanLow: m(low), seHigh: seH, seLow: seL,
    value, se: seDiff,
    t: seDiff ? value / seDiff : null,
    insideNoise: seDiff == null || Math.abs(value) < 2 * seDiff };
}

function ratingStats(obs, basis = 'excess') {
  /* THE CONTROL. The same forward-return comparison on a median split of the
     board's own Overall score, over the identical symbols and dates.

     Without it the rating arm is uninterpretable. A positive rating spread is
     only evidence the RATING works if it beats what the board already knew, and
     the rating correlates +0.71 with the canonical composite — so a spread that
     merely matches the board's is the rating measuring the board, which is what
     that correlation predicts it would do.

     `difference` is the quantity of interest and it is NOT the difference of
     two independent samples: both arms are computed on the same observations,
     so their errors are correlated and the naive sqrt(seA^2 + seB^2) overstates
     the uncertainty. It is reported as an indication with that stated, never as
     a test. */
  const rating = splitSpread(obs, 'rating', basis);
  const board = obs.some((o) => Number.isFinite(o.overall))
    ? splitSpread(obs.filter((o) => Number.isFinite(o.overall)), 'overall', basis)
    : null;

  const control = { rating, board, difference: null };
  if (rating && board && rating.se != null && board.se != null) {
    control.difference = {
      value: rating.value - board.value,
      /* Upper bound: treats the arms as independent when they are not. */
      seUpperBound: Math.sqrt(rating.se * rating.se + board.se * board.se),
      beatsBoard: rating.value > board.value,
    };
  }

  const buckets = RATING_BUCKETS.map((b) => {
    const inBucket = obs.filter((o) => o.rating >= b.min && o.rating <= b.max);
    const rets = inBucket.map((o) => o.ret);
    const exc = inBucket.map((o) => o.excess).filter((x) => x != null);
    const sd = sampleSd(rets);
    return {
      ...b,
      n: inBucket.length,
      mean: mean_(rets),
      meanExcess: exc.length ? mean_(exc) : null,
      sd,
      /* SE of this bucket's own mean. Printed per bucket as well as on the
         spread, because a bucket of three names showing +18% is the single
         most misreadable cell this table can produce. */
      se: sd == null ? null : sd / Math.sqrt(inBucket.length),
    };
  });

  const top = buckets[buckets.length - 1];
  const bottom = buckets[0];

  /* Top minus bottom, with the SE of the DIFFERENCE — not of either end.
     sqrt(se_top² + se_bottom²), the two-independent-samples form. Reporting
     one bucket's SE beside a difference would understate it by up to a factor
     of √2, which is exactly the direction that flatters the result. */
  let spread = null;
  if (top.n && bottom.n && top.mean != null && bottom.mean != null) {
    const se = (top.se != null && bottom.se != null)
      ? Math.sqrt(top.se * top.se + bottom.se * bottom.se) : null;
    const value = top.mean - bottom.mean;
    spread = {
      value, se, nTop: top.n, nBottom: bottom.n,
      /* Not a p-value. A ratio, stated as one, because the sample will spend a
         long time in the region where the honest reading is "inside the
         noise" and a p-value invites a threshold to be applied to it. */
      t: se ? value / se : null,
      insideNoise: se == null || Math.abs(value) < 2 * se,
    };
  }

  return {
    n: obs.length,
    buckets,
    /* The fixed-bucket spread is kept because its ABSENCE is informative — an
       empty 9–10 bucket is a fact about the model's use of the scale that the
       median split hides by construction. It is no longer the headline. */
    spread,
    control,
    rho: spearman(obs.map((o) => o.rating), obs.map((o) => o.ret)),
    rhoExcess: spearman(
      obs.filter((o) => o.excess != null).map((o) => o.rating),
      obs.filter((o) => o.excess != null).map((o) => o.excess)),
    /* How many DISTINCT DAYS the observations were made on. The number that
       decides whether `n` means what it looks like: twenty names assessed in
       one batch share one market window, so their forward returns move
       together and the effective sample is closer to one than to twenty. This
       is the same overlapping-windows problem the backtest already warns
       about, arriving through a different door. */
    days: new Set(obs.map((o) => o.day)).size,
  };
}

/** Join the assessment log to subsequent price action.

    `closeAt(symbol, day)` is injected rather than reached for, so the join can
    be tested against a synthetic price store.

    Returns raw AND excess-over-benchmark returns. Both, because they answer
    different questions and neither is redundant: within one assessment date
    they differ by a constant and the dispersion is identical, so excess buys
    nothing; ACROSS dates the market level differs, and pooling raw returns
    from a rising quarter and a falling one adds variance that has nothing to
    do with the rating. Excess is the one to read once the log spans dates. */
/*  `field`, `horizons` and `predates` are parameters so that ONE join serves
    all three directional fields. The alternative — a copy per field — would
    let the near-term arm and the rating arm drift apart in their handling of
    maturity, missing prices or the benchmark, and a control measured a
    different way is not a control. The observation's value is emitted under
    the key `rating` whatever field produced it, so every statistic downstream
    is literally the same code path for all three. */
function ratingObservations(entries, closeAt, {
  minDays = RATING_MIN_DAYS, now = Date.now(),
  field = 'rating', horizons = RATING_HORIZONS, predates = predatesRating,
} = {}) {
  const byHorizon = new Map(horizons.map((h) => [h.months, []]));
  let noRating = 0;
  let preRating = 0;
  let tooYoung = 0;
  let noPrice = 0;

  for (const e of entries) {
    if (!validCall(e[field])) {
      /* Counted apart: an entry from before the field existed is not a
         failure, an entry whose value was refused by validation is. Folding
         them together is how a silently missing field stays invisible. */
      if (predates(e)) preRating++; else noRating++;
      continue;
    }
    const ageDays = (now - e.at) / 86400000;
    if (ageDays < minDays) { tooYoung++; continue; }

    const from = new Date(e.at).toISOString().slice(0, 10);
    /* The price AT THE TIME OF THE ASSESSMENT comes from the log entry, not
       from today's series. The stored `priceAt` is what the model was actually
       shown; re-deriving it from the series would silently change the
       denominator if the series were ever back-adjusted for a split. */
    const p0 = e.priceAt ?? closeAt(e.symbol, from);
    if (!p0) { noPrice++; continue; }

    let used = false;
    for (const h of horizons) {
      if (ageDays < h.days) continue;
      const to = new Date(e.at + h.days * 86400000).toISOString().slice(0, 10);
      const p1 = closeAt(e.symbol, to);
      if (!p1) continue;
      const ret = (p1 / p0 - 1) * 100;
      const b0 = closeAt(BENCHMARK, from);
      const b1 = closeAt(BENCHMARK, to);
      const bench = (b0 && b1) ? (b1 / b0 - 1) * 100 : null;
      byHorizon.get(h.months).push({
        /* `rating` is the key whatever `field` produced the value — see the
           note above. It is the value under test, not necessarily the rating. */
        symbol: e.symbol, rating: e[field], day: from, model: e.model,
        /* The board's Overall AS IT STOOD when the assessment ran — the control
           arm's split variable. Read from the entry, never recomputed: the
           point of the control is what the board knew at the same moment the
           model did. Older entries have none and drop out of the control arm
           only, not out of the rating arm. */
        overall: Number.isFinite(e.scores?.overall) ? e.scores.overall : null,
        ret, excess: bench == null ? null : ret - bench,
      });
      used = true;
    }
    if (!used) noPrice++;
  }

  return { byHorizon, skipped: { noRating, preRating, tooYoung, noPrice } };
}

/* ── Did waiting for the entry level beat buying immediately? ─────────
   The direct test of the field, and the only one that matters: an entry level
   claims that a better price was available if you waited for it. That claim is
   settled by three facts — whether the level was reached, how long it took,
   and what the return from the level was against the return from the price on
   the day of the assessment, both measured to the SAME end date.

   THE SAME END DATE IS THE POINT. Comparing a fill on day 40 held to day 90
   against a purchase on day 0 held to day 90 is the comparison a person
   actually faces: the money was either committed at the start or committed
   later at a better price, and both positions are worth what they are worth on
   the same day. Equalising the holding periods instead would compare two
   different windows of the market and answer a question nobody asked.

   A FILL IS THE DAY'S LOW WHERE THE SERIES HAS ONE, AND ITS CLOSE WHERE IT
   DOES NOT. Intraday capture began 2026-09-01; bars fetched from then on carry
   `l`, and a limit order at the level fills if the day traded there whether or
   not it closed there. Older bars have no low and fall back to the close for
   that bar only, which undercounts fills and overstates time-to-fill — in one
   direction, making entry levels look worse than they were.

   This matters much less than it sounds, and the reason is worth stating: an
   entry level is scored FORWARD from its assessment date, so every bar it will
   ever be measured against is a bar fetched after capture began. The fallback
   exists for correctness on a mixed series, not because it is expected to fire.
   Each row carries `fillBasis` so a fill measured the weak way can say so. */
function entryLevelOutcomes(entries, closesBetween, closeAt, {
  now = Date.now(), horizons = CALL_NEAR_HORIZONS,
} = {}) {
  const rows = [];
  let noLevel = 0;
  let outsideBand = 0;
  let rejected = 0;
  let preField = 0;
  let preStance = 0;
  let tooYoung = 0;
  let noPrice = 0;

  const shortest = Math.min(...horizons.map((h) => h.days));

  for (const e of entries) {
    if (predatesCalls(e)) { preField++; continue; }
    if (e.entryLevelRejected) { rejected++; continue; }

    /* An at-market entry BELONGS IN THIS COMPARISON. It is the model saying
       "buy now, no better entry expected", which is an answerable claim about
       the same decision an entry level is about — and dropping it as missing
       data would count only the occasions the model wanted to wait, which is
       the half of the sample that flatters the field. */
    const hasLevel = Number.isFinite(e.entryLevel);
    const stance = hasLevel ? 'level'
      : predatesStance(e) ? null
        : (e.entryStance || 'no_anchor');

    if (stance == null) { preStance++; continue; }
    if (stance === 'outside_band') { outsideBand++; continue; }
    if (stance === 'no_anchor') { noLevel++; continue; }

    const atMarket = stance === 'at_market';

    const ageDays = (now - e.at) / 86400000;
    if (ageDays < shortest) { tooYoung++; continue; }

    const from = new Date(e.at).toISOString().slice(0, 10);
    const p0 = e.priceAt ?? closeAt(e.symbol, from);
    if (!p0) { noPrice++; continue; }

    /* An at-market claim's effective level IS the price on the day: the
       position was opened immediately, so it fills on day zero at p0. That
       makes it the DECLARED twin of `degenerate` below — the inferred buy-now —
       and lets it reuse the fill machinery rather than needing a parallel path
       whose arithmetic would have to be kept in step by hand. */
    const level = atMarket ? p0 : e.entryLevel;

    /* A level at or above the price on the day claims nothing: you could have
       bought at it immediately, so "waiting" was never asked for. Recorded and
       counted rather than dropped — a model that keeps producing these is
       telling you something about the field. Kept separate from `atMarket`,
       which is the same outcome ARRIVED AT DELIBERATELY. */
    const degenerate = !atMarket && level >= p0;

    for (const h of horizons) {
      if (ageDays < h.days) continue;
      const to = new Date(e.at + h.days * 86400000).toISOString().slice(0, 10);
      const pEnd = closeAt(e.symbol, to);
      if (!pEnd) continue;

      const bars = closesBetween(e.symbol, from, to) || [];
      let reachedOn = null;
      let fillBasis = PX_BASIS.NONE;
      if (atMarket || degenerate) {
        reachedOn = from;
      } else {
        /* Count the regime over the bars actually WALKED, not over the whole
           window: a fill on day 3 says nothing about whether day 80 had a low.
           The loop breaks at the fill, so `seen` is the evidence the verdict
           actually rests on. */
        let seenLows = 0;
        let seen = 0;
        for (const b of bars) {
          if (b.day <= from) continue;             // the assessment day is not a fill
          seen++;
          const low = Number.isFinite(b.low) ? b.low : null;
          if (low != null) seenLows++;
          // The low is what a limit order would have been filled at.
          if ((low ?? b.close) <= level) { reachedOn = b.day; break; }
        }
        fillBasis = seen === 0 ? PX_BASIS.NONE
          : seenLows === seen ? PX_BASIS.INTRADAY
            : seenLows === 0 ? PX_BASIS.CLOSES : PX_BASIS.MIXED;
      }

      const daysToReach = reachedOn == null ? null
        : Math.round((Date.parse(`${reachedOn}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
      const retFromAssessment = (pEnd / p0 - 1) * 100;
      /* Only meaningful if the level was actually reached — you cannot earn the
         return from a price you never paid. Null, not zero, when unreached. */
      const retFromLevel = reachedOn == null ? null : (pEnd / level - 1) * 100;

      rows.push({
        symbol: e.symbol, day: from, months: h.months, model: e.model,
        level, basis: e.entryLevelBasis,
        priceAt: p0, priceEnd: pEnd,
        levelPct: (level / p0 - 1) * 100,
        /* The stance is carried through so the summary can keep the two arms
           apart. An at-market row's `advantage` is exactly 0 by construction —
           see entryLevelStats for why that must not be averaged in. */
        stance, atMarket,
        degenerate,
        reached: reachedOn != null,
        /* How the fill was decided. `closes` means the weak test was used and
           an intraday touch would have been missed; `intraday` means the
           verdict is what a limit order would actually have done. */
        fillBasis,
        reachedOn, daysToReach,
        retFromLevel, retFromAssessment,
        /* The whole question in one number. Positive means waiting for the
           level beat buying on the day; null means there was no fill, and the
           honest reading of that is that waiting earned nothing at all — the
           position was never opened, and `retFromAssessment` is what declining
           to buy immediately cost. */
        advantage: retFromLevel == null ? null : retFromLevel - retFromAssessment,
        callNear: validCall(e.callNear) ? e.callNear : null,
      });
    }
  }

  return {
    rows,
    skipped: { noLevel, outsideBand, rejected, preField, preStance, tooYoung, noPrice },
  };
}

/** Summarise entry-level outcomes for one horizon.

    TWO ARMS, REPORTED APART. An at-market row is in `rows` because it is a
    claim about the same decision, but its `advantage` is 0 by CONSTRUCTION —
    the model said buy now, so waiting earned exactly nothing relative to buying
    now, and that zero is a definition rather than a measurement.

    Averaging those zeros into `meanAdvantage` would drag it toward zero and
    shrink its standard error while adding no evidence at all: the more often
    the model says "buy now", the more confident the wait-vs-buy number would
    look. So the wait arm keeps `meanAdvantage`, `fillRate` and `medianDaysToFill`
    to itself, and the at-market arm is scored on the only question it can
    answer — what the forward return actually was when the model said the
    current price was fine. `meanWaitReturn` is the same figure for the wait
    arm, so the two are directly comparable. */
function entryLevelStats(rows) {
  if (!rows.length) return null;

  const atMarket = rows.filter((r) => r.atMarket);
  const waits = rows.filter((r) => !r.atMarket);
  const filled = waits.filter((r) => r.reached);
  const unfilled = waits.filter((r) => !r.reached);
  const adv = filled.map((r) => r.advantage).filter(Number.isFinite);
  const sd = sampleSd(adv);
  const atRets = atMarket.map((r) => r.retFromAssessment).filter(Number.isFinite);
  const waitRets = waits.map((r) => r.retFromAssessment).filter(Number.isFinite);
  const atSd = sampleSd(atRets);

  return {
    n: rows.length,
    /* The split that makes the rest readable. A field whose every entry is
       at_market has produced no wait claims to test, and n alone hides that. */
    nWait: waits.length,
    nAtMarket: atMarket.length,
    nFilled: filled.length,
    nUnfilled: unfilled.length,
    nDegenerate: rows.filter((r) => r.degenerate).length,
    // Over the wait arm only: nothing was waited for on an at-market row.
    fillRate: waits.length ? filled.length / waits.length : null,
    medianDaysToFill: (() => {
      const d = filled.map((r) => r.daysToReach).filter(Number.isFinite).sort((a, b) => a - b);
      if (!d.length) return null;
      const m = d.length >> 1;
      return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
    })(),
    meanAdvantage: adv.length ? mean_(adv) : null,
    seAdvantage: sd == null ? null : sd / Math.sqrt(adv.length),
    /* What declining to buy immediately cost, on the ones that never filled.
       The other half of the ledger: a field that fills rarely can still look
       good on its fills while losing badly overall. */
    meanMissed: unfilled.length ? mean_(unfilled.map((r) => r.retFromAssessment)) : null,
    /* The at-market arm. "Was the model right that this price was fine?" is
       answered by what the price then did, against the same figure for the
       occasions it wanted to wait. */
    meanAtMarketReturn: atRets.length ? mean_(atRets) : null,
    seAtMarketReturn: atSd == null ? null : atSd / Math.sqrt(atRets.length),
    meanWaitReturn: waitRets.length ? mean_(waitRets) : null,
    days: new Set(rows.map((r) => r.day)).size,
  };
}

/* ── Fundamentals from SEC EDGAR ──────────────────────────────────────
   `companyfacts` returns everything a company has ever filed: 3.56 MB on
   average, 7.55 MB for JPM. Extraction keeps 36 KB of it — about 1.1% — so the
   raw response is parsed on receipt and never stored. 560 symbols is ~20 MB
   kept rather than ~2 GB.

   Own database, like the consensus archive but for a different reason: this
   CAN be re-fetched from EDGAR, so losing it costs an hour rather than being
   unrecoverable. It is separate because 20 MB of quarterly filings has no
   business sharing an eviction policy with daily price bars. */
const FX_DB = 'bolt.fundamentals';
const FX_STORE = 'facts';

/* The five concepts that resolved cleanly across every filer sampled in stage
   1 — one universal tag each, full history, no per-industry handling. */
const FX_CONCEPTS = {
  netIncome: [
    'NetIncomeLoss',
    'ProfitLoss',                    // IFRS filers, and some us-gaap consolidated statements
  ],
  assets: ['Assets'],
  equity: [
    'StockholdersEquity',
    /* Measured: FFIV, T, VZ, PG and others report ONLY the including-NCI form,
       so the strict tag alone leaves them with no equity at all. Semantically
       this is not the same number — it carries minority interests — so it is a
       fallback, used only where the parent-only figure is absent, never in
       preference to it. */
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'EquityAttributableToOwnersOfParent',                                    // IFRS
    'Equity',                                                                // IFRS
  ],
  operatingCF: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    'CashFlowsFromUsedInOperatingActivities',                                // IFRS
  ],
  /* Measured: `CommonStockSharesOutstanding` alone leaves 124 of 564 symbols
     with no share count whatever — it is a balance-sheet parenthetical many
     filers simply do not tag. Every one of a 10-symbol sample carried at least
     one of the fallbacks. Ordered most to least direct: a period-end count
     beats a weighted average, which is an average over the period rather than a
     figure as at its end. */
  shares: [
    'CommonStockSharesOutstanding',
    'EntityCommonStockSharesOutstanding',                // dei, the cover-page count
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
  ],

  /* Revenue is the one concept that needs a chain, and the variation is by ERA
     more than by industry: AAPL reports under SalesRevenueNet before ASC 606
     and RevenueFromContractWithCustomer after, so `Revenues` exists for it but
     carries a single fiscal year. First populated wins PER PERIOD, not per
     company, because one filer crosses the boundary mid-history. */
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'RevenuesNetOfInterestExpense',
    'Revenues',
    'Revenue',                                           // IFRS
    'RevenueFromContractsWithCustomers',                 // IFRS
  ],
};

/* Which filings count. 10-K and 10-Q are the domestic pair; a foreign private
   issuer files 20-F annually and 6-K in between, and a Canadian one files 40-F.
   Measured: restricting to the domestic two left ARM, WIX and SPOT with NOTHING
   AT ALL — every concept empty — because none of them files a 10-K.

   SPOT additionally reports under `ifrs-full` rather than `us-gaap`. The
   extraction already walks every taxonomy, so the IFRS aliases above are what
   it needs; the form filter was the blocker. */
const FX_FORMS = new Set(['10-K', '10-Q', '20-F', '6-K', '40-F']);

/* A successor registrant carries the ticker but not the history. EDGAR maps XOM
   to CIK 2115436 — "Exxon Mobil Corporation", four facts, 10-Q only, 1.5 years
   — while CIK 34088, the same name, holds 229 facts back to 2007. Detected by
   comparing fundamentals span against stored price span: XOM was the only
   symbol on the board with 500 bars and under four years of filings, against a
   median of 18.6 years, so this is a list of one rather than a pattern. */
const SEC_CIK_OVERRIDE = { XOM: 34088 };

/* ── Reading a period out of the extraction ───────────────────────────
   A "quarter" is 80-100 days and a "year" 330-400. Between them sit the
   year-to-date cumulations that 10-Qs are full of: six-month, nine-month.

   THE CUMULATIONS ARE THE POINT, not noise to be filtered out. Everything below
   exists because the previous approach — take the newest four ~90-day facts and
   sum them — was wrong for 525 of 558 symbols, and the cumulations are what
   make the correct construction possible. See the long note on `fxRollTTM`. */
/* `fxIsQuarter` and `fxIsYear` were removed with the rewrite rather than left
   in place. They were correct — every fact they admitted really was a quarter —
   and they were the instruments of the bug, because a correct predicate invited
   `slice(0, 4)` on its output. Leaving them would leave the same trap loaded. */
const fxDays = (x) => (x.s ? Math.round((Date.parse(x.e) - Date.parse(x.s)) / 86400000) : null);

/** Which reporting period a fact covers: Q, H (six months), T (nine months) or
    Y. Null for anything that fits none of them — a 53-week retail year, a stub
    period after a fiscal-calendar change — which is then simply not used. */
function fxPeriod(x) {
  const d = fxDays(x);
  if (d === null) return null;
  if (d >= 80 && d <= 100) return 'Q';
  if (d >= 170 && d <= 195) return 'H';
  if (d >= 260 && d <= 285) return 'T';
  if (d >= 330 && d <= 400) return 'Y';
  return null;
}

const fxPrep = (arr) => (arr || [])
  .map((x) => ({ ...x, p: fxPeriod(x) })).filter((x) => x.p);

/** Twelve months ending at the newest reported date, by the standard roll:

        TTM = YTD(current) + FY(prior) − YTD(prior year, same length)

    WHY NOT SUM FOUR QUARTERS. Because the fourth quarter is not there. There is
    no 10-Q for Q4, so Q4 exists only inside the annual figure, and the quarterly
    facts on file are Q1, Q2 and Q3 of each year. Taking the newest four
    therefore reaches back into the PRIOR year: it double-counts a Q3 and omits
    Q4 entirely. Measured 2026-08-31 — 525 of the 558 symbols on the old
    quarterly path had a span of about 455 days rather than 365, with a median
    summed-over-filed ratio of 1.06 and 68 symbols above 1.5x. AAPL summed
    124.9B against a true 129.0B; NVDA 176.3B against 192.9B.

    For operating cash flow it was worse still: only Q1 is ever filed as a
    discrete quarter, so the "four quarters" were four consecutive FIRST
    quarters. MAS spanned 1,185 days and summed −298M against a filed annual
    1,022M, which is the entire reason its accruals read +0.224 against a true
    −0.041. The 4Q pairing never once produced a correct number — zero of 106.

    The roll uses only facts the extraction already keeps and resolves for 561
    of 561 symbols on both concepts. When the newest fact is itself an annual it
    is returned untouched, because a filed year needs no reconstruction. */
function fxRollTTM(arr) {
  const w = fxPrep(arr);
  if (!w.length) return null;
  const years = w.filter((x) => x.p === 'Y');
  if (!years.length) return null;

  const newest = w[0];
  if (newest.p === 'Y') {
    return { v: newest.v, end: newest.e, basis: 'FY', filed: newest.f,
      cur: newest, prevFY: null, priorYTD: null };
  }

  // The cumulative ending on the newest date — the year so far.
  const cur = w.find((x) => x.e === newest.e);
  if (!cur) return null;

  /* The fiscal year that ended immediately before this one began. The ten-day
     slack absorbs 52/53-week calendars, where the year end drifts by a few days
     and an exact comparison would find nothing. */
  const prevFY = years.find((y) => Date.parse(y.e) <= Date.parse(cur.s) + 86400000 * 10);
  if (!prevFY) return null;

  /* The same stretch of the previous year, so subtracting it leaves exactly the
     twelve months wanted. Matched on period type AND on being about 365 days
     earlier: matching on type alone would find the same period two years back. */
  const priorYTD = w.find((x) => x.p === cur.p
    && Math.abs((Date.parse(cur.e) - Date.parse(x.e)) - 365 * 86400000) <= 20 * 86400000);
  if (!priorYTD) return null;

  return { v: cur.v + prevFY.v - priorYTD.v, end: cur.e, basis: 'TTM', filed: cur.f,
    cur, prevFY, priorYTD };
}

/* A differenced cumulative and an independently filed quarter for the same
   period are two separately reported numbers, so requiring them to agree is a
   real test rather than an arithmetic identity. 20,024 of 21,698 such checks
   across the board are EXACTLY zero.

   1% relative. Tight enough to catch a genuine break — the failures cluster far
   above it, at 2.5% to 97% — and loose enough for rounding and for a filer that
   restates a cumulative without restating its parts. */
const FX_RECONCILE_TOL = 0.01;

/** Check the roll against independently filed figures, scoped to the facts THIS
    number rests on.

    Scoped deliberately. Reconciling all history flags 216 symbols, almost all
    of them restatements in years the current figure does not touch; reconciling
    the two fiscal years the roll actually draws on flags 12. A gate that nulls
    a correct current number because of a restatement in 2019 is a gate nobody
    will leave switched on.

    Returns `checks: 0` when no redundancy exists — that is NOT a pass, it is an
    absence of evidence, and it is reported separately so the count stays
    visible rather than being folded in with the verified. */
function fxReconcile(arr, r) {
  if (!r) return { ok: false, checks: 0, worst: null, why: 'unresolved' };

  const w = fxPrep(arr);
  const byStart = new Map();
  for (const x of w) {
    if (!byStart.has(x.s)) byStart.set(x.s, {});
    const g = byStart.get(x.s);
    if (!g[x.p]) g[x.p] = x;      // first is newest-filed; later duplicates ignored
  }

  const errs = [];
  const starts = new Set([r.cur, r.prevFY, r.priorYTD].filter(Boolean).map((x) => x.s));
  for (const start of starts) {
    const g = byStart.get(start);
    if (!g) continue;
    for (const [a, b] of [['Q', 'H'], ['H', 'T'], ['T', 'Y']]) {
      if (!g[a] || !g[b]) continue;
      const filed = w.find((x) => x.p === 'Q' && x.e === g[b].e);
      if (!filed) continue;
      /* A floor on the denominator: a quarter that netted to near zero would
         otherwise turn a rounding difference into an enormous relative error. */
      errs.push(Math.abs((g[b].v - g[a].v) - filed.v) / Math.max(Math.abs(filed.v), 1e6));
    }
  }

  const worst = errs.length ? Math.max(...errs) : null;
  return { ok: worst === null || worst <= FX_RECONCILE_TOL, checks: errs.length, worst };
}

/* Why each symbol's fundamentals are absent or unverified, filled by the pass
   below and surfaced in the UI. A number that failed its own test is withheld,
   and the reason is kept rather than the row simply going blank. */
const fxGateReasons = new Map();

/** Newest instant (balance-sheet item), and the one `back` periods before it. */
const fxLatest = (arr) => (arr && arr.length ? arr[0] : null);
function fxPrior(arr, back) {
  if (!arr) return null;
  const distinct = [...new Map(arr.map((x) => [x.e, x])).values()];
  return distinct[back] || null;
}

/** A flow over the last twelve months, rolled and then reconciled.

    THE GATE IS HARD. A figure whose own reconciliation fails is withheld, not
    shipped with a caveat: the whole reason this function was rewritten is that
    a plausible-looking wrong number sorted to the top of the board and was read
    as the strongest signal on it. 12 of 561 symbols fail at 1%. */
function fxTTM(arr, symbol = null) {
  const r = fxRollTTM(arr);
  if (!r) {
    if (symbol) fxGateReasons.set(symbol, 'no annual filing to roll from');
    return null;
  }
  const check = fxReconcile(arr, r);
  if (!check.ok) {
    if (symbol) {
      fxGateReasons.set(symbol,
        `failed reconciliation — a differenced cumulative disagrees with the filed quarter by ${
          (check.worst * 100).toFixed(1)}%`);
    }
    return null;
  }
  return { v: r.v, end: r.end, basis: r.basis, filed: r.filed,
    /* Carried so the UI can distinguish "verified against filed quarters" from
       "nothing available to check it against". Nine symbols are the latter. */
    verified: check.checks > 0 };
}

/** Two flows over the SAME window.

    Accruals are a DIFFERENCE between two flows, so the two must cover the same
    period or the difference is between two different years. Measured before this
    existed: Apple's TTM net income ran to 2026-06-27 while its operating cash
    flow ran to 2025-12-27, two quarters apart, and the resulting "accrual" was
    −0.092 against a true 0.0015. NVIDIA's was 0.349 against 0.075. Both were
    plausible-looking numbers that were entirely artefacts of the mismatch.

    Operating cash flow is reported year-to-date rather than per quarter, so the
    quarterly basis is available for only 105 of 564 symbols and the rest fall
    back to the fiscal year. That is staler, not wrong. */
function fxPaired(niArr, ocfArr, symbol = null) {
  const ni = fxTTM(niArr, symbol);
  const ocf = fxTTM(ocfArr, symbol);
  if (!ni || !ocf) return null;

  /* The endpoint check that `fxPaired` was created for, unchanged and still
     necessary: Apple's net income once ran to 2026-06-27 against cash flow to
     2025-12-27, and the resulting "accrual" was −0.092 against a true 0.0015.
     Six symbols still land here because their two concepts are reported to
     different dates. The old code's version of this check compared only the
     newest endpoints and let a 1,185-day span through underneath it — matching
     ends are necessary and were never sufficient. */
  if (ni.end !== ocf.end) {
    if (symbol) {
      fxGateReasons.set(symbol,
        `net income runs to ${ni.end} and operating cash flow to ${ocf.end} — a difference between two different periods is not an accrual`);
    }
    return null;
  }

  return { ni: ni.v, ocf: ocf.v, basis: ni.basis, end: ni.end,
    verified: ni.verified && ocf.verified };
}

/* Curve constants, calibrated from the board's own distribution on 2026-09-01
   rather than guessed: the pivot is the median and k is the interquartile
   spread, so a name one IQR better than the middle scores about 88. */
/* A market cap needs a CURRENT share count, and some filers simply stop tagging
   one. Measured 2026-09-01: Berkshire's newest share fact in any accepted form
   is 2015-09-30, Coca-Cola Consolidated's is 2019-12-29, and Erie Indemnity has
   a single row of 2,542 shares — a Class B count, the class dimension being
   absent from companyfacts entirely.

   Priced against a current quote those produce market caps of $0.83B, $1.84B
   and $0.00B, and earnings yields of 9,531%, 32% and 105,953%. They sorted to
   the top of the value ranking, which is the worst place for a broken number to
   land: it looks like the strongest signal on the board.

   No better tag exists for them — this is not a chain that can be extended, it
   is data that stopped. So the count is required to be recent, and a stale one
   yields no market cap at all. Earnings yield and book-to-market go null;
   return on equity and accruals are unaffected, since neither needs a price.
   450 days allows an annual filer a full year plus its filing lag. */
const SHARES_MAX_AGE_DAYS = 450;

/* RECALIBRATED 2026-08-31 against the rolled figures. The originals were fitted
   to the 15-month window, so they were fitted to bad inputs and had to be
   re-measured rather than assumed to carry over.

   They barely moved, and the reason is worth keeping: the median of a ratio is
   robust to a numerator inflated by roughly 6%, which is what the broken TTM
   did at the median. The damage was in the tails — 68 symbols above 1.5x and 17
   negative — and a median-and-IQR calibration is close to blind to exactly
   that. A calibration surviving a change of inputs is NOT evidence the inputs
   were fine. */
const EY_PIVOT = 0.041;  const EY_K = 0.032;   // earnings yield, median 4.10%, IQR 0.0322
const BM_PIVOT = 0.264;  const BM_K = 0.358;   // book-to-market, median 0.264, IQR 0.3578
const ROE_PIVOT = 0.156; const ROE_K = 0.226;  // return on equity, median 15.6%, IQR 0.2256
const ACC_PIVOT = -0.042; const ACC_K = 0.053; // accruals, median −0.0416, IQR 0.0529

/** The four value/quality readings for one symbol, plus their sub-scores.

    NEGATIVE DENOMINATORS RETURN NULL, deliberately. A company losing money does
    not have a low earnings yield, it has none — ranking −$2bn/mcap above
    −$5bn/mcap orders depths of loss as though they were degrees of value. The
    same for negative book value, which on this board is mostly buyback-driven
    (MCD, SBUX, PM, LOW, HCA) rather than distress. Return on equity is the most
    dangerous of the three: negative over negative silently yields a healthy
    positive, so it is gated on the sign of average equity, not of the ratio.

    Accruals need no such gate. Its numerator is a difference, which is signed
    either way by construction, and its denominator is average assets, which is
    never negative. It is the widest-covered of the four for that reason. */
function fundamentalsFor(symbol, price) {
  const empty = { earnYield: null, bookToMkt: null, roe: null, accruals: null,
    fxBasis: null, fxEnd: null, fxNiBasis: null, fxNiEnd: null,
    fxNiVerified: null, fxOcfVerified: null, fxWithheld: null };
  const rec = state.fx.facts.get(symbol);
  if (!rec || !rec.f || price == null) return empty;

  const f = rec.f;
  const shares = fxLatest(f.shares);
  const sharesAgeDays = shares
    ? (Date.now() - Date.parse(`${shares.e}T00:00:00Z`)) / 86400000
    : Infinity;
  /* A stale count is worse than none: it prices a current quote against a share
     base from another era and lands the result at the top of the ranking. */
  const mcap = shares && shares.v > 0 && sharesAgeDays <= SHARES_MAX_AGE_DAYS
    ? price * shares.v
    : null;

  fxGateReasons.delete(symbol);
  const ni = fxTTM(f.netIncome, symbol);
  const equity = fxLatest(f.equity);
  const equityPrior = fxPrior(f.equity, 4);
  const assets = fxLatest(f.assets);
  const assetsPrior = fxPrior(f.assets, 4);

  const avg = (now, before) => (now && before ? (now.v + before.v) / 2 : (now ? now.v : null));
  const avgEquity = avg(equity, equityPrior);
  const avgAssets = avg(assets, assetsPrior);

  const paired = fxPaired(f.netIncome, f.operatingCF, symbol);

  return {
    earnYield: mcap && ni && ni.v > 0 ? ni.v / mcap : null,
    bookToMkt: mcap && equity && equity.v > 0 ? equity.v / mcap : null,
    roe: ni && avgEquity != null && avgEquity > 0 ? ni.v / avgEquity : null,
    accruals: paired && avgAssets ? (paired.ni - paired.ocf) / avgAssets : null,
    /* `fxBasis` describes the ACCRUALS PAIRING ONLY, and the distinction has
       already caused one misreading. Earnings yield and return on equity are
       built from `ni` — a plain TTM of net income, which needs no counterpart
       to agree with it and is on four quarters for 558 of 561 symbols. The
       pairing is stricter: it needs quarterly net income AND quarterly
       operating cash flow AND matching period ends, which only 106 filers
       satisfy. So a symbol reading `FY` here almost always has current
       quarterly net income driving its other two factors.

       The period ends are carried alongside the labels because the label is a
       proxy for staleness and not staleness itself: `FY` to 2026-06-30 and `FY`
       to 2024-12-31 are the same label and 18 months apart. Anything that wants
       to say how old a figure is needs the date, not the basis. */
    fxBasis: paired ? paired.basis : null,
    fxEnd: paired ? paired.end : null,
    fxNiBasis: ni ? ni.basis : null,
    fxNiEnd: ni ? ni.end : null,
    /* PER CONCEPT, and it has to be, because the two are nothing alike.

       Net income reconciles for 552 of 561 symbols. Operating cash flow
       reconciles for 16 — because a filer publishes only Q1 as a discrete
       quarter of cash flow, which is the very structural fact that made
       `slice(0, 4)` wrong in the first place. There is simply nothing to check
       the differenced cumulations against for the other 545.

       A single boolean AND of the two reported 521 of 542 rows as "unverified",
       which is true and useless: a condition holding on 96% of the board is not
       a flag, it is a property of the data source, and dressing it as a
       per-row warning is the same overstatement that put three briefs onto the
       wrong factor. So the rare case (9 symbols with unverifiable net income)
       is flagged per row, and the universal one is stated once, in the places
       that explain where the number came from. */
    fxNiVerified: ni ? ni.verified : null,
    fxOcfVerified: paired ? paired.verified : null,
    /* Why this symbol has no fundamentals, when it has none. Read from the pass
       that just ran, so a blank row can say what happened to it instead of
       looking like a symbol nobody fetched. */
    fxWithheld: fxGateReasons.get(symbol) || null,
  };
}

/* Debt is deliberately absent. It is the one concept that genuinely varies by
   industry — HOOD carries none of the standard tags at all, and JPM reports
   ShortTermBorrowings/OtherBorrowings where AAPL reports LongTermDebt — so a
   board-wide leverage factor would need per-industry handling that v1 does not
   have. Leaving it out costs the weakest factor of the set. */

let fxDbPromise = null;

function fxDb() {
  if (fxDbPromise) return fxDbPromise;
  fxDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(FX_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FX_STORE)) db.createObjectStore(FX_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('fundamentals database is blocked by another tab'));
  });
  return fxDbPromise;
}

/** Reduce one companyfacts response to what the scores need.

    Returns `{ <concept>: [ {e, s, v, f, u, r} ] }`, newest period first:
      e  period end          f  filing date this value FIRST became knowable
      s  period start        u  unit
      v  value as first filed
      r  restatements: [{v, f}] for every later filing that changed it

    POINT-IN-TIME. `v` and `f` come from min(filed) for that period, so a
    backtest can ask what was knowable on a date and get the answer that was
    actually available. Later filings restate prior periods constantly — JPM
    moved its 2009 assets by $88bn six months after first reporting them — and
    taking the latest value would read numbers that did not exist at the time.
    Restatements are kept beside the original rather than replacing it, so the
    difference is measurable instead of invisible. */
function extractFundamentals(facts) {
  const out = {};
  const nodes = {};
  for (const tx of Object.keys(facts?.facts || {})) {
    for (const tag of Object.keys(facts.facts[tx])) nodes[tag] = facts.facts[tx][tag];
  }

  for (const [concept, chain] of Object.entries(FX_CONCEPTS)) {
    /* Per period, walk the chain and keep the first tag that has a value for
       it. Later tags fill only the periods earlier ones left empty, which is
       what makes a filer that switched tags mid-history come out whole. */
    const byPeriod = new Map();

    for (const tag of chain) {
      const node = nodes[tag];
      if (!node || !node.units) continue;

      for (const [unit, arr] of Object.entries(node.units)) {
        for (const x of arr) {
          if (!FX_FORMS.has(x.form)) continue;
          if (!x.end || x.val == null || !x.filed) continue;

          const key = `${x.start || ''}|${x.end}`;
          const seen = byPeriod.get(key);

          if (!seen) {
            byPeriod.set(key, { e: x.end, s: x.start || null, v: x.val, f: x.filed, u: unit, tag, r: [] });
            continue;
          }
          // A period already claimed by an earlier tag in the chain stays with it.
          if (seen.tag !== tag) continue;

          if (x.filed < seen.f) {
            // An earlier filing of the same period: this is the knowable one.
            if (seen.v !== x.val) seen.r.push({ v: seen.v, f: seen.f });
            seen.v = x.val;
            seen.f = x.filed;
          } else if (x.val !== seen.v && !seen.r.some((z) => z.f === x.filed)) {
            seen.r.push({ v: x.val, f: x.filed });
          }
        }
      }
    }

    const rows = [...byPeriod.values()].sort((a, b) => (a.e < b.e ? 1 : a.e > b.e ? -1 : 0));
    for (const row of rows) { row.r.sort((a, b) => (a.f < b.f ? -1 : 1)); delete row.tag; }
    if (rows.length) out[concept] = rows;
  }
  return out;
}

/** Fetch and store one symbol's fundamentals. Throws so the caller can count. */
async function fetchFundamentals(symbol) {
  const cik = state.sec.cik[symbol];
  if (cik == null) {
    const err = new Error(`${symbol} has no CIK — run the EDGAR check first`);
    err.status = 0;
    throw err;
  }
  const padded = String(SEC_CIK_OVERRIDE[symbol] ?? cik).padStart(10, '0');
  const res = await fetch(`/sec/data/api/xbrl/companyfacts/CIK${padded}.json`);
  if (!res.ok) {
    const err = new Error(`EDGAR returned ${res.status} for ${symbol}`);
    err.status = res.status;
    throw err;
  }

  // Parsed and reduced here; the multi-MB response is never written anywhere.
  const extracted = extractFundamentals(await res.json());
  const record = { cik, at: Date.now(), f: extracted };

  const db = await fxDb();
  const tx = db.transaction(FX_STORE, 'readwrite');
  tx.objectStore(FX_STORE).put(record, symbol);
  await txDone(tx);

  state.fx.facts.set(symbol, record);
  return record;
}

/** Read every stored extraction into memory. */
async function loadFundamentals() {
  try {
    const db = await fxDb();
    const tx = db.transaction(FX_STORE, 'readonly');
    const store = tx.objectStore(FX_STORE);
    const [keys, values] = await Promise.all([
      idbRequest(store.getAllKeys()),
      idbRequest(store.getAll()),
    ]);
    state.fx.facts.clear();
    keys.forEach((k, i) => { if (values[i]) state.fx.facts.set(String(k), values[i]); });
    state.fx.hydrated = true;
  } catch {
    state.fx.hydrated = true;   // nothing stored yet, or storage unavailable
  }
}

/** Seed the archive from what the entry cache already holds.

    The cache carries four months for every symbol on the board and the archive
    starts empty, so without this the first four months of history would be
    thrown away and the clock would start from today — despite the data already
    being on disk. Trends refresh weekly, so waiting for `archiveTrend` to fill
    it naturally would also mean a week before anything is recorded at all.

    Idempotent: `mergeSnapshots` upserts by period, so running it on every boot
    adds nothing after the first. */
async function seedArchiveFromCache() {
  let seeded = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(LS.entry)) continue;
    let entry;
    try { entry = JSON.parse(localStorage.getItem(k)); } catch { continue; }
    if (!entry || !Array.isArray(entry.t) || !entry.t.length) continue;

    // The cache stores rows positionally; the archive wants named fields.
    const trend = entry.t.map(([period, strongBuy, buy, hold, sell, strongSell]) =>
      ({ period, strongBuy, buy, hold, sell, strongSell }));
    const r = await recordSnapshot(k.slice(LS.entry.length), trend);
    if (r) seeded += r.added;
  }
  state.snap.added += seeded;
  return seeded;
}

/** Everything the archive holds, for the header line and the detail panel. */
async function snapshotStats() {
  try {
    const db = await snapDb();
    const tx = db.transaction(SNAP_STORE, 'readonly');
    const store = tx.objectStore(SNAP_STORE);
    const [keys, values] = await Promise.all([
      idbRequest(store.getAllKeys()),
      idbRequest(store.getAll()),
    ]);

    let records = 0;
    let revisions = 0;
    let oldest = null;
    let newest = null;
    for (const rows of values) {
      for (const r of rows || []) {
        records++;
        revisions += r.rev || 0;
        if (!oldest || r.p < oldest) oldest = r.p;
        if (!newest || r.p > newest) newest = r.p;
      }
    }
    return { symbols: keys.length, records, revisions, oldest, newest };
  } catch {
    return null;
  }
}

let pxDbPromise = null;

/** Open (and on first use create) the series database. */
function pxDb() {
  if (pxDbPromise) return pxDbPromise;
  pxDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(PX_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PX_STORE)) db.createObjectStore(PX_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('price history database is blocked by another tab'));
  });
  return pxDbPromise;
}

const idbRequest = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/* Resolve on commit, not on the last request's success: a transaction can still
   fail after every request in it has succeeded. */
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

/** Epoch millis → YYYY-MM-DD, UTC. Shared with the insider-transaction fetch
    further down, which wants the same format for its date range. */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Shift a YYYY-MM-DD by whole days. Used for range ends, so UTC throughout. */
function shiftDay(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(Date.UTC(y, m - 1, d) + days * 86_400_000);
}

const usableSeries = (s) => !!s && Array.isArray(s.c) && s.c.length > 0;

/** Store one symbol's series. The in-memory Map is updated first and always,
    so a failed write costs persistence for the session and not the session. */
async function writeSeries(symbol, series) {
  state.px.series.set(symbol, series);
  try {
    const db = await pxDb();
    const tx = db.transaction(PX_STORE, 'readwrite');
    tx.objectStore(PX_STORE).put(series, symbol);
    await txDone(tx);
  } catch {
    /* A blocked database, or private browsing with storage disabled. The
       series is still in memory and the board still scores it; the next
       backfill will try to store it again. Counted so the UI can say so once
       rather than per symbol. */
    state.px.storeFailed++;
  }
}

/** Read every stored series into the in-memory Map. */
async function loadAllSeries() {
  state.px.series.clear();
  const db = await pxDb();
  const tx = db.transaction(PX_STORE, 'readonly');
  const store = tx.objectStore(PX_STORE);
  const [symbols, records] = await Promise.all([
    idbRequest(store.getAllKeys()),
    idbRequest(store.getAll()),
  ]);
  symbols.forEach((symbol, i) => {
    if (usableSeries(records[i])) state.px.series.set(String(symbol), records[i]);
  });
}

/** Move any series still in localStorage into IndexedDB, once.

    Idempotent, and ordered so an interruption repeats work rather than losing
    it: every record is written and the transaction committed BEFORE a single
    localStorage key is removed. Refetching instead would cost one Polygon call
    per symbol at five a minute — an hour and a half to recover bars already on
    disk. Freeing the old keys also returns ~2.8 MB of localStorage to the
    caches that still live there. */
async function migrateSeriesToIdb() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS.px)) keys.push(k);
  }
  if (!keys.length) return 0;

  const db = await pxDb();
  const tx = db.transaction(PX_STORE, 'readwrite');
  const store = tx.objectStore(PX_STORE);
  let moved = 0;
  for (const k of keys) {
    let series = null;
    try { series = JSON.parse(localStorage.getItem(k)); } catch { /* unreadable */ }
    // A migrated series carries no `bf`, so needsPrices will pick it up for the
    // backward extension exactly once. That is how a board stored under the old
    // two-year window grows into the ten-year one.
    if (usableSeries(series)) { store.put(series, k.slice(LS.px.length)); moved++; }
  }
  await txDone(tx);

  for (const k of keys) localStorage.removeItem(k);
  return moved;
}

async function clearPriceHistory() {
  state.px.series.clear();
  const db = await pxDb();
  const tx = db.transaction(PX_STORE, 'readwrite');
  tx.objectStore(PX_STORE).clear();
  await txDone(tx);
}

/** Migrate, then read the stored series in, then repaint whatever is on screen.

    Deliberately not awaited by `init()`. Reading a few hundred series out of
    IndexedDB is fast but not instant, and blocking on it would leave every
    button in the page dead until it finished. Nothing on screen needs the
    series to render an empty state first, so the load happens alongside the
    wiring and the views that care are re-rendered when it lands. */
async function hydrateSeries() {
  try {
    await migrateSeriesToIdb();
    await loadAllSeries();
  } catch {
    /* No IndexedDB — private browsing, or storage blocked for this origin. The
       app still works for the session; nothing will survive a reload. */
    toast('Could not open the price history database. Prices will not persist this session.');
  }
  state.px.hydrated = true;

  if (state.view === VIEW.BOARD && domain(state.boardMode).needsPrices) renderBoard();
  if (state.view === VIEW.BACKTEST) renderBacktest();
}

// ── Price history: backfill ─────────────────────────────────────────

/** The oldest date the window currently reaches back to. */
const pxFloorDay = () => isoDay(Date.now() - PX_YEARS * 365.25 * 86_400_000);

/** Whether a symbol is worth spending a Polygon call on right now. */
function needsPrices(symbol) {
  const series = state.px.series.get(symbol);
  if (!series) return true;

  /* Stored, but never asked for bars this far back — either it predates the
     ten-year window or it came through the migration. This is what makes a
     wider window take effect on a board that is already full.

     The test is `bf` (the oldest date ever REQUESTED) and not `f` (the oldest
     bar actually held). A 2021 listing has no 2016 bars and never will, so
     testing `f` would mark it short forever and re-ask on every single pass.
     Recording what was asked for settles the question once. */
  if (!series.bf || series.bf > pxFloorDay()) return true;

  // A symbol checked recently is left alone even if no new bar arrived —
  // weekends and holidays would otherwise re-ask for every name, every load.
  return Date.now() - (series.at || 0) > PX_REFRESH_MS;
}

/** The date of bar `index`, interpolated between the series' first and last.

    The same approximation `barIndexOn` makes in the other direction, and the
    only one available when per-bar dates are not stored. Needed when a merge
    overflows the bar cap and drops bars off the front: `f` then no longer
    describes the series and would throw off every date lookup into it. */
function dayAtIndex(series, index) {
  const from = Date.parse(`${series.f}T00:00:00Z`);
  const to = Date.parse(`${series.t}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || series.c.length < 2) return series.f;
  return isoDay(from + ((to - from) * index) / (series.c.length - 1));
}

/* ── Intraday extremes: full-length arrays with null holes ────────────
   `h` and `l` are ALWAYS the same length as `c`, with null for a bar whose
   intraday extremes are not known. They cost about 5 characters per unknown
   bar — 1.4 MB across the current 287,594 — and buy the one property that
   matters: index i of `c`, `h` and `l` is always the same bar.

   The alternative, a shorter array aligned to the tail of `c` with an offset,
   is smaller and wrong. Capture starts now, so today's holes are all at the
   FRONT; but a later backfill of older history fetches those bars WITH their
   extremes, which puts the hole in the MIDDLE. Any offset arithmetic is
   correct until that backfill runs and silently wrong afterwards, which is the
   worst available failure — it would misalign every drawdown on the board with
   nothing on screen to show it. Null holes survive any merge order. */
const nullsFor = (n) => new Array(n).fill(null);

/** An existing series' intraday arrays, padded to match its closes.

    Defensive about length as well as presence: a series written by an older
    build has no arrays at all, and one written by a buggy merge could have
    arrays of the wrong length. Both are replaced with nulls rather than
    trusted, because a misaligned low is worse than an absent one. */
function paddedIntraday(series) {
  const n = series.c.length;
  const ok = (a) => (Array.isArray(a) && a.length === n ? a : nullsFor(n));
  return { h: ok(series.h), l: ok(series.l) };
}

/** The first day this series carries intraday extremes, or null.

    THE STAMP. Recomputed from the arrays on every write rather than carried
    forward, so it cannot drift from what the arrays actually hold, and it moves
    backwards on its own if a later backfill adds extremes to older bars. */
function firstIntradayDay(series) {
  if (!Array.isArray(series.l) || !series.c?.length) return null;
  for (let i = 0; i < series.l.length; i++) {
    if (series.l[i] != null) return dayAtIndex(series, i);
  }
  return null;
}

/** Attach the stamp to a series about to be written. */
const stampIntraday = (series) => ({ ...series, lf: firstIntradayDay(series) });

/* The three regimes an intraday-aware factor can be computed under. Named
   rather than booleans because MIXED is the one that matters and a boolean
   cannot express it: a drawdown over a window that is half close-only and half
   intraday is neither the old quantity nor the new one, and anything that
   reports it as either is lying about its own inputs. */
const PX_BASIS = { CLOSES: 'closes', INTRADAY: 'intraday', MIXED: 'mixed', NONE: 'none' };

/** What a factor's inputs actually were, over the window it will read.

    THE STAMP IS FOR READING, NOT ONLY FOR STORING. `lf` says where intraday
    data begins in the series; this says what that means for ONE window, which
    is the question a factor actually has. A twelve-month drawdown ending today
    and a twelve-month drawdown ending last year can sit either side of the
    boundary in the same series, and only the window can settle it. */
function intradayCoverage(series, window = null) {
  const n = series?.c?.length || 0;
  if (!n) return { bars: 0, known: 0, from: null, basis: PX_BASIS.NONE };
  const w = window == null ? n : Math.min(window, n);
  const lows = Array.isArray(series.l) && series.l.length === n ? series.l : null;

  let known = 0;
  let firstKnown = null;
  for (let i = n - w; i < n; i++) {
    if (lows && lows[i] != null) {
      known++;
      if (firstKnown == null) firstKnown = i;
    }
  }
  const basis = known === 0 ? PX_BASIS.CLOSES
    : known === w ? PX_BASIS.INTRADAY : PX_BASIS.MIXED;
  return {
    bars: w,
    known,
    from: firstKnown == null ? null : dayAtIndex(series, firstKnown),
    basis,
  };
}

/** The basis tag beside a drawdown on the board.

    NOTHING IS SHOWN FOR THE PURE CASES. A tag on every row would be noise
    within a day and would train the eye to skip it, which is the opposite of
    what it is for. `closes` is the current state of every row and is the
    quantity `DD_PIVOT` was set against, so it is the unmarked default; the tag
    appears only once a row stops being that — for `intraday`, whose number is
    now deeper than its neighbours', and for `mixed`, which is neither. */
function ddBasisTagHTML(row) {
  if (row.ddBasis === PX_BASIS.INTRADAY) {
    return ' <span class="px-basis px-basis-intra" title="Computed from intraday highs and lows. Deeper than a close-to-close drawdown by construction, so it is NOT directly comparable with rows still marked close-to-close.">id</span>';
  }
  if (row.ddBasis === PX_BASIS.MIXED) {
    const c = row.ddCoverage;
    return ` <span class="px-basis px-basis-mixed" title="${esc(
      `Mixed inputs: ${c.known} of ${c.bars} bars in the window carry intraday extremes, from ${c.from}. `
      + 'This is neither the close-to-close quantity nor the intraday one, and it should not be compared with either until the window is wholly one or the other.',
    )}">mix</span>`;
  }
  return '';
}

/** One line a consumer can print beside a number computed on a mixed window. */
function intradayBasisNote(cov) {
  if (!cov || cov.basis === PX_BASIS.NONE) return '';
  if (cov.basis === PX_BASIS.INTRADAY) return 'from intraday extremes';
  if (cov.basis === PX_BASIS.CLOSES) return 'close-to-close — understated';
  return `mixed: ${cov.known} of ${cov.bars} bars carry intraday extremes, from ${cov.from}`;
}

/** Fetch one date range from Polygon and merge it into the stored series.

    `side` says where the bars belong: `'before'` prepends them and moves the
    series' first date back, `'after'` appends and moves the last date forward,
    and `null` is a cold fetch that becomes the whole series. */
async function fetchRange(symbol, from, to, side) {
  const data = await getFrom(
    'polygon',
    `v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: 50000 },
    0,   // never cached: the raw response is ~10x the size of what we keep
  );

  /* Date, close and the intraday extremes are carried together and filtered
     together. Reading the date off `results` while the closes come from a
     separately filtered array lets one dropped bar shift every date by one
     position — and the same trap now exists three more times over, so the
     extremes ride on the same object through the same filter.

     THE EXTREMES WERE ALWAYS IN THIS RESPONSE. Polygon's aggregates return
     o/h/l/c/v/vw/t per bar and this mapped `b.c` alone, discarding the rest —
     which is why capturing them costs no extra call, no extra endpoint and no
     plan change. Only the bars fetched from now on carry them; older bars keep
     their nulls until someone runs the backfill. */
  const num = (v) => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const bars = (Array.isArray(data.results) ? data.results : [])
    .map((b) => ({ day: isoDay(b.t), c: num(b.c), h: num(b.h), l: num(b.l) }))
    .filter((b) => b.c != null)
    /* A low above its own close, or a high below it, is a broken bar. Dropping
       just the extremes keeps the close — which is still good — rather than
       discarding the bar and shifting every date after it. */
    .map((b) => (b.l != null && b.h != null && b.l <= b.c && b.h >= b.c
      ? b : { ...b, h: null, l: null }));

  const existing = state.px.series.get(symbol);
  const stamp = { at: Date.now(), bf: side === 'after' && existing ? existing.bf : from };

  if (!bars.length) {
    // A valid "nothing there" — an empty older window means the symbol simply
    // was not listed yet. Stamp it so the next pass does not ask again.
    if (existing) await writeSeries(symbol, stampIntraday({ ...existing, ...stamp }));
    return 0;
  }

  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);

  if (!existing || !side) {
    await writeSeries(symbol, stampIntraday({
      f: bars[0].day,
      t: bars[bars.length - 1].day,
      c: closes.slice(-PX_MAX_BARS),
      h: highs.slice(-PX_MAX_BARS),
      l: lows.slice(-PX_MAX_BARS),
      ...stamp,
    }));
    return closes.length;
  }

  const prev = paddedIntraday(existing);

  if (side === 'before') {
    /* Truncation keeps the newest bars, so prepending more than the cap allows
       would discard exactly the bars just fetched. Trim the incoming head
       instead and take `f` from the oldest bar that actually survives — its
       real date, straight off the response, no interpolation needed. */
    const room = Math.max(0, PX_MAX_BARS - existing.c.length);
    if (!room) {
      await writeSeries(symbol, stampIntraday({ ...existing, ...prev, ...stamp }));
      return 0;
    }
    // One cut length for all three, so the head cannot desynchronise.
    const cut = Math.min(closes.length, room);
    await writeSeries(symbol, stampIntraday({
      f: bars[bars.length - cut].day,
      t: existing.t,
      c: closes.slice(-cut).concat(existing.c),
      h: highs.slice(-cut).concat(prev.h),
      l: lows.slice(-cut).concat(prev.l),
      ...stamp,
    }));
    return cut;
  }

  const merged = existing.c.concat(closes);
  const overflow = Math.max(0, merged.length - PX_MAX_BARS);
  await writeSeries(symbol, stampIntraday({
    f: overflow ? dayAtIndex(existing, overflow) : existing.f,
    t: bars[bars.length - 1].day,
    c: merged.slice(-PX_MAX_BARS),
    h: prev.h.concat(highs).slice(-PX_MAX_BARS),
    l: prev.l.concat(lows).slice(-PX_MAX_BARS),
    ...stamp,
  }));
  return closes.length;
}

/** Bring one symbol's history up to date at both ends.

    A cold symbol is one call for the whole window. A stored one is asked only
    for what it is missing, and it can be missing bars at either end: older ones
    because the window was widened from two years to ten, newer ones because
    time passed. Each gap is its own request, so neither re-downloads bars
    already held — and on a typical day there is no gap at all and no call. */
async function fetchSeries(symbol) {
  const existing = state.px.series.get(symbol);
  const today = isoDay(Date.now());
  const floor = pxFloorDay();

  if (!existing) return fetchRange(symbol, floor, today, null);

  let added = 0;

  // Older bars first: this is the half that makes the longer backtest possible,
  // and unlike the forward gap it does not grow if it has to wait.
  if (!existing.bf || existing.bf > floor) {
    if (state.px.historyLimited) {
      /* The plan already refused this depth once this run. Record the floor as
         requested so the symbol stops queueing for a call that cannot succeed,
         and spend nothing finding that out 400 more times. */
      await writeSeries(symbol, { ...existing, bf: floor, at: Date.now() });
    } else {
      try {
        added += await fetchRange(symbol, floor, shiftDay(existing.f, -1), 'before');
      } catch (err) {
        /* A 403 on the OLDER window is a depth limit, not an auth failure: the
           same key keeps serving the recent window in the same run. Learn it
           once, stamp this symbol, and let the forward fetch below carry on. */
        if (err.status !== 403) throw err;
        state.px.historyLimited = err.message;
        await writeSeries(symbol, { ...existing, bf: floor, at: Date.now() });
      }
    }
  }

  // Re-read: the prepend above replaced the record.
  const current = state.px.series.get(symbol) || existing;
  const from = shiftDay(current.t, 1);
  if (from <= today) {
    added += await fetchRange(symbol, from, today, 'after');
  } else if (!added) {
    // Nothing can have happened between the last bar and itself.
    await writeSeries(symbol, { ...current, at: Date.now() });
  }

  return added;
}

/** Backfill the board's price history in the background, 5 calls a minute.

    Pacing is not this loop's job — every request goes through the provider's
    own sliding-window limiter, so the loop can simply run flat out and be
    throttled from underneath. Stopping keeps everything already stored, and
    starting again resumes at the first symbol that still needs bars. */
/* ── Fundamentals pass ────────────────────────────────────────────────
   EXPLICIT REQUEST ONLY. Never called from a render, a boot path, or a board
   mode change. The proxy in serve.mjs is a single Node process and a full pass
   is ~560 sequential EDGAR round trips; letting that ride along with a board
   render would stall every other request behind it for a minute and a half.
   Filings land 29-37 days after a quarter ends, so there is nothing to gain
   from running it often either. */
async function fetchAllFundamentals() {
  if (state.fx.running) return;

  if (!state.fx.hydrated) {
    toast('Still reading the stored fundamentals — try again in a moment.');
    return;
  }
  if (!state.proxy) {
    toast('Fundamentals come from SEC EDGAR, which only the local server (serve.mjs) can reach.');
    return;
  }
  /* The CIK map is what turns a ticker into an EDGAR request, and it is only
     written by secResolve, which needs the proxy. Without it every symbol would
     fail identically. */
  if (!Object.keys(state.sec.cik).length) {
    toast('No CIK map yet — the EDGAR check has not run. Reload with serve.mjs behind the page.');
    return;
  }

  const todo = state.symbols.filter((s) => state.sec.cik[s] != null && !notRegistered(s));
  if (!todo.length) {
    toast('No symbols resolve to a CIK.');
    return;
  }

  Object.assign(state.fx, {
    running: true, cancelled: false, done: 0, failed: 0, total: todo.length, failures: [],
  });
  renderFxProgress();

  for (const symbol of todo) {
    if (state.fx.cancelled) break;
    try {
      await fetchFundamentals(symbol);
    } catch (err) {
      state.fx.failed++;
      state.fx.failures.push({ symbol, status: err.status ?? null, message: String(err.message || err) });
      /* A missing proxy fails the same way for all 560, so stop rather than
         grind through the rest producing one identical error per symbol. */
      if (err.status === 404 && !state.fx.done) {
        toast('The /sec/ proxy is not answering — is the page served by serve.mjs?');
        break;
      }
    }
    state.fx.done++;
    renderFxProgress();
  }

  const stopped = state.fx.cancelled;
  state.fx.running = false;
  renderFxProgress();

  const stored = state.fx.done - state.fx.failed;
  toast(stopped
    ? `Stopped. ${stored} symbols stored — starting again refetches from the beginning.`
    : `Fundamentals stored for ${stored} symbols${state.fx.failed ? `, ${state.fx.failed} failed` : ''}.`);
}

function renderFxProgress() {
  const box = $('#fx-progress');
  const start = $('#fx-start');
  const cancel = $('#fx-cancel');
  if (!box) return;

  box.hidden = !state.fx.running;
  if (start) start.hidden = state.fx.running;
  if (cancel) cancel.hidden = !state.fx.running;
  if (!state.fx.running) return;

  const pct = state.fx.total ? (state.fx.done / state.fx.total) * 100 : 0;
  $('#fx-fill').style.width = `${pct}%`;
  $('#fx-text').textContent =
    `Fundamentals ${state.fx.done} / ${state.fx.total}${state.fx.failed ? ` · ${state.fx.failed} failed` : ''}`;
}

async function backfillPrices() {
  if (state.px.running) return;
  /* Before hydration the series Map is empty, and an empty Map makes every
     symbol look uncovered — starting here would refetch a board that is
     already stored, at five calls a minute. */
  if (!state.px.hydrated) {
    toast('Still reading the stored price history — try again in a moment.');
    return;
  }
  if (!state.provKeys.polygon) {
    toast('Connect a Polygon key first — the price history comes from there.');
    showKeyGate('', '');
    return;
  }

  /* The benchmark goes first, and is not part of the watchlist — one extra
     call, so the backtest has a yardstick before the board is finished. */
  const wanted = BENCHMARK ? [BENCHMARK, ...state.symbols] : [...state.symbols];
  const todo = wanted.filter(needsPrices);
  if (!todo.length) {
    toast('Price history is already up to date.');
    return;
  }

  state.px = {
    ...state.px,
    running: true, cancelled: false, done: 0, total: todo.length, failed: 0,
    // Which symbols failed and why. A bare count cannot answer either question
    // after the fact, and "15 failed" with no way to see what they were is not
    // a report — it is a rumour.
    failures: [],
    historyLimited: null,
  };
  renderPxProgress();

  for (const symbol of todo) {
    if (state.px.cancelled) break;
    try {
      await fetchSeries(symbol);
    } catch (err) {
      state.px.failed++;
      state.px.failures.push({
        symbol,
        status: err.status ?? null,
        message: String(err.message || err),
      });
      /* A rejected key or an exhausted plan will fail identically for every
         remaining symbol, so stop rather than grind through 500 more. */
      if (err.status === 401 || err.status === 403) {
        toast(err.message);
        break;
      }
    }
    state.px.done++;
    renderPxProgress();
    // renderBoard recomputes the indicators, so rows fill in as bars arrive.
    if (domain(state.boardMode).needsPrices && state.view === VIEW.BOARD) renderBoard();
  }

  const stopped = state.px.cancelled;
  state.px.running = false;
  renderPxProgress();
  renderBoard();

  if (stopped) {
    toast(`Stopped. ${state.px.done} symbols stored — starting again resumes where it left off.`);
    return;
  }

  const stored = state.px.done - state.px.failed;
  if (state.px.historyLimited) {
    /* Not a failure worth counting per symbol: the plan served everything it
       has, and the older window is simply not on it. Say so once, in the
       provider's own words. */
    toast(`Price history updated for ${stored} symbols. Older bars were refused — ${state.px.historyLimited}`);
    return;
  }

  if (!state.px.failed) {
    toast(`Price history updated for ${stored} symbols.`);
    return;
  }

  // Lead with the commonest reason rather than a bare count.
  const reasons = new Map();
  for (const f of state.px.failures) reasons.set(f.message, (reasons.get(f.message) || 0) + 1);
  const [topReason, count] = [...reasons].sort((a, b) => b[1] - a[1])[0];
  toast(`Price history updated for ${stored} symbols, ${state.px.failed} failed — ${
    count === state.px.failed ? 'all' : `${count} of them`}: ${topReason}`);
}

/** The last run's failures, grouped by reason. For working out what went wrong
    without re-running anything: `pxFailures()` in the console. */
function pxFailures() {
  const byReason = new Map();
  for (const f of state.px.failures || []) {
    if (!byReason.has(f.message)) byReason.set(f.message, []);
    byReason.get(f.message).push(f.symbol);
  }
  return [...byReason].map(([reason, symbols]) => ({ reason, count: symbols.length, symbols }));
}

// ── Technical indicators ────────────────────────────────────────────
/* Each takes the close series oldest-first and returns null when there is not
   enough history, rather than a plausible number computed from too little. */

/** Return over six months, excluding the most recent month.

    The recent month is dropped because short-horizon reversal runs against
    medium-horizon momentum: the last few weeks of a move tend to give back,
    and including them muddies what the previous five months actually showed.
    It is the standard 12−1 construction on a six-month window. */
function momentum6m1m(c) {
  if (c.length < MOM_LOOKBACK + 1) return null;
  const end = c[c.length - 1 - MOM_SKIP];
  const start = c[c.length - 1 - MOM_LOOKBACK];
  if (!start || !end) return null;
  return (end / start - 1) * 100;
}

/** Percent above (+) or below (−) the 200-day simple moving average. */
function maGap(c, window = MA_WINDOW) {
  if (c.length < window) return null;
  let sum = 0;
  for (let i = c.length - window; i < c.length; i++) sum += c[i];
  const ma = sum / window;
  return ma ? (c[c.length - 1] / ma - 1) * 100 : null;
}

/** Wilder's 14-day RSI, seeded on the first window and smoothed across the
    rest of the series — the original definition, not a plain moving average
    of gains, which gives a visibly different number. */
function rsi14(c, window = RSI_WINDOW) {
  if (c.length < window + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= window; i++) {
    const change = c[i] - c[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= window;
  avgLoss /= window;

  for (let i = window + 1; i < c.length; i++) {
    const change = c[i] - c[i - 1];
    avgGain = (avgGain * (window - 1) + Math.max(change, 0)) / window;
    avgLoss = (avgLoss * (window - 1) + Math.max(-change, 0)) / window;
  }

  // No losses at all is RSI 100 by definition; a series that never moved has
  // no relative strength to speak of, and 50 is the honest neutral for it.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Where the last close sits in the 52-week closing range: 0 at the low, 100
    at the high. Closes, not intraday extremes — highs and lows are not stored,
    because keeping them would triple the storage budget for a cosmetic gain. */
function rangePos(c, window = RANGE_WINDOW) {
  const w = c.length > window ? c.slice(-window) : c;
  if (w.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const price of w) {
    if (price < lo) lo = price;
    if (price > hi) hi = price;
  }
  if (hi === lo) return null;
  return ((c[c.length - 1] - lo) / (hi - lo)) * 100;
}

/** Twelve-month return with the most recent month dropped — the canonical
    momentum construction. The skipped month is the point of it: at a one-month
    horizon returns reverse rather than continue, so including it works against
    the effect being measured. Same skip as the six-month form. */
function momentum12m1m(c) {
  if (c.length < MOM12_LOOKBACK + 1) return null;
  const end = c[c.length - 1 - MOM_SKIP];
  const start = c[c.length - 1 - MOM12_LOOKBACK];
  if (!start || !end) return null;
  return (end / start - 1) * 100;
}

/** Annualised standard deviation of daily simple returns, in percent.

    Sample standard deviation (n−1), scaled by √252. Simple returns rather than
    log returns: the difference is immaterial at daily frequency and simple
    returns are what the rest of this file uses. */
function realisedVol(c, window = VOL_WINDOW) {
  if (c.length < window + 1) return null;

  const rets = [];
  for (let i = c.length - window; i < c.length; i++) {
    const prev = c[i - 1];
    if (!prev) return null;
    rets.push(c[i] / prev - 1);
  }
  if (rets.length < 2) return null;

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let sq = 0;
  for (const r of rets) sq += (r - mean) * (r - mean);
  return Math.sqrt(sq / (rets.length - 1)) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Largest peak-to-trough fall within the window, as a positive percent.

    INTRADAY WHERE AVAILABLE, CLOSE-TO-CLOSE WHERE NOT, and the caller is told
    which — see `intradayCoverage`. Close-to-close drawdown is SYSTEMATICALLY
    UNDERSTATED: the true figure runs from the peak's high to the trough's low,
    and a close is by definition inside that range. The bias is one-directional,
    roughly a daily range deep, and `DD_PIVOT = 30` was set against the
    understated quantity — so if this board ever reaches full intraday coverage,
    the pivot is calibrated against a number that no longer exists.

    `highs` and `lows` are index-aligned with `c`, with null for bars whose
    extremes are unknown. A null falls back to the close FOR THAT BAR ONLY,
    which is the correct conservative choice: it is the one price known to have
    traded, so the drawdown is understated for that bar rather than invented. */
function maxDrawdown(c, window = DD_WINDOW, lows = null, highs = null) {
  if (c.length < window) return null;
  const from = c.length - window;
  const at = (arr, i) => {
    const v = Array.isArray(arr) && arr.length === c.length ? arr[i] : null;
    return v == null ? c[i] : v;
  };

  let peak = at(highs, from);
  let worst = 0;
  for (let i = from; i < c.length; i++) {
    /* The peak runs on highs and the trough on lows, and both are needed: a
       peak taken from closes understates the top of the fall exactly as a
       trough taken from closes understates the bottom. */
    const hi = at(highs, i);
    const lo = at(lows, i);
    if (hi > peak) peak = hi;
    if (!peak) continue;
    const fall = (peak - lo) / peak;
    if (fall > worst) worst = fall;
  }
  return worst * 100;
}

/** Price levels that several local extremes agree on.

    A local extreme is a close that is the highest — or the lowest — of the
    SR_SWING bars on each side. Extremes are then swept in price order and
    merged while they stay within SR_BAND, and a merged level survives only if
    SR_MIN_TOUCHES extremes formed it.

    NOT volume-weighted. The series store keeps closes and nothing else (see
    fetchRange), so there is no volume at these levels to weight by, and touch
    count stands in for it. That is a weaker instrument than the literature's
    and is one reason this factor is marked experimental. */
function srLevels(c, window = SR_WINDOW) {
  const w = c.length > window ? c.slice(-window) : c;
  if (w.length < SR_SWING * 2 + 1) return [];

  const extremes = [];
  for (let i = SR_SWING; i < w.length - SR_SWING; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - SR_SWING; j <= i + SR_SWING; j++) {
      if (j === i) continue;
      if (w[j] >= w[i]) isHigh = false;
      if (w[j] <= w[i]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh || isLow) extremes.push(w[i]);
  }

  extremes.sort((a, b) => a - b);

  const clusters = [];
  for (const price of extremes) {
    const open = clusters[clusters.length - 1];
    /* Merged against the cluster's first price, not its running mean: drifting
       the comparison point lets a long chain of near-misses walk a "level"
       arbitrarily far from where it started. */
    if (open && price <= open.base * (1 + SR_BAND)) {
      open.touches++;
      open.sum += price;
    } else {
      clusters.push({ base: price, sum: price, touches: 1 });
    }
  }

  return clusters
    .filter((cl) => cl.touches >= SR_MIN_TOUCHES)
    .map((cl) => ({ level: cl.sum / cl.touches, touches: cl.touches }));
}

/** Percent above the nearest qualifying support level below the last close.

    Null when nothing qualifies — a name at its lowest point in the window has
    no support beneath it to measure against, which is information rather than
    a gap to paper over. */
function supportDistance(c, window = SR_WINDOW) {
  if (!c.length) return null;
  const price = c[c.length - 1];
  const below = srLevels(c, window).filter((l) => l.level < price);
  if (!below.length) return null;

  const nearest = below.reduce((best, l) => (l.level > best.level ? l : best));
  return ((price - nearest.level) / price) * 100;
}

/* ── Price-denominated anchors ────────────────────────────────────────
   Added 2026-09-01. Everything above returns a percentage or an index, which is
   the right shape for a factor and the wrong shape for a level.

   `entry_level` asks the model for a PRICE and requires it to be arithmetic on
   a figure it was given. Until this existed, the only price anywhere in the
   assessment context was the current one: the 52-week RANGE reached the model
   as a position ("80%"), the 200-day mean as a gap ("+10%"), support as a
   distance ("17.9%"). A position of 80% and a price of 203.16 is one equation
   in two unknowns — the endpoints are not recoverable from it.

   So the field could not be satisfied as specified, and the two levels it did
   produce cited $134.30 and $216.90, which were never supplied to it. They came
   from the model's web search. The instruction was impossible and the gate could
   not tell, because it only checked that the basis was a non-empty string.

   Nothing new is measured here. These are the same numbers the factors above
   already compute and throw away; what changes is that the prices survive. */

/** The 52-week closing range as two prices — the endpoints `rangePos` reduces
    to a single percentage and discards. Same window, same closes. */
function rangePrices(c, window = RANGE_WINDOW) {
  const w = c.length > window ? c.slice(-window) : c;
  if (w.length < 2) return { low: null, high: null };
  let low = Infinity;
  let high = -Infinity;
  for (const price of w) {
    if (price < low) low = price;
    if (price > high) high = price;
  }
  return high === low ? { low: null, high: null } : { low, high };
}

/** The 200-day mean as a price. `maGap` computes exactly this and returns only
    the gap from it. */
function ma200Price(c, window = MA_WINDOW) {
  if (c.length < window) return null;
  let sum = 0;
  for (let i = c.length - window; i < c.length; i++) sum += c[i];
  return sum / window;
}

/** Nearest support below and nearest resistance above, as PRICES.

    `supportDistance` keeps the percentage and throws the level away; the
    resistance side was never surfaced at all, although `srLevels` finds both
    and always has. Resistance is included because a level is a claim about
    where price stops, and a model given only the downside anchor is being
    steered toward one. */
function srPrices(c, window = SR_WINDOW) {
  if (!c.length) return { support: null, resistance: null };
  const price = c[c.length - 1];
  const levels = srLevels(c, window);
  const below = levels.filter((l) => l.level < price);
  const above = levels.filter((l) => l.level > price);
  return {
    support: below.length ? below.reduce((b, l) => (l.level > b.level ? l : b)).level : null,
    resistance: above.length ? above.reduce((b, l) => (l.level < b.level ? l : b)).level : null,
  };
}

/* `call_near` is scored over one and three months, so the band that bounds
   `entry_level` is a quarter's worth of movement. sqrt(1/4) = 1/2, so a
   quarter's sigma is half the annualised figure the volatility factor already
   reports. Why 1σ and not 1.5σ: see the docs/NOTES.md note — the choice is for
   measurability, not because 1σ is the correct distance. */
const ENTRY_HORIZON_YEARS = 0.25;

/** One standard deviation of price over one quarter, in dollars. */
function sigmaQuarter(price, annualVolPct) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(annualVolPct) || annualVolPct <= 0) return null;
  return price * (annualVolPct / 100) * Math.sqrt(ENTRY_HORIZON_YEARS);
}

/** Every price-denominated anchor the board can offer for one symbol.

    `price` is the live quote and the closes end at the last stored session, so
    the range can exclude today. That is stated in the context rather than
    papered over: a 52-week high below the current price is a fact about the
    store's freshness, and a model that notices it is right to. */
function priceAnchors(closes, price, annualVolPct) {
  const c = Array.isArray(closes) ? closes : [];
  const { low, high } = rangePrices(c);
  const { support, resistance } = srPrices(c);
  const sigma = sigmaQuarter(price, annualVolPct);
  return {
    low52: low,
    high52: high,
    ma200: ma200Price(c),
    support,
    resistance,
    sigma,
    bandLow: sigma == null ? null : price - sigma,
    bandHigh: sigma == null ? null : price + sigma,
    lastClose: c.length ? c[c.length - 1] : null,
  };
}

/* ── Single-bar anomalies ─────────────────────────────────────────────
   One bar can carry a whole factor. MRNA's 2026-08-17 close went 62.96 → 174.38
   (+177%) and took its twelve-month realised volatility from 75% to 192%.

   What this does NOT do is decide why. Three candidate tests were measured on
   2026-09-01 and all three failed to separate a data fault from a violent real
   move:

   - "a real gap retraces, a corporate action persists" — MRNA retained 0.72 of
     its jump, AAP 0.73, MEDP 0.79. A genuine re-rating IS a permanent level
     shift, so persistence says nothing.
   - a clean split ratio — MRNA's is 2.7697, nearest 3:1 off by 7.7%. A failed
     split adjustment gives an EXACT ratio. None of the three candidates did.
   - mom6-vs-mom12 divergence — MRNA ranks tenth on it. The nine above are the
     2025 semiconductor rally, with largest bars of 15–29%. It detects a
     sustained sector move, not a fault.

   So the screen targets the HARM instead of the cause: one bar accounting for
   more than VOL_INFLATION_FLAG points of annualised volatility means the factor
   is describing that bar rather than the stock, whether or not the bar is real.
   MRNA inflates by 117 points; the next worst name on the board is FMC at 16.
   Nothing sits between, which is why the threshold is not delicate.

   Flagged factors are annotated, never nulled. The cause is unresolved and
   nulling a possibly-genuine reading throws away a real signal. */
const VOL_INFLATION_FLAG = 40;

/** Index of the largest single-bar move in the volatility window. */
function anomalyIndex(c, window = VOL_WINDOW) {
  let at = -1;
  let worst = 0;
  for (let i = Math.max(1, c.length - window); i < c.length; i++) {
    if (!c[i - 1] || !c[i]) continue;
    const move = Math.abs(Math.log(c[i] / c[i - 1]));
    if (move > worst) { worst = move; at = i; }
  }
  return at;
}

/** The series with one bar's discontinuity spliced out.

    Everything before the bar is scaled by its ratio, which is exactly what a
    split adjustment does — so the bar's own return becomes zero and every other
    return in the series is untouched. That gives one coherent "without this
    bar" series that every factor can be recomputed on, rather than a different
    ad-hoc removal per factor. */
function backAdjusted(c, at) {
  const ratio = c[at] / c[at - 1];
  return c.map((price, i) => (i < at ? price * ratio : price));
}

/* Which factors read which bars.

   The flag has to be per factor, because a bar outside a factor's span cannot
   affect it. Both momentum forms read exactly two closes — `c[n-1-MOM_SKIP]`
   and `c[n-1-LOOKBACK]` — so a bar in the skipped final month is invisible to
   them. MRNA is the case in point: its jump sits at index 492 of 500, past the
   momentum end index of 478, so mom12 and mom6 are UNAFFECTED and only vol,
   drawdown and support distance move. Flagging the whole symbol would discard
   two good numbers. */
const ANOMALY_FACTORS = [
  { field: 'mom12m1m', read: momentum12m1m,
    span: (n) => [n - 1 - MOM12_LOOKBACK, n - 1 - MOM_SKIP] },
  { field: 'mom6m1m', read: momentum6m1m,
    span: (n) => [n - 1 - MOM_LOOKBACK, n - 1 - MOM_SKIP] },
  { field: 'realisedVol', read: realisedVol, span: (n) => [n - VOL_WINDOW, n - 1] },
  { field: 'maxDD', read: maxDrawdown, span: (n) => [n - DD_WINDOW, n - 1] },
  { field: 'srDist', read: supportDistance, span: (n) => [n - SR_WINDOW, n - 1] },
];

/** The anomaly on this series, with each affected factor's ex-bar reading.

    Null when no bar inflates volatility past the threshold — which is every
    name on the board except one. */
function anomalyFor(c) {
  if (!c || c.length < VOL_WINDOW + 2) return null;

  const at = anomalyIndex(c);
  if (at < 1 || !c[at - 1]) return null;

  const reported = realisedVol(c);
  const adjusted = backAdjusted(c, at);
  const exBar = realisedVol(adjusted);
  if (reported == null || exBar == null) return null;

  const inflation = reported - exBar;
  if (inflation < VOL_INFLATION_FLAG) return null;

  const n = c.length;
  const exBarValues = {};
  for (const f of ANOMALY_FACTORS) {
    const [lo, hi] = f.span(n);
    if (at < lo || at > hi) continue;          // outside this factor's span
    const without = f.read(adjusted);
    const with_ = f.read(c);
    // Only worth showing where it actually moves the number.
    if (without == null || with_ == null) continue;
    exBarValues[f.field] = without;
  }

  return {
    at,
    ratio: c[at] / c[at - 1],
    barPct: (c[at] / c[at - 1] - 1) * 100,
    volReported: reported,
    volExBar: exBar,
    inflation,
    exBar: exBarValues,
  };
}

/* ── Missing bars ─────────────────────────────────────────────────────
   A stored series is {f, t, c[], at, bf} — closes and two dates, no date per
   bar. `dayAtIndex` infers dates by assuming even spacing, so one missing bar
   silently shifts every date after it and nothing downstream could tell. That
   is a problem for the backtest's point-in-time guarantee, not just for
   volatility.

   Full per-bar dates would fix it properly and cost a schema change plus a
   complete re-backfill (~580 symbols at Polygon's 5/min, about two hours). This
   is the cheap check instead, and it needs neither.

   TWO SERIES COVERING THE SAME [f, t] MUST HOLD THE SAME NUMBER OF BARS. The
   board is its own calendar: 560 of 580 series span 2024-08-30 to 2026-08-28
   and every one holds exactly 500 closes, so a deviation inside that group is a
   gap, detected exactly and with no holiday calendar anywhere.

   The weekday fallback below is much coarser and exists only for spans held by
   too few symbols to vote. A flat deficit threshold does NOT work across
   different span lengths — measured across all 580 series the deficit runs 3.70%
   to 4.78%, because a short window can hold a holiday-dense stretch — so the
   ceiling is set well above that range and catches only large gaps. */
const GAP_COHORT_MIN = 5;
const GAP_DEFICIT_MAX = 0.06;

/** Weekdays in [from, to] inclusive. Holidays are not removed — the callers
    above compare against a threshold that already allows for them. */
function weekdaysBetween(from, to) {
  let n = 0;
  const day = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (day <= end) {
    const w = day.getUTCDay();
    if (w !== 0 && w !== 6) n++;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return n;
}

/** symbol -> why its series cannot be trusted to be gap-free, for the ones that
    cannot. Everything absent from the map reconciled. */
function seriesGaps(seriesMap) {
  const bySpan = new Map();
  for (const [symbol, s] of seriesMap) {
    if (!s || !s.c || !s.c.length || !s.f || !s.t) continue;
    const key = `${s.f}|${s.t}`;
    if (!bySpan.has(key)) bySpan.set(key, []);
    bySpan.get(key).push({ symbol, bars: s.c.length, f: s.f, t: s.t });
  }

  const gaps = new Map();
  for (const members of bySpan.values()) {
    if (members.length >= GAP_COHORT_MIN) {
      /* The cohort votes. The mode is what a complete series over this span
         holds, so anything short of it is missing bars — exactly, with no
         calendar and no tolerance. */
      const counts = new Map();
      for (const m of members) counts.set(m.bars, (counts.get(m.bars) || 0) + 1);
      let mode = 0;
      let best = -1;
      for (const [bars, n] of counts) if (n > best) { best = n; mode = bars; }

      for (const m of members) {
        if (m.bars < mode) {
          gaps.set(m.symbol, `${mode - m.bars} bar${mode - m.bars === 1 ? '' : 's'} missing `
            + `— ${m.bars} stored where ${best} other symbols over ${m.f}→${m.t} hold ${mode}`);
        }
      }
      continue;
    }

    // Too few to vote: fall back on the coarse weekday check.
    for (const m of members) {
      const weekdays = weekdaysBetween(m.f, m.t);
      if (!weekdays) continue;
      const deficit = (weekdays - m.bars) / weekdays;
      if (deficit > GAP_DEFICIT_MAX) {
        gaps.set(m.symbol, `${m.bars} bars over ${weekdays} weekdays — `
          + `${(deficit * 100).toFixed(1)}% short, above the `
          + `${(GAP_DEFICIT_MAX * 100).toFixed(0)}% limit. Too few symbols share `
          + `${m.f}→${m.t} to check the count exactly.`);
      }
    }
  }
  return gaps;
}

/** Map a signed percentage onto 0–100 through a tanh curve: 50 at zero,
    approaching 0 and 100 without ever tying two different inputs together.
    `k` is the scale — the value at which the curve reaches ~76. */
const curveScore = (value, k) =>
  (value == null ? null : 50 + 50 * Math.tanh(value / k));

/** Skewed bell on 52-week range position: peaks at RANGE_PEAK, falls away
    gently below it and sharply above. */
function rangeCurve(pos) {
  if (pos == null) return null;
  const width = pos <= RANGE_PEAK ? RANGE_W_BELOW : RANGE_W_ABOVE;
  const z = (pos - RANGE_PEAK) / width;
  return 100 * Math.exp(-(z * z));
}

/** The indicators as comparable 0–100 sub-scores.

    The three inverted ones all take the same shape — PIVOT minus the reading,
    through the same curve — so that "lower is better" is expressed once, in
    the sub-score, and never again downstream. Every consumer can then treat
    all five identically as higher-is-better.

    The null guards matter: `PIVOT - null` is `PIVOT`, not null, which would
    silently score an unmeasurable name as if it had come in exactly at the
    pivot. */
function subScores(r) {
  return {
    mom6Score:  curveScore(r.mom6m1m, MOM_K),
    mom12Score: curveScore(r.mom12m1m, MOM12_K),
    /* Log space — see VOL_LOG_K. Guarded above zero because log(0) is −Infinity
       and a zero-volatility series is a flat line, not a safe stock. */
    volScore:   r.realisedVol == null || !(r.realisedVol > 0) ? null
      : curveScore(Math.log(VOL_PIVOT) - Math.log(r.realisedVol), VOL_LOG_K),
    ddScore:    r.maxDD == null ? null : curveScore(DD_PIVOT - r.maxDD, DD_K),
    srScore:    r.srDist == null ? null : curveScore(SR_PIVOT - r.srDist, SR_K),

    /* Fundamentals. Higher is better for the first three as they stand; accruals
       are inverted, because the effect in the literature is that LOW accruals
       precede better returns — earnings backed by cash rather than by
       estimates. Expressed once here, so nothing downstream has to remember. */
      eyScore:  r.earnYield == null ? null : curveScore(r.earnYield - EY_PIVOT, EY_K),
    bmScore:  r.bookToMkt == null ? null : curveScore(r.bookToMkt - BM_PIVOT, BM_K),
    roeScore: r.roe == null ? null : curveScore(r.roe - ROE_PIVOT, ROE_K),
    accScore: r.accruals == null ? null : curveScore(ACC_PIVOT - r.accruals, ACC_K),
  };
}

/* ── Who is in the cohort ─────────────────────────────────────────────
   An absolute score answers "what is this symbol's reading". A cross-sectional
   score answers "where does it stand among these others", so the others are
   part of the answer and admitting the wrong ones corrupts every score at once,
   not just the offending row's.

   Defined here, once, and consulted by `applyCrossSectionalScores` for EVERY
   cross-sectional score — the three that exist and any added later. The bug
   this closes was specific to the analyst score only because it is the one
   cross-sectional score that needs no prices: `zblend` and `momscreen` already
   produced null for a dead company, since their components come from a price
   series that stopped. `analystPct` cheerfully ranked 14 companies that no
   longer trade, from cached consensus, because nothing it depended on had
   noticed.

   Returns a REASON rather than a boolean so the exclusion can be shown, counted
   and argued with, instead of being a silent filter.

   `score` is optional. Called without one it reports only the exclusions that
   apply to EVERY cross-sectional score — which is what the header count wants.
   Called with one it adds the exclusions specific to what that score reads. */
function cohortIneligible(row, score) {
  if (!row) return null;

  /* Strongest and most direct, but it depends on EDGAR having been reached at
     least once: `state.sec.gone` is only written by secResolve, which needs the
     proxy. On a page served without one this is always empty, so it must not be
     the only rule — see the next, which reads data already on disk. */
  if (notRegistered(row.symbol)) return 'no longer an SEC registrant';

  /* Works with no EDGAR at all. `pxNote` is set when the symbol has no current
     quote, or when its price series stopped while the rest of the board moved
     on. Every one of the 14 dead names carries it, including the two that are
     only days stale rather than months. Ordinary cache age is NOT this: quotes
     are cached for 24h by design and every row is "stale" by that measure at
     some point in the day.

     A gap sets `pxNote` too, so it is excluded here — the next rule handles it
     on its own terms rather than letting it ride along as a market-data fault,
     which it is not. */
  if (row.pxNote && !row.pxGap) return 'no current market data';

  /* A hole in a PRICE series invalidates price-derived factors and says nothing
     whatever about analyst consensus. So it gates the cross-sectional scores
     whose domain reads prices, and leaves the analyst percentile alone: a live,
     well-covered company should not lose its consensus ranking because its bar
     count came up short.

     Nothing currently trips this — the cohort check found zero gapped series —
     which is exactly why it was worth separating now rather than after it
     started mattering. */
  if (row.pxGap && score && score.domain && score.domain.needsPrices) {
    return 'price series has missing bars';
  }
  return null;
}

/** Fill in every cross-sectional score across one cohort of rows.

    Separate from `technicalsFor` because it is a different kind of computation:
    `technicalsFor` looks at one symbol's bars and nothing else, while this
    needs the whole cohort at once. Keeping them apart is what lets the backtest
    hand it one start date's symbols and get a point-in-time answer.

    A row scores only if EVERY component does. Renormalising over the present
    ones — the way `weightedScore` does — would defeat the purpose here: the
    whole point is that the components contribute equally, and a one-legged
    z-blend is just that leg. */
function applyCrossSectionalScores(rows) {
  for (const s of allScores()) {
    if (!s.crossSectional) continue;

    /* One filter, consulted per score because eligibility is not identical for
       all of them: a price-series gap disqualifies a name from the price-derived
       rankings and not from the analyst one. An ineligible row is excluded from
       the statistics AND left unscored — both, deliberately. Being counted but
       unscored would still move everyone else's percentile; being scored but
       uncounted would rank a dead company against the living. */
    const cohort = [];
    const at = [];
    rows.forEach((row, i) => {
      if (cohortIneligible(row, s)) return;
      cohort.push(row);
      at.push(i);
    });

    // Nobody is scored until the cohort says so, so an ineligible row cannot
    // keep a value computed on a previous pass over a different cohort.
    for (const row of rows) row[s.field] = null;

    const parts = cohort.map((r) => subScores(r));

    /* A cohort score that is not a z-standardisation supplies its own function.
       It gets the eligible rows' sub-scores at once and returns one value per
       eligible row, in the same order — a screen, a rank, a decile cut. */
    if (s.cohort) {
      const values = s.cohort(parts, cohort);
      at.forEach((rowIndex, k) => { rows[rowIndex][s.field] = values[k] ?? null; });
      continue;
    }

    const stats = {};
    for (const field of s.components) {
      const values = parts.map((p) => p[field]).filter((v) => v != null);
      if (values.length < Z_MIN_COHORT) { stats[field] = null; continue; }
      const m = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((t, v) => t + (v - m) * (v - m), 0) / (values.length - 1));
      // A cohort with no spread cannot standardise; dividing by it would be Infinity.
      stats[field] = sd > 0 ? { m, sd } : null;
    }

    cohort.forEach((row, i) => {
      let sum = 0;
      for (const field of s.components) {
        const stat = stats[field];
        const value = parts[i][field];
        if (!stat || value == null) { row[s.field] = null; return; }
        sum += (value - stat.m) / stat.sd;
      }
      row[s.field] = curveScore(sum / s.components.length, Z_K);
    });
  }
}

/** Weighted mean of whichever sub-scores exist, renormalised over the weight
    actually present. Null when too little of it is. */
function weightedScore(parts, weights) {
  let total = 0;
  let present = 0;
  for (const [field, weight] of weights) {
    const value = parts[field];
    if (value == null) continue;
    total += value * weight;
    present += weight;
  }
  return present < SCORE_MIN_WEIGHT ? null : total / present;
}

/** Every indicator and every registered technical score for one series. Each
    indicator gates on its own window, so a short history yields a partial row
    rather than an empty one — 130 bars is enough for six-month momentum and RSI
    even though the twelve-month factors have nothing to say yet. */
function technicalsFor(series) {
  const c = series && series.c;
  /* The score fields come from the registry, so a newly registered technical
     score is computed here without this function being edited. */
  if (!c || !c.length) {
    const empty = { mom6m1m: null, mom12m1m: null, realisedVol: null, maxDD: null,
                    srDist: null, maGap: null, rsi14: null, rangePos: null,
                    combinedScore: null, bars: 0, ddBasis: PX_BASIS.NONE, ddCoverage: null };
    // Cross-sectional fields included: a caller that never runs the cohort pass
    // must still see null rather than `undefined`.
    for (const s of allScores()) {
      if (s.weights || s.crossSectional || s.derive) empty[s.field] = null;
    }
    return empty;
  }

  /* Carried on the row, not left for a caller to recompute. The drawdown is
     the one factor whose MEANING depends on which inputs it got, so the answer
     travels with the number — a row is copied into the assessment log, into
     the backtest and into the board, and a basis that had to be looked up
     separately would be dropped at the first of those. */
  const ddCoverage = intradayCoverage(series, DD_WINDOW);

  const row = {
    mom6m1m: momentum6m1m(c),
    mom12m1m: momentum12m1m(c),
    realisedVol: realisedVol(c),
    maxDD: maxDrawdown(c, DD_WINDOW, series.l, series.h),
    srDist: supportDistance(c),
    // Display only — demoted from the scoring model, still rendered.
    maGap: maGap(c),
    rsi14: rsi14(c),
    rangePos: rangePos(c),
    bars: c.length,
    /* Which regime this row's drawdown came from. `mixed` is the one that
       matters: neither the old quantity nor the new one. */
    ddBasis: c.length < DD_WINDOW ? PX_BASIS.NONE : ddCoverage.basis,
    ddCoverage: c.length < DD_WINDOW ? null : ddCoverage,
  };

  const parts = subScores(row);
  for (const s of allScores()) {
    /* A score that is neither a weighted mean nor a cohort statistic computes
       itself from the sub-scores. `derive` is checked first because it is the
       most specific: a score declaring one wants exactly that function. */
    if (s.derive) row[s.field] = s.derive(parts, row);
    else if (s.weights) row[s.field] = weightedScore(parts, SCORE_WEIGHTS[s.weights]);
    // Needs the whole cohort, so it stays null until applyCrossSectionalScores
    // runs over the set this row belongs to.
    else if (s.crossSectional) row[s.field] = null;
  }
  row.combinedScore = combine(...combinableFields().map((f) => row[f]));
  return row;
}

/** The plain average of the combinable domains, defined only when all exist.

    Both are 0–100 and both read the same way — higher is better — so the mean
    is in the same units as either one and buckets against the same thresholds.
    They are also nearly disjoint in what they look at: `long` is six-month
    trend and the 200-day line, `short` is 14-day RSI and position in the range.
    Averaging them is the point — one covers what the other is blind to.

    Falling back to whichever score exists would be the tempting shortcut and is
    wrong: it would file a name scored on trend alone into the same bucket as one
    scored on trend and entry together, and the bucket would stop meaning a
    single thing. A one-sided name is left out and counted instead. */
function combine(...scores) {
  if (!scores.length || scores.some((s) => s == null)) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/* Which domains the combined column averages. Declared in the registry, so a
   newly registered domain joins the comparison by saying `combinable: true` —
   and one on a different scale (the analyst rating is 1–5, not 0–100) stays
   out by saying nothing. */
const combinableFields = () => allScores().filter((s) => s.combinable).map((s) => s.field);

/** Whole days from one YYYY-MM-DD to another. */
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Why a symbol cannot be scored right now, or null if it can.

    Two ways a stored series lies about the present. A symbol the board cannot
    price has no live quote behind it — it has been delisted, halted or
    renamed, and Finnhub has stopped answering for it. And a series whose last
    bar is far behind the rest of the board stopped updating while everything
    else moved on, so its indicators describe a stock that no longer trades.

    Either way the numbers look current and are not. A delisted name whose last
    print was a takeover premium reads as 100% of its 52-week range forever. */
function priceUnusableReason(row, series, latest) {
  /* Checked first because it is the CAUSE and the others are symptoms. A name
     that has stopped being a registrant produces "no current quote" too, and
     reporting that instead says the quote is missing when what is missing is
     the company. */
  if (notRegistered(row.symbol)) return 'no longer an SEC registrant';
  if (row.price == null) return 'no current quote';
  if (!series || !series.c.length) return null;   // no history: partial row, handled below
  if (latest && series.t && daysBetween(series.t, latest) > PX_STALE_DAYS) {
    return `price history stops at ${series.t}`;
  }
  return null;
}

/** Attach indicators and scores to every watchlist row.

    Each symbol is scored entirely from its own price series, so nothing here
    depends on the rest of the board, the sector filter, the coverage threshold
    or how much of the backfill has finished. */
function applyTechnicals() {
  const { latest } = priceCalendar();

  /* One pass over every stored series, because the check is cohort-based: a
     series is judged against the others covering the same span, not on its own. */
  const gaps = seriesGaps(state.px.series);

  for (const row of state.rows.values()) {
    if (!state.symbolSet.has(row.symbol)) continue;

    const series = state.px.series.get(row.symbol);
    const reason = priceUnusableReason(row, series, latest) || gaps.get(row.symbol) || null;

    Object.assign(row, technicalsFor(reason ? null : series));

    /* Fundamentals come from filings rather than bars, so a stale price series
       does not invalidate them — but a market cap does need a current price, so
       a row with no usable price gets none either. Assigned before the score
       loop below reads the sub-scores. */
    Object.assign(row, fundamentalsFor(row.symbol, reason ? null : row.price));
    const fparts = subScores(row);
    for (const s of domain('fundamentals').scores) {
      row[s.field] = weightedScore(fparts, SCORE_WEIGHTS[s.weights]);
    }
    // Report what is stored either way — the bar count is how the row explains
    // itself when everything else in it is blank.
    row.bars = series && series.c ? series.c.length : 0;
    row.pxNote = reason;
    row.pxGap = gaps.has(row.symbol) ? gaps.get(row.symbol) : null;

    /* Annotation, not exclusion: the row keeps its numbers and carries what
       each factor reads without the offending bar. Only for series that were
       actually scored — an unusable series has nothing to annotate. */
    row.pxAnomaly = reason ? null : anomalyFor(series && series.c);

    /* Not a technical indicator, but this is the one pass where a row meets its
       price series, and the analyst domain has no pass of its own — it declares
       needsPrices: false precisely because its own data needs none. The flag is
       about the relationship between the two. */
    row.movedSince = movedSincePeriod(row, series);
  }

  /* The cohort for a cross-sectional score on the board is the watchlist, and
     it can only be standardised once every row has its own indicators — hence
     a second pass rather than a step inside the loop above. */
  applyCrossSectionalScores(
    [...state.rows.values()].filter((row) => state.symbolSet.has(row.symbol)));
}

// ── Backtest ────────────────────────────────────────────────────────

/** Shift a YYYY-MM-DD by whole months, UTC. */
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}

/** Index of the bar nearest `day` in a series, or null if `day` falls outside
    the range it covers.

    Interpolated, because only the first and last bar dates are stored — a
    bar's position is inferred from where its date sits between them. Trading
    days are near-uniform through the year, so the error is a bar or two across
    a two-year span, which does not move a bucket-level result. It also means a
    symbol whose history begins after `day` correctly returns null instead of
    being silently measured from its first bar. */
function barIndexOn(series, day) {
  const from = Date.parse(`${series.f}T00:00:00Z`);
  const to = Date.parse(`${series.t}T00:00:00Z`);
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(at)) return null;
  if (at < from || at > to) return null;
  if (to === from) return series.c.length - 1;
  return clamp(Math.round(((at - from) / (to - from)) * (series.c.length - 1)),
               0, series.c.length - 1);
}

/** Scores as they would have read on the bar at `endIndex`, computed from that
    bar and everything before it. Nothing after it is in scope. */
function technicalsAsOf(series, endIndex) {
  return technicalsFor({ c: series.c.slice(0, endIndex + 1) });
}

/** The span the stored history covers, across every symbol. */
function priceCalendar() {
  let earliest = null;
  let latest = null;
  for (const series of state.px.series.values()) {
    if (!earliest || series.f < earliest) earliest = series.f;
    if (!latest || series.t > latest) latest = series.t;
  }
  return { earliest, latest };
}

/** Start dates the stored history can actually support, newest first.

    The newest is one holding period back from the last bar, so every run has a
    complete forward window — a run measuring a part-elapsed period against
    full ones would flatter whichever bucket happened to be measured over less
    time. */
function backtestStartDays(holdMonths, spacingMonths) {
  const { earliest, latest } = priceCalendar();
  if (!earliest || !latest) return [];

  const days = [];
  let day = addMonths(latest, -holdMonths);
  /* Leave room for the LONGEST indicator window, not the shortest. The
     twelve-month factors need 253 bars before the start date, so a start date
     closer to the beginning than that scores only the short-window factors —
     the run appears, and the twelve-month columns and Combined are blank in it.

     At two years of history that cost one run out of a handful and the floor
     sat at one month. At ten it costs nothing worth having, and every start
     date the backtest offers can score every field. */
  const floor = addMonths(earliest, 10);
  while (day > floor && days.length < BACKTEST_MAX_RUNS) {
    days.push(day);
    day = addMonths(day, -spacingMonths);
  }
  return days;
}

/** One run: every symbol's score on `startDay`, against what it then did.

    Both scores are bucketed in the same pass — they come from one call to the
    indicators, so computing them separately would double the work for nothing. */
function backtestRun(startDay, holdMonths) {
  const exitDay = addMonths(startDay, holdMonths);
  /* Score and forward return for every symbol that has that score, kept until
     the end so the run can be cut into buckets both ways from one pass. Keyed
     off SCORE_FIELDS rather than written out, so a registry change cannot leave
     a field being collected into a bucket list that was never created. */
  const scored = Object.fromEntries(SCORE_FIELDS.map((f) => [f, []]));
  const result = {
    startDay,
    all: [],
    // Scored on one side only, so they are in a single-score bucket but not in
    // any combined one. This is why the combined view counts fewer symbols.
    oneSided: 0,
    // What the market did over the same window. Null when the benchmark has no
    // stored bars covering it — the backfill may not have reached it, or the
    // window may predate what the plan serves.
    bench: BENCHMARK ? seriesReturn(BENCHMARK, startDay, exitDay) : null,
    skipped: { noHistory: 0, tooEarly: 0, noForward: 0, noScore: 0 },
  };

  /* Collected first, scored second. A cross-sectional score needs the whole
     cohort for this start date before any of them can be standardised, so the
     loop below gathers and the pass after it scores. The cohort is this date's
     symbols and nothing later, which is what keeps it point-in-time. */
  const measured = [];

  for (const symbol of state.symbols) {
    const series = state.px.series.get(symbol);
    if (!series || !series.c.length) { result.skipped.noHistory++; continue; }

    const start = barIndexOn(series, startDay);
    if (start == null) { result.skipped.tooEarly++; continue; }

    /* Both ends located the same way, so the holding period is a true calendar
       period in this symbol's own series. Converting months to a fixed bar
       count instead would assume ~252 trading days a year, and quietly overrun
       the end of any series that is short of that — a halted name, or one the
       backfill has not finished. */
    const exit = barIndexOn(series, exitDay);
    if (exit == null || exit <= start) { result.skipped.noForward++; continue; }

    const entry = series.c[start];
    if (!entry) { result.skipped.noForward++; continue; }

    /* Skip only a symbol that scored on NOTHING. Naming the scores here was a
       latent coupling to the old two-score registry — when those two were
       replaced the guard went on testing fields that no longer exist, read
       null for every symbol, and emptied every run. Derived from SCORE_FIELDS
       like the rest of this function, it cannot go stale that way again. */
    measured.push({ symbol, past: technicalsAsOf(series, start),
                    ret: (series.c[exit] / entry - 1) * 100 });
  }

  applyCrossSectionalScores(measured.map((m) => m.past));

  for (const { symbol, past, ret } of measured) {
    if (SCORE_FIELDS.every((f) => past[f] == null)) { result.skipped.noScore++; continue; }

    result.all.push(ret);
    if (past.combinedScore == null) result.oneSided++;

    for (const field of SCORE_FIELDS) {
      const score = past[field];
      // The symbol rides along so a bucket can be capped by sector, and so the
      // bucket's own return path can be rebuilt for its Sharpe.
      if (score != null) scored[field].push({ score, ret, symbol });
    }
  }

  const cap = state.sectorCap || 0;
  /* Risk figures per bucket, not just the mean return. A raw return says how a
     bucket did; it cannot evaluate a factor whose whole claim is about
     risk-adjusted return — which is exactly what the low-volatility anomaly
     claims. Measured over the holding window, so they answer "what would
     holding this bucket have felt like", not "what did it end at". */
  const withRisk = (buckets) =>
    buckets.map((b) => ({ ...b, ...portfolioStats(b.symbols, startDay, exitDay) }));

  for (const field of SCORE_FIELDS) {
    result[field] = {
      [BUCKETING.BANDS]: withRisk(bandBuckets(scored[field], cap)),
      [BUCKETING.QUINTILES]: withRisk(quintileBuckets(scored[field], cap)),
      n: scored[field].length,
    };
  }

  // The benchmark on the same footing, or there is nothing to read a Sharpe against.
  result.benchStats = BENCHMARK ? portfolioStats([BENCHMARK], startDay, exitDay) : null;

  return result;
}

/* Risk-free rate for the Sharpe ratio, annualised percent. Zero, and declared
   rather than assumed: the app stores no rate series, and inventing a constant
   would shift every score's Sharpe by the same amount without changing their
   ORDER, which is what the backtest actually compares. Read these as
   excess-over-zero, not as a number to quote against a fund's. */
const RISK_FREE_ANNUAL = 0;

/** Equal-weighted daily return path for a set of symbols over one window.

    Rebalanced daily, which is the simplest defensible convention and the one
    that matches equal-weighted buckets — a buy-and-hold path would drift toward
    whichever names ran, and stop describing the bucket that was selected.

    Legs are truncated to the shortest, because a symbol whose series ends early
    would otherwise shorten the average silently partway through. */
function portfolioReturns(symbols, startDay, exitDay) {
  const legs = [];
  for (const symbol of symbols || []) {
    const series = state.px.series.get(symbol);
    if (!series || !series.c.length) continue;

    const start = barIndexOn(series, startDay);
    const exit = barIndexOn(series, exitDay);
    if (start == null || exit == null || exit <= start) continue;

    const rets = [];
    for (let i = start + 1; i <= exit; i++) {
      const prev = series.c[i - 1];
      if (!prev) { rets.length = 0; break; }
      rets.push(series.c[i] / prev - 1);
    }
    if (rets.length) legs.push(rets);
  }
  if (!legs.length) return [];

  const days = Math.min(...legs.map((r) => r.length));
  const path = [];
  for (let d = 0; d < days; d++) {
    let sum = 0;
    for (const leg of legs) sum += leg[d];
    path.push(sum / legs.length);
  }
  return path;
}

/** Annualised return, annualised volatility and Sharpe for one bucket.

    Nulls rather than zeros when the window is too short to say anything: a
    bucket nothing landed in has no volatility, and reporting 0 would rank it
    as the safest thing on the board. */
function portfolioStats(symbols, startDay, exitDay) {
  const path = portfolioReturns(symbols, startDay, exitDay);
  if (path.length < 2) return { annReturn: null, vol: null, sharpe: null, days: path.length };

  const m = path.reduce((a, b) => a + b, 0) / path.length;
  let sq = 0;
  for (const r of path) sq += (r - m) * (r - m);
  const sd = Math.sqrt(sq / (path.length - 1));

  const annReturn = m * TRADING_DAYS * 100;
  const vol = sd * Math.sqrt(TRADING_DAYS) * 100;
  return { annReturn, vol, days: path.length,
           sharpe: vol > 0 ? (annReturn - RISK_FREE_ANNUAL) / vol : null };
}

/** Score-and-return pairs sorted into the fixed bands. */
function bandBuckets(entries, cap = 0) {
  const held = BACKTEST_BUCKETS.map((b) => ({ ...b, entries: [] }));
  for (const e of entries) {
    const bucket = held.find((b) => e.score >= b.min && e.score < b.max);
    if (bucket) bucket.entries.push(e);
  }
  return held.map(({ entries: es, ...b }) => {
    const kept = capPerSector(es, cap);
    // Symbols ride along so the bucket's own return path can be rebuilt for its
    // risk figures — the returns array alone cannot say what it held.
    return { ...b, returns: kept.map((e) => e.ret), symbols: kept.map((e) => e.symbol),
             capped: es.length - kept.length };
  });
}

/** The same pairs cut into five equal groups by rank, best score first.

    Sizes differ by at most one symbol, so a spread taken across these is a
    like-for-like comparison whichever score produced the ranking. Ties are
    split by position rather than kept together — the scores are continuous, so
    an exact tie is a curiosity, and honouring it would give up the equal sizes
    that are the whole reason for ranking. */
function quintileBuckets(entries, cap = 0) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const n = sorted.length;
  return QUINTILE_LABELS.map((label, i) => {
    /* The fifths are cut BEFORE the cap, so the cap does not decide which
       bucket a name belongs to — only which of that bucket's names count. */
    const group = sorted.slice(Math.round((i * n) / 5), Math.round(((i + 1) * n) / 5));
    const kept = capPerSector(group, cap);
    return { label, returns: kept.map((e) => e.ret), symbols: kept.map((e) => e.symbol),
             capped: group.length - kept.length };
  });
}

/** One symbol's return between two calendar days, from its stored series.

    Located exactly the way a bucketed symbol's return is — both ends through
    `barIndexOn`, on the symbol's own series — so a bucket and the benchmark are
    measured over the same span by the same method, and the difference between
    them is not an artefact of two different lookups. */
function seriesReturn(symbol, startDay, exitDay) {
  const series = state.px.series.get(symbol);
  if (!series || !series.c.length) return null;

  const start = barIndexOn(series, startDay);
  const exit = barIndexOn(series, exitDay);
  if (start == null || exit == null || exit <= start) return null;

  const entry = series.c[start];
  return entry ? (series.c[exit] / entry - 1) * 100 : null;
}

/** Top bucket's average return minus the bottom bucket's, for one run.

    This is the single number that says whether a score ranked that period at
    all. Positive means the names it liked most beat the names it liked least.
    Negative is an **inversion** — the ranking ran backwards over that window,
    which is the thing the combined column exists to be tested against.

    Null when either end is empty: a spread against a bucket nothing landed in
    would be an artefact of the thresholds, not a result. */
function bucketSpread(buckets) {
  const top = mean(buckets[0].returns);
  const bottom = mean(buckets[buckets.length - 1].returns);
  return top == null || bottom == null ? null : top - bottom;
}

/** Every run for the current settings. Cached on the settings that produced
    it, so switching tabs does not recompute anything — every field in
    SCORE_FIELDS is bucketed in the same pass. */
function backtestRuns() {
  const { months, spacing } = state.backtest;
  const key = `${months}|${spacing}|${state.px.series.size}|${state.symbols.length}|${state.sectorCap || 0}`;
  if (state.backtest.cacheKey === key) return state.backtest.cache;

  const runs = backtestStartDays(months, spacing).map((day) => backtestRun(day, months));
  state.backtest.cacheKey = key;
  state.backtest.cache = runs;
  return runs;
}

// ── Consensus math ──────────────────────────────────────────────────

/** One month's ratings as { raw, analysts, sd }, or null if nobody covers it. */
function distribution(rec) {
  if (!rec) return null;

  let analysts = 0;
  let weighted = 0;
  for (const b of BUCKETS) {
    const n = Number(rec[b.field]) || 0;
    analysts += n;
    weighted += n * b.weight;
  }
  if (!analysts) return null;

  const raw = weighted / analysts;

  // Population standard deviation over the 1–5 rating scale.
  let variance = 0;
  for (const b of BUCKETS) {
    const n = Number(rec[b.field]) || 0;
    variance += n * (b.weight - raw) ** 2;
  }

  return { raw, analysts, sd: Math.sqrt(variance / analysts) };
}

/** Pull the mean toward PRIOR; the fewer the analysts, the harder the pull.
    `m` is exposed so a caller can score the same data at a different shrink
    strength — useful for comparing tunings without refetching. */
function shrink(raw, analysts, m = SHRINK_M) {
  return (raw * analysts + PRIOR * m) / (analysts + m);
}

/** "2024-05-01" → months since year 0, for gap arithmetic. */
function monthIndex(period) {
  const [y, m] = String(period ?? '').split('-').map(Number);
  return Number.isFinite(y) && Number.isFinite(m) ? y * 12 + (m - 1) : null;
}

/** The trend record closest to MOMENTUM_LOOKBACK months before the newest one,
    among those at least MOMENTUM_MIN_BACK months old.

    HONEST NOTE ON WHAT THIS ACTUALLY DOES TODAY. Finnhub returns exactly four
    consecutive months for every symbol on this board — measured 2026-09-01,
    575 of 575 — so the candidates are always the record 2 months back (gap 1
    from the 3-month target) and the one 3 months back (gap 0). The second
    always wins. **The selection has never once selected anything: it returns
    the oldest of the four, deterministically, for every symbol.**

    The search is kept rather than replaced with `trend[3]` because it is the
    only thing that would cope if the provider ever returned a sparse or longer
    history — and because the alternative, hard-coding an index, would break
    silently rather than adapt. But it must not be read as adaptive behaviour
    that is happening. It is dormant.

    Nor is the 3-month lookback it aims for real. Consensus is sticky: 74% of
    symbols carry a duplicate consecutive month and 42% have a head identical to
    the month before, so the genuine separation between this record and the head
    averages **1.72 months, not 3**. See docs/NOTES.md, "The analyst window is
    1.72 months, not 3". */
const MOMENTUM_MIN_BACK = 2;   // months; anything nearer reads as noise, not drift

function baseline(trend) {
  const head = monthIndex(trend[0]?.period);
  if (head == null) return null;

  let best = null;
  let bestGap = Infinity;
  for (const rec of trend.slice(1)) {
    const idx = monthIndex(rec.period);
    if (idx == null) continue;
    const back = head - idx;
    if (back < MOMENTUM_MIN_BACK) continue;
    const gap = Math.abs(back - MOMENTUM_LOOKBACK);
    if (gap < bestGap) {
      bestGap = gap;
      best = rec;
    }
  }
  return best;
}

/** Full scoring for a symbol's recommendation history (newest record first).
    `upside` is the fractional gap to the mean analyst price target (0.15 = +15%),
    or null when no target is available. */
function rate(trend, upside = null, m = SHRINK_M) {
  const now = distribution(trend?.[0]);
  if (!now) return null;

  const baseRec = baseline(trend || []);
  const prev = distribution(baseRec);

  const level = shrink(now.raw, now.analysts, m);
  const momentum = prev ? level - shrink(prev.raw, prev.analysts, m) : null;
  const agreement = clamp(1 - now.sd / MAX_SD, 0, 1);

  // Both terms adjust the level rather than being averaged with it. A name with
  // no usable baseline simply gets no momentum adjustment — nothing to redistribute.
  const momentumAdj = momentum == null
    ? 0
    : clamp(momentum, -MOMENTUM_CAP, MOMENTUM_CAP) * MOMENTUM_MULT;
  const agreementAdj = (agreement - AGREEMENT_PIVOT) * AGREEMENT_MULT;

  // Price-target upside, used directly and clamped. Missing targets contribute
  // nothing rather than penalising a name for an endpoint we could not read.
  const upsideAdj = upside == null ? 0 : clamp(upside, -UPSIDE_CAP, UPSIDE_CAP);

  // Kept unclamped as well, so the detail panel's breakdown still adds up and
  // can say when the clamp bound the result.
  const compositeUnclamped = level + momentumAdj + agreementAdj + upsideAdj;
  const composite = clamp(compositeUnclamped, COMPOSITE_MIN, COMPOSITE_MAX);

  return {
    raw: now.raw,
    analysts: now.analysts,
    sd: now.sd,
    level,
    momentum,
    agreement,
    upside,
    momentumAdj,
    agreementAdj,
    upsideAdj,
    compositeUnclamped,
    composite,
    coverageChange: prev ? now.analysts - prev.analysts : null,
    baselinePeriod: prev ? baseRec.period : null,
  };
}

/** Label reflects the raw, unshrunk mean — what the analysts actually said. */
function consensusLabel(score) {
  if (score >= 4.5) return { text: 'Strong Buy',  cls: 's5' };
  if (score >= 3.5) return { text: 'Buy',         cls: 's4' };
  if (score >= 2.5) return { text: 'Hold',        cls: 's3' };
  if (score >= 1.5) return { text: 'Sell',        cls: 's2' };
  return              { text: 'Strong Sell', cls: 's1' };
}

const CLS_VAR = { s5: '--r5', s4: '--r4', s3: '--r3', s2: '--r2', s1: '--r1' };

// ── Formatting ──────────────────────────────────────────────────────

const fmtNum = (n, d = 2) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtPct = (n) => (n == null || Number.isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);

/** Signed to a fixed precision, for adjustments that read as ± contributions. */
const fmtSigned = (n, d = 2) =>
  (n == null || Number.isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}`);

function fmtCap(millions) {
  if (!millions) return '—';
  if (millions >= 1e6) return `$${(millions / 1e6).toFixed(2)}T`;
  if (millions >= 1e3) return `$${(millions / 1e3).toFixed(1)}B`;
  return `$${Math.round(millions)}M`;
}

/** "2024-05-01" → "May 2024" */
function fmtPeriod(period) {
  if (!period) return '—';
  const d = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);


// ── Data loading ────────────────────────────────────────────────────

/** Assemble a board row. Returns null when the symbol has no analyst coverage
    — callers drop those silently rather than rendering a dead row. */
function buildRow(symbol, quote, rawTrend, fetchedAt, target = null, insider = null) {
  const trend = (Array.isArray(rawTrend) ? rawTrend : [])
    .slice()
    .sort((a, b) => String(b.period).localeCompare(String(a.period)));

  const price = Number.isFinite(quote?.c) && quote.c !== 0 ? quote.c : null;

  // Upside needs both a target and a live price to divide by.
  const targetMean = Number.isFinite(target?.targetMean) && target.targetMean > 0
    ? target.targetMean
    : null;
  const upside = targetMean != null && price != null ? (targetMean - price) / price : null;

  const scores = rate(trend, upside);
  if (!scores) return null;

  const latest = trend[0] || null;

  return {
    symbol,
    name: UNIVERSE_NAMES.get(symbol) || symbol,
    sector: UNIVERSE_SECTORS.get(symbol) || 'Other',
    profile: null,            // fetched lazily when the row is opened
    quote: quote || {},
    fetchedAt,
    target,
    targetMean,
    targetHigh: Number.isFinite(target?.targetHigh) ? target.targetHigh : null,
    targetLow: Number.isFinite(target?.targetLow) ? target.targetLow : null,
    upside,
    insider,
    /* The sortable column is the OFFICER figure alone. Sorting on a combined
       number would rank FANG by a $2B stake rebalance sitting in a column
       headed "Insider", which is what this split exists to stop. */
    insiderNet: insider ? insider.officer.net : null,
    insiderHolderNet: insider ? insider.holder.net : null,
    price: Number.isFinite(quote.c) && quote.c !== 0 ? quote.c : null,
    changePct: Number.isFinite(quote.dp) ? quote.dp : null,
    // Flattened onto the row so the sort comparator can address them directly.
    composite:      scores?.composite ?? null,
    raw:            scores?.raw ?? null,
    level:          scores?.level ?? null,
    momentum:       scores?.momentum ?? null,
    agreement:      scores?.agreement ?? null,
    momentumAdj:    scores?.momentumAdj ?? null,
    agreementAdj:   scores?.agreementAdj ?? null,
    upsideAdj:      scores?.upsideAdj ?? null,
    compositeUnclamped: scores?.compositeUnclamped ?? null,
    sd:             scores?.sd ?? null,
    analysts:       scores?.analysts ?? null,
    coverageChange: scores?.coverageChange ?? null,
    baselinePeriod: scores?.baselinePeriod ?? null,
    latest,
    trend,
    loaded: true,
  };
}

/** Show whatever the cache holds for a symbol, however old it is, and report
    whether anything still needs fetching.

    Those are two separate questions and this used to answer them with one
    early return: a stale quote sent the symbol back before `state.rows` was
    touched, so "this price needs refreshing" and "there is nothing to draw"
    were the same state. The row then vanished for the length of the refetch —
    which is a blank board for ~10 minutes across 579 names, rather than an
    hour-old price sitting there greyed out until the new one lands.

    An entry with a stale part still has something to render. `fetchedAt`
    carries its age to commonCellsHTML, which greys any price past
    PRICE_STALE_MS, so an old row is visibly old rather than absent.

    Returns true when no network call is needed for this symbol. */
function loadFromCache(symbol, quoteTtl) {
  const { entry, quoteFresh, trendFresh, targetFresh, insiderFresh } = cacheState(symbol, quoteTtl);
  if (!entry) return false;

  const { quote, trend, at, target, insider } = decodeEntry(entry);
  const row = buildRow(symbol, quote, trend, at, target, insider);

  // Complete only if every part is fresh — or, for the optional two, off the plan.
  const complete = quoteFresh && trendFresh
    && (!PLAN.priceTarget || targetFresh) && (!PLAN.insider || insiderFresh);

  if (row) state.rows.set(symbol, row);
  // Cached as "no coverage" — a valid cached answer, but only count it as
  // dropped if we are done with this symbol. Counting here *and* again in
  // fetchSymbol double-reported every uncovered name in the header.
  else if (complete) state.dropped++;

  return complete;
}

/** Reorder a fetch queue so the rows on screen are fetched first.

    The queue is otherwise the watchlist's own order, which has nothing to do
    with how the board is sorted or where it is scrolled. At 55 calls a minute
    the far end of a 579-name queue is ten minutes away, so the names actually
    being read should not be at it.

    Three tiers: visible, rendered but scrolled off, then everything the
    current filters, thresholds or sector cap keep off the board entirely.
    Falls back to the given order wherever there is no DOM to measure. */
function prioritiseOnScreen(symbols) {
  if (symbols.length < 2) return symbols;

  const wanted = new Set(symbols);
  const onScreen = [];
  const offScreen = [];

  let trs = [];
  try {
    trs = [...document.querySelectorAll('#board-body tr[data-symbol]')];
  } catch {
    trs = [];
  }

  const height = window.innerHeight || 0;
  for (const tr of trs) {
    const symbol = tr.dataset.symbol;
    if (!wanted.has(symbol)) continue;
    const box = tr.getBoundingClientRect();
    (box.bottom > 0 && box.top < height ? onScreen : offScreen).push(symbol);
  }

  const placed = new Set([...onScreen, ...offScreen]);
  return [...onScreen, ...offScreen, ...symbols.filter((s) => !placed.has(s))];
}

/** Call an optional (premium) endpoint. A 403 disables it for the session and
    resolves to null, so a plan restriction never aborts the load. `note` says
    what the user will see instead, since not every optional endpoint backs a
    board column. */
async function fetchOptional(path, params, flag, label, note = 'that column will stay empty', ttl = 0) {
  if (!PLAN[flag]) return null;
  try {
    return await get(path, params, ttl);
  } catch (err) {
    /* `err.proxy` marks a refusal from serve.mjs rather than an answer from
       Finnhub, and the difference matters more here than anywhere else. Since
       the key moved to the server, a server started without FINNHUB_API_KEY
       fails every call — including these — and a 503 read as a 403 would write
       "not on your plan" into localStorage for all three premium endpoints, for
       a week, on an account that has them. The flag is a fact about the
       account, so only the account may set it. */
    if (!err.proxy && (err.status === 403 || err.status === 401)) {
      PLAN[flag] = false;
      persistPlan();   // so the next load does not re-probe the whole board
      if (!PLAN.warned[flag]) {
        PLAN.warned[flag] = true;
        toast(`${label} are not available on your Finnhub plan — ${note}.`);
      }
    }
    return null;
  }
}

/* Form 4 transaction codes. Only open-market trades say anything about
   conviction: A (grant), M (option exercise), F (shares withheld for tax) and
   G (gift) are compensation mechanics and would otherwise read as "buying". */
const OPEN_MARKET_CODES = new Set(['P', 'S']);

/* A Form 4 filer is an officer, a director, or a beneficial owner of more than
   10% — and the last of those means something entirely different from the first
   two. An officer selling is a judgement about the company. A 26% holder
   trimming a stake is portfolio mechanics, and it can be a hundred times larger
   than every officer trade combined.

   MEASURED: FANG's −10,177,667 share "net insider activity" is 98.3% ONE
   filing — 10,000,000 shares at $204.25, about $2.04B, by a filer who still
   held 74,036,722 shares afterwards, a quarter of the company. The other 18
   open-market trades total −178k. Summing those into one number and rendering
   it "▼ selling" reports a rebalancing as if it were nineteen insiders losing
   faith. */
const HOLDER_THRESHOLD = 0.10;

/** Split open-market insider activity by filer type.

    Finnhub's payload carries NO role field — the columns are name, share,
    change, dates, code, price, id, symbol, source, isDerivative, currency — so
    the classification is INFERRED from post-transaction holding against shares
    outstanding. That works cleanly at the boundary this cares about: on a
    sample of five symbols the largest non-holder position was 1.64% (MRNA's
    chief executive) and FANG's block filer was 26.44%. Nothing sits near 10%,
    so the threshold is not doing delicate work.

    Without a share count nothing can be classified, and those rows go to
    `unknown` rather than being assumed to be officers. Guessing here would
    reintroduce the exact conflation this function exists to remove. */
function summariseInsider(payload, sharesOutstanding = null) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const blank = () => ({ net: null, bought: 0, sold: 0, trades: 0 });
  const out = { officer: blank(), holder: blank(), unknown: blank() };

  for (const r of rows) {
    const code = String(r.transactionCode ?? '').trim().toUpperCase();
    if (!OPEN_MARKET_CODES.has(code)) continue;
    const change = Number(r.change);
    if (!Number.isFinite(change)) continue;

    const held = Number(r.share);
    const bucket = !(sharesOutstanding > 0) || !Number.isFinite(held)
      ? out.unknown
      : (held / sharesOutstanding) >= HOLDER_THRESHOLD ? out.holder : out.officer;

    bucket.trades++;
    if (change > 0) bucket.bought += change;
    else bucket.sold += -change;
  }

  // No qualifying trades is different from a net of zero across many trades.
  for (const g of Object.values(out)) {
    if (g.trades) g.net = g.bought - g.sold;
  }
  return out;
}

/** Fetch the stale parts of one symbol and merge them with whatever is cached.
    Throws only on core-endpoint failures, so the caller can still tell a key or
    rate problem from a symbol that simply has no data. */
async function fetchSymbol(symbol, quoteTtl) {
  const { entry, quoteFresh, trendFresh, targetFresh, insiderFresh } = cacheState(symbol, quoteTtl);
  const cached = entry ? decodeEntry(entry) : null;

  const jobs = [
    quoteFresh
      ? Promise.resolve(null)
      : get('/quote', { symbol }, 0),
    trendFresh
      ? Promise.resolve(null)
      : get('/stock/recommendation', { symbol }, 0),
    targetFresh
      ? Promise.resolve(null)
      : fetchOptional('/stock/price-target', { symbol }, 'priceTarget', 'Price targets'),
    insiderFresh
      ? Promise.resolve(null)
      : fetchOptional('/stock/insider-transactions', {
          symbol,
          from: isoDay(Date.now() - INSIDER_LOOKBACK_DAYS * 86_400_000),
          to: isoDay(Date.now()),
        }, 'insider', 'Insider transactions'),
  ];

  const [rawQuote, rawTrend, rawTarget, rawInsider] = await Promise.all(jobs);

  // A skipped job resolves to null; a fetched one can legitimately be empty
  // (`[]` = no coverage), so presence, not emptiness, decides what to cache.
  const quote = rawQuote || cached?.quote || {};
  const trend = rawTrend ? (Array.isArray(rawTrend) ? rawTrend : []) : cached?.trend || [];

  /* The share count comes from the SEC filings already stored, not from a
     second network call. It is the same figure the fundamentals use, so it
     carries the same freshness gate — a count older than SHARES_MAX_AGE_DAYS
     yields no classification and the trades land in `unknown`, which is the
     right answer rather than a stale denominator. */
  const shareFact = state.fx.facts.get(symbol)?.f ? fxLatest(state.fx.facts.get(symbol).f.shares) : null;
  const shareAgeDays = shareFact
    ? (Date.now() - Date.parse(`${shareFact.e}T00:00:00Z`)) / 86400000 : Infinity;
  const sharesOut = shareFact && shareFact.v > 0 && shareAgeDays <= SHARES_MAX_AGE_DAYS
    ? shareFact.v : null;

  const insiderSummary = rawInsider ? summariseInsider(rawInsider, sharesOut) : null;

  const patch = {};
  /* A quote refetch overwrites `at`, which is ALSO the trend's fetch time on
     entries written before `tAt` existed. Pin the trend's real age before that
     happens: Refresh now refetches quotes on their own, so without this a
     legacy entry's 7-day trend TTL would be pushed forward by every Refresh and
     the trend would never expire. */
  if (rawQuote && entry?.t && entry.tAt === undefined) patch.tAt = entry.at;
  if (rawQuote) Object.assign(patch, encodeQuote(quote));
  if (rawTrend) {
    Object.assign(patch, encodeTrend(trend));
    // The cache holds four months and rolls; the archive keeps them forever.
    archiveTrend(symbol, trend);
  }
  if (rawTarget) Object.assign(patch, encodeTarget(rawTarget));
  if (insiderSummary) Object.assign(patch, encodeInsider(insiderSummary));
  if (Object.keys(patch).length) writeEntry(symbol, patch);

  const target = rawTarget
    ? { targetMean: rawTarget.targetMean, targetHigh: rawTarget.targetHigh, targetLow: rawTarget.targetLow }
    : cached?.target || null;
  const insider = insiderSummary || cached?.insider || null;

  // fetchedAt is the price's as-of time, so only a refetched quote advances it.
  const row = buildRow(symbol, quote, trend, rawQuote ? Date.now() : cached?.at, target, insider);
  if (row) {
    state.rows.set(symbol, row);
    logHistory(row);          // flushed by the caller, in batches
  } else {
    state.dropped++;
  }
  return row;
}

/** Load the whole watchlist: cache first, then the rest in paced batches.

    `quoteTtl` is threaded down to cacheState so a caller can decide how old a
    cached price may be. Omitted, it is the 24h store TTL. */
async function loadAll({ quoteTtl } = {}) {
  if (!state.finnhub.ready || state.loading) return;

  state.loading = true;
  state.cancelled = false;
  state.dropped = 0;
  state.rows.clear();

  /* Reset before pass 1, so an offset in the 429 report is measured from the
     start of THIS run rather than from whenever the page happened to load. */
  runStartedAt = Date.now();
  rate429.count = 0;
  rate429.firstOffsetMs = -1;
  rate429.lastOffsetMs = -1;
  rate429.windowAtFirst = -1;

  /* Pass 1 — draw everything the cache holds, fresh or not. No API calls, so
     the board is complete and readable immediately; pass 2 then replaces the
     stale prices in place rather than filling in blanks. */
  const stale = [];
  let pendingCalls = 0;
  for (const symbol of state.symbols) {
    if (loadFromCache(symbol, quoteTtl)) continue;
    stale.push(symbol);
    pendingCalls += pendingCallsFor(symbol, quoteTtl);
  }

  state.progress = {
    done: state.symbols.length - stale.length,
    total: state.symbols.length,
    fetched: 0,
    // Average cost of the symbols actually being fetched, for the ETA.
    callsPerRow: stale.length ? pendingCalls / stale.length : callsPerSymbol(),
  };
  renderBoard();
  renderProgress();

  /* Ordered after the render, so it measures the board the user is looking at
     — on a cold start there are no rows to measure and the watchlist order
     stands. */
  const queue = prioritiseOnScreen(stale);

  // Pass 2 — fetch the stale remainder in batches, nearest the eye first.
  let failure = null;
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    if (state.cancelled) break;

    const batch = queue.slice(i, i + BATCH_SIZE);
    const callsBefore = state.callsMade;
    const results = await Promise.allSettled(batch.map((symbol) => fetchSymbol(symbol, quoteTtl)));

    for (const result of results) {
      state.progress.done++;
      if (result.status === 'rejected') {
        // A symbol Finnhub does not recognise returns empty data, not an error,
        // so anything landing here is an API-level problem worth surfacing once.
        failure = failure || result.reason;
        state.dropped++;
      } else {
        state.progress.fetched++;
      }
    }

    // Abandon the run on an auth failure — every remaining call would fail too.
    if (failure && (failure.status === 401 || failure.status === 403)) break;

    persistHistory();
    renderBoard();
    renderProgress();

    /* Pace only when the batch actually spent calls. A batch served entirely
       from cache — or one whose endpoints are all off-plan — has nothing to
       rate-limit against, and sleeping through it added minutes of dead time
       to a load that made no requests at all. */
    if (i + BATCH_SIZE < queue.length && state.callsMade > callsBefore) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  state.loading = false;
  persistHistory();
  renderBoard();
  renderProgress();
  reportRateLimits();

  if (failure) {
    toast(failure.message);
    /* A proxy refusal is not a rejected key, and must not send the user to a
       gate that tells them to check one. */
    if (!failure.proxy && (failure.status === 401 || failure.status === 403)) {
      state.finnhub = { checked: true, ready: false, message: failure.message };
      showKeyGate(failure.message, 'fail');
    }
  }

  /* A refetch builds a new row object, which drops the lazily-fetched profile
     and candles. Re-request them, or the open panel keeps saying "loading"
     forever with nothing in flight. Both are cached, so this usually costs
     nothing. */
  if (state.selected) {
    renderDetail(state.selected);
    ensureProfile(state.selected);
    ensureDetailData(state.selected);
  }
}

// ── Rendering: progress ─────────────────────────────────────────────

const ALL_SECTORS = 'All sectors';

function renderProgress() {
  const bar = $('#progress');
  const { done, total, callsPerRow } = state.progress;

  if (!state.loading) {
    bar.hidden = true;
    renderBoardMeta();
    return;
  }

  const remaining = Math.max(0, total - done);
  const seconds = estimateSeconds(remaining * (callsPerRow ?? callsPerSymbol()));
  const eta = seconds > 90 ? `~${Math.ceil(seconds / 60)} min left` : `~${seconds}s left`;

  $('#progress-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#progress-text').textContent = `Loading ${done} / ${total} · ${eta}`;
  bar.hidden = false;
  renderBoardMeta();
}

/** The backfill's own progress bar, separate from the Finnhub load's — the two
    run against different providers and can overlap. */
function renderPxProgress() {
  const bar = $('#px-progress');
  if (!bar) return;

  const { running, done, total, failed } = state.px;
  $('#px-start').hidden = running;
  $('#px-cancel').hidden = !running;

  if (!running) {
    bar.hidden = true;
    return;
  }

  const remaining = Math.max(0, total - done);
  // Polygon's free plan is metered per minute, so the wait is arithmetic.
  const minutes = Math.ceil(remaining / PROVIDER_BY_ID.get('polygon').rate.calls);
  const eta = minutes >= 60
    ? `~${Math.floor(minutes / 60)}h ${minutes % 60}m left`
    : `~${minutes} min left`;

  $('#px-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#px-text').textContent =
    `Price history ${done} / ${total} · ${eta}${failed ? ` · ${failed} failed` : ''}`;
  bar.hidden = false;
}

/** Switch the board between the analyst and technical column sets. */
/** The domain tabs, one per registered entry. Built rather than written, so a
    new domain gets a tab by existing. */
/** The active section's own controls. Rendered from the registry, so a domain
    that declares one gets it on its tab and only on its tab. */
function renderSectionControls() {
  const host = $('#section-controls');
  if (!host) return;
  host.innerHTML = sectionControls().map((c) => `<label class="filter-label"
      for="ctl-${esc(c.id)}" title="${esc(c.title)}">${esc(c.label)}
      <input id="ctl-${esc(c.id)}" class="num-input" type="number"
             data-control="${esc(c.id)}"
             min="${c.min}" max="${c.max}" step="${c.step}"
             value="${state.controls[c.id]}">
    </label>`).join('');
}

function renderModeTabs() {
  const host = $('#board-modes');
  if (!host) return;

  const overallTab = () => {
    const active = isOverall(state.boardMode);
    /* A visible marker, not just a tooltip. Once any input is cohort-relative
       the whole number is, and a reader comparing yesterday's Overall to
       today's has no way to know that from the number itself. */
    const relative = overallScores().some((s) => s.crossSectional);
    const title = `Every symbol ranked by the mean of ${
      overallScores().map((s) => plainLabel(s.label)).join(' and ')}, each normalised to 0–100.${
      relative ? ' Relative: at least one input is cross-sectional, so this ranks names against'
        + ' each other on this board today and cannot be compared across days or watchlists.' : ''}`;
    return `<button class="tab tab-overall${active ? ' tab-active' : ''}" type="button" role="tab"
        data-mode="${OVERALL}" aria-selected="${active}"
        title="${esc(title)}">Overall${
      relative ? '<span class="rel-tag" aria-label="relative to this board">rel</span>' : ''}</button>`;
  };

  host.innerHTML = overallTab() + SCORE_DOMAINS.map((d) => {
    const s = primaryScore(d);
    const active = state.boardMode === d.id;
    return `<button class="tab${active ? ' tab-active' : ''}" type="button" role="tab"
        data-mode="${esc(d.id)}" aria-selected="${active}"
        title="${esc(`${d.label} — ${plainLabel(s.label)} is ${s.status}. ${d.blurb}`)}">${esc(d.label)}<span
        class="status-dot status-${esc(rules(s).tag)}" aria-hidden="true"></span></button>`;
  }).join('');
}

function setBoardMode(mode) {
  if (state.boardMode === mode || !sectionIds().includes(mode)) return;
  state.boardMode = mode;
  localStorage.setItem(LS.boardMode, mode);

  renderModeTabs();
  /* Overall depends on every domain, so it wants the price data too. */
  const wantsPrices = isOverall(mode) || domain(mode).needsPrices;
  $('#px-controls').hidden = !wantsPrices;

  showView(VIEW.BOARD);

  /* Arriving at a section whose prices are missing is the moment the backfill
     is actually wanted, so start it. It paces itself at 5 calls a minute and
     can be stopped from the bar it puts on screen. */
  if (wantsPrices && state.provKeys.polygon
      && !state.px.running && state.symbols.some(needsPrices)) {
    backfillPrices();
  }
}

/** How many of `rows` carry the score the board is actually ranked by, asked of
    the registry rather than of a field name.

    This counted `r.longScore` and `r.shortScore` until the 2026-08-31 factor
    restructure retired both. The fields stopped existing, `!= null` was false
    every time, and the meta line went on rendering "0 scored long · 0 short" —
    silently, because a zero is a plausible number. Same failure as the old
    `backtestRun` guard; docs/NOTES.md draws the rule from it.

    Split out of renderBoardMeta so that rule is testable: the bug lived in a
    function the tests could not call, which is why it survived the restructure
    that caused it. */
function coverageNote(dom, rows) {
  const head = primaryScore(dom);
  const scored = rows.filter((r) => r[head.field] != null).length;
  return `${scored} scored ${plainLabel(head.label)}`;
}

function renderBoardMeta(count) {
  const shown = count ?? sortedRows().length;
  const parts = [`${shown} shown`];

  /* Whatever the section's own controls excluded, described by the control
     itself — so a domain that adds one gets its count reported for free. */
  for (const c of sectionControls()) {
    const v = state.controls[c.id];
    if (!c.active(v)) continue;
    const excluded = [...state.rows.values()]
      .filter((r) => state.symbolSet.has(r.symbol) && !c.passes(r, v)).length;
    if (excluded) parts.push(c.describe(v, excluded));
  }
  const dom = domain(state.boardMode);
  if (dom.needsPrices) {
    const mine = [...state.rows.values()].filter((r) => state.symbolSet.has(r.symbol));

    parts.push(coverageNote(dom, mine));

    /* How many names sit out where the curve compresses hardest — the same
       names the old ±cap ramps tied to an identical 0 or 100. Kept after the
       switch to tanh because it is the measurement that justifies the curve:
       a handful and a clamp would have been fine, a crowd and it was not. */
    const beyond = (field, edge) =>
      mine.filter((r) => r[field] != null && Math.abs(r[field]) >= edge).length;
    const momFar = beyond('mom6m1m', MOM_FLAT);
    const maFar = beyond('maGap', MA_FLAT);
    if (momFar) parts.push(`${momFar} beyond ±${MOM_FLAT}% momentum`);
    if (maFar) parts.push(`${maFar} beyond ±${MA_FLAT}% MA gap`);

    /* Withheld for a gap, and flagged for a dominating bar, are different
       states and are counted separately. A gapped series is not scored at all;
       a flagged one keeps every number and carries an ex-bar reading beside the
       factors the bar reaches. Both are surfaced here rather than left to be
       noticed in a row. */
    const gapped = mine.filter((r) => r.pxGap).length;
    if (gapped) parts.push(`${gapped} withheld (missing bars)`);

    const flagged = mine.filter((r) => r.pxAnomaly).length;
    if (flagged) parts.push(`${flagged} with a single bar dominating a factor`);

    const stale = mine.filter((r) => r.pxNote && !r.pxGap).length;
    if (stale) parts.push(`${stale} not scored (no current data)`);
  }

  /* Reported outside the needsPrices branch on purpose: a delisted name is not
     a price problem, and the Analyst tab — which needs no prices — is exactly
     where one can still carry a score without anything else noticing. */
  const mineAll = [...state.rows.values()].filter((r) => state.symbolSet.has(r.symbol));
  const gone = mineAll.filter((r) => notRegistered(r.symbol)).length;
  if (gone) parts.push(`${gone} no longer trading`);

  /* Excluded from every cross-sectional score's cohort, which is a stronger
     statement than "not scored" and worth its own count: these rows are not
     ranked against, and do not move anyone else's ranking. */
  const outOfCohort = mineAll.filter((r) => cohortIneligible(r)).length;
  if (outOfCohort) parts.push(`${outOfCohort} outside the ranking cohort`);

  if (domain(state.boardMode).needsPrices) {
  }
  if (state.dropped) parts.push(`${state.dropped} dropped (no coverage)`);
  if (!state.loading && state.rows.size) parts.push(`updated ${new Date().toLocaleTimeString()}`);
  $('#board-meta').textContent = parts.join(' · ');
}

// ── Rendering: board ────────────────────────────────────────────────

function sortedRows() {
  const { by, dir } = activeSort();
  const mult = dir === 'asc' ? 1 : -1;

  const sector = state.sector;

  const survivors = [...state.rows.values()]
    .filter((r) => state.symbolSet.has(r.symbol)
                && passesSectionControls(r)
                && rowPassesActiveFilters(r)
                && (sector === ALL_SECTORS || r.sector === sector));

  /* The cap keeps the best `n` per sector by whatever the board is sorted on —
     the same number the ranking is already using, so "highest-scoring" means
     the same thing on screen as it does in the setting. Rows with no value for
     that field cannot be ranked within their sector, so they are capped out. */
  const capped = state.sectorCap
    ? capPerSector(survivors, state.sectorCap, (r) => r.symbol,
        (r) => (r[by] == null ? -Infinity : r[by]))
    : survivors;

  return capped
    .sort((a, b) => {
      const av = a[by];
      const bv = b[by];
      // Missing values always sink to the bottom, whichever direction we sort.
      if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * mult;
      return (av - bv) * mult;
    });
}


/** Rank on one field across the whole watchlist, ignoring the sector filter and
    the active thresholds — so a filtered view can still say where a name sits
    among all of them. */
function fieldRanks(field) {
  const ranked = [...state.rows.values()]
    .filter((r) => state.symbolSet.has(r.symbol) && r[field] != null)
    .sort((a, b) => b[field] - a[field]);
  return new Map(ranked.map((r, i) => [r.symbol, i + 1]));
}

function distributionHTML(rec) {
  if (!rec) return '<span class="muted">—</span>';
  const total = BUCKETS.reduce((sum, b) => sum + (Number(rec[b.field]) || 0), 0);
  if (!total) return '<span class="muted">—</span>';

  const segments = BUCKETS.map((b) => {
    const n = Number(rec[b.field]) || 0;
    if (!n) return '';
    const pct = (n / total) * 100;
    return `<span class="${b.cls}" style="width:${pct.toFixed(2)}%" title="${b.label}: ${n}"></span>`;
  }).join('');

  return `<div class="dist" role="img" aria-label="${BUCKETS.map((b) => `${b.label} ${rec[b.field] || 0}`).join(', ')}">${segments}</div>`;
}

/** Raw mean plus the Buy/Hold/Sell chip it drives. */
function ratingHTML(row) {
  if (row.raw == null) {
    return row.loaded ? '<span class="muted">No coverage</span>' : '<span class="skeleton"></span>';
  }
  const { text, cls } = consensusLabel(row.raw);
  return `<div class="consensus">
      <span class="consensus-score">${row.raw.toFixed(2)}</span>
      <span class="consensus-label" style="background:var(${CLS_VAR[cls]})">${text}</span>
    </div>`;
}

/* ── Ratings published against a price that has moved on ──────────────
   A consensus period is labelled with a month. If the stock has moved sharply
   since that month began, every rating in the record was formed at a price the
   stock has since left, and the score is describing a different security than
   the one on screen. TTWO on 2026-09-01 was the board's top-rated name while
   down 6.67% on the day alone.

   This is a staleness flag, not a signal: a rating is not wrong because the
   price moved, and analysts may simply not have updated yet. It says the
   reading and the price no longer refer to the same moment. */
const PRE_MOVE_FLAG = 5;   // percent

/** Percent the price has moved since the latest consensus period began.

    The period start is a date; the series holds closes with no per-bar dates,
    so the index is interpolated the same way `dayAtIndex` reads one out. That is
    approximate by exactly the amount the storage format is approximate — see
    "Missing bars" in docs/NOTES.md — and a few days' error does not change whether a
    move is worth flagging. */
function movedSincePeriod(row, series) {
  if (!row || row.price == null || !series || !series.c || series.c.length < 2) return null;
  const period = row.latest && row.latest.period;
  if (!period) return null;

  const start = Date.parse(`${String(period).slice(0, 7)}-01T00:00:00Z`);
  const from = Date.parse(`${series.f}T00:00:00Z`);
  const to = Date.parse(`${series.t}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  if (start <= from) return null;            // the period predates the stored history
  if (start > to) return null;               // labelled ahead of the last bar

  const idx = Math.round(((start - from) / (to - from)) * (series.c.length - 1));
  const at = series.c[Math.max(0, Math.min(series.c.length - 1, idx))];
  if (!at) return null;
  return (row.price / at - 1) * 100;
}

function preMoveHTML(row) {
  const moved = row.movedSince;
  if (moved == null) return '<span class="muted">—</span>';
  const big = Math.abs(moved) >= PRE_MOVE_FLAG;
  const cls = big ? (moved > 0 ? 'up' : 'down') : 'muted';
  const title = big
    ? `Rated as of ${row.latest?.period || 'the latest period'}, and the price has moved `
      + `${moved > 0 ? '+' : ''}${moved.toFixed(1)}% since that period began. The consensus was `
      + `formed against a price the stock has left.`
    : `${moved > 0 ? '+' : ''}${moved.toFixed(1)}% since the latest consensus period began`;
  return `<span class="${cls}${big ? ' pre-move' : ''}" title="${esc(title)}">${
    moved > 0 ? '+' : ''}${moved.toFixed(1)}%</span>`;
}

/** Upside to the mean price target, coloured like the day change. */
function upsideHTML(row) {
  if (row.upside == null) return '<span class="muted">—</span>';
  const pct = row.upside * 100;
  const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'muted';
  const tip = row.targetLow != null && row.targetHigh != null
    ? ` title="Target mean ${fmtNum(row.targetMean)} (range ${fmtNum(row.targetLow)}–${fmtNum(row.targetHigh)})"`
    : ` title="Target mean ${fmtNum(row.targetMean)}"`;
  return `<span class="${cls}"${tip}>${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
}

/** Insider activity as a direction, not a share count — the raw numbers vary by
    orders of magnitude between names and do not compare usefully.

    TWO DIRECTIONS, NOT ONE. The officer/director group leads because it is the
    one that carries an opinion about the company; a >10% owner's activity is
    shown beside it, marked, and never merged into it. Where the two disagree
    that is the interesting case and the row now shows it instead of netting it
    to a single arrow. */
function insiderGroupHTML(g, label, cls) {
  if (!g || g.net == null) return '';
  const tip = `${label}: bought ${g.bought.toLocaleString()} · sold ${g.sold.toLocaleString()} `
    + `· net ${g.net > 0 ? '+' : g.net < 0 ? '−' : ''}${Math.abs(g.net).toLocaleString()} shares `
    + `across ${g.trades} open-market trade${g.trades === 1 ? '' : 's'} in ${INSIDER_LOOKBACK_DAYS} days`;
  const dir = g.net === 0 ? '<span class="muted">flat</span>'
    : g.net > 0 ? '<span class="up">&#9650;</span>' : '<span class="down">&#9660;</span>';
  return `<span class="${cls}" title="${esc(tip)}">${dir}${label === 'Officers and directors' ? '' : '<sub>10%</sub>'}</span>`;
}

function insiderHTML(row) {
  const i = row.insider;
  if (!i) return '<span class="muted">—</span>';

  const parts = [
    insiderGroupHTML(i.officer, 'Officers and directors', 'insider-officer'),
    insiderGroupHTML(i.holder, 'Beneficial owners above 10%', 'insider-holder'),
    insiderGroupHTML(i.unknown, 'Filer type unknown — no current share count to classify against', 'insider-unknown'),
  ].filter(Boolean);

  if (!parts.length) {
    return `<span class="muted" title="No open-market (P/S) insider trades in the last ${INSIDER_LOOKBACK_DAYS} days. Form 4 covers officers, directors and holders above 10% only — an institution below 10% files 13F/13G and is invisible here.">none</span>`;
  }
  return parts.join(' ');
}

/** Signed delta, coloured by direction. Rounds first so "-0.00" never shows. */
function deltaHTML(value, digits = 0) {
  if (value == null) return '<span class="muted">—</span>';
  const text = value.toFixed(digits);
  if (Number(text) === 0) return `<span class="muted">${(0).toFixed(digits)}</span>`;
  return `<span class="${value > 0 ? 'up' : 'down'}">${value > 0 ? '+' : ''}${text}</span>`;
}

/** The shared left-hand columns: rank, ticker, company, price, day change.
    Identical in both modes, so neither drifts from the other. */
function commonCellsHTML(r, pos, rankTitle) {
  const chgCls = r.changePct == null ? '' : r.changePct >= 0 ? 'up' : 'down';
  const cell = (v) => (r.loaded ? v : '<span class="skeleton"></span>');
  // Prices come from the 24h cache, so flag any that are no longer intraday.
  // A snapshot is one moment by declaration; greying its prices as stale would
  // restate the banner on every row.
  const stale = !state.snapshot && Date.now() - (r.fetchedAt || 0) > PRICE_STALE_MS;
  const staleAttrs = stale
    ? ` class="num stale" title="Price from ${new Date(r.fetchedAt).toLocaleString()}"`
    : ' class="num"';

  /* A symbol EDGAR no longer lists is marked on the ticker itself, because that
     is the cell every view shows and the fact travels with the name rather than
     with any one score. Not removed: a row that vanishes explains nothing, and
     the reason it should go is exactly what the marker states. */
  const gone = notRegistered(r.symbol)
    ? ` <span class="delisted" title="${esc(
        `${r.symbol} is not in EDGAR's list of current SEC registrants — acquired, taken private, or delisted. `
        + `Its price history stopped updating${r.bars ? ` after ${r.bars} bars` : ''}, and any score still shown for it `
        + `is computed from cached data about a company that no longer trades.`)}">not trading</span>`
    : '';

  return `<td class="rank"${rankTitle}>${pos}</td>
        <td class="ticker">${esc(r.symbol)}${gone}</td>
        <td class="company" title="${esc(r.name)} · ${esc(r.sector)}">${cell(esc(r.name))}</td>
        <td${staleAttrs}>${cell(r.price == null ? '—' : fmtNum(r.price))}</td>
        <td class="num ${stale ? 'stale' : chgCls}">${cell(fmtPct(r.changePct))}</td>`;
}

/* A CLICK STARTS AN ASSESSMENT, which is what it always did. What changed is
   the second click: while one is running, clicking another row lines that name
   up instead of being refused, and the runner takes it as soon as it is free.

   Three states, and the label is the whole of the difference:

     ✦   idle — click to assess it now
     …   in flight — the call is sent and cannot be taken back
     3   waiting — third in line; click to take it out

   The waiting state carries the POSITION rather than a tick, because the order
   is a fact the user made by clicking in the order they did and the runner will
   honour it. A checkmark would say "in" and stop there; "3" also says when.

   The model is still named in the tooltip so the choice stays discoverable from
   the row as well as from the selector — a control that quietly spends
   differently depending on something elsewhere on the page is a trap. */
const ASSESS_GLYPH = '✦';           // the resting state of the row button
const ASSESS_LIVE_GLYPH = '…';      // one call, already sent

/** The label a row button should be showing right now. One function, because
    the initial render and the repainter must never disagree about it. */
function assessBtnLabel(symbol) {
  if (assessing(symbol)) return ASSESS_LIVE_GLYPH;
  return queued(symbol) ? String(queuePosition(symbol)) : ASSESS_GLYPH;
}

const assessCellHTML = (r) => {
  const cfg = ASSESS_MODELS[state.assessModel] || {};
  const est = perCallEstimate(state.assessModel);
  const live = assessing(r.symbol);
  const inQueue = queued(r.symbol);
  /* A GLYPH, NOT AN SVG. The label is swapped in place between three states, so
     it has to be a text character; an icon made of child elements would be
     wiped by the first swap and come back as an empty button. The full
     explanation stays in the title.

     Written once as constants and used by both painters: two copies of a
     character nobody can read in a diff is two copies that can drift. */
  const title = live
    ? `${r.symbol} is being assessed now. The call is already sent, so it cannot be cancelled.`
    : inQueue
      ? `${r.symbol} is number ${queuePosition(r.symbol)} in line. Nothing has been sent for it yet — `
        + 'click to take it out.'
      : `Assess ${r.symbol} now: its board context and a web search go to `
        + `${cfg.label || state.assessModel} for a written brief. `
        + `${estimateText(est)} per assessment — ${est.basis}. Logged permanently. `
        + 'If something is already running this one waits its turn instead. '
        + 'Change the model with the "Assess with" selector.';
  return `<td class="action-col"><button class="row-assess${live ? ' is-live' : inQueue ? ' is-queued' : ''}"
      data-assess="${esc(r.symbol)}" type="button" aria-pressed="${live || inQueue}"
      aria-label="${esc(live ? `Assessing ${r.symbol}`
        : inQueue ? `Take ${r.symbol} out of the queue` : `Assess ${r.symbol}`)}"
      title="${esc(title)}"
      >${assessBtnLabel(r.symbol)}</button></td>`;
};

/** Bring every rendered row button in line with the runner, without rebuilding
    the board.

    One click changes at most one row's state but shifts every LATER position —
    take number 2 out of five and three buttons are now wrong, and every name
    the runner finishes shifts the rest up by one. So this repaints them all
    rather than the one that was clicked. It touches attributes on ~575 buttons;
    a `renderBoard()` would rebuild 575 rows of markup and every score cell in
    them, on a change that touched no score. */
function paintQueueMarks() {
  for (const btn of document.querySelectorAll('#board-body [data-assess]')) {
    const symbol = btn.dataset.assess;
    const live = assessing(symbol);
    const inQueue = queued(symbol);
    const label = assessBtnLabel(symbol);
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle('is-live', live);
    btn.classList.toggle('is-queued', !live && inQueue);
    btn.setAttribute('aria-pressed', String(live || inQueue));
  }
}

/* ── The assessed cell ────────────────────────────────────────────────
   ONE COLUMN, not three. Measured 2026-09-01 before building: of 575 rows, 33
   carry a rating and only 9 carry the horizon split. Three columns would have
   left two of them blank on 98.4% of the board and spent the width anyway.

   Combined, the cell degrades instead of emptying: model plus rating alone when
   that is all there is, model plus rating plus both calls when the split
   exists, and NOTHING at all when there is no assessment. Not a dash and not a
   zero — 542 rows have no assessment, and a placeholder repeated 542 times is a
   value being asserted where none exists.

   The UNSUPPORTED marking lives on the COLUMN HEADER, not in the cell: the
   claim is about the field, it is true of every row equally, and a chip per
   populated row would be ink that says the same thing 33 times. See
   boardColumns. The cell reuses `score-weak`, so a rating reads as a muted
   reading rather than as a score sitting at the weight of Overall. */
const ASSESS_STALE_DAYS = RATING_MIN_DAYS;

function assessedCellHTML(r) {
  const e = state.assessBySymbol[r.symbol];
  if (!e) return '<td class="num assessed-col"></td>';

  const ageMs = Date.now() - e.at;
  /* Thirty days is the shortest scoring horizon, so it is the point at which
     an entry first becomes measurable against anything — and the point past
     which "what the model thought" and "what the price has since done" have
     had room to diverge. */
  const stale = ageMs > ASSESS_STALE_DAYS * 86400000;

  const bits = [];
  if (validRating(e.rating)) bits.push(String(e.rating));
  if (hasHorizonSplit(e)) bits.push(`${e.callNear}/${e.callLong}`);
  bits.push(humanAgo(ageMs));

  /* WHO SAID IT, beside what they said, rather than only in the tooltip.
     This cell shows ONE entry chosen out of however many a symbol carries, and
     the choice is not "newest" — pickAssessment prefers a horizon split first
     and Opus second, so two rows showing 7 can be two different models and the
     board said nothing about it. A rating is a model's judgement and the model
     is half of what the number means; a tooltip is the wrong place for a fact
     that changes how the column reads at a glance.

     First in the cell, not last: the numbers stay flush against the right edge
     where they can be scanned down the column, and the variable-width name
     takes the slack on the left. Muted, so it reads as provenance rather than
     as one more score. */
  const who = `<span class="assessed-by">${esc(assessModelShort(e.model))}</span>`;

  return `<td class="num assessed-col${stale ? ' assessed-stale' : ''}"
      title="${esc(`${ASSESS_MODELS[e.model]?.label || e.model}, ${new Date(e.at).toLocaleString()}. `
        + `${validRating(e.rating) ? `Rating ${e.rating}/10. ` : ''}`
        + `${hasHorizonSplit(e) ? `Near-term ${e.callNear}/10, long-term ${e.callLong}/10. ` : 'No horizon split — this entry predates it. '}`
        + 'None of these has been measured against forward returns. Open the row to read the brief.')
      }">${who} <span class="score-weak">${bits.join(' · ')}</span></td>`;
}

const removeCellHTML = (r) =>
  `<td class="action-col"><button class="row-remove" data-remove="${esc(r.symbol)}" title="Remove ${esc(r.symbol)}" aria-label="Remove ${esc(r.symbol)}">&times;</button></td>`;

/** The bar-count cell, shared by every price-driven domain.

    Every symbol shows, however little history it has — the blanks say which
    indicators it cannot support, and the bar count says why. A row held back
    because its data is not current says so instead, since its bar count would
    otherwise look ample and explain nothing. */
function barsCellHTML(r) {
  const bars = r.bars || 0;
  const short = bars < MA_WINDOW;
  const title = r.pxNote
    ? `Not scored — ${r.pxNote}. ${bars} closes stored.`
    : short
      ? `${bars} daily closes — the 200-day average needs ${MA_WINDOW}, momentum ${MOM_LOOKBACK + 1}, RSI ${RSI_WINDOW + 1}`
      : `${bars} daily closes stored`;
  return `<span class="${r.pxNote || short ? 'muted' : ''}" title="${esc(title)}">${
    r.pxNote ? `${bars} · stale` : bars}</span>`;
}

/** One row, assembled from the registry.

    Identity cells, then every domain's score, then the detail columns of the
    domain on screen. There is no per-domain row function to keep in step with
    a per-domain column list any more: both come from the same entry, so a new
    domain cannot render a header its cells do not fill. */
function boardRowHTML(r, pos, rankTitle) {
  const skel = (html) => (r.loaded ? html : '<span class="skeleton"></span>');

  /* Driven by the same list the header is built from, so a column can never
     render a heading without a cell under it. */
  const cells = dataColumns().map((col) => {
    const cls = [col.num ? 'num' : '', col.cls || '', col.unsortable ? 'col-failed' : '',
      col.notCounted ? 'col-aside-cell' : '']
      .filter(Boolean).join(' ');
    const title = col.cellTitle ? ` title="${esc(col.cellTitle(r))}"` : '';
    return `<td${cls ? ` class="${cls}"` : ''}${title}>${skel(col.cell(r))}</td>`;
  }).join('');

  return `${commonCellsHTML(r, pos, rankTitle)}${cells}${assessedCellHTML(r)}${assessCellHTML(r)}${removeCellHTML(r)}`;
}

/** A percentage that reads as a direction, signed and coloured. */
function signedPctHTML(value, digits = 1) {
  if (value == null) return '<span class="muted">—</span>';
  const text = value.toFixed(digits);
  if (Number(text) === 0) return `<span class="muted">${(0).toFixed(digits)}%</span>`;
  return `<span class="${value > 0 ? 'up' : 'down'}">${value > 0 ? '+' : ''}${text}%</span>`;
}

/** A 0–100 score. Tinted by which side of neutral it falls, since 50 is a
    fixed meaning here rather than a middle-of-the-pack artefact. */
/* Every 0–100 score here comes off a tanh curve, which never reaches its rails
   but gets close enough that `toFixed(1)` prints 0.0 or 100.0. Those read as
   round numbers — or, at the bottom, as a failed calculation — when what they
   actually mean is "past the end of the curve's resolution". S/R showed 0.0 for
   names 40–58% above their nearest support, which is a real and quite precise
   statement rendered as something indistinguishable from a null.

   Inside the rails the score is shown as a number. Outside them it is shown as
   an inequality, because that is all the curve can still say. Distinct from
   `—`, which means no score at all. */
const SCORE_RAIL_LOW = 1;
const SCORE_RAIL_HIGH = 99;

/** What a flagged factor reads without its dominating bar, shown beside the
    reported figure so both are visible and neither is hidden.

    Returns '' for every factor that bar does not reach — which is the point of
    the flag being per factor. */
function exBarHTML(row, field, fmt) {
  const a = row && row.pxAnomaly;
  if (!a || !(field in a.exBar)) return '';
  const day = dayAtIndex(state.px.series.get(row.symbol), a.at);
  return ` <span class="ex-bar" title="${esc(
    `One bar dominates this factor: ${day || 'a single close'} moved ${a.barPct > 0 ? '+' : ''}`
    + `${a.barPct.toFixed(0)}%, which alone accounts for ${a.inflation.toFixed(0)} points of `
    + `annualised volatility (${a.volReported.toFixed(0)}% reported, ${a.volExBar.toFixed(0)}% without it). `
    + `The value in brackets is what this factor reads with that bar's discontinuity spliced out. `
    + `Whether the bar is a data fault or a real move is NOT established — see docs/NOTES.md.`
  )}">(${fmt(a.exBar[field])})</span>`;
}

function scoreHTML(value, { rails = true } = {}) {
  if (value == null) return '<span class="muted">—</span>';

  /* Rails are a statement about a TANH CURVE running out of resolution, not
     about the number being large. A percentile has uniform resolution all the
     way to the ends — 99.9 and 99.7 are two genuinely different names — so
     rendering both as ">99" would recreate the exact flat top the percentile
     was introduced to fix. Scores that are not curve-based opt out. */
  /* `score-strong` / `score-weak`, NOT `up` / `down`. Same thresholds, same
     text, no hue: green and red now mean the sign of a price move and nothing
     else, and a score says its magnitude with weight. See the colour rule in
     styles.css — a red change beside a green score read as a contradiction
     between two axes that have nothing to do with each other. */
  if (!rails) {
    const flat = value > 55 ? 'score-strong' : value < 45 ? 'score-weak' : '';
    return `<span class="${flat}">${value.toFixed(1)}</span>`;
  }

  if (value < SCORE_RAIL_LOW) {
    return `<span class="score-weak saturated" title="Saturated: below ${SCORE_RAIL_LOW} the curve has no resolution left, so the exact value (${value.toFixed(3)}) does not rank against another name in the same region. This is a real score, not a missing one — a missing score shows as —.">&lt;${SCORE_RAIL_LOW}</span>`;
  }
  if (value > SCORE_RAIL_HIGH) {
    return `<span class="score-strong saturated" title="Saturated: above ${SCORE_RAIL_HIGH} the curve has no resolution left, so the exact value (${value.toFixed(3)}) does not rank against another name in the same region.">&gt;${SCORE_RAIL_HIGH}</span>`;
  }

  const cls = value > 55 ? 'score-strong' : value < 45 ? 'score-weak' : '';
  return `<span class="${cls}">${value.toFixed(1)}</span>`;
}


/** Rebuild the header row for the active mode. Regenerated rather than
    toggled, so the two column sets cannot drift out of step with the cells
    beneath them — and sort clicks are delegated for the same reason. */
function renderBoardHead() {
  const { by, dir } = activeSort();

  $('#board-head').innerHTML = `<tr>${boardColumns().map((col) => {
    if (col.special === 'rank') {
      return '<th class="rank-col" scope="col" title="Position in the current sort"><span class="sr-only">Rank</span>#</th>';
    }
    if (col.special === 'assessed') {
      return `<th class="num assessed-col assessed-head" scope="col" title="${esc(col.title)}"><span class="saturated">${esc(col.label)}</span></th>`;
    }
    if (col.special === 'assess') return '<th class="action-col" scope="col"><span class="sr-only">Assess</span></th>';
    if (col.special === 'remove') return '<th class="action-col" scope="col"><span class="sr-only">Remove</span></th>';

    // A failed domain's column renders as a reading, not as a control: no
    // sortable class and no data-sort, so the click handler never sees it.
    const canSort = !!col.key && !col.unsortable;
    const classes = [col.num ? 'num' : '', canSort ? 'sortable' : '',
      col.unsortable ? 'col-failed' : '', col.notCounted ? 'col-aside' : '',
      col.cls || '']
      .filter(Boolean).join(' ');
    const attrs = [
      classes ? ` class="${classes}"` : '',
      canSort ? ` data-sort="${col.key}"` : '',
      canSort && col.key === by ? ` data-dir="${dir}"` : '',
      col.title ? ` title="${esc(col.title)}"` : '',
    ].join('');
    /* Marked in the header rather than only in a tooltip: on Overall this
       column sits beside the ones that DID feed the number, and nothing about
       a score in a column says whether it was counted. */
    const mark = col.notCounted ? '<span class="col-aside-tag">not counted</span>' : '';
    return `<th${attrs} scope="col">${col.label}${mark}</th>`;
  }).join('')}</tr>`;
}

/* ── Rendering: the filter panel ─────────────────────────────────────
   One row per filterable domain, built from the registry. A domain that is not
   filterable still gets a line, saying why — a failed score silently vanishing
   from the panel would look like a bug rather than like a decision. */
function renderFilters() {
  const host = $('#filters');
  if (!host) return;

  // The panel lives on Overall, where comparing across domains is the point.
  const panel = $('#filter-panel');
  if (panel) panel.hidden = !filtersApply();
  if (!filtersApply()) return;

  const mine = [...state.rows.values()].filter((r) => state.symbolSet.has(r.symbol));

  host.innerHTML = allScores().map((sc) => {
    const r = rules(sc);
    const f = state.filters[sc.id];
    const scored = mine.filter((row) => row[sc.field] != null).length;
    const name = `${sc.domain.label} · ${plainLabel(sc.label)}`;

    if (!r.filterable) {
      return `<div class="filter-row filter-off">
          <span class="filter-name">${esc(name)}
            <span class="status-tag status-${esc(r.tag)}" title="${esc(r.title)}">${esc(r.tag)}</span>
          </span>
          <span class="muted filter-note">display only — cannot filter or sort</span>
        </div>`;
    }

    const passing = f.on
      ? mine.filter((row) => row[sc.field] != null && row[sc.field] >= f.min).length
      : scored;

    return `<div class="filter-row${f.on ? ' filter-active' : ''}">
        <label class="filter-name">
          <input type="checkbox" data-filter-on="${esc(sc.id)}"${f.on ? ' checked' : ''}>
          ${esc(name)}
          <span class="status-tag status-${esc(r.tag)}" title="${esc(r.title)}">${esc(r.tag)}</span>
        </label>
        <label class="filter-min">&ge;
          <input class="num-input" type="number" data-filter-min="${esc(sc.id)}"
                 min="${sc.scale.min}" max="${sc.scale.max}" step="${sc.scale.step}"
                 value="${f.min}"${f.on ? '' : ' disabled'}>
        </label>
        <span class="muted filter-note">${
          f.on ? `${passing} of ${scored} scored pass` : `${scored} scored`
        }</span>
      </div>`;
  }).join('');

  const active = activeFilters();
  const passing = mine.filter(passesFilters).length;
  const el = $('#filter-summary');

  /* SHORT ENOUGH TO SIT ON A CLOSED SUMMARY. The panel is collapsed by default
     now, so this line is what stands for it on the board — a sentence of prose
     here put the old wall of text back one row higher. The full reading moves
     to the title, which loses nothing: it was never information you could act
     on without opening the panel anyway. */
  el.textContent = active.length
    ? `${active.length} active · ${passing} of ${mine.length} pass`
    : 'none active';
  el.title = active.length
    ? `${passing} of ${mine.length} symbols pass ${active.length} active filter${active.length === 1 ? '' : 's'}: ${active.map((d) => `${plainLabel(d.label)} ≥ ${state.filters[d.id].min}`).join(' · ')}`
    : 'No filters active — every symbol on the watchlist is shown. Each domain is judged on its own scale; there is no combined score.';
  /* So a board that IS filtered says so without being opened. */
  $('#filter-panel')?.classList.toggle('filter-panel-active', active.length > 0);
}

function renderBoard() {
  /* Recomputed here rather than at each of the half-dozen places rows or
     series change, so a score can never be stale. It costs ~10ms across 579
     symbols and only the technicals board pays it. */
  /* Any price-driven domain needs the indicators recomputed; the scores are
     always all on screen now, so this is no longer conditional on one view. */
  if (SCORE_DOMAINS.some((d) => d.needsPrices)) applyTechnicals();
  // Overall reads every domain's score, so it is derived after they are all in.
  applyOverall();

  const rows = sortedRows();

  // Suppress the empty-state while a load is still filling the board.
  $('#board-empty').hidden = rows.length > 0 || state.loading;

  renderBoardHead();
  renderSectionControls();
  renderFilters();

  /* Rank against whichever field is being sorted by, so the tooltip answers
     the question the column ordering just asked. Falls back to the domain on
     screen when the sort is on an identity column like price. */
  const sortedBy = activeSort().by;
  const rankScore = allScores().find((s) => s.field === sortedBy);
  const rankField = sortedBy === 'overall' ? 'overall'
    : rankScore ? rankScore.field
    : (isOverall(state.boardMode) ? 'overall' : primaryScore(domain(state.boardMode)).field);
  const overall = fieldRanks(rankField);
  const rankLabel = rankField === 'overall' ? 'Overall'
    : (allScores().find((s) => s.field === rankField) || {}).label || rankField;

  $('#board-body').innerHTML = rows
    .map((r, i) => {
      /* The visible number is the row's place in the current view; when a
         sector filter or a different sort makes that diverge from the overall
         rank, the real rank goes in the tooltip rather than replacing it. */
      const pos = i + 1;
      const abs = overall.get(r.symbol);
      const rankTitle = abs && abs !== pos
        ? ` title="${rankLabel} rank ${abs} of ${overall.size} overall"`
        : '';
      return `<tr data-symbol="${esc(r.symbol)}" class="${state.selected === r.symbol ? 'active' : ''}">
        ${boardRowHTML(r, pos, rankTitle)}
      </tr>`;
    })
    .join('');

  renderBoardMeta(rows.length);
}

// ── Rendering: detail ───────────────────────────────────────────────

function trendHTML(trend) {
  const months = trend.slice(0, 6).reverse();
  if (!months.length) return '<p class="muted">No recommendation history available for this symbol.</p>';

  const max = Math.max(...months.map((m) => BUCKETS.reduce((s, b) => s + (Number(m[b.field]) || 0), 0)), 1);

  const cols = months
    .map((m) => {
      const total = BUCKETS.reduce((s, b) => s + (Number(m[b.field]) || 0), 0);
      const segments = BUCKETS.map((b) => {
        const n = Number(m[b.field]) || 0;
        if (!n) return '';
        // Height is a share of the tallest month, so month-to-month volume is comparable.
        return `<span class="${b.cls}" style="height:${((n / max) * 100).toFixed(2)}%" title="${b.label}: ${n}"></span>`;
      }).join('');
      return `<div class="trend-col">
          <div class="trend-stack" role="img" aria-label="${fmtPeriod(m.period)}: ${total} analysts">${segments}</div>
          <div class="trend-label">${fmtPeriod(m.period)}</div>
        </div>`;
    })
    .join('');

  const legend = BUCKETS.map(
    (b) => `<span><i style="background:var(${CLS_VAR[b.cls]})"></i>${b.label}</span>`
  ).join('');

  return `<div class="trend">${cols}</div><div class="legend">${legend}</div>`;
}

/* Chart coordinate space. The SVG is stretched to the panel width with
   preserveAspectRatio="none", so it holds no text — the labels live in HTML
   around it, where they cannot be distorted by the scaling. */
const CHART_W = 600;
const CHART_H = 150;

/** Six months of daily closes as a line + area. `points` is [[unixSec, close]…]
    oldest first, guaranteed at least two entries by normaliseCandles. */
function priceChartHTML(points) {
  const closes = points.map((p) => p[1]);
  const min = Math.min(...closes);
  const max = Math.max(...closes);

  // Pad the range so the extremes do not sit exactly on the frame edge. A flat
  // series has zero span, which would divide by zero; give it an arbitrary one.
  const span = (max - min) || Math.abs(max) || 1;
  const lo = min - span * 0.08;
  const hi = max + span * 0.08;

  const n = points.length;
  const x = (i) => ((i / (n - 1)) * CHART_W).toFixed(2);
  const y = (v) => (CHART_H - ((v - lo) / (hi - lo)) * CHART_H).toFixed(2);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p[1])}`).join(' ');
  const area = `${line} L${CHART_W} ${CHART_H} L0 ${CHART_H} Z`;

  const first = closes[0];
  const last = closes[n - 1];
  const pct = first ? ((last - first) / first) * 100 : null;
  const dir = last >= first ? 'up' : 'down';
  const colour = `var(--${dir})`;

  const dayOf = (sec) => fmtDay(new Date(sec * 1000).toISOString());
  const summary =
    `${fmtNum(first)} on ${dayOf(points[0][0])} to ${fmtNum(last)} on ${dayOf(points[n - 1][0])}, ${fmtPct(pct)}`;

  return `
    <div class="pchart-head">
      <span class="pchart-change ${dir}">${esc(fmtPct(pct))}</span>
      <span class="muted">high ${esc(fmtNum(max))} · low ${esc(fmtNum(min))} · ${n} sessions</span>
    </div>
    <svg class="pchart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none"
         role="img" aria-label="Six-month closing price: ${esc(summary)}">
      <path d="${area}" fill="${colour}" opacity=".10"></path>
      <path d="${line}" fill="none" stroke="${colour}" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>
    </svg>
    <div class="pchart-axis">
      <span>${esc(dayOf(points[0][0]))}</span>
      <span>${esc(dayOf(points[n - 1][0]))}</span>
    </div>`;
}

/** The price-chart slot in whichever of its four states the row is in. */
function priceSectionHTML(row) {
  if (row.candles === undefined || row.candles === 'loading') {
    return '<p class="chart-msg">Loading price history…</p>';
  }
  if (row.candles === null) {
    return PLAN.candle
      ? '<p class="chart-msg">No price history available for this symbol.</p>'
      : '<p class="chart-msg">Price charts are not available on your Finnhub plan.</p>';
  }
  return priceChartHTML(row.candles);
}

/** The raw monthly records behind the trend bars. The chart shows shape; this
    shows the numbers, including each month's own weighted mean — which is what
    momentum is measured across. */
function monthlyTableHTML(trend, baselinePeriod) {
  const months = (trend || []).slice(0, 6);   // newest first, as stored
  if (!months.length) return '';

  const head = BUCKETS.map(
    (b) => `<th class="num" title="${esc(b.label)}"><i class="bucket-dot" style="background:var(${CLS_VAR[b.cls]})"></i>${esc(b.short)}</th>`
  ).join('');

  const body = months.map((m) => {
    const d = distribution(m);
    const isBase = baselinePeriod && m.period === baselinePeriod;
    const cells = BUCKETS.map((b) => {
      const n = Number(m[b.field]) || 0;
      return `<td class="num${n ? '' : ' zero'}">${n}</td>`;
    }).join('');
    return `<tr${isBase ? ' class="baseline-row"' : ''}>
        <td class="period">${esc(fmtPeriod(m.period))}${
          isBase ? '<span class="tag" title="Momentum is measured against this month">base</span>' : ''
        }</td>
        ${cells}
        <td class="num">${d ? d.analysts : 0}</td>
        <td class="num">${d ? d.raw.toFixed(2) : '—'}</td>
        <td class="num">${d ? d.sd.toFixed(2) : '—'}</td>
      </tr>`;
  }).join('');

  return `<div class="table-scroll">
      <table class="mini-table">
        <thead><tr>
          <th>Month</th>
          ${head}
          <th class="num" title="Total analysts covering">Total</th>
          <th class="num" title="Weighted mean on the 1–5 scale, before shrinkage">Raw</th>
          <th class="num" title="Standard deviation of the ratings">σ</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** Every term of the composite and what it contributed, in the order the model
    applies them, so the column adds up to the score on the board. */
function breakdownHTML(row) {
  if (row.composite == null) return '<p class="muted">No analyst coverage, so no composite score.</p>';

  const terms = [
    {
      name: 'Level',
      note: 'base',
      input: row.raw == null
        ? '—'
        : `raw ${row.raw.toFixed(2)} over ${row.analysts} analysts, shrunk toward ${PRIOR} (m=${SHRINK_M})`,
      value: row.level,
      base: true,
    },
    {
      name: 'Momentum',
      input: row.momentum == null
        ? 'No baseline at least 2 months back'
        : `${fmtSigned(row.momentum)} vs ${fmtPeriod(row.baselinePeriod)}, capped at ±${MOMENTUM_CAP.toFixed(2)}`,
      value: row.momentumAdj,
    },
    {
      name: 'Agreement',
      input: row.agreement == null
        ? '—'
        : `${(row.agreement * 100).toFixed(0)}% (σ ${row.sd.toFixed(2)}), ${(AGREEMENT_PIVOT * 100).toFixed(0)}% pivot × ${AGREEMENT_MULT}`,
      value: row.agreementAdj,
    },
    {
      name: 'Upside',
      input: row.upside == null
        ? (PLAN.priceTarget ? 'No price target' : 'Not available on your plan')
        : `${fmtSigned(row.upside * 100, 1)}% to ${fmtNum(row.targetMean)}, capped at ±${UPSIDE_CAP.toFixed(2)}`,
      value: row.upsideAdj,
    },
  ];

  const rows = terms.map((t) => {
    const cls = t.base || !t.value ? '' : t.value > 0 ? 'adj-pos' : 'adj-neg';
    const shown = t.value == null ? '—' : t.base ? t.value.toFixed(2) : fmtSigned(t.value);
    return `<tr>
        <th scope="row">${esc(t.name)}${t.note ? ` <span class="muted">(${esc(t.note)})</span>` : ''}</th>
        <td class="term-input">${esc(t.input)}</td>
        <td class="num ${cls}">${esc(shown)}</td>
      </tr>`;
  }).join('');

  const clamped = row.compositeUnclamped != null
    && Math.abs(row.compositeUnclamped - row.composite) > 0.005;

  return `<table class="mini-table breakdown">
      <tbody>
        ${rows}
        <tr class="total">
          <th scope="row">Composite</th>
          <td class="term-input">${clamped
            ? `${row.compositeUnclamped.toFixed(2)} before the ${COMPOSITE_MIN}–${COMPOSITE_MAX} clamp`
            : 'sum of the terms above'}</td>
          <td class="num">${row.composite.toFixed(2)}</td>
        </tr>
      </tbody>
    </table>${
      clamped
        ? `<p class="breakdown-note">Adjustments carried this name past the rating scale, so the composite is held at ${row.composite.toFixed(2)}.</p>`
        : ''
    }`;
}

/* ── The technical panel ──────────────────────────────────────────────
   What the detail panel shows follows the board's mode. On the Technicals
   board the analyst breakdown describes a model the board is not using, so it
   is replaced rather than appended to: the same price/indicator material the
   columns are computed from, at the resolution a single symbol can afford. */

/** The stored series as chart points.

    Per-bar dates are not kept, so each bar's timestamp is interpolated between
    the series' first and last — the same approximation `dayAtIndex` makes, and
    invisible here because the chart labels only its two ends. */
function seriesPoints(series) {
  const from = Date.parse(`${series.f}T00:00:00Z`);
  const to = Date.parse(`${series.t}T00:00:00Z`);
  const n = series.c.length;
  if (!Number.isFinite(from) || !Number.isFinite(to) || n < 2) return null;
  return series.c.map((c, i) => [Math.round((from + ((to - from) * i) / (n - 1)) / 1000), c]);
}

/** The price chart, drawn from the stored Polygon series rather than the
    Finnhub candles the analyst panel uses. It is already on disk, it reaches
    ten years back instead of six months, and it costs no API call. */
function technicalPriceSectionHTML(row) {
  const series = state.px.series.get(row.symbol);
  if (!series || !series.c.length) {
    return state.provKeys.polygon
      ? '<p class="chart-msg">No stored price history for this symbol yet — run the backfill from the board.</p>'
      : '<p class="chart-msg">Connect a Polygon key and run the backfill to see price history.</p>';
  }
  const points = seriesPoints(series);
  if (!points) return '<p class="chart-msg">Only one stored bar — not enough to draw a line.</p>';
  return priceChartHTML(points);
}

/* Every sub-score any technical domain can draw on, keyed by the field
   `subScores()` produces. A domain's breakdown is assembled by looking up the
   entries its own weights name; the ones it does not name are listed as
   excluded, so a reader can see what the model chose to leave out as well as
   what it used. `read` turns the stored indicator into the reading shown
   beside it, including what it would need to produce one at all. */
const SUBSCORE_TERMS = {
  mom12Score: {
    name: 'Momentum 12−1',
    read: (row) => (row.mom12m1m == null
      ? `needs ${MOM12_LOOKBACK + 1} bars`
      : `${fmtSigned(row.mom12m1m, 1)}% over ${MOM12_LOOKBACK} bars, last ${MOM_SKIP} excluded · tanh k=${MOM12_K}`),
    excluded: 'the twelve-month horizon; this score reads a different one',
  },
  mom6Score: {
    name: 'Momentum 6−1',
    read: (row) => (row.mom6m1m == null
      ? `needs ${MOM_LOOKBACK + 1} bars`
      : `${fmtSigned(row.mom6m1m, 1)}% over ${MOM_LOOKBACK} bars, last ${MOM_SKIP} excluded · tanh k=${MOM_K}`),
    excluded: 'the shorter momentum horizon, left out of the canonical blend',
  },
  volScore: {
    name: 'Realised volatility 12m',
    read: (row) => (row.realisedVol == null
      ? `needs ${VOL_WINDOW + 1} bars`
      : `${row.realisedVol.toFixed(1)}% annualised · inverted about ${VOL_PIVOT}% in log space, tanh k=${VOL_LOG_K}, so calmer scores high and a doubling costs ~41 points`),
    excluded: 'a risk measure, not a trend measure',
  },
  ddScore: {
    name: 'Max drawdown 12m',
    read: (row) => (row.maxDD == null
      ? `needs ${DD_WINDOW} bars`
      : `−${row.maxDD.toFixed(1)}% peak to trough · inverted about ${DD_PIVOT}%, tanh k=${DD_K}, so shallower scores high`),
    excluded: 'expected to restate volatility; kept out until the matrix says otherwise',
  },
  srScore: {
    name: 'Distance to support',
    read: (row) => (row.srDist == null
      ? `no level below the price with ${SR_MIN_TOUCHES}+ touches`
      : `${row.srDist.toFixed(1)}% above the nearest support · inverted about ${SR_PIVOT}%, tanh k=${SR_K} · EXPERIMENTAL, no volume weighting`),
    excluded: 'experimental, and deliberately not in a score meant to be trusted',
  },

  /* Fundamentals. `read` says WHY a reading is absent rather than leaving a
     dash, because for these the absence is usually a statement — a loss, a
     negative book value, or a share count too old to price a market cap — and
     each of those is a different fact about the company. */
  eyScore: {
    name: 'Earnings yield',
    read: (row) => (row.earnYield == null
      ? 'no reading — negative trailing earnings, or no current share count to price a market cap'
      : `${(row.earnYield * 100).toFixed(2)}% of market cap · pivot ${(EY_PIVOT * 100).toFixed(1)}%, tanh k=${(EY_K * 100).toFixed(1)}pp`),
    excluded: 'a value measure, not a quality one',
  },
  bmScore: {
    name: 'Book to market',
    read: (row) => (row.bookToMkt == null
      ? 'no reading — negative book value, or no current share count'
      : `${row.bookToMkt.toFixed(3)} of market cap · pivot ${BM_PIVOT}, tanh k=${BM_K}`),
    excluded: 'the other half of value; shares its equity input with ROE',
  },
  roeScore: {
    name: 'Return on equity',
    read: (row) => (row.roe == null
      ? 'no reading — negative average equity, which would make the ratio read positive'
      : `${(row.roe * 100).toFixed(1)}% on average equity · pivot ${(ROE_PIVOT * 100).toFixed(0)}%, tanh k=${(ROE_K * 100).toFixed(0)}pp`),
    excluded: 'a profitability measure, not a valuation one',
  },
  accScore: {
    name: 'Accruals',
    read: (row) => (row.accruals == null
      ? 'no reading — net income and operating cash flow do not cover the same period'
      : `${row.accruals.toFixed(3)} of average assets${row.fxBasis ? ` · ${row.fxBasis} basis` : ''}`
        + ` · inverted about ${ACC_PIVOT}, tanh k=${ACC_K}, so cash-backed earnings score high`),
    excluded: 'a quality measure; the value scores do not read cash flow',
  },
};

/** Each term of a weighted score with its sub-score and what it contributed.

    `weightedScore` renormalises over the weights that are present, so a term
    contributes its sub-score times its share of the PRESENT weight, not of the
    nominal total. Computed that way the column sums to the number on the board
    even when an indicator is missing — which is the only thing that makes a
    breakdown worth showing. */
function domainBreakdown(row, d) {
  const weights = SCORE_WEIGHTS[d.weights] || [];
  const parts = subScores(row);
  const present = weights.reduce((sum, [field, w]) => sum + (parts[field] == null ? 0 : w), 0);

  const used = weights.map(([field, weight]) => {
    const term = SUBSCORE_TERMS[field];
    const score = parts[field];
    return {
      name: term.name,
      input: term.read(row),
      weight,
      score,
      share: score == null || !present ? null : weight / present,
      contribution: score == null || !present ? null : (score * weight) / present,
    };
  });

  /* Sub-scores this domain does not use, listed and zeroed rather than
     omitted. They are on the board, so their absence from the table would read
     as an oversight rather than as the decision it is. */
  const names = new Set(weights.map(([field]) => field));
  const excluded = Object.entries(SUBSCORE_TERMS)
    .filter(([field]) => !names.has(field))
    .map(([field, term]) => ({
      name: term.name,
      input: parts[field] == null ? term.read(row) : `${term.read(row)} — ${term.excluded}`,
      excluded: true,
    }));

  return { used, excluded };
}

function technicalBreakdownHTML(row, d) {
  if (row.pxNote) return `<p class="muted">Not scored — ${esc(row.pxNote)}.</p>`;

  const score = row[d.field];
  if (score == null) {
    return `<p class="muted">Not enough price history for a ${esc(plainLabel(d.label))} score: ${row.bars || 0} bar${
      row.bars === 1 ? '' : 's'} stored, and the terms that do resolve carry under ${
      (SCORE_MIN_WEIGHT * 100).toFixed(0)}% of the weight between them.</p>`;
  }

  const { used, excluded } = domainBreakdown(row, d);
  const renormalised = used.some((t) => t.score == null);

  /* `term-active` is the row that actually carries the score. Eight of nine
     read `0%` and `—`, and the one doing the work differed only by having
     numbers in it — presentational only, nothing downstream reads the class. */
  const usedRows = used.map((t) => `<tr class="${
    t.score == null ? 'term-absent' : t.weight > 0 ? 'term-active' : ''}">
      <th scope="row">${esc(t.name)}</th>
      <td class="term-input">${esc(t.input)}</td>
      <td class="num">${t.score == null ? '—' : t.score.toFixed(1)}</td>
      <td class="num muted">${(t.weight * 100).toFixed(0)}%${
        t.share != null && Math.abs(t.share - t.weight) > 0.005
          ? ` → ${(t.share * 100).toFixed(0)}%` : ''}</td>
      <td class="num">${t.contribution == null ? '—' : t.contribution.toFixed(1)}</td>
    </tr>`).join('');

  const excludedRows = excluded.map((t) => `<tr class="term-absent">
      <th scope="row">${esc(t.name)}</th>
      <td class="term-input">${esc(t.input)}</td>
      <td class="num">—</td>
      <td class="num muted">0%</td>
      <td class="num">—</td>
    </tr>`).join('');

  return `<table class="mini-table breakdown">
      <thead>
        <tr>
          <th scope="col">Indicator</th>
          <th scope="col">Reading</th>
          <th class="num" scope="col" title="The indicator mapped onto 0–100">Sub-score</th>
          <th class="num" scope="col" title="Nominal weight, and its share of the weight actually present">Weight</th>
          <th class="num" scope="col">Contribution</th>
        </tr>
      </thead>
      <tbody>
        ${usedRows}
        ${excludedRows}
        <tr class="total">
          <th scope="row">${esc(plainLabel(d.label))}</th>
          <td class="term-input">sum of the contributions above</td>
          <td class="num">—</td>
          <td class="num muted">100%</td>
          <td class="num">${d.format(score)}</td>
        </tr>
      </tbody>
    </table>${renormalised
      ? '<p class="breakdown-note">An indicator is short of bars, so the remaining weights were renormalised — the arrow in the weight column shows what each term actually counted for.</p>'
      : ''}${evidenceHTML(d)}`;
}

/** What a score's status rests on, and what would move it.

    Rendered wherever a score explains itself, because a tag on its own invites
    the reader to fill in the reason — and for `external` the reason is exactly
    what varies. The momentum tag and the analyst tag look identical and are not
    remotely equivalent: one has decades of replication and accumulating windows,
    the other rests on a weak-to-negative literature and cannot be backtested at
    all. Showing the tag without the note would flatten that. */
function evidenceHTML(s) {
  if (!s || (!s.evidence && !s.pathOut && !s.caveat)) return '';
  const r = rules(s);
  return `<div class="evidence">
      <p class="evidence-head"><span class="status-tag status-${esc(r.tag)}">${esc(r.tag)}</span>
        ${esc(plainLabel(s.label))}</p>
      ${s.evidence ? `<p><strong>Rests on:</strong> ${esc(s.evidence)}</p>` : ''}
      ${s.pathOut ? `<p><strong>What would move it:</strong> ${esc(s.pathOut)}</p>` : ''}
      ${s.caveat ? `<p class="caveat"><strong>Known limit:</strong> ${esc(s.caveat)}</p>` : ''}
    </div>`;
}

/** The four fundamentals scores side by side, each with its reading.

    Separate from `technicalBreakdownHTML` because that one explains an absent
    score in bars — "not enough price history" — and these are absent for
    entirely different reasons. It also shows all four rather than one score's
    terms: each of these IS a single term, so a per-score breakdown would be a
    one-row table four times over. */
function fundamentalsBreakdownHTML(row) {
  const parts = subScores(row);
  const scores = domain('fundamentals').scores;

  /* DISPLAY ONLY — deliberately not a score. Sector explains 13.2% of the
     variance in earnings yield and 20.6% in book-to-market, so a sector-relative
     factor would re-rank one name in five, concentrated in Utilities and
     Energy, at the cost of a fifth registered score in a domain whose one-third
     weight already rests on a thinner argument than this file once recorded.

     The complaint it answers is real though: a brief flagged FANG at 38.3x
     against Energy peers at 11.8x, and the board showed only that FANG was
     below the board median. It was 390th of 495 board-wide and 28th of 29
     within Energy — the same conclusion, much sharper. Context, not weight. */
  const sectorMedian = (field) => {
    if (!row.sector) return null;
    const peers = [...state.rows.values()]
      .filter((r) => r.sector === row.sector && r.symbol !== row.symbol && r[field] != null)
      .map((r) => r[field])
      .sort((a, b) => a - b);
    /* Eight is arbitrary but the direction is not: a "sector median" from three
       names invites a comparison it cannot support. */
    if (peers.length < 8) return null;
    return { median: peers[Math.floor(peers.length / 2)], n: peers.length };
  };

  const RAW_FOR_SCORE = { earnYieldOnly: 'earnYield', bookToMktOnly: 'bookToMkt',
    roeOnly: 'roe', accrualsOnly: 'accruals' };
  const FMT = {
    earnYield: (v) => `${(v * 100).toFixed(2)}%`,
    bookToMkt: (v) => v.toFixed(3),
    roe: (v) => `${(v * 100).toFixed(1)}%`,
    accruals: (v) => v.toFixed(3),
  };

  const body = scores.map((s) => {
    const term = SUBSCORE_TERMS[SCORE_WEIGHTS[s.weights][0][0]];
    const value = row[s.field];
    const raw = RAW_FOR_SCORE[s.field];
    const peer = raw ? sectorMedian(raw) : null;
    /* Which side of its sector, in words, because the raw comparison is only
       useful if the reader knows which direction is better — and for accruals
       lower is better, which is the opposite of the other three. */
    const side = peer && row[raw] != null
      ? (row[raw] === peer.median ? 'at' : row[raw] > peer.median ? 'above' : 'below')
      : null;
    return `<tr${value == null ? ' class="term-absent"' : ''}>
        <th scope="row">${esc(plainLabel(s.label))}</th>
        <td class="term-input">${esc(term.read(row))}${peer ? `<span class="sector-peer" title="${esc(
          `Median ${plainLabel(s.label)} across the ${peer.n} other ${row.sector} names on the board that have one. `
          + 'Shown for context and NOT scored: the factor is ranked against all 560 names, so a '
          + 'name cheap against the board can be expensive against its own sector. Sector explains '
          + '13% of the spread in earnings yield and 21% in book-to-market, which is why this is a '
          + 'note rather than a separate score.')}"> · ${row.sector} median ${
          esc(FMT[raw] ? FMT[raw](peer.median) : peer.median.toFixed(3))}${
          side ? `, this name ${side}` : ''}</span>` : ''}</td>
        <td class="num">${value == null ? '<span class="muted">—</span>' : value.toFixed(1)}</td>
      </tr>`;
  }).join('');

  const scored = scores.filter((s) => row[s.field] != null).length;

  /* Provenance sits with the readings, not in a tooltip on a board column. A
     reader who has opened the panel is asking where the number came from, and
     "checked against what" is part of that answer. */
  const provenance = row.fxWithheld
    ? `<p class="breakdown-note fx-withheld"><b>Withheld by the reconciliation gate</b> — ${
      esc(row.fxWithheld)}. The figures were computed and then refused: this is a
      finding about the filings, not a gap in them.</p>`
    : `<p class="breakdown-note fx-note-unverified"><b>How far these were checked.</b>
        Every figure is reconciled before it is shown: a differenced year-to-date cumulation
        must match the discrete quarter covering the same period — two independently filed
        numbers, and 20,024 of 21,698 such checks across the board are exactly zero.
        <b>Net income</b> ${row.fxNiVerified === false
          ? '<em>could not be checked</em> — this filer publishes no discrete quarterly net income. Only 9 of 561 symbols are in this position. The check did not fail; there was nothing to run it against.'
          : row.fxNiVerified === true
            ? 'is reconciled, so earnings yield and return on equity rest on a figure that was cross-checked.'
            : 'has no figure here.'}
        <b>Operating cash flow</b> ${row.fxOcfVerified === false
          ? '<em>is not reconciled</em>, and for 545 of 561 symbols it cannot be: filers publish only Q1 of cash flow as a discrete quarter, so there is nothing to compare the rest against. That is a standing limit of what EDGAR contains rather than anything about this company — and it means the cash-flow half of accruals is the least-verified input on this panel.'
          : row.fxOcfVerified === true
            ? 'is reconciled too, which only 16 symbols manage.'
            : 'has no figure here, so accruals are absent.'}</p>`;

  return provenance + `<table class="mini-table breakdown">
      <thead>
        <tr>
          <th scope="col">Factor</th>
          <th scope="col">Reading</th>
          <th class="num" scope="col" title="The reading mapped onto 0–100 by its own tanh curve">Score</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot>
        <tr class="total">
          <th scope="row">Scored</th>
          <td class="term-input">${scored} of ${scores.length}${
            scored < scores.length ? ' — an absent factor is a statement, not a gap; see each reading' : ''}</td>
          <td class="num">—</td>
        </tr>
      </tfoot>
    </table>`;
}

/** The Fundamentals body: the four readings, their inputs, and the filing that
    made each knowable. The filing date is the point of showing it — a figure is
    not usable before it was filed, whatever period it describes. */
function fundamentalsDetailHTML(row, dom) {
  const rec = state.fx.facts.get(row.symbol);
  if (!rec) {
    return `<div class="detail-body"><div class="detail-main">
      <p class="muted">No filings stored for ${esc(row.symbol)}. Use “Fetch fundamentals” on the board to
      retrieve them from SEC EDGAR — the pass is explicit and never runs on its own.</p>
      ${evidenceHTML(primaryScore(dom))}
    </div></div>`;
  }

  const ni = fxTTM(rec.f.netIncome);
  const eq = fxLatest(rec.f.equity);
  const as = fxLatest(rec.f.assets);
  const sh = fxLatest(rec.f.shares);
  const paired = fxPaired(rec.f.netIncome, rec.f.operatingCF);
  const money = (v) => (v == null ? '—' : `$${(v / 1e9).toFixed(2)}B`);

  const stats = [
    ['CIK', String(rec.cik)],
    ['Net income (TTM)', ni ? `${money(ni.v)} · ${ni.basis} to ${ni.end} · filed ${ni.filed}` : '—'],
    ['Equity', eq ? `${money(eq.v)} · ${eq.e} · filed ${eq.f}` : '—'],
    ['Assets', as ? `${money(as.v)} · ${as.e} · filed ${as.f}` : '—'],
    ['Shares out', sh ? `${(sh.v / 1e6).toFixed(1)}M · ${sh.e}` : '—'],
    ['Market cap', row.price != null && sh ? money(row.price * sh.v) : '—'],
    ['Accrual basis', paired ? `${paired.basis} to ${paired.end}` : '—'],
    ['Restatements held', String(Object.values(rec.f).reduce((n, a) => n + a.reduce((m, x) => m + x.r.length, 0), 0))],
    ['Fetched', new Date(rec.at).toLocaleString()],
  ];

  return `<div class="detail-body">
      <div class="detail-main">
        <section>
          <h3 class="section-title">Value and quality</h3>
          ${fundamentalsBreakdownHTML(row)}
        </section>
        ${evidenceHTML(primaryScore(dom))}
      </div>
      <div>
        <h3 class="section-title">Filings</h3>
        <dl class="stats">
          ${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
      </div>
    </div>`;
}

/** The Technicals body: price, the headline score's breakdown, and what is
    stored. */
function technicalDetailHTML(row, dom) {
  const series = state.px.series.get(row.symbol);
  const bars = row.bars || 0;
  /* The breakdown is of the domain's headline score — currently Mom 12−1 —
     which is what the board is ranked by. Every other registered score appears
     in the stats beside it, each flagged with its own status. */
  const d = primaryScore(dom);

  /* GROUPED, and the first split is the one that matters: SCORES are 0-100 on
     a common scale, READINGS are signed percentages and raw counts. Run as one
     flat list they read as sixteen comparable numbers, and `68.0` (a score)
     sat at the same weight as `+14.8%` (a return) — the same score-versus-
     direction collision the board's colour rule exists to prevent, reproduced
     in miniature by layout instead of by hue. */
  const scoreGroups = [];
  for (const x of allScores()) {
    const label = x.domain.label;
    let g = scoreGroups.find((s) => s.label === label);
    if (!g) { g = { label, rows: [] }; scoreGroups.push(g); }
    g.rows.push([
      `${plainLabel(x.label)}${rules(x).sortable ? '' : ' (failed)'}`,
      row[x.field] == null ? '—' : x.format(row[x.field]),
    ]);
  }

  const groups = [
    ...scoreGroups,
    { label: 'Raw readings', rows: [
      ['Momentum 6−1', row.mom6m1m == null ? '—' : `${fmtSigned(row.mom6m1m, 1)}%`],
      [`vs ${MA_WINDOW}-day`, row.maGap == null ? '—' : `${fmtSigned(row.maGap, 1)}%`],
      ['RSI 14', row.rsi14 == null ? '—' : row.rsi14.toFixed(0)],
      ['52-week position', row.rangePos == null ? '—' : `${row.rangePos.toFixed(0)}%`],
    ] },
    { label: 'Stored', rows: [
      ['Bars stored', bars ? `${bars}${bars >= 252 ? ` · ~${(bars / 252).toFixed(1)} years` : ''}` : 'none'],
      ['History covers', series ? `${fmtLocalDay(series.f)} → ${fmtLocalDay(series.t)}` : '—'],
      ['Oldest requested', series && series.bf ? fmtLocalDay(series.bf) : 'not yet extended'],
      ['Scoring', row.pxNote ? `Withheld — ${row.pxNote}` : 'Scored from the stored series'],
      ['Sector', row.sector || '—'],
      ['Price as of', row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : '—'],
    ] },
  ];

  return `<div class="detail-body">
      <div class="detail-main">
        <section>
          <h3 class="section-title">Price${bars ? ` · ${bars} stored bars` : ''}</h3>
          ${technicalPriceSectionHTML(row)}
        </section>
        <section>
          <h3 class="section-title">${esc(plainLabel(d.label))} score breakdown${
            rules(d).sortable ? '' : ' <span class="status-tag status-failed">failed</span>'}</h3>
          ${technicalBreakdownHTML(row, d)}
        </section>
      </div>
      <div>
        <h3 class="section-title">Snapshot</h3>
        ${snapshotHTML(groups)}
      </div>
    </div>`;
}

/** A grouped snapshot column. Empty groups drop out rather than rendering a
    heading over nothing. */
function snapshotHTML(groups) {
  return groups.filter((g) => g.rows.length).map((g) => `
      <section class="snap-group">
        <h4 class="snap-head">${esc(g.label)}</h4>
        <dl class="stats">
          ${g.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
      </section>`).join('');
}

/* Renders content only — showView owns whether the panel is visible, so a
   re-render triggered mid-load cannot pull the view out from under the user. */
function renderDetail(symbol) {
  const row = state.rows.get(symbol);
  const panel = $('#detail');
  if (!row || !row.loaded) {
    panel.innerHTML = `<p class="empty">${
      row ? 'Still loading this symbol…' : 'That symbol is no longer on the board.'
    }</p>`;
    return;
  }

  const p = row.profile || {};
  const q = row.quote || {};
  const chgCls = row.changePct == null ? '' : row.changePct >= 0 ? 'up' : 'down';

  /* One panel, one tab per registered domain, each rendering the detail view
     that domain declared. The same view appears whether the symbol was opened
     from Overall or from that domain's own section — which tab is open differs,
     what a tab shows does not. */
  const active = DOMAINS_BY_ID.has(state.detailTab) ? state.detailTab : defaultDetailTab();
  const d = domain(active);

  const tabs = SCORE_DOMAINS.map((x) => {
    const s = primaryScore(x);
    const on = x.id === active;
    return `<button class="tab${on ? ' tab-active' : ''}" type="button" role="tab"
        data-detail-tab="${esc(x.id)}" aria-selected="${on}"
        title="${esc(`${plainLabel(x.label)} — ${plainLabel(s.label)} is ${s.status}`)}">${esc(plainLabel(x.label))}<span
        class="status-dot status-${esc(rules(s).tag)}" aria-hidden="true"></span></button>`;
  }).join('');

  panel.innerHTML = `
    <div class="detail-head">
      <button id="detail-back" class="btn btn-ghost btn-sm detail-back" type="button"
              aria-label="Back to the board">← Board</button>
      ${p.logo ? `<img class="detail-logo" src="${esc(p.logo)}" alt="" onerror="this.remove()">` : ''}
      <div class="detail-title">
        <h2>${esc(row.name)} <span class="muted">${esc(row.symbol)}</span></h2>
        <p>${esc(p.finnhubIndustry || d.blurb)}${
          p.weburl ? ` · <a href="${esc(p.weburl)}" target="_blank" rel="noopener">Website</a>` : ''
        }</p>
      </div>
      <div class="detail-price">
        <div class="p">${row.price == null ? '—' : fmtNum(row.price)}</div>
        <div class="c ${chgCls}">${
          Number.isFinite(q.d) ? `${q.d > 0 ? '+' : ''}${fmtNum(q.d)} (${fmtPct(row.changePct)})` : ''
        }</div>
      </div>
    </div>
    <div class="detail-tabs tabs" role="tablist" aria-label="Domain">${tabs}${overallChipHTML(row)}</div>
    ${registeredNotCountedHTML(row)}
    <div id="assess-verdict"></div>
    ${d.detail(row, d)}
    <div id="assess-brief"></div>`;

  /* Async, and appended after the domain view rather than inside it: an
     assessment belongs to the symbol, not to any one domain's tab. */
  /* One read, two mounts. The verdict goes above the domain body and the brief
     below it, so a symbol with no assessment leaves both empty rather than
     leaving a gap where one of them would have been. */
  loadAssessments(symbol).then((log) => {
    const top = $('#assess-verdict');
    const bottom = $('#assess-brief');
    if (top) top.innerHTML = assessVerdictHTML(log);
    if (bottom) bottom.innerHTML = assessBriefHTML(log);

    /* A jump from the Recent strip lands here rather than in the click handler,
       because this is the moment the brief exists and has a height.

       `scrollY === 0` is the re-apply condition and it is doing real work: the
       second render of this panel drops the page to the top, and that is the
       only state in which jumping again is right. Once the reader has scrolled
       anywhere at all, this stops moving the page under them.

       Instant, not smooth: a smooth scroll interrupted by the second render is
       a visible slide to nowhere. */
    if (scrollToBriefFor === row.symbol && bottom?.firstChild && window.scrollY === 0) {
      bottom.scrollIntoView({ block: 'start' });
    }
  }).catch(() => {});
}

/** The horizon split, rendered under the rating.

    ADDED 2026-09-01, and late. The split shipped its schema, its parsing, its
    entry version bump and its whole harness on the same day — and no display.
    So three fields arrived from the model, passed validation, and were written
    to disk with nothing on screen to show them, for every assessment run in
    between. The 400 that preceded this was the better failure of the two: a
    field that never arrives is visible on the first attempt, and a field that
    arrives and is silently unrendered looks exactly like one that was refused.

    Reads only from the stored entry, so an older assessment renders whatever it
    happens to carry and one predating the split renders nothing at all. */
function horizonSplitHTML(a) {
  const call = (n, why, label, horizon) => (validCall(n) ? `
      <div class="brief-call">
        <span class="brief-call-n">${n}<span class="brief-call-d">/10</span></span>
        <div class="brief-call-body">
          <h5>${esc(label)} <span class="brief-call-horizon">${esc(horizon)}</span></h5>
          <p>${esc(why || '—')}</p>
        </div>
      </div>` : '');

  const near = call(a.callNear, a.callNearWhy, 'Near-term',
    'next quarter — the setup');
  const long = call(a.callLong, a.callLongWhy, 'Long-term',
    'one to three years — the business');

  /* Five states now, and none of them may collapse into another: a level that
     cited a board figure and was kept; a level refused on receipt; "the price
     is fine" — a POSITION, and the one most likely to be misread as an
     omission; "I want lower but cannot name a level"; and nothing to build
     from, which stays silent because it is the only one that is not a claim. */
  let level = '';
  if (Number.isFinite(a.entryLevel)) {
    const pct = Number.isFinite(a.entryLevelPct) ? a.entryLevelPct : null;
    const at = Number.isFinite(a.priceAt) ? ` $${a.priceAt.toFixed(2)} at assessment` : ' the price at assessment';
    const sig = Number.isFinite(a.entryLevelSigmas)
      ? ` <span class="brief-entry-pct">${Math.abs(a.entryLevelSigmas).toFixed(2)}&sigma; below, on a quarter</span>` : '';
    level = `
      <div class="brief-entry">
        <h5>Entry level <span class="brief-entry-n">$${a.entryLevel.toFixed(2)}</span>${
          pct === null ? '' : ` <span class="brief-entry-pct">${
            pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs${esc(at)}</span>`}${sig}</h5>
        <p>${esc(a.entryLevelBasis || '—')}</p>
      </div>`;
  } else if (a.entryLevelRejected) {
    /* THE PRICE WAS REFUSED; THE INTENT WAS NOT. Without this line a refusal
       says a number was rejected and nothing about whether the model wanted to
       wait or was happy to buy at the current price — which is the more useful
       half of the answer and was already stored. */
    const declaredLine = {
      level: 'It was giving a level, so the near-term view was <b>wait for a better price</b> — '
        + 'only the price it named was refused.',
      at_market: 'It also declared <b>at market</b>, which contradicts giving a level at all. '
        + 'Both are recorded; neither is repaired.',
      outside_band: 'It declared <b>outside band</b> — wanting a lower entry than any anchor supports.',
      no_anchor: 'It declared <b>no anchor</b>, which contradicts naming a price. '
        + 'Both are recorded; neither is repaired.',
    }[a.entryStanceDeclared];

    level = `
      <div class="brief-entry brief-entry-rejected">
        <h5>Entry level refused &mdash; ${esc(a.entryLevelRejected)}</h5>
        ${declaredLine ? `<p class="brief-entry-declared">${declaredLine}</p>` : ''}
        ${a.entryLevelBasis ? `<p class="brief-entry-quoted">${esc(a.entryLevelBasis)}</p>` : ''}
        <p>A level has to be arithmetic on a price the board actually supplied. One
        that cites a figure from anywhere else is dropped on receipt rather than
        stored &mdash; being right is not the same as being supported, and the log
        records what the board could support. The refusal is kept, with the line that
        caused it, because "none was offered" and "one was offered and rejected" are
        different facts about the model, and because a rejection nobody can audit is
        itself a silent failure.</p>
      </div>`;
  } else if (a.entryStance === 'at_market') {
    level = `
      <div class="brief-entry">
        <h5>No entry level &mdash; <span class="brief-entry-n">the current price is acceptable</span></h5>
        <p>The model expects no materially better entry inside the quarter. This is a
        position, not a missing answer, and the harness scores it as one: it counts in
        the wait-versus-buy comparison as a buy-now case rather than being dropped.</p>
      </div>`;
  } else if (a.entryStance === 'outside_band') {
    level = `
      <div class="brief-entry brief-entry-rejected">
        <h5>No entry level &mdash; every anchor sits outside the quarter's band</h5>
        <p>A lower entry is wanted, but no figure the board supplied yields one within
        one sigma of the price. That is "wait" without a price to wait for, so there is
        nothing to score either way &mdash; recorded rather than dropped, because a
        model that keeps landing here is saying the band is set wrong.</p>
      </div>`;
  }

  if (!near && !long && !level) return '';

  return `<div class="brief-calls">
      <h4 class="brief-calls-head">The horizon split</h4>
      ${near}${long}${level}
      <p class="brief-calls-note">Two calls rather than one, because the board's
      factors operate over about a quarter and a judgment about a business operates
      over years. They are allowed to disagree, and a good business at a stretched
      entry is the case the split exists for &mdash; so do not read agreement as
      confirmation. Neither has been measured against anything: the harness needs
      entries 30 days old, and the first of these was written on 2026-09-01.</p>
    </div>`;
}

/** The assessment log for one symbol. Newest in full, older ones collapsed. */
function assessVerdictHTML(log) {
  if (!log.length) return '';
  const a = log[0];
  const when = new Date(a.at).toLocaleString();

  return `<div class="assess-log assess-verdict-block">
      <h3 class="section-title">Assessment
        <span class="muted">${esc(when)} · ${esc(ASSESS_MODELS[a.model]?.label || a.model)}
          · <span title="Estimated locally from this call's token counts, not billed cost">est. $${a.usage.usd.toFixed(4)}</span></span>
      </h3>

      ${predatesFxFix(a) ? `<div class="brief-stale">
        <b>Predates the fundamentals fix of 2026-08-31.</b> The board context in this brief
        was computed over a 15-month window — earnings yield, return on equity and accruals
        were built from four non-consecutive quarters. Whatever this brief says about them
        rests on figures since withdrawn. Kept unedited: it records what the model was shown.
      </div>` : ''}

      <!-- THE VERDICT, FIRST. Reading order changed 2026-09-01, deliberately
           and with sign-off: the chart and the score breakdown are reference
           you consult, the rating and the horizon split are the panel's output.
           Output goes first. -->
      <div class="verdict">
      ${Number.isInteger(a.rating) ? `<div class="brief-rating">
        <span class="brief-rating-n">${a.rating}<span class="brief-rating-d">/10</span></span>
        <div class="brief-rating-body">
          <h5 class="brief-rating-label">Overall rating <span class="brief-call-horizon">no stated horizon</span></h5>
          <p class="brief-rating-basis">${esc(a.ratingBasis || '—')}</p>
          <!-- CLOSED BY DEFAULT, AND THE CHIP IS LOUD. This text is the only
               thing standing between a reader and treating the rating as a
               signal, and the three findings in it are the strongest evidence
               in the project — so it is quiet, not hidden. The summary carries
               the status chip and the headline number; the reasoning is one
               click away rather than five lines of muted prose competing with
               the figure it qualifies. -->
          <details class="brief-caveat">
          <summary>
            <span class="status-tag status-${esc(STATUS_RULES[STATUS.UNSUPPORTED].tag)} status-loud"
              title="${esc(STATUS_RULES[STATUS.UNSUPPORTED].title)}">${esc(STATUS_RULES[STATUS.UNSUPPORTED].tag)}</span>
            <span class="brief-caveat-lead">Not a signal &mdash; +0.71 correlated with the board, two thirds noise.</span>
          </summary>
          <p class="brief-rating-warn">
            The only field on this board with <b>no external evidence of any kind</b>, and
            the three things measured about it are all bad. It correlates <b>+0.71</b> with
            the composite of the scores shown above, so half of it restates the board rather
            than adding to it. Repeating the same symbol on the same model moves it by
            <b>0.63</b> on average against a spread of 0.99 &mdash; about two thirds of its
            range is noise. And every rating so far has landed between 3 and 8, leaving the
            harness&rsquo;s top bucket empty and its spread uncomputable. It cannot sort,
            filter or enter the backtest. Read it as one model&rsquo;s summary of the panel
            beside it, not as information the panel lacks.
          </p>
          </details>
        </div>
      </div>` : ''}

      ${horizonSplitHTML(a)}
      </div>
    </div>`;
}

/** The written half of the assessment: how the brief was made, then the four
    prose sections and the sources.

    SPLIT FROM THE VERDICT, 2026-09-01. The judgments — rating, both calls, the
    entry level — are the model's OUTPUT and sit above the charts. Everything
    here is the model's READING, and it belongs after the board's own evidence:
    a reader should meet the price history and the score breakdown before the
    prose that interprets them, or the interpretation frames the data instead of
    the other way round.

    The metadata rows lead this half rather than the whole panel. They describe
    how the brief was made, which is the right preface to the brief and the
    wrong preface to a verdict. */
function assessBriefHTML(log) {
  if (!log.length) return '';
  const a = log[0];
  const sec = (title, text) => `<section class="brief-section">
      <h4>${esc(title)}</h4><p>${esc(text || '—')}</p></section>`;

  const tags = (list, cls) => (list.length
    ? list.map((t) => `<span class="brief-tag ${cls}">${esc(t.replace(/_/g, ' '))}</span>`).join('')
    : '<span class="muted">none</span>');

  /* Coverage is stated, not implied. A brief built on two sources and one built
     on twenty read identically; only this line distinguishes them. */
  const cov = a.coverage;
  const covLine = a.searchStatus === 'completed'
    ? `${cov.distinctSources} distinct source${cov.distinctSources === 1 ? '' : 's'} from ${cov.searches} search${cov.searches === 1 ? '' : 'es'} — <b>${cov.band}</b> coverage`
    : `search ${esc(a.searchStatus)} — this brief rests on the board context alone`;

  return `<div class="assess-log assess-brief-block">
      <h3 class="section-title">What the model read into it</h3>

      <div class="brief-meta ${cov.band === 'thin' || cov.band === 'none' ? 'brief-thin' : ''}">
        <span>${covLine}</span>
        ${a.dataQualityFlags.length
          ? `<span class="brief-flagcount" title="${esc(a.dataQualityFlags.join(' | '))}">${a.dataQualityFlags.length} data-quality flag${a.dataQualityFlags.length === 1 ? '' : 's'} passed in${a.dataQualityLed ? ', led with' : ' — NOT led with'}</span>`
          : '<span class="muted">no data-quality flags</span>'}
      </div>

      <div class="brief-tags">
        <span class="brief-tag-label">Events</span>${tags(a.concerns, 'tag-event')}
        <span class="brief-tag-label">Structural</span>${tags(a.structural, 'tag-structural')}
      </div>

      ${a.directional?.flagged ? `<div class="brief-directional" title="${esc(
        a.directional.matches.map((m) => `[${m.section}] ${m.context}`).join('\n\n'))}">
        <b>Directional language detected</b> — ${a.directional.count} match${a.directional.count === 1 ? '' : 'es'}
        (${esc([...new Set(a.directional.matches.map((m) => m.pattern.replace(/_/g, ' ')))].join(', '))}).
        Recorded, not removed: the brief below is unedited. Hover for the phrases.
      </div>` : ''}

      ${sec('What the board says', a.brief.board_says)}
      ${sec('What has happened recently', a.brief.recent_events)}
      ${sec('What could break this', a.brief.what_could_break)}
      ${sec('What is uncertain', a.brief.uncertain)}

      ${a.sources.length ? `<section class="brief-section"><h4>Sources</h4><ol class="brief-sources">${
        a.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${
          esc(s.title || s.url)}</a>${s.date ? ` <span class="muted">${esc(s.date)}</span>` : ''}</li>`).join('')
      }</ol></section>` : ''}

      ${log.length > 1 ? `<p class="muted brief-older">${log.length - 1} earlier assessment${
        log.length === 2 ? '' : 's'} in the log, oldest ${new Date(log[log.length - 1].at).toLocaleDateString()}.</p>` : ''}
    </div>`;
}

/** Domains that are registered and scored but do not feed Overall.

    Shown next to the Overall chip on every tab, because a reader looking at
    Overall has no other way to tell that a whole domain exists and is being
    left out — the chip lists contributors, and a non-contributor is invisible
    in it by construction. Deliberately styled apart from the contributions and
    labelled "not in Overall": the point is to surface the readings WITHOUT
    implying they are in the number. */
function registeredNotCountedHTML(row) {
  const outside = SCORE_DOMAINS.filter((d) => d.inOverall === false);
  if (!outside.length) return '';

  const blocks = outside.map((d) => {
    const scored = d.scores.filter((s) => row[s.field] != null);
    if (!scored.length) {
      return `<span class="aside-domain"><b>${esc(plainLabel(d.label))}</b>
        <span class="muted">no reading</span></span>`;
    }
    const chips = scored.map((s) => `<span class="aside-part" title="${esc(
      `${plainLabel(s.label)} (${s.status}): ${s.format(row[s.field])} of 100. `
      + `Registered and scored, and deliberately not an input to Overall.`)}">${
      esc(plainLabel(s.label))} <b>${s.format(row[s.field])}</b></span>`).join('');
    return `<span class="aside-domain"><b>${esc(plainLabel(d.label))}</b>${chips}</span>`;
  }).join('');

  return `<div class="detail-aside" title="Registered domains that are scored but not counted in Overall">
      <span class="aside-tag">not in Overall</span>${blocks}
    </div>`;
}

/** Overall, shown beside the domain tabs with each contribution and its status,
    so an untested input is visibly untested wherever the breakdown appears. */
function overallChipHTML(row) {
  const o = overallFor(row);
  if (o.value == null) return '<span class="overall-chip muted">Overall —</span>';

  /* Each domain's contribution AND its share of the weight, so the balance is
     readable rather than assumed. A domain that is missing pushes the others'
     shares up, and showing the share is how that becomes visible instead of
     silently changing what the number means. */
  const parts = o.parts.map((p) => {
    const r = rules(p.score);
    return `<span class="overall-part" title="${esc(
      `${p.domain.label} contributes its ${p.score.label} score (${p.score.status}): `
      + `${p.score.format(p.raw)} on its own scale → ${p.norm.toFixed(1)} of 100, `
      + `weighted ${(p.share * 100).toFixed(0)}% of Overall.`)}">${esc(p.domain.label)}
      <b>${p.norm.toFixed(0)}</b>
      <span class="overall-weight">${(p.share * 100).toFixed(0)}%</span>
      <span class="status-tag status-${esc(r.tag)}">${esc(r.tag)}</span></span>`;
  }).join('');

  return `<span class="overall-chip" title="${esc(
    `Weighted mean of ${o.parts.length} of ${o.of} domains, one score per domain, each normalised to 0–100 by its own scale.`)}">
      <strong>Overall ${o.value.toFixed(1)}</strong>${parts}${
      o.parts.length < o.of
        ? `<span class="overall-weight">${o.parts.length}/${o.of} domains</span>` : ''}</span>`;
}

/** Fetch whatever the open detail tab needs and nothing else.

    A domain that draws from stored prices needs no call at all; the analyst
    panel wants Finnhub candles, which are premium and six months deep against
    ten years already on disk. Gating on the open tab rather than on the board
    means switching tabs fetches lazily, and a tab never spends a call for a
    panel that is not on screen. */
function ensureDetailData(symbol) {
  if (!symbol) return;
  const active = DOMAINS_BY_ID.has(state.detailTab) ? state.detailTab : defaultDetailTab();
  if (!domain(active).needsPrices) ensureCandles(symbol);
}

/** Which tab a symbol opens on: its own domain's when clicked from a domain
    section, Technicals when clicked from Overall (where no domain is implied). */
function defaultDetailTab() {
  return DOMAINS_BY_ID.has('technicals') ? 'technicals' : SCORE_DOMAINS[0].id;
}

const detailTabFor = (sectionId) =>
  (isOverall(sectionId) ? defaultDetailTab() : sectionId);

/** The Analyst body: the recommendation trend and the composite behind it. */
function analystDetailHTML(row) {
  const p = row.profile || {};
  const q = row.quote || {};
  const label = row.raw == null ? null : consensusLabel(row.raw);

  /* The score terms have moved to their own breakdown table, which shows each
     one's contribution rather than just its value. What stays here is the
     material the breakdown does not cover. */
  const stats = [
    ['Composite', row.composite == null ? 'No coverage' : row.composite.toFixed(2)],
    ['Raw mean', row.raw == null ? '—' : `${row.raw.toFixed(2)} · ${label.text}`],
    ['Price target', row.targetMean == null
      ? '—'
      : `${fmtNum(row.targetMean)}${row.targetLow != null && row.targetHigh != null
          ? ` (${fmtNum(row.targetLow)} – ${fmtNum(row.targetHigh)})` : ''}`],
    ['Insider (3mo, P/S)', row.insider == null
      ? (PLAN.insider ? '—' : 'Not on your plan')
      : row.insider.net == null
        ? 'No open-market trades'
        : `${fmtSigned(row.insider.net, 0)} net · +${row.insider.bought.toLocaleString()} / −${row.insider.sold.toLocaleString()} · ${row.insider.trades} trades`],
    ['Analysts', row.analysts == null ? '—' : `${row.analysts}${row.coverageChange == null ? '' : ` (${fmtSigned(row.coverageChange, 0)})`}`],
    ['Latest period', fmtPeriod(row.latest?.period)],
    ['Sector', row.sector || '—'],
    ['Industry', p.finnhubIndustry || (row.profile ? '—' : '…')],
    ['Exchange', p.exchange || (row.profile ? '—' : '…')],
    ['Market cap', row.profile ? fmtCap(p.marketCapitalization) : '…'],
    ['Price as of', row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : '—'],
    ['Open', fmtNum(q.o)],
    ['Day range', q.l && q.h ? `${fmtNum(q.l)} – ${fmtNum(q.h)}` : '—'],
    ['Prev close', fmtNum(q.pc)],
  ];

  return `<div class="detail-body">
      <div class="detail-main">
        <section>
          <h3 class="section-title">Price · 6 months</h3>
          ${priceSectionHTML(row)}
        </section>
        <section>
          <h3 class="section-title">Recommendation trend</h3>
          ${trendHTML(row.trend || [])}
        </section>
        <section>
          <h3 class="section-title">Monthly records</h3>
          ${monthlyTableHTML(row.trend, row.baselinePeriod)
            || '<p class="muted">No monthly records for this symbol.</p>'}
        </section>
        <section>
          <h3 class="section-title">Score breakdown</h3>
          ${breakdownHTML(row)}
          ${evidenceHTML(primaryScore(domain('analyst')))}
        </section>
      </div>
      <div>
        <h3 class="section-title">Snapshot</h3>
        <dl class="stats">
          ${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
      </div>
    </div>`;
}

// ── Rendering: history ──────────────────────────────────────────────

/** The price to measure "change since" against: whatever the board currently
    holds, falling back to the newest recorded price if the symbol is off the
    board (removed, or dropped for lack of coverage). */
function referencePrice(symbol, records) {
  const live = state.rows.get(symbol);
  if (live && live.price != null) return { price: live.price, source: 'current board price' };
  const newest = records.find((r) => r[H.PRICE] != null);
  return newest
    ? { price: newest[H.PRICE], source: `last recorded ${fmtDay(newest[H.ISO])}` }
    : { price: null, source: null };
}

/** "2026-08-29T14:03:00Z" → "29 Aug 2026" */
function fmtDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "2026-08-29" → "29 Aug 2026". Parsed from its parts rather than handed to
    the Date constructor: a bare date string is read as UTC midnight, which
    renders as the day before anywhere west of Greenwich, and these keys are
    local calendar days. */
function fmtLocalDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return String(day);
  return new Date(y, m - 1, d)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Shared chrome for both history tabs, then whichever one is active. */
function renderHistory() {
  const onBuckets = state.historyTab === HTAB.BUCKETS;

  $('#history-total').textContent =
    `${state.history.length.toLocaleString()} of ${HISTORY_MAX.toLocaleString()} records · ${historySymbols().length} symbols`;

  for (const [id, active] of [['#tab-symbol', !onBuckets], ['#tab-buckets', onBuckets]]) {
    $(id).classList.toggle('tab-active', active);
    $(id).setAttribute('aria-selected', String(active));
  }

  // Each tab owns one picker; the renderers below may hide their own further
  // when there is nothing to pick.
  $('#history-symbol').hidden = onBuckets;
  $('#history-date').hidden = !onBuckets;
  $('#history-by-symbol').hidden = onBuckets;
  $('#history-buckets').hidden = !onBuckets;

  if (onBuckets) renderHistoryBuckets();
  else renderHistorySymbol();
}

function renderHistorySymbol() {
  const select = $('#history-symbol');
  const symbols = historySymbols();

  /* Keep the chosen symbol if it still has records; otherwise fall back to the
     row last opened — `selected` is cleared on the way out of the detail view,
     so the fallback reads `lastViewed` — then to the first symbol logged. */
  if (!symbols.includes(state.historySymbol)) {
    state.historySymbol = symbols.includes(state.lastViewed) ? state.lastViewed : symbols[0] || null;
  }

  select.innerHTML = symbols
    .map((s) => `<option value="${esc(s)}"${s === state.historySymbol ? ' selected' : ''}>${esc(s)} — ${esc(UNIVERSE_NAMES.get(s) || s)}</option>`)
    .join('');
  select.hidden = symbols.length === 0;

  const empty = $('#history-empty');
  if (!state.historySymbol) {
    $('#history-body').innerHTML = '';
    $('#history-meta').textContent = '';
    empty.textContent = state.finnhub.ready
      ? 'No history yet. Records are written when a symbol is fetched from the API — one per symbol per day.'
      : 'No history yet. Set FINNHUB_API_KEY on the server and load the board to start recording.';
    empty.hidden = false;
    return;
  }

  const records = historyFor(state.historySymbol);
  const ref = referencePrice(state.historySymbol, records);

  $('#history-meta').textContent = ref.price == null
    ? `${records.length} records`
    : `${records.length} records · compared against ${fmtNum(ref.price)} (${ref.source})`;

  $('#history-body').innerHTML = records
    .map((r) => {
      const price = r[H.PRICE];
      const pct = ref.price != null && price ? ((ref.price - price) / price) * 100 : null;
      const cls = pct == null ? '' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'muted';
      return `<tr>
        <td title="${esc(r[H.ISO])}">${esc(fmtDay(r[H.ISO]))}</td>
        <td class="num composite-cell">${r[H.COMPOSITE] == null ? '—' : r[H.COMPOSITE].toFixed(2)}</td>
        <td class="num">${r[H.RAW] == null ? '—' : r[H.RAW].toFixed(2)}</td>
        <td class="num">${r[H.ANALYSTS] ?? '—'}</td>
        <td class="num">${price == null ? '—' : fmtNum(price)}</td>
        <td class="num ${cls}">${pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</td>
      </tr>`;
    })
    .join('');

  empty.hidden = true;
}

/** The aggregate: bucket one past day's symbols by what they scored, and show
    what each band has returned since. The "all symbols" row is the control —
    a band only means something measured against it. */
function renderHistoryBuckets() {
  const select = $('#history-date');
  const dates = historyDates();

  /* Default to the oldest day on file. It is the longest horizon the log can
     offer, and the only kind of day where a score has had time to be right or
     wrong; today's records would compare a price against itself. */
  if (!dates.some((d) => d.day === state.historyDate)) {
    state.historyDate = dates.length ? dates[dates.length - 1].day : null;
  }

  select.innerHTML = dates
    .map(({ day, records }) =>
      `<option value="${esc(day)}"${day === state.historyDate ? ' selected' : ''}>${esc(fmtLocalDay(day))} — ${records} logged</option>`)
    .join('');
  select.hidden = dates.length === 0;

  const body = $('#buckets-body');
  const foot = $('#buckets-foot');
  const empty = $('#buckets-empty');
  const meta = $('#history-meta');

  if (!state.historyDate) {
    body.innerHTML = '';
    foot.innerHTML = '';
    meta.textContent = '';
    empty.textContent = state.finnhub.ready
      ? 'No history yet. Records are written when a symbol is fetched from the API — one per symbol per day.'
      : 'No history yet. Set FINNHUB_API_KEY on the server and load the board to start recording.';
    empty.hidden = false;
    return;
  }

  const when = fmtLocalDay(state.historyDate);
  const { rows, unpriced } = returnsForDay(state.historyDate);

  if (!rows.length) {
    body.innerHTML = '';
    foot.innerHTML = '';
    meta.textContent = `${when} · nothing measurable`;
    empty.textContent = unpriced
      ? `${unpriced} symbol${unpriced === 1 ? '' : 's'} logged on ${when}, but the board is not currently pricing any of them. Load the board to compare against live prices.`
      : `No usable records on ${when}. A return needs both a composite and a price at the moment it was logged.`;
    empty.hidden = false;
    return;
  }

  const days = daysSince(state.historyDate);
  meta.textContent = [
    when,
    days == null || days === 0 ? null : `${days} day${days === 1 ? '' : 's'} ago`,
    `${rows.length} symbol${rows.length === 1 ? '' : 's'}`,
    unpriced ? `${unpriced} skipped (not on the board)` : null,
  ].filter(Boolean).join(' · ');

  /* An empty band prints an em dash rather than a zero: no symbols scored in
     that range is a different statement from those symbols going nowhere. */
  const cell = (n) => {
    if (n == null) return '<td class="num muted">—</td>';
    return `<td class="num ${n > 0 ? 'up' : n < 0 ? 'down' : 'muted'}">${fmtPct(n)}</td>`;
  };

  const returns = rows.map((r) => r.ret);

  body.innerHTML = bucketReturns(rows)
    .map((b) => `<tr>
        <td class="composite-cell">${esc(b.label)}</td>
        <td class="num">${b.count}</td>
        ${cell(b.avg)}
        ${cell(b.med)}
      </tr>`)
    .join('');

  foot.innerHTML = `<tr class="agg-total">
      <td>All symbols</td>
      <td class="num">${returns.length}</td>
      ${cell(mean(returns))}
      ${cell(median(returns))}
    </tr>`;

  empty.hidden = true;
}

// ── Rendering: backtest ─────────────────────────────────────────────

/** A signed percentage cell, coloured by direction. */
function pctCell(value, digits = 2, extra = '') {
  const base = `num ${extra}`.trim();
  if (value == null) return `<td class="${base} muted">—</td>`;
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'muted';
  return `<td class="${base} ${cls}">${value > 0 ? '+' : ''}${value.toFixed(digits)}%</td>`;
}

/** Top-minus-bottom spread for every backtestable score, one row per start date.

    The point of the table: read across a row to see whether a window that
    inverted one factor also inverted the others, and read down the Combined
    column to see how often the average holds up when an input does not. The
    footer counts the inversions so that comparison does not have to be made by
    eye across every row. */
function renderSpreadTable(runs) {
  const cut = state.backtest.bucketing;

  /* The spread itself takes no benchmark, and that is not an omission.

     It is top-bucket return MINUS bottom-bucket return, so any benchmark common
     to both ends cancels exactly: (top − SPY) − (bottom − SPY) is the same
     number as top − bottom. A "vs SPY" spread column would be a copy of the
     column beside it. The spread is already market-neutral by construction,
     which is the reason it is the right thing to read across periods.

     What a benchmark does add here is CONTEXT: the market return for the same
     window, so a +20% top bucket in a quarter when everything rose 18% reads
     as what it is. Those go in their own columns, not subtracted from anything.
     Per-bucket benchmarking, where it does not cancel, is in the run tables. */
  const hasBench = runs.some((r) => r.bench != null);
  const context = (run) => `${pctCell(mean(run.all))}${hasBench ? pctCell(run.bench) : ''}`;

  /* This table shows every score at once and does NOT follow the tab — the tab
     picks which score gets the per-date bucket tables below. Switching tabs
     leaving it unchanged reads as a bug otherwise, so the selected score's
     column is highlighted: the tab visibly points at a column that is already
     on screen rather than at nothing. */
  const active = state.backtest.score;
  const mark = (field) => (field === active ? 'col-active' : '');

  const rows = runs.map((run) => `<tr>
      <td class="composite-cell">${esc(fmtLocalDay(run.startDay))}</td>
      ${SCORE_FIELDS.map((field) => pctCell(bucketSpread(run[field][cut]), 2, mark(field))).join('')}
      ${context(run)}
    </tr>`).join('');

  /* The footer rows exist to be read across, so they are taken over the start
     dates where every score is measurable — not over whatever each one happens
     to reach on its own.

     The factors reach different distances back: `mom6` needs 127 bars where the
     twelve-month factors need 253, so the earliest runs score the short-window
     factors and nothing else. Averaging those extra dates into one column would
     put different samples on a row whose whole purpose is comparing them. */
  const comparable = runs.filter((run) =>
    SCORE_FIELDS.every((field) => bucketSpread(run[field][cut]) != null));

  const spreads = (field) =>
    comparable.map((run) => bucketSpread(run[field][cut]));

  const averages = SCORE_FIELDS.map((field) => pctCell(mean(spreads(field)), 2, mark(field))).join('');
  const inversions = SCORE_FIELDS.map((field) => {
    const measured = spreads(field);
    if (!measured.length) return `<td class="num muted ${mark(field)}">—</td>`;
    const down = measured.filter((s) => s < 0).length;
    const cls = down ? 'down' : 'up';
    return `<td class="num ${cls} ${mark(field)}">${down} / ${measured.length}</td>`;
  }).join('');

  /* Counted from SCORE_FIELDS rather than written out: this read "all three"
     from back when there were three, and went on saying it after the registry
     grew to seven. */
  const footNote = comparable.length === runs.length
    ? ''
    : ` <span class="muted">(${comparable.length} of ${runs.length} dates score all ${SCORE_FIELDS.length})</span>`;

  return `<section class="bt-spread">
      <h3 class="bt-run-head">
        <span>${cut === BUCKETING.QUINTILES ? 'Top fifth minus bottom fifth' : 'Top band minus bottom band'}</span>
        <span class="muted">every score, side by side — the tab below picks which
          one gets the per-date tables, not what appears here${cut === BUCKETING.QUINTILES
            ? '. Equal-sized groups, so the columns compare like for like'
            : '. Fixed bands — group sizes differ by score, so read down a column, not across'}
          · a negative spread is an inversion</span>
      </h3>
      <div class="table-scroll">
        <table class="board-table agg-table">
          <thead>
            <tr>
              <th scope="col">Start date</th>
              ${SCORE_FIELDS.map((field) => `<th class="num ${mark(field)}" scope="col"${
                field === active ? ' title="The tab you have selected. This table always shows every score; the tab chooses which one gets the per-date tables below."' : ''
              }>${esc(plainLabel(SCORE_LABELS[field]))}</th>`).join('')}
              <th class="num bench-col" scope="col" title="Mean return of every scored symbol over this window — what the board did, not what a bucket did">All</th>
              ${hasBench ? `<th class="num bench-col" scope="col" title="${esc(BENCHMARK)} return over the same window, located the same way as every symbol's">${esc(BENCHMARK)}</th>` : ''}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr class="agg-total"><td>Average spread${footNote}</td>${averages}${
              pctCell(mean(comparable.map((r) => mean(r.all)).filter((v) => v != null)))
            }${hasBench ? pctCell(mean(comparable.map((r) => r.bench).filter((v) => v != null))) : ''}</tr>
            <tr class="agg-total"><td>Periods inverted</td>${inversions}<td class="num muted">—</td>${
              hasBench ? '<td class="num muted">—</td>' : ''}</tr>
          </tfoot>
        </table>
      </div>
    </section>`;
}

/** The tooltip for one backtest tab.

    Looked up in the SCORES, not the domains. `field` is a score's property — no
    domain has ever carried one — so this searched SCORE_DOMAINS for a key none
    of them have, found undefined for all seven tabs, and gave every one of them
    the Combined blurb. It read as deliberate because the fallback is a real
    sentence. The registry grew scores-within-domains in the 2026-08-31
    restructure and this lookup was never moved down with them.

    Split out of renderBacktest for the same reason as coverageNote: a bug the
    tests cannot reach is a bug that survives. */
function backtestTabTitle(field) {
  const s = allScores().find((x) => x.field === field);
  return s
    ? `${s.domain.label} · ${plainLabel(s.label)} — ${s.status}. ${s.blurb}`
    : 'The average of the combinable scores, for symbols that have all of them. A measurement tool, not a signal.';
}

function renderBacktest() {
  // A saved tab can name a score that no longer has one — a domain demoted to
  // `failed` since it was chosen. Fall back rather than render a dead tab.
  if (!SCORE_FIELDS.includes(state.backtest.score)) state.backtest.score = SCORE_FIELDS[0];

  $('#bt-tabs').innerHTML = SCORE_FIELDS.map((field) => {
    const active = state.backtest.score === field;
    return `<button class="tab${active ? ' tab-active' : ''}" type="button" role="tab"
        data-score="${esc(field)}" aria-selected="${active}"
        title="${esc(backtestTabTitle(field))}">${esc(plainLabel(SCORE_LABELS[field]))}</button>`;
  }).join('');

  $('#bt-months').value = String(state.backtest.months);
  $('#bt-spacing').value = String(state.backtest.spacing);
  $('#bt-bucketing').value = state.backtest.bucketing;

  const host = $('#bt-runs');
  const spread = $('#bt-spread');
  const empty = $('#bt-empty');
  const { earliest, latest } = priceCalendar();

  if (!state.px.series.size) {
    host.innerHTML = '';
    spread.innerHTML = '';
    $('#bt-meta').textContent = '';
    empty.textContent = state.provKeys.polygon
      ? 'No price history stored yet. Open the Technicals board to start the backfill.'
      : 'No price history stored. Connect a Polygon key and run the backfill from the Technicals board.';
    empty.hidden = false;
    return;
  }

  const runs = backtestRuns();
  if (!runs.length) {
    host.innerHTML = '';
    spread.innerHTML = '';
    $('#bt-meta').textContent = `${earliest} to ${latest}`;
    empty.textContent = `The stored history (${earliest} to ${latest}) is not long enough for a ${state.backtest.months}-month holding period. Shorten the period, or let the backfill finish.`;
    empty.hidden = false;
    return;
  }

  /* Spacing below the holding period makes consecutive windows share bars — at
     a 6-month hold and 1-month spacing, five sixths of each window is the
     previous one. The run count then reports rows rather than trials, which is
     exactly how a ten-row reading of two years got mistaken for ten tests. Say
     how many independent windows are actually in there, right where the row
     count is read. */
  const overlapping = state.backtest.spacing < state.backtest.months;
  const independent = overlapping
    ? backtestStartDays(state.backtest.months, state.backtest.months).length
    : runs.length;

  $('#bt-meta').textContent =
    `${runs.length} start ${runs.length === 1 ? 'date' : 'dates'}${
      overlapping ? ` · overlapping, ${independent} independent` : ''
    } · ${state.backtest.months}-month hold · history ${earliest} to ${latest}`;
  $('#bt-meta').classList.toggle('meta-warn', overlapping);
  $('#bt-meta').title = overlapping
    ? `Windows advance every ${state.backtest.spacing} month${state.backtest.spacing === 1 ? '' : 's'} but cover ${state.backtest.months}, so they overlap and move together. Only ${independent} of them are independent. Set "Every" equal to "Hold" for a sample you can count.`
    : '';

  spread.innerHTML = renderSpreadTable(runs);

  const isCombined = state.backtest.score === 'combinedScore';
  /* Only offer the benchmark column when there is a benchmark to show. Before
     the backfill reaches SPY every cell would be a dash, which is noise rather
     than information. */
  const hasBench = runs.some((r) => r.bench != null);

  host.innerHTML = runs.map((run) => {
    const buckets = run[state.backtest.score][state.backtest.bucketing];
    const baseline = mean(run.all);
    const skipped = Object.values(run.skipped).reduce((a, b) => a + b, 0);

    const rows = buckets.map((b) => {
      const avg = mean(b.returns);
      /* Against the baseline, not in isolation: every bucket moved with the
         market over the window, and the only claim worth reading is whether
         this one beat the board. */
      const edge = avg == null || baseline == null ? null : avg - baseline;
      /* Against the market, not just against the board. `vs all` says whether a
         bucket beat the other 578 names; `vs SPY` says whether it beat simply
         holding the index — a bucket can clear the first and fail the second,
         which is the more useful question of the two. */
      const vsBench = avg == null || run.bench == null ? null : avg - run.bench;
      return `<tr>
          <td class="composite-cell">${esc(b.label)}</td>
          <td class="num">${b.returns.length}</td>
          ${pctCell(avg)}
          ${pctCell(median(b.returns))}
          ${pctCell(edge)}
          ${hasBench ? pctCell(vsBench) : ''}
        </tr>`;
    }).join('');

    /* The all-symbols baseline counts every symbol that produced a return, but
       a one-sided name is in none of the combined buckets. Saying so where the
       counts are is better than leaving a reader to find the shortfall. */
    const note = isCombined && run.oneSided
      ? ` · ${run.oneSided} scored on one side only, not bucketed here`
      : '';

    return `<section class="bt-run">
        <h3 class="bt-run-head">
          <span>${esc(fmtLocalDay(run.startDay))}</span>
          <span class="muted">${run.all.length} symbols · ${skipped} skipped${note} · exit ${esc(fmtLocalDay(addMonths(run.startDay, state.backtest.months)))}</span>
        </h3>
        <div class="table-scroll">
          <table class="board-table agg-table">
            <thead>
              <tr>
                <th scope="col">${esc(plainLabel(SCORE_LABELS[state.backtest.score]))} score at start${
                  state.backtest.bucketing === BUCKETING.QUINTILES ? ', by rank' : ''}</th>
                <th class="num" scope="col">Symbols</th>
                <th class="num" scope="col">Avg return</th>
                <th class="num" scope="col">Median return</th>
                <th class="num" scope="col" title="Average return minus the all-symbols average">vs&nbsp;all</th>
                ${hasBench ? `<th class="num" scope="col" title="Average return minus ${esc(BENCHMARK)} over the same window">vs&nbsp;${esc(BENCHMARK)}</th>` : ''}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr class="agg-total">
                <td>All symbols</td>
                <td class="num">${run.all.length}</td>
                ${pctCell(baseline)}
                ${pctCell(median(run.all))}
                <td class="num muted">—</td>
                ${hasBench ? pctCell(baseline == null || run.bench == null ? null : baseline - run.bench) : ''}
              </tr>
              ${hasBench ? `<tr class="agg-total bench-row">
                <td>${esc(BENCHMARK)}</td>
                <td class="num muted">—</td>
                ${pctCell(run.bench)}
                <td class="num muted">—</td>
                <td class="num muted">—</td>
                <td class="num muted">—</td>
              </tr>` : ''}
            </tfoot>
          </table>
        </div>
      </section>`;
  }).join('');

  empty.hidden = true;
}

// ── Rendering: rating harness ───────────────────────────────────────

/** A number and its own standard error in one cell, as `+4.2 ± 13.7`.

    Never one without the other. The whole reason this view exists is that the
    sample is too small for the point estimate to mean anything on its own, and
    a table that prints the estimate large and the error in a footnote is a
    table that will be read as if the error were not there. */
function pmCell(value, se, digits = 1, extra = '') {
  const base = `num ${extra}`.trim();
  if (value == null) return `<td class="${base} muted">—</td>`;
  const sign = value > 0 ? '+' : '';
  const body = `${sign}${value.toFixed(digits)}`;
  if (se == null) return `<td class="${base} muted">${body} <span class="rt-se">± ?</span></td>`;
  /* Coloured only when the estimate clears twice its own error. A green +4.2
     that is ±13.7 is a green number for no reason, and colour is read faster
     than the digits beside it. */
  const clears = Math.abs(value) >= 2 * se;
  const cls = !clears ? 'muted' : value > 0 ? 'up' : 'down';
  return `<td class="${base} ${cls}">${body} <span class="rt-se">± ${se.toFixed(1)}</span></td>`;
}

/* The board context a repeat has to match for the repeat to measure anything.

   `overallParts` is excluded deliberately: it is a structured breakdown of
   `overall`, which is compared directly, so including it would compare the same
   fact twice and would do it by object identity. */
const CONTEXT_EXCLUDE = new Set(['overallParts']);

/** Did these two entries see the same board?

    Exact equality, not a tolerance. A tolerance would need a defensible width
    per score — these are percentile ranks, z-blends and raw ratios on different
    Scales — and inventing one would quietly admit pairs whose inputs moved. */
function sameBoardContext(a, b) {
  const sa = a?.scores; const sb = b?.scores;
  if (!sa || !sb) return false;                 // an unrecorded context is not a matching one
  const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]
    .filter((k) => !CONTEXT_EXCLUDE.has(k)));
  for (const k of keys) {
    const x = sa[k] ?? null; const y = sb[k] ?? null;
    if (x === null && y === null) continue;
    if (x === null || y === null) return false;
    if (typeof x !== 'number' || typeof y !== 'number' || x !== y) return false;
  }
  return true;
}

/** Consecutive same-symbol, same-model rating pairs, each marked clean or not.

    CLEAN REQUIRES BOTH TESTS, and the second is not implied by the first. A
    pair that straddles the fundamentals fix of 03:10Z saw different earnings
    yields, ROEs and accruals by construction — but only if the symbol HAD
    those figures. A name whose fundamentals were null on both sides passes an
    exact score comparison while still spanning a change in what the board
    meant, so the boundary is checked independently rather than trusted to show
    up as a numeric difference. */
function repeatPairs(rated) {
  const bySM = new Map();
  for (const e of rated) {
    const k = `${e.symbol}|${e.model}`;
    if (!bySM.has(k)) bySM.set(k, []);
    bySM.get(k).push(e);
  }
  const out = [];
  for (const v of bySM.values()) {
    if (v.length < 2) continue;
    const s = v.slice().sort((a, b) => a.at - b.at);
    for (let i = 1; i < s.length; i++) {
      const [prev, next] = [s[i - 1], s[i]];
      const straddles = predatesFxFix(prev) !== predatesFxFix(next);
      const sameCtx = sameBoardContext(prev, next);
      out.push({
        symbol: next.symbol,
        model: next.model,
        from: prev.at,
        to: next.at,
        diff: Math.abs(next.rating - prev.rating),
        ratings: [prev.rating, next.rating],
        straddles,
        sameCtx,
        clean: sameCtx && !straddles,
      });
    }
  }
  return out;
}

/** Three things the log can say about the rating without waiting for returns.

    Computed live rather than hardcoded, because they are the numbers that
    decide whether the harness below is worth reading and they will move as the
    log grows. All three currently point the same way. */
function ratingDiagnosticsHTML(entries) {
  const R = entries.filter((e) => validRating(e.rating));
  if (R.length < 5) return '';

  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sdev = (a) => {
    if (a.length < 2) return null;
    const m = avg(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  };
  const corr = (xs, ys) => {
    const mx = avg(xs); const my = avg(ys);
    let s = 0; let dx = 0; let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      s += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? s / Math.sqrt(dx * dy) : null;
  };

  /* 1. Does it restate the board? Against the equal-weight composite of the
     three canonical scores, which is what Overall actually is. */
  const CANON = ['mom12', 'analyst', 'accruals'];
  const usable = R.filter((e) => CANON.every((k) => Number.isFinite(e.scores?.[k])));
  const rBoard = usable.length >= 8
    ? corr(usable.map((e) => e.rating), usable.map((e) => avg(CANON.map((k) => e.scores[k]))))
    : null;

  /* 2. How much of the spread is noise? Same symbol, same model, repeated.

     SPLIT BY WHETHER THE BOARD MOVED UNDER THE PAIR. A repeat only measures the
     model's own run-to-run noise if the model saw the SAME INPUTS twice. Where
     the stored scores differ between the two runs, the rating was free to
     change because the board changed, and the difference is model noise plus
     board movement with no way to separate them — pooling those two kinds of
     pair inflates the noise estimate with real signal and understates
     reliability. The clean subset is the honest measurement; the rest is
     reported beside it rather than discarded, because "we could not measure
     these" is itself a finding about how the log was collected. */
  const pairs = repeatPairs(R);
  const clean = pairs.filter((p) => p.clean);
  const dirty = pairs.filter((p) => !p.clean);
  const diffs = clean.map((p) => p.diff);
  const dirtyDiffs = dirty.map((p) => p.diff);
  const sdTotal = sdev(R.map((e) => e.rating));
  /* E|d| = sd(d)·sqrt(2/pi) for a normal, and sd(d) = sqrt(2)·sd(error). */
  const sdErr = diffs.length ? (avg(diffs) / Math.sqrt(2 / Math.PI)) / Math.SQRT2 : null;
  const reliability = sdErr != null && sdTotal
    ? (sdTotal ** 2 - sdErr ** 2) / sdTotal ** 2 : null;

  /* 3. Can the buckets the harness is built on ever fill? */
  const occ = RATING_BUCKETS.map((b) => ({ label: b.label,
    n: R.filter((e) => e.rating >= b.min && e.rating <= b.max).length }));
  const endsEmpty = occ[0].n === 0 || occ[occ.length - 1].n === 0;

  const row = (label, value, note) => `<div class="rt-diag-row">
      <span class="rt-diag-label">${label}</span>
      <span class="rt-diag-value">${value}</span>
      <span class="rt-diag-note">${note}</span>
    </div>`;

  return `<div class="rt-diagnostics">
    <h3>What the log already says about the rating</h3>
    ${rBoard == null ? '' : row('Correlation with the board',
      `<b>${rBoard >= 0 ? '+' : ''}${rBoard.toFixed(2)}</b> ± ${(1 / Math.sqrt(usable.length - 3)).toFixed(2)}`,
      `against the equal-weight composite of the three canonical scores, n=${usable.length}. `
      + `It shares ${(rBoard * rBoard * 100).toFixed(0)}% of its variance with numbers the board already had, so most of what it says is a restatement rather than an addition.`)}
    ${!pairs.length ? '' : row('Test-retest noise',
      diffs.length < 3
        ? `<b class="muted">not measurable</b> — ${diffs.length} clean pair${diffs.length === 1 ? '' : 's'}`
        : `<b>${avg(diffs).toFixed(2)}</b> mean |difference|`,
      diffs.length < 3
        ? `${pairs.length} same-model repeat${pairs.length === 1 ? '' : 's'} exist, but only ${diffs.length} `
          + `saw an unchanged board, and three is the minimum this will report on. `
          + `A repeat whose inputs moved measures the board and the model together and cannot separate them, `
          + `so the number is withheld rather than computed from pairs that do not support it.`
        : `across ${diffs.length} CLEAN repeat${diffs.length === 1 ? '' : 's'} — same symbol, same model, and identical stored board scores — `
          + `against a between-symbol spread of ${sdTotal.toFixed(2)}. `
          + `That is ${(avg(diffs) / sdTotal * 100).toFixed(0)}% of the field's total range${
            reliability != null ? `, implying a reliability of ${reliability.toFixed(2)} and capping any correlation it could ever show at ${Math.sqrt(reliability).toFixed(2)}` : ''}.`)}
    ${!dirty.length ? '' : row('Repeats that cannot measure it',
      `<b>${dirty.length}</b> excluded${dirtyDiffs.length ? ` · mean |difference| ${avg(dirtyDiffs).toFixed(2)}` : ''}`,
      `${dirty.filter((p) => p.straddles).length} straddle the fundamentals fix of ${new Date(FX_FIX_AT).toISOString().slice(0, 16).replace('T', ' ')}Z `
      + `and ${dirty.filter((p) => !p.straddles && !p.sameCtx).length} ran against a board that had moved for other reasons. `
      + `Shown because the figure beside them is NOT the noise estimate — the board changed under these, so a rating that moved was entitled to. `
      + `They are listed here so the exclusion is visible rather than silent: `
      + dirty.map((p) => `${p.symbol} ${p.ratings[0]}→${p.ratings[1]}`).join(', ') + '.')}
    ${row('Bucket occupancy',
      occ.map((b) => `${b.label}: <b>${b.n}</b>`).join(' · '),
      endsEmpty
        ? 'An end bucket is empty, so the top-minus-bottom spread below cannot be computed at all. The model clusters in the middle of the scale it was given.'
        : 'Both end buckets have entries, so the spread is at least computable.')}
  </div>`;
}

function renderRatings() {
  const host = $('#rt-body');
  const empty = $('#rt-empty');
  const meta = $('#rt-meta');
  if (!host) return;

  const minDays = Number($('#rt-mindays')?.value) || RATING_MIN_DAYS;
  const basis = $('#rt-basis')?.value === 'raw' ? 'raw' : 'excess';

  loadAssessments().then((entries) => {
    const closeAt = (symbol, day) => {
      const s = state.px.series.get(symbol);
      if (!s) return null;
      const i = barIndexOn(s, day);
      return i == null ? null : s.c[i];
    };

    const { byHorizon, skipped } = ratingObservations(entries, closeAt, { minDays });
    const rated = entries.filter((e) => Number.isInteger(e.rating)).length;

    const stale = entries.filter(predatesFxFix).length;
    meta.textContent = [
      `${entries.length} assessment${entries.length === 1 ? '' : 's'} logged`,
      `${rated} carry a rating`,
      `${entries.filter((e) => validCall(e.callNear)).length} a near-term call`,
      `${entries.filter((e) => validCall(e.callLong)).length} a long-term call`,
      skipped.preRating ? `${skipped.preRating} predate the rating` : null,
      skipped.noRating ? `${skipped.noRating} had a rating refused` : null,
      `${skipped.tooYoung} younger than ${minDays} days`,
      skipped.noPrice ? `${skipped.noPrice} without a usable price window` : null,
    ].filter(Boolean).join(' · ');

    /* Three properties of the field measured on the log itself, none of which
       need forward returns and all of which bear on whether anything below can
       ever mean something. Printed above the tables rather than beneath them:
       they are prior constraints on the reading, not caveats to it. */
    const diag = $('#rt-diagnostics');
    if (diag) diag.innerHTML = ratingDiagnosticsHTML(entries);

    /* Stated in the view, not only in the log. Anyone reading a spread here has
       to know that some of the briefs behind it reasoned about numbers since
       withdrawn — and the rating is the thing being scored, so a rating formed
       partly on a broken earnings yield is a contaminated observation. */
    const warn = $('#rt-stale');
    if (warn) {
      warn.hidden = !stale;
      warn.innerHTML = stale
        ? `<strong>${stale} of ${entries.length} logged assessment${entries.length === 1 ? '' : 's'} predate the fundamentals fix of 2026-08-31.</strong> `
          + 'Their stored board context was computed over a 15-month window — earnings yield, return on equity and accruals were all built from four non-consecutive quarters. '
          + 'The model reasoned about those numbers in good faith, so any rating among them was formed partly on figures that have since been withdrawn. '
          + 'They are kept unaltered because a log entry records what was actually shown; treat them as a separate cohort rather than pooling them with later ones.'
        : '';
    }

    /* The rating's maturity gates the RATING section and nothing else.

       It used to gate the whole view, which was right when the view held one
       field. With three it is wrong in a specific way: the long-term call's
       panel exists to say when a result becomes possible, and hiding it until
       the rating matures would hide the clock exactly while it is the only
       thing there is to look at. Each field now reports its own state. */
    const usable = RATING_HORIZONS.some((h) => byHorizon.get(h.months).length);
    empty.hidden = usable;
    if (!usable) {
      empty.textContent = rated === 0
        ? 'No rated assessments yet. Run some from the board — the rating field was added on 2026-08-31, so anything logged before then has none.'
        : `No rated assessment is yet ${minDays} days old. The shortest horizon needs 30 days of subsequent price action before it can be scored at all.`;
    }

    host.innerHTML = `
      ${usable ? fieldSectionHTML({ id: 'rating', byHorizon, horizons: RATING_HORIZONS, basis }) : ''}
      ${nearSectionHTML(entries, closeAt, minDays, basis)}
      ${longSectionHTML(entries)}
      ${entrySectionHTML(entries, closeAt)}`;
  }).catch(() => {
    host.innerHTML = '';
    empty.textContent = 'Could not read the assessment log.';
    empty.hidden = false;
  });
}

/** One directional field's tables, one per horizon.

    Shared by the rating and the near-term call so the two are computed AND
    presented by identical code. A control measured a different way is not a
    control, and a second arm rendered by a second template is a second place
    for the two to drift apart. */
function fieldSectionHTML({ id, byHorizon, horizons, basis }) {
  const cfg = DIRECTIONAL_FIELDS[id];
  const label = cfg?.label || id;
  const pick = (b) => (basis === 'raw' ? b.mean : (b.meanExcess ?? b.mean));

  const body = horizons.map((h) => {
    const obs = byHorizon.get(h.months) || [];
      if (!obs.length) {
        return `<div class="rt-horizon"><h3>${esc(h.label)}</h3>
          <p class="muted">Nothing is ${h.days} days old yet.</p></div>`;
      }
      const st = ratingStats(obs, basis);
      const rho = basis === 'raw' ? st.rho : (st.rhoExcess || st.rho);
      const { rating: rArm, board: bArm, difference: diff } = st.control;

      /* The distinct-day count sits in the heading, not in a note underneath.
         It is the number that decides whether `n` is what it appears to be. */
      const effective = st.days < st.n
        ? ` <span class="rt-warnline">— on only ${st.days} distinct day${st.days === 1 ? '' : 's'}, so these are not ${st.n} independent observations</span>`
        : '';

      const rows = st.buckets.map((b) => `<tr>
          <td class="composite-cell">${esc(b.label)}</td>
          <td class="num${b.n && b.n < 5 ? ' rt-thin' : ''}">${b.n}</td>
          ${pmCell(pick(b), b.se)}
          <td class="num muted">${b.sd == null ? '—' : b.sd.toFixed(1)}</td>
        </tr>`).join('');

      const sp = st.spread;
      const spreadRow = sp
        ? `<tr class="agg-total">
            <td>Top &minus; bottom</td>
            <td class="num">${sp.nTop} / ${sp.nBottom}</td>
            ${pmCell(sp.value, sp.se)}
            <td class="num muted">${sp.t == null ? '—' : `${sp.t.toFixed(1)}×SE`}</td>
          </tr>`
        : `<tr class="agg-total"><td>Top &minus; bottom</td>
            <td class="num muted" colspan="3">not measurable — one of the end buckets is empty</td></tr>`;

      const verdict = !sp ? ''
        : sp.insideNoise
          ? `<p class="rt-verdict rt-inside">Inside the noise. The spread is ${
              sp.se == null ? 'unmeasurable' : `smaller than twice its own standard error (±${sp.se.toFixed(1)})`
            }, so it is consistent with the rating having no relationship to return at all.</p>`
          : `<p class="rt-verdict rt-outside">Outside twice its own standard error. That is a signal worth looking at, not a validated one — with ${st.n} observations on ${st.days} day${st.days === 1 ? '' : 's'}, check the distinct-day count before believing it.</p>`;

      /* THE HEADLINE: the median split, against the board as a control.
         Two arms computed by identical code over identical observations, so the
         only difference between them is which variable did the splitting. */
      const armRow = (arm, label, note) => (arm
        ? `<tr>
            <td class="composite-cell">${label}<span class="rt-split">${note}</span></td>
            <td class="num">${arm.nHigh} / ${arm.nLow}</td>
            ${pmCell(arm.value, arm.se)}
            <td class="num muted">${arm.t == null ? '—' : `${arm.t.toFixed(1)}×SE`}</td>
          </tr>`
        : `<tr><td class="composite-cell">${label}</td>
            <td class="num muted" colspan="3">no split — every value identical, or one side empty</td></tr>`);

      const controlTable = `<table class="agg-table rt-control">
        <thead><tr>
          <th>Median split, high &minus; low</th>
          <th class="num">high / low</th>
          <th class="num">Spread ${basis === 'raw' ? '' : 'in excess vs SPY '}± SE</th>
          <th class="num"></th>
        </tr></thead>
        <tbody>
          ${armRow(rArm, esc(label),
            rArm ? ` at ${rArm.median}${rArm.balance < 0.35 ? ' — ties force an uneven split' : ''}` : '')}
          ${armRow(bArm, 'Board Overall <span class="rt-ctl-tag">control</span>',
            bArm ? ` at ${bArm.median.toFixed(1)}` : '')}
        </tbody>
        ${diff ? `<tfoot><tr class="agg-total">
          <td>${esc(label)} &minus; board</td>
          <td class="num"></td>
          ${pmCell(diff.value, diff.seUpperBound)}
          <td class="num muted">upper bound</td>
        </tr></tfoot>` : ''}
      </table>
      ${!diff ? '' : `<p class="rt-verdict ${diff.beatsBoard ? 'rt-outside' : 'rt-inside'}">${
        Math.abs(diff.value) < 2 * diff.seUpperBound
          ? `The ${esc(label.toLowerCase())}'s spread and the board's are <b>indistinguishable</b> (difference ${diff.value >= 0 ? '+' : ''}${diff.value.toFixed(1)} against an error of at least ±${diff.seUpperBound.toFixed(1)}). `
            + (id === 'rating'
              ? 'That is what a field correlating +0.71 with the canonical composite should look like: the rating is measuring the board, not adding to it. '
              : 'A field that cannot separate returns better than Overall already does is restating the board rather than adding to it. ')
            + 'The error shown is an UPPER bound — both arms use the same observations, so their errors move together and the true uncertainty on the difference is smaller than this. It is an indication, not a test.'
          : diff.beatsBoard
            ? `The ${esc(label.toLowerCase())}'s spread <b>exceeds</b> the board's by ${diff.value.toFixed(1)} points. That is the only result here that would argue the field adds something, and it needs the distinct-day count and the sample size checked before it is believed.`
            : `The ${esc(label.toLowerCase())}'s spread <b>falls short</b> of the board's by ${Math.abs(diff.value).toFixed(1)} points — splitting on Overall separated future returns better than splitting on it did.`
      }</p>`}`;

      return `<div class="rt-horizon">
        <h3>${esc(h.label)} <span class="muted">— ${st.n} observation${st.n === 1 ? '' : 's'}${effective}</span></h3>
        ${controlTable}
        <h4 class="rt-sub">Fixed buckets <span class="muted">— kept because an empty end bucket is itself a finding</span></h4>
        <table class="agg-table">
          <thead><tr>
            <th>${esc(label)}</th><th class="num">n</th>
            <th class="num">Mean ${basis === 'raw' ? 'return' : 'excess vs SPY'} ± SE</th>
            <th class="num">sd</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot>${spreadRow}</tfoot>
        </table>
        ${verdict}
        <p class="muted rt-rho">Rank correlation (Spearman, ties midranked): ${
          rho ? `<strong>${rho.rho >= 0 ? '+' : ''}${rho.rho.toFixed(2)}</strong> ± ${rho.se.toFixed(2)} on n=${rho.n}${
            Math.abs(rho.rho) < 2 * rho.se ? ' — inside the noise' : ''}`
            : 'not computable — fewer than three observations, or every value identical'
        }</p>
      </div>`;
  }).join('');

  return `<section class="rt-field"><h2 class="rt-field-h">${esc(label)}</h2>${body}</section>`;
}

/** The near-term call: same tables as the rating, on 1 and 3 months only. */
function nearSectionHTML(entries, closeAt, minDays, basis) {
  const { byHorizon, skipped } = ratingObservations(entries, closeAt, {
    minDays, field: 'callNear', horizons: CALL_NEAR_HORIZONS, predates: predatesCalls,
  });
  const any = CALL_NEAR_HORIZONS.some((h) => byHorizon.get(h.months).length);
  if (!any) {
    const carry = entries.filter((e) => validCall(e.callNear)).length;
    return `<section class="rt-field"><h2 class="rt-field-h">Near-term call</h2>
      <p class="muted">${carry === 0
        ? `No assessment carries a near-term call yet — the field was added on 2026-09-01, and ${skipped.preRating} earlier ${skipped.preRating === 1 ? 'entry predates' : 'entries predate'} it.`
        : `${carry} assessment${carry === 1 ? '' : 's'} carr${carry === 1 ? 'ies' : 'y'} a near-term call, but none is yet ${CALL_NEAR_HORIZONS[0].days} days old.`}</p>
      <p class="muted">Scored on 1 and 3 months only. The 6-month column is deliberately absent: it is past the decay of the momentum this call is about, and grading a near-term view on it would score a claim the field never made.</p>
    </section>`;
  }
  return fieldSectionHTML({ id: 'call_near', byHorizon, horizons: CALL_NEAR_HORIZONS, basis });
}

/** The long-term call: a clock, not a table.

    AN EMPTY TABLE IS NOT A FINDING. Rendering the same headings with dashes in
    every cell would put a long-term result on screen in the same shape as a
    measured one, and the only thing distinguishing them would be the contents
    of the cells — which is exactly the reading error the rest of this view is
    built to prevent. Until a year has passed there is no table, only the date
    on which one becomes possible. */
function longSectionHTML(entries) {
  const carrying = entries.filter((e) => validCall(e.callLong));
  const head = '<section class="rt-field"><h2 class="rt-field-h">Long-term call</h2>';

  if (!carrying.length) {
    return `${head}<p class="muted">No assessment carries a long-term call yet. The field was added on 2026-09-01; entries logged before then predate it and are not failures.</p></section>`;
  }

  const earliest = Math.min(...carrying.map((e) => e.at)) + CALL_LONG_MIN_DAYS * 86400000;
  const daysLeft = Math.ceil((earliest - Date.now()) / 86400000);
  const when = new Date(earliest).toISOString().slice(0, 10);

  if (daysLeft > 0) {
    return `${head}
      <div class="rt-pending">
        <p><b>Nothing can be reported here until ${when}</b> — ${daysLeft} day${daysLeft === 1 ? '' : 's'} away.</p>
        <p>${carrying.length} assessment${carrying.length === 1 ? '' : 's'} carr${carrying.length === 1 ? 'ies' : 'y'} a long-term call and ${carrying.length === 1 ? 'is' : 'are'} logged and waiting. The shortest horizon this field claims is 12 months, and it is scored on 12, 24 and 36. There is no shorter measurement to take in the meantime: scoring a business judgment on three months would grade it on a question it did not answer.</p>
        <p class="muted">This is the horizon working as intended, not a gap. The field is recorded now so the clock starts now.</p>
      </div></section>`;
  }

  const closeAt = (symbol, day) => {
    const s = state.px.series.get(symbol);
    if (!s) return null;
    const i = barIndexOn(s, day);
    return i == null ? null : s.c[i];
  };
  const { byHorizon } = ratingObservations(entries, closeAt, {
    minDays: CALL_LONG_MIN_DAYS, field: 'callLong',
    horizons: CALL_LONG_HORIZONS, predates: predatesCalls,
  });
  const basis = $('#rt-basis')?.value === 'raw' ? 'raw' : 'excess';
  return fieldSectionHTML({ id: 'call_long', byHorizon, horizons: CALL_LONG_HORIZONS, basis });
}

/** What the fill verdicts actually rest on.

    Reports the real state rather than a standing warning. A blanket "fills are
    measured on closes" note was correct on the day it was written and becomes a
    lie the moment intraday capture covers the window — and a caveat that is
    wrong in the safe direction still teaches the reader to discount the ones
    that are right. */
function entryFillBasisNoteHTML(rows) {
  const weak = rows.filter((r) => !r.degenerate
    && (r.fillBasis === PX_BASIS.CLOSES || r.fillBasis === PX_BASIS.MIXED));
  if (!weak.length) {
    return '<p class="rt-caveat">Fills are measured against the day&rsquo;s <b>low</b>, so a level counts as filled if the stock traded there — which is what a limit order would have done. Intraday extremes have been captured since 2026-09-01 and every window scored here is covered by them.</p>';
  }
  return `<p class="rt-caveat"><b>${weak.length} of ${rows.length} fill verdict${weak.length === 1 ? '' : 's'} rest${weak.length === 1 ? 's' : ''} partly on closes, not lows.</b>
    Intraday extremes have been captured since 2026-09-01; bars older than that carry none, so for those windows a stock that traded through the level and closed above it counts as unfilled.
    This undercounts fills and overstates time-to-fill, and it errs in one direction — it makes entry levels look worse than they were.
    The remaining ${rows.length - weak.length} ${rows.length - weak.length === 1 ? 'is' : 'are'} measured on lows throughout.</p>`;
}

/** Did waiting for the entry level beat buying on the day?

    Not a bucket spread — the field is not a score to be ranked, it is a claim
    that a better price was available. So the table is the three facts that
    settle that claim: whether it filled, how long it took, and what the fill
    was worth against not waiting. */
function entrySectionHTML(entries, closeAt) {
  const head = '<section class="rt-field"><h2 class="rt-field-h">Entry level</h2>';

  const closesBetween = (symbol, fromDay, toDay) => {
    const s = state.px.series.get(symbol);
    if (!usableSeries(s)) return [];
    const lows = Array.isArray(s.l) && s.l.length === s.c.length ? s.l : null;
    const out = [];
    for (let i = 0; i < s.c.length; i++) {
      const day = dayAtIndex(s, i);
      if (day == null || day < fromDay) continue;
      if (day > toDay) break;
      if (Number.isFinite(s.c[i])) out.push({ day, close: s.c[i], low: lows ? lows[i] : null });
    }
    return out;
  };

  const { rows, skipped } = entryLevelOutcomes(entries, closesBetween, closeAt);
  const offered = entries.filter((e) => Number.isFinite(e.entryLevel)).length;

  const atMarketOffered = entries.filter((e) => e.entryStance === 'at_market').length;

  /* Every disposition, named. A null level used to be one line here and meant
     four things; collapsing them back into "returned null" would undo the point
     of recording the stance. */
  const ledger = [
    `${offered} level${offered === 1 ? '' : 's'} offered`,
    atMarketOffered ? `${atMarketOffered} at market — no better entry expected` : null,
    skipped.rejected ? `${skipped.rejected} rejected for citing a price the board did not supply` : null,
    skipped.outsideBand ? `${skipped.outsideBand} wanted lower but had no anchor inside the band` : null,
    skipped.noLevel ? `${skipped.noLevel} had no usable anchor` : null,
    skipped.preField ? `${skipped.preField} predate the field` : null,
    skipped.preStance ? `${skipped.preStance} predate the stance, so their null cannot be read` : null,
    skipped.tooYoung ? `${skipped.tooYoung} too young to score` : null,
  ].filter(Boolean).join(' · ');

  if (!rows.length) {
    return `${head}<p class="muted">${ledger}.</p>
      <p class="muted">Nothing scoreable yet. A level needs ${CALL_NEAR_HORIZONS[0].days} days of subsequent closes before it can be asked whether it filled.</p>
      </section>`;
  }

  const tables = CALL_NEAR_HORIZONS.map((h) => {
    const at = rows.filter((r) => r.months === h.months);
    const st = entryLevelStats(at);
    if (!st) return '';
    const pct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
    return `<div class="rt-horizon">
      <h3>${esc(h.label)} <span class="muted">— ${st.nWait} level${st.nWait === 1 ? '' : 's'}${
        st.nAtMarket ? ` and ${st.nAtMarket} at market` : ''} on ${st.days} distinct day${st.days === 1 ? '' : 's'}</span></h3>
      <table class="agg-table">
        <thead><tr><th>Outcome</th><th class="num">n</th><th class="num">Value</th></tr></thead>
        <tbody>
          <tr><td class="composite-cell">Filled <span class="rt-split">— closed at or below the level</span></td>
            <td class="num">${st.nFilled}</td>
            <td class="num">${st.fillRate == null ? '—' : `${(st.fillRate * 100).toFixed(0)}%`}</td></tr>
          <tr><td class="composite-cell">Median days to fill</td>
            <td class="num">${st.nFilled}</td>
            <td class="num">${st.medianDaysToFill == null ? '—' : st.medianDaysToFill}</td></tr>
          <tr><td class="composite-cell">Never filled <span class="rt-split">— return foregone by waiting</span></td>
            <td class="num">${st.nUnfilled}</td>
            <td class="num">${pct(st.meanMissed)}</td></tr>
          ${st.nDegenerate ? `<tr><td class="composite-cell">At or above the price on the day <span class="rt-split">— claims nothing</span></td>
            <td class="num">${st.nDegenerate}</td><td class="num muted">—</td></tr>` : ''}
          ${st.nAtMarket ? `<tr><td class="composite-cell">Bought at market <span class="rt-split">— no better entry expected; return from the day</span></td>
            <td class="num">${st.nAtMarket}</td>
            <td class="num">${pct(st.meanAtMarketReturn)}</td></tr>
          <tr><td class="composite-cell">Wanted to wait <span class="rt-split">— same return, for comparison</span></td>
            <td class="num">${st.nWait}</td>
            <td class="num">${pct(st.meanWaitReturn)}</td></tr>` : ''}
        </tbody>
        <tfoot><tr class="agg-total">
          <td>Waiting &minus; buying on the day</td>
          <td class="num">${st.nFilled}</td>
          ${st.meanAdvantage == null
            ? '<td class="num muted">not measurable — nothing filled</td>'
            : pmCell(st.meanAdvantage, st.seAdvantage)}
        </tr></tfoot>
      </table>
      ${st.meanAdvantage == null ? '' : `<p class="rt-verdict ${
        st.seAdvantage != null && Math.abs(st.meanAdvantage) >= 2 * st.seAdvantage ? 'rt-outside' : 'rt-inside'}">${
        st.seAdvantage != null && Math.abs(st.meanAdvantage) < 2 * st.seAdvantage
          ? `Inside the noise: ${pct(st.meanAdvantage)} against an error of ±${st.seAdvantage.toFixed(1)}. Consistent with the level being worth nothing.`
          : st.meanAdvantage > 0
            ? `Waiting beat buying on the day by ${pct(st.meanAdvantage)} on the fills. Read it against the ${st.nUnfilled} that never filled, where waiting earned ${pct(st.meanMissed)} of nothing.`
            : `Waiting LOST ${pct(Math.abs(st.meanAdvantage))} against buying on the day, on the fills alone.`
      }</p>`}
    </div>`;
  }).join('');

  return `${head}
    <p class="muted">${ledger}.</p>
    ${tables}
    ${entryFillBasisNoteHTML(rows)}
    </section>`;
}

/** Switch which of the views owns the main column. Everything that shows
    or hides a view goes through here, so the board's reading position is saved
    on the way out and restored on the way back however the user got there. */
function showView(view, symbol = null) {
  if (state.view === VIEW.BOARD && view !== VIEW.BOARD) state.boardScroll = window.scrollY;

  /* A pending jump to a brief belongs to ONE panel. Any move that is not that
     panel opening drops it, so it cannot fire later against a detail view the
     user reached by some other route. `openAssessment` sets it immediately
     before calling this, which is why the matching case survives. */
  if (view !== VIEW.DETAIL || symbol !== scrollToBriefFor) scrollToBriefFor = null;

  state.view = view;
  state.selected = view === VIEW.DETAIL ? symbol : null;
  if (view === VIEW.DETAIL) state.lastViewed = symbol;

  $('#board').hidden = view !== VIEW.BOARD;
  $('#history').hidden = view !== VIEW.HISTORY;
  $('#detail').hidden = view !== VIEW.DETAIL;
  $('#backtest').hidden = view !== VIEW.BACKTEST;
  $('#ratings').hidden = view !== VIEW.RATINGS;
  $('#open-history').classList.toggle('btn-active', view === VIEW.HISTORY);
  $('#open-backtest').classList.toggle('btn-active', view === VIEW.BACKTEST);
  $('#open-ratings').classList.toggle('btn-active', view === VIEW.RATINGS);

  renderBoard();   // keeps row highlighting and the meta line in step
  if (view === VIEW.HISTORY) renderHistory();
  if (view === VIEW.DETAIL) renderDetail(symbol);
  if (view === VIEW.BACKTEST) renderBacktest();
  if (view === VIEW.RATINGS) renderRatings();

  /* Scroll after the new view is laid out. Reading offsetHeight forces that
     layout now, so the restore lands on the real height rather than on
     whatever the previous view left behind. */
  void document.body.offsetHeight;
  window.scrollTo(0, view === VIEW.BOARD ? state.boardScroll : 0);
}

/** Leave the detail view for the board. */
const closeDetail = () => showView(VIEW.BOARD);

/** Company profile is not part of the bulk load — fetch it the first time a row
    is opened, then re-render that panel. One call, and only for names actually
    looked at. */
async function ensureProfile(symbol) {
  const row = state.rows.get(symbol);
  if (!row || row.profile) return;
  if (state.snapshot) { row.profile = {}; return; }   // profiles are fetched live, never stored

  try {
    row.profile = await get('/stock/profile2', { symbol }, 12 * 3_600_000);
  } catch {
    row.profile = {};   // don't retry on every click
  }
  if (state.selected === symbol) renderDetail(symbol);
}

/* `row.candles` is a four-state field, which the renderer reads directly:
     undefined   never attempted
     'loading'   request in flight
     null        attempted, nothing to draw (off-plan, or no data)
     [[t, c]…]   usable closes
   Like the profile, candles are held in memory only. They are worth ~1.5 KB a
   symbol and only for names actually opened, which is not worth spending the
   localStorage budget the score log now needs. */
async function ensureCandles(symbol) {
  const row = state.rows.get(symbol);
  if (!row || row.candles !== undefined) return;

  // A previous symbol already proved the endpoint is off-plan; don't ask again.
  // A snapshot has no candles either: they are fetched live, never stored.
  if (!PLAN.candle || state.snapshot) {
    row.candles = null;
    if (state.selected === symbol) renderDetail(symbol);
    return;
  }

  row.candles = 'loading';

  /* Snap the window to whole days. `get` caches on the full URL, so an
     unsnapped `to = now` would mint a new key every second and the 12h TTL
     would never hit. Daily candles make the rounding free. */
  const DAY_SEC = 86_400;
  const to = (Math.floor(Date.now() / 1000 / DAY_SEC) + 1) * DAY_SEC;
  const from = to - CANDLE_DAYS * DAY_SEC;

  const data = await fetchOptional(
    '/stock/candle',
    { symbol, resolution: 'D', from, to },
    'candle',
    'Price charts',
    'the price chart will be hidden',
    12 * 3_600_000,
  );

  row.candles = normaliseCandles(data);
  if (state.selected === symbol) renderDetail(symbol);
}

/** Finnhub returns parallel arrays plus a status string. Anything short of a
    usable `ok` payload becomes null, so the panel says "no data" rather than
    drawing a broken line. */
function normaliseCandles(data) {
  if (!data || data.s !== 'ok') return null;
  const t = Array.isArray(data.t) ? data.t : [];
  const c = Array.isArray(data.c) ? data.c : [];

  const points = [];
  for (let i = 0; i < Math.min(t.length, c.length); i++) {
    if (Number.isFinite(t[i]) && Number.isFinite(c[i]) && c[i] > 0) points.push([t[i], c[i]]);
  }
  // A single point is not a line; treat it as no data.
  return points.length >= 2 ? points : null;
}

// ── Watchlist mutation ──────────────────────────────────────────────

function persistWatchlist() {
  localStorage.setItem(LS.watchlist, JSON.stringify(state.symbols));
}

async function addSymbol(rawSymbol) {
  const symbol = String(rawSymbol || '').trim().toUpperCase();
  if (!symbol) return;

  if (state.symbolSet.has(symbol)) {
    toast(`${symbol} is already on the board.`);
    return;
  }

  state.symbols.push(symbol);
  state.symbolSet.add(symbol);
  persistWatchlist();

  try {
    const row = await fetchSymbol(symbol);
    if (!row) toast(`${symbol} has no analyst coverage — not added to the board.`);
    persistHistory();
  } catch (err) {
    toast(err.message);
  }
  renderBoard();
}

function removeSymbol(symbol) {
  state.symbols = state.symbols.filter((s) => s !== symbol);
  state.symbolSet.delete(symbol);
  state.rows.delete(symbol);
  persistWatchlist();
  /* A name off the board cannot be assessed — `assessSymbol` refuses it, and
     `batchPlan` reports it as unknown — so leaving it queued would keep a chip
     no run can ever clear. Taken out here, at the one place membership ends. */
  queueDrop([symbol]);
  // Removing the symbol whose detail is open leaves nothing to show — go back.
  if (state.selected === symbol) showView(VIEW.BOARD);
  else renderBoard();
}

// ── Search ──────────────────────────────────────────────────────────

let searchTimer = null;
let activeSuggestion = -1;

function closeSuggestions() {
  const list = $('#suggestions');
  list.hidden = true;
  list.innerHTML = '';
  activeSuggestion = -1;
  $('.search').setAttribute('aria-expanded', 'false');
}

async function runSearch(term) {
  if (term.length < 1) return closeSuggestions();

  let data;
  try {
    data = await get('/search', { q: term, exchange: 'US' }, 10 * 60_000);
  } catch (err) {
    toast(err.message);
    return closeSuggestions();
  }

  const results = (data.result || [])
    .filter((r) => r.symbol && !r.symbol.includes('.'))
    .slice(0, 8);

  if (!results.length) return closeSuggestions();

  $('#suggestions').innerHTML = results
    .map(
      (r, i) => `<li role="option" data-symbol="${esc(r.symbol)}" aria-selected="${i === 0}">
        <span class="sym">${esc(r.symbol)}</span>
        <span class="desc">${esc(r.description || '')}</span>
      </li>`
    )
    .join('');

  activeSuggestion = 0;
  $('#suggestions').hidden = false;
  $('.search').setAttribute('aria-expanded', 'true');
}

function moveSuggestion(delta) {
  const items = [...document.querySelectorAll('#suggestions li')];
  if (!items.length) return;
  activeSuggestion = (activeSuggestion + delta + items.length) % items.length;
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === activeSuggestion)));
  items[activeSuggestion].scrollIntoView({ block: 'nearest' });
}

// ── API key gate ────────────────────────────────────────────────────
/* PROXY MODE: there is no Finnhub key field. The key is FINNHUB_API_KEY on the
   server, so the only things this panel can do about it are report what the
   proxy said and, once, help move a key that an older version left behind.
   STATIC MODE: the visitor's own key, entered here and kept in localStorage. */

function finnhubStatusHTML() {
  if (!state.proxy) return finnhubKeyFormHTML();
  const f = state.finnhub;
  if (!f.checked) return '<p class="muted">Checking the server for a Finnhub key…</p>';
  if (f.ready) return '<p class="key-ok">Finnhub key found on the server and working.</p>';
  return `<p class="key-bad">${esc(f.message || 'No usable Finnhub key on the server.')}</p>`
    + '<p class="muted">Set it where the server can read it, then restart:<br>'
    + '<code>$env:FINNHUB_API_KEY="…"; node serve.mjs</code></p>';
}

/** Static mode's Finnhub slot. Mirrors the provider panels below: a password
    field, a verify-on-save, and the key never written back into the DOM. */
function finnhubKeyFormHTML() {
  const f = state.finnhub;
  const has = !!state.browserKey;
  let status = '';
  if (has && !f.checked) status = '<p class="muted">Checking the key…</p>';
  else if (has && f.ready) status = '<p class="key-ok">Finnhub key saved in this browser and working.</p>';
  else if (has) status = `<p class="key-bad">${esc(f.message || 'Finnhub did not accept this key.')}</p>`;
  return `
    <form id="finnhub-key-form" class="key-form">
      <input id="finnhub-key-input" type="password" placeholder="Finnhub API key" spellcheck="false"
             autocomplete="off" aria-label="Finnhub API key">
      <button class="btn btn-primary" type="submit">Save key</button>
      <button id="finnhub-key-clear" class="btn btn-ghost" type="button"${has ? '' : ' hidden'}>Remove key</button>
    </form>
    ${status}`;
}

/** Verify and store the static-mode key. One call to prove it, and a failed
    check restores whatever was there before rather than emptying the slot. */
async function saveFinnhubKey(key) {
  const previous = state.browserKey;
  state.browserKey = key;
  state.finnhub = { checked: false, ready: false, message: '' };
  showKeyGate('', '');
  if (await checkFinnhubKey()) {
    localStorage.setItem(LS.key, key);
    /* From the snapshot, live data starts from a clean page rather than mixing
       a published board with this browser's own fetches in one session. */
    if (state.snapshot) { location.reload(); return undefined; }
    showKeyGate('Saved. Loading the board…', 'ok');
    return loadAll({ quoteTtl: PRICE_STALE_MS });
  }
  const message = state.finnhub.message;
  state.browserKey = previous;
  if (previous) await checkFinnhubKey();
  showKeyGate(message || 'Finnhub did not accept that key.', 'fail');
  return undefined;
}

/** The one-time hand-over for a key an older version stored in the browser.

    The key is never written into the DOM. Rendering it would put it in exactly
    the screenshots and shoulder-surfs this change exists to keep it out of, and
    for a value that goes straight into a terminal a clipboard is the right
    channel anyway. */
function legacyKeyHTML() {
  if (!state.proxy || !state.browserKey) return '';
  return `
    <div class="key-legacy">
      <h3>A key from an earlier version is still in this browser</h3>
      <p class="muted">
        It is no longer sent anywhere — the board reads Finnhub through
        <code>serve.mjs</code> now. Copy it into <code>FINNHUB_API_KEY</code>
        on the server, then remove it from here. It is not shown on screen on
        purpose.
      </p>
      <button id="key-legacy-copy" class="btn btn-primary" type="button">Copy key to clipboard</button>
      <button id="key-legacy-drop" class="btn btn-ghost" type="button">Remove it from this browser</button>
    </div>`;
}

function showKeyGate(message, cls) {
  const gate = $('#key-gate');
  gate.hidden = false;
  $('#key-finnhub').innerHTML = finnhubStatusHTML();
  $('#key-legacy').innerHTML = legacyKeyHTML();
  // The day may have rolled over since the gate was last open.
  for (const p of PROVIDERS) renderProviderStatus(p.id);
  const status = $('#key-status');
  status.textContent = message || '';
  status.className = `key-status ${cls || ''}`;
}

function dropLegacyKey() {
  localStorage.removeItem(LS.key);
  state.browserKey = '';
  // Static mode with no key is snapshot mode, which starts from a clean page.
  if (!state.proxy) { location.reload(); return; }
  showKeyGate('Removed from this browser.', 'ok');
}

// ── Secondary provider keys ─────────────────────────────────────────

/** Build the key panel's provider blocks once, from the registry. */
function renderProviderPanels() {
  const host = $('#key-sources');
  if (!host) return;

  host.innerHTML = PROVIDERS.map((p) => `
    <div class="key-source" data-provider="${esc(p.id)}">
      <h3>${esc(p.name)} <span class="key-tag">${esc(p.quota)}</span></h3>
      <p class="muted">
        ${esc(p.best)}
        ${p.caveat ? `<br><em>${esc(p.caveat)}</em>` : ''}
        <a href="${esc(p.signup)}" target="_blank" rel="noopener">Get a free key</a>.
      </p>
      <form class="key-form" data-key-form="${esc(p.id)}">
        <input type="password" placeholder="${esc(p.name)} API key" spellcheck="false"
               autocomplete="off" aria-label="${esc(p.name)} API key" data-key-input="${esc(p.id)}">
        <button class="btn btn-primary" type="submit">Save key</button>
        <button class="btn btn-ghost" type="button" data-key-clear="${esc(p.id)}" hidden>Remove key</button>
      </form>
      <p class="key-status" role="status" data-key-status="${esc(p.id)}"></p>
      <p class="key-budget" data-key-budget="${esc(p.id)}"></p>
    </div>`).join('');

  for (const p of PROVIDERS) renderProviderStatus(p.id);
}

/** The budget line under one provider's form. Rendered after every call, so
    the number on screen is what is actually left. */
function renderProviderStatus(id) {
  const provider = PROVIDER_BY_ID.get(id);
  const budget = document.querySelector(`[data-key-budget="${id}"]`);
  const clear = document.querySelector(`[data-key-clear="${id}"]`);
  if (!budget || !clear) return;   // panel not built yet

  const connected = !!state.provKeys[id];
  clear.hidden = !connected;

  if (!connected) {
    budget.textContent = 'Not connected. The app works fine without it.';
    return;
  }
  if (!provider.dailyCap) {
    budget.textContent = `Connected. No daily cap — ${provider.rate.calls} requests a minute.`;
    return;
  }
  const left = budgetLeft(id);
  budget.textContent = left === 0
    ? `No requests left today (${provider.dailyCap}/${provider.dailyCap} used). Resets at 00:00 UTC.`
    : `${left} of ${provider.dailyCap} requests left today. Resets at 00:00 UTC.`;
}

function showProviderKeyStatus(id, message, cls) {
  const status = document.querySelector(`[data-key-status="${id}"]`);
  if (!status) return;
  status.textContent = message || '';
  status.className = `key-status ${cls || ''}`;
}

/** Verify and store one provider's key. Costs a single request from that
    provider's budget, which each panel says up front. A failed check restores
    the previous key rather than leaving the slot empty. */
async function saveProviderKey(id, key) {
  const provider = PROVIDER_BY_ID.get(id);
  const previous = state.provKeys[id];
  state.provKeys[id] = key;

  try {
    const data = await getFrom(id, provider.verify.path, provider.verify.params, 0);
    if (!provider.ok(data)) {
      throw new ApiError(400, `${provider.name} accepted the key but returned no data for the test request.`);
    }
  } catch (err) {
    state.provKeys[id] = previous;
    showProviderKeyStatus(id, err.message, 'fail');
    renderProviderStatus(id);
    return false;
  }

  localStorage.setItem(LS.provKey + id, key);
  showProviderKeyStatus(id, 'Key verified and saved.', 'ok');
  renderProviderStatus(id);
  return true;
}

function removeProviderKey(id) {
  localStorage.removeItem(LS.provKey + id);
  state.provKeys[id] = '';
  // Cached responses outlive the key on purpose: they cost budget to rebuild,
  // and reconnecting the same key should not have to pay for them twice.
  showProviderKeyStatus(id, 'Key removed.', '');
  renderProviderStatus(id);
}

// ── Toast ───────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  /* A missing toast element must not throw. This is a notification, and it is
     called from inside the assessment runner between paid calls — a crash here
     would abandon the rest of a queue the user has already been charged for,
     over a line of text nobody read. */
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// ── Theme ───────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS.theme, theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '☼' : '☾';
}

// ── Wiring ──────────────────────────────────────────────────────────

function init() {
  /* First, before anything that might call a serve.mjs-only path. Not awaited:
     the first paint does not depend on it; the calls that do wait on it. */
  serverDetected = detectServer();
  applyTheme(localStorage.getItem(LS.theme) || 'dark');
  loadPlan();   // before any load, so off-plan endpoints are not re-probed
  renderProviderPanels();
  /* Async and not waited on: the controls render once from the static table and
     again from the log a moment later. The alternative is blocking the first
     paint on an IndexedDB read to price a button nobody has reached yet. */
  assessmentsChanged();

  /* This browser's own stores, read only when the board is live. In snapshot
     mode they are left alone: the snapshot supplies series and fundamentals, and
     a late IndexedDB read (clear, then fill from an empty store) would wipe what
     it had just put in memory. Waiting on detection costs one local round trip,
     and none of these block the first paint anyway. */
  serverDetected.then((proxy) => {
    if (!proxy && !state.browserKey) return;

    hydrateSeries();

    /* The consensus archive is the only store here holding data that cannot be
       re-fetched, so it is filled from the cache immediately rather than
       waiting for the weekly trend refresh. Nothing on screen depends on it. */
    seedArchiveFromCache()
      .then(() => snapshotStats())
      .then((s) => { state.snap.stats = s; })
      .catch(() => { state.snap.failed++; });

    /* Reads what is already stored. Does NOT fetch — the pass is explicit only.
       Rescores when it lands: this resolves after the first board render, so
       without the re-run every fundamentals score would be null until something
       else happened to trigger one. */
    loadFundamentals().then(() => {
      if (!state.fx.facts.size) return;
      applyTechnicals();
      renderBoard();
    }).catch(() => {});
  });

  /* Weekly, and never attempted without serve.mjs — static mode has no EDGAR
     proxy to ask. Re-renders only if the answer actually changed. */
  serverDetected.then((proxy) => (proxy ? secResolve() : null)).then((r) => {
    if (!r) return;
    applyTechnicals();
    renderBoard();
  }).catch(() => {});

  // Reflect the persisted board mode before anything renders.
  renderModeTabs();
  $('#px-controls').hidden = !domain(state.boardMode).needsPrices;

  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  $('#open-key').addEventListener('click', () => {
    const gate = $('#key-gate');
    if (gate.hidden) showKeyGate('', '');
    else gate.hidden = true;
  });
  $('#snapshot-live').addEventListener('click', () => {
    showKeyGate('', '');
    $('#finnhub-key-input')?.focus();
  });

  /* Delegated: both buttons live inside HTML that showKeyGate rebuilds, so a
     listener bound to the elements themselves would be replaced with them. */
  $('#key-legacy').addEventListener('click', async (e) => {
    if (e.target.closest('#key-legacy-drop')) return dropLegacyKey();
    if (!e.target.closest('#key-legacy-copy')) return;
    try {
      await navigator.clipboard.writeText(state.browserKey);
      showKeyGate('Copied. Set it as FINNHUB_API_KEY, restart the server, then remove it here.', 'ok');
    } catch {
      /* Clipboard access can be refused, and the fallback must not be "show it
         on the page". Nothing is lost: the key is in the user's Finnhub
         dashboard, which is a safer place to copy it from than this browser. */
      showKeyGate('The browser refused clipboard access. Copy the key from your '
        + 'Finnhub dashboard instead, then remove this one.', 'fail');
    }
  });

  /* Static mode's Finnhub form. Delegated for the same reason as #key-legacy:
     showKeyGate rebuilds it. */
  $('#key-finnhub').addEventListener('submit', async (e) => {
    if (!e.target.closest('#finnhub-key-form')) return;
    e.preventDefault();
    const input = $('#finnhub-key-input');
    const key = input.value.trim();
    if (!key) return;
    input.value = '';
    await saveFinnhubKey(key);
  });
  $('#key-finnhub').addEventListener('click', (e) => {
    if (e.target.closest('#finnhub-key-clear')) dropLegacyKey();
  });

  /* Delegated, because the provider panels are generated from the registry —
     adding a provider must not mean adding a listener. */
  $('#key-sources').addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-key-form]');
    if (!form) return;
    e.preventDefault();

    const id = form.dataset.keyForm;
    const input = form.querySelector('[data-key-input]');
    const key = input.value.trim();
    if (!key) return;
    input.value = '';
    showProviderKeyStatus(id, 'Checking…', '');
    await saveProviderKey(id, key);
  });

  $('#key-sources').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-key-clear]');
    if (btn) removeProviderKey(btn.dataset.keyClear);
  });


  /* Refresh refetches every price the board is already showing as stale, by
     holding quotes to PRICE_STALE_MS instead of the 24h store TTL.

     Clearing state.cache alone was not enough and made the button look broken:
     that map is only the 60-second in-memory response cache behind get(), while
     the prices come from the per-symbol localStorage entries, which stayed
     inside their 24h TTL. Every symbol then short-circuited in loadFromCache
     and no /quote call went out, so yesterday's close survived a Refresh — on a
     row the board had been marking stale since an hour after it was fetched.

     The board stays up throughout: loadFromCache renders the old price before
     pass 2 goes for the new one, so rows are replaced in place instead of
     disappearing and coming back.

     Trend, price target and insider data keep their own TTLs. They do not move
     intraday and they are three of the four calls per symbol, so forcing them
     here would quadruple the cost of the button for no fresher price.

     "Clear cached data" remains the escape hatch for a genuine cold reload. */
  $('#refresh').addEventListener('click', () => {
    state.cache.clear();
    loadAll({ quoteTtl: PRICE_STALE_MS });
  });

  // History view
  $('#open-history').addEventListener('click', () => {
    showView(state.view === VIEW.HISTORY ? VIEW.BOARD : VIEW.HISTORY);
  });

  /* Escape backs out of a subview, but not while the user is typing in the
     search box — that key already dismisses the suggestion list. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.view === VIEW.BOARD) return;
    // e.target is the document itself when nothing is focused, and only
    // Elements have closest().
    const el = e.target;
    if (el instanceof Element && el.closest('input, select, textarea')) return;
    showView(VIEW.BOARD);
  });

  $('#tab-symbol').addEventListener('click', () => {
    state.historyTab = HTAB.SYMBOL;
    renderHistory();
  });

  $('#tab-buckets').addEventListener('click', () => {
    state.historyTab = HTAB.BUCKETS;
    renderHistory();
  });

  $('#history-symbol').addEventListener('change', (e) => {
    state.historySymbol = e.target.value;
    renderHistory();
  });

  $('#history-date').addEventListener('change', (e) => {
    state.historyDate = e.target.value;
    renderHistory();
  });

  $('#history-clear').addEventListener('click', () => {
    clearHistory();
    renderHistory();
    toast('Score history cleared.');
  });

  // Flush anything logged since the last batch boundary.
  window.addEventListener('pagehide', persistHistory);

  $('#cache-clear').addEventListener('click', () => {
    clearSymbolCache();
    // Secondary-provider responses go too — this button is the only way to
    // force one to be refetched before its 24h TTL. It does not reset any
    // daily counter; those belong to the providers, not to us.
    clearProviderCache();
    state.cache.clear();
    // Also forget which endpoints were off-plan, so an upgraded key is retried
    // now rather than at the next weekly re-probe.
    localStorage.removeItem(LS.plan);
    for (const flag of PLAN_FLAGS) PLAN[flag] = true;
    PLAN.warned = {};
    toast('Cached data cleared — the next load refetches everything.');
  });

  $('#progress-cancel').addEventListener('click', () => {
    state.cancelled = true;
    toast('Stopped. Anything already loaded stays on the board.');
  });

  // Sector filter
  const sectorSelect = $('#sector-filter');
  sectorSelect.innerHTML = [ALL_SECTORS, ...SECTOR_LIST]
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  sectorSelect.addEventListener('change', () => {
    state.sector = sectorSelect.value;
    renderBoard();
  });

  /* Section controls are rebuilt whenever the board renders, so the handler
     lives on the container. Which control it is comes from the registry, so
     nothing here knows what "min analysts" means. */
  /* Sector cap. Board and backtest share one setting, so the comparison the
     user is making — with it, without it — is the same cap in both places. */
  const capInput = $('#sector-cap');
  capInput.value = String(state.sectorCap);
  capInput.addEventListener('input', () => {
    const n = Number(capInput.value);
    state.sectorCap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    localStorage.setItem(LS.sectorCap, String(state.sectorCap));
    renderBoard();
    if (state.view === VIEW.BACKTEST) renderBacktest();
  });

  $('#section-controls').addEventListener('input', (e) => {
    const input = e.target.closest('[data-control]');
    if (!input) return;
    const c = CONTROLS_BY_ID.get(input.dataset.control);
    if (!c) return;
    const n = Number(input.value);
    // An empty or nonsense box means "no threshold" rather than NaN.
    state.controls[c.id] = Number.isFinite(n) ? clamp(Math.floor(n), c.min, c.max) : c.min;
    persistControls();
    renderBoard();
  });

  // Backtest
  $('#open-backtest').addEventListener('click', () => {
    showView(state.view === VIEW.BACKTEST ? VIEW.BOARD : VIEW.BACKTEST);
  });

  // Rating harness
  $('#open-ratings').addEventListener('click', () => {
    showView(state.view === VIEW.RATINGS ? VIEW.BOARD : VIEW.RATINGS);
  });
  /* Not persisted to localStorage, unlike the backtest's controls. These two
     change what is measured, not how the board looks, and a maturity floor
     silently carried over from a previous session is a way to read a different
     sample than the one you think you are reading. */
  $('#rt-mindays').addEventListener('change', renderRatings);
  $('#rt-basis').addEventListener('change', renderRatings);

  // Tabs are rebuilt on every render, so the listener lives on the container.
  $('#bt-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-score]');
    if (!tab) return;
    state.backtest.score = tab.dataset.score;
    renderBacktest();
  });

  for (const [id, field] of [['#bt-months', 'months'], ['#bt-spacing', 'spacing']]) {
    $(id).addEventListener('change', (e) => {
      state.backtest[field] = Number(e.target.value);
      renderBacktest();
    });
  }

  // Bucketing changes how a run is cut, not what it measured, so the cached
  // runs stand and only the render has to happen again.
  $('#bt-bucketing').addEventListener('change', (e) => {
    state.backtest.bucketing = e.target.value;
    renderBacktest();
  });

  // Board domain tabs — rebuilt on every switch, so delegate to the container.
  $('#board-modes').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-mode]');
    if (tab) setBoardMode(tab.dataset.mode);
  });

  /* Filter panel. Rows are regenerated by renderFilters on every board render,
     so both handlers delegate from the container that survives it. */
  $('#filters').addEventListener('change', (e) => {
    const on = e.target.closest('[data-filter-on]');
    if (on) {
      state.filters[on.dataset.filterOn].on = on.checked;
      persistFilters();
      renderBoard();
      return;
    }
    const min = e.target.closest('[data-filter-min]');
    if (!min) return;
    const d = domain(min.dataset.filterMin);
    const n = Number(min.value);
    state.filters[d.id].min = Number.isFinite(n)
      ? clamp(n, d.scale.min, d.scale.max)
      : d.filterDefault;
    persistFilters();
    renderBoard();
  });

  $('#px-start').addEventListener('click', backfillPrices);
  $('#px-cancel').addEventListener('click', () => {
    state.px.cancelled = true;
  });

  $('#fx-start').addEventListener('click', fetchAllFundamentals);
  $('#fx-cancel').addEventListener('click', () => {
    state.fx.cancelled = true;
  });

  renderAssessControls();
  $('#assess-model').addEventListener('change', (e) => {
    const chosen = e.target.value;
    if (!ASSESS_MODELS[chosen]) return;      // an option that is not in the registry
    state.assessModel = chosen;
    localStorage.setItem(LS.assessModel, chosen);
    /* Re-render so every row's tooltip names the model it would now use. */
    if (state.view === VIEW.BOARD) renderBoard();
    const est = perCallEstimate(chosen);
    toast(`Assessments will use ${ASSESS_MODELS[chosen].label} — ${estimateText(est)} each, `
      + `from ${est.basis}.`);
  });

  $('#assess-export').addEventListener('click', downloadAssessments);
  $('#assess-import').addEventListener('click', () => $('#assess-file').click());
  $('#assess-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    /* Cleared before awaiting, so selecting the same file twice in a row fires
       `change` the second time — otherwise a failed import cannot be retried
       without picking a different file first. */
    e.target.value = '';
    if (file) await uploadAssessments(file);
  });

  /* Persisted, unlike the rating harness's controls, and for the opposite
     reason: this one is a standing preference about spending money, not a
     choice about what is being measured. Someone who ticked it once should not
     silently start re-running names again after a reload. */
  const skipBox = $('#assess-skip-repeats');
  if (skipBox) {
    skipBox.checked = loadAssessSkipRepeats();
    skipBox.addEventListener('change', (e) => {
      localStorage.setItem(LS.assessSkipRepeats, e.target.checked ? '1' : '0');
      toast(e.target.checked
        ? `Batches will skip names assessed on the same model in the last ${humanWindow(ASSESS_REPEAT_WINDOW_MS)}.`
        : 'Batches will re-run recent names. Repeats are still listed before you confirm.');
    });
  }

  /* Enter assesses what is typed, on the same terms as a row click. Not
     `change`, and not blur: both fire on their own as focus moves around the
     toolbar, and a control that starts spending because you clicked away from
     it is a trap. Enter is a deliberate gesture and this one spends money. */
  const symbolBox = $('#assess-symbols');
  if (symbolBox) {
    symbolBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();          // no implicit form submit, and no page reload
      enqueueTyped();
    });
  }

  /* Delegated: the bar is rewritten on every queue change, so listeners bound
     to the chips inside it would be bound to elements that no longer exist. */
  $('#assess-queue')?.addEventListener('click', (e) => {
    const chipX = e.target.closest('[data-unqueue]');
    if (chipX) { queueDrop([chipX.dataset.unqueue]); return; }
    if (e.target.closest('#assess-queue-clear')) {
      /* No confirm. Nothing has been sent for anything still waiting, and
         re-queueing is one click per name — a dialog here would guard a free
         action while the one that actually spends is a row click away. The name
         in flight is untouched: it is not in this list. */
      const n = state.assessQueue.length;
      state.assessQueue = [];
      queueChanged();
      toast(`${n} name${n === 1 ? '' : 's'} dropped from the queue. `
        + `Nothing was sent for ${n === 1 ? 'it' : 'them'}.`
        + `${assessRun.symbol ? ` ${assessRun.symbol} is still running.` : ''}`);
    }
  });

  /* Delegated for the same reason: the strip is rewritten every time the log
     changes, so its chips do not survive a run. */
  $('#assess-recent')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-open-assessment]');
    if (chip) openAssessment(chip.dataset.openAssessment);
  });

  /* The bars start hidden and the buttons start idle — there is nothing queued
     at boot, by design, but the render is what makes that true on screen. The
     Recent strip fills itself when refreshAssessCache first reads the log. */
  queueChanged();
  syncRunControls();

  $('#assess-batch').addEventListener('click', onBatchClick);
  $('#assess-stop').addEventListener('click', () => {
    /* Sets a flag rather than aborting in flight. The call already paid for is
       allowed to land and be logged — cancelling it would spend the money and
       throw away the brief. The stop takes effect before the NEXT one. */
    assessRun.stop = true;
    syncRunControls();
  });

  /* Sorting is delegated: the header row is regenerated whenever the mode
     changes, so per-th listeners would be attached to elements that no longer
     exist. Each mode keeps its own sort, since they share no columns worth
     sorting by. */
  $('#board-head').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;

    const by = th.dataset.sort;
    const sort = activeSort();
    if (sort.by === by) {
      sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      // Text sorts read best ascending; numbers best descending.
      state.sort[state.boardMode] = { by, dir: by === 'symbol' || by === 'name' ? 'asc' : 'desc' };
    }
    localStorage.setItem(LS.sort, JSON.stringify(state.sort));
    renderBoard();
  });

  // Row select / remove
  $('#board-body').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      e.stopPropagation();
      removeSymbol(removeBtn.dataset.remove);
      return;
    }
    const assessBtn = e.target.closest('[data-assess]');
    if (assessBtn) {
      /* Must not also open the row: the click is about assessing the name, not
         about reading what is already known of it. */
      e.stopPropagation();
      assessClick(assessBtn.dataset.assess);
      return;
    }
    const tr = e.target.closest('tr[data-symbol]');
    if (!tr) return;
    const symbol = tr.dataset.symbol;
    // Open on the section's own domain; Overall implies none, so it opens on
    // the default. Set before showView, which renders the panel.
    state.detailTab = detailTabFor(state.boardMode);
    showView(VIEW.DETAIL, symbol);
    ensureProfile(symbol);
    ensureDetailData(symbol);
  });

  /* The panel is rewritten on every render, so its own controls are delegated
     from the container that survives it. */
  $('#detail').addEventListener('click', (e) => {
    if (e.target.closest('#detail-back')) { closeDetail(); return; }
    const tab = e.target.closest('[data-detail-tab]');
    if (!tab || tab.dataset.detailTab === state.detailTab) return;
    state.detailTab = tab.dataset.detailTab;
    renderDetail(state.selected);
    ensureDetailData(state.selected);
  });

  // Search box
  const input = $('#search');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = input.value.trim();
    searchTimer = setTimeout(() => runSearch(term), 300);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestion(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestion(-1); }
    else if (e.key === 'Escape') { closeSuggestions(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const items = [...document.querySelectorAll('#suggestions li')];
      const picked = items[activeSuggestion];
      addSymbol(picked ? picked.dataset.symbol : input.value);
      input.value = '';
      closeSuggestions();
    }
  });

  $('#suggestions').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-symbol]');
    if (!li) return;
    e.preventDefault();
    addSymbol(li.dataset.symbol);
    input.value = '';
    closeSuggestions();
  });

  input.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

  /* Boot. Same quote horizon as Refresh: pass 1 paints the cached board at
     once, then the prices older than an hour are replaced in the background.
     Opening on Monday no longer leaves Friday's closes sitting there until
     the button is pressed.

     Whether there is a usable key is now a question for the server, so it is
     answered asynchronously and the cached board is painted first rather than
     waiting on a round trip. A key left behind by an older version opens the
     gate on its own — that hand-over should not wait for someone to click Key.
     The probe spends one call and reuses the limiter like everything else.

     detectServer goes first: it decides where that probe is sent. On the
     hosted site, a first visit has no key, so the gate opens with the form. */
  renderBoard();
  serverDetected
    .then(async () => {
      applyServerMode();
      /* Static mode without a key: the published snapshot is the front door. If
         it is missing or unreadable, fall through to the key gate as before. */
      if (!state.proxy && !state.browserKey && await loadSnapshot()) return false;
      return checkFinnhubKey().then((ready) => {
        const handOver = state.proxy && !!state.browserKey;
        if (!ready || handOver) showKeyGate('', '');
        if (ready) return loadAll({ quoteTtl: PRICE_STALE_MS });
        return undefined;
      });
    });
}

/** What changes on screen in static mode. The CSS hides everything marked
    `.proxy-only` (and the per-row Assess buttons) off `data-server`; this
    only rewrites the text that has to say something different. */
function applyServerMode() {
  if (state.proxy) return;
  const intro = $('#key-intro');
  if (intro) {
    intro.innerHTML = 'This app reads live analyst recommendation trends from '
      + '<a href="https://finnhub.io/register" target="_blank" rel="noopener">Finnhub</a>. '
      + 'Get a free key and paste it below. It is stored only in this browser&rsquo;s '
      + '<code>localStorage</code> and sent only to Finnhub &mdash; as a URL parameter, '
      + 'so it will show in this browser&rsquo;s own developer tools.';
  }
  const note = $('#static-note');
  if (note) note.hidden = false;
}

// ── Snapshot mode ───────────────────────────────────────────────────

async function fetchSnapshotPart(name) {
  const res = await fetch(`${SNAPSHOT_BASE}${name}.json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

/** Run the app's clock from the snapshot's moment instead of today's.

    Shifted, not frozen: elapsed time still passes normally, so timers and
    anything measuring a duration behave. What changes is every "how old is
    this" question — share-count age, price staleness, how long ago a brief was
    written — which is now asked as of the day the board was captured. Without
    it the published scores would drift as real time passed (earnings yield, for
    one, is withheld once a share count ages past SHARES_MAX_AGE_DAYS) and the
    demo would decay the longer it stayed up. */
function installSnapshotClock(asOf) {
  const RealDate = Date;
  const offset = RealDate.now() - asOf;
  const now = () => RealDate.now() - offset;
  globalThis.Date = class SnapshotDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  };
}

/** Draw the board from the published snapshot. Resolves true once the board is
    on screen, false if there is no usable snapshot (the caller then shows the
    key gate, exactly as before snapshots existed).

    core.json paints the board: quotes, analyst trends, insider counts. Prices,
    fundamentals and the assessment log are larger and stream in behind it; each
    rescores the board when it lands, the same way the IndexedDB hydration does
    in live mode. */
async function loadSnapshot() {
  let core;
  try {
    core = await fetchSnapshotPart('core');
  } catch {
    return false;
  }
  if (!core || core.format !== 'bolt.snapshot' || !core.entries || !Array.isArray(core.watchlist)) return false;

  installSnapshotClock(core.asOf);
  state.snapshot = { asOf: core.asOf, entries: core.entries, assessments: [] };
  Object.assign(PLAN, core.plan || {});
  if (core.sec) state.sec = { at: core.sec.at || 0, cik: core.sec.cik || {}, gone: core.sec.gone || [] };
  state.symbols = core.watchlist.filter((s) => core.entries[s]);
  state.symbolSet = new Set(state.symbols);

  state.rows.clear();
  for (const symbol of state.symbols) loadFromCache(symbol);
  applyTechnicals();
  renderSnapshotBar();
  renderBoard();

  const rescore = () => {
    applyTechnicals();
    renderBoard();
    if (state.view === VIEW.BACKTEST) renderBacktest();
    if (state.selected) renderDetail(state.selected);
  };
  fetchSnapshotPart('prices').then((p) => {
    for (const [symbol, series] of Object.entries(p.series || {})) {
      if (usableSeries(series)) state.px.series.set(symbol, series);
    }
    state.px.hydrated = true;
    rescore();
  }).catch(() => { state.px.hydrated = true; });
  fetchSnapshotPart('fundamentals').then((f) => {
    for (const [symbol, rec] of Object.entries(f.facts || {})) state.fx.facts.set(symbol, rec);
    state.fx.hydrated = true;
    rescore();
  }).catch(() => { state.fx.hydrated = true; });
  fetchSnapshotPart('assessments').then((a) => {
    state.snapshot.assessments = Array.isArray(a.entries) ? a.entries : [];
    assessmentsChanged();
  }).catch(() => {});

  return true;
}

/** The snapshot's label. Stated once, plainly, where the board starts — a date
    and a route to live data, not an apology. */
function renderSnapshotBar() {
  const bar = $('#snapshot-bar');
  if (!bar || !state.snapshot) return;
  const day = new Date(state.snapshot.asOf).toLocaleDateString(undefined,
    { year: 'numeric', month: 'long', day: 'numeric' });
  $('#snapshot-date').textContent = day;
  $('#snapshot-count').textContent = state.symbols.length.toLocaleString();
  bar.hidden = false;
}

init();
