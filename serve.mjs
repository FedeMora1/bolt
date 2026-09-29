/* Static file server for this folder, plus the SEC EDGAR proxy.
 *
 * Replaces serve.ps1, which became permanently unreadable (file permissions
 * that could not be recovered even with admin). Node is already a dependency
 * here — the test suite runs on it — so this adds nothing new to install.
 *
 *   node serve.mjs            -> http://localhost:8080
 *   node serve.mjs 8081       -> a different port
 *   node serve.mjs 8080 me@example.com   -> set the EDGAR contact
 *
 * SERVE ON 8080 unless you mean not to. localStorage and IndexedDB are keyed
 * by origin, so a different port gives you an empty board: every cached price,
 * analyst trend and consensus snapshot lives under http://localhost:8080.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, normalize, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf } from './pricing.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2]) || 8080;

/* EDGAR rejects a User-Agent with no contact address: a plain descriptive
   string gets 403, the same as sending none. Only something email-shaped gets
   through. This placeholder works; SEC's guidance is to use an address they can
   reach if your traffic ever causes them a problem. */
const SEC_CONTACT = process.argv[3] || 'bolt-research@example.com';
const SEC_UA = `Bolt/1.0 (personal research tool; contact: ${SEC_CONTACT})`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/* Only these two hosts, only GET. Without an allowlist this would be an open
   proxy on localhost that any browser tab could use to reach arbitrary hosts. */
const SEC_HOSTS = {
  data: 'https://data.sec.gov',   // /sec/data/api/xbrl/companyfacts/CIK##########.json
  www: 'https://www.sec.gov',     // /sec/www/files/company_tickers.json
};

/* EDGAR asks for no more than 10 requests/second. Server-side and deliberately
   separate from the app's provider limiters: those govern one browser tab's
   spend against a per-key quota, this governs what this machine sends EDGAR
   however many tabs are open. */
const SEC_MAX_PER_SECOND = 10;
const secWindow = [];

async function waitForSecSlot() {
  for (;;) {
    const now = Date.now();
    while (secWindow.length && now - secWindow[0] >= 1000) secWindow.shift();
    if (secWindow.length < SEC_MAX_PER_SECOND) { secWindow.push(now); return; }
    await new Promise((r) => setTimeout(r, 1000 - (now - secWindow[0])));
  }
}

/* ── Finnhub proxy ────────────────────────────────────────────────────
 * The Finnhub key lives here, as FINNHUB_API_KEY, and is attached to each
 * upstream request as an `X-Finnhub-Token` header. It is never sent to the
 * browser, so it is in no URL the page builds and therefore in no console
 * line, no devtools network row, no HAR export and no screenshot of any of
 * them. That — not billing — is what this path is for; see the note above the
 * Anthropic proxy for why the two concerns are separate.
 *
 * Finnhub does support the header form directly, but the page cannot use it:
 * finnhub.io answers a CORS preflight with no Access-Control-Allow-Headers at
 * all, so a browser blocks any request carrying a custom header. Server-side
 * there is no preflight. Verified 2026-09-01: a bogus token in the header
 * returns {"error":"Invalid API key."} while sending none returns
 * {"error":"Please use an API key."}, so the header is genuinely read.
 */
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

/* Exactly the endpoints app.js calls, matched whole. Without an allowlist this
   is a key-bearing open relay that any tab on this machine can point at any
   Finnhub endpoint — including the ones a paid plan meters. Whole-string
   matching also settles path traversal: there is no prefix to escape from. */
const FINNHUB_PATHS = new Set([
  '/quote',
  '/search',
  '/stock/recommendation',
  '/stock/profile2',
  '/stock/price-target',
  '/stock/insider-transactions',
  '/stock/candle',
]);

/* Server-side twin of the limiter in app.js, and the second reason this path
   exists. app.js can only bound what ONE PAGE sends; the quota is per key. Two
   tabs, or a reload partway through a run, each start with an empty window and
   spend the same allowance twice over. This counts every tab because it is the
   only thing that can see them all — the same argument already written down
   for SEC_MAX_PER_SECOND above.
   The minimum gap is what stops 55 calls a minute from arriving as one burst;
   the reasoning is in app.js beside RATE_MIN_GAP_MS. */
