/**
 * SteadyGains — strategy.js
 * =========================
 * Conservative swing strategy engine.
 *
 * BUY signal scoring (need 3/5 to enter):
 *   +1  RSI in oversold zone (≤ 35)
 *   +1  Price at or below lower Bollinger Band
 *   +1  Price above SMA-50 (uptrend filter)
 *   +1  Volume spike (≥ 1.3× 20-day avg)
 *   +1  Bullish reversal candlestick pattern
 *
 * EXIT signal triggers (any one is enough):
 *   - RSI overbought (≥ 65)
 *   - Price at upper Bollinger Band
 *   - Profit target hit (3× ATR from entry)
 *   - Stop loss hit (1.5× ATR below entry)
 *   - Time-based exit (5 trading days, no progress)
 *
 * Position sizing:
 *   Risk per trade = 1.5% of equity
 *   Shares = riskAmount / (entry - stopLoss)
 *   Capped at 15% of portfolio per position
 */

import config from './config.js';

const { strategy: strat, risk: riskCfg } = config;

// ─── Signal Types ───────────────────────────────────────────
const SIGNAL = {
  BUY:        'BUY',
  SELL:       'SELL',
  HOLD:       'HOLD',
  PARTIAL:    'PARTIAL_EXIT',   // take partial profits
  STOP:       'STOP_EXIT',      // stop loss triggered
  TARGET:     'TARGET_EXIT',    // profit target hit
  TIME:       'TIME_EXIT',      // held too long
  OVERBOUGHT: 'OVERBOUGHT_EXIT',
};

// ─── Buy Signal Analysis ────────────────────────────────────

/**
 * Evaluate a scanned candidate for buy signals.
 * Returns a detailed signal object with score breakdown.
 *
 * @param {Object} candidate - From scanner.analyzeSymbol()
 * @returns {Object} signal
 */
