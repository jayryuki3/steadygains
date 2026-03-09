/**
 * SteadyGains — riskManager.js
 * ============================
 * Portfolio-level risk gatekeeper. Every trade MUST pass all checks
 * before execution. This is the safety net that prevents blowing
 * up the account.
 *
 * 11-Point Pre-Trade Validation:
 *  1. Position size limit (max 15% of portfolio per stock)
 *  2. Max open positions (5)
 *  3. Daily loss circuit breaker (3%)
 *  4. Weekly drawdown limit (10%)
 *  5. Total drawdown kill switch (15%)
 *  6. Sector correlation check (max 2 per sector)
 *  7. Consecutive loss cooldown (pause after 3 losses)
 *  8. Buying power verification
 *  9. Market hours check
 * 10. Volatility filter (skip extreme volatility)
 * 11. Portfolio heat check (total open risk ≤ 6%)
 */

import config from './config.js';
import alpaca from './alpacaClient.js';

const { risk: riskCfg } = config;

// ─── State Tracking ─────────────────────────────────────────
const state = {
  dailyStartEquity:   null,
  weeklyStartEquity:  null,
  allTimeHighEquity:  null,
  consecutiveLosses:  0,
  lastLossTime:       null,
  cooldownUntil:      null,
  dailyTradeCount:    0,
  dailyLosses:        0,
  dailyGains:         0,
  circuitBreakerActive: false,
  lastResetDate:      null,
  tradeLog:           [],       // recent trades for pattern tracking
};

// ─── Initialize ─────────────────────────────────────────────

/**
 * Initialize risk manager with current account state.
 * Call this at startup and at the beginning of each trading day.
 */
async function initialize() {
  const accountRes = await alpaca.getAccount();
  if (!accountRes.success) {
    console.error('Risk manager init failed:', accountRes.error?.message);
    return false;
  }

  const equity = accountRes.data.equity;
  const today = new Date().toISOString().split('T')[0];

  // Reset daily counters if new day
  if (state.lastResetDate !== today) {
    state.dailyStartEquity = equity;
    state.dailyTradeCount = 0;
    state.dailyLosses = 0;
    state.dailyGains = 0;
    state.circuitBreakerActive = false;
    state.lastResetDate = today;
    console.log(`📊 Risk manager reset for ${today} | Equity: $${equity.toFixed(2)}`);
  }

  // Set weekly start on Monday
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 1 && state.weeklyStartEquity === null) {
    state.weeklyStartEquity = equity;
  }
  if (state.weeklyStartEquity === null) {
    state.weeklyStartEquity = equity;
  }

  // Track all-time high
  if (state.allTimeHighEquity === null || equity > state.allTimeHighEquity) {
    state.allTimeHighEquity = equity;
  }

  return true;
}

/**
 * Reset weekly tracking — call on Monday morning.
 */
async function resetWeekly() {
  const accountRes = await alpaca.getAccount();
  if (accountRes.success) {
    state.weeklyStartEquity = accountRes.data.equity;
    state.consecutiveLosses = 0;
    state.cooldownUntil = null;
    console.log(`📅 Weekly reset | Starting equity: $${state.weeklyStartEquity.toFixed(2)}`);
  }
}

// ─── The 11 Checks ──────────────────────────────────────────

/**
 * Run all 11 risk checks on a proposed trade.
 *
 * @param {Object} trade - Proposed trade
 *   { symbol, shares, entryPrice, stopLoss, side, riskPerShare }
 * @param {Object} account - Current account state from alpaca.getAccount()
 * @param {Array} openPositions - Current open positions from alpaca.getPositions()
 * @returns {Object} { approved, checks, reasons, riskScore }
 */
