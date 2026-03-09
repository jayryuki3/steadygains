/**
 * SteadyGains — positionManager.js
 * =================================
 * Manages all open positions with their entry metadata,
 * stop levels, profit targets, and exit logic.
 *
 * Responsibilities:
 *   - Track entry info (price, date, stop, target) for each position
 *   - Activate and adjust trailing stops as price moves up
 *   - Detect time-based exits (stale positions)
 *   - Handle partial profit taking at first target
 *   - Tighten stops for weekend risk reduction
 *   - Sync with Alpaca's actual positions on each cycle
 */

import config from './config.js';
import alpaca from './alpacaClient.js';

const { strategy: strat } = config;

// ─── Position Store ─────────────────────────────────────────
// In-memory map of tracked positions.
// Keyed by symbol for O(1) lookups.
const positions = new Map();

/**
 * Position object shape:
 * {
 *   symbol:          'AAPL',
 *   shares:          10,
 *   entryPrice:      150.00,
 *   entryDate:       '2026-03-08T10:30:00Z',
 *   stopLoss:        146.50,      // current stop (may trail up)
 *   originalStop:    146.50,      // initial stop level
 *   takeProfit:      160.00,      // full profit target
 *   partialTarget:   156.00,      // first partial exit target
 *   partialTaken:    false,       // has partial profit been taken?
 *   trailingActive:  false,       // is trailing stop activated?
 *   highWaterMark:   152.00,      // highest price since entry
 *   atr:             2.33,        // ATR at entry
 *   riskPerShare:    3.50,        // entry - stop
 *   sector:          'tech',
 *   orderId:         'abc-123',   // Alpaca order ID
 *   status:          'open',      // open, partial, closing, closed
 * }
 */

// ─── Add / Remove Positions ─────────────────────────────────

/**
 * Register a new position after a buy order fills.
 */
function addPosition(posData) {
  const pos = {
    symbol:         posData.symbol,
    shares:         posData.shares,
    entryPrice:     posData.entryPrice,
    entryDate:      posData.entryDate || new Date().toISOString(),
    stopLoss:       posData.stopLoss,
    originalStop:   posData.stopLoss,
    takeProfit:     posData.takeProfit,
    partialTarget:  posData.partialTarget || null,
    partialTaken:   false,
    trailingActive: false,
    highWaterMark:  posData.entryPrice,
    atr:            posData.atr || 0,
    riskPerShare:   posData.entryPrice - posData.stopLoss,
    sector:         posData.sector || config.sectors[posData.symbol] || 'unknown',
    orderId:        posData.orderId || null,
    status:         'open',
  };

  positions.set(pos.symbol, pos);
  console.log(`📥 Position opened: ${pos.symbol} | ${pos.shares} shares @ $${pos.entryPrice.toFixed(2)} | Stop: $${pos.stopLoss.toFixed(2)} | Target: $${pos.takeProfit.toFixed(2)}`);

  return pos;
}

/**
 * Remove a position after it's fully closed.
 */
function removePosition(symbol) {
  const pos = positions.get(symbol);
  if (pos) {
    positions.delete(symbol);
    console.log(`📤 Position closed: ${symbol}`);
  }
  return pos;
}

// ─── Position Updates ───────────────────────────────────────

/**
 * Update a position with the latest price. Handles:
 *   1. High water mark tracking
 *   2. Trailing stop activation and adjustment
 *   3. Partial profit target detection
 *
 * @param {string} symbol
 * @param {number} currentPrice
 * @returns {Object|null} action to take, or null if hold
 */
