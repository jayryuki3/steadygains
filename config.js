/**
 * SteadyGains — config.js
 * ========================
 * Every tunable parameter lives here. Nothing is hardcoded elsewhere.
 * Swap TRADING_MODE between 'paper' and 'live' when you're ready.
 */

import 'dotenv/config';

// ─── Environment ────────────────────────────────────────────
const MODE = (process.env.TRADING_MODE || 'paper').toLowerCase();
const IS_LIVE = MODE === 'live';

const config = {

  // ─── Alpaca Connection ──────────────────────────────────────
  alpaca: {
    apiKey:    process.env.ALPACA_API_KEY    || '',
    secretKey: process.env.ALPACA_SECRET_KEY || '',
    baseUrl:   IS_LIVE
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets',
    dataUrl:   'https://data.alpaca.markets',
    apiVersion: 'v2',
    isLive:    IS_LIVE,
    mode:      MODE,
  },

  // ─── Account ────────────────────────────────────────────────
  account: {
    startingCapital:    1000,
    // The bot reads actual equity from Alpaca each cycle;
    // this is only used for first-run sanity checks.
  },

  // ─── Risk Limits (the guardrails that keep you safe) ────────
  risk: {
    maxRiskPerTrade:      0.015,   // 1.5 % of equity risked per trade
    maxRiskPerTradeHard:  0.02,    // absolute ceiling — never exceed 2 %
    maxDailyLoss:         0.03,    // halt trading if down 3 % in a day
    maxWeeklyDrawdown:    0.10,    // halt trading if down 10 % from weekly peak
    maxTotalDrawdown:     0.15,    // kill switch — 15 % from all-time high
    maxOpenPositions:     5,       // never hold more than 5 stocks at once
    maxPortfolioPerStock: 0.15,    // no single stock > 15 % of portfolio
    maxPortfolioHeat:     0.06,    // total risk across all positions ≤ 6 %
    maxCorrelatedSector:  2,       // max 2 stocks from the same sector
    consecutiveLossLimit: 3,       // pause after 3 losses in a row
    cooldownMinutes:      60,      // how long to pause after consecutive losses
    minCashReserve:       0.20,    // always keep 20 % cash available
  },

  // ─── Strategy Parameters ────────────────────────────────────
  strategy: {
    name: 'ConservativeSwing',

    // RSI
    rsiPeriod:         14,
    rsiOversold:       35,      // buy zone (conservative — not 30)
    rsiOverbought:     65,      // exit zone (conservative — not 70)

    // Bollinger Bands
    bbPeriod:          20,
    bbStdDev:          2,

    // Trend Filters (SMA)
    smaPeriodShort:    50,
    smaPeriodLong:     200,
    requireUptrend:    true,     // price must be above SMA-50

    // ATR (for stops & targets)
    atrPeriod:         14,
    stopLossMultiplier:  1.5,    // stop = entry - 1.5 × ATR
    takeProfitMultiplier: 3.0,   // target = entry + 3.0 × ATR (2:1 R:R)

    // Volume
    volumeAvgPeriod:   20,
    volumeSpikeRatio:  1.3,     // volume must be ≥ 1.3× its 20-day avg

    // Signal scoring
    minSignalScore:    3,       // need 3 out of 5 confirmations to enter
    maxSignalScore:    5,

    // Position holding
    maxHoldingDays:    5,       // close stale trades after 5 trading days
    trailingStopActivation: 0.015, // activate trailing stop after +1.5 %
    trailingStopDistance:   0.01,  // trail by 1 %

    // Partial profit taking
    partialExitRatio:  0.50,    // sell 50 % at first target
    partialExitRR:     1.5,     // first target = 1.5 × risk
  },

  // ─── Watchlist ──────────────────────────────────────────────
  //  Liquid, mid-cap stocks with decent volatility.
  //  The scanner will validate these daily and skip any
  //  that don't meet liquidity thresholds.
  watchlist: [
    // Tech
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META',
    'NVDA', 'AMD', 'CRM', 'ADBE', 'INTC',
    // Finance
    'JPM', 'BAC', 'GS', 'V', 'MA',
    // Healthcare
    'JNJ', 'PFE', 'UNH', 'ABBV', 'MRK',
    // Consumer
    'DIS', 'NKE', 'SBUX', 'HD', 'TGT',
    // Energy
    'XOM', 'CVX', 'COP',
    // ETFs (for diversification signals)
    'SPY', 'QQQ',
  ],

  // Sector mapping for correlation checks
  sectors: {
    AAPL: 'tech', MSFT: 'tech', GOOGL: 'tech', AMZN: 'tech', META: 'tech',
    NVDA: 'tech', AMD: 'tech', CRM: 'tech', ADBE: 'tech', INTC: 'tech',
    JPM: 'finance', BAC: 'finance', GS: 'finance', V: 'finance', MA: 'finance',
    JNJ: 'health', PFE: 'health', UNH: 'health', ABBV: 'health', MRK: 'health',
    DIS: 'consumer', NKE: 'consumer', SBUX: 'consumer', HD: 'consumer', TGT: 'consumer',
    XOM: 'energy', CVX: 'energy', COP: 'energy',
    SPY: 'index', QQQ: 'index',
  },

  // ─── Scheduling ─────────────────────────────────────────────
  //  All times in America/New_York (market time)
  schedule: {
    timezone: 'America/New_York',

    // How often each loop runs (cron expressions)
    stopCheck:       '*/5 * * * *',     // every 5 min — protect capital
    quickScan:       '*/15 * * * *',     // every 15 min — spot setups
    fullSignalScan:  '0 * * * *',        // top of every hour — deep analysis
    preMarket:       '0 9 * * 1-5',      // 9:00 AM ET weekdays
    marketOpen:      '30 9 * * 1-5',     // 9:30 AM ET — market opens
    endOfDay:        '45 15 * * 1-5',    // 3:45 PM ET — EOD cleanup
    weeklyReview:    '0 15 * * 5',       // Friday 3:00 PM ET

    // Market hours (only trade during these)
    marketOpenHour:  9,
    marketOpenMin:   30,
    marketCloseHour: 16,
    marketCloseMin:  0,

    // Don't enter new positions in last 30 min
    noNewTradesBeforeCloseMin: 30,
  },

  // ─── Compounding ────────────────────────────────────────────
  compounding: {
    enabled:           true,
    reinvestProfits:   true,    // roll gains into position sizing
    weeklyTarget:      0.03,    // 3 % weekly target (conservative middle ground)
    compoundThreshold: 50,      // only compound when profits > $50
    // After hitting weekly target, reduce position sizes by this factor
    targetHitReduction: 0.5,
  },

  // ─── Logging ─────────────────────────────────────────────────
  logging: {
    level:     process.env.LOG_LEVEL || 'info',
    dir:       './logs',
    maxFiles:  30,              // keep 30 days of logs
    console:   true,
    timestamps: true,
  },

  // ─── Database ───────────────────────────────────────────────
  database: {
    path: './data/steadygains.db',
  },

  // ─── Order Defaults ─────────────────────────────────────────
  orders: {
    defaultType:      'limit',   // prefer limit orders over market
    limitSlippage:    0.001,     // limit price = market + 0.1 % (for fills)
    timeInForce:      'day',     // orders expire end of day
    extendedHours:    false,     // no pre/post market trading
  },

  // ─── Filters ────────────────────────────────────────────────
  filters: {
    minPrice:          5,        // skip penny stocks
    maxPrice:          500,      // skip ultra-expensive stocks
    minAvgVolume:      500000,   // must trade 500k+ shares/day avg
    minMarketCap:      1e9,      // $1B+ market cap
    maxSpreadPercent:  0.005,    // skip illiquid stocks (> 0.5 % spread)
  },
};