const FINNHUB_PER_WINDOW = 55;
const FINNHUB_WINDOW_MS = 60_000;
const FINNHUB_MIN_GAP_MS = Math.ceil(FINNHUB_WINDOW_MS / FINNHUB_PER_WINDOW);
const fhWindow = [];
let fhLastGrant = 0;

async function waitForFinnhubSlot() {
  for (;;) {
    const now = Date.now();
    while (fhWindow.length && now - fhWindow[0] >= FINNHUB_WINDOW_MS) fhWindow.shift();

    /* Both waits `continue` instead of falling through, so the test that admits
       a call and the push that records it stay in one synchronous run and every
       waiter re-reads the clock after waking. */
    const sinceGrant = now - fhLastGrant;
    if (sinceGrant < FINNHUB_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, FINNHUB_MIN_GAP_MS - sinceGrant));
      continue;
    }
    if (fhWindow.length >= FINNHUB_PER_WINDOW) {
      await new Promise((r) => setTimeout(r, FINNHUB_WINDOW_MS - (now - fhWindow[0]) + 50));
      continue;
    }
    fhWindow.push(now);
    fhLastGrant = now;
    return;
  }
}

/* Last-seen time per browser context — one random id per page load, sent as
   X-Bolt-Context. Only the count is ever used, and only when Finnhub 429s,
   where it answers the one question the 429 itself cannot: whether more than
   one tab is spending this key. */
const fhContexts = new Map();

function noteFinnhubContext(id) {
  if (!id) return;
  const now = Date.now();
  fhContexts.set(id, now);
  for (const [k, at] of fhContexts) if (now - at > FINNHUB_WINDOW_MS) fhContexts.delete(k);
}

/** A refusal from this proxy, flagged so the client cannot read it as Finnhub's
    answer. app.js keys off the header rather than the body, and fetchOptional
    depends on the distinction: a 503 from here mistaken for a 403 from Finnhub
    records "not on your plan" for endpoints that are fine. */
const proxyError = (res, code, error) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Bolt-Proxy-Error': '1',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error, via: 'serve.mjs' }));
};

