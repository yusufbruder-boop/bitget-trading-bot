"use strict";

// ── Dependencies ──────────────────────────────────────────────────────────────
import dotenv from "dotenv";
import http from "http";
import crypto from "crypto";

dotenv.config();

// ── Environment ───────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN          = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID            = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID || "";
const LOOP_INTERVAL_MINUTES       = parseInt(process.env.LOOP_INTERVAL_MINUTES || "5", 10);
const MAX_MARKETS                 = parseInt(process.env.MAX_MARKETS || "50", 10);
const SEND_SCAN_COMPLETE_EVERY_N  = parseInt(process.env.SEND_SCAN_COMPLETE_EVERY_N_SCANS || "1", 10);

// BitGet API credentials
const BITGET_API_KEY    = process.env.BITGET_API_KEY    || "";
const BITGET_SECRET_KEY = process.env.BITGET_SECRET_KEY || "";
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE || "";
const BITGET_BASE_URL   = "https://api.bitget.com";

// Trading config
const TRADE_SYMBOL      = process.env.TRADE_SYMBOL      || "BTCUSDT";
const TRADE_SIZE        = process.env.TRADE_SIZE        || "0.001";
const LIVE_TRADING      = process.env.LIVE_TRADING      === "true";

// Polymarket insider bot (internal Railway service)
const POLYMARKET_INTERNAL_URL = process.env.POLYMARKET_INTERNAL_URL
  || "http://polymarket-insider-bot.railway.internal";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── BitGet API signing ────────────────────────────────────────────────────────

function bitgetSign(timestamp, method, requestPath, body) {
  const message = timestamp + method.toUpperCase() + requestPath + (body || "");
  return crypto.createHmac("sha256", BITGET_SECRET_KEY).update(message).digest("base64");
}

async function bitgetRequest(method, path, params, body) {
  const timestamp = Date.now().toString();
  let url = BITGET_BASE_URL + path;

  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    url += "?" + qs;
  }

  const bodyStr = body ? JSON.stringify(body) : "";
  const requestPath = path + (params && Object.keys(params).length > 0
    ? "?" + new URLSearchParams(params).toString()
    : "");

  const sign = bitgetSign(timestamp, method, requestPath, bodyStr);

  const headers = {
    "Content-Type":       "application/json",
    "ACCESS-KEY":         BITGET_API_KEY,
    "ACCESS-SIGN":        sign,
    "ACCESS-TIMESTAMP":   timestamp,
    "ACCESS-PASSPHRASE":  BITGET_PASSPHRASE,
    "locale":             "en-US",
  };

  const options = { method, headers };
  if (bodyStr) options.body = bodyStr;

  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  return json;
}

// ── BitGet: Candle data ───────────────────────────────────────────────────────

async function getCandles(symbol, granularity, limit) {
  // granularity: "5m", "15m", etc.
  const gran = granularity || "5m";
  const lim  = (limit || 100).toString();

  const data = await bitgetRequest("GET", "/api/v2/mix/market/candles", {
    symbol:      symbol,
    productType: "USDT-FUTURES",
    granularity: gran,
    limit:       lim,
  });

  if (!data || data.code !== "00000" || !Array.isArray(data.data)) {
    console.error("Candle fetch error:", data?.msg || "unknown");
    return [];
  }

  // Each candle: [timestamp, open, high, low, close, baseVol, quoteVol]
  return data.data.map((c) => ({
    ts:     parseInt(c[0], 10),
    open:   toNum(c[1]),
    high:   toNum(c[2]),
    low:    toNum(c[3]),
    close:  toNum(c[4]),
    vol:    toNum(c[5]),
    quoteVol: toNum(c[6]),
  }));
}

// ── Technical Indicators ──────────────────────────────────────────────────────

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
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  const avgGain = gains  / period;
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
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── Signal detection ──────────────────────────────────────────────────────────

