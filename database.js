/**
 * SteadyGains — database.js
 * =========================
 * SQLite persistence layer using better-sqlite3.
 * Stores trade history, position snapshots, signals,
 * risk events, and daily equity snapshots.
 *
 * Tables:
 *   trades          — Complete trade journal (entry/exit/P&L)
 *   positions        — Current open position state
 *   daily_snapshots  — End-of-day equity curve
 *   signals          — Every signal generated (for backtesting)
 *   risk_events      — Circuit breaker triggers and risk warnings
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import config from './config.js';

let db = null;

// ─── Initialize ─────────────────────────────────────────────

function initialize() {
  const dbPath = config.database.path;

  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();
  console.log(`💾 Database initialized: ${dbPath}`);

  return db;
}

function createTables() {
  db.exec(`
    -- Trade journal: every completed trade
    CREATE TABLE IF NOT EXISTS trades (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL DEFAULT 'buy',
      shares          REAL NOT NULL,
      entry_price     REAL NOT NULL,
      exit_price      REAL,
      entry_date      TEXT NOT NULL,
      exit_date       TEXT,
      stop_loss       REAL,
      take_profit     REAL,
      exit_type       TEXT,          -- 'stop', 'target', 'partial', 'time', 'overbought', 'manual'
      pnl             REAL DEFAULT 0,
      pnl_percent     REAL DEFAULT 0,
      fees            REAL DEFAULT 0,
      signal_score    INTEGER,
      holding_days    INTEGER,
      notes           TEXT,
      order_id        TEXT,
      status          TEXT DEFAULT 'open',  -- 'open', 'closed', 'partial'
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Current position state (mirrors positionManager in-memory)
    CREATE TABLE IF NOT EXISTS positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol          TEXT UNIQUE NOT NULL,
      shares          REAL NOT NULL,
      entry_price     REAL NOT NULL,
      entry_date      TEXT NOT NULL,
      stop_loss       REAL NOT NULL,
      original_stop   REAL,
      take_profit     REAL,
      partial_target  REAL,
      partial_taken   INTEGER DEFAULT 0,
      trailing_active INTEGER DEFAULT 0,
      high_water_mark REAL,
      atr             REAL,
      sector          TEXT,
      order_id        TEXT,
      status          TEXT DEFAULT 'open',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Daily equity snapshots for performance tracking
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT UNIQUE NOT NULL,
      equity          REAL NOT NULL,
      cash            REAL,
      buying_power    REAL,
      positions_count INTEGER DEFAULT 0,
      total_exposure  REAL DEFAULT 0,
      daily_pnl       REAL DEFAULT 0,
      daily_pnl_pct   REAL DEFAULT 0,
      weekly_pnl      REAL DEFAULT 0,
      weekly_pnl_pct  REAL DEFAULT 0,
      drawdown_pct    REAL DEFAULT 0,
      trades_today    INTEGER DEFAULT 0,
      wins_today      INTEGER DEFAULT 0,
      losses_today    INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Signal log: every signal generated (buy and exit)
    CREATE TABLE IF NOT EXISTS signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol          TEXT NOT NULL,
      signal_type     TEXT NOT NULL,   -- 'BUY', 'SELL', 'HOLD', etc.
      score           INTEGER,
      price           REAL,
      stop_loss       REAL,
      take_profit     REAL,
      rsi             REAL,
      bb_percent_b    REAL,
      volume_ratio    REAL,
      reasons         TEXT,            -- JSON array of reason strings
      acted_on        INTEGER DEFAULT 0,  -- was this signal traded?
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Risk events: circuit breakers, cooldowns, warnings
    CREATE TABLE IF NOT EXISTS risk_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type      TEXT NOT NULL,   -- 'circuit_breaker', 'cooldown', 'kill_switch', 'warning'
      severity        TEXT DEFAULT 'warning',  -- 'info', 'warning', 'critical'
      details         TEXT,
      daily_pnl_pct   REAL,
      weekly_pnl_pct  REAL,
      equity          REAL,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_exit_date ON trades(exit_date);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON daily_snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type);
  `);
}

// ─── Trade Operations ───────────────────────────────────────

const tradeOps = {
  /** Record a new trade entry */
  openTrade(trade) {
    const stmt = db.prepare(`
      INSERT INTO trades (symbol, side, shares, entry_price, entry_date, stop_loss, take_profit, signal_score, order_id, status)
      VALUES (@symbol, @side, @shares, @entryPrice, @entryDate, @stopLoss, @takeProfit, @signalScore, @orderId, 'open')
    `);
    const result = stmt.run({
      symbol: trade.symbol,
      side: trade.side || 'buy',
      shares: trade.shares,
      entryPrice: trade.entryPrice,
      entryDate: trade.entryDate || new Date().toISOString(),
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      signalScore: trade.signalScore || null,
      orderId: trade.orderId || null,
    });
    return result.lastInsertRowid;
  },

  /** Record a trade exit */
  closeTrade(tradeId, exitData) {
    const stmt = db.prepare(`
      UPDATE trades SET
        exit_price = @exitPrice,
        exit_date = @exitDate,
        exit_type = @exitType,
        pnl = @pnl,
        pnl_percent = @pnlPercent,
        holding_days = @holdingDays,
        notes = @notes,
        status = 'closed',
        updated_at = datetime('now')
      WHERE id = @id
    `);
    stmt.run({
      id: tradeId,
      exitPrice: exitData.exitPrice,
      exitDate: exitData.exitDate || new Date().toISOString(),
      exitType: exitData.exitType,
      pnl: exitData.pnl,
      pnlPercent: exitData.pnlPercent,
      holdingDays: exitData.holdingDays || 0,
      notes: exitData.notes || null,
    });
  },

  /** Find open trade by symbol */
  getOpenTrade(symbol) {
    return db.prepare("SELECT * FROM trades WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(symbol);
  },

  /** Get all open trades */
  getOpenTrades() {
    return db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY entry_date DESC").all();
  },

  /** Get recent closed trades */
  getRecentTrades(limit = 20) {
    return db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY exit_date DESC LIMIT ?").all(limit);
  },

  /** Get trades for a date range */
  getTradesByDateRange(startDate, endDate) {
    return db.prepare('SELECT * FROM trades WHERE entry_date >= ? AND entry_date <= ? ORDER BY entry_date DESC').all(startDate, endDate);
  },
};