async function proxyFinnhub(req, res, rel) {
  if (req.method !== 'GET') return proxyError(res, 405, 'only GET is proxied');

  const path = rel.slice('finnhub'.length) || '/';
  if (!FINNHUB_PATHS.has(path)) {
    return proxyError(res, 400, `'${path}' is not an endpoint this proxy allows`);
  }
  if (!FINNHUB_KEY) {
    /* The fact only. Both readers of this string already supply the fix — the
       key panel prints the command underneath it, and the startup log prints it
       at the top — and saying it three times made the panel look like an error
       repeated rather than one explained. */
    return proxyError(res, 503, 'FINNHUB_API_KEY is not set on the server.');
  }

  noteFinnhubContext(req.headers['x-bolt-context']);
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await waitForFinnhubSlot();

  try {
    const upstream = await fetch(`${FINNHUB_BASE}${path}${query}`, {
      headers: { 'X-Finnhub-Token': FINNHUB_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());

    /* The whole point of logging this here rather than in the browser: only
       this process sees every tab. The two numbers separate the two faults that
       produce an identical 429 in the console. */
    if (upstream.status === 429) {
      const now = Date.now();
      const lastSecond = fhWindow.filter((t) => now - t < 1000).length;
      console.warn(
        `[finnhub] 429 — this server admitted ${fhWindow.length}/${FINNHUB_PER_WINDOW} calls in the `
        + `last minute, ${lastSecond} in the last second, across ${fhContexts.size} browser `
        + `context(s) seen this minute.`);
      console.warn(
        `  >1 context: a second tab or a mid-run reload is spending the same key.`);
      console.warn(
        `  1 context, well under ${FINNHUB_PER_WINDOW}: something outside this server holds the key too.`);
    }

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      /* no-store, unlike the EDGAR proxy above. Filings are immutable; quotes
         and recommendation trends are the moving things this board exists to
         show, and a cached copy of one is a wrong copy. The app already caches
         per endpoint on its own TTLs, which is where that judgement belongs. */
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (err) {
    if (err?.name === 'TimeoutError') return proxyError(res, 504, 'Finnhub timed out after 30s');
    proxyError(res, 502, `upstream failure: ${err?.message || err}`);
  }
}

/* ── Anthropic proxy, with a hard daily spend ceiling ─────────────────
 * The key stays here and never reaches the browser. That is the whole reason
 * this path exists rather than `anthropic-dangerous-direct-browser-access`:
 * the five market-data keys in localStorage are rate-limited free tiers a leak
 * cannot bill, and this one is not.
 *
 * ADDED 2026-09-01, and not a reversal: that argument is about BILLING and it
 * still holds exactly as written. What it never covered is a second exposure. A
 * key in a query string is in every console line, devtools row, HAR export and
 * screenshot of any of them, and is read by whoever the screen or the log
 * reaches — whether or not they could ever bill it. Unbillable is not
 * unexposed, and the note only ever answered the first.
 *
 * Finnhub moved above on that second ground alone. The five are the secondary
 * providers and they are unchanged, so the same second argument still applies
 * to them: their keys are still in their URLs. That is a known gap, not a
 * settled question — the reason it was not closed here is that each has its own
 * host, auth convention and quota accounting, which is five proxies rather than
 * one, and none of them is on the path that logged ~70 429s.
 *
 * The ceiling is a DOLLAR ceiling, not a rate limit. A rate limit bounds calls
 * per second; a runaway loop under a rate limit still spends all night. This
 * refuses once the day's actual metered cost passes ANTHROPIC_DAILY_USD, and
 * the ledger is on disk so a server restart does not reset the day.
 *
 * Cost is computed from the `usage` block the API returns, not estimated, so
 * the ledger reflects what was actually billed. Verified against
 * platform.claude.com/docs/en/about-claude/pricing on 2026-09-01.
 */
/* ── Which variable holds the key ─────────────────────────────────────
 * BOLT_ANTHROPIC_KEY, not ANTHROPIC_API_KEY, and the reason is Claude Code
 * rather than this app. ANTHROPIC_API_KEY is read by Claude Code's own auth and
 * TAKES PRECEDENCE over a claude.ai login, so setting it machine-wide for Bolt
 * silently moves that session onto API billing — a change nothing announces and
 * which has nothing to do with this server. A name only this project reads
 * cannot do that.
 *
 * ANTHROPIC_API_KEY is still honoured, second, so an existing setup keeps
 * working rather than losing the proxy at a rename. It is a fallback and not a
 * peer: the startup log names which variable supplied the key, because a key
 * found under the old name means the collision is still live on that machine.
 *
 * ANTHROPIC_DAILY_USD is deliberately NOT renamed. Claude Code does not read
 * it, so it collides with nothing.
 */
const ANTHROPIC_KEY_VARS = ['BOLT_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'];
const ANTHROPIC_KEY_VAR = ANTHROPIC_KEY_VARS.find((name) => process.env[name]) || '';
const ANTHROPIC_KEY = ANTHROPIC_KEY_VAR ? process.env[ANTHROPIC_KEY_VAR] : '';
const DAILY_USD = Number(process.env.ANTHROPIC_DAILY_USD || 5);
const LEDGER = resolve(join(ROOT, '.anthropic-spend.json'));

/* ── The ledger's day ─────────────────────────────────────────────────
 * LOCAL midnight, not UTC. Changed 2026-09-01.
 *
 * This is a DAY BUCKET, not a 24-hour rolling window: the total resets to zero
 * when the date string changes and is otherwise cumulative. The two behave
 * differently and the difference matters — under a bucket, spend at 23:50
 * constrains nothing ten minutes later, and a session that straddles midnight
 * is split across two ceilings. That is the intended behaviour of a daily
 * ceiling and it is not being changed here; only which midnight it is.
 *
 * It was `toISOString().slice(0, 10)`, a UTC date, which put the boundary at
 * 20:00 local in EDT. An evening session after that hour was counted against
 * the NEXT day, so opening the app at 6pm could read most of a ceiling already
 * spent by work done the previous evening. The server runs on the user's own
 * machine, so it can simply use the machine's clock — the same reasoning
 * already applied to localDay() in app.js: "once a day" is a human-facing
 * notion and humans do not live in UTC.
 *
 * NOT the same decision as the secondary-provider counters in app.js, which
 * stay on utcDay(). Those track quotas that Finnhub, FMP and the rest genuinely
 * reset at 00:00 UTC; matching the vendor is the whole point there. This
 * ceiling is local policy, set here, so it answers to a local day. Do not
 * "unify" them.
 */
const LEDGER_BASIS = 'local';

const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

function nextReset() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);   // the next local midnight
  return d;
}

const TZ_NAME = Intl.DateTimeFormat().resolvedOptions().timeZone || 'system local time';

function tzOffsetLabel() {
  const mins = -new Date().getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const freshLedger = () => ({ day: today(), usd: 0, calls: 0, basis: LEDGER_BASIS });

async function readLedger() {
  try {
    const l = JSON.parse(await readFile(LEDGER, 'utf8'));

    /* A day string only means something under the basis that wrote it: the same
       "2026-09-01" names a different span of hours as a UTC date than as a local
       one. So a ledger written under a different basis is not a ledger for today
       under this one, whatever its date reads, and carrying it over would import
       a total that mixes two local days. It is retired instead — loudly, because
       a spend figure vanishing without explanation is worse than the wrong
       figure it replaces. */
    if (l.basis !== LEDGER_BASIS) {
      if (Number(l.usd) > 0) {
        console.warn(
          `[spend] the stored ledger was keyed to ${l.basis || 'UTC'} days. Starting a fresh `
          + `${LEDGER_BASIS}-day ledger and discarding $${Number(l.usd).toFixed(4)} over `
          + `${l.calls} call(s) dated ${l.day}.`);
        console.warn(
          '  That total cannot be carried across: only a running sum was stored, never the '
          + 'per-call times, so there is no way to say how much of it belongs to today.');
        console.warn('  Anthropic\'s own figure is unaffected — reconcile at platform.claude.com/cost');
      }
      return freshLedger();
    }

    return l.day === today() ? l : freshLedger();
  } catch {
    return freshLedger();
  }
}

async function proxyAnthropic(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'POST only', via: 'serve.mjs' });
  }
  if (!ANTHROPIC_KEY) {
    return sendJson(res, 503, {
      error: 'BOLT_ANTHROPIC_KEY is not set on the server. Start with: '
        + '$env:BOLT_ANTHROPIC_KEY="sk-ant-..."; node serve.mjs',
      via: 'serve.mjs',
    });
  }

  /* Checked BEFORE the call, so the ceiling is a refusal rather than a report
     of an overrun. A single call can still carry the total past the line — the
     cost is not knowable until it returns — so the guard is "no new calls once
     over", with one call of overshoot as the worst case. */
  const ledger = await readLedger();
  if (ledger.usd >= DAILY_USD) {
    return sendJson(res, 429, {
      error: `Daily spend ceiling reached: $${ledger.usd.toFixed(4)} of $${DAILY_USD.toFixed(2)} `
        + `across ${ledger.calls} calls today. Raise ANTHROPIC_DAILY_USD or wait for UTC midnight.`,
      /* A machine-readable reason, not just prose. The batch runner has to tell
         "the ceiling stopped you, stop cleanly" apart from "this one name
         failed, keep going", and matching on the message text would break the
         first time the wording changed. */
      reason: 'ceiling',
      spent: ledger.usd, ceiling: DAILY_USD, calls: ledger.calls, via: 'serve.mjs',
    });
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: AbortSignal.timeout(600000),   // web search turns run long
    });
    const text = await upstream.text();

    let spent = 0;
    let unknownModel = false;
    try {
      const parsed = JSON.parse(text);
      ({ usd: spent, unknownModel } = costOf(parsed.model, parsed.usage));
      if (unknownModel && parsed.usage) {
        console.warn(`[spend] "${parsed.model}" is not in the pricing table — `
          + `metered at the highest known rate ($${spent.toFixed(4)}). Add it to pricing.mjs.`);
      }
      /* `spent > 0` is also what decides whether the call is COUNTED, and that
         is deliberate rather than incidental: a response with no `usage` block
         — a 400 schema rejection, a 401, a 529 overload — is not billed by
         Anthropic, so metering it would inflate the total and fire the ceiling
         early on calls that cost nothing. Both fields move together or neither
         does, which keeps `calls` meaning "billed calls" rather than "attempts".
         A successful call always carries usage, and an unrecognised model is
         priced high rather than free, so nothing billable slips through at 0. */
      if (spent > 0) {
        const l = await readLedger();
        await writeFile(LEDGER, JSON.stringify(
          { day: l.day, usd: l.usd + spent, calls: l.calls + 1, basis: LEDGER_BASIS }, null, 2));
      }
    } catch { /* non-JSON error body: nothing to meter */ }

    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      /* The browser cannot see the key, but it should see what the call cost —
         otherwise the spend guard is invisible until it fires. Named `-Est`
         because this is computed from the returned token counts against a local
         price table, not read from Anthropic's billing. */
      'X-Bolt-Call-Usd-Est': spent.toFixed(6),
      'X-Bolt-Day-Usd-Est': (ledger.usd + spent).toFixed(6),
      'X-Bolt-Day-Ceiling': String(DAILY_USD),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
  } catch (err) {
    if (err?.name === 'TimeoutError') return sendJson(res, 504, { error: 'Anthropic timed out', via: 'serve.mjs' });
    sendJson(res, 502, { error: `upstream failure: ${err?.message || err}`, via: 'serve.mjs' });
  }
}