function evaluateBuySignal(candidate) {
  const { symbol, price, indicators } = candidate;
  const { rsi, bb, sma50, atr, volumeRatio, bullishCandle } = indicators;

  const checks = {
    rsiOversold: false,
    belowLowerBB: false,
    aboveSMA50: false,
    volumeSpike: false,
    bullishReversal: false,
  };

  const reasons = [];
  let score = 0;

  // Check 1: RSI oversold
  if (rsi <= strat.rsiOversold) {
    checks.rsiOversold = true;
    score++;
    reasons.push(`RSI ${rsi.toFixed(1)} ≤ ${strat.rsiOversold} (oversold)`);
  }

  // Check 2: Price at or below lower Bollinger Band
  if (price <= bb.lower * 1.005) { // within 0.5% of lower band
    checks.belowLowerBB = true;
    score++;
    reasons.push(`Price $${price.toFixed(2)} near lower BB $${bb.lower.toFixed(2)}`);
  }

  // Check 3: Price above SMA-50 (uptrend confirmation)
  if (price > sma50) {
    checks.aboveSMA50 = true;
    score++;
    reasons.push(`Price above SMA-50 ($${sma50.toFixed(2)}) — uptrend intact`);
  }

  // Check 4: Volume spike
  if (volumeRatio && volumeRatio >= strat.volumeSpikeRatio) {
    checks.volumeSpike = true;
    score++;
    reasons.push(`Volume ${volumeRatio.toFixed(1)}× avg (spike ≥ ${strat.volumeSpikeRatio}×)`);
  }

  // Check 5: Bullish reversal candlestick
  if (bullishCandle) {
    checks.bullishReversal = true;
    score++;
    reasons.push('Bullish reversal pattern detected');
  }

  // Calculate entry, stop, and target prices
  const stopLoss    = price - (atr * strat.stopLossMultiplier);
  const takeProfit  = price + (atr * strat.takeProfitMultiplier);
  const partialTarget = price + (atr * strat.partialExitRR * strat.stopLossMultiplier);
  const riskPerShare = price - stopLoss;
  const rewardRisk  = riskPerShare > 0 ? (takeProfit - price) / riskPerShare : 0;

  const isBuy = score >= strat.minSignalScore;

  return {
    symbol,
    type:       isBuy ? SIGNAL.BUY : SIGNAL.HOLD,
    score,
    minScore:   strat.minSignalScore,
    triggered:  isBuy,
    checks,
    reasons,
    price,
    entry: {
      price:         price,
      stopLoss:      Math.max(stopLoss, 0.01), // never negative
      takeProfit:    takeProfit,
      partialTarget: partialTarget,
      riskPerShare:  riskPerShare,
      rewardRisk:    rewardRisk,
      atr:           atr,
    },
    indicators: {
      rsi,
      bbPercentB: bb.percentB,
      bbWidth:    bb.width,
      sma50,
      volumeRatio,
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Exit Signal Analysis ───────────────────────────────────

/**
 * Evaluate whether an open position should be exited.
 *
 * @param {Object} position - { symbol, entryPrice, stopLoss, takeProfit, entryDate, qty }
 * @param {Object} candidate - Fresh scan data from scanner
 * @param {number} currentPrice - Latest price
 * @returns {Object} exit signal
 */
function evaluateExitSignal(position, candidate, currentPrice) {
  const { symbol, entryPrice, stopLoss, takeProfit, partialTarget, entryDate } = position;
  const { indicators } = candidate;
  const { rsi, bb } = indicators;

  const exitReasons = [];
  let exitType = SIGNAL.HOLD;
  let urgency = 0; // 0 = hold, 1-3 = increasing urgency to exit

  // Check 1: Stop loss hit
  if (currentPrice <= stopLoss) {
    exitType = SIGNAL.STOP;
    urgency = 3;
    exitReasons.push(`STOP LOSS: Price $${currentPrice.toFixed(2)} ≤ stop $${stopLoss.toFixed(2)}`);
  }

  // Check 2: Full profit target hit
  if (currentPrice >= takeProfit) {
    exitType = SIGNAL.TARGET;
    urgency = 2;
    exitReasons.push(`TARGET HIT: Price $${currentPrice.toFixed(2)} ≥ target $${takeProfit.toFixed(2)}`);
  }

  // Check 3: Partial profit target (sell half)
  if (currentPrice >= partialTarget && exitType === SIGNAL.HOLD) {
    exitType = SIGNAL.PARTIAL;
    urgency = 1;
    exitReasons.push(`PARTIAL TARGET: Price $${currentPrice.toFixed(2)} ≥ $${partialTarget.toFixed(2)}`);
  }

  // Check 4: RSI overbought
  if (rsi >= strat.rsiOverbought && exitType === SIGNAL.HOLD) {
    exitType = SIGNAL.OVERBOUGHT;
    urgency = 2;
    exitReasons.push(`OVERBOUGHT: RSI ${rsi.toFixed(1)} ≥ ${strat.rsiOverbought}`);
  }

  // Check 5: Price at upper Bollinger (potential reversal)
  if (bb.percentB >= 0.95 && rsi >= 60 && exitType === SIGNAL.HOLD) {
    exitType = SIGNAL.OVERBOUGHT;
    urgency = 1;
    exitReasons.push(`Upper BB + elevated RSI: potential reversal`);
  }

  // Check 6: Time-based exit
  if (entryDate) {
    const holdingDays = getTradingDaysBetween(new Date(entryDate), new Date());
    if (holdingDays >= strat.maxHoldingDays) {
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      // Only time-exit if the trade isn't strongly profitable
      if (pnlPercent < 3) {
        exitType = exitType === SIGNAL.HOLD ? SIGNAL.TIME : exitType;
        urgency = Math.max(urgency, 1);
        exitReasons.push(`STALE: Held ${holdingDays} days with only ${pnlPercent.toFixed(1)}% gain`);
      }
    }
  }

  // P&L calculations
  const unrealizedPnl = (currentPrice - entryPrice) * (position.qty || 0);
  const unrealizedPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

  return {
    symbol,
    type: exitType,
    triggered: exitType !== SIGNAL.HOLD,
    urgency,
    reasons: exitReasons,
    currentPrice,
    entryPrice,
    unrealizedPnl,
    unrealizedPct,
    // How much to sell
    exitQty: exitType === SIGNAL.PARTIAL
      ? Math.floor((position.qty || 0) * strat.partialExitRatio)
      : (position.qty || 0),
    timestamp: new Date().toISOString(),
  };
}

// ─── Position Sizing ────────────────────────────────────────

/**
 * Calculate how many shares to buy based on risk management.
 *
 * @param {number} equity - Current portfolio equity
 * @param {number} entryPrice - Planned entry price
 * @param {number} stopLoss - Planned stop loss price
 * @param {number} buyingPower - Available buying power
 * @returns {Object} { shares, dollarAmount, riskAmount, riskPercent }
 */
function calculatePositionSize(equity, entryPrice, stopLoss, buyingPower) {
  // Risk amount = equity × max risk per trade
  const riskAmount = equity * riskCfg.maxRiskPerTrade;

  // Risk per share = entry - stop
  const riskPerShare = entryPrice - stopLoss;
  if (riskPerShare <= 0) {
    return { shares: 0, dollarAmount: 0, riskAmount: 0, riskPercent: 0, reason: 'Invalid stop loss (above entry)' };
  }

  // Shares from risk: how many shares fit within our risk budget
  let shares = Math.floor(riskAmount / riskPerShare);

  // Cap by max portfolio allocation per stock
  const maxDollarAmount = equity * riskCfg.maxPortfolioPerStock;
  const maxSharesByAllocation = Math.floor(maxDollarAmount / entryPrice);
  shares = Math.min(shares, maxSharesByAllocation);

  // Cap by available buying power (leave cash reserve)
  const usableBuyingPower = buyingPower * (1 - riskCfg.minCashReserve);
  const maxSharesByPower = Math.floor(usableBuyingPower / entryPrice);
  shares = Math.min(shares, maxSharesByPower);

  // Must buy at least 1 share
  shares = Math.max(shares, 0);

  const dollarAmount = shares * entryPrice;
  const actualRisk = shares * riskPerShare;
  const actualRiskPercent = equity > 0 ? (actualRisk / equity) * 100 : 0;

  return {
    shares,
    dollarAmount,
    riskAmount:  actualRisk,
    riskPercent: actualRiskPercent,
    maxRiskAllowed: riskAmount,
    reason: shares === 0
      ? 'Position size too small (account too small or stop too wide)'
      : `${shares} shares @ $${entryPrice.toFixed(2)} = $${dollarAmount.toFixed(2)} (${actualRiskPercent.toFixed(1)}% risk)`,
  };
}

// ─── Batch Signal Generation ────────────────────────────────

/**
 * Generate signals for all candidates from a scan.
 * Returns only actionable signals (BUY with score >= min).
 *
 * @param {Array} candidates - From scanner.scanWatchlist()
 * @returns {Array} actionable buy signals, sorted by score desc
 */
function generateSignals(candidates) {
  const signals = [];

  for (const candidate of candidates) {
    const signal = evaluateBuySignal(candidate);

    // Attach the signal back to the candidate
    candidate.signals = signal;

    if (signal.triggered) {
      signals.push(signal);
    }
  }

  // Sort by score (highest first), then by reward:risk ratio
  signals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.rewardRisk - a.entry.rewardRisk;
  });

  console.log(`\n🎯 Signals: ${signals.length} BUY out of ${candidates.length} scanned`);
  for (const s of signals) {
    console.log(`   ${s.symbol}: score ${s.score}/${strat.maxSignalScore} | R:R ${s.entry.rewardRisk.toFixed(1)}:1 | ${s.reasons.join(', ')}`);
  }

  return signals;
}

/**
 * Generate exit signals for all open positions.
 *
 * @param {Array} positions - Array of { symbol, entryPrice, stopLoss, takeProfit, partialTarget, entryDate, qty }
 * @param {Array} scanData - Fresh scan results for position symbols
 * @param {Object} latestPrices - { SYMBOL: price } map
 * @returns {Array} exit signals that were triggered
 */
function generateExitSignals(positions, scanData, latestPrices) {
  const exitSignals = [];

  for (const position of positions) {
    const candidate = scanData.find(c => c.symbol === position.symbol);
    const currentPrice = latestPrices[position.symbol] || position.currentPrice;

    if (!candidate || !currentPrice) {
      console.warn(`⚠️  No scan data for open position ${position.symbol}`);
      continue;
    }

    const exitSignal = evaluateExitSignal(position, candidate, currentPrice);

    if (exitSignal.triggered) {
      exitSignals.push(exitSignal);
      console.log(`   🚪 ${exitSignal.symbol}: ${exitSignal.type} — ${exitSignal.reasons.join(', ')}`);
    }
  }

  return exitSignals;
}

// ─── Weekend Risk Reduction ─────────────────────────────────

/**
 * On Friday afternoon, tighten all stops to reduce weekend gap risk.
 * Returns modified stop levels for each position.
 */
function getWeekendStops(positions, currentPrices) {
  const adjustments = [];

  for (const pos of positions) {
    const currentPrice = currentPrices[pos.symbol];
    if (!currentPrice) continue;

    const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    let newStop;
    if (pnlPercent > 2) {
      // Profitable — lock in at least breakeven
      newStop = pos.entryPrice * 1.002; // breakeven + tiny buffer
    } else if (pnlPercent > 0) {
      // Slightly profitable — tighten stop to 0.5% below current
      newStop = currentPrice * 0.995;
    } else {
      // Losing — tighten to 1% below current (limit weekend damage)
      newStop = currentPrice * 0.99;
    }

    // Only tighten, never loosen
    if (newStop > pos.stopLoss) {
      adjustments.push({
        symbol: pos.symbol,
        oldStop: pos.stopLoss,
        newStop: newStop,
        reason: `Weekend tightening (P&L: ${pnlPercent.toFixed(1)}%)`,
      });
    }
  }

  return adjustments;
}

// ─── Compounding Logic ──────────────────────────────────────

/**
 * Adjust position sizing based on weekly performance.
 * If we've hit the weekly target, reduce size to protect gains.
 * If we're behind, keep standard sizing (don't increase risk!).
 */
function getCompoundingMultiplier(weeklyPnlPercent) {
  if (!config.compounding.enabled) return 1.0;

  const target = config.compounding.weeklyTarget * 100; // convert to %

  if (weeklyPnlPercent >= target) {
    // Hit target — reduce position sizes to protect gains
    return config.compounding.targetHitReduction;
  } else if (weeklyPnlPercent <= -2) {
    // Down 2%+ this week — be more conservative
    return 0.5;
  }

  return 1.0; // standard sizing
}

// ─── Helpers ────────────────────────────────────────────────

function getTradingDaysBetween(start, end) {
  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++; // skip weekends
    current.setDate(current.getDate() + 1);
  }

  return count;
}

// ─── Export ─────────────────────────────────────────────────
export {
  SIGNAL,
  evaluateBuySignal,
  evaluateExitSignal,
  calculatePositionSize,
  generateSignals,
  generateExitSignals,
  getWeekendStops,
  getCompoundingMultiplier,
};

export default {
  SIGNAL,
  evaluateBuySignal,
  evaluateExitSignal,
  calculatePositionSize,
  generateSignals,
  generateExitSignals,
  getWeekendStops,
  getCompoundingMultiplier,
};
