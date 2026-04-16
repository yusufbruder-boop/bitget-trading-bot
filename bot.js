"use strict";

const http = require("http");
const crypto = require("crypto");

// ── Configuration ─────────────────────────────────────────────────────────────

const BITGET_API_KEY      = process.env.BITGET_API_KEY      || "";
const BITGET_SECRET_KEY   = process.env.BITGET_SECRET_KEY   || "";
const BITGET_PASSPHRASE   = process.env.BITGET_PASSPHRASE   || "";
const TRADE_SYMBOL        = process.env.TRADE_SYMBOL        || "BTCUSDT";
const TRADE_SIZE          = parseFloat(process.env.TRADE_SIZE || "0.001");
const LIVE_TRADING        = (process.env.LIVE_TRADING || "").toLowerCase() === "true";
const POLYMARKET_URL      = process.env.POLYMARKET_INTERNAL_URL || "http://polymarket-insider-bot.railway.internal/signals";
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || "";
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID    || process.env.TELEGRAM_USER_ID || "";
const PORT                = parseInt(process.env.PORT || "3000", 10);

const BITGET_BASE_URL = "https://api.bitget.com";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram] env missing, skipping");
    return;
  }
  try {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15000),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.ok === false)) {
      console.error("[Telegram] failed:", res.status, data && data.description);
    }
  } catch (e) {
    console.error("[Telegram] error:", e.message);
  }
}

// ── BitGet API v2 HMAC-SHA256 signing ─────────────────────────────────────────

function sign(timestamp, method, requestPath, body) {
  const prehash = timestamp + method.toUpperCase() + requestPath + (body || "");
  return crypto
    .createHmac("sha256", BITGET_SECRET_KEY)
    .update(prehash)
    .digest("base64");
}

async function bitgetRequest(method, path, params, bodyObj) {
  const timestamp = Date.now().toString();
  let url = BITGET_BASE_URL + path;
  let bodyStr = "";

  if (params && Object.keys(params).length > 0) {
    url += "?" + new URLSearchParams(params).toString();
  }
  if (bodyObj) {
    bodyStr = JSON.stringify(bodyObj);
  }

  const requestPath = path + (params && Object.keys(params).length > 0
    ? "?" + new URLSearchParams(params).toString()
    : "");

  const signature = sign(timestamp, method, requestPath, bodyStr);

  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": BITGET_API_KEY,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
    "locale": "en-US",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(15000),
  });

  const json = await res.json().catch(() => null);
  return json;
}

// ── Market Data ───────────────────────────────────────────────────────────────

async function getCandles(symbol, granularity, limit) {
  // BitGet v2 spot candles
  const data = await bitgetRequest("GET", "/api/v2/spot/market/candles", {
    symbol,
    granularity: granularity || "5min",
    limit: String(limit || 50),
  });
  if (!data || data.code !== "00000") {
    console.error("[BitGet] candles error:", data && data.msg);
    return [];
  }
  // Each candle: [ts, open, high, low, close, baseVol, quoteVol]
  return (data.data || []).map((c) => ({
    ts:     toNum(c[0]),
    open:   toNum(c[1]),
    high:   toNum(c[2]),
    low:    toNum(c[3]),
    close:  toNum(c[4]),
    volume: toNum(c[5]),
  }));
}

