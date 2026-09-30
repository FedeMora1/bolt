/* Static mode, end to end, in a real browser.
 *
 * The page is served the way GitHub Pages serves it — plain files, no
 * serve.mjs — and walked through a first visit: the key gate, a key, the
 * board, a detail panel. Screenshots of each step go to e2e/screenshots/.
 *
 * MOCKED by default. Every request to finnhub.io is answered here with
 * invented data for invented tickers (ZZ*), and the key is a dummy, so the run
 * needs no account and nothing leaves the machine. What that proves is the
 * app's side: mode detection, the key flow, the direct-call shape, rendering.
 * It does NOT prove Finnhub still answers the way the mocks say.
 *
 * The @live test does, and is skipped unless you supply a key yourself:
 *   $env:BOLT_LIVE_KEY = "your-finnhub-key"; npm run test:live
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROXY_PORT } from './playwright.config.mjs';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const shotPath = (name) => SHOTS + name;
const shot = (page, name) => page.screenshot({ path: shotPath(name) });

const DUMMY_KEY = 'e2e-dummy-key';

/* 32 names, not 3: the analyst percentile — and so Overall — is withheld below
   PCT_MIN_COHORT = 30 scored names, by design. Three rows would test a board
   whose headline columns are blank for a reason no visitor ever hits (a first
   visit loads all 579). ZZAA .. ZZAZ, ZZBA .. ZZBF. */
