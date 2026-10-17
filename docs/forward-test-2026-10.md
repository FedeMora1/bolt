# Forward test: the September snapshot, three weeks on

**Window: close of Fri 2026-09-25 → close of Fri 2026-10-16** (15 trading days).
The committed snapshot (`data/snapshot/`, commit `495cc6c`) is dated
2026-09-28 03:55 UTC, Sunday evening US time, so the last price anyone could act
on was the Sep 25 close. Every return is measured from there.

**Short answer.** Three of the four headline scores **reversed hard or did nothing**
over the window. Overall, Analyst and the AI ratings are **within noise**.
Technicals and both Fundamentals scores show **large spreads**, too large to be
stock-by-stock luck. But they come from one three-week window that looks like a
single market event: a sell-off in the momentum leaders (storage and chip makers among them) and a bounce in
cheaper names. One window says the event was real. It does not say the scores
work or fail.

## How it was run

- **Scores: the snapshot only.** `tools/snapshot-scores.mjs` loads the real
  `app.js` in a sandbox with its clock pinned to the snapshot's `asOf`, and
  feeds it nothing but the four committed `data/snapshot/*.json` files, in the
  same steps `loadSnapshot()` takes in the browser. Nothing fetched after the
  snapshot reaches a score. 574 symbols got a row.
- **Start price: the Sep 25 close**, from the refreshed local price store
  (Polygon, split-adjusted), found by counting trading days back from each
  series' last bar (no market holiday in the window). The snapshot's own quotes
  could not be used directly: 232 of them were last fetched on Sep 15, so they
  would have mixed two different windows. As a check, the 347 symbols whose
  snapshot quote *was* taken after the Sep 25 close all match the series' Sep 25
  close within 0.5%.
- **End price: the Oct 16 close**, Finnhub `/quote` fetched after the close. Every
  symbol's series close for Oct 15 matched the quote's previous close within
  0.5%, so no split or bad bar slipped in.
- **Price return only.** Dividends are ignored (a few tenths of a percent over
  three weeks at most).
- **Fifths:** scored and priced stocks sorted by snapshot score, cut into five
  equal groups. **Spread** = mean return of the top fifth minus the bottom fifth.
  **± SE** = standard error of that difference (Welch). **IC** = rank correlation
  of score with return (± ≈ 1/√n). **Sector-neutral** repeats the spread on each
  stock's return minus its sector's average.
- `tools/forward-test-report.mjs` does the arithmetic, so the run can be repeated with
  later prices.

**Coverage.** 558 of 574 scored stocks are priced. 16 were dropped, each for a
stated reason. Fourteen have no current quote, most likely acquired or delisted
(CFLT, ALTR, EA, IPG, SKX, K, HOLX, EXAS, MASI, DFS, CMA, HES, CTRA, AVB). QRVO
and WBD have quotes dated Oct 2 and Oct 5. Leaving out acquired names usually
leaves out deal-premium jumps. With 16 names that is small, but not nothing.

## The market over the window

| | Return |
|---|---|
| **SPY** (771.35 → 763.25) | **−1.05%** |
| All 558 stocks, equal-weight mean | +1.77% |
| All 558 stocks, median | +2.30% |
| Cross-sectional standard deviation | 8.9% |

The average stock beat SPY by about 2.8 points. That fits the same rotation:
SPY is weighted toward the biggest, highest-momentum names.

## Results by score

Returns are Sep 25 close → Oct 16 close. Fifth 1 = lowest score, fifth 5 = highest.

### Overall: within noise

| Fifth | n | Score range | Mean | Median |
|---|---|---|---|---|
| 1 | 112 | 10.8–39.8 | +1.76% | +2.85% |
| 2 | 111 | 39.9–48.1 | +2.05% | +2.09% |
| 3 | 112 | 48.2–55.9 | +2.59% | +2.81% |
| 4 | 111 | 55.9–65.9 | +2.26% | +2.38% |
| 5 | 112 | 65.9–89.0 | +0.22% | +1.33% |

**Spread −1.55% ± 1.31** (t −1.2) · sector-neutral −1.63% ± 1.19 · IC −0.02 ± 0.04.
Its parts pulled in opposite directions (Technicals down, Fundamentals up), and
the equal-weight average largely cancelled them.

### Technicals (12-1 momentum, the score in Overall): large reversal

| Fifth | n | Score range | Mean | Median |
|---|---|---|---|---|
| 1 | 112 | 17.6–42.2 | +2.41% | +2.82% |
| 2 | 111 | 42.4–50.6 | +4.37% | +4.41% |
| 3 | 112 | 50.9–58.4 | +3.49% | +4.62% |
| 4 | 111 | 58.4–68.4 | +1.36% | +1.01% |
| 5 | 112 | 68.6–100.0 | **−2.74%** | **−2.35%** |

**Spread −5.15% ± 1.46** (t −3.5) · sector-neutral −4.87% ± 1.38 · IC −0.22 ± 0.04.

The top fifth fell while the market's average stock rose. It survives removing
sector effects, and clipping every return at ±25% (−4.90%), so it is not a few
blow-ups. The biggest losers were top-momentum names: STX −30%, WDC −27%,
INTC −27%, ARM −27% (all scored 83–100).

**Yardstick.** The ± above treats 112 stocks as 112 independent bets. They are
not: momentum winners move together. A better measure of noise is how much the same
spread swings from one three-week window to the next. Measured on the
snapshot's own price history (raw 12-1 momentum, 357 stocks, 15 separate
three-week windows over the past year), the spread averaged +0.07% with a
**standard deviation of 2.65%**, ranging from −3.9% to +4.6%. So −5.15% is about
two of those deviations, and **larger than any of the 15 windows before it**.
That is unusual, but momentum is known for occasional sharp reversals, and this
is one window.