async function getTicker(symbol) {
  const data = await bitgetRequest("GET", "/api/v2/spot/market/tickers", { symbol });
  if (!data || data.code !== "00000") {
    console.error("[BitGet] ticker error:", data && data.msg);
    return null;
  }
  const t = (data.data || [])[0];
  return t ? { last: toNum(t.lastPr), bid: toNum(t.bidPr), ask: toNum(t.askPr) } : null;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── Polymarket Signals ────────────────────────────────────────────────────────

async function fetchPolymarketSignals() {
  try {
    const res = await fetch(POLYMARKET_URL, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[Polymarket] HTTP error:", res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error("[Polymarket] fetch error:", e.message);
    return null;
  }
}

// ── Order Execution ───────────────────────────────────────────────────────────

async function placeOrder(side, size, price) {
  if (!LIVE_TRADING) {
    console.log(`[Paper] ${side.toUpperCase()} ${size} ${TRADE_SYMBOL} @ ~${price}`);
    return { paper: true, side, size, price };
  }

  if (!BITGET_API_KEY || !BITGET_SECRET_KEY || !BITGET_PASSPHRASE) {
    console.error("[BitGet] API credentials missing — cannot place live order");
    return null;
  }

  const body = {
    symbol: TRADE_SYMBOL,
    side: side.toLowerCase(),   // "buy" | "sell"
    orderType: "market",
    force: "gtc",
    size: String(size),
  };

  const data = await bitgetRequest("POST", "/api/v2/spot/trade/place-order", null, body);
  if (!data || data.code !== "00000") {
    console.error("[BitGet] order error:", data && data.msg);
    return null;
  }
  console.log(`[BitGet] Order placed: ${side} ${size} ${TRADE_SYMBOL}`, data.data);
  return data.data;
}

// ── Trading Logic ─────────────────────────────────────────────────────────────

let lastSignal = null;

async function runTradingCycle() {
  console.log(`\n[Bot] Cycle start: ${new Date().toISOString()}`);

  // 1. Fetch candles
  const candles = await getCandles(TRADE_SYMBOL, "5min", 50);
  if (candles.length < 20) {
    console.error("[Bot] Not enough candle data");
    return;
  }

  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];

  // 2. Compute indicators
  const ema8  = calcEMA(closes, 8);
  const rsi3  = calcRSI(closes, 3);
  const vwap  = calcVWAP(candles);

  console.log(`[Bot] ${TRADE_SYMBOL} price=${price} EMA8=${ema8 && ema8.toFixed(2)} RSI3=${rsi3 && rsi3.toFixed(1)} VWAP=${vwap && vwap.toFixed(2)}`);

  // 3. Fetch Polymarket bias
  const poly = await fetchPolymarketSignals();
  const polyBias = poly ? poly.bias : "neutral";
  console.log(`[Bot] Polymarket bias: ${polyBias}`);

  // 4. Signal logic
  //    BUY:  price > EMA8, RSI3 < 70, price > VWAP, poly not bearish
  //    SELL: price < EMA8, RSI3 > 30, price < VWAP, poly not bullish
  let signal = "hold";

  if (ema8 !== null && rsi3 !== null && vwap !== null) {
    if (price > ema8 && rsi3 < 70 && price > vwap && polyBias !== "bearish") {
      signal = "buy";
    } else if (price < ema8 && rsi3 > 30 && price < vwap && polyBias !== "bullish") {
      signal = "sell";
    }
  }

  console.log(`[Bot] Signal: ${signal.toUpperCase()} (last: ${lastSignal || "none"})`);

  // 5. Execute only on signal change to avoid spam
  if (signal !== "hold" && signal !== lastSignal) {
    const result = await placeOrder(signal, TRADE_SIZE, price);
    lastSignal = signal;

    const mode = LIVE_TRADING ? "🔴 LIVE" : "📄 Paper";
    const emoji = signal === "buy" ? "🟢" : "🔴";
    await sendTelegram(
      `${emoji} <b>BitGet Trade Signal</b> [${mode}]\n\n` +
      `Pair: <b>${TRADE_SYMBOL}</b>\n` +
      `Side: <b>${signal.toUpperCase()}</b>\n` +
      `Price: ${price}\n` +
      `Size: ${TRADE_SIZE}\n` +
      `EMA8: ${ema8 && ema8.toFixed(2)}\n` +
      `RSI3: ${rsi3 && rsi3.toFixed(1)}\n` +
      `VWAP: ${vwap && vwap.toFixed(2)}\n` +
      `Poly Bias: ${polyBias}\n` +
      (result && result.paper ? "⚠️ Paper trade (not executed)" : "✅ Order submitted")
    );
  } else if (signal === "hold") {
    lastSignal = null;
  }
}

// ── HTTP Health Server ────────────────────────────────────────────────────────

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", symbol: TRADE_SYMBOL, live: LIVE_TRADING }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`[Health] HTTP server listening on port ${PORT}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  BitGet Trading Bot — Node.js");
  console.log(`  Symbol:  ${TRADE_SYMBOL}`);
  console.log(`  Size:    ${TRADE_SIZE}`);
  console.log(`  Mode:    ${LIVE_TRADING ? "LIVE 🔴" : "Paper 📄"}`);
  console.log(`  Poly:    ${POLYMARKET_URL}`);
  console.log("═══════════════════════════════════════════════");

  startHealthServer();

  await sendTelegram(
    `🤖 <b>BitGet Trading Bot started</b>\n` +
    `Symbol: ${TRADE_SYMBOL} | Mode: ${LIVE_TRADING ? "LIVE 🔴" : "Paper 📄"}`
  );

  // Run immediately, then every 5 minutes
  while (true) {
    try {
      await runTradingCycle();
    } catch (e) {
      console.error("[Bot] Cycle error:", e.message);
      await sendTelegram(`❌ <b>Bot Error:</b>\n${String(e.message).slice(0, 200)}`);
    }
    console.log("[Bot] Sleeping 5 minutes...\n");
    await sleep(5 * 60 * 1000);
  }
}

main();
