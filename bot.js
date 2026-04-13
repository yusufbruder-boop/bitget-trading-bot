/**
 * BitGet Trading Bot — Professionelle Version
 *
 * Verbesserungen gegenüber Original:
 * - TP/SL automatisch bei jeder Order gesetzt
 * - Gebühren-Prüfung: Trade nur wenn Profit > 5× Gebühren
 * - Leverage wird vor jedem Trade gesetzt
 * - Offene Positionen werden geprüft (kein Doppeln)
 * - Aktien-Kerzen direkt von BitGet (nicht Binance)
 * - Wochentag-Strategie: Crypto am Wochenende, Aktien+Rohstoffe Mo-Fr
 * - News-Filter für Richtungsbestätigung
 *
 * BitGet Futures Taker-Gebühr: 0.06% pro Seite = 0.12% Round-Trip
 * Minimum Profit-Ziel: 5× Gebühren = 0.60% des Nominalwerts
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Konfiguration ────────────────────────────────────────────────────────────

const TAKER_FEE_RATE = 0.0006;          // 0.06% pro Seite
const MIN_PROFIT_FEE_MULTIPLIER = 5;    // Profit muss > 5× Gebühren sein

const CONFIG = {
  timeframe:       process.env.TIMEFRAME        || "1m",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD  || "253"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD   || "50"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY     || "5"),
  leverage:        parseInt(process.env.LEVERAGE               || "5"),
  tpPercent:       parseFloat(process.env.TP_PERCENT           || "1.0"),
  slPercent:       parseFloat(process.env.SL_PERCENT           || "0.5"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    "https://api.bitget.com",
  },
};

// ─── Symbole ──────────────────────────────────────────────────────────────────

const WEEKEND_CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

const WEEKDAY_STOCKS = [
  "NVDAUSDT", "TSLAUSDT", "AAPLUSDT", "MSFTUSDT", "GOOGLUSDT",
  "AMZNUSDT", "METAUSDT", "INTCUSDT", "MUUSDT",   "TSMUSDT",
  "NFLXUSDT", "COINUSDT", "MSTRUSDT", "IBMUSDT",  "ASMLUSDT",
  "ARMUSDT",  "ORCLUSDT", "WMTUSDT",  "RKLBUSDT", "MCDUSDT",
];

const WEEKDAY_COMMODITIES = [
  "XAUUSDT",    // Gold
  "XAGUSDT",    // Silber
  "NATGASUSDT", // Erdgas
  "COPPERUSDT", // Kupfer
];

const NEWS_BULLISH = ["ceasefire","peace","deal","rate cut","etf approved","stimulus","upgrade","earnings beat","ai","partnership","profit","growth","record"];
const NEWS_BEARISH = ["war","attack","invasion","tariff","ban","crash","recession","rate hike","miss","downgrade","hack","bankruptcy","fraud","loss","sanction"];

// Gold-spezifische News-Schlüsselwörter
const GOLD_NEWS_BULLISH = [
  "gold rally","safe haven","dollar falls","rate cut","fed cut","inflation rise","geopolitical",
  "war","attack","crisis","recession","dollar weak","dxy fall","stimulus","etf inflow",
  "gold demand","central bank buy","gold surge","record high","rate pause",
];
const GOLD_NEWS_BEARISH = [
  "dollar rises","dxy rise","fed hike","rate hike","real yield","risk-on","gold falls",
  "treasury yield","taper","tightening","strong dollar","gold sell","etf outflow",
  "gold drop","gold slump","profit taking","gold selloff",
];

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";

// ─── Wochentag ────────────────────────────────────────────────────────────────

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

function getActiveSymbols() {
  if (isWeekend()) {
    console.log("📅 Wochenende → Crypto (BTC, ETH, SOL)");
    return WEEKEND_CRYPTO;
  }
  console.log("📅 Wochentag → Aktien + Rohstoffe");
  return [...WEEKDAY_STOCKS, ...WEEKDAY_COMMODITIES];
}

// ─── News ─────────────────────────────────────────────────────────────────────

// ─── Liquidität & Funding ─────────────────────────────────────────────────────

async function getLiquidityBias(symbol) {
  // Nur für Crypto sinnvoll (Funding Rate + Order Book)
  const isCrypto = CRYPTO_SYMBOLS.some(s => symbol.startsWith(s));
  if (!isCrypto) return "neutral";

  try {
    // 1. Funding Rate — positiv = Longs zahlen = Short-Druck; negativ = Shorts zahlen = Long-Druck
    const frRes = await fetch(
      `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`,
      { signal: AbortSignal.timeout(5000) }
    );
    const frJson = await frRes.json();
    const fundingRate = parseFloat(frJson?.data?.[0]?.fundingRate || 0);

    // 2. Order Book Tiefe — wo sind große Kauf/Verkauf-Wände
    const obRes = await fetch(
      `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=USDT-FUTURES&limit=50`,
      { signal: AbortSignal.timeout(5000) }
    );
    const obJson = await obRes.json();
    const bids = obJson?.data?.bids || [];
    const asks = obJson?.data?.asks || [];

    // Größte Liquiditätszonen finden
    const topBid = bids.slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
    const topAsk = asks.slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
    const bidAskRatio = topBid / (topAsk || 1);

    // 3. Open Interest Richtung
    const oiRes = await fetch(
      `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`,
      { signal: AbortSignal.timeout(5000) }
    );
    const oiJson = await oiRes.json();
    const openInterest = parseFloat(oiJson?.data?.openInterestList?.[0]?.size || 0);

    console.log(`  Funding: ${(fundingRate*100).toFixed(4)}% | Bid/Ask Ratio: ${bidAskRatio.toFixed(2)} | OI: ${openInterest.toFixed(0)}`);

    // Liquiditätsjagd-Logik:
    // Funding stark positiv (>0.01%) → viele Longs → Market Maker kann Short-Squeeze auslösen → SHORT-Bias
    // Funding stark negativ (<-0.01%) → viele Shorts → Long-Squeeze wahrscheinlich → LONG-Bias
    // Bid-Wand viel größer als Ask → Käufer warten unten → Kurs wird nach unten gezogen dann Reversal LONG
    // Ask-Wand viel größer als Bid → Verkäufer warten oben → SHORT möglich

    if (fundingRate > 0.0003) {
      console.log(`  ⚠️  Funding sehr positiv → viele Longs → Short-Squeeze Risiko`);
      return "bearish"; // Market Maker jagt Long-Liquidierungen nach unten
    }
    if (fundingRate < -0.0003) {
      console.log(`  ⚠️  Funding sehr negativ → viele Shorts → Long-Squeeze möglich`);
      return "bullish"; // Market Maker jagt Short-Liquidierungen nach oben
    }
    if (bidAskRatio > 1.5) {
      console.log(`  📗 Große Bid-Wand → Unterstützung → BULLISH`);
      return "bullish";
    }
    if (bidAskRatio < 0.67) {
      console.log(`  📕 Große Ask-Wand → Widerstand → BEARISH`);
      return "bearish";
    }

    return "neutral";
  } catch {
    return "neutral";
  }
}

async function getNewsBias(symbol) {
  const name = symbol
    .replace("USDT","")
    .replace("BTC","Bitcoin").replace("ETH","Ethereum").replace("SOL","Solana")
    .replace("NVDA","Nvidia").replace("TSLA","Tesla").replace("AAPL","Apple")
    .replace("MSFT","Microsoft").replace("GOOGL","Google").replace("AMZN","Amazon")
    .replace("META","Meta").replace("XAU","Gold").replace("XAG","Silver")
    .replace("NATGAS","Natural Gas").replace("COPPER","Copper");

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
      .map(m => m[1].toLowerCase()).slice(0, 10);

    let bull = 0, bear = 0;
    for (const t of titles) {
      for (const k of NEWS_BULLISH) if (t.includes(k)) bull++;
      for (const k of NEWS_BEARISH) if (t.includes(k)) bear++;
    }
    console.log(`  News [${name}]: 🟢 ${bull}  🔴 ${bear}`);
    if (bull > bear + 1) return "bullish";
    if (bear > bull + 1) return "bearish";
    return "neutral";
  } catch {
    return "neutral";
  }
}

// ─── Gold News Sentiment ──────────────────────────────────────────────────────

async function getGoldNewsBias() {
  try {
    const url = `https://news.google.com/rss/search?q=gold+price+XAU&hl=en-US&gl=US&ceid=US:en`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const xml  = await res.text();
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
      .map(m => m[1].toLowerCase()).slice(0, 15);
    let bull = 0, bear = 0;
    for (const t of titles) {
      for (const k of GOLD_NEWS_BULLISH) if (t.includes(k)) bull++;
      for (const k of GOLD_NEWS_BEARISH) if (t.includes(k)) bear++;
    }
    console.log(`  Google News Gold: 🟢 ${bull} | 🔴 ${bear}`);
    if (bull > bear + 1) return "bullish";
    if (bear > bull + 1) return "bearish";
    return "neutral";
  } catch {
    return "neutral";
  }
}

// ─── Marktdaten ───────────────────────────────────────────────────────────────

const BINANCE_INTERVAL = { "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1H":"1h","4H":"4h","1D":"1d" };
const BITGET_GRANULARITY = { "1m":"1m","5m":"5m","15m":"15m","1H":"1H","4H":"4H","1D":"1Dutc" };

const CRYPTO_SYMBOLS = ["BTC","ETH","SOL","XRP","BNB","ADA","DOGE","AVAX","LINK"];

async function fetchCandles(symbol, limit = 200) {
  const isCrypto = CRYPTO_SYMBOLS.some(s => symbol.startsWith(s));

  if (isCrypto) {
    // Crypto: Binance kostenlos
    const interval = BINANCE_INTERVAL[CONFIG.timeframe] || "1m";
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    return data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  } else {
    // Aktien/Rohstoffe: BitGet
    const gran = BITGET_GRANULARITY[CONFIG.timeframe] || "1m";
    const url = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${gran}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json.code !== "00000") throw new Error(`BitGet Kerzen: ${json.msg}`);
    return json.data
      .map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }))
      .reverse();
  }
}

// Gold-Kerzen — immer von BitGet, verschiedene Zeitrahmen
async function fetchGoldCandles(timeframe, limit = 200) {
  const gran = BITGET_GRANULARITY[timeframe] || "1H";
  const url  = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/candles?symbol=XAUUSDT&productType=USDT-FUTURES&granularity=${gran}&limit=${limit}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const json = await res.json();
  if (json.code !== "00000") throw new Error(`BitGet Gold-Kerzen (${gran}): ${json.msg}`);
  return json.data
    .map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
    .reverse();
}

// ─── Indikatoren ──────────────────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) val = closes[i]*k + val*(1-k);
  return val;
}

function rsi(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  const avgL = l / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + (g/period) / avgL);
}

function vwap(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol = sess.reduce((s,c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
}

// ─── Erweiterte Indikatoren ───────────────────────────────────────────────────

// EMA als Array (für MACD benötigt)
function emaArray(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(val);
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// Average True Range
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) val = (val * (period - 1) + trs[i]) / period;
  return val;
}

// Bollinger Bands
function bollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + multiplier * std, middle: mean, lower: mean - multiplier * std, std };
}

// MACD (12, 26, 9)
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastArr = emaArray(closes, fast);
  const slowArr = emaArray(closes, slow);
  if (!slowArr.length || !fastArr.length) return null;
  const offset  = slow - fast;
  const macdArr = slowArr.map((s, i) => fastArr[i + offset] - s);
  const sigArr  = emaArray(macdArr, signal);
  if (!sigArr.length) return null;
  const macdVal = macdArr.at(-1);
  const sigVal  = sigArr.at(-1);
  return { macd: macdVal, signal: sigVal, histogram: macdVal - sigVal };
}

// Swing-Hochs / -Tiefs → Schlüsselniveaus
function findKeyLevels(candles) {
  const levels = [];
  const h = candles.map(c => c.high);
  const l = candles.map(c => c.low);
  for (let i = 2; i < candles.length - 2; i++) {
    if (h[i] > h[i-1] && h[i] > h[i-2] && h[i] > h[i+1] && h[i] > h[i+2])
      levels.push({ price: h[i], type: "resistance" });
    if (l[i] < l[i-1] && l[i] < l[i-2] && l[i] < l[i+1] && l[i] < l[i+2])
      levels.push({ price: l[i], type: "support" });
  }
  // Cluster ähnliche Niveaus (innerhalb 0.2%)
  const used = new Set();
  const clustered = [];
  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    const group = [levels[i]];
    for (let j = i + 1; j < levels.length; j++) {
      if (!used.has(j) && Math.abs(levels[j].price - levels[i].price) / levels[i].price < 0.002) {
        group.push(levels[j]); used.add(j);
      }
    }
    used.add(i);
    const avg  = group.reduce((s, x) => s + x.price, 0) / group.length;
    const type = group.filter(x => x.type === "support").length > group.length / 2 ? "support" : "resistance";
    clustered.push({ price: avg, type, strength: group.length });
  }
  return clustered.sort((a, b) => b.strength - a.strength).slice(0, 8);
}

// ─── Gebühren-Check ───────────────────────────────────────────────────────────

function feeCheck(marginUSD, leverage, tpPct) {
  const notional    = marginUSD * leverage;
  const feeRoundTrip = notional * TAKER_FEE_RATE * 2;   // Entry + Exit
  const tpProfit    = notional * (tpPct / 100);
  const ratio       = tpProfit / feeRoundTrip;
  const ok          = ratio >= MIN_PROFIT_FEE_MULTIPLIER;
  console.log(`  Gebühren-Check: Notional=$${notional.toFixed(0)} | Fees=$${feeRoundTrip.toFixed(3)} | TP-Gewinn=$${tpProfit.toFixed(2)} | Ratio=${ratio.toFixed(1)}× ${ok ? "✅" : "🚫"}`);
  return { ok, notional, feeRoundTrip, tpProfit };
}

// ─── BitGet API ───────────────────────────────────────────────────────────────

function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function bitgetRequest(method, path, body = null) {
  const ts  = Date.now().toString();
  const b   = body ? JSON.stringify(body) : "";
  const sig = sign(ts, method, path, b);
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
  });
  return res.json();
}

// Offene Positionen für Symbol prüfen
async function getOpenPosition(symbol) {
  const res = await bitgetRequest("GET", `/api/v2/mix/position/single-position?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`);
  if (res.code !== "00000") return null;
  return res.data?.find(p => parseFloat(p.total || 0) > 0) || null;
}

// Leverage setzen
async function setLeverage(symbol, leverage) {
  for (const side of ["long", "short"]) {
    await bitgetRequest("POST", "/api/v2/mix/account/set-leverage", {
      symbol, productType: "USDT-FUTURES", marginCoin: "USDT",
      leverage: String(leverage), holdSide: side,
    });
  }
}

// Order mit TP/SL platzieren
async function placeOrder(symbol, direction, marginUSD, price) {
  const side      = direction === "long" ? "buy" : "sell";
  const rawSize   = (marginUSD * CONFIG.leverage) / price;
  const size      = Math.max(rawSize, 0.001).toFixed(4);

  const tpPrice   = direction === "long"
    ? (price * (1 + CONFIG.tpPercent / 100)).toFixed(2)
    : (price * (1 - CONFIG.tpPercent / 100)).toFixed(2);

  const slPrice   = direction === "long"
    ? (price * (1 - CONFIG.slPercent / 100)).toFixed(2)
    : (price * (1 + CONFIG.slPercent / 100)).toFixed(2);

  const path = "/api/v2/mix/order/place-order";
  const body = {
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
  };

  const res = await bitgetRequest("POST", path, body);
  if (res.code !== "00000") throw new Error(`${res.msg} (${res.code})`);
  return { orderId: res.data.orderId, tpPrice, slPrice, size };
}

// ─── Signal-Logik ─────────────────────────────────────────────────────────────

function getSignal(price, ema8, vwapVal, rsi3, newsBias) {
  const results = [];
  const check = (label, cond, req, actual) => {
    results.push({ label, pass: cond });
    console.log(`  ${cond ? "✅" : "🚫"} ${label} → Soll: ${req} | Ist: ${actual}`);
  };

  const bullish = price > vwapVal && price > ema8;
  const bearish = price < vwapVal && price < ema8;
  const distPct = Math.abs((price - vwapVal) / vwapVal) * 100;

  if (newsBias === "bearish" && bullish) { console.log("  ⚠️  News bearish vs Chart bullish — kein Trade"); return { allPass: false, direction: null }; }
  if (newsBias === "bullish" && bearish) { console.log("  ⚠️  News bullish vs Chart bearish — kein Trade"); return { allPass: false, direction: null }; }

  if (bullish) {
    console.log("  Richtung: LONG");
    check("Preis > VWAP",     price > vwapVal,  `>${vwapVal.toFixed(2)}`, price.toFixed(2));
    check("Preis > EMA(8)",   price > ema8,     `>${ema8.toFixed(2)}`,    price.toFixed(2));
    check("RSI(3) < 30",      rsi3 < 30,        "< 30",                   rsi3.toFixed(2));
    check("Dist VWAP < 1.5%", distPct < 1.5,    "< 1.5%",                 `${distPct.toFixed(2)}%`);
    return { allPass: results.every(r => r.pass), direction: "long" };
  }

  if (bearish) {
    console.log("  Richtung: SHORT");
    check("Preis < VWAP",     price < vwapVal,  `<${vwapVal.toFixed(2)}`, price.toFixed(2));
    check("Preis < EMA(8)",   price < ema8,     `<${ema8.toFixed(2)}`,    price.toFixed(2));
    check("RSI(3) > 70",      rsi3 > 70,        "> 70",                   rsi3.toFixed(2));
    check("Dist VWAP < 1.5%", distPct < 1.5,    "< 1.5%",                 `${distPct.toFixed(2)}%`);
    return { allPass: results.every(r => r.pass), direction: "short" };
  }

  console.log("  Neutral — kein Signal");
  return { allPass: false, direction: null };
}

// ─── Gold Chart Analyse ───────────────────────────────────────────────────────

async function analyzeGoldChart() {
  console.log("\n" + "═".repeat(60));
  console.log("  GOLD (XAUUSDT) — Chart Analyse");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═".repeat(60));

  // Alle Zeitrahmen parallel laden
  let c15m, c1h, c4h;
  try {
    [c15m, c1h, c4h] = await Promise.all([
      fetchGoldCandles("15m", 120),
      fetchGoldCandles("1H",  200),
      fetchGoldCandles("4H",  100),
    ]);
  } catch (e) {
    console.log(`  ❌ Datenfehler: ${e.message}`);
    return null;
  }

  const price = c1h.at(-1).close;
  console.log(`\n  Aktueller Preis: $${price.toFixed(2)}\n`);

  // ── 4H Analyse ──────────────────────────────────────────────
  console.log("── 4H Timeframe ───────────────────────────────────────────\n");
  const cl4h    = c4h.map(c => c.close);
  const ema8_4h  = ema(cl4h, 8);
  const ema21_4h = ema(cl4h, 21);
  const ema50_4h = ema(cl4h, 50);
  const rsi14_4h = rsi(cl4h, 14);
  const macd4h   = macd(cl4h);
  const atr4h    = atr(c4h, 14);
  const bb4h     = bollingerBands(cl4h, 20, 2);

  const trend4h =
    ema8_4h > ema21_4h && ema21_4h > ema50_4h ? "BULLISCH" :
    ema8_4h < ema21_4h && ema21_4h < ema50_4h ? "BÄRISCH"  : "SEITWÄRTS";

  console.log(`  Trend (EMA Stack):  ${trend4h}`);
  console.log(`  EMA(8)  $${ema8_4h?.toFixed(2)}  EMA(21) $${ema21_4h?.toFixed(2)}  EMA(50) $${ema50_4h?.toFixed(2)}`);
  console.log(`  RSI(14): ${rsi14_4h?.toFixed(1)}${rsi14_4h > 70 ? "  ⚠️  Überkauft" : rsi14_4h < 30 ? "  ⚠️  Überverkauft" : "  ✅ Normal"}`);
  if (macd4h) console.log(`  MACD: ${macd4h.macd.toFixed(2)} | Signal ${macd4h.signal.toFixed(2)} | Hist ${macd4h.histogram > 0 ? "+" : ""}${macd4h.histogram.toFixed(2)} ${macd4h.histogram > 0 ? "📈" : "📉"}`);
  if (atr4h)  console.log(`  ATR(14): $${atr4h.toFixed(2)}  (4H-Volatilität)`);
  if (bb4h) {
    const bbW = ((bb4h.upper - bb4h.lower) / bb4h.middle * 100).toFixed(2);
    console.log(`  BB(20,2): $${bb4h.lower.toFixed(2)} — $${bb4h.middle.toFixed(2)} — $${bb4h.upper.toFixed(2)}  Breite ${bbW}%`);
  }

  // ── 1H Analyse ──────────────────────────────────────────────
  console.log("\n── 1H Timeframe ───────────────────────────────────────────\n");
  const cl1h    = c1h.map(c => c.close);
  const ema8_1h  = ema(cl1h, 8);
  const ema21_1h = ema(cl1h, 21);
  const rsi14_1h = rsi(cl1h, 14);
  const rsi3_1h  = rsi(cl1h, 3);
  const macd1h   = macd(cl1h);
  const atr1h    = atr(c1h, 14);
  const bb1h     = bollingerBands(cl1h, 20, 2);
  const vwap1h   = vwap(c1h);

  const trend1h = ema8_1h > ema21_1h ? "BULLISCH" : "BÄRISCH";

  console.log(`  Trend (EMA8 vs EMA21): ${trend1h}`);
  console.log(`  EMA(8) $${ema8_1h?.toFixed(2)}  EMA(21) $${ema21_1h?.toFixed(2)}`);
  console.log(`  VWAP:  $${vwap1h?.toFixed(2)}  (Preis ${price > vwap1h ? "ÜBER ▲" : "UNTER ▼"} VWAP)`);
  console.log(`  RSI(14): ${rsi14_1h?.toFixed(1)}  RSI(3): ${rsi3_1h?.toFixed(1)}`);
  if (macd1h) console.log(`  MACD: ${macd1h.macd.toFixed(2)} | Signal ${macd1h.signal.toFixed(2)} | Hist ${macd1h.histogram > 0 ? "+" : ""}${macd1h.histogram.toFixed(2)} ${macd1h.histogram > 0 ? "📈" : "📉"}`);
  if (atr1h)  console.log(`  ATR(14): $${atr1h.toFixed(2)}`);
  if (bb1h)   console.log(`  BB(20,2): $${bb1h.lower.toFixed(2)} — $${bb1h.middle.toFixed(2)} — $${bb1h.upper.toFixed(2)}`);

  // ── 15m Analyse ─────────────────────────────────────────────
  console.log("\n── 15m Timeframe (Einstieg) ───────────────────────────────\n");
  const cl15m   = c15m.map(c => c.close);
  const ema8_15m = ema(cl15m, 8);
  const rsi3_15m = rsi(cl15m, 3);
  const atr15m   = atr(c15m, 14);
  const vwap15m  = vwap(c15m);

  console.log(`  EMA(8)  $${ema8_15m?.toFixed(2)}  VWAP $${vwap15m?.toFixed(2)}`);
  console.log(`  RSI(3): ${rsi3_15m?.toFixed(1)}  ATR: $${atr15m?.toFixed(2)}`);
  console.log(`  Preis ${price > ema8_15m ? "über" : "unter"} EMA(8) | ${price > vwap15m ? "über" : "unter"} VWAP`);

  // ── Schlüsselniveaus ─────────────────────────────────────────
  console.log("\n── Schlüsselniveaus (1H Swing-Analyse) ────────────────────\n");
  const levels  = findKeyLevels(c1h.slice(-80));
  const res_lvl = levels.filter(l => l.type === "resistance" && l.price > price).sort((a, b) => a.price - b.price).slice(0, 3);
  const sup_lvl = levels.filter(l => l.type === "support"    && l.price < price).sort((a, b) => b.price - a.price).slice(0, 3);

  if (res_lvl.length) { console.log("  Widerstand:"); res_lvl.forEach(l => console.log(`    R $${l.price.toFixed(2)}  (${l.strength}× berührt)`)); }
  if (sup_lvl.length) { console.log("  Unterstützung:"); sup_lvl.forEach(l => console.log(`    S $${l.price.toFixed(2)}  (${l.strength}× berührt)`)); }

  // ── News Sentiment ───────────────────────────────────────────
  console.log("\n── Gold News Sentiment ─────────────────────────────────────\n");
  const newsBias = await getGoldNewsBias();
  console.log(`  Sentiment: ${newsBias.toUpperCase()}  ${newsBias === "bullish" ? "📈" : newsBias === "bearish" ? "📉" : "⚖️"}`);

  // ── Signal-Score ─────────────────────────────────────────────
  console.log("\n── Signal-Score ────────────────────────────────────────────\n");
  const scoreItems = [];
  const add = (pts, cond, label) => scoreItems.push({ pts, cond, label });

  add(2, trend4h === "BULLISCH",                                  "4H EMA-Stack bullisch");
  add(2, trend4h === "BÄRISCH",                                   "4H EMA-Stack bärisch");
  add(1, trend1h === trend4h && trend4h === "BULLISCH",           "1H + 4H Trend aligned ▲");
  add(1, trend1h === trend4h && trend4h === "BÄRISCH",            "1H + 4H Trend aligned ▼");
  add(1, price > vwap1h && trend4h === "BULLISCH",                "Preis über VWAP in Auftrend");
  add(1, price < vwap1h && trend4h === "BÄRISCH",                 "Preis unter VWAP in Abtrend");
  add(1, (macd1h?.histogram ?? 0) > 0 && (macd4h?.histogram ?? 0) > 0, "MACD 1H + 4H beide positiv");
  add(1, (macd1h?.histogram ?? 0) < 0 && (macd4h?.histogram ?? 0) < 0, "MACD 1H + 4H beide negativ");
  add(1, rsi3_1h < 30 && trend4h === "BULLISCH",                 "RSI(3) überverkauft → Long-Einstieg");
  add(1, rsi3_1h > 70 && trend4h === "BÄRISCH",                  "RSI(3) überkauft → Short-Einstieg");
  add(1, newsBias === "bullish" && trend4h === "BULLISCH",        "News bestätigt Auftrend");
  add(1, newsBias === "bearish" && trend4h === "BÄRISCH",         "News bestätigt Abtrend");

  const bbWidth4h = bb4h ? (bb4h.upper - bb4h.lower) / bb4h.middle * 100 : 999;
  add(1, bbWidth4h < 1.5,                                        "BB-Squeeze → Ausbruch erwartet");

  let rawScore = 0;
  const maxRaw = 13; // Summe aller möglichen Punkte
  for (const { pts, cond, label } of scoreItems) {
    if (cond) { rawScore += pts; console.log(`  +${pts} ✅ ${label}`); }
    else                           console.log(`   0    ${label}`);
  }

  const signalStrength = Math.min(Math.round((rawScore / maxRaw) * 10), 10);
  console.log(`\n  Score ${rawScore}/${maxRaw} → Stärke ${"█".repeat(signalStrength)}${"░".repeat(10 - signalStrength)} ${signalStrength}/10`);

  // Richtung bestimmen
  const bullVotes = (trend4h === "BULLISCH" ? 1 : 0) + (trend1h === "BULLISCH" ? 1 : 0)
                  + (price > vwap1h ? 1 : 0) + ((macd1h?.histogram ?? 0) > 0 ? 1 : 0);
  const bearVotes = (trend4h === "BÄRISCH" ? 1 : 0) + (trend1h === "BÄRISCH" ? 1 : 0)
                  + (price < vwap1h ? 1 : 0) + ((macd1h?.histogram ?? 0) < 0 ? 1 : 0);

  let direction = null;
  if (bullVotes > bearVotes && signalStrength >= 5) direction = "long";
  else if (bearVotes > bullVotes && signalStrength >= 5) direction = "short";

  // ── Trade-Empfehlung ─────────────────────────────────────────
  console.log("\n── Trade-Empfehlung ────────────────────────────────────────\n");

  if (direction && atr1h) {
    const tp  = direction === "long" ? price + atr1h * 2 : price - atr1h * 2;
    const sl  = direction === "long" ? price - atr1h * 1 : price + atr1h * 1;
    const rr  = Math.abs(tp - price) / Math.abs(sl - price);

    console.log(`  Richtung:   ${direction.toUpperCase()} ${direction === "long" ? "📈" : "📉"}`);
    console.log(`  Entry:      $${price.toFixed(2)}`);
    console.log(`  TP (2×ATR): $${tp.toFixed(2)}  (+$${Math.abs(tp - price).toFixed(2)})`);
    console.log(`  SL (1×ATR): $${sl.toFixed(2)}  (-$${Math.abs(sl - price).toFixed(2)})`);
    console.log(`  R/R-Ratio:  ${rr.toFixed(2)}:1`);
    if (sup_lvl.length) console.log(`  Nächste Unterstützung: $${sup_lvl[0].price.toFixed(2)}`);
    if (res_lvl.length) console.log(`  Nächster Widerstand:   $${res_lvl[0].price.toFixed(2)}`);
  } else if (signalStrength < 5) {
    console.log(`  ⏸️  Signal zu schwach (${signalStrength}/10) — kein Trade`);
  } else {
    console.log(`  ⚖️  Kein klarer Bias — abwarten`);
  }

  console.log("\n" + "═".repeat(60) + "\n");
  return { direction, signalStrength, price, atr: atr1h, vwap: vwap1h, ema8: ema8_1h };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function todayCount(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

const CSV_HEAD = "Datum,Zeit,Symbol,Richtung,Preis,Margin$,Notional$,TP,SL,OrderID,Modus\n";
function initCsv() { if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEAD); }
function writeCsv(e) {
  const d = new Date(e.timestamp);
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0,10), d.toISOString().slice(11,19),
    e.symbol, e.direction||"BLOCKED", e.price?.toFixed(2)||"",
    e.margin?.toFixed(2)||"", e.notional?.toFixed(2)||"",
    e.tpPrice||"", e.slPrice||"",
    e.orderId||"",
    e.paperTrading ? "PAPER" : (e.orderPlaced ? "LIVE" : "BLOCKED"),
  ].join(",") + "\n");
}

// ─── Ein Symbol handeln ───────────────────────────────────────────────────────

async function tradeSymbol(symbol, log) {
  console.log(`\n${"─".repeat(58)}`);
  console.log(`  ${symbol}`);
  console.log("─".repeat(58));

  // 1. Bereits offen?
  const existing = await getOpenPosition(symbol);
  if (existing) {
    console.log(`  ⏭️  Position bereits offen (${existing.holdSide}, ${existing.total} Kontrakte) — überspringen`);
    return;
  }

  // Gold: Erweiterte Chart-Analyse (Multi-Timeframe)
  if (symbol === "XAUUSDT") {
    const goldAnalysis = await analyzeGoldChart();
    if (!goldAnalysis || !goldAnalysis.direction || goldAnalysis.signalStrength < 5) return;
    // Weiter mit direction aus Gold-Analyse
    const { direction, price: goldPrice, atr: goldAtr } = goldAnalysis;
    const margin = Math.min(CONFIG.portfolioValue * 0.015, CONFIG.maxTradeSizeUSD);
    const { ok: feesOk, notional, tpProfit, feeRoundTrip } = feeCheck(margin, CONFIG.leverage, CONFIG.tpPercent);
    if (!feesOk) { console.log(`  🚫 Gebühren-Check fehlgeschlagen`); return; }
    const logEntry = {
      timestamp: new Date().toISOString(), symbol, direction, price: goldPrice,
      margin, notional, paperTrading: CONFIG.paperTrading, orderPlaced: false,
      orderId: null, tpPrice: null, slPrice: null,
    };
    console.log(`\n── Order (Gold) ────────────────────────────────────────────\n`);
    console.log(`  ${direction.toUpperCase()} XAUUSDT | Margin $${margin.toFixed(0)} × ${CONFIG.leverage}x = $${notional.toFixed(0)}`);
    if (CONFIG.paperTrading) {
      const tp = direction === "long" ? goldPrice * (1 + CONFIG.tpPercent / 100) : goldPrice * (1 - CONFIG.tpPercent / 100);
      const sl = direction === "long" ? goldPrice * (1 - CONFIG.slPercent / 100) : goldPrice * (1 + CONFIG.slPercent / 100);
      logEntry.orderId = `PAPER-GOLD-${Date.now()}`;
      logEntry.tpPrice = tp.toFixed(2); logEntry.slPrice = sl.toFixed(2); logEntry.orderPlaced = true;
      console.log(`  📋 PAPER — würde ${direction.toUpperCase()} @ $${goldPrice.toFixed(2)} | TP $${tp.toFixed(2)} | SL $${sl.toFixed(2)}`);
    } else {
      try {
        await setLeverage(symbol, CONFIG.leverage);
        const order = await placeOrder(symbol, direction, margin, goldPrice);
        logEntry.orderPlaced = true; logEntry.orderId = order.orderId;
        logEntry.tpPrice = order.tpPrice; logEntry.slPrice = order.slPrice;
        console.log(`  ✅ ORDER PLATZIERT #${order.orderId}`);
      } catch (err) { console.log(`  ❌ ORDER FEHLER: ${err.message}`); logEntry.error = err.message; }
    }
    log.trades.push(logEntry);
    writeCsv(logEntry);
    return;
  }

  // 2. Liquidität + Funding (Crypto) & News parallel
  const [liquidityBias, newsBias] = await Promise.all([
    getLiquidityBias(symbol),
    getNewsBias(symbol),
  ]);
  console.log(`  Liquidität: ${liquidityBias.toUpperCase()} | News: ${newsBias.toUpperCase()}`);

  // Kombinierter Bias: Liquidität hat mehr Gewicht als News
  const combinedBias = liquidityBias !== "neutral" ? liquidityBias : newsBias;

  // 3. Marktdaten
  let candles;
  try { candles = await fetchCandles(symbol); }
  catch (e) { console.log(`  ❌ Keine Daten: ${e.message}`); return; }

  const closes  = candles.map(c => c.close);
  const price   = closes.at(-1);
  const ema8    = ema(closes, 8);
  const vwapVal = vwap(candles);
  const rsi3    = rsi(closes, 3);

  console.log(`\n  Preis $${price.toFixed(2)}  EMA8 $${ema8?.toFixed(2)||"?"}  VWAP $${vwapVal?.toFixed(2)||"?"}  RSI3 ${rsi3?.toFixed(1)||"?"}`);

  if (vwapVal === null || rsi3 === null || ema8 === null) {
    console.log("  ⚠️  Nicht genug Daten");
    return;
  }

  // 4. Signal
  console.log("\n── Signal ──────────────────────────────────────────────\n");
  const { allPass, direction } = getSignal(price, ema8, vwapVal, rsi3, combinedBias);

  if (!allPass) return;

  // 5. Gebühren-Check
  console.log("\n── Gebühren ────────────────────────────────────────────\n");
  const margin = Math.min(CONFIG.portfolioValue * 0.015, CONFIG.maxTradeSizeUSD);
  const { ok: feesOk, notional, tpProfit, feeRoundTrip } = feeCheck(margin, CONFIG.leverage, CONFIG.tpPercent);

  if (!feesOk) {
    console.log(`  🚫 Trade unrentabel: Profit $${tpProfit.toFixed(2)} < 5× Gebühren $${(feeRoundTrip*5).toFixed(2)}`);
    return;
  }

  console.log(`  TP +${CONFIG.tpPercent}% = +$${tpProfit.toFixed(2)} | SL -${CONFIG.slPercent}% = -$${(notional*CONFIG.slPercent/100+feeRoundTrip).toFixed(2)} | Net nach Gebühren: +$${(tpProfit-feeRoundTrip).toFixed(2)}`);

  // 6. Order
  console.log(`\n── Order ───────────────────────────────────────────────\n`);
  console.log(`  ${direction.toUpperCase()} ${symbol} | Margin $${margin.toFixed(0)} × ${CONFIG.leverage}x = $${notional.toFixed(0)} Notional`);

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, direction, price,
    margin, notional, paperTrading: CONFIG.paperTrading,
    orderPlaced: false, orderId: null, tpPrice: null, slPrice: null,
  };

  if (CONFIG.paperTrading) {
    const tp = direction === "long" ? price*(1+CONFIG.tpPercent/100) : price*(1-CONFIG.tpPercent/100);
    const sl = direction === "long" ? price*(1-CONFIG.slPercent/100) : price*(1+CONFIG.slPercent/100);
    logEntry.orderId = `PAPER-${Date.now()}`;
    logEntry.tpPrice = tp.toFixed(2);
    logEntry.slPrice = sl.toFixed(2);
    logEntry.orderPlaced = true;
    console.log(`  📋 PAPER — würde ${direction.toUpperCase()} @ ${price.toFixed(2)} | TP ${tp.toFixed(2)} | SL ${sl.toFixed(2)}`);
  } else {
    try {
      await setLeverage(symbol, CONFIG.leverage);
      const order = await placeOrder(symbol, direction, margin, price);
      logEntry.orderPlaced = true;
      logEntry.orderId     = order.orderId;
      logEntry.tpPrice     = order.tpPrice;
      logEntry.slPrice     = order.slPrice;
      console.log(`  ✅ ORDER PLATZIERT #${order.orderId}`);
      console.log(`     ${direction.toUpperCase()} @ $${price.toFixed(2)} | TP $${order.tpPrice} | SL $${order.slPrice}`);
      console.log(`     Größe: ${order.size} Kontrakte | Notional: $${notional.toFixed(0)}`);
    } catch (err) {
      console.log(`  ❌ ORDER FEHLER: ${err.message}`);
      logEntry.error = err.message;
    }
  }

  log.trades.push(logEntry);
  writeCsv(logEntry);
}

// ─── Haupt ────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();
  const log = loadLog();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BitGet Trading Bot — Professionell");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | ${CONFIG.leverage}x | TP ${CONFIG.tpPercent}% | SL ${CONFIG.slPercent}%`);
  console.log("═══════════════════════════════════════════════════════════");

  const traded = todayCount(log);
  console.log(`\n✅ Trades heute: ${traded}`);

  const symbols = getActiveSymbols();

  for (const sym of symbols) {
    await tradeSymbol(sym, log);
  }

  saveLog(log);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  const lines = existsSync(CSV_FILE) ? readFileSync(CSV_FILE,"utf8").trim().split("\n").slice(1) : [];
  const live  = lines.filter(l => l.includes(",LIVE"));
  console.log(`\nTrades gesamt: ${lines.length} | Live: ${live.length} | Paper: ${lines.filter(l=>l.includes(",PAPER")).length}`);
} else if (process.argv.includes("--gold")) {
  // Standalone Gold-Chart-Analyse (kein Trade, nur Auswertung)
  analyzeGoldChart().catch(e => { console.error("Gold-Analyse Fehler:", e); process.exit(1); });
} else {
  run().catch(e => { console.error("Fehler:", e); process.exit(1); });
}
