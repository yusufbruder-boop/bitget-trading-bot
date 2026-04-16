import http from "http";
import crypto from "crypto";

// ── Configuration ─────────────────────────────────────────────────────────────

const BITGET_API_KEY      = process.env.BITGET_API_KEY      ?? "";
const BITGET_SECRET_KEY   = process.env.BITGET_SECRET_KEY   ?? "";
const BITGET_PASSPHRASE   = process.env.BITGET_PASSPHRASE   ?? "";
const TRADE_SYMBOL        = process.env.TRADE_SYMBOL        ?? "BTCUSDT";
const TRADE_SIZE          = parseFloat(process.env.TRADE_SIZE ?? "0.001");
const LIVE_TRADING        = process.env.LIVE_TRADING        === "true";
const POLYMARKET_URL      = process.env.POLYMARKET_INTERNAL_URL ?? "http://polymarket-insider-bot.railway.internal";
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  ?? "";
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID    ?? "";
const PORT                = parseInt(process.env.PORT        ?? "3000", 10);
const LOOP_INTERVAL_MS    = 5 * 60 * 1000; // 5 minutes

// ── State ─────────────────────────────────────────────────────────────────────

let cycleCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram env missing — skipping alert");
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
    if (!res.ok || data?.ok === false) {
      console.error("Telegram failed:", res.status, data?.description);
    }
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ── BitGet API v2 signing ─────────────────────────────────────────────────────

function sign(timestamp, method, requestPath, body) {
  const prehash = timestamp + method.toUpperCase() + requestPath + (body ?? "");
  return crypto
    .createHmac("sha256", BITGET_SECRET_KEY)
    .update(prehash)
    .digest("base64");
}

