/**
 * SteadyGains — scanner.js
 * ========================
 * Market scanner that pulls price/volume data for the watchlist,
 * calculates all technical indicators, and returns a ranked list
 * of candidates ready for the strategy engine.
 *
 * Indicators computed per symbol:
 *   - RSI (14)
 *   - Bollinger Bands (20, 2)
 *   - SMA 50 & SMA 200
 *   - ATR (14)
 *   - Volume ratio (current vs 20-day avg)
 *   - Price change % (1-day, 5-day)
 */

import { RSI, BollingerBands, SMA, ATR } from 'technicalindicators';
import alpaca from './alpacaClient.js';
import config from './config.js';

// ─── Indicator Calculations ─────────────────────────────────

function calcRSI(closes) {
  const result = RSI.calculate({
    values: closes,
    period: config.strategy.rsiPeriod,
  });
  return result.length > 0 ? result[result.length - 1] : null;
}

function calcBollingerBands(closes) {
  const result = BollingerBands.calculate({
    values: closes,
    period: config.strategy.bbPeriod,
    stdDev: config.strategy.bbStdDev,
  });
  return result.length > 0 ? result[result.length - 1] : null;
}

function calcSMA(closes, period) {
  const result = SMA.calculate({
    values: closes,
    period: period,
  });
  return result.length > 0 ? result[result.length - 1] : null;
}

function calcATR(highs, lows, closes) {
  const result = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.strategy.atrPeriod,
  });
  return result.length > 0 ? result[result.length - 1] : null;
}

function calcVolumeRatio(volumes) {
  const period = config.strategy.volumeAvgPeriod;
  if (volumes.length < period + 1) return null;

  const currentVol = volumes[volumes.length - 1];
  const avgSlice = volumes.slice(-(period + 1), -1);
  const avgVol = avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length;

  return avgVol > 0 ? currentVol / avgVol : null;
}

// ─── Candlestick Pattern Detection ──────────────────────────

function detectBullishReversal(bars) {
  if (bars.length < 3) return false;

  const prev2 = bars[bars.length - 3];
  const prev1 = bars[bars.length - 2];
  const curr  = bars[bars.length - 1];

  // Hammer: small body at top, long lower shadow
  const bodySize = Math.abs(curr.close - curr.open);
  const totalRange = curr.high - curr.low;
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;

  const isHammer = totalRange > 0
    && bodySize / totalRange < 0.35
    && lowerShadow / totalRange > 0.60
    && curr.close > curr.open;

  // Bullish engulfing: red candle followed by larger green candle
  const isEngulfing = prev1.close < prev1.open       // prev was red
    && curr.close > curr.open                         // current is green
    && curr.open <= prev1.close                       // opens at/below prev close
    && curr.close >= prev1.open;                      // closes at/above prev open

  // Morning star: red, small-body doji, green
  const prev1Body = Math.abs(prev1.close - prev1.open);
  const prev1Range = prev1.high - prev1.low;
  const isDoji = prev1Range > 0 && prev1Body / prev1Range < 0.15;
  const isMorningStar = prev2.close < prev2.open      // first red
    && isDoji                                          // middle doji
    && curr.close > curr.open                          // third green
    && curr.close > (prev2.open + prev2.close) / 2;    // closes above midpoint

  return isHammer || isEngulfing || isMorningStar;
}

// ─── Single Symbol Analysis ─────────────────────────────────

function analyzeSymbol(symbol, bars) {
  if (!bars || bars.length < 200) {
    return { symbol, valid: false, reason: 'Insufficient data (need 200+ bars)' };
  }

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const currentPrice = closes[closes.length - 1];
  const currentVol   = volumes[volumes.length - 1];

  // Price filters
  if (currentPrice < config.filters.minPrice || currentPrice > config.filters.maxPrice) {
    return { symbol, valid: false, reason: `Price $${currentPrice} outside range` };
  }

  // Volume filter
  const avgVolume = volumes.slice(-config.strategy.volumeAvgPeriod)
    .reduce((a, b) => a + b, 0) / config.strategy.volumeAvgPeriod;
  if (avgVolume < config.filters.minAvgVolume) {
    return { symbol, valid: false, reason: `Avg volume ${avgVolume.toFixed(0)} below minimum` };
  }

  // Calculate all indicators
  const rsi           = calcRSI(closes);
  const bb            = calcBollingerBands(closes);
  const sma50         = calcSMA(closes, config.strategy.smaPeriodShort);
  const sma200        = calcSMA(closes, config.strategy.smaPeriodLong);
  const atr           = calcATR(highs, lows, closes);
  const volumeRatio   = calcVolumeRatio(volumes);
  const bullishCandle = detectBullishReversal(bars);

  // Price changes
  const change1d = closes.length >= 2
    ? (currentPrice - closes[closes.length - 2]) / closes[closes.length - 2] * 100
    : 0;
  const change5d = closes.length >= 6
    ? (currentPrice - closes[closes.length - 6]) / closes[closes.length - 6] * 100
    : 0;

  // Null checks — skip if any critical indicator failed
  if (rsi === null || bb === null || sma50 === null || atr === null) {
    return { symbol, valid: false, reason: 'Indicator calculation failed' };
  }

  return {
    symbol,
    valid: true,
    price: currentPrice,
    indicators: {
      rsi,
      bb: {
        upper:  bb.upper,
        middle: bb.middle,
        lower:  bb.lower,
        width:  (bb.upper - bb.lower) / bb.middle,
        percentB: bb.upper !== bb.lower
          ? (currentPrice - bb.lower) / (bb.upper - bb.lower)
          : 0.5,
      },
      sma50,
      sma200,
      atr,
      atrPercent: (atr / currentPrice) * 100,
      volumeRatio,
      avgVolume,
      currentVolume: currentVol,
      change1d,
      change5d,
      bullishCandle,
    },
    // These get filled by the strategy engine
    signals: null,
    sector: config.sectors[symbol] || 'unknown',
  };
}