function updatePosition(symbol, currentPrice) {
  const pos = positions.get(symbol);
  if (!pos || pos.status === 'closed') return null;

  const actions = [];

  // Update high water mark
  if (currentPrice > pos.highWaterMark) {
    pos.highWaterMark = currentPrice;
  }

  // ── Check 1: Stop Loss Hit ────────────────────────────────
  if (currentPrice <= pos.stopLoss) {
    actions.push({
      type: 'STOP_EXIT',
      symbol,
      shares: pos.shares,
      reason: `Stop hit: $${currentPrice.toFixed(2)} <= $${pos.stopLoss.toFixed(2)}`,
      urgency: 3,
    });
    pos.status = 'closing';
    return actions[0];
  }

  // ── Check 2: Full Profit Target Hit ───────────────────────
  if (currentPrice >= pos.takeProfit) {
    actions.push({
      type: 'TARGET_EXIT',
      symbol,
      shares: pos.shares,
      reason: `Target hit: $${currentPrice.toFixed(2)} >= $${pos.takeProfit.toFixed(2)}`,
      urgency: 2,
    });
    pos.status = 'closing';
    return actions[0];
  }

  // ── Check 3: Partial Profit Taking ────────────────────────
  if (pos.partialTarget && !pos.partialTaken && currentPrice >= pos.partialTarget) {
    const partialShares = Math.floor(pos.shares * strat.partialExitRatio);
    if (partialShares >= 1) {
      actions.push({
        type: 'PARTIAL_EXIT',
        symbol,
        shares: partialShares,
        reason: `Partial target: $${currentPrice.toFixed(2)} >= $${pos.partialTarget.toFixed(2)} | Selling ${partialShares}/${pos.shares} shares`,
        urgency: 1,
      });
      // Don't mark as closing — we keep the remaining shares
      return actions[0];
    }
  }

  // ── Check 4: Trailing Stop Activation ─────────────────────
  const gainPercent = (currentPrice - pos.entryPrice) / pos.entryPrice;

  if (!pos.trailingActive && gainPercent >= strat.trailingStopActivation) {
    pos.trailingActive = true;
    const newStop = currentPrice * (1 - strat.trailingStopDistance);
    if (newStop > pos.stopLoss) {
      pos.stopLoss = newStop;
      console.log(`   📈 ${symbol}: Trailing stop ACTIVATED at $${newStop.toFixed(2)} (+${(gainPercent * 100).toFixed(1)}%)`);
    }
  }

  // ── Check 5: Trail the Stop Up ────────────────────────────
  if (pos.trailingActive) {
    const trailStop = pos.highWaterMark * (1 - strat.trailingStopDistance);
    if (trailStop > pos.stopLoss) {
      const oldStop = pos.stopLoss;
      pos.stopLoss = trailStop;
      console.log(`   📈 ${symbol}: Stop trailed $${oldStop.toFixed(2)} -> $${trailStop.toFixed(2)}`);
    }
  }

  return null; // hold
}

/**
 * Record that a partial exit was completed.
 */
function recordPartialExit(symbol, sharesSold) {
  const pos = positions.get(symbol);
  if (!pos) return;

  pos.shares -= sharesSold;
  pos.partialTaken = true;

  // After partial, move stop to breakeven to protect remaining
  if (pos.entryPrice > pos.stopLoss) {
    pos.stopLoss = pos.entryPrice * 1.001; // tiny buffer above breakeven
    console.log(`   🔒 ${symbol}: Stop moved to breakeven $${pos.stopLoss.toFixed(2)} after partial exit`);
  }

  pos.status = 'partial';
  console.log(`   ✂️  ${symbol}: Partial exit complete. ${pos.shares} shares remaining.`);
}

// ─── Time-Based Exit Check ──────────────────────────────────

/**
 * Check all positions for time-based exits.
 * Stale positions (held > maxHoldingDays with minimal gain) should be closed.
 *
 * @returns {Array} positions that should be time-exited
 */
