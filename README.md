# SteadyGains

**Conservative Alpaca trading bot for a $1,000 account.**
Targets 2-5% weekly gains with strict risk controls that protect your capital above all else.

---

## Philosophy

> "I'd rather make less money safely than risk losing it all."

SteadyGains is built around one principle: **survival first, profits second.**
Every trade must pass 11 risk checks before execution. Circuit breakers halt
trading automatically if losses mount. The bot compounds gains when things go
well and scales back when they don't.

---

## Quick Start

### 1. Get Alpaca API Keys (Free)

1. Sign up at [alpaca.markets](https://alpaca.markets) (no deposit required)
2. Go to **Paper Trading** dashboard
3. Generate API keys (Key + Secret)

### 2. Install & Configure

```bash
# Clone / copy the steadygains folder
cd steadygains

# Install dependencies
npm install

# Set up environment
mv env.example .env
# Edit .env with your Alpaca API keys
```

### 3. Run in Paper Mode

```bash
# Start the bot (paper trading by default)
npm start

# Or explicitly:
npm run paper
```

The bot will connect to Alpaca, verify your API keys, and start its
scheduled trading loops. It only trades during market hours (9:30 AM - 4:00 PM ET).

### 4. Switch to Live (After 2+ Weeks of Paper Testing)

```bash
# Update .env:
#   TRADING_MODE=live
#   ALPACA_API_KEY=<your live key>
#   ALPACA_SECRET_KEY=<your live secret>

npm run live
```

---

## Architecture

```
+--------------------------------------------------+
|               autoTrader.js (Engine)             |
|   Scheduler -> Scan -> Signal -> Risk -> Execute |
+--------------------------------------------------+
        |           |          |         |
   +--------+  +---------+  +------+  +--------+
   |scanner | |strategy | | risk  | |position|
   |   .js  | |   .js   | |Mgr.js | |Mgr.js  |
   +--------+  +---------+  +------+  +--------+
        |           |          |         |
   +------------------------------------------+
   |          alpacaClient.js                 |
   |    (Alpaca REST API v2 wrapper)          |
   +------------------------------------------+
        |                       |
   +----------+          +----------+
   |config.js |          |database.js|
   |(all params)|        |(SQLite)   |
   +----------+          +----------+
```

### File Overview

| File | Lines | Purpose |
|------|-------|---------|
| `config.js` | ~260 | Every tunable parameter: risk limits, strategy settings, watchlist, schedule |
| `alpacaClient.js` | ~450 | HTTP wrapper for Alpaca API. Auth, rate limiting, retries, clean responses |
| `scanner.js` | ~300 | Fetches price/volume data, calculates RSI/BB/SMA/ATR, ranks candidates |
| `strategy.js` | ~400 | Signal scoring (3/5 to buy), position sizing, exit logic, compounding |
| `riskManager.js` | ~500 | 11-point pre-trade validation, circuit breakers, drawdown limits |
| `positionManager.js` | ~400 | Trailing stops, partial profits, time exits, weekend risk reduction |
| `database.js` | ~460 | SQLite persistence: trades, positions, equity curve, signal log |
| `autoTrader.js` | ~600 | Main engine: scheduler, trading loop, daily/weekly reports, shutdown |

---

## Trading Strategy

### Entry: Conservative Swing (Score 3/5 required)

The bot scores each stock on 5 criteria. A trade only triggers when
3 or more align:

| Signal | Condition | Weight |
|--------|-----------|--------|
| RSI Oversold | RSI(14) <= 35 | +1 |
| Bollinger Low | Price at/below lower BB(20,2) | +1 |
| Uptrend Filter | Price above SMA-50 | +1 |
| Volume Spike | Volume >= 1.3x 20-day avg | +1 |
| Bullish Candle | Hammer, engulfing, or morning star | +1 |

### Exit Triggers (any one is enough)

- **Stop Loss**: 1.5x ATR below entry (hard floor)
- **Profit Target**: 3x ATR above entry (2:1 reward-to-risk)
- **Partial Exit**: Sell 50% at 1.5x R, let rest ride
- **Trailing Stop**: Activates at +1.5%, trails by 1%
- **Overbought**: RSI >= 65 or price at upper Bollinger
- **Time Exit**: Close after 5 trading days if < 3% gain
- **Weekend**: Tighten all stops Friday 3 PM

### Position Sizing

```
Risk per trade = 1.5% of equity
Shares = risk_amount / (entry - stop_loss)
Capped at 15% of portfolio per stock
Max 5 positions open simultaneously
```

With a $1,000 account, this means risking ~$15 per trade.

---

## Risk Controls (11-Point Checklist)

Every trade must pass ALL of these before the bot places an order:

| # | Check | Limit |
|---|-------|-------|
| 1 | Position size | Max 15% of portfolio per stock |
| 2 | Open positions | Max 5 at once |
| 3 | Daily loss | Circuit breaker at -3% |
| 4 | Weekly drawdown | Halt at -10% |
| 5 | Total drawdown | Kill switch at -15% from ATH |
| 6 | Sector correlation | Max 2 stocks from same sector |
| 7 | Consecutive losses | Cooldown after 3 losses (1 hour) |
| 8 | Buying power | Must have funds + 20% cash reserve |
| 9 | Market hours | Only trade 9:30 AM - 3:30 PM ET |
| 10 | Volatility | Skip if ATR > 5% of price |
| 11 | Portfolio heat | Total open risk <= 6% of equity |

---

## Scheduling

All times in Eastern Time (market time):

| Frequency | What Happens | Why |
|-----------|-------------|-----|
| Every 5 min | Check stops & position health | Protect capital first |
| Every 15 min | Quick market scan (snapshots) | Spot fast-moving setups |
| Every 1 hour | Full signal generation | Deep technical analysis |
| 9:00 AM ET | Pre-market prep | Reset daily counters, sync positions |
| 9:45 AM ET | Post-open scan | Wait 15 min for opening chaos to settle |
| 3:45 PM ET | End-of-day cleanup | Save snapshots, daily P&L summary |
| Friday 3 PM | Weekly review | Tighten stops, performance report |

The bot does NOT trade:
- Before 9:30 AM or after 3:30 PM ET
- During the first 15 minutes after market open
- On weekends or market holidays
- When any circuit breaker is active

---

## Watchlist

30 liquid stocks across 6 sectors + 2 index ETFs:

- **Tech**: AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, CRM, ADBE, INTC
- **Finance**: JPM, BAC, GS, V, MA
- **Healthcare**: JNJ, PFE, UNH, ABBV, MRK
- **Consumer**: DIS, NKE, SBUX, HD, TGT
- **Energy**: XOM, CVX, COP
- **Index ETFs**: SPY, QQQ

Edit the watchlist in `config.js` to add/remove symbols.

---

## Compounding

When enabled (default), the bot:

1. **Reinvests profits** — position sizes grow as equity grows
2. **Scales back after hitting weekly target** — reduces size by 50% to protect gains
3. **Gets more conservative during drawdowns** — halves position size when down 2%+ in a week
4. **Only compounds above $50** — avoids micro-adjustments

---

## Database

All data is stored locally in `./data/steadygains.db` (SQLite).

**Tables:**
- `trades` — Complete trade journal with entry/exit prices, P&L, holding time
- `positions` — Current open position state (persisted across restarts)
- `daily_snapshots` — Equity curve for performance tracking
- `signals` — Every signal generated (for strategy analysis)
- `risk_events` — Circuit breaker triggers and risk warnings

---

## Realistic Expectations

**The target is 2-5% weekly, but here's the honest truth:**

- **Some weeks will be negative.** The stop losses and circuit breakers exist
  because losing trades are inevitable. The goal is to make the winners
  bigger than the losers over time.

- **5-10% weekly is aggressive.** Professional hedge funds target 15-20%
  annually. 2-5% weekly would be exceptional. The bot is tuned for the
  conservative end of your target.

- **Paper trade first.** Run in paper mode for at least 2 weeks before
  putting real money in. This lets you see how the strategy behaves in
  real market conditions without any risk.

- **$1,000 is a small account.** Position sizes will be small (often 1-5
  shares). This limits diversification but the risk controls compensate.

- **The bot protects against catastrophic loss.** The 15% kill switch means
  the absolute worst case is losing $150 before the bot stops itself.
  More realistically, the 3% daily circuit breaker ($30) halts trading
  well before that.

**What success looks like:**
- Win rate: 45-55% (you don't need to win most trades)
- Average win > average loss (the 2:1 reward-to-risk ratio)
- Profit factor > 1.5 (gross profits / gross losses)
- Drawdowns recover within 1-2 weeks

---

## Folder Structure

```
steadygains/
  autoTrader.js       # Main engine (run this)
  config.js           # All parameters
  alpacaClient.js     # Alpaca API wrapper
  scanner.js          # Market scanner + indicators
  strategy.js         # Signal generation + sizing
  riskManager.js      # 11-point risk validation
  positionManager.js  # Position tracking + exits
  database.js         # SQLite persistence
  package.json        # Dependencies
  env.example         # Environment template (rename to .env)
  README.md           # This file
  data/               # Created at runtime (SQLite database)
  logs/               # Created at runtime (log files)
```

---

## License

MIT
