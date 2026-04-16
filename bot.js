import { Hono } from "hono";

const app = new Hono();

const TELEGRAM_BOT_TOKEN = Bun.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = Bun.env.TELEGRAM_CHAT_ID ?? Bun.env.TELEGRAM_USER_ID;
const LOOP_INTERVAL_MINUTES = parseInt(Bun.env.LOOP_INTERVAL_MINUTES ?? "5", 10);
const MAX_MARKETS = parseInt(Bun.env.MAX_MARKETS ?? "50", 10);
const SEND_SCAN_COMPLETE_EVERY_N_SCANS = parseInt(Bun.env.SEND_SCAN_COMPLETE_EVERY_N_SCANS ?? "1", 10);

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function pickQuestion(market: any): string {
  return market?.question ?? market?.title ?? market?.name ?? market?.slug ?? "Unknown market";
}

function pickMarketId(market: any): string {
  return market?.slug ?? market?.id ?? market?.conditionId ?? "";
}

// ── Signal-Speicher (für /signals Endpoint) ───────────────────────────────────

interface SignalEntry {
  question: string;
  type: "bullish" | "bearish";
  volume24h: number;
  priceChange: number;
  volLiqRatio: number;
}

let latestSignals: {
  bullish: SignalEntry[];
  bearish: SignalEntry[];
  bias: "bullish" | "bearish" | "neutral";
  scannedAt: string;
  marketsScanned: number;
} = { bullish: [], bearish: [], bias: "neutral", scannedAt: "", marketsScanned: 0 };

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegramMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.error("Telegram env missing"); return; }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text: message,
        parse_mode: "HTML", disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || data?.ok === false)
      console.error("Telegram failed:", { status: resp.status, desc: data?.description });
  } catch (e) { console.error("Telegram Error:", e); }
}

// ── Polymarket API ────────────────────────────────────────────────────────────

