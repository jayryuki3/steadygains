/**
 * SteadyGains — autoTrader.js
 * ============================
 * THE MAIN ENGINE. Self-sufficient orchestrator that runs
 * the entire trading system on schedule with zero human input.
 *
 * Startup sequence:
 *   1. Validate config & API connection
 *   2. Initialize database
 *   3. Initialize risk manager
 *   4. Sync positions with broker
 *   5. Start all scheduled jobs
 *
 * Scheduled loops:
 *   - Every 5 min:  Check stops & position health
 *   - Every 15 min: Quick market scan
 *   - Every 1 hour:  Full signal generation
 *   - 9:00 AM ET:   Pre-market prep
 *   - 9:30 AM ET:   Market open scan
 *   - 3:45 PM ET:   EOD cleanup
 *   - Friday 3 PM:  Weekly review
 */

import cron from 'node-cron';
import config, { validateConfig } from './config.js';
import alpaca from './alpacaClient.js';
import { scanWatchlist, quickScan, scanSymbol } from './scanner.js';
import {
  generateSignals,
  generateExitSignals,
  calculatePositionSize,
  getWeekendStops,
  getCompoundingMultiplier,
  SIGNAL,
} from './strategy.js';
import riskManager from './riskManager.js';
import positionManager from './positionManager.js';
import db from './database.js';

const TZ = config.schedule.timezone;
const jobs = [];  // track cron jobs for cleanup
let isRunning = false;
let lastFullScan = null;

// ═══════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════