function validateTrade(trade, account, openPositions) {
  const { symbol, shares, entryPrice, stopLoss, riskPerShare } = trade;
  const equity = account.equity;
  const buyingPower = account.buyingPower;
  const tradeValue = shares * entryPrice;
  const tradeRisk = shares * (riskPerShare || (entryPrice - stopLoss));

  const results = [];
  let approved = true;

  // ── Check 1: Position Size Limit ──────────────────────────
  const positionPct = tradeValue / equity;
  const check1Pass = positionPct <= riskCfg.maxPortfolioPerStock;
  results.push({
    check: 'Position Size',
    passed: check1Pass,
    detail: `${(positionPct * 100).toFixed(1)}% of portfolio (max ${riskCfg.maxPortfolioPerStock * 100}%)`,
  });
  if (!check1Pass) approved = false;

  // ── Check 2: Max Open Positions ───────────────────────────
  const openCount = openPositions.length;
  const check2Pass = openCount < riskCfg.maxOpenPositions;
  results.push({
    check: 'Open Positions',
    passed: check2Pass,
    detail: `${openCount}/${riskCfg.maxOpenPositions} positions open`,
  });
  if (!check2Pass) approved = false;

  // ── Check 3: Daily Loss Circuit Breaker ───────────────────
  const dailyPnl = equity - (state.dailyStartEquity || equity);
  const dailyPnlPct = state.dailyStartEquity ? dailyPnl / state.dailyStartEquity : 0;
  const check3Pass = dailyPnlPct > -riskCfg.maxDailyLoss && !state.circuitBreakerActive;
  results.push({
    check: 'Daily Loss Limit',
    passed: check3Pass,
    detail: check3Pass
      ? `Daily P&L: ${(dailyPnlPct * 100).toFixed(2)}% (limit: -${riskCfg.maxDailyLoss * 100}%)`
      : `CIRCUIT BREAKER: Down ${(dailyPnlPct * 100).toFixed(2)}% today`,
  });
  if (!check3Pass) {
    approved = false;
    state.circuitBreakerActive = true;
  }

  // ── Check 4: Weekly Drawdown Limit ────────────────────────
  const weeklyPnl = equity - (state.weeklyStartEquity || equity);
  const weeklyPnlPct = state.weeklyStartEquity ? weeklyPnl / state.weeklyStartEquity : 0;
  const check4Pass = weeklyPnlPct > -riskCfg.maxWeeklyDrawdown;
  results.push({
    check: 'Weekly Drawdown',
    passed: check4Pass,
    detail: `Weekly P&L: ${(weeklyPnlPct * 100).toFixed(2)}% (limit: -${riskCfg.maxWeeklyDrawdown * 100}%)`,
  });
  if (!check4Pass) approved = false;

  // ── Check 5: Total Drawdown Kill Switch ───────────────────
  const totalDrawdown = state.allTimeHighEquity
    ? (equity - state.allTimeHighEquity) / state.allTimeHighEquity
    : 0;
  const check5Pass = totalDrawdown > -riskCfg.maxTotalDrawdown;
  results.push({
    check: 'Total Drawdown',
    passed: check5Pass,
    detail: check5Pass
      ? `Drawdown: ${(totalDrawdown * 100).toFixed(2)}% from ATH (kill switch: -${riskCfg.maxTotalDrawdown * 100}%)`
      : `KILL SWITCH: ${(totalDrawdown * 100).toFixed(2)}% drawdown from all-time high`,
  });
  if (!check5Pass) approved = false;

  // ── Check 6: Sector Correlation ───────────────────────────
  const tradeSector = config.sectors[symbol] || 'unknown';
  const sectorCount = openPositions.filter(p =>
    (config.sectors[p.symbol] || 'unknown') === tradeSector
  ).length;
  const check6Pass = tradeSector === 'unknown' || sectorCount < riskCfg.maxCorrelatedSector;
  results.push({
    check: 'Sector Correlation',
    passed: check6Pass,
    detail: `${sectorCount}/${riskCfg.maxCorrelatedSector} ${tradeSector} positions`,
  });
  if (!check6Pass) approved = false;

  // ── Check 7: Consecutive Loss Cooldown ────────────────────
  const now = Date.now();
  const inCooldown = state.cooldownUntil && now < state.cooldownUntil;
  const check7Pass = state.consecutiveLosses < riskCfg.consecutiveLossLimit && !inCooldown;
  results.push({
    check: 'Loss Cooldown',
    passed: check7Pass,
    detail: inCooldown
      ? `Cooling down until ${new Date(state.cooldownUntil).toLocaleTimeString()}`
      : `${state.consecutiveLosses}/${riskCfg.consecutiveLossLimit} consecutive losses`,
  });
  if (!check7Pass) approved = false;

  // ── Check 8: Buying Power ─────────────────────────────────
  const requiredPower = tradeValue * 1.01; // 1% buffer
  const reserveNeeded = equity * riskCfg.minCashReserve;
  const availablePower = buyingPower - reserveNeeded;
  const check8Pass = availablePower >= requiredPower;
  results.push({
    check: 'Buying Power',
    passed: check8Pass,
    detail: `Need $${requiredPower.toFixed(2)}, available $${availablePower.toFixed(2)} (after ${riskCfg.minCashReserve * 100}% reserve)`,
  });
  if (!check8Pass) approved = false;

  // ── Check 9: Market Hours ─────────────────────────────────
  const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(nowET);
  const hour = etDate.getHours();
  const minute = etDate.getMinutes();
  const day = etDate.getDay();
  const totalMin = hour * 60 + minute;
  const marketOpen = config.schedule.marketOpenHour * 60 + config.schedule.marketOpenMin;
  const marketClose = config.schedule.marketCloseHour * 60 + config.schedule.marketCloseMin;
  const noNewTradesCutoff = marketClose - config.schedule.noNewTradesBeforeCloseMin;

  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = totalMin >= marketOpen && totalMin <= noNewTradesCutoff;
  const check9Pass = isWeekday && isMarketHours;
  results.push({
    check: 'Market Hours',
    passed: check9Pass,
    detail: check9Pass
      ? `Market open (${hour}:${String(minute).padStart(2, '0')} ET)`
      : `Outside trading window (${hour}:${String(minute).padStart(2, '0')} ET)`,
  });
  if (!check9Pass) approved = false;

  // ── Check 10: Volatility Filter ───────────────────────────
  // Skip stocks that are moving too wildly (ATR > 5% of price)
  const atrPercent = trade.atr ? (trade.atr / entryPrice) * 100 : 0;
  const check10Pass = atrPercent <= 5;
  results.push({
    check: 'Volatility',
    passed: check10Pass,
    detail: `ATR: ${atrPercent.toFixed(1)}% of price (max 5%)`,
  });
  if (!check10Pass) approved = false;

  // ── Check 11: Portfolio Heat ──────────────────────────────
  const existingRisk = openPositions.reduce((total, p) => {
    // Estimate risk as 2% of position value if we don't have exact stops
    const posRisk = Math.abs(p.marketValue) * 0.02;
    return total + posRisk;
  }, 0);
  const totalHeat = (existingRisk + tradeRisk) / equity;
  const check11Pass = totalHeat <= riskCfg.maxPortfolioHeat;
  results.push({
    check: 'Portfolio Heat',
    passed: check11Pass,
    detail: `Total risk: ${(totalHeat * 100).toFixed(1)}% of equity (max ${riskCfg.maxPortfolioHeat * 100}%)`,
  });
  if (!check11Pass) approved = false;

  // ── Also check for duplicate positions ────────────────────
  const alreadyHolding = openPositions.some(p => p.symbol === symbol);
  if (alreadyHolding) {
    approved = false;
    results.push({
      check: 'Duplicate Position',
      passed: false,
      detail: `Already holding ${symbol}`,
    });
  }

  // Calculate overall risk score (0-100, higher = riskier)
  const failedCount = results.filter(r => !r.passed).length;
  const riskScore = Math.round((failedCount / results.length) * 100);

  return {
    approved,
    symbol,
    checks: results,
    passedCount: results.filter(r => r.passed).length,
    totalChecks: results.length,
    failedChecks: results.filter(r => !r.passed).map(r => r.check),
    riskScore,
    timestamp: new Date().toISOString(),
  };
}

