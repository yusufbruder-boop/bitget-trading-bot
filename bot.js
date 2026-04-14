/**
 * BitGet Trading Bot
 *
 * Strategy : EMA(8) + RSI(3) + VWAP
 * LONG     : price > VWAP AND price > EMA(8) AND RSI(3) > 50
 * SHORT    : price < VWAP AND price < EMA(8) AND RSI(3) < 50
 *
 * Risk     : 1% TP | 0.5% SL | 5× leverage | max 5 trades/day
 * Schedule : Driven by Railway cron (*/5 * * * *) — no setInterval
 */

import { createHmac } from "crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  symbols:        ["BTCUSDT", "ETHUSDT", "XAGUSDT", "NATGASUSDT"],
  timeframe:      "5m",
  leverage:       parseInt(process.env.LEVERAGE        || "5"),
  tpPercent:      parseFloat(process.env.TP_PERCENT    || "1.0"),
  slPercent:      parseFloat(process.env.SL_PERCENT    || "0.5"),
  maxTradesPerDay:parseInt(process.env.MAX_TRADES_PER_DAY || "5"),
  marginUSD:      parseFloat(process.env.MARGIN_USD    || "20"),
  paperTrading:   process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    "https://api.bitget.com",
  },
};

const LOG_FILE = "trades-log.json";
const CSV_FILE = "trades.csv";
const CSV_HEAD = "Date,Time,Symbol,Direction,Price,MarginUSD,NotionalUSD,TP,SL,OrderID,Mode\n";

// ─── Logging helpers ──────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(LOG_FILE, "utf8")); }
  catch { return { trades: [] }; }
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function todayTradeCount(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEAD);
}

function writeCsv(entry) {
  const d = new Date(entry.timestamp);
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    entry.symbol,
    entry.direction || "BLOCKED",
    entry.price     != null ? entry.price.toFixed(4)    : "",
    entry.marginUSD != null ? entry.marginUSD.toFixed(2) : "",
    entry.notional  != null ? entry.notional.toFixed(2)  : "",
    entry.tpPrice   || "",
    entry.slPrice   || "",
    entry.orderId   || "",
    entry.paperTrading ? "PAPER" : (entry.orderPlaced ? "LIVE" : "BLOCKED"),
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains  += delta;
    else           losses -= delta;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgGain === 0 && avgLoss === 0) return 50; // flat candles → neutral
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function vwap(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (!session.length) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// ─── Market data ──────────────────────────────────────────────────────────────

const CRYPTO_PREFIXES = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOGE", "AVAX", "LINK"];

function isCrypto(symbol) {
  return CRYPTO_PREFIXES.some(p => symbol.startsWith(p));
}

async function fetchCandles(symbol, limit = 200) {
  if (isCrypto(symbol)) {
    // Binance spot klines for crypto (public, no auth needed)
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data = await res.json();
    return data.map(k => ({
      time:   +k[0],
      open:   +k[1],
      high:   +k[2],
      low:    +k[3],
      close:  +k[4],
      volume: +k[5],
    }));
  } else {
    // BitGet futures candles for commodities / non-crypto
    const url = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=5m&limit=${limit}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json.code !== "00000") throw new Error(`BitGet candles: ${json.msg}`);
    return json.data
      .map(k => ({
        time:   +k[0],
        open:   +k[1],
        high:   +k[2],
        low:    +k[3],
        close:  +k[4],
        volume: +k[5],
      }))
      .reverse();
  }
}

// ─── Signal logic ─────────────────────────────────────────────────────────────

function getSignal(price, ema8, vwapVal, rsi3) {
  const aboveBoth = price > vwapVal && price > ema8;
  const belowBoth = price < vwapVal && price < ema8;

  console.log(`  ├─ Price  : $${price.toFixed(4)}`);
  console.log(`  ├─ EMA(8) : $${ema8.toFixed(4)}  → price ${price > ema8 ? ">" : "<"} EMA`);
  console.log(`  ├─ VWAP   : $${vwapVal.toFixed(4)}  → price ${price > vwapVal ? ">" : "<"} VWAP`);
  console.log(`  └─ RSI(3) : ${rsi3.toFixed(2)}  → ${rsi3 > 50 ? "bullish" : "bearish"}`);

  if (aboveBoth && rsi3 > 50) {
    console.log("  ✅ Signal: LONG  (price > VWAP, price > EMA8, RSI > 50)");
    return "long";
  }
  if (belowBoth && rsi3 < 50) {
    console.log("  ✅ Signal: SHORT (price < VWAP, price < EMA8, RSI < 50)");
    return "short";
  }

  console.log("  ⬜ Signal: NONE  (conditions not met)");
  return null;
}