async function start() {
  console.log('\n' + '='.repeat(60));
  console.log('  SteadyGains — Conservative Trading Bot');
  console.log(`  Mode: ${config.alpaca.mode.toUpperCase()}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('='.repeat(60) + '\n');

  // Step 1: Validate config
  validateConfig();

  // Step 2: Health check API connection
  console.log('🔌 Connecting to Alpaca...');
  const health = await alpaca.healthCheck();
  if (!health.connected) {
    console.error('❌ Cannot connect to Alpaca:', health.errors.join(', '));
    process.exit(1);
  }
  console.log(`   ✅ Connected | Mode: ${config.alpaca.mode} | Equity: $${health.equity?.toFixed(2)} | Market: ${health.marketOpen ? 'OPEN' : 'CLOSED'}`);

  // Step 3: Initialize database
  db.initialize();

  // Step 4: Initialize risk manager
  await riskManager.initialize();

  // Step 5: Sync positions with broker
  await positionManager.syncWithBroker();
  const openPositions = positionManager.getAll();
  if (openPositions.length > 0) {
    console.log(`\n📋 ${openPositions.length} open positions loaded:`);
    console.log(positionManager.getSummary());
  } else {
    console.log('\n📋 No open positions.');
  }

  // Step 6: Save positions to database
  for (const pos of openPositions) {
    db.positions.upsert(pos);
  }

  // Step 7: Start scheduled jobs
  scheduleJobs();

  // Step 8: Handle shutdown
  setupGracefulShutdown();

  console.log('\n🟢 SteadyGains is running. Waiting for market hours...\n');
  isRunning = true;

  // If market is currently open, run an immediate scan
  if (health.marketOpen) {
    console.log('📡 Market is open — running initial scan...');
    await fullTradingCycle();
  }
}

// ═══════════════════════════════════════════════════════════════
//  SCHEDULING
// ═══════════════════════════════════════════════════════════════

function scheduleJobs() {
  console.log('\n⏰ Scheduling jobs (all times ET):');

  // Every 5 min: Check stops and position health
  jobs.push(cron.schedule(config.schedule.stopCheck, async () => {
    await safeRun('StopCheck', checkStopsAndExits);
  }, { timezone: TZ }));
  console.log('   • Every 5 min:  Stop & position check');

  // Every 15 min: Quick scan for new setups
  jobs.push(cron.schedule(config.schedule.quickScan, async () => {
    await safeRun('QuickScan', quickScanCycle);
  }, { timezone: TZ }));
  console.log('   • Every 15 min: Quick market scan');

  // Every hour: Full signal generation
  jobs.push(cron.schedule(config.schedule.fullSignalScan, async () => {
    await safeRun('FullScan', fullTradingCycle);
  }, { timezone: TZ }));
  console.log('   • Every hour:   Full signal scan');

  // Pre-market: 9:00 AM ET
  jobs.push(cron.schedule(config.schedule.preMarket, async () => {
    await safeRun('PreMarket', preMarketPrep);
  }, { timezone: TZ }));
  console.log('   • 9:00 AM ET:   Pre-market prep');

  // Market open: 9:30 AM ET
  jobs.push(cron.schedule(config.schedule.marketOpen, async () => {
    await safeRun('MarketOpen', marketOpenScan);
  }, { timezone: TZ }));
  console.log('   • 9:30 AM ET:   Market open scan');

  // EOD: 3:45 PM ET
  jobs.push(cron.schedule(config.schedule.endOfDay, async () => {
    await safeRun('EOD', endOfDayCleanup);
  }, { timezone: TZ }));
  console.log('   • 3:45 PM ET:   End-of-day cleanup');

  // Weekly review: Friday 3:00 PM ET
  jobs.push(cron.schedule(config.schedule.weeklyReview, async () => {
    await safeRun('WeeklyReview', weeklyReview);
  }, { timezone: TZ }));
  console.log('   • Friday 3 PM:  Weekly review');
}

// ═══════════════════════════════════════════════════════════════
//  CORE TRADING LOOPS
// ═══════════════════════════════════════════════════════════════

/**
 * Full trading cycle — the main loop that finds and executes trades.
 */
async function fullTradingCycle() {
  console.log('\n' + '-'.repeat(50));
  console.log(`🔄 Full Trading Cycle | ${new Date().toLocaleString('en-US', { timeZone: TZ })} ET`);
  console.log('-'.repeat(50));

  // Check if market is open
  const clock = await alpaca.getClock();
  if (!clock.success || !clock.data.isOpen) {
    console.log('   Market is closed. Skipping.');
    return;
  }

  // Check if we can trade at all
  const tradeCheck = riskManager.canTrade();
  if (!tradeCheck.allowed) {
    console.log(`   ⛔ Trading blocked: ${tradeCheck.reason}`);
    return;
  }

  // Step 1: Scan the watchlist
  const scanResults = await scanWatchlist('1Day');
  lastFullScan = scanResults;

  if (scanResults.candidates.length === 0) {
    console.log('   No valid candidates found.');
    return;
  }

  // Step 2: Generate buy signals
  const buySignals = generateSignals(scanResults.candidates);

  // Log all signals to database
  for (const candidate of scanResults.candidates) {
    if (candidate.signals) {
      db.signals.log(candidate.signals);
    }
  }

  // Step 3: Check exits on open positions
  await checkStopsAndExits();

  // Step 4: Execute approved buy signals
  if (buySignals.length > 0) {
    await executeBuySignals(buySignals);
  }

  // Step 5: Persist position state
  for (const pos of positionManager.getAll()) {
    db.positions.upsert(pos);
  }

  console.log('\n✅ Cycle complete.');
}

/**
 * Quick scan — lighter check during market hours.
 */
async function quickScanCycle() {
  const clock = await alpaca.getClock();
  if (!clock.success || !clock.data.isOpen) return;

  console.log(`\n⚡ Quick Scan | ${new Date().toLocaleString('en-US', { timeZone: TZ })} ET`);

  // Only check positions and quick price updates
  await checkStopsAndExits();

  // Look for opportunities using snapshots (fast)
  const quickResults = await quickScan();
  if (quickResults.results.length > 0) {
    // Check if any quick-scan stocks show big moves worth a deeper look
    const bigMovers = quickResults.results.filter(r => Math.abs(r.change) > 2);
    if (bigMovers.length > 0) {
      console.log(`   🔥 Big movers: ${bigMovers.map(m => `${m.symbol} (${m.change > 0 ? '+' : ''}${m.change.toFixed(1)}%)`).join(', ')}`);
    }
  }
}

/**
 * Check all open positions for stop hits and exit signals.
 */
async function checkStopsAndExits() {
  const openPositions = positionManager.getAll();
  if (openPositions.length === 0) return;

  // Get latest prices for all open positions
  const symbols = openPositions.map(p => p.symbol);
  const snapshots = await alpaca.getSnapshots(symbols);

  if (!snapshots.success) {
    console.warn('⚠️  Could not fetch snapshots for position check');
    return;
  }

  const currentPrices = {};
  for (const [symbol, snap] of Object.entries(snapshots.data)) {
    if (snap.latestTrade) {
      currentPrices[symbol] = snap.latestTrade.p;
    } else if (snap.dailyBar) {
      currentPrices[symbol] = snap.dailyBar.c;
    }
  }

  // Update each position and check for exit triggers
  for (const pos of openPositions) {
    const price = currentPrices[pos.symbol];
    if (!price) continue;

    const action = positionManager.updatePosition(pos.symbol, price);

    if (action) {
      await executeExit(action, price);
    }
  }

  // Check time-based exits
  const timeExits = positionManager.checkTimeExits();
  for (const exit of timeExits) {
    const price = currentPrices[exit.symbol];
    if (price) {
      await executeExit(exit, price);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  TRADE EXECUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Execute approved buy signals through the full pipeline.
 */
async function executeBuySignals(signals) {
  // Get current account state
  const accountRes = await alpaca.getAccount();
  const positionsRes = await alpaca.getPositions();

  if (!accountRes.success) {
    console.error('❌ Cannot fetch account for trade execution');
    return;
  }

  const account = accountRes.data;
  const brokerPositions = positionsRes.success ? positionsRes.data : [];

  // Get compounding multiplier based on weekly performance
  const weeklyPnl = riskManager.getWeeklyPnlPercent();
  const compMultiplier = getCompoundingMultiplier(weeklyPnl);
  if (compMultiplier !== 1.0) {
    console.log(`   📊 Compounding multiplier: ${compMultiplier}x (weekly P&L: ${weeklyPnl.toFixed(1)}%)`);
  }

  for (const signal of signals) {
    console.log(`\n   📝 Evaluating: ${signal.symbol} (score ${signal.score}/${signal.minScore})`);

    // Calculate position size
    const sizing = calculatePositionSize(
      account.equity,
      signal.entry.price,
      signal.entry.stopLoss,
      account.buyingPower
    );

    // Apply compounding multiplier
    let shares = Math.floor(sizing.shares * compMultiplier);
    if (shares < 1) {
      console.log(`   ⏭️  Skip ${signal.symbol}: Position too small (${sizing.reason})`);
      continue;
    }

    // Run through risk manager (all 11 checks)
    const riskResult = riskManager.validateTrade({
      symbol: signal.symbol,
      shares,
      entryPrice: signal.entry.price,
      stopLoss: signal.entry.stopLoss,
      riskPerShare: signal.entry.riskPerShare,
      atr: signal.entry.atr,
    }, account, brokerPositions);

    if (!riskResult.approved) {
      console.log(`   ⛔ REJECTED: ${signal.symbol} — Failed: ${riskResult.failedChecks.join(', ')}`);
      // Log the rejected signal
      signal.actedOn = false;
      db.signals.log(signal);
      continue;
    }

    console.log(`   ✅ APPROVED: ${signal.symbol} | ${riskResult.passedCount}/${riskResult.totalChecks} checks passed`);

    // Calculate limit price with small buffer for fills
    const limitPrice = parseFloat(
      (signal.entry.price * (1 + config.orders.limitSlippage)).toFixed(2)
    );

    // Submit the order
    const orderRes = await alpaca.submitOrder({
      symbol: signal.symbol,
      qty: shares,
      side: 'buy',
      type: config.orders.defaultType,
      timeInForce: config.orders.timeInForce,
      limitPrice: limitPrice,
    });

    if (!orderRes.success) {
      console.error(`   ❌ Order failed for ${signal.symbol}: ${orderRes.error?.message}`);
      continue;
    }

    console.log(`   🛒 ORDER PLACED: ${signal.symbol} | ${shares} shares @ limit $${limitPrice} | Order: ${orderRes.data.id.slice(0, 8)}...`);

    // Track the position
    positionManager.addPosition({
      symbol: signal.symbol,
      shares,
      entryPrice: signal.entry.price,
      stopLoss: signal.entry.stopLoss,
      takeProfit: signal.entry.takeProfit,
      partialTarget: signal.entry.partialTarget,
      atr: signal.entry.atr,
      orderId: orderRes.data.id,
      sector: config.sectors[signal.symbol],
    });

    // Log to database
    const tradeId = db.trades.openTrade({
      symbol: signal.symbol,
      shares,
      entryPrice: signal.entry.price,
      stopLoss: signal.entry.stopLoss,
      takeProfit: signal.entry.takeProfit,
      signalScore: signal.score,
      orderId: orderRes.data.id,
    });

    signal.actedOn = true;
    db.signals.log(signal);

    // Update broker positions for subsequent risk checks
    brokerPositions.push({
      symbol: signal.symbol,
      qty: shares,
      marketValue: shares * signal.entry.price,
    });
  }
}

/**
 * Execute an exit (stop, target, partial, time-based).
 */
async function executeExit(exitAction, currentPrice) {
  const { symbol, shares, type, reason } = exitAction;

  // Exits should always be allowed
  const canExit = riskManager.canExit();
  if (!canExit.allowed) {
    console.error(`   ❌ Exit blocked (this should not happen): ${canExit.reason}`);
    return;
  }

  console.log(`   🚪 EXIT: ${symbol} | Type: ${type} | ${reason}`);

  if (type === SIGNAL.PARTIAL) {
    // Partial exit — sell some shares
    const orderRes = await alpaca.closePosition(symbol, shares);
    if (orderRes.success) {
      positionManager.recordPartialExit(symbol, shares);
      console.log(`   ✂️  Partial exit: sold ${shares} shares of ${symbol}`);
    } else {
      console.error(`   ❌ Partial exit failed: ${orderRes.error?.message}`);
    }
  } else {
    // Full exit — close entire position
    const orderRes = await alpaca.closePosition(symbol);

    if (orderRes.success) {
      const pos = positionManager.get(symbol);
      if (pos) {
        const pnl = (currentPrice - pos.entryPrice) * pos.shares;
        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        // Record in risk manager
        riskManager.recordTradeResult({
          symbol,
          pnl,
          pnlPercent,
          exitType: type,
        });

        // Close in database
        const dbTrade = db.trades.getOpenTrade(symbol);
        if (dbTrade) {
          db.trades.closeTrade(dbTrade.id, {
            exitPrice: currentPrice,
            exitType: type,
            pnl,
            pnlPercent,
            holdingDays: getTradingDays(new Date(pos.entryDate), new Date()),
          });
        }

        console.log(`   ${pnl >= 0 ? '💰' : '📉'} ${symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
      }

      // Remove from position tracker
      positionManager.removePosition(symbol);
      db.positions.remove(symbol);
    } else {
      console.error(`   ❌ Exit failed for ${symbol}: ${orderRes.error?.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  DAILY ROUTINES
// ═══════════════════════════════════════════════════════════════

/**
 * Pre-market prep — run at 9:00 AM ET.
 */
async function preMarketPrep() {
  console.log('\n' + '='.repeat(50));
  console.log('🌅 PRE-MARKET PREP');
  console.log('='.repeat(50));

  // Reset daily risk counters
  await riskManager.initialize();

  // Monday: reset weekly counters
  const day = new Date().getDay();
  if (day === 1) {
    await riskManager.resetWeekly();
  }

  // Sync positions
  await positionManager.syncWithBroker();

  // Show account status
  const healthReport = await riskManager.getHealthReport();
  if (healthReport.success) {
    const r = healthReport.report;
    console.log(`   Equity:    $${r.equity.toFixed(2)}`);
    console.log(`   Cash:      $${r.cash.toFixed(2)}`);
    console.log(`   Positions: ${r.openPositions}/${r.maxPositions}`);
    console.log(`   Status:    ${r.status}`);
    if (r.daily.pnl !== 0) {
      console.log(`   Daily P&L: $${r.daily.pnl.toFixed(2)} (${r.daily.pct.toFixed(2)}%)`);
    }
  }

  // Show open positions
  const positions = positionManager.getAll();
  if (positions.length > 0) {
    console.log(`\n   Open positions:`);
    console.log(positionManager.getSummary());
  }
}

/**
 * Market open scan — run at 9:30 AM ET.
 * Wait 15 minutes for opening volatility to settle, then scan.
 */
async function marketOpenScan() {
  console.log('\n🔔 Market open! Waiting 15 min for volatility to settle...');

  // Wait 15 minutes after open
  await sleep(15 * 60 * 1000);

  console.log('📡 Running post-open scan...');
  await fullTradingCycle();
}

/**
 * End of day cleanup — run at 3:45 PM ET.
 */
async function endOfDayCleanup() {
  console.log('\n' + '='.repeat(50));
  console.log('🌆 END OF DAY CLEANUP');
  console.log('='.repeat(50));

  // Final position check
  await checkStopsAndExits();

  // Get final account state
  const accountRes = await alpaca.getAccount();
  const healthReport = await riskManager.getHealthReport();

  if (accountRes.success && healthReport.success) {
    const r = healthReport.report;

    // Save daily snapshot
    const weeklyStats = db.metrics.getWeeklyStats();
    db.snapshots.saveDaily({
      date: new Date().toISOString().split('T')[0],
      equity: r.equity,
      cash: r.cash,
      buyingPower: r.buyingPower,
      positionsCount: r.openPositions,
      totalExposure: positionManager.getTotalExposure(),
      dailyPnl: r.daily.pnl,
      dailyPnlPct: r.daily.pct,
      weeklyPnl: r.weekly.pnl,
      weeklyPnlPct: r.weekly.pct,
      drawdownPct: r.drawdown.fromATH,
      tradesToday: r.daily.trades,
      winsToday: weeklyStats.wins,
      lossesToday: weeklyStats.losses,
    });

    // Print daily summary
    console.log(`\n   📊 Daily Summary:`);
    console.log(`   Equity:      $${r.equity.toFixed(2)}`);
    console.log(`   Daily P&L:   $${r.daily.pnl.toFixed(2)} (${r.daily.pct.toFixed(2)}%)`);
    console.log(`   Weekly P&L:  $${r.weekly.pnl.toFixed(2)} (${r.weekly.pct.toFixed(2)}%)`);
    console.log(`   Drawdown:    ${r.drawdown.fromATH.toFixed(2)}% from ATH`);
    console.log(`   Positions:   ${r.openPositions}`);
    console.log(`   Trades today: ${r.daily.trades}`);
  }

  // Persist all position states
  for (const pos of positionManager.getAll()) {
    db.positions.upsert(pos);
  }
}

/**
 * Weekly review — run Friday 3:00 PM ET.
 */
async function weeklyReview() {
  console.log('\n' + '='.repeat(50));
  console.log('📅 WEEKLY REVIEW');
  console.log('='.repeat(50));

  // Apply weekend stop tightening
  const positions = positionManager.getAll();
  if (positions.length > 0) {
    const symbols = positions.map(p => p.symbol);
    const snapshots = await alpaca.getSnapshots(symbols);

    if (snapshots.success) {
      const prices = {};
      for (const [sym, snap] of Object.entries(snapshots.data)) {
        prices[sym] = snap.latestTrade?.p || snap.dailyBar?.c;
      }

      const adjustments = positionManager.applyWeekendStops(prices);
      if (adjustments.length > 0) {
        console.log(`\n   🔐 Weekend stop adjustments:`);
        for (const adj of adjustments) {
          console.log(`      ${adj.symbol}: $${adj.oldStop.toFixed(2)} -> $${adj.newStop.toFixed(2)} (${adj.reason})`);
        }
      }
    }
  }

  // Print weekly performance
  const stats = db.metrics.getStats();
  const weeklyStats = db.metrics.getWeeklyStats();
  const healthReport = await riskManager.getHealthReport();

  console.log('\n   📊 Week Summary:');
  if (weeklyStats.trades > 0) {
    console.log(`   Trades:     ${weeklyStats.trades} (${weeklyStats.wins}W / ${weeklyStats.losses}L)`);
    console.log(`   Win Rate:   ${weeklyStats.winRate.toFixed(0)}%`);
    console.log(`   Weekly P&L: $${weeklyStats.totalPnl.toFixed(2)}`);
  } else {
    console.log('   No trades this week.');
  }

  if (stats.totalTrades > 0) {
    console.log('\n   📊 All-Time Stats:');
    console.log(`   Total Trades:   ${stats.totalTrades}`);
    console.log(`   Win Rate:       ${stats.winRate.toFixed(0)}%`);
    console.log(`   Total P&L:      $${stats.totalPnl.toFixed(2)}`);
    console.log(`   Profit Factor:  ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}`);
    console.log(`   Avg Win:        $${stats.avgWin.toFixed(2)}`);
    console.log(`   Avg Loss:       $${stats.avgLoss.toFixed(2)}`);
    console.log(`   Avg Hold:       ${stats.avgHoldingDays.toFixed(1)} days`);
  }

  if (healthReport.success) {
    console.log(`\n   Account: $${healthReport.report.equity.toFixed(2)} | Drawdown: ${healthReport.report.drawdown.fromATH.toFixed(2)}%`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Safely run a function with error handling.
 * Ensures one crash doesn't bring down the whole bot.
 */
async function safeRun(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`\n❌ Error in ${name}:`, err.message);
    console.error(err.stack);

    // Log risk event
    try {
      db.risk.log({
        type: 'error',
        severity: 'warning',
        details: `${name}: ${err.message}`,
      });
    } catch (dbErr) {
      // Don't crash if logging fails
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// ─── Graceful Shutdown ──────────────────────────────────────

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    console.log(`\n\n🛑 ${signal} received. Shutting down gracefully...`);
    isRunning = false;

    // Stop all cron jobs
    for (const job of jobs) {
      job.stop();
    }
    console.log('   ⏹️  Cron jobs stopped.');

    // Save all positions to database
    for (const pos of positionManager.getAll()) {
      try {
        db.positions.upsert(pos);
      } catch (e) {
        // ignore
      }
    }
    console.log('   💾 Positions saved.');

    // Close database
    db.close();

    console.log('\n👋 SteadyGains shut down cleanly.\n');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('\n💥 Uncaught exception:', err);
    // Don't exit — the bot should keep running
    try {
      db.risk.log({
        type: 'uncaught_exception',
        severity: 'critical',
        details: err.message,
      });
    } catch (e) {
      // ignore
    }
  });
}

// ─── Start the Bot ──────────────────────────────────────────
start().catch(err => {
  console.error('\n💥 Fatal startup error:', err);
  process.exit(1);
});