// ─── Trade Result Tracking ──────────────────────────────────

/**
 * Record a completed trade result for consecutive loss tracking.
 */
function recordTradeResult(result) {
  // result: { symbol, pnl, pnlPercent, exitType }
  state.tradeLog.push({ ...result, timestamp: new Date().toISOString() });

  // Keep only last 50 trades
  if (state.tradeLog.length > 50) {
    state.tradeLog = state.tradeLog.slice(-50);
  }

  if (result.pnl < 0) {
    state.consecutiveLosses++;
    state.dailyLosses += Math.abs(result.pnl);
    state.lastLossTime = Date.now();

    if (state.consecutiveLosses >= riskCfg.consecutiveLossLimit) {
      state.cooldownUntil = Date.now() + (riskCfg.cooldownMinutes * 60 * 1000);
      console.warn(`\n🛑 COOLDOWN ACTIVATED: ${state.consecutiveLosses} consecutive losses. Pausing until ${new Date(state.cooldownUntil).toLocaleTimeString()}`);
    }
  } else {
    state.consecutiveLosses = 0;
    state.dailyGains += result.pnl;
  }

  state.dailyTradeCount++;
}

// ─── Portfolio Health Report ────────────────────────────────

/**
 * Generate a comprehensive risk health report.
 */
async function getHealthReport() {
  const accountRes = await alpaca.getAccount();
  const positionsRes = await alpaca.getPositions();

  if (!accountRes.success) {
    return { success: false, error: 'Cannot fetch account data' };
  }

  const equity = accountRes.data.equity;
  const positions = positionsRes.success ? positionsRes.data : [];

  const dailyPnl = state.dailyStartEquity
    ? equity - state.dailyStartEquity : 0;
  const dailyPnlPct = state.dailyStartEquity
    ? (dailyPnl / state.dailyStartEquity) * 100 : 0;

  const weeklyPnl = state.weeklyStartEquity
    ? equity - state.weeklyStartEquity : 0;
  const weeklyPnlPct = state.weeklyStartEquity
    ? (weeklyPnl / state.weeklyStartEquity) * 100 : 0;

  const totalDrawdown = state.allTimeHighEquity
    ? ((equity - state.allTimeHighEquity) / state.allTimeHighEquity) * 100 : 0;

  // Sector breakdown
  const sectorExposure = {};
  for (const p of positions) {
    const sector = config.sectors[p.symbol] || 'unknown';
    sectorExposure[sector] = (sectorExposure[sector] || 0) + Math.abs(p.marketValue);
  }

  // Position concentration
  const largestPosition = positions.reduce((max, p) =>
    Math.abs(p.marketValue) > Math.abs(max) ? Math.abs(p.marketValue) : max
  , 0);
  const concentrationPct = equity > 0 ? (largestPosition / equity) * 100 : 0;

  return {
    success: true,
    report: {
      // Account
      equity,
      cash: accountRes.data.cash,
      buyingPower: accountRes.data.buyingPower,

      // Performance
      daily: { pnl: dailyPnl, pct: dailyPnlPct, trades: state.dailyTradeCount },
      weekly: { pnl: weeklyPnl, pct: weeklyPnlPct },
      drawdown: { fromATH: totalDrawdown, athEquity: state.allTimeHighEquity },

      // Risk state
      openPositions: positions.length,
      maxPositions: riskCfg.maxOpenPositions,
      consecutiveLosses: state.consecutiveLosses,
      circuitBreaker: state.circuitBreakerActive,
      cooldownActive: state.cooldownUntil ? Date.now() < state.cooldownUntil : false,
      cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,

      // Exposure
      sectorExposure,
      largestPositionPct: concentrationPct,
      portfolioHeat: positions.reduce((t, p) =>
        t + (Math.abs(p.marketValue) * 0.02), 0
      ) / (equity || 1) * 100,

      // Status
      status: state.circuitBreakerActive ? 'HALTED'
        : (state.cooldownUntil && Date.now() < state.cooldownUntil) ? 'COOLDOWN'
        : totalDrawdown <= -(riskCfg.maxTotalDrawdown * 100) ? 'KILL_SWITCH'
        : 'ACTIVE',

      timestamp: new Date().toISOString(),
    },
  };
}