// ─── Full Watchlist Scan ────────────────────────────────────

/**
 * Scan the entire watchlist. Fetches bars in batches to stay
 * within rate limits, then analyzes each symbol.
 *
 * @param {string} timeframe - '1Day', '1Hour', etc.
 * @returns {Object} { candidates: [...], skipped: [...], timestamp }
 */
async function scanWatchlist(timeframe = '1Day') {
  const startTime = Date.now();
  const symbols = config.watchlist;
  const batchSize = 10; // Alpaca multi-bars supports batching
  const allBars = {};

  console.log(`\n📡 Scanning ${symbols.length} symbols (${timeframe})...`);

  // Fetch bars in batches
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);

    // Calculate start date — need 200+ daily bars
    const startDate = new Date();
    if (timeframe === '1Day') {
      startDate.setDate(startDate.getDate() - 365); // 1 year of daily bars
    } else if (timeframe === '1Hour') {
      startDate.setDate(startDate.getDate() - 30);  // 30 days of hourly
    } else {
      startDate.setDate(startDate.getDate() - 14);  // 2 weeks otherwise
    }

    const res = await alpaca.getMultiBars(batch, {
      timeframe,
      start: startDate.toISOString(),
      limit: 250,
    });

    if (res.success) {
      Object.assign(allBars, res.data);
    } else {
      console.warn(`⚠️  Batch fetch failed for [${batch.join(', ')}]: ${res.error?.message}`);
    }

    // Small delay between batches to be nice to the API
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Analyze each symbol
  const candidates = [];
  const skipped = [];

  for (const symbol of symbols) {
    const bars = allBars[symbol];
    const analysis = analyzeSymbol(symbol, bars);

    if (analysis.valid) {
      candidates.push(analysis);
    } else {
      skipped.push({ symbol, reason: analysis.reason });
    }
  }

  // Sort candidates by a simple opportunity score:
  // Lower RSI + higher volume ratio = more interesting
  candidates.sort((a, b) => {
    const scoreA = (100 - a.indicators.rsi) + (a.indicators.volumeRatio || 0) * 10;
    const scoreB = (100 - b.indicators.rsi) + (b.indicators.volumeRatio || 0) * 10;
    return scoreB - scoreA;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   ✅ ${candidates.length} candidates, ${skipped.length} skipped (${elapsed}s)`);

  return {
    candidates,
    skipped,
    timestamp: new Date().toISOString(),
    elapsed: parseFloat(elapsed),
    timeframe,
  };
}

/**
 * Quick scan — only fetch latest quotes for existing watchlist.
 * Much faster than full scan, used for the 15-min check.
 */
async function quickScan(symbols = null) {
  const targetSymbols = symbols || config.watchlist;
  const results = [];

  // Use snapshots endpoint for speed
  const res = await alpaca.getSnapshots(targetSymbols);
  if (!res.success) {
    console.warn(`⚠️  Quick scan failed: ${res.error?.message}`);
    return { results: [], timestamp: new Date().toISOString() };
  }

  for (const [symbol, snapshot] of Object.entries(res.data)) {
    const bar = snapshot.dailyBar;
    const prevBar = snapshot.prevDailyBar;
    const quote = snapshot.latestQuote;

    if (!bar || !prevBar) continue;

    const currentPrice = bar.c;
    const change = prevBar.c > 0 ? ((currentPrice - prevBar.c) / prevBar.c) * 100 : 0;
    const spread = quote ? (quote.ap - quote.bp) : 0;
    const spreadPct = quote && quote.bp > 0 ? spread / quote.bp : 0;

    results.push({
      symbol,
      price: currentPrice,
      change: change,
      volume: bar.v,
      spread: spreadPct,
      sector: config.sectors[symbol] || 'unknown',
    });
  }

  // Filter out illiquid
  const filtered = results.filter(r =>
    r.spread <= config.filters.maxSpreadPercent
  );

  console.log(`⚡ Quick scan: ${filtered.length}/${results.length} symbols liquid`);

  return {
    results: filtered,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Scan a single symbol — used for position monitoring
 */
async function scanSymbol(symbol, timeframe = '1Day') {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 365);

  const res = await alpaca.getBars(symbol, {
    timeframe,
    start: startDate.toISOString(),
    limit: 250,
  });

  if (!res.success) {
    return { symbol, valid: false, reason: res.error?.message };
  }

  return analyzeSymbol(symbol, res.data);
}

export { scanWatchlist, quickScan, scanSymbol, analyzeSymbol };
export default { scanWatchlist, quickScan, scanSymbol, analyzeSymbol };