function detectSignal(candles) {
  if (candles.length < 20) return null;

  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];

  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(candles);

  if (ema8 === null || rsi3 === null || vwap === null) return null;

  const aboveEMA  = price > ema8;
  const aboveVWAP = price > vwap;
  const belowEMA  = price < ema8;
  const belowVWAP = price < vwap;

  let signal = null;

  // Long: price above EMA(8) AND above VWAP AND RSI(3) < 30 (oversold pullback)
  if (aboveEMA && aboveVWAP && rsi3 < 30) {
    signal = "LONG";
  }
  // Short: price below EMA(8) AND below VWAP AND RSI(3) > 70 (overbought pullback)
  else if (belowEMA && belowVWAP && rsi3 > 70) {
    signal = "SHORT";
  }

  return { signal, price, ema8, rsi3, vwap };
}

// ── Polymarket insider signals ────────────────────────────────────────────────

async function fetchPolymarketSignals() {
  try {
    const url = `${POLYMARKET_INTERNAL_URL}/signals`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`Polymarket internal: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json().catch(() => null);
    return json;
  } catch (e) {
    console.warn("Polymarket internal fetch failed:", e.message || e);
    return null;
  }
}

// ── BitGet: Place order ───────────────────────────────────────────────────────

async function placeOrder(symbol, side, size) {
  // side: "buy" (long) or "sell" (short)
  const body = {
    symbol:      symbol,
    productType: "USDT-FUTURES",
    marginMode:  "crossed",
    marginCoin:  "USDT",
    size:        size,
    side:        side,
    orderType:   "market",
    tradeSide:   side === "buy" ? "open" : "open",
  };

  const data = await bitgetRequest("POST", "/api/v2/mix/order/place-order", null, body);
  return data;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram env missing — skipping notification");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          chat_id:                  TELEGRAM_CHAT_ID,
          text:                     message,
          parse_mode:               "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      console.error("Telegram failed:", { status: res.status, desc: data?.description });
    }
  } catch (e) {
    console.error("Telegram error:", e.message || e);
  }
}

// ── Main trading loop ─────────────────────────────────────────────────────────

let scanCounter = 0;

async function runTradingCycle() {
  scanCounter++;
  const now = new Date().toISOString();
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Cycle #${scanCounter} — ${now}`);
  console.log(`${"═".repeat(50)}`);

  // 1. Fetch candle data from BitGet
  const candles = await getCandles(TRADE_SYMBOL, "5m", 100);
  if (!candles.length) {
    console.error("No candle data — skipping cycle");
    return;
  }

  const latest = candles[candles.length - 1];
  console.log(`📈 ${TRADE_SYMBOL} | Price: ${latest.close} | Candles: ${candles.length}`);

  // 2. Compute technical signal
  const tech = detectSignal(candles);
  if (!tech) {
    console.log("⚠️  Not enough data for indicators");
    return;
  }

  console.log(
    `📊 EMA(8): ${tech.ema8.toFixed(2)} | RSI(3): ${tech.rsi3.toFixed(1)} | VWAP: ${tech.vwap.toFixed(2)}`
  );
  console.log(`🔎 Signal: ${tech.signal || "NONE"}`);

  // 3. Fetch Polymarket insider bias
  const polySignals = await fetchPolymarketSignals();
  const polyBias    = polySignals?.bias || "neutral";
  console.log(`🎯 Polymarket bias: ${polyBias.toUpperCase()}`);

  // 4. Decide whether to trade
  if (!tech.signal) {
    console.log("⏸  No technical signal — holding");
    return;
  }

  // Optionally filter by Polymarket bias alignment
  const biasAligned =
    (tech.signal === "LONG"  && polyBias === "bullish") ||
    (tech.signal === "SHORT" && polyBias === "bearish") ||
    polyBias === "neutral";

  if (!biasAligned) {
    console.log(`⛔ Signal ${tech.signal} conflicts with Polymarket bias (${polyBias}) — skipping`);
    await sendTelegram(
      `⛔ <b>Signal Skipped</b>\n` +
      `Symbol: <b>${TRADE_SYMBOL}</b>\n` +
      `Tech signal: <b>${tech.signal}</b>\n` +
      `Polymarket bias: <b>${polyBias.toUpperCase()}</b>\n` +
      `Price: ${tech.price} | EMA8: ${tech.ema8.toFixed(2)} | RSI3: ${tech.rsi3.toFixed(1)}`
    );
    return;
  }

  // 5. Execute trade
  const side = tech.signal === "LONG" ? "buy" : "sell";
  console.log(`🚀 ${LIVE_TRADING ? "LIVE" : "PAPER"} trade: ${tech.signal} ${TRADE_SYMBOL} size=${TRADE_SIZE}`);

  let orderResult = null;
  if (LIVE_TRADING) {
    orderResult = await placeOrder(TRADE_SYMBOL, side, TRADE_SIZE);
    console.log("Order result:", JSON.stringify(orderResult));
  } else {
    console.log("📝 Paper trade — LIVE_TRADING=false, no order sent");
  }

  // 6. Send Telegram alert
  const modeTag  = LIVE_TRADING ? "🟢 LIVE" : "📝 PAPER";
  const sideEmoji = tech.signal === "LONG" ? "📈" : "📉";
  const orderInfo = orderResult
    ? (orderResult.code === "00000"
        ? `✅ Order ID: ${orderResult.data?.orderId || "n/a"}`
        : `❌ Error: ${orderResult.msg || "unknown"}`)
    : "(paper — no order)";

  await sendTelegram(
    `${sideEmoji} <b>${tech.signal} Signal — ${TRADE_SYMBOL}</b> ${modeTag}\n\n` +
    `💰 Price: <b>${tech.price}</b>\n` +
    `📊 EMA(8): ${tech.ema8.toFixed(2)}\n` +
    `📉 RSI(3): ${tech.rsi3.toFixed(1)}\n` +
    `📏 VWAP:   ${tech.vwap.toFixed(2)}\n` +
    `🎯 Polymarket: ${polyBias.toUpperCase()}\n` +
    `📦 Size: ${TRADE_SIZE}\n\n` +
    `${orderInfo}`
  );
}