// ─── Quick Checks ───────────────────────────────────────────

/**
 * Quick check — can we trade at all right now?
 * Lighter than full validateTrade, used for early bailout.
 */
function canTrade() {
  if (state.circuitBreakerActive) {
    return { allowed: false, reason: 'Daily circuit breaker active' };
  }
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    return { allowed: false, reason: `Cooldown until ${new Date(state.cooldownUntil).toLocaleTimeString()}` };
  }
  return { allowed: true, reason: 'Trading allowed' };
}

/**
 * Check if an exit/sell is allowed (less restrictive than buy).
 * Exits should almost always be allowed to protect capital.
 */
function canExit() {
  // Exits are always allowed — protecting capital is priority
  return { allowed: true, reason: 'Exits always permitted' };
}

// ─── State Access ───────────────────────────────────────────

function getState() {
  return { ...state };
}

function getDailyPnlPercent() {
  if (!state.dailyStartEquity) return 0;
  // This is approximate — actual comes from getHealthReport
  return ((state.dailyGains - state.dailyLosses) / state.dailyStartEquity) * 100;
}

function getWeeklyPnlPercent() {
  // Approximate from state — more accurate via getHealthReport
  if (!state.weeklyStartEquity) return 0;
  const netDaily = state.dailyGains - state.dailyLosses;
  return (netDaily / state.weeklyStartEquity) * 100;
}

// ─── Export ─────────────────────────────────────────────────
export {
  initialize,
  resetWeekly,
  validateTrade,
  recordTradeResult,
  getHealthReport,
  canTrade,
  canExit,
  getState,
  getDailyPnlPercent,
  getWeeklyPnlPercent,
};

export default {
  initialize,
  resetWeekly,
  validateTrade,
  recordTradeResult,
  getHealthReport,
  canTrade,
  canExit,
  getState,
  getDailyPnlPercent,
  getWeeklyPnlPercent,
};