// ─── BitGet API ───────────────────────────────────────────────────────────────

function buildSignature(timestamp, method, path, body = "") {
  return createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest("base64");
}

async function bitgetRequest(method, path, body = null) {
  const ts  = Date.now().toString();
  const b   = body ? JSON.stringify(body) : "";
  const sig = buildSignature(ts, method, path, b);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type":      "application/json",
      "ACCESS-KEY":        CONFIG.bitget.apiKey,
      "ACCESS-SIGN":       sig,
      "ACCESS-TIMESTAMP":  ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body: b || undefined,
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function getOpenPosition(symbol) {
  try {
    const res = await bitgetRequest(
      "GET",
      `/api/v2/mix/position/single-position?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`
    );
    if (res.code !== "00000") return null;
    return res.data?.find(p => parseFloat(p.total || 0) > 0) || null;
  } catch (e) {
    console.log(`  ⚠️  Position check error: ${e.message}`);
    return null;
  }
}

async function setLeverage(symbol, leverage) {
  for (const holdSide of ["long", "short"]) {
    await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {
      symbol,
      productType: "USDT-FUTURES",
      marginCoin:  "USDT",
      leverage:    String(leverage),
      holdSide,
    });
  }
}

async function placeOrder(symbol, direction, marginUSD, price) {
  const side    = direction === "long" ? "buy" : "sell";
  const rawSize = (marginUSD * CONFIG.leverage) / price;
  const size    = Math.max(rawSize, 0.001).toFixed(4);

  const tpPrice = direction === "long"
    ? (price * (1 + CONFIG.tpPercent / 100)).toFixed(4)
    : (price * (1 - CONFIG.tpPercent / 100)).toFixed(4);

  const slPrice = direction === "long"
    ? (price * (1 - CONFIG.slPercent / 100)).toFixed(4)
    : (price * (1 + CONFIG.slPercent / 100)).toFixed(4);

  const res = await bitgetRequest("POST", "/api/v2/mix/order/place-order", {
    symbol,
    productType:            "USDT-FUTURES",
    marginMode:             "isolated",
    marginCoin:             "USDT",
    size,
    side,
    tradeSide:              "open",
    orderType:              "market",
    presetStopSurplusPrice: tpPrice,
    presetStopLossPrice:    slPrice,
  });

  if (res.code !== "00000") throw new Error(`${res.msg} (${res.code})`);
  return { orderId: res.data.orderId, tpPrice, slPrice, size };
}

// ─── Per-symbol trade logic ───────────────────────────────────────────────────