// ── HTTP health server ────────────────────────────────────────────────────────

function startHealthServer() {
  const port = parseInt(process.env.PORT || "3000", 10);
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", cycle: scanCounter, symbol: TRADE_SYMBOL }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(port, () => console.log(`🌐 Health server listening on port ${port}`));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  BitGet Trading Bot — Node.js");
  console.log(`  Symbol:   ${TRADE_SYMBOL}`);
  console.log(`  Size:     ${TRADE_SIZE}`);
  console.log(`  Interval: ${LOOP_INTERVAL_MINUTES} min`);
  console.log(`  Mode:     ${LIVE_TRADING ? "🟢 LIVE TRADING" : "📝 PAPER TRADING"}`);
  console.log(`  Polymarket: ${POLYMARKET_INTERNAL_URL}`);
  console.log("═══════════════════════════════════════════════════");

  if (!BITGET_API_KEY || !BITGET_SECRET_KEY || !BITGET_PASSPHRASE) {
    console.warn("⚠️  BitGet API credentials not set — live trading disabled");
  }

  startHealthServer();

  await sendTelegram(
    `🤖 <b>BitGet Trading Bot gestartet</b>\n` +
    `Symbol: <b>${TRADE_SYMBOL}</b>\n` +
    `Mode: <b>${LIVE_TRADING ? "🟢 LIVE" : "📝 PAPER"}</b>\n` +
    `Interval: ${LOOP_INTERVAL_MINUTES} min\n` +
    `Polymarket: ${POLYMARKET_INTERNAL_URL}`
  );

  // Run immediately, then on interval
  while (true) {
    try {
      await runTradingCycle();
    } catch (e) {
      console.error("Cycle error:", e);
      await sendTelegram(`❌ <b>Bot Error:</b>\n${String(e).slice(0, 200)}`);
    }
    console.log(`\n⏳ Next cycle in ${LOOP_INTERVAL_MINUTES} min...\n`);
    await sleep(LOOP_INTERVAL_MINUTES * 60 * 1000);
  }
}

main();