const TICKERS = Array.from({ length: 32 }, (_, i) =>
  `ZZ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

/* Distinct distributions so the rows score differently: coverage from thin to
   deep, consensus from Hold-heavy to Strong-Buy-heavy, and a drift in the older
   months so momentum is non-zero. Newest first, four consecutive months — the
   shape Finnhub actually returns. */
const PERIODS = ['2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01'];
function trendFor(i) {
  const coverage = 2 + ((i * 7) % 38);
  const bull = (i % 11) / 10;
  const months = [];
  for (let m = 0; m < 4; m++) {
    const b = Math.max(0, Math.min(1, bull - m * (i % 3 - 1) * 0.05));
    const strongBuy = Math.round(coverage * b * 0.4);
    const buy = Math.round(coverage * b * 0.5);
    const sell = Math.round(coverage * (1 - b) * 0.15);
    const strongSell = Math.round(coverage * (1 - b) * 0.05);
    const hold = Math.max(0, coverage - strongBuy - buy - sell - strongSell);
    months.push([strongBuy, buy, hold, sell, strongSell]);
  }
  return months;
}
const TRENDS = Object.fromEntries(TICKERS.map((s, i) => [s, trendFor(i)]));
const PRICES = Object.fromEntries(TICKERS.map((s, i) => [s, +(20 + i * 7.31).toFixed(2)]));

function finnhubMock(url) {
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const symbol = url.searchParams.get('symbol') || '';
  const json = (body, status = 200) => ({ status, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });

  switch (path) {
    case '/quote': {
      const c = PRICES[symbol] ?? 100;
      return json({ c, d: +(c * 0.012).toFixed(2), dp: 1.2, h: c * 1.02, l: c * 0.98, o: c * 0.99,
        pc: +(c / 1.012).toFixed(2), t: Math.floor(Date.now() / 1000) });
    }
    case '/stock/recommendation':
      return json((TRENDS[symbol] || []).map(([strongBuy, buy, hold, sell, strongSell], i) =>
        ({ symbol, period: PERIODS[i], strongBuy, buy, hold, sell, strongSell })));
    case '/stock/profile2':
      return json({ ticker: symbol, name: `${symbol} Test Holdings`, finnhubIndustry: 'Technology',
        marketCapitalization: 12345, logo: '', weburl: '', country: 'US', exchange: 'TEST' });
    case '/stock/insider-transactions':
      return json({ symbol, data: [] });
    case '/search':
      return json({ count: 0, result: [] });
    default:   // price-target, candle: premium on the free plan, and 403 there
      return json({ error: "You don't have access to this resource." }, 403);
  }
}

/** A returning visit would carry a watchlist; a first visit gets the full
    579-name universe, which at the free tier's pace is a half-hour load. Seed
    the three fake names instead, and mark the universe version as current so
    loadWatchlist does not overwrite them. */
async function seedWatchlist(page, symbols) {
  await page.addInitScript(([list]) => {
    if (sessionStorage.getItem('e2e-seeded')) return;   // once, not on every navigation
    sessionStorage.setItem('e2e-seeded', '1');
    localStorage.setItem('bar.universeVersion', '2');
    localStorage.setItem('bar.watchlist', JSON.stringify(list));
  }, [symbols]);
}

/* The front door. A first visit to the hosted site, with no key and no setup,
   must land on a working board drawn from the published snapshot — and spend
   nothing doing it. Uses the real data/snapshot/ files. */
test('snapshot: first visit shows a working board with no key', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  const external = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost' && !/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) external.push(r.url());
  });
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-server', 'static');
  await expect(page.locator('#snapshot-bar')).toBeVisible();
  await expect(page.locator('#snapshot-date')).not.toBeEmpty();
  await expect(page.locator('#key-gate'), 'the key gate is an option, not the front door').toBeHidden();

  // Board: real companies, scored, once prices and fundamentals have streamed in.
  await page.waitForFunction(() => state.px.hydrated && state.fx.hydrated && state.rows.size > 500, null, { timeout: 30_000 });
  const stats = await page.evaluate(() => {
    const rows = [...state.rows.values()];
    const n = (f) => rows.filter((r) => r[f] != null).length;
    return { rows: rows.length, analyst: n('analystPct'), mom12: n('mom12Only'), accruals: n('accrualsOnly'),
      overall: rows.filter((r) => overallFor(r)?.value != null).length };
  });
  console.log('snapshot board:', JSON.stringify(stats));
  expect(stats.analyst).toBeGreaterThan(500);
  expect(stats.mom12).toBeGreaterThan(500);
  expect(stats.accruals).toBeGreaterThan(500);

  // Read-only: nothing that edits the board or the log, but the way to live data stays.
  await expect(page.locator('html')).toHaveAttribute('data-snapshot', 'true');
  await expect(page.locator('#data-menu')).toBeHidden();
  await expect(page.locator('#assess-export')).toBeHidden();
  await expect(page.locator('#assess-import')).toBeHidden();
  await expect(page.locator('#board-body .row-remove').first()).toBeHidden();
  await expect(page.locator('#board-head .remove-col')).toBeHidden();
  await expect(page.locator('#snapshot-live')).toBeVisible();

  // The status line: shown and scored only, and inside the card at any width.
  await expect(page.locator('#board-meta')).toHaveText(/^\d+ shown · \d+ scored [^·]+$/);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const over = await page.locator('#board-meta').evaluate((el) =>
      el.getBoundingClientRect().right - el.closest('.card-head').getBoundingClientRect().right);
    expect(over, `status line overflows the card at ${width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The Recent strip scrolls inside the card rather than running past it.
  await expect(page.locator('#assess-recent')).toBeVisible();
  const recentOver = await page.locator('#assess-recent').evaluate((el) =>
    el.getBoundingClientRect().right - document.querySelector('#board').getBoundingClientRect().right);
  expect(recentOver, 'the Recent strip runs past the card').toBeLessThanOrEqual(0);
  await shot(page, 'snapshot-01-board.png');

  // A detail panel on a real name: price chart from the stored series.
  const first = page.locator('#board-body tr[data-symbol]').first();
  const symbol = await first.getAttribute('data-symbol');
  await first.locator('td').first().click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText(symbol);
  await detail.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80));
  await shot(page, 'snapshot-02-detail-technicals.png');

  await detail.locator('button', { hasText: /^\s*Analyst/ }).first().click();
  await expect(detail).toContainText(/Level/);
  await detail.screenshot({ path: shotPath('snapshot-03-detail-analyst.png') });

  // The assessment log arrived, and a brief opens from the board.
  await page.waitForFunction(() => Object.keys(state.assessBySymbol).length > 0, null, { timeout: 15_000 });
  const assessed = await page.evaluate(() => Object.keys(state.assessBySymbol)[0]);
  await page.evaluate((s) => openAssessment(s), assessed);
  await expect(page.locator('#detail')).toContainText(assessed);
  await page.waitForTimeout(400);
  await shot(page, 'snapshot-04-assessment.png');

  // Backtest and Ratings run on the snapshot too.
  await page.locator('#open-backtest').click();
  await expect(page.locator('#backtest')).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, 'snapshot-05-backtest.png');
  await page.locator('#open-ratings').click();
  await expect(page.locator('#ratings')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'snapshot-06-ratings.png');

  expect(external, 'a snapshot visit reaches no API at all').toEqual([]);
  const unexpected = failed.filter((f) => !/\/bolt\/ping$/.test(f));
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('static mode: Use live data → key → live board → detail panel (mocked Finnhub)', async ({ page }) => {
  const finnhubCalls = [];
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  /* Failed requests are collected by URL instead of by console text, which
     says only "Failed to load resource" and cannot be checked against intent. */
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/finnhub')) finnhubCalls.push({ proxied: true, url: r.url() });
  });
  await page.route('https://finnhub.io/**', (route) => {
    const req = route.request();
    finnhubCalls.push({ url: req.url(), headers: req.headers() });
    return route.fulfill(finnhubMock(new URL(req.url())));
  });
  await seedWatchlist(page, TICKERS);

  // 1. First visit lands on the snapshot; "Use live data" opens the key gate.
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-server', 'static');
  await expect(page.locator('#snapshot-bar')).toBeVisible();
  await page.locator('#snapshot-live').click();
  await expect(page.locator('#key-gate')).toBeVisible();
  await expect(page.locator('#finnhub-key-input')).toBeVisible();
  await expect(page.locator('#static-note')).toBeVisible();
  await expect(page.locator('#fx-controls')).toBeHidden();
  await expect(page.locator('.assess-batch')).toBeHidden();
  expect(finnhubCalls, 'no key yet, so nothing may be spent').toHaveLength(0);
  await shot(page, '01-key-gate.png');

  // 2. Enter a key. It is checked, saved, and the page reloads into live mode.
  await page.locator('#finnhub-key-input').fill(DUMMY_KEY);
  await shot(page, '02-key-entered.png');
  await Promise.all([
    page.waitForEvent('load'),
    page.locator('#finnhub-key-form button[type="submit"]').click(),
  ]);
  expect(await page.evaluate(() => localStorage.getItem('bar.apiKey'))).toBe(DUMMY_KEY);
  await expect(page.locator('#snapshot-bar'), 'live mode is not labelled a snapshot').toBeHidden();

  // 3. The board loads every name, at the app's real Finnhub pace (~1 call/s).
  await page.waitForFunction((n) => !state.loading && state.rows.size === n, TICKERS.length, { timeout: 240_000 });
  await page.locator('#key-gate').evaluate((el) => { el.hidden = true; });   // as clicking Key would
  for (const s of TICKERS) await expect(page.locator(`#board-body tr[data-symbol="${s}"]`)).toBeAttached();
  await expect(page.locator('#board-body [data-assess]').first()).toBeHidden();
  // Live data is the visitor's own board again: removing a row is back.
  await expect(page.locator('html')).not.toHaveAttribute('data-snapshot', /.*/);
  await expect(page.locator('#board-body .row-remove').first()).toBeVisible();
  const pct = await page.evaluate(() => [...state.rows.values()].filter((r) => r.analystPct != null).length);
  expect(pct, 'every name gets an analyst percentile once the cohort is large enough').toBe(TICKERS.length);
  await shot(page, '03-board-loaded.png');

  // 4. Click a ticker: the detail panel opens on it.
  await page.locator('#board-body tr[data-symbol="ZZAA"] td').first().click();
  const detail = page.locator('#detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('ZZAA');
  await page.waitForTimeout(500);   // lazy profile fetch lands
  await detail.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80));
  await shot(page, '04-detail-panel.png');

  // 5. The Analyst tab — what a Finnhub-only visitor actually has to look at.
  const analystTab = detail.locator('button', { hasText: /^\s*Analyst/ }).first();
  await analystTab.click();
  await expect(detail).toContainText(/analysts?/i);
  await detail.screenshot({ path: shotPath('05-detail-analyst-tab.png') });

  // Every Finnhub call went direct, carried the key, and stayed a simple request.
  expect(finnhubCalls.filter((c) => c.proxied), 'nothing may try the /finnhub proxy path').toHaveLength(0);
  for (const c of finnhubCalls) {
    expect(new URL(c.url).searchParams.get('token')).toBe(DUMMY_KEY);
    expect(c.headers['x-bolt-context'], 'a custom header would fail Finnhub\'s preflight').toBeUndefined();
  }
  expect(errors, 'no page errors').toEqual([]);

  /* Exactly two kinds of failure are intended: the one 404 that IS the mode
     detection, and the free plan refusing a premium endpoint (mocked as it
     answers). Anything else — a serve.mjs-only path like /sec/ or /anthropic/
     fired in static mode — is a request a Pages visitor would see fail. */
  const unexpected = failed.filter((f) =>
    !/^404 http:\/\/localhost:\d+\/bolt\/ping$/.test(f)
    && !/^403 https:\/\/finnhub\.io\/api\/v1\/stock\/(price-target|candle)\?/.test(f));
  expect(unexpected, 'no serve.mjs-only path is called in static mode').toEqual([]);
  expect(failed.filter((f) => f.includes('/bolt/ping')), 'detection asks once per page load').toHaveLength(2);
});