// ─── Validation ─────────────────────────────────────────────
function validateConfig() {
  const errors = [];

  if (!config.alpaca.apiKey)
    errors.push('ALPACA_API_KEY is required — set it in .env');
  if (!config.alpaca.secretKey)
    errors.push('ALPACA_SECRET_KEY is required — set it in .env');
  if (config.risk.maxRiskPerTrade > config.risk.maxRiskPerTradeHard)
    errors.push('maxRiskPerTrade cannot exceed maxRiskPerTradeHard');
  if (config.risk.maxOpenPositions < 1)
    errors.push('maxOpenPositions must be at least 1');
  if (config.strategy.minSignalScore > config.strategy.maxSignalScore)
    errors.push('minSignalScore cannot exceed maxSignalScore');
  if (config.watchlist.length === 0)
    errors.push('Watchlist cannot be empty');

  if (errors.length > 0) {
    console.error('\n❌ CONFIG ERRORS:');
    errors.forEach(e => console.error(`   • ${e}`));
    console.error('');
    process.exit(1);
  }

  if (config.alpaca.isLive) {
    console.warn('\n⚠️  LIVE TRADING MODE — Real money is at risk!\n');
  } else {
    console.log('📋 Paper trading mode — no real money at risk.');
  }
}

export { config, validateConfig };
export default config;