const sendJson = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
};

async function proxySec(req, res, rel) {
  /* CORS headers on every response including errors. These are not what make
     this work: the page and the proxy share an origin, so the browser never
     applies CORS to the call. They are here so the failure mode stays readable
     if the page is ever served from somewhere else. */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'only GET is proxied', via: 'serve.mjs' });
  }

  const rest = rel.slice(4);                    // strip "sec/"
  const slash = rest.indexOf('/');
  const hostKey = slash >= 0 ? rest.slice(0, slash) : rest;
  const tail = slash >= 0 ? rest.slice(slash + 1) : '';

  if (!Object.hasOwn(SEC_HOSTS, hostKey)) {
    return sendJson(res, 400, { error: `unknown host '${hostKey}' - use /sec/data/... or /sec/www/...`, via: 'serve.mjs' });
  }
  /* Reached only by the ENCODED form. A plain `/sec/data/../../x` is collapsed
     to `/x` by the URL parser before it gets here, which is safe but means it
     lands on the static handler and 404s rather than being refused here. The
     form that survives parsing is `/sec/data/..%2f..%2fx`, because encoded
     slashes are not normalised — that is what this catches. */
  if (tail.includes('..')) {
    return sendJson(res, 400, { error: 'path traversal refused', via: 'serve.mjs' });
  }

  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  await waitForSecSlot();

  try {
    const upstream = await fetch(`${SEC_HOSTS[hostKey]}/${tail}${query}`, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(30000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());

    /* Deliberately NOT no-store, unlike the static files below. Those are edited
       while the server runs, so a cached copy is a stale copy of something that
       just changed. EDGAR filings are immutable once filed, so re-fetching them
       on every page reload would spend the 10/sec budget on identical bytes. */
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (err) {
    if (err?.name === 'TimeoutError') return sendJson(res, 504, { error: 'EDGAR timed out after 30s', via: 'serve.mjs' });
    sendJson(res, 502, { error: `upstream failure: ${err?.message || err}`, via: 'serve.mjs' });
  }
}

createServer(async (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(res, 400, { error: 'bad path', via: 'serve.mjs' });
  }

  // Handled before the static lookup, or they would fall through to 404.
  /* How the page tells it is behind this server rather than a plain static
     host (GitHub Pages), which decides proxy mode vs static mode in app.js. */
  if (rel === 'bolt/ping') return sendJson(res, 200, { bolt: true, via: 'serve.mjs' });
  if (rel === 'finnhub' || rel.startsWith('finnhub/')) return proxyFinnhub(req, res, rel);
  if (rel === 'sec' || rel.startsWith('sec/')) return proxySec(req, res, rel);
  if (rel === 'anthropic/messages') return proxyAnthropic(req, res);
  if (rel === 'anthropic/spend') {
    const l = await readLedger();
    return sendJson(res, 200, {
      ...l, ceiling: DAILY_USD, hasKey: !!ANTHROPIC_KEY,
      /* Stated in the payload as well as the UI, so a consumer of this endpoint
         cannot mistake it for billed cost either. */
      estimate: true,
      basis: 'token counts from each response x list prices in pricing.mjs, '
        + 'plus $0.01 per web search. Counts only calls through this proxy. '
        + 'Reconcile at https://platform.claude.com/cost',
      /* Reported rather than assumed by the client. The UI used to state the
         boundary in a hardcoded tooltip, which is how it went on saying "UTC
         midnight" and how nobody could see it was wrong without reading the
         server source. Whatever the server does is now what the page says. */
      dayBasis: LEDGER_BASIS,
      dayWindow: 'bucket',        // resets at the boundary; NOT 24-hour rolling
      timezone: TZ_NAME,
      utcOffset: tzOffsetLabel(),
      resetsAt: nextReset().toISOString(),
      /* So a consumer knows the denominator: refused and errored calls carry no
         usage, are not billed, and are not in either figure. */
      countsBilledCallsOnly: true,
    });
  }

  if (!rel) rel = 'index.html';
  const full = resolve(join(ROOT, normalize(rel)));

  // Refuse anything that escapes the served directory.
  if (full !== ROOT && !full.startsWith(ROOT + '\\') && !full.startsWith(ROOT + '/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      /* These files are edited while the server is running, and the browser was
         given nothing to revalidate against - no ETag, no Last-Modified, no
         Cache-Control - so it was free to keep serving an old copy. That is how
         a newly added button can be missing from a page that reloads fine. */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(PORT, 'localhost', async () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}/`);
  console.log(`EDGAR proxy on /sec/data/... and /sec/www/...`);
  if (FINNHUB_KEY) {
    console.log(`Finnhub proxy on /finnhub/... — key held here, ${FINNHUB_PER_WINDOW}/min `
      + `across every tab, ${FINNHUB_MIN_GAP_MS}ms apart`);
  } else {
    console.log('Finnhub proxy DISABLED — the board cannot load. Set FINNHUB_API_KEY:');
    console.log('  $env:FINNHUB_API_KEY="..."; node serve.mjs');
  }
  const l = await readLedger();

  /* Retire a ledger written under the old basis, once, here. readLedger is kept
     side-effect free — it is called on the ceiling-check path before every call
     — so without this the warning it prints would repeat at every start until
     somebody happened to spend money. */
  try {
    const onDisk = JSON.parse(await readFile(LEDGER, 'utf8'));
    if (onDisk.basis !== LEDGER_BASIS) {
      await writeFile(LEDGER, JSON.stringify(freshLedger(), null, 2));
    }
  } catch { /* no ledger on disk yet, or unreadable: nothing to retire */ }

  if (ANTHROPIC_KEY) {
    const reset = nextReset();
    const hours = (reset - Date.now()) / 3_600_000;
    console.log(`Anthropic proxy on /anthropic/messages — ceiling $${DAILY_USD.toFixed(2)}/day, `
      + `est. $${l.usd.toFixed(4)} spent today (${l.calls} calls)`);
    /* Named rather than assumed, because the two names have different side
       effects on the rest of the machine and only one of them is visible here. */
    if (ANTHROPIC_KEY_VAR === 'BOLT_ANTHROPIC_KEY') {
      console.log('  Key read from BOLT_ANTHROPIC_KEY');
    } else {
      console.log(`  Key read from the FALLBACK ${ANTHROPIC_KEY_VAR} — Claude Code reads that name too,`);
      console.log('  and it takes precedence over a claude.ai login, so anything you run on this');
      console.log('  machine is silently on API billing. Move the key to BOLT_ANTHROPIC_KEY and unset it.');
    }
    /* Printed every start, because the boundary was wrong for weeks and nothing
       on screen said which one was in use. A setting nobody can see is a setting
       nobody can check. */
    console.log(`  Day resets at LOCAL midnight — ${TZ_NAME}, ${tzOffsetLabel()} — `
      + `next at ${reset.toLocaleString()} (in ${hours.toFixed(1)}h)`);
    console.log('  Day BUCKET, not a 24h rolling window: the total resets at that boundary.');
    console.log('  Counts BILLED calls only — a refused or errored call carries no usage and is not metered.');
    console.log('  The spend figure is a LOCAL ESTIMATE from returned token counts, not Anthropic\'s');
    console.log('  billing, and counts only calls through this proxy. Reconcile: platform.claude.com/cost');
  } else {
    console.log('Anthropic proxy DISABLED — set BOLT_ANTHROPIC_KEY to enable /anthropic/messages:');
    console.log('  $env:BOLT_ANTHROPIC_KEY="sk-ant-..."; node serve.mjs');
    console.log('  NOT ANTHROPIC_API_KEY: Claude Code reads that name and it overrides a claude.ai login.');
  }
  console.log('Press Ctrl+C to stop.');
});
