/**
 * SteadyGains — alpacaClient.js
 * ==============================
 * Thin wrapper around Alpaca REST API v2.
 * Handles auth headers, paper/live URL switching, rate limiting,
 * retries with exponential backoff, and clean error responses.
 *
 * Every method returns { success, data, error } so callers
 * never deal with raw HTTP or thrown exceptions.
 */

import axios from 'axios';
import config from './config.js';

// ─── HTTP Client Setup ──────────────────────────────────────
const tradingClient = axios.create({
  baseURL: `${config.alpaca.baseUrl}/${config.alpaca.apiVersion}`,
  headers: {
    'APCA-API-KEY-ID':     config.alpaca.apiKey,
    'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    'Content-Type':        'application/json',
  },
  timeout: 15000,
});

const dataClient = axios.create({
  baseURL: config.alpaca.dataUrl,
  headers: {
    'APCA-API-KEY-ID':     config.alpaca.apiKey,
    'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    'Content-Type':        'application/json',
  },
  timeout: 30000, // data endpoints can be slower
});

// ─── Rate Limiter ───────────────────────────────────────────
class RateLimiter {
  constructor(maxRequests = 200, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldest = this.requests[0];
      const waitMs = this.windowMs - (now - oldest) + 100;
      console.log(`⏳ Rate limit — waiting ${waitMs}ms`);
      await sleep(waitMs);
    }

    this.requests.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(190, 60000); // stay under 200/min limit

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Request Wrapper with Retry ─────────────────────────────
async function request(client, method, path, data = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await rateLimiter.waitForSlot();

      const opts = { method, url: path };
      if (data && (method === 'post' || method === 'patch' || method === 'put')) {
        opts.data = data;
      } else if (data && method === 'get') {
        opts.params = data;
      }

      const response = await client(opts);
      return { success: true, data: response.data, error: null };

    } catch (err) {
      const status = err.response?.status;
      const message = err.response?.data?.message || err.message;

      // Don't retry client errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) {
        return {
          success: false,
          data: null,
          error: { status, message, code: err.response?.data?.code || 'CLIENT_ERROR' },
        };
      }