// ─── Position Operations ────────────────────────────────────

const positionOps = {
  /** Save or update a position */
  upsert(pos) {
    const stmt = db.prepare(`
      INSERT INTO positions (symbol, shares, entry_price, entry_date, stop_loss, original_stop, take_profit, partial_target, partial_taken, trailing_active, high_water_mark, atr, sector, order_id, status)
      VALUES (@symbol, @shares, @entryPrice, @entryDate, @stopLoss, @originalStop, @takeProfit, @partialTarget, @partialTaken, @trailingActive, @highWaterMark, @atr, @sector, @orderId, @status)
      ON CONFLICT(symbol) DO UPDATE SET
        shares = @shares,
        stop_loss = @stopLoss,
        partial_taken = @partialTaken,
        trailing_active = @trailingActive,
        high_water_mark = @highWaterMark,
        status = @status,
        updated_at = datetime('now')
    `);
    stmt.run({
      symbol: pos.symbol,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      entryDate: pos.entryDate,
      stopLoss: pos.stopLoss,
      originalStop: pos.originalStop || pos.stopLoss,
      takeProfit: pos.takeProfit,
      partialTarget: pos.partialTarget || null,
      partialTaken: pos.partialTaken ? 1 : 0,
      trailingActive: pos.trailingActive ? 1 : 0,
      highWaterMark: pos.highWaterMark || pos.entryPrice,
      atr: pos.atr || null,
      sector: pos.sector || null,
      orderId: pos.orderId || null,
      status: pos.status || 'open',
    });
  },

  /** Remove a position */
  remove(symbol) {
    db.prepare('DELETE FROM positions WHERE symbol = ?').run(symbol);
  },

  /** Get all saved positions */
  getAll() {
    return db.prepare("SELECT * FROM positions WHERE status != 'closed' ORDER BY entry_date").all();
  },
};

// ─── Snapshot Operations ────────────────────────────────────

const snapshotOps = {
  /** Save daily equity snapshot */
  saveDaily(snapshot) {
    const stmt = db.prepare(`
      INSERT INTO daily_snapshots (date, equity, cash, buying_power, positions_count, total_exposure, daily_pnl, daily_pnl_pct, weekly_pnl, weekly_pnl_pct, drawdown_pct, trades_today, wins_today, losses_today)
      VALUES (@date, @equity, @cash, @buyingPower, @positionsCount, @totalExposure, @dailyPnl, @dailyPnlPct, @weeklyPnl, @weeklyPnlPct, @drawdownPct, @tradesToday, @winsToday, @lossesToday)
      ON CONFLICT(date) DO UPDATE SET
        equity = @equity,
        cash = @cash,
        buying_power = @buyingPower,
        positions_count = @positionsCount,
        total_exposure = @totalExposure,
        daily_pnl = @dailyPnl,
        daily_pnl_pct = @dailyPnlPct,
        weekly_pnl = @weeklyPnl,
        weekly_pnl_pct = @weeklyPnlPct,
        drawdown_pct = @drawdownPct,
        trades_today = @tradesToday,
        wins_today = @winsToday,
        losses_today = @lossesToday
    `);
    stmt.run(snapshot);
  },

  /** Get equity curve (last N days) */
  getEquityCurve(days = 30) {
    return db.prepare('SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT ?').all(days).reverse();
  },

  /** Get latest snapshot */
  getLatest() {
    return db.prepare('SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 1').get();
  },
};

