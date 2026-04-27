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
import http from "http";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

process.on("unhandledRejection", (reason, p) => {
  console.error("[unhandledRejection]", p, reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// ─── Konfiguration ────────────────────────────────────────────────────────────

const TAKER_FEE_RATE = 0.0006;          // 0.06% pro Seite
const MIN_PROFIT_FEE_MULTIPLIER = 5;    // Profit muss > 5× Gebühren sein
const MAX_NOTIONAL_PER_TRADE = 100;
const TARGET_PROFIT_USD = 5;

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
    apiKey:     "",
    secretKey:  "",
    passphrase: "",
    baseUrl:    "https://api.bitget.com",
  },
};

/** Bitget-Keys aus Umgebung (Railway: exakte Namen; Aliase für häufige Tippfehler) */
function hydrateBitgetFromEnv() {
  const apiKey =
    (process.env.BITGET_API_KEY || process.env.BITGET_APIKEY || "").trim();
  const secretKey = (
    process.env.BITGET_SECRET_KEY ||
    process.env.BITGET_SECRET ||
    process.env.BITGET_API_SECRET ||
    ""
  ).trim();
  const passphrase = (process.env.BITGET_PASSPHRASE || "").trim();
  CONFIG.bitget.apiKey = apiKey;
  CONFIG.bitget.secretKey = secretKey;
  CONFIG.bitget.passphrase = passphrase;
}

hydrateBitgetFromEnv();

// ─── Symbole ──────────────────────────────────────────────────────────────────

const WEEKEND_CRYPTO = [];

const WEEKDAY_EQUITIES = [
  "QQQUSDT",
  "SPYUSDT",
  "NVDAUSDT",
  "TSLAUSDT",
  "AAPLUSDT",
  "MSFTUSDT",
  "AMZNUSDT",
  "METAUSDT",
];

const WEEKDAY_COMMODITIES = [
  "XAUUSDT",
  "XAGUSDT",
];

const SYMBOL_META = {
  BTCUSDT: { assetClass: "crypto", label: "Bitcoin", newsQuery: "Bitcoin crypto market", leverage: 3, maxTradeSizeUSD: 20 },
  ETHUSDT: { assetClass: "crypto", label: "Ethereum", newsQuery: "Ethereum crypto market", leverage: 3, maxTradeSizeUSD: 20 },
  SOLUSDT: { assetClass: "crypto", label: "Solana", newsQuery: "Solana crypto market", leverage: 3, maxTradeSizeUSD: 18 },
  QQQUSDT: { assetClass: "etf", label: "Nasdaq QQQ", newsQuery: "Nasdaq QQQ tech stocks fed inflation", leverage: 1, maxTradeSizeUSD: 15 },
  SPYUSDT: { assetClass: "etf", label: "S&P 500 SPY", newsQuery: "S&P 500 SPY fed inflation earnings", leverage: 1, maxTradeSizeUSD: 15 },
  NVDAUSDT: { assetClass: "equity", label: "Nvidia", newsQuery: "Nvidia AI earnings semiconductor", leverage: 1, maxTradeSizeUSD: 12 },
  TSLAUSDT: { assetClass: "equity", label: "Tesla", newsQuery: "Tesla EV deliveries earnings", leverage: 1, maxTradeSizeUSD: 12 },
  AAPLUSDT: { assetClass: "equity", label: "Apple", newsQuery: "Apple iphone earnings", leverage: 1, maxTradeSizeUSD: 12 },
  MSFTUSDT: { assetClass: "equity", label: "Microsoft", newsQuery: "Microsoft cloud AI earnings", leverage: 1, maxTradeSizeUSD: 12 },
  AMZNUSDT: { assetClass: "equity", label: "Amazon", newsQuery: "Amazon AWS consumer earnings", leverage: 1, maxTradeSizeUSD: 12 },
  METAUSDT: { assetClass: "equity", label: "Meta Platforms social advertising AI", leverage: 1, maxTradeSizeUSD: 12 },
  XAUUSDT: { assetClass: "commodity", label: "Gold", newsQuery: "Gold price fed inflation war peace talks", leverage: 1, maxTradeSizeUSD: 15 },
  XAGUSDT: { assetClass: "commodity", label: "Silver", newsQuery: "Silver price fed inflation industrial demand", leverage: 1, maxTradeSizeUSD: 12 },
};

const ALLOWED_SYMBOLS = new Set(Object.keys(SYMBOL_META));

const SYMBOL_OVERRIDES = {};

const NEWS_BULLISH = [
  "ceasefire", "peace", "peace talks", "deal", "agreement", "progress",
  "rate cut", "cooling inflation", "etf approved", "stimulus", "upgrade",
  "earnings beat", "ai", "partnership", "profit", "growth", "record",
  "bullish", "breakout", "strong demand", "soft landing"
];
const NEWS_BEARISH = [
  "war", "attack", "invasion", "no agreement", "talks failed", "tariff",
  "ban", "crash", "recession", "rate hike", "inflation fears", "miss",
  "downgrade", "hack", "bankruptcy", "fraud", "loss", "sanction",
  "bearish", "selloff", "weak demand", "guidance cut"
];
const NEWS_SHOCK_BULLISH = [
  "trump says deal",
  "trump backs",
  "ceasefire",
  "peace talks progress",
  "fed cut",
  "cooling inflation",
  "tariff relief",
];
const NEWS_SHOCK_BEARISH = [
  "trump tariff",
  "trump says tariff",
  "trump post",
  "trade war",
  "no peace deal",
  "missile",
  "attack",
  "fed hikes",
  "hot inflation",
];
const NEWS_RSS_DOMAINS = [
  "bloomberg.com",
  "reuters.com",
  "axios.com",
  "cnbc.com",
  "marketwatch.com",
  "wsj.com",
  "ft.com",
  "investing.com",
  "finance.yahoo.com",
  "seekingalpha.com",
];
const MARKET_SENTIMENT_QUERY = [
  "stock market sentiment",
  "trump fed inflation tariff war peace talks earnings futures risk-on risk-off",
  "\"Truth Social\"",
  "\"US futures\"",
].join(" ");
const TRUMP_FEED_QUERY = [
  "\"Trump\"",
  "\"Truth Social\" OR \"TruthSocial\" OR \"Trump post\"",
  "(site:axios.com OR site:bloomberg.com OR site:reuters.com OR site:cnbc.com OR site:marketwatch.com OR site:wsj.com)",
].join(" ");
const INFLUENCER_X_USERS = (
  process.env.X_INFLUENCER_USERS ||
  "realDonaldTrump,POTUS,WhiteHouse,federalreserve,USTreasury,SecScottBessent,elonmusk"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  const code = err?.code || err?.cause?.code;
  const msg = String(err?.message || "");
  return [
    "ENOTFOUND",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(code) || /fetch failed|timeout|timed out|network/i.test(msg);
}

async function fetchWithRetry(url, options = {}) {
  const {
    attempts = 3,
    timeoutMs = 8000,
    retryDelayMs = 1000,
    label = "request",
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (isRetryableStatus(res.status) && attempt < attempts) {
        console.warn(`  [retry] ${label} HTTP ${res.status} (${attempt}/${attempts})`);
        await res.arrayBuffer().catch(() => {});
        await sleep(retryDelayMs * attempt);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < attempts && isRetryableError(err)) {
        const code = err?.code || err?.cause?.code || "ERR";
        console.warn(`  [retry] ${label} ${code} (${attempt}/${attempts})`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`${label} fehlgeschlagen`);
}

function validateBitgetEnv() {
  hydrateBitgetFromEnv();
  const { apiKey, secretKey, passphrase } = CONFIG.bitget;
  const missing = [];
  if (!apiKey) missing.push("BITGET_API_KEY");
  if (!secretKey) missing.push("BITGET_SECRET_KEY (oder BITGET_SECRET)");
  if (!passphrase) missing.push("BITGET_PASSPHRASE");
  if (missing.length) {
    console.error(
      "❌ Bitget-Zugangsdaten fehlen. Lokal: `.env` im Projektordner anlegen oder Umgebungsvariablen setzen.\n" +
        "   BITGET_API_KEY\n" +
        "   BITGET_SECRET_KEY   ← Secret Key von Bitget (nicht die Passphrase!)\n" +
        "   BITGET_PASSPHRASE   ← Passphrase bei API-Key-Erstellung\n" +
        `   Fehlt: ${missing.join(", ")}`
    );
    process.exit(1);
  }
}

/** Erkennung Railway — dort muss der Prozess auf $PORT lauschen (Deploy-Healthcheck). */
function isRailwayRuntime() {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

/**
 * HTTP /health für Railway & Co. Auf Railway wird SKIP_HEALTH_SERVER ignoriert (sonst schlägt Deploy fehl).
 * Lokal: SKIP_HEALTH_SERVER=true oder HEALTH_PORT=0 zum Abschalten.
 */
function startHealthServer() {
  const onRailway = isRailwayRuntime();
  if ((process.env.SKIP_HEALTH_SERVER === "true" || process.env.HEALTH_PORT === "0") && !onRailway) {
    console.log("🩺 Health-Server aus (SKIP_HEALTH_SERVER oder HEALTH_PORT=0)");
    return;
  }
  if (onRailway && process.env.SKIP_HEALTH_SERVER === "true") {
    console.warn("⚠️  SKIP_HEALTH_SERVER wird auf Railway ignoriert — Healthcheck braucht einen Listener auf $PORT.");
  }
  const port = parseInt(process.env.PORT || process.env.HEALTH_PORT || "8080", 10);
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`🩺 Health: http://0.0.0.0:${port}/health`);
  });
  server.on("error", (err) => {
    console.error("[health server]", err.message);
  });
}

// ─── Wochentag ────────────────────────────────────────────────────────────────

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

function getActiveSymbols() {
  console.log(`📅 ${isWeekend() ? "Wochenende" : "Wochentag"} → nur Gold, Silber, Aktien, ETFs`);
  return [...WEEKDAY_COMMODITIES, ...WEEKDAY_EQUITIES];
}

function getSymbolMeta(symbol) {
  return SYMBOL_META[symbol] || { assetClass: "unknown", label: symbol, newsQuery: symbol.replace("USDT", "") };
}

function getCurrentSession(date = new Date()) {
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 7) return "asia";
  if (hour >= 7 && hour < 13) return "europe";
  if (hour >= 13 && hour < 21) return "us";
  return "afterhours";
}

function canTradeNow(symbol, date = new Date()) {
  const meta = getSymbolMeta(symbol);
  if (meta.assetClass === "crypto") return { allowed: true, session: getCurrentSession(date) };

  const session = getCurrentSession(date);
  if (meta.assetClass === "commodity") {
    const allowed = session === "europe" || session === "us";
    return { allowed, session, reason: allowed ? "" : "Gold/Silber nur Europa- oder US-Session" };
  }

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const usOpenMinutes = 13 * 60 + 30;
  const usOpenDelayEnd = usOpenMinutes + 15;
  if (minutes >= usOpenMinutes && minutes < usOpenDelayEnd) {
    return { allowed: false, session, reason: "Erste 15 Minuten nach US-Open nur beobachten und Opening Range markieren" };
  }

  const allowed = session === "us";
  return { allowed, session, reason: allowed ? "" : "Aktien/ETFs nur zur US-Session" };
}

// ─── News ─────────────────────────────────────────────────────────────────────

// ─── Liquidität & Funding ─────────────────────────────────────────────────────

async function getLiquidityBias(symbol) {
  // Nur für Crypto sinnvoll (Funding Rate + Order Book)
  const isCrypto = CRYPTO_SYMBOLS.some(s => symbol.startsWith(s));
  if (!isCrypto) return "neutral";

  try {
    // 1. Funding Rate — positiv = Longs zahlen = Short-Druck; negativ = Shorts zahlen = Long-Druck
    const frRes = await fetchWithRetry(
      `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`,
      { timeoutMs: 5000, attempts: 3, retryDelayMs: 1200, label: `${symbol} funding` }
    );
    const frJson = await frRes.json();
    const fundingRate = parseFloat(frJson?.data?.[0]?.fundingRate || 0);

    // 2. Order Book Tiefe — wo sind große Kauf/Verkauf-Wände
    const obRes = await fetchWithRetry(
      `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}&productType=USDT-FUTURES&limit=50`,
      { timeoutMs: 5000, attempts: 3, retryDelayMs: 1200, label: `${symbol} depth` }
    );
    const obJson = await obRes.json();
    const bids = obJson?.data?.bids || [];
    const asks = obJson?.data?.asks || [];

    // Größte Liquiditätszonen finden
    const topBid = bids.slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
    const topAsk = asks.slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
    const bidAskRatio = topBid / (topAsk || 1);

    // 3. Open Interest Richtung
    const oiRes = await fetchWithRetry(
      `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${symbol}&productType=USDT-FUTURES`,
      { timeoutMs: 5000, attempts: 3, retryDelayMs: 1200, label: `${symbol} open-interest` }
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
  } catch (err) {
    console.warn(`  [liquidity] ${symbol}: ${err?.message || err}`);
    return "neutral";
  }
}

function buildDomainFilter(domains = []) {
  if (!domains.length) return "";
  return `(${domains.map((d) => `site:${d}`).join(" OR ")})`;
}

function parseGoogleNewsTitles(xml) {
  // Google News uses plain <title> tags (no CDATA wrapper)
  // Skip the first match which is the feed/channel title
  const all = [...xml.matchAll(/<title>(.*?)<\/title>/gs)]
    .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim())
    .filter((t) => t && !t.includes("Google News") && !t.startsWith('"'));
  return all;
}

function dedupeHeadlines(titles = []) {
  const seen = new Set();
  const out = [];
  for (const raw of titles) {
    const clean = String(raw || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function scoreHeadlines(titles = []) {
  let bull = 0;
  let bear = 0;
  let shockBull = 0;
  let shockBear = 0;

  for (const t of titles) {
    for (const k of NEWS_BULLISH) if (t.includes(k)) bull++;
    for (const k of NEWS_BEARISH) if (t.includes(k)) bear++;
    for (const k of NEWS_SHOCK_BULLISH) if (t.includes(k)) shockBull++;
    for (const k of NEWS_SHOCK_BEARISH) if (t.includes(k)) shockBear++;
  }

  const score = bull - bear + (shockBull * 2) - (shockBear * 2);
  const bias = score > 1 ? "bullish" : score < -1 ? "bearish" : "neutral";
  const shock = shockBull > shockBear ? "bullish" : shockBear > shockBull ? "bearish" : "none";
  return { bull, bear, shockBull, shockBear, score, bias, shock };
}

async function fetchGoogleNewsTitles(query, label, limit = 8) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetchWithRetry(url, {
    timeoutMs: 5000,
    attempts: 3,
    retryDelayMs: 1200,
    label,
  });
  const xml = await res.text();
  return parseGoogleNewsTitles(xml).map((title) => title.toLowerCase()).slice(0, limit);
}

async function fetchNewsApiTitles(query, label, limit = 6) {
  const apiKey = (process.env.NEWSAPI_KEY || "").trim();
  if (!apiKey) return [];
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&pageSize=${limit}&sortBy=publishedAt`;
  const res = await fetchWithRetry(url, {
    timeoutMs: 5000,
    attempts: 2,
    retryDelayMs: 1200,
    label,
    headers: { "X-Api-Key": apiKey },
  });
  if (!res.ok) {
    console.warn(`  [newsapi] ${label}: HTTP ${res.status}`);
    return [];
  }
  const json = await res.json();
  return (json?.articles || [])
    .map((article) => String(article?.title || "").toLowerCase().trim())
    .filter(Boolean)
    .slice(0, limit);
}

async function fetchXUserRecentPosts(username) {
  const bearer = (process.env.X_API_BEARER_TOKEN || "").trim();
  if (!bearer) return [];

  const userRes = await fetchWithRetry(
    `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`,
    {
      timeoutMs: 5000,
      attempts: 2,
      retryDelayMs: 1000,
      label: `x user ${username}`,
      headers: { Authorization: `Bearer ${bearer}` },
    }
  );
  if (!userRes.ok) {
    console.warn(`  [x] user ${username}: HTTP ${userRes.status}`);
    return [];
  }
  const userJson = await userRes.json();
  const userId = userJson?.data?.id;
  if (!userId) return [];

  const postsRes = await fetchWithRetry(
    `https://api.x.com/2/users/${userId}/tweets?exclude=retweets,replies&max_results=5&tweet.fields=created_at`,
    {
      timeoutMs: 5000,
      attempts: 2,
      retryDelayMs: 1000,
      label: `x posts ${username}`,
      headers: { Authorization: `Bearer ${bearer}` },
    }
  );
  if (!postsRes.ok) {
    console.warn(`  [x] posts ${username}: HTTP ${postsRes.status}`);
    return [];
  }
  const postsJson = await postsRes.json();
  return (postsJson?.data || [])
    .map((tweet) => String(tweet?.text || "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

async function fetchInfluencerXTitles() {
  const bearer = (process.env.X_API_BEARER_TOKEN || "").trim();
  if (!bearer || !INFLUENCER_X_USERS.length) return [];
  const settled = await Promise.allSettled(
    INFLUENCER_X_USERS.slice(0, 8).map((username) => fetchXUserRecentPosts(username))
  );
  return dedupeHeadlines(
    settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
  ).slice(0, 12);
}

async function getNewsBias(symbol) {
  const meta = getSymbolMeta(symbol);
  const name = meta.label;
  const query = `${meta.newsQuery || name} ${buildDomainFilter(NEWS_RSS_DOMAINS)}`;

  try {
    const feeds = await Promise.allSettled([
      fetchGoogleNewsTitles(query, `${symbol} news/google`, 8),
      fetchNewsApiTitles(meta.newsQuery || name, `${symbol} news/newsapi`, 6),
    ]);
    const mergedTitles = dedupeHeadlines(
      feeds.flatMap((feed) => (feed.status === "fulfilled" ? feed.value : []))
    ).slice(0, 10);
    const { bull, bear, score, bias } = scoreHeadlines(mergedTitles);
    console.log(`  News [${name}]: ${bull} bull / ${bear} bear | Headlines: ${mergedTitles.length}`);
    return { bias, score, headlines: mergedTitles.slice(0, 3) };
  } catch (err) {
    console.warn(`  [news] ${symbol}: ${err?.message || err}`);
    return { bias: "neutral", score: 0, headlines: [] };
  }
}

async function getMarketSentiment() {
  const query = `${MARKET_SENTIMENT_QUERY} ${buildDomainFilter(NEWS_RSS_DOMAINS)}`;
  try {
    const feeds = await Promise.allSettled([
      fetchGoogleNewsTitles(query, "market sentiment/google", 8),
      fetchGoogleNewsTitles(TRUMP_FEED_QUERY, "market sentiment/trump", 6),
      fetchNewsApiTitles(MARKET_SENTIMENT_QUERY, "market sentiment/newsapi", 6),
      fetchInfluencerXTitles(),
    ]);
    const mergedTitles = dedupeHeadlines(
      feeds.flatMap((feed) => (feed.status === "fulfilled" ? feed.value : []))
    ).slice(0, 16);
    const { bull, bear, score, bias, shock } = scoreHeadlines(mergedTitles);
    console.log(`Market sentiment: ${bias.toUpperCase()} | bull ${bull} bear ${bear} | Shock: ${shock} | Headlines: ${mergedTitles.length}`);
    return { bias, score, shock, headlines: mergedTitles.slice(0, 6) };
  } catch (err) {
    console.warn(`[market sentiment] ${err?.message || err}`);
    return { bias: "neutral", score: 0, shock: "none", headlines: [] };
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
    const res = await fetchWithRetry(url, {
      timeoutMs: 8000,
      attempts: 3,
      retryDelayMs: 1500,
      label: `${symbol} candles/binance`,
    });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(`Binance: keine Kerzen (${typeof data})`);
    return data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  } else {
    // Aktien/Rohstoffe: BitGet
    const gran = BITGET_GRANULARITY[CONFIG.timeframe] || "1m";
    const url = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${gran}&limit=${limit}`;
    const res = await fetchWithRetry(url, {
      timeoutMs: 8000,
      attempts: 3,
      retryDelayMs: 1500,
      label: `${symbol} candles/bitget`,
    });
    const json = await res.json();
    if (json.code !== "00000") throw new Error(`BitGet Kerzen: ${json.msg}`);
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }))
      .reverse();
  }
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

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }
  return trs.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function getSessionRange(candles, startHour, endHour) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startHour, 0, 0, 0);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endHour, 0, 0, 0);
  const rows = candles.filter((c) => c.time >= start && c.time < end);
  if (!rows.length) return null;
  return {
    high: Math.max(...rows.map((c) => c.high)),
    low: Math.min(...rows.map((c) => c.low)),
  };
}

function getOpeningRange(candles) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 30, 0, 0);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 45, 0, 0);
  const rows = candles.filter((c) => c.time >= start && c.time < end);
  if (!rows.length) return null;
  return {
    high: Math.max(...rows.map((c) => c.high)),
    low: Math.min(...rows.map((c) => c.low)),
  };
}

function getMarketStructure(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atrValue = atr(candles, 14);
  const atrPct = atrValue && price ? (atrValue / price) * 100 : null;

  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const dayCandles = candles.filter((c) => c.time >= midnight);
  const currentDay = dayCandles.length ? dayCandles : candles.slice(-Math.min(96, candles.length));

  const dayHigh = Math.max(...currentDay.map((c) => c.high));
  const dayLow = Math.min(...currentDay.map((c) => c.low));

  const asia = getSessionRange(candles, 0, 7);
  const europe = getSessionRange(candles, 7, 13);
  const us = getSessionRange(candles, 13, 21);
  const openingRange = getOpeningRange(candles);

  const recent = candles.slice(-60);
  const support = Math.min(...recent.map((c) => c.low));
  const resistance = Math.max(...recent.map((c) => c.high));

  return {
    price,
    ema20,
    ema50,
    ema200,
    atrValue,
    atrPct,
    dayHigh,
    dayLow,
    asia,
    europe,
    us,
    openingRange,
    support,
    resistance,
    currentSession: getCurrentSession(now),
  };
}

function nearestLevels(structure, currentSession) {
  const highs = [structure.dayHigh, structure.resistance];
  const lows = [structure.dayLow, structure.support];

  if (currentSession === "us") {
    if (structure.openingRange) {
      highs.push(structure.openingRange.high);
      lows.push(structure.openingRange.low);
    }
    if (structure.asia) {
      highs.push(structure.asia.high);
      lows.push(structure.asia.low);
    }
    if (structure.europe) {
      highs.push(structure.europe.high);
      lows.push(structure.europe.low);
    }
  } else if (currentSession === "europe" && structure.asia) {
    highs.push(structure.asia.high);
    lows.push(structure.asia.low);
  }

  return {
    breakoutHigh: Math.max(...highs.filter(Number.isFinite)),
    breakdownLow: Math.min(...lows.filter(Number.isFinite)),
  };
}

function getOpenWindowState(structure) {
  if (structure.currentSession !== "us" || !structure.openingRange) {
    return { active: false, breakoutUp: false, breakoutDown: false };
  }
  const price = structure.price;
  return {
    active: true,
    breakoutUp: price > structure.openingRange.high * 1.001,
    breakoutDown: price < structure.openingRange.low * 0.999,
  };
}

function deriveRiskParams(direction, price, structure) {
  const atrPct = structure.atrPct ?? 0.35;
  const baseSl = Math.min(Math.max(atrPct * 1.2, 0.35), 1.1);
  let tpPct = Math.min(Math.max(baseSl * 1.8, 0.8), 2.8);

  if (direction === "long") {
    const resistanceGap = ((structure.resistance - price) / price) * 100;
    if (Number.isFinite(resistanceGap) && resistanceGap > 0.3) {
      tpPct = Math.min(tpPct, Math.max(resistanceGap * 0.8, 0.8));
    }
  } else {
    const supportGap = ((price - structure.support) / price) * 100;
    if (Number.isFinite(supportGap) && supportGap > 0.3) {
      tpPct = Math.min(tpPct, Math.max(supportGap * 0.8, 0.8));
    }
  }

  return { slPercent: baseSl, tpPercent: Math.max(tpPct, baseSl * 1.5) };
}

function finalizeRiskParams(direction, price, structure, notional, signalType, hasExistingPosition) {
  const risk = deriveRiskParams(direction, price, structure);
  const minTpPctForProfit = Math.max((TARGET_PROFIT_USD / Math.max(notional, 1)) * 100, 0.8);
  const trendSignal = ["breakout", "breakdown", "trend-add-breakout", "trend-add-breakdown"].includes(signalType);

  return {
    slPercent: risk.slPercent,
    tpPercent: Math.max(risk.tpPercent, minTpPctForProfit),
    useTakeProfit: !(trendSignal || hasExistingPosition),
  };
}

function analyzeChart(candles, structure) {
  const recent = candles.slice(-6);
  const last = recent.at(-1);
  const prev = recent.at(-2);
  const swing = candles.slice(-20);

  const higherHighs = swing.slice(-5).every((c, i, arr) => i === 0 || c.high >= arr[i - 1].high);
  const higherLows = swing.slice(-5).every((c, i, arr) => i === 0 || c.low >= arr[i - 1].low);
  const lowerHighs = swing.slice(-5).every((c, i, arr) => i === 0 || c.high <= arr[i - 1].high);
  const lowerLows = swing.slice(-5).every((c, i, arr) => i === 0 || c.low <= arr[i - 1].low);

  const bullishEngulfing = !!(last && prev &&
    last.close > last.open &&
    prev.close < prev.open &&
    last.close >= prev.open &&
    last.open <= prev.close);

  const bearishEngulfing = !!(last && prev &&
    last.close < last.open &&
    prev.close > prev.open &&
    last.open >= prev.close &&
    last.close <= prev.open);

  const closeNearHigh = !!last && (last.high - last.close) <= (last.high - last.low) * 0.2;
  const closeNearLow = !!last && (last.close - last.low) <= (last.high - last.low) * 0.2;

  let trend = "range";
  if (structure.ema20 > structure.ema50 && structure.ema50 > structure.ema200 && higherHighs && higherLows) trend = "uptrend";
  if (structure.ema20 < structure.ema50 && structure.ema50 < structure.ema200 && lowerHighs && lowerLows) trend = "downtrend";

  return {
    trend,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    bullishEngulfing,
    bearishEngulfing,
    closeNearHigh,
    closeNearLow,
  };
}

function isHighQualitySetup(structure, chart, signalType) {
  const atrOk = (structure.atrPct ?? 0) >= 0.03;
  const trendOk = chart.trend === "uptrend" || chart.trend === "downtrend";
  const breakoutSignal = ["breakout", "breakdown", "trend-add-breakout", "trend-add-breakdown"].includes(signalType);
  return atrOk && (trendOk || breakoutSignal);
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
  const secret = CONFIG.bitget.secretKey;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "BITGET_SECRET_KEY ist leer — bitte in Railway unter Variables setzen (Name: BITGET_SECRET_KEY, Wert: Secret Key von Bitget API)."
    );
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`${ts}${method}${path}${body}`)
    .digest("base64");
}

async function bitgetRequest(method, path, body = null) {
  const ts  = Date.now().toString();
  const b   = body ? JSON.stringify(body) : "";
  const sig = sign(ts, method, path, b);
  const res = await fetchWithRetry(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    timeoutMs: 10000,
    attempts: 4,
    retryDelayMs: 1500,
    label: `Bitget ${method} ${path}`,
    headers: {
      "Content-Type":      "application/json",
      "ACCESS-KEY":        CONFIG.bitget.apiKey,
      "ACCESS-SIGN":       sig,
      "ACCESS-TIMESTAMP":  ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body: b || undefined,
  });
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`BitGet API: kein JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// Offene Positionen für Symbol prüfen
async function getOpenPosition(symbol) {
  const res = await bitgetRequest("GET", `/api/v2/mix/position/single-position?symbol=${symbol}&productType=USDT-FUTURES&marginCoin=USDT`);
  if (res.code !== "00000") return null;
  return res.data?.find(p => parseFloat(p.total || 0) > 0) || null;
}

async function getAllOpenPositions() {
  const res = await bitgetRequest("GET", `/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT`);
  if (res.code !== "00000") return [];
  return (res.data || []).filter((p) => parseFloat(p.total || 0) > 0);
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

async function closePosition(symbol, position) {
  const holdSide = position?.holdSide;
  const size = parseFloat(position?.total || 0);
  if (!holdSide || !size) return null;

  const side = holdSide === "long" ? "sell" : "buy";
  const res = await bitgetRequest("POST", "/api/v2/mix/order/place-order", {
    symbol,
    productType: "USDT-FUTURES",
    marginMode: "isolated",
    marginCoin: "USDT",
    size: size.toFixed(4),
    side,
    tradeSide: "close",
    orderType: "market",
  });

  if (res.code !== "00000") throw new Error(`Close failed: ${res.msg} (${res.code})`);
  return res.data?.orderId || null;
}

// Order platzieren (kein Stop Loss — nur Take Profit, max $100 Notional)
async function placeOrder(symbol, direction, marginUSD, price, leverage = CONFIG.leverage, risk = null) {
  const side    = direction === "long" ? "buy" : "sell";

  // Max Notional = $100 (Margin × Leverage darf $100 nicht überschreiten)
  const maxNotional = MAX_NOTIONAL_PER_TRADE;
  const cappedMargin = Math.min(marginUSD, maxNotional / leverage);
  const rawSize = (cappedMargin * leverage) / price;
  const size    = Math.max(rawSize, 0.001).toFixed(4);

  // Preis-Precision: kleine Coins brauchen mehr Dezimalstellen
  const decimals = price < 1 ? 6 : price < 10 ? 4 : 2;
  const tpPercent = risk?.tpPercent ?? CONFIG.tpPercent;
  const slPercent = risk?.slPercent ?? CONFIG.slPercent;
  const useTakeProfit = risk?.useTakeProfit !== false;
  const tpPrice = direction === "long"
    ? (price * (1 + tpPercent / 100)).toFixed(decimals)
    : (price * (1 - tpPercent / 100)).toFixed(decimals);
  const slPrice = direction === "long"
    ? (price * (1 - slPercent / 100)).toFixed(decimals)
    : (price * (1 + slPercent / 100)).toFixed(decimals);

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
    presetStopLossPrice:    slPrice,
  };
  if (useTakeProfit) {
    body.presetStopSurplusPrice = tpPrice;
  }

  let res = await bitgetRequest("POST", path, body);
  if (res.code !== "00000" && String(res.msg || "").toLowerCase().includes("stop loss")) {
    console.warn(`  [order] Stop-Loss wurde von Bitget abgelehnt, retry ohne Exchange-SL: ${res.msg}`);
    delete body.presetStopLossPrice;
    res = await bitgetRequest("POST", path, body);
  }
  if (res.code !== "00000") throw new Error(`${res.msg} (${res.code})`);
  return { orderId: res.data?.orderId, tpPrice, slPrice, size, notional: cappedMargin * leverage };
}

// ─── Signal-Logik ─────────────────────────────────────────────────────────────

// Spike-Erkennung: Preis hat sich in letzten N Kerzen um X% bewegt
function detectSpike(closes, lookback = 3, minPct = 2.5) {
  if (closes.length < lookback + 1) return { spike: null, pct: 0 };
  const base  = closes[closes.length - 1 - lookback];
  const now   = closes.at(-1);
  const pct   = (now - base) / base * 100;
  if (pct >= minPct)  return { spike: "up",   pct };
  if (pct <= -minPct) return { spike: "down", pct };
  return { spike: null, pct };
}

function getSignal(structure, chart, rsi3, news, marketSentiment, liquidityBias, closes, symOverrides = {}, existingDirection = null) {
  const results = [];
  const check = (label, cond, req, actual) => {
    results.push({ label, pass: cond });
    console.log(`  ${cond ? "✅" : "🚫"} ${label} → Soll: ${req} | Ist: ${actual}`);
  };

  const price = structure.price;
  const maxDist = symOverrides.maxVwapDistPct ?? 1.8;
  const distSupportPct = Math.abs((price - structure.support) / price) * 100;
  const distResistancePct = Math.abs((structure.resistance - price) / price) * 100;
  const trendBull = price > structure.ema20 && structure.ema20 > structure.ema50 && structure.ema50 >= structure.ema200 * 0.995 && chart.trend === "uptrend";
  const trendBear = price < structure.ema20 && structure.ema20 < structure.ema50 && structure.ema50 <= structure.ema200 * 1.005 && chart.trend === "downtrend";
  const levels = nearestLevels(structure, structure.currentSession);
  const openWindow = getOpenWindowState(structure);
  const breakoutUp = price > levels.breakoutHigh * 1.001;
  const breakoutDown = price < levels.breakdownLow * 0.999;
  const supportBounce = distSupportPct <= maxDist && rsi3 >= 42 && rsi3 <= 62 && (chart.bullishEngulfing || chart.closeNearHigh);
  const resistanceReject = distResistancePct <= maxDist && rsi3 >= 38 && rsi3 <= 58 && (chart.bearishEngulfing || chart.closeNearLow);
  const nearEma20 = Math.abs((price - structure.ema20) / price) * 100 <= 0.2;
  const nearEma50 = Math.abs((price - structure.ema50) / price) * 100 <= 0.25;
  const nearEma200 = Math.abs((price - structure.ema200) / price) * 100 <= 0.35;
  const nearSupportZone = distSupportPct <= 0.45;
  const nearOpeningRangeLow = structure.openingRange ? Math.abs((price - structure.openingRange.low) / price) * 100 <= 0.25 : false;
  const shortBounceRisk = nearEma20 || nearEma50 || nearEma200 || nearSupportZone || nearOpeningRangeLow;
  const newsBias = news.bias;
  const alignedBullish = newsBias !== "bearish" && marketSentiment.bias !== "bearish" && liquidityBias !== "bearish";
  const alignedBearish = newsBias !== "bullish" && marketSentiment.bias !== "bullish" && liquidityBias !== "bullish";
  const shockBlocksLong = marketSentiment.shock === "bearish";
  const shockBlocksShort = marketSentiment.shock === "bullish";

  if (structure.currentSession === "us" && openWindow.active) {
    if (!openWindow.breakoutUp && !openWindow.breakoutDown) {
      console.log("  US-Open-Regel: Noch kein bestätigter Breakout aus der 15m Opening Range");
      return { allPass: false, direction: null, type: null };
    }
  }

  const { spike, pct: spikePct } = detectSpike(closes, 3, 1.6);
  if (spike === "up" && rsi3 > 78 && alignedBullish && trendBull) {
    console.log("  Trend ist stark bullish – keine voreiligen Shorts gegen Momentum");
  }
  if (spike === "down" && rsi3 < 22 && alignedBearish && trendBear) {
    console.log("  Trend ist stark bearish – keine voreiligen Longs gegen Momentum");
  }

  if (existingDirection === "long" && trendBull && alignedBullish && !shockBlocksLong) {
    console.log("  Bestehender Long-Trend bleibt intakt");
    return { allPass: true, direction: "long", type: breakoutUp ? "trend-add-breakout" : "trend-add-pullback" };
  }
  if (existingDirection === "short" && trendBear && alignedBearish && !shockBlocksShort) {
    console.log("  Bestehender Short-Trend bleibt intakt");
    return { allPass: true, direction: "short", type: breakoutDown ? "trend-add-breakdown" : "trend-add-retest" };
  }

  if (trendBull && alignedBullish && !shockBlocksLong && (breakoutUp || supportBounce)) {
    console.log(`  Richtung: LONG (${breakoutUp ? "Breakout" : "Support-Bounce"})`);
    check("EMA20 > EMA50", structure.ema20 > structure.ema50, "bullischer Trend", `${structure.ema20.toFixed(2)} > ${structure.ema50.toFixed(2)}`);
    check("Preis > EMA20", price > structure.ema20, `>${structure.ema20.toFixed(2)}`, price.toFixed(2));
    check("EMA50 >= EMA200", structure.ema50 >= structure.ema200 * 0.995, `>= ${structure.ema200.toFixed(2)}`, structure.ema50.toFixed(2));
    check("News/Sentiment/Liquidity nicht bearish", alignedBullish, "kein Gegenwind", `${newsBias}/${marketSentiment.bias}/${liquidityBias}`);
    check("Kein bärischer Shock", !shockBlocksLong, "Shock != bearish", marketSentiment.shock);
    check("Chart bestätigt Long", chart.trend === "uptrend" || chart.bullishEngulfing, "uptrend/engulfing", `${chart.trend}${chart.bullishEngulfing ? " + engulfing" : ""}`);
    if (structure.currentSession === "us" && openWindow.active) {
      check("Opening-Range Breakout Up", openWindow.breakoutUp, "true", openWindow.breakoutUp ? "bestätigt" : "nein");
    }
    check("Breakout oder Support-Bounce", breakoutUp || supportBounce, "true", breakoutUp ? "breakout" : `support ${distSupportPct.toFixed(2)}%`);
    return { allPass: results.every((r) => r.pass), direction: "long", type: breakoutUp ? "breakout" : "support-bounce" };
  }

  if (trendBear && alignedBearish && !shockBlocksShort && (breakoutDown || resistanceReject)) {
    console.log(`  Richtung: SHORT (${breakoutDown ? "Breakdown" : "Resistance-Reject"})`);
    check("EMA20 < EMA50", structure.ema20 < structure.ema50, "bearischer Trend", `${structure.ema20.toFixed(2)} < ${structure.ema50.toFixed(2)}`);
    check("Preis < EMA20", price < structure.ema20, `<${structure.ema20.toFixed(2)}`, price.toFixed(2));
    check("EMA50 <= EMA200", structure.ema50 <= structure.ema200 * 1.005, `<= ${structure.ema200.toFixed(2)}`, structure.ema50.toFixed(2));
    check("News/Sentiment/Liquidity nicht bullish", alignedBearish, "kein Gegenwind", `${newsBias}/${marketSentiment.bias}/${liquidityBias}`);
    check("Kein bullischer Shock", !shockBlocksShort, "Shock != bullish", marketSentiment.shock);
    check("Chart bestätigt Short", chart.trend === "downtrend" || chart.bearishEngulfing, "downtrend/engulfing", `${chart.trend}${chart.bearishEngulfing ? " + engulfing" : ""}`);
    check("Nicht direkt auf EMA/Support", !shortBounceRisk, "keine Bounce-Zone", shortBounceRisk ? "Bounce-Risiko aktiv" : "frei");
    if (structure.currentSession === "us" && openWindow.active) {
      check("Opening-Range Breakout Down", openWindow.breakoutDown, "true", openWindow.breakoutDown ? "bestätigt" : "nein");
    }
    check("Breakdown oder Resistance-Reject", breakoutDown || resistanceReject, "true", breakoutDown ? "breakdown" : `resistance ${distResistancePct.toFixed(2)}%`);
    return { allPass: results.every((r) => r.pass), direction: "short", type: breakoutDown ? "breakdown" : "resistance-reject" };
  }

  console.log("  Neutral — kein Signal");
  return { allPass: false, direction: null, type: null };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try {
    const raw = readFileSync(LOG_FILE, "utf8").trim();
    if (!raw) return { trades: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { trades: [] };
    if (!Array.isArray(parsed.trades)) parsed.trades = [];
    return parsed;
  } catch (e) {
    console.error(`⚠️  ${LOG_FILE} beschädigt — starte mit leerem Log:`, e.message);
    return { trades: [] };
  }
}
function saveLog(log) {
  try {
    writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.error(`⚠️  Log speichern fehlgeschlagen:`, e.message);
  }
}
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

async function tradeSymbol(symbol, log, marketSentiment) {
  try {
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    console.log(`  ⛔ ${symbol} ist nicht freigegeben. Keine Meme-/Sondersymbole.`);
    return;
  }
  console.log(`\n${"─".repeat(58)}`);
  console.log(`  ${symbol}`);
  console.log("─".repeat(58));
  const symCfg = SYMBOL_OVERRIDES[symbol] || {};
  const meta = getSymbolMeta(symbol);
  const sessionGate = canTradeNow(symbol);
  if (!sessionGate.allowed) {
    console.log(`  ⏸️  ${sessionGate.reason}`);
    return;
  }
  console.log(`  Session: ${sessionGate.session.toUpperCase()} | Asset: ${meta.assetClass.toUpperCase()}`);

  // 1. Position prüfen — bei kleiner Position nachladen bis $100 Notional
  const MAX_NOTIONAL = MAX_NOTIONAL_PER_TRADE;
  const existing = await getOpenPosition(symbol);
  let existingNotional = 0;
  let existingDirection = null;

  if (existing) {
    const markPrice = parseFloat(existing.markPrice || 0);
    existingNotional = parseFloat(existing.total) * markPrice;
    existingDirection = existing.holdSide; // "long" oder "short"

    if (existingNotional >= MAX_NOTIONAL) {
      console.log(`  ⏭️  Position voll ($${existingNotional.toFixed(0)} Notional ≥ $${MAX_NOTIONAL}) — überspringen`);
      return;
    }
    console.log(`  📊 Position offen: ${existingDirection.toUpperCase()} $${existingNotional.toFixed(0)} Notional — Raum bis $${(MAX_NOTIONAL - existingNotional).toFixed(0)} mehr`);
  }

  // 2. Liquidität + Funding (Crypto) & News parallel
  const [liquidityBias, news] = await Promise.all([
    getLiquidityBias(symbol),
    getNewsBias(symbol),
  ]);
  console.log(`  Liquidität: ${liquidityBias.toUpperCase()} | News: ${news.bias.toUpperCase()} (${news.score}) | Markt: ${marketSentiment.bias.toUpperCase()} (${marketSentiment.score})`);

  // 3. Marktdaten
  let candles;
  try { candles = await fetchCandles(symbol, 320); }
  catch (e) { console.log(`  ❌ Keine Daten: ${e.message}`); return; }

  const closes  = candles.map(c => c.close);
  const price   = closes.at(-1);
  const vwapVal = vwap(candles);
  const rsi3    = rsi(closes, 3);
  const structure = getMarketStructure(candles);
  const chart = analyzeChart(candles, structure);

  console.log(`\n  Preis $${price.toFixed(2)}  EMA20 $${structure.ema20?.toFixed(2)||"?"}  EMA50 $${structure.ema50?.toFixed(2)||"?"}  EMA200 $${structure.ema200?.toFixed(2)||"?"}`);
  console.log(`  VWAP $${vwapVal?.toFixed(2)||"?"}  RSI3 ${rsi3?.toFixed(1)||"?"}  ATR ${(structure.atrPct ?? 0).toFixed(2)}%`);
  console.log(`  Chart: ${chart.trend} | HH/HL ${chart.higherHighs}/${chart.higherLows} | LH/LL ${chart.lowerHighs}/${chart.lowerLows}`);
  console.log(`  Candle: bullishEngulfing=${chart.bullishEngulfing} bearishEngulfing=${chart.bearishEngulfing}`);
  console.log(`  Day High/Low: $${structure.dayHigh.toFixed(2)} / $${structure.dayLow.toFixed(2)}`);
  console.log(`  Support/Resistance: $${structure.support.toFixed(2)} / $${structure.resistance.toFixed(2)}`);
  if (structure.asia) console.log(`  Asia High/Low: $${structure.asia.high.toFixed(2)} / $${structure.asia.low.toFixed(2)}`);
  if (structure.europe) console.log(`  Europe High/Low: $${structure.europe.high.toFixed(2)} / $${structure.europe.low.toFixed(2)}`);
  if (structure.us) console.log(`  US High/Low: $${structure.us.high.toFixed(2)} / $${structure.us.low.toFixed(2)}`);
  if (structure.openingRange) console.log(`  Opening 15m High/Low: $${structure.openingRange.high.toFixed(2)} / $${structure.openingRange.low.toFixed(2)}`);

  if (vwapVal === null || rsi3 === null || !structure.ema20 || !structure.ema50 || !structure.ema200) {
    console.log("  ⚠️  Nicht genug Daten");
    return;
  }

  // 4. Signal
  console.log("\n── Signal ──────────────────────────────────────────────\n");
  const { allPass, direction, type: signalType } = getSignal(
    structure,
    chart,
    rsi3,
    news,
    marketSentiment,
    liquidityBias,
    closes,
    symCfg,
    existingDirection
  );

  if (!allPass) return;

  if (!isHighQualitySetup(structure, chart, signalType)) {
    console.log("  ⏭️  Setup verworfen: keine hohe Qualität (zu wenig Volatilität oder kein klarer Trend/Breakout)");
    return;
  }

  // Wenn Position bereits offen: nur in gleiche Richtung nachladen
  if (existing && existingDirection !== direction) {
    console.log(`  🔄 Richtungswechsel: ${existingDirection.toUpperCase()} → ${direction.toUpperCase()} | schließe alte Position zuerst`);
    try {
      if (CONFIG.paperTrading) {
        console.log("  📋 PAPER — würde bestehende Position jetzt schließen");
      } else {
        const closeOrderId = await closePosition(symbol, existing);
        console.log(`  ✅ Position geschlossen #${closeOrderId}`);
      }
    } catch (err) {
      console.log(`  ❌ Konnte Gegenposition nicht schließen: ${err.message}`);
      return;
    }
    return;
  }
  if (existing) {
    console.log(`  ➕ Nachladen in bestehende ${direction.toUpperCase()} Position`);
  }

  // 5. Gebühren-Check
  console.log("\n── Gebühren ────────────────────────────────────────────\n");
  const maxSize = Math.min(symCfg.maxTradeSizeUSD ?? meta.maxTradeSizeUSD ?? CONFIG.maxTradeSizeUSD, MAX_NOTIONAL_PER_TRADE);
  const lev     = symCfg.leverage        ?? meta.leverage ?? CONFIG.leverage;
  // Ziel: kleine, aber echte Teilnahme an schnellen Moves. Maximal $100 Notional pro Trade.
  const TARGET_NOTIONAL = existing ? 50 : 100;
  const remainingNotional = MAX_NOTIONAL - existingNotional;
  const notionalCapByPortfolio = CONFIG.portfolioValue * 0.4;
  const targetNotional = Math.max(0, Math.min(TARGET_NOTIONAL, maxSize, remainingNotional, notionalCapByPortfolio));
  const margin = targetNotional / lev;
  if (margin <= 0) {
    console.log("  ⏭️  Kein freier Margin-/Notional-Spielraum mehr");
    return;
  }
  const prelimRisk = deriveRiskParams(direction, price, structure);
  const { ok: feesOk, notional, tpProfit, feeRoundTrip } = feeCheck(margin, lev, prelimRisk.tpPercent);

  if (!feesOk) {
    console.log(`  🚫 Trade unrentabel: Profit $${tpProfit.toFixed(2)} < 5× Gebühren $${(feeRoundTrip*5).toFixed(2)}`);
    return;
  }

  const risk = finalizeRiskParams(direction, price, structure, notional, signalType, !!existing);
  const targetProfit = notional * (risk.tpPercent / 100);
  console.log(`  Setup: ${signalType} | TP +${risk.tpPercent.toFixed(2)}% = +$${targetProfit.toFixed(2)} | SL -${risk.slPercent.toFixed(2)}% = -$${(notional*risk.slPercent/100+feeRoundTrip).toFixed(2)} | Net nach Gebühren: +$${(targetProfit-feeRoundTrip).toFixed(2)}`);
  console.log(`  Ziel: ca. $${targetProfit.toFixed(2)} Gewinn${risk.useTakeProfit ? " mit TP" : " ohne fixes TP, Exit bei Richtungswechsel"}`);

  // 6. Order
  console.log(`\n── Order ───────────────────────────────────────────────\n`);
  console.log(`  ${direction.toUpperCase()} ${symbol} | Margin $${margin.toFixed(0)} × ${lev}x = $${notional.toFixed(0)} Notional`);

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, direction, price,
    margin, notional, paperTrading: CONFIG.paperTrading,
    orderPlaced: false, orderId: null, tpPrice: null, slPrice: null,
  };

  if (CONFIG.paperTrading) {
    const tp = direction === "long" ? price*(1+risk.tpPercent/100) : price*(1-risk.tpPercent/100);
    const sl = direction === "long" ? price*(1-risk.slPercent/100) : price*(1+risk.slPercent/100);
    logEntry.orderId = `PAPER-${Date.now()}`;
    logEntry.tpPrice = risk.useTakeProfit ? tp.toFixed(2) : "TREND-RUN";
    logEntry.slPrice = sl.toFixed(2);
    logEntry.orderPlaced = true;
    console.log(`  📋 PAPER — würde ${direction.toUpperCase()} @ ${price.toFixed(2)} | TP ${risk.useTakeProfit ? tp.toFixed(2) : "Trend-Run"} | SL ${sl.toFixed(2)}`);
  } else {
    try {
      await setLeverage(symbol, lev);
      const order = await placeOrder(symbol, direction, margin, price, lev, risk);
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
  try {
    writeCsv(logEntry);
  } catch (e) {
    console.error(`  ⚠️  CSV-Append:`, e.message);
  }
  } catch (err) {
    console.error(`  ❌ ${symbol}:`, err?.message || err);
  }
}

// ─── Haupt ────────────────────────────────────────────────────────────────────

async function run() {
  hydrateBitgetFromEnv();
  try {
    initCsv();
  } catch (e) {
    console.error("initCsv:", e.message);
  }
  const log = loadLog();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BitGet Trading Bot — Professionell");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | ${CONFIG.leverage}x | TP ${CONFIG.tpPercent}% | SL ${CONFIG.slPercent}%`);
  console.log("═══════════════════════════════════════════════════════════");

  const traded = todayCount(log);
  console.log(`\n✅ Trades heute: ${traded} | Kein hartes Tageslimit, Trend-Nachladen aktiv`);

  const symbols = getActiveSymbols();
  const marketSentiment = await getMarketSentiment();
  const openPositions = await getAllOpenPositions();
  const unsupportedPositions = openPositions.filter((p) => !symbols.includes(p.symbol));
  if (unsupportedPositions.length) {
    const summary = unsupportedPositions
      .map((p) => `${p.symbol}:${p.holdSide}:${parseFloat(p.unrealizedPL || 0).toFixed(2)} USD`)
      .join(" | ");
    console.warn(`⚠️  Fremd-/Altpositionen offen, werden von dieser Strategie nicht aktiv gemanagt: ${summary}`);
  }

  for (const sym of symbols) {
    await tradeSymbol(sym, log, marketSentiment);
  }

  saveLog(log);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--tax-summary")) {
    const lines = existsSync(CSV_FILE) ? readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1) : [];
    const live = lines.filter((l) => l.includes(",LIVE"));
    console.log(
      `\nTrades gesamt: ${lines.length} | Live: ${live.length} | Paper: ${lines.filter((l) => l.includes(",PAPER")).length}`
    );
    return;
  }

  validateBitgetEnv();

  // Ein Durchlauf und Ende — ideal für Windows-Aufgabenplanung / Cron ohne dauernden Prozess
  if (argv.includes("--once")) {
    await run();
    return;
  }

  startHealthServer();

  const INTERVAL_MS = parseInt(process.env.BOT_INTERVAL_MS || "60000", 10);
  const runLoop = async () => {
    try {
      await run();
    } catch (e) {
      console.error("Fehler im Run:", e?.message || e);
    }
    setTimeout(runLoop, INTERVAL_MS);
  };
  console.log(`\n🔄 Bot startet Loop — alle ${INTERVAL_MS / 1000}s\n`);
  runLoop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