async function tradeSymbol(symbol, log) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${symbol}`);
  console.log("═".repeat(60));

  // 1. Skip if position already open
  const existing = await getOpenPosition(symbol);
  if (existing) {
    console.log(`  ⏭️  Open position exists (${existing.holdSide}, ${existing.total} contracts) — skipping`);
    return;
  }

  // 2. Fetch candles
  let candles;
  try {
    candles = await fetchCandles(symbol);
  } catch (e) {
    console.log(`  ❌ Failed to fetch candles: ${e.message}`);
    return;
  }

  // 3. Compute indicators
  const closes  = candles.map(c => c.close);
  const price   = closes.at(-1);
  const ema8    = ema(closes, 8);
  const vwapVal = vwap(candles);
  const rsi3    = rsi(closes, 3);

  if (ema8 === null || vwapVal === null || rsi3 === null) {
    console.log("  ⚠️  Insufficient data for indicators");
    return;
  }

  // 4. Evaluate signal
  console.log("\n  ── Indicators ──────────────────────────────────────────");
  const direction = getSignal(price, ema8, vwapVal, rsi3);

  if (!direction) return;

  // 5. Size & risk summary
  const notional = CONFIG.marginUSD * CONFIG.leverage;
  const tpUSD    = notional * (CONFIG.tpPercent / 100);
  const slUSD    = notional * (CONFIG.slPercent / 100);

  console.log("\n  ── Order ───────────────────────────────────────────────");
  console.log(`  ${direction.toUpperCase()} ${symbol}`);
  console.log(`  Margin $${CONFIG.marginUSD} × ${CONFIG.leverage}x = $${notional} notional`);
  console.log(`  TP +${CONFIG.tpPercent}% = +$${tpUSD.toFixed(2)} | SL -${CONFIG.slPercent}% = -$${slUSD.toFixed(2)}`);

  const logEntry = {
    timestamp:   new Date().toISOString(),
    symbol,
    direction,
    price,
    marginUSD:   CONFIG.marginUSD,
    notional,
    paperTrading: CONFIG.paperTrading,
    orderPlaced: false,
    orderId:     null,
    tpPrice:     null,
    slPrice:     null,
  };

  if (CONFIG.paperTrading) {
    const tp = direction === "long"
      ? (price * (1 + CONFIG.tpPercent / 100)).toFixed(4)
      : (price * (1 - CONFIG.tpPercent / 100)).toFixed(4);
    const sl = direction === "long"
      ? (price * (1 - CONFIG.slPercent / 100)).toFixed(4)
      : (price * (1 + CONFIG.slPercent / 100)).toFixed(4);

    logEntry.orderId    = `PAPER-${Date.now()}`;
    logEntry.tpPrice    = tp;
    logEntry.slPrice    = sl;
    logEntry.orderPlaced = true;

    console.log(`  📋 PAPER TRADE — ${direction.toUpperCase()} @ $${price.toFixed(4)}`);
    console.log(`     TP $${tp} | SL $${sl}`);
  } else {
    try {
      await setLeverage(symbol, CONFIG.leverage);
      const order = await placeOrder(symbol, direction, CONFIG.marginUSD, price);

      logEntry.orderPlaced = true;
      logEntry.orderId     = order.orderId;
      logEntry.tpPrice     = order.tpPrice;
      logEntry.slPrice     = order.slPrice;

      console.log(`  ✅ ORDER PLACED  #${order.orderId}`);
      console.log(`     ${direction.toUpperCase()} @ $${price.toFixed(4)} | TP $${order.tpPrice} | SL $${order.slPrice}`);
      console.log(`     Size: ${order.size} contracts | Notional: $${notional}`);
    } catch (err) {
      console.log(`  ❌ ORDER FAILED: ${err.message}`);
      logEntry.error = err.message;
    }
  }

  log.trades.push(logEntry);
  writeCsv(logEntry);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();
  const log = loadLog();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║              BitGet Trading Bot — 5m Scan               ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Time     : ${new Date().toISOString().padEnd(44)}║`);
  console.log(`║  Mode     : ${(CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE").padEnd(44)}║`);
  console.log(`║  Leverage : ${String(CONFIG.leverage + "x").padEnd(44)}║`);
  console.log(`║  TP / SL  : ${String(CONFIG.tpPercent + "% / " + CONFIG.slPercent + "%").padEnd(44)}║`);
  console.log(`║  Symbols  : ${CONFIG.symbols.join(", ").padEnd(44)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  // Validate credentials (live mode only)
  if (!CONFIG.paperTrading) {
    if (!CONFIG.bitget.apiKey || !CONFIG.bitget.secretKey || !CONFIG.bitget.passphrase) {
      console.error("❌ Missing BitGet credentials. Set BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE.");
      process.exit(1);
    }
  }

  const traded = todayTradeCount(log);
  console.log(`\n  Trades today : ${traded} / ${CONFIG.maxTradesPerDay}`);

  if (traded >= CONFIG.maxTradesPerDay) {
    console.log("  🛑 Daily trade limit reached — exiting.");
    return;
  }

  for (const symbol of CONFIG.symbols) {
    if (todayTradeCount(log) >= CONFIG.maxTradesPerDay) {
      console.log("\n  🛑 Daily trade limit reached mid-scan — stopping.");
      break;
    }
    try {
      await tradeSymbol(symbol, log);
    } catch (e) {
      console.log(`  ❌ Unexpected error for ${symbol}: ${e.message}`);
    }
  }

  saveLog(log);
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  Scan complete                                           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

run().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