/* The other side of detection: with serve.mjs behind the page, nothing about
   local mode may change. serve.mjs runs with every key blanked, and the one
   request it would forward outside the machine (EDGAR's ticker map) is answered
   here instead. */
test('proxy mode: serve.mjs behind the page keeps local mode', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const asked = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.route(/\/sec\//, (route) => route.fulfill({ status: 404, body: '' }));
  await seedWatchlist(page, TICKERS);

  await page.goto(`http://localhost:${PROXY_PORT}/`);
  await expect(page.locator('html')).toHaveAttribute('data-server', 'proxy');
  await expect(page.locator('#key-gate')).toBeVisible();
  await expect(page.locator('#key-finnhub')).toContainText('FINNHUB_API_KEY');
  await expect(page.locator('#finnhub-key-input'), 'no browser key field in proxy mode').toHaveCount(0);
  await expect(page.locator('#static-note')).toBeHidden();
  await expect(page.locator('#assess-spend')).toContainText('BOLT_ANTHROPIC_KEY');
  expect(asked).toContain('/anthropic/spend');
  expect(asked).toContain('/sec/www/files/company_tickers.json');
  expect(errors).toEqual([]);
  await shot(page, 'proxy-01-no-server-key.png');
});

test('static mode against the real Finnhub @live', async ({ page }) => {
  const key = process.env.BOLT_LIVE_KEY;
  test.skip(!key, 'set BOLT_LIVE_KEY to run against the real Finnhub');
  const symbols = (process.env.BOLT_LIVE_SYMBOLS || 'AAPL,MSFT,JPM').split(',').map((s) => s.trim());

  await seedWatchlist(page, symbols);
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-server', 'static');
  await shot(page, 'live-01-key-gate.png');

  await page.locator('#finnhub-key-input').fill(key);
  await page.locator('#finnhub-key-form button[type="submit"]').click();
  await expect(page.locator('#key-finnhub .key-ok')).toBeVisible({ timeout: 20_000 });
  await page.locator('#finnhub-key-input').evaluate((el) => { el.value = ''; });

  await page.waitForFunction((n) => !state.loading && state.rows.size === n, symbols.length, { timeout: 80_000 });
  await page.locator('#key-gate').evaluate((el) => { el.hidden = true; });
  await shot(page, 'live-02-board.png');

  await page.locator(`#board-body tr[data-symbol="${symbols[0]}"] td`).first().click();
  await expect(page.locator('#detail')).toContainText(symbols[0]);
  await page.locator('#detail').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await shot(page, 'live-03-detail.png');
});