async function getPolymarketMarkets(): Promise<any[]> {
  try {
    const url = `https://gamma-api.polymarket.com/markets?active=true&limit=${MAX_MARKETS}&order=volume24hr&ascending=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.error("Gamma API error:", res.status); return []; }
    const json = await res.json();
    const markets = Array.isArray(json) ? json : (json?.data ?? json?.markets ?? []);
    return Array.isArray(markets) ? markets : [];
  } catch (e) { console.error("Polymarket API Error:", e); return []; }
}

// ── Signal-Erkennung ──────────────────────────────────────────────────────────

async function detectInsiderActivity(market: any) {
  const volume24h = toNum(market?.volume24hr) || toNum(market?.volumeNum) || toNum(market?.volume);
  const liquidity = toNum(market?.liquidityNum) || toNum(market?.liquidity);
  const priceChange = toNum(market?.oneDayPriceChange) * 100;
  const volLiqRatio = liquidity > 0 ? volume24h / liquidity : 0;

  if (volume24h === 0 && priceChange === 0) return { detected: false, debug: "missing_metrics" };

  const VOLUME_USD_MIN    = parseFloat(Bun.env.VOLUME_USD_MIN ?? "10000");
  const PRICE_MOVE_MIN    = parseFloat(Bun.env.PRICE_MOVE_MIN_ABS_PCT ?? "5");
  const VOL_LIQ_RATIO_MIN = parseFloat(Bun.env.VOL_LIQ_RATIO_MIN ?? "2");

  const isLargeVolume = volume24h > VOLUME_USD_MIN;
  const isPriceMove   = Math.abs(priceChange) > PRICE_MOVE_MIN;
  const isVolumeSpike = volLiqRatio > VOL_LIQ_RATIO_MIN;

  if (!((isLargeVolume && isPriceMove) || isVolumeSpike))
    return { detected: false, debug: "no_threshold_hit" };

  return { detected: true, volume24h, priceChange, volLiqRatio, liquidity,
    signals: { largeVolume: isLargeVolume, volumeSpike: isVolumeSpike, priceMove: isPriceMove } };
}

// ── Scan ──────────────────────────────────────────────────────────────────────

let scanCounter = 0;

async function scanPolymarket() {
  scanCounter++;
  console.log(`\n🔍 Polymarket Scan #${scanCounter}: ${new Date().toISOString()}`);

  const markets = await getPolymarketMarkets();
  if (!markets.length) {
    console.log("❌ Keine Märkte gefunden");
    await sendTelegramMessage(`❌ <b>Polymarket Scan</b>\nMarkets: 0`);
    return;
  }

  if (scanCounter === 1) {
    const s = markets[0] ?? {};
    console.log("DEBUG fields:", { volume24hr: s.volume24hr, oneDayPriceChange: s.oneDayPriceChange, liquidityNum: s.liquidityNum });
  }

  const bullishSignals: SignalEntry[] = [];
  const bearishSignals: SignalEntry[] = [];
  let missingCount = 0;

  for (const market of markets) {
    const activity = await detectInsiderActivity(market) as any;
    if (activity?.debug === "missing_metrics") { missingCount++; continue; }
    if (!activity.detected) continue;

    const question = pickQuestion(market);
    const slug = pickMarketId(market);
    const entry: SignalEntry = {
      question, volume24h: activity.volume24h,
      priceChange: activity.priceChange, volLiqRatio: activity.volLiqRatio,
      type: activity.priceChange >= 0 ? "bullish" : "bearish",
    };

    if (activity.priceChange >= 0) bullishSignals.push(entry);
    else bearishSignals.push(entry);

    const emoji = activity.signals?.volumeSpike ? "🚨" : "⚠️";
    const marketUrl = slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/";

    await sendTelegramMessage(
      `${emoji} <b>Polymarket Insider Signal</b>\n\n` +
      `<b>${question}</b>\n\n` +
      `📊 Volume 24h: $${Math.round(activity.volume24h).toLocaleString()}\n` +
      `💹 Price Move: ${activity.priceChange.toFixed(1)} pp\n` +
      `📈 Vol/Liq: ${activity.volLiqRatio.toFixed(1)}×\n\n` +
      `🔗 <a href="${marketUrl}">Market öffnen</a>`
    );
    console.log(`✅ Alert: ${question}`);
  }

  // Bias berechnen und speichern
  const bias: "bullish" | "bearish" | "neutral" =
    bullishSignals.length > bearishSignals.length + 1 ? "bullish" :
    bearishSignals.length > bullishSignals.length + 1 ? "bearish" : "neutral";

  latestSignals = {
    bullish: bullishSignals, bearish: bearishSignals,
    bias, scannedAt: new Date().toISOString(), marketsScanned: markets.length,
  };

  const total = bullishSignals.length + bearishSignals.length;
  console.log(`📊 Scan #${scanCounter}: ${total} Signale (🟢${bullishSignals.length} 🔴${bearishSignals.length}) | Bias: ${bias.toUpperCase()} | missing: ${missingCount}/${markets.length}`);

  if (scanCounter % SEND_SCAN_COMPLETE_EVERY_N_SCANS === 0) {
    await sendTelegramMessage(
      `📊 <b>Polymarket Scan #${scanCounter}</b>\n` +
      `Märkte: ${markets.length} | Signale: ${total}\n` +
      `Bias: <b>${bias.toUpperCase()}</b> 🟢${bullishSignals.length} 🔴${bearishSignals.length}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Polymarket Insider Bot (Gamma API)");
  console.log(`  Interval: ${LOOP_INTERVAL_MINUTES} min`);
  console.log("═══════════════════════════════════════");

  await sendTelegramMessage("🔍 <b>Polymarket Insider Bot gestartet</b>\nScanne Gamma API nach Insider-Aktivität...");

  while (true) {
    try { await scanPolymarket(); }
    catch (e) {
      console.error("Scan error:", e);
      await sendTelegramMessage(`❌ <b>Bot Error:</b>\n${String(e).slice(0, 180)}`);
    }
    console.log(`⏳ Nächster Scan in ${LOOP_INTERVAL_MINUTES} Minuten...\n`);
    await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MINUTES * 60 * 1000));
  }
}

// ── HTTP Endpoints ────────────────────────────────────────────────────────────

app.get("/health",  (c) => c.json({ status: "ok" }));
app.get("/signals", (c) => c.json(latestSignals));  // ← BitGet Bot ruft das ab

main();
export default { fetch: app.fetch, port: parseInt(Bun.env.PORT || "3000", 10) };