function checkTimeExits() {
  const exits = [];
  const now = new Date();

  for (const [symbol, pos] of positions) {
    if (pos.status === 'closing' || pos.status === 'closed') continue;

    const entryDate = new Date(pos.entryDate);
    const holdingDays = getTradingDays(entryDate, now);

    if (holdingDays >= strat.maxHoldingDays) {
      const gainPct = ((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100;

      // Only force-exit if the trade hasn't moved significantly
      if (gainPct < 3) {
        exits.push({
          type: 'TIME_EXIT',
          symbol,
          shares: pos.shares,
          reason: `Stale: held ${holdingDays} days, max gain ${gainPct.toFixed(1)}%`,
          holdingDays,
          urgency: 1,
        });
      }
    }
  }

  return exits;
}

// ─── Weekend Risk Reduction ─────────────────────────────────

/**
 * Tighten all stops for Friday afternoon.
 * Returns list of adjustments made.
 */
function applyWeekendStops(currentPrices) {
  const adjustments = [];

  for (const [symbol, pos] of positions) {
    if (pos.status === 'closing' || pos.status === 'closed') continue;

    const currentPrice = currentPrices[symbol];
    if (!currentPrice) continue;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    let newStop;

    if (pnlPct > 2) {
      // Lock in breakeven+
      newStop = pos.entryPrice * 1.005;
    } else if (pnlPct > 0) {
      // Tighten to 0.5% below current
      newStop = currentPrice * 0.995;
    } else {
      // Losing — tighten to limit weekend damage
      newStop = currentPrice * 0.99;
    }

    // Only tighten, never loosen
    if (newStop > pos.stopLoss) {
      const oldStop = pos.stopLoss;
      pos.stopLoss = newStop;
      adjustments.push({
        symbol,
        oldStop,
        newStop,
        pnlPct,
        reason: `Weekend tightening (P&L: ${pnlPct.toFixed(1)}%)`,
      });
      console.log(`   🔐 ${symbol}: Weekend stop $${oldStop.toFixed(2)} -> $${newStop.toFixed(2)}`);
    }
  }

  return adjustments;
}

// ─── Sync with Alpaca ───────────────────────────────────────

/**
 * Sync our tracked positions with Alpaca's actual positions.
 * Handles fills that happened while we weren't watching,
 * and cleans up positions that were closed externally.
 */
async function syncWithBroker() {
  const res = await alpaca.getPositions();
  if (!res.success) {
    console.warn('⚠️  Position sync failed:', res.error?.message);
    return { synced: false, changes: [] };
  }

  const brokerPositions = res.data;
  const changes = [];

  // Check for positions closed on broker side
  for (const [symbol, pos] of positions) {
    const brokerPos = brokerPositions.find(p => p.symbol === symbol);
    if (!brokerPos) {
      changes.push({ type: 'removed', symbol, reason: 'Not found on broker' });
      positions.delete(symbol);
    } else if (brokerPos.qty !== pos.shares) {
      // Shares changed (partial fill or external trade)
      changes.push({
        type: 'adjusted',
        symbol,
        oldShares: pos.shares,
        newShares: brokerPos.qty,
      });
      pos.shares = brokerPos.qty;
    }
  }

  // Check for positions on broker not in our tracker
  // (could be manual trades — track them with conservative defaults)
  for (const brokerPos of brokerPositions) {
    if (!positions.has(brokerPos.symbol)) {
      console.warn(`⚠️  Untracked position found: ${brokerPos.symbol} (${brokerPos.qty} shares)`);
      // Add with conservative defaults
      addPosition({
        symbol: brokerPos.symbol,
        shares: brokerPos.qty,
        entryPrice: brokerPos.avgEntryPrice,
        stopLoss: brokerPos.avgEntryPrice * 0.97,  // 3% default stop
        takeProfit: brokerPos.avgEntryPrice * 1.06, // 6% default target
        entryDate: new Date().toISOString(),
      });
      changes.push({ type: 'added', symbol: brokerPos.symbol, reason: 'Found on broker, not tracked' });
    }
  }

  if (changes.length > 0) {
    console.log(`🔄 Position sync: ${changes.length} changes`);
  }

  return { synced: true, changes };
}

// ─── Queries ────────────────────────────────────────────────

/**
 * Get all open positions as an array.
 */
function getAll() {
  return Array.from(positions.values()).filter(p => p.status !== 'closed');
}

/**
 * Get a specific position by symbol.
 */
function get(symbol) {
  return positions.get(symbol) || null;
}

/**
 * Get count of open positions.
 */
function count() {
  return Array.from(positions.values()).filter(p => p.status !== 'closed').length;
}

/**
 * Get total exposure (sum of position values at entry).
 */
function getTotalExposure() {
  return getAll().reduce((total, p) => total + (p.shares * p.entryPrice), 0);
}

/**
 * Get positions by sector.
 */
function getBySector(sector) {
  return getAll().filter(p => p.sector === sector);
}

/**
 * Get a summary suitable for logging.
 */
function getSummary(currentPrices = {}) {
  const all = getAll();
  if (all.length === 0) return 'No open positions.';

  const lines = all.map(p => {
    const current = currentPrices[p.symbol] || p.entryPrice;
    const pnl = (current - p.entryPrice) * p.shares;
    const pnlPct = ((current - p.entryPrice) / p.entryPrice) * 100;
    const stopDist = ((current - p.stopLoss) / current) * 100;

    return `  ${p.symbol}: ${p.shares} shares | Entry: $${p.entryPrice.toFixed(2)} | Now: $${current.toFixed(2)} | P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | Stop: $${p.stopLoss.toFixed(2)} (${stopDist.toFixed(1)}% away)${p.trailingActive ? ' [TRAILING]' : ''}${p.partialTaken ? ' [PARTIAL]' : ''}`;
  });

  return `Open Positions (${all.length}):\n${lines.join('\n')}`;
}

// ─── Helpers ────────────────────────────────────────────────

function getTradingDays(start, end) {
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// ─── Export ─────────────────────────────────────────────────
export {
  addPosition,
  removePosition,
  updatePosition,
  recordPartialExit,
  checkTimeExits,
  applyWeekendStops,
  syncWithBroker,
  getAll,
  get,
  count,
  getTotalExposure,
  getBySector,
  getSummary,
};

export default {
  addPosition,
  removePosition,
  updatePosition,
  recordPartialExit,
  checkTimeExits,
  applyWeekendStops,
  syncWithBroker,
  getAll,
  get,
  count,
  getTotalExposure,
  getBySector,
  getSummary,
};