      // Retry on 429, 5xx, or network errors
      if (attempt < retries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const jitter = Math.random() * 500;
        console.warn(`⚠️  Alpaca ${method.toUpperCase()} ${path} failed (attempt ${attempt}/${retries}): ${message}. Retrying in ${backoff}ms...`);
        await sleep(backoff + jitter);
      } else {
        return {
          success: false,
          data: null,
          error: { status: status || 0, message, code: 'MAX_RETRIES' },
        };
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  TRADING API (paper-api.alpaca.markets or api.alpaca.markets)
// ═══════════════════════════════════════════════════════════════

/**
 * Get account info — equity, cash, buying power, P&L
 */
async function getAccount() {
  const res = await request(tradingClient, 'get', '/account');
  if (!res.success) return res;

  const a = res.data;
  return {
    success: true,
    data: {
      id:               a.id,
      equity:           parseFloat(a.equity),
      cash:             parseFloat(a.cash),
      buyingPower:      parseFloat(a.buying_power),
      portfolioValue:   parseFloat(a.portfolio_value),
      lastEquity:       parseFloat(a.last_equity),
      dayTradeCount:    a.daytrade_count,
      tradingBlocked:   a.trading_blocked,
      transfersBlocked: a.transfers_blocked,
      accountBlocked:   a.account_blocked,
      patternDayTrader: a.pattern_day_trader,
      currency:         a.currency,
      status:           a.status,
      dailyPnl:         parseFloat(a.equity) - parseFloat(a.last_equity),
      dailyPnlPercent:  ((parseFloat(a.equity) - parseFloat(a.last_equity)) / parseFloat(a.last_equity)) * 100,
    },
    error: null,
  };
}

/**
 * Get all open positions
 */
async function getPositions() {
  const res = await request(tradingClient, 'get', '/positions');
  if (!res.success) return res;

  const positions = res.data.map(p => ({
    symbol:          p.symbol,
    qty:             parseFloat(p.qty),
    side:            p.side,
    marketValue:     parseFloat(p.market_value),
    costBasis:       parseFloat(p.cost_basis),
    avgEntryPrice:   parseFloat(p.avg_entry_price),
    currentPrice:    parseFloat(p.current_price),
    unrealizedPnl:   parseFloat(p.unrealized_pl),
    unrealizedPnlPct: parseFloat(p.unrealized_plpc),
    changeToday:     parseFloat(p.change_today),
    assetId:         p.asset_id,
  }));

  return { success: true, data: positions, error: null };
}

/**
 * Get a single position by symbol
 */
async function getPosition(symbol) {
  const res = await request(tradingClient, 'get', `/positions/${symbol.toUpperCase()}`);
  if (!res.success) return res;

  const p = res.data;
  return {
    success: true,
    data: {
      symbol:          p.symbol,
      qty:             parseFloat(p.qty),
      side:            p.side,
      marketValue:     parseFloat(p.market_value),
      costBasis:       parseFloat(p.cost_basis),
      avgEntryPrice:   parseFloat(p.avg_entry_price),
      currentPrice:    parseFloat(p.current_price),
      unrealizedPnl:   parseFloat(p.unrealized_pl),
      unrealizedPnlPct: parseFloat(p.unrealized_plpc),
    },
    error: null,
  };
}

/**
 * Submit a new order
 * @param {Object} order - { symbol, qty, side, type, timeInForce, limitPrice, stopPrice }
 */
async function submitOrder(order) {
  const payload = {
    symbol:        order.symbol.toUpperCase(),
    qty:           String(order.qty),
    side:          order.side,          // 'buy' or 'sell'
    type:          order.type || config.orders.defaultType,
    time_in_force: order.timeInForce || config.orders.timeInForce,
    extended_hours: config.orders.extendedHours,
  };

  // Add price fields based on order type
  if (order.limitPrice && (payload.type === 'limit' || payload.type === 'stop_limit')) {
    payload.limit_price = String(order.limitPrice);
  }
  if (order.stopPrice && (payload.type === 'stop' || payload.type === 'stop_limit')) {
    payload.stop_price = String(order.stopPrice);
  }
  if (order.trailPercent && payload.type === 'trailing_stop') {
    payload.trail_percent = String(order.trailPercent);
  }

  const res = await request(tradingClient, 'post', '/orders', payload);
  if (!res.success) return res;

  const o = res.data;
  return {
    success: true,
    data: {
      id:            o.id,
      clientOrderId: o.client_order_id,
      symbol:        o.symbol,
      qty:           parseFloat(o.qty),
      side:          o.side,
      type:          o.type,
      status:        o.status,
      limitPrice:    o.limit_price ? parseFloat(o.limit_price) : null,
      stopPrice:     o.stop_price ? parseFloat(o.stop_price) : null,
      filledQty:     parseFloat(o.filled_qty || 0),
      filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
      createdAt:     o.created_at,
      submittedAt:   o.submitted_at,
    },
    error: null,
  };
}

/**
 * Get order status by ID
 */
async function getOrder(orderId) {
  const res = await request(tradingClient, 'get', `/orders/${orderId}`);
  if (!res.success) return res;

  const o = res.data;
  return {
    success: true,
    data: {
      id:            o.id,
      symbol:        o.symbol,
      qty:           parseFloat(o.qty),
      side:          o.side,
      type:          o.type,
      status:        o.status,
      filledQty:     parseFloat(o.filled_qty || 0),
      filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
      createdAt:     o.created_at,
      filledAt:      o.filled_at,
    },
    error: null,
  };
}

/**
 * List recent orders
 */
async function listOrders(params = {}) {
  const query = {
    status: params.status || 'all',
    limit:  params.limit  || 50,
    direction: 'desc',
  };
  if (params.after)  query.after  = params.after;
  if (params.until)  query.until  = params.until;
  if (params.symbols) query.symbols = params.symbols.join(',');

  return request(tradingClient, 'get', '/orders', query);
}

/**
 * Cancel a specific order
 */
async function cancelOrder(orderId) {
  return request(tradingClient, 'delete', `/orders/${orderId}`);
}

/**
 * Cancel all open orders
 */
async function cancelAllOrders() {
  return request(tradingClient, 'delete', '/orders');
}

/**
 * Close a specific position (market sell)
 */
async function closePosition(symbol, qty = null) {
  const path = `/positions/${symbol.toUpperCase()}`;
  const params = qty ? { qty: String(qty) } : {};
  return request(tradingClient, 'delete', path, params);
}

/**
 * Close all positions
 */
async function closeAllPositions() {
  return request(tradingClient, 'delete', '/positions');
}

/**
 * Get market clock — is the market open right now?
 */
async function getClock() {
  const res = await request(tradingClient, 'get', '/clock');
  if (!res.success) return res;

  const c = res.data;
  return {
    success: true,
    data: {
      isOpen:    c.is_open,
      timestamp: c.timestamp,
      nextOpen:  c.next_open,
      nextClose: c.next_close,
    },
    error: null,
  };
}

/**
 * Get market calendar (trading days)
 */
async function getCalendar(start, end) {
  const params = {};
  if (start) params.start = start;  // YYYY-MM-DD
  if (end)   params.end   = end;
  return request(tradingClient, 'get', '/calendar', params);
}

/**
 * Get asset info
 */
async function getAsset(symbol) {
  return request(tradingClient, 'get', `/assets/${symbol.toUpperCase()}`);
}

// ═══════════════════════════════════════════════════════════════
//  MARKET DATA API (data.alpaca.markets)
// ═══════════════════════════════════════════════════════════════

/**
 * Get historical bars (OHLCV candles)
 * @param {string} symbol
 * @param {Object} params - { timeframe, start, end, limit, feed }
 *   timeframe: '1Min', '5Min', '15Min', '1Hour', '1Day'
 */
async function getBars(symbol, params = {}) {
  const query = {
    timeframe: params.timeframe || '1Day',
    limit:     params.limit     || 200,
    feed:      params.feed      || 'iex',  // free tier uses IEX
    sort:      'asc',
  };
  if (params.start) query.start = params.start;
  if (params.end)   query.end   = params.end;

  const res = await request(
    dataClient, 'get',
    `/v2/stocks/${symbol.toUpperCase()}/bars`,
    query
  );
  if (!res.success) return res;

  const bars = (res.data.bars || []).map(b => ({
    timestamp: b.t,
    open:      b.o,
    high:      b.h,
    low:       b.l,
    close:     b.c,
    volume:    b.v,
    vwap:      b.vw,
    tradeCount: b.n,
  }));

  return { success: true, data: bars, error: null };
}

/**
 * Get multi-symbol bars in one call (batch)
 */
async function getMultiBars(symbols, params = {}) {
  const query = {
    symbols:   symbols.join(','),
    timeframe: params.timeframe || '1Day',
    limit:     params.limit     || 200,
    feed:      params.feed      || 'iex',
    sort:      'asc',
  };
  if (params.start) query.start = params.start;
  if (params.end)   query.end   = params.end;

  const res = await request(dataClient, 'get', '/v2/stocks/bars', query);
  if (!res.success) return res;

  // Transform { AAPL: [{...}], MSFT: [{...}] } into clean format
  const result = {};
  for (const [sym, bars] of Object.entries(res.data.bars || {})) {
    result[sym] = bars.map(b => ({
      timestamp: b.t,
      open:      b.o,
      high:      b.h,
      low:       b.l,
      close:     b.c,
      volume:    b.v,
      vwap:      b.vw,
    }));
  }

  return { success: true, data: result, error: null };
}

/**
 * Get latest quote (bid/ask) for a symbol
 */
async function getLatestQuote(symbol) {
  const res = await request(
    dataClient, 'get',
    `/v2/stocks/${symbol.toUpperCase()}/quotes/latest`,
    { feed: 'iex' }
  );
  if (!res.success) return res;

  const q = res.data.quote;
  return {
    success: true,
    data: {
      symbol:    symbol.toUpperCase(),
      bidPrice:  q.bp,
      bidSize:   q.bs,
      askPrice:  q.ap,
      askSize:   q.as,
      timestamp: q.t,
      spread:    q.ap - q.bp,
      spreadPct: q.bp > 0 ? (q.ap - q.bp) / q.bp : 0,
    },
    error: null,
  };
}

/**
 * Get latest trade for a symbol
 */
async function getLatestTrade(symbol) {
  const res = await request(
    dataClient, 'get',
    `/v2/stocks/${symbol.toUpperCase()}/trades/latest`,
    { feed: 'iex' }
  );
  if (!res.success) return res;

  const t = res.data.trade;
  return {
    success: true,
    data: {
      symbol:    symbol.toUpperCase(),
      price:     t.p,
      size:      t.s,
      timestamp: t.t,
    },
    error: null,
  };
}

/**
 * Get snapshot for a symbol (latest trade + quote + bar)
 */
async function getSnapshot(symbol) {
  return request(
    dataClient, 'get',
    `/v2/stocks/${symbol.toUpperCase()}/snapshot`,
    { feed: 'iex' }
  );
}

/**
 * Get snapshots for multiple symbols at once
 */
async function getSnapshots(symbols) {
  return request(
    dataClient, 'get',
    '/v2/stocks/snapshots',
    { symbols: symbols.join(','), feed: 'iex' }
  );
}

// ─── Health Check ───────────────────────────────────────────
/**
 * Verify the API connection is working
 */
async function healthCheck() {
  const [accountRes, clockRes] = await Promise.all([
    getAccount(),
    getClock(),
  ]);

  return {
    connected:    accountRes.success && clockRes.success,
    mode:         config.alpaca.mode,
    equity:       accountRes.success ? accountRes.data.equity : null,
    marketOpen:   clockRes.success ? clockRes.data.isOpen : null,
    errors:       [
      !accountRes.success ? `Account: ${accountRes.error?.message}` : null,
      !clockRes.success   ? `Clock: ${clockRes.error?.message}`   : null,
    ].filter(Boolean),
  };
}

// ─── Export ─────────────────────────────────────────────────
const alpaca = {
  // Account
  getAccount,
  getPositions,
  getPosition,

  // Orders
  submitOrder,
  getOrder,
  listOrders,
  cancelOrder,
  cancelAllOrders,

  // Positions
  closePosition,
  closeAllPositions,

  // Market info
  getClock,
  getCalendar,
  getAsset,

  // Market data
  getBars,
  getMultiBars,
  getLatestQuote,
  getLatestTrade,
  getSnapshot,
  getSnapshots,

  // Utility
  healthCheck,
};

export { alpaca };
export default alpaca;