// ─── Signal Operations ──────────────────────────────────────

const signalOps = {
  /** Log a generated signal */
  log(signal) {
    const stmt = db.prepare(`
      INSERT INTO signals (symbol, signal_type, score, price, stop_loss, take_profit, rsi, bb_percent_b, volume_ratio, reasons, acted_on)
      VALUES (@symbol, @signalType, @score, @price, @stopLoss, @takeProfit, @rsi, @bbPercentB, @volumeRatio, @reasons, @actedOn)
    `);
    stmt.run({
      symbol: signal.symbol,
      signalType: signal.type,
      score: signal.score || null,
      price: signal.price,
      stopLoss: signal.entry?.stopLoss || null,
      takeProfit: signal.entry?.takeProfit || null,
      rsi: signal.indicators?.rsi || null,
      bbPercentB: signal.indicators?.bbPercentB || null,
      volumeRatio: signal.indicators?.volumeRatio || null,
      reasons: JSON.stringify(signal.reasons || []),
      actedOn: signal.actedOn ? 1 : 0,
    });
  },

  /** Get recent signals */
  getRecent(limit = 50) {
    return db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};

// ─── Risk Event Operations ──────────────────────────────────

const riskOps = {
  /** Log a risk event */
  log(event) {
    const stmt = db.prepare(`
      INSERT INTO risk_events (event_type, severity, details, daily_pnl_pct, weekly_pnl_pct, equity)
      VALUES (@eventType, @severity, @details, @dailyPnlPct, @weeklyPnlPct, @equity)
    `);
    stmt.run({
      eventType: event.type,
      severity: event.severity || 'warning',
      details: event.details || null,
      dailyPnlPct: event.dailyPnlPct || null,
      weeklyPnlPct: event.weeklyPnlPct || null,
      equity: event.equity || null,
    });
  },

  /** Get recent risk events */
  getRecent(limit = 20) {
    return db.prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};

// ─── Performance Metrics ────────────────────────────────────

const metrics = {
  /** Calculate overall performance stats */
  getStats() {
    const closedTrades = db.prepare("SELECT * FROM trades WHERE status = 'closed'").all();

    if (closedTrades.length === 0) {
      return { totalTrades: 0, message: 'No closed trades yet' };
    }

    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl <= 0);
    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const largestWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;
    const avgHoldingDays = closedTrades.reduce((s, t) => s + (t.holding_days || 0), 0) / closedTrades.length;

    // Profit factor
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Exit type breakdown
    const exitTypes = {};
    for (const t of closedTrades) {
      exitTypes[t.exit_type] = (exitTypes[t.exit_type] || 0) + 1;
    }

    return {
      totalTrades:    closedTrades.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        (wins.length / closedTrades.length) * 100,
      totalPnl,
      avgWin,
      avgLoss,
      avgPnl:         totalPnl / closedTrades.length,
      largestWin,
      largestLoss,
      profitFactor,
      avgHoldingDays,
      exitTypes,
    };
  },

  /** Get this week's stats */
  getWeeklyStats() {
    const monday = getMonday(new Date()).toISOString().split('T')[0];
    const trades = db.prepare(
      "SELECT * FROM trades WHERE status = 'closed' AND exit_date >= ?"
    ).all(monday);

    const wins = trades.filter(t => t.pnl > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

    return {
      trades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalPnl,
    };
  },
};

// ─── Helpers ────────────────────────────────────────────────

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

/** Close the database connection */
function close() {
  if (db) {
    db.close();
    console.log('💾 Database closed.');
  }
}

// ─── Export ─────────────────────────────────────────────────
export {
  initialize,
  close,
  tradeOps,
  positionOps,
  snapshotOps,
  signalOps,
  riskOps,
  metrics,
};

export default {
  initialize,
  close,
  trades: tradeOps,
  positions: positionOps,
  snapshots: snapshotOps,
  signals: signalOps,
  risk: riskOps,
  metrics,
};