### Fundamentals (accruals, the score in Overall): large positive spread

| Fifth | n | Score range | Mean | Median |
|---|---|---|---|---|
| 1 | 108 | 0.0–23.9 | **−1.47%** | −0.99% |
| 2 | 108 | 24.1–41.6 | +2.52% | +2.23% |
| 3 | 108 | 41.6–57.4 | +3.02% | +3.64% |
| 4 | 108 | 57.5–80.9 | +1.44% | +1.40% |
| 5 | 108 | 81.2–100.0 | +3.62% | +6.05% |

**Spread +5.08% ± 1.42** (t 3.6) · sector-neutral +3.83% ± 1.36 · IC +0.20 ± 0.04.

Not a clean staircase: fifths 2–5 are close together, and most of the spread is
the **bottom fifth** losing ground. About a quarter of the spread is sector
(sector-neutral 3.8%). Accruals has almost no rank correlation with momentum
(−0.03), so this is not just the Technicals result in reverse.

### Fundamentals (earnings yield, the Fundamentals tab's first column): large positive spread

| Fifth | n | Score range | Mean | Median |
|---|---|---|---|---|
| 1 | 99 | 7.3–28.1 | **−2.91%** | −1.60% |
| 2 | 99 | 28.2–43.5 | +2.16% | +2.07% |
| 3 | 98 | 43.8–63.4 | +3.99% | +3.65% |
| 4 | 99 | 63.7–84.4 | +4.24% | +4.99% |
| 5 | 99 | 84.4–100.0 | +3.17% | +1.80% |

**Spread +6.08% ± 1.28** (t 4.7) · sector-neutral +3.95% ± 1.20 · IC +0.22 ± 0.04.

The same shape: the most expensive fifth fell, and the rest moved together. A
third of the spread is sector. Earnings yield correlates −0.18 with momentum,
so part of this is the momentum reversal seen from the other side.

There is no history-based yardstick for either Fundamentals score: the store
holds current filings, not point-in-time ones, which is also why these scores
have no backtest tab.

### Analyst: within noise

| Fifth | n | Score range | Mean | Median |
|---|---|---|---|---|
| 1 | 112 | 0.1–20.1 | +1.87% | +3.01% |
| 2 | 111 | 20.3–40.1 | +3.65% | +4.79% |
| 3 | 112 | 40.3–60.1 | +2.31% | +1.95% |
| 4 | 111 | 60.3–79.9 | +0.09% | +1.07% |
| 5 | 112 | 80.1–99.9 | +0.95% | +1.97% |

**Spread −0.92% ± 1.27** (t −0.7) · sector-neutral −0.72% ± 1.17 · IC −0.10 ± 0.04.

The top-minus-bottom spread is noise. The rank correlation leans slightly
negative, but Analyst correlates +0.19 with momentum, so the momentum reversal
alone would produce a tilt like this.

### AI 1–10 ratings: not enough spread for fifths

Only **46** stocks have a rating in the snapshot, all written Sep 1–4 (three to
four weeks before the snapshot, so the window starts weeks after the rating).
Ratings run 3–7 and 22 of the 46 are a 5, so equal fifths are impossible.
Grouped by rating instead:

| Rating | n | Mean | Median |
|---|---|---|---|
| ≤4 | 3 | −0.38% | +5.63% |
| 5 | 22 | −1.81% | +1.10% |
| 6 | 13 | −3.11% | −4.86% |
| 7 | 8 | +3.35% | +6.98% |

**Rated 6+ minus rated ≤5: +0.99% ± 3.11** (t 0.3) · IC +0.06 ± 0.15.
That is noise. With 46 names and this little spread, a real effect would have to
be very large to show.

## What stands out, and what doesn't

1. **Within noise:** Overall, Analyst, and the AI ratings. Nothing to read into them.
2. **Not noise for this window:** Technicals (−5.2%), accruals (+5.1%) and
   earnings yield (+6.1%). Each is more than three standard errors from zero,
   and the momentum spread is bigger than any of the previous 15 three-week
   windows.
3. **But it is one event, not three findings.** All three fit one story: three
   weeks in which last year's winners (the biggest losers were storage and chip makers) sold
   off and cheaper names caught up. A single window cannot separate "the score
   predicts" from "the score happened to be on the right side of one rotation".
   That takes many windows.
4. **Nothing here justifies changing a status or weight.** Momentum stays
   provisional. Its one earlier independent window was a rising market, and
   this one went the other way. The Fundamentals results are the first
   forward evidence for those scores in this repo, and they are worth
   re-checking at the next refresh.
5. **A data note on the snapshot itself:** its price histories end on Sep 4
   (357 stocks) or Sep 11 (204), and 232 of its quotes date from Sep 15. The
   Technicals scores it published were therefore two to three weeks old on the
   day it is dated. **Fixed 2026-10-17:** the snapshot was rebuilt from a fully
   refreshed board, and its banner now shows each part's own date and names
   anything older than the snapshot. This test still scores the September
   snapshot as it was published (commit `495cc6c`).

## Re-running

```
node tools/snapshot-scores.mjs scores.json
node tools/forward-test-report.mjs scores.json closes.json quotes.json result.json
```

`closes.json` is the last 20 closes per symbol from the local board's price
store; `quotes.json` is one Finnhub `/quote` per symbol (through `serve.mjs`).
Neither is committed.

`snapshot-scores.mjs` scores whatever is in `data/snapshot/`, which has since
been replaced by the October snapshot. To reproduce this test, first restore
the September files: `git checkout 495cc6c -- data/snapshot` (and
`git checkout HEAD -- data/snapshot` afterwards).