async function bitgetRequest(method, path, params, bodyObj) {
  const timestamp = Date.now().toString();
  let url = `https://api.bitget.com${path}`;

  let queryString = "";
  if (params && Object.keys(params).length > 0) {
    queryString = new URLSearchParams(params).toString();
    url += "?" + queryString;
  }

  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  const requestPath = path + (queryString ? "?" + queryString : "");
  const signature = sign(timestamp, method, requestPath, bodyStr);

  const headers = {
    "ACCESS-KEY":        BITGET_API_KEY,
    "ACCESS-SIGN":       signature,
    "ACCESS-TIMESTAMP":  timestamp,
    "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
    "Content-Type":      "application/json",
    "locale":            "en-US",
  };

  const options = { method, headers, signal: AbortSignal.timeout(10000) };
  if (bodyStr) options.body = bodyStr;

  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.code && json.code !== "00000")) {
    throw new Error(`BitGet ${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Candle fetch ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, granularity, limit) {
  // BitGet v2 spot candles
  const data = await bitgetRequest("GET", "/api/v2/spot/market/candles", {
    symbol,
    granularity: granularity ?? "5m",
    limit: String(limit ?? 50),
  });
  // data.data is array of [ts, open, high, low, close, vol, quoteVol]
  return (data?.data ?? []).map((c) => ({
    ts:     toNum(c[0]),
    open:   toNum(c[1]),
    high:   toNum(c[2]),
    low:    toNum(c[3]),
    close:  toNum(c[4]),
    volume: toNum(c[5]),
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

// ── Polymarket insider signals ────────────────────────────────────────────────

async function fetchPolymarketBias() {
  try {
    const res = await fetch(`${POLYMARKET_URL}/signals`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn("Polymarket signals fetch failed:", res.status);
      return "neutral";
    }
    const json = await res.json().catch(() => null);
    return json?.bias ?? "neutral";
  } catch (e) {
    console.warn("Polymarket unreachable:", e.message);
    return "neutral";
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

async function placeOrder(side, size, symbol) {
  if (!LIVE_TRADING) {
    console.log(`[PAPER] ${side.toUpperCase()} ${size} ${symbol}`);
    return { paper: true, side, size, symbol };
  }
  const body = {
    symbol,
    side,          // "buy" | "sell"
    orderType: "market",
    force:     "gtc",
    size:      String(size),
  };
  return bitgetRequest("POST", "/api/v2/spot/trade/place-order", null, body);
}

// ── Trading cycle ─────────────────────────────────────────────────────────────

async function tradingCycle() {
  cycleCount++;
  console.log(`\n── Cycle #${cycleCount} ── ${new Date().toISOString()} ──`);

  // 1. Fetch candles
  let candles;
  try {
    candles = await fetchCandles(TRADE_SYMBOL, "5m", 50);
  } catch (e) {
    console.error("Candle fetch error:", e.message);
    await sendTelegram(`❌ <b>BitGet Bot Error</b>\nCandle fetch failed: ${e.message.slice(0, 200)}`);
    return;
  }

  if (!candles || candles.length < 20) {
    console.warn("Not enough candles:", candles?.length);
    return;
  }

  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];

  // 2. Compute indicators
  const ema8  = calcEMA(closes, 8);
  const rsi3  = calcRSI(closes, 3);
  const vwap  = calcVWAP(candles);

  console.log(
    `${TRADE_SYMBOL} | Close: ${lastClose} | EMA8: ${ema8?.toFixed(2)} | RSI3: ${rsi3?.toFixed(2)} | VWAP: ${vwap?.toFixed(2)}`
  );

  if (ema8 === null || rsi3 === null || vwap === null) {
    console.warn("Indicators not ready yet");
    return;
  }

  // 3. Fetch Polymarket bias
  const polyBias = await fetchPolymarketBias();
  console.log(`Polymarket bias: ${polyBias}`);

  // 4. Signal logic
  const bullish =
    lastClose > ema8 &&
    rsi3 > 50 &&
    lastClose > vwap &&
    polyBias !== "bearish";

  const bearish =
    lastClose < ema8 &&
    rsi3 < 50 &&
    lastClose < vwap &&
    polyBias !== "bullish";

  if (!bullish && !bearish) {
    console.log("No signal — holding");
    return;
  }

  const side = bullish ? "buy" : "sell";
  const emoji = bullish ? "🟢" : "🔴";
  const label = bullish ? "LONG" : "SHORT";

  console.log(`${emoji} Signal: ${label} | Placing ${side} order for ${TRADE_SIZE} ${TRADE_SYMBOL}`);

  // 5. Place order
  let orderResult;
  try {
    orderResult = await placeOrder(side, TRADE_SIZE, TRADE_SYMBOL);
  } catch (e) {
    console.error("Order error:", e.message);
    await sendTelegram(
      `❌ <b>Order Failed</b>\n${label} ${TRADE_SYMBOL}\nError: ${e.message.slice(0, 200)}`
    );
    return;
  }

  // 6. Telegram alert
  const mode = LIVE_TRADING ? "LIVE" : "PAPER";
  await sendTelegram(
    `${emoji} <b>${label} Signal — ${mode}</b>\n\n` +
    `Symbol: <b>${TRADE_SYMBOL}</b>\n` +
    `Size: ${TRADE_SIZE}\n` +
    `Price: ${lastClose}\n` +
    `EMA8: ${ema8.toFixed(2)}\n` +
    `RSI3: ${rsi3.toFixed(2)}\n` +
    `VWAP: ${vwap.toFixed(2)}\n` +
    `Polymarket: ${polyBias}\n` +
    `Cycle: #${cycleCount}`
  );

  console.log("Order placed:", JSON.stringify(orderResult));
}

// ── HTTP Health Server ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", cycles: cycleCount }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
});

server.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  BitGet Trading Bot — Node.js");
  console.log(`  Symbol:  ${TRADE_SYMBOL}`);
  console.log(`  Size:    ${TRADE_SIZE}`);
  console.log(`  Mode:    ${LIVE_TRADING ? "LIVE" : "PAPER"}`);
  console.log(`  Interval: 5 min`);
  console.log("═══════════════════════════════════════════");

  await sendTelegram(
    `🤖 <b>BitGet Trading Bot started</b>\n` +
    `Symbol: ${TRADE_SYMBOL} | Size: ${TRADE_SIZE}\n` +
    `Mode: ${LIVE_TRADING ? "🔴 LIVE" : "📄 PAPER"}`
  );

  while (true) {
    try {
      await tradingCycle();
    } catch (e) {
      console.error("Cycle error:", e);
      await sendTelegram(`❌ <b>Bot Cycle Error</b>\n${String(e).slice(0, 200)}`);
    }
    console.log(`⏳ Next cycle in 5 minutes…\n`);
    await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
  }
}

main();
