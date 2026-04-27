#!/usr/bin/env node
/**
 * Prüft ob die nötigen Variablen-Namen für Bitget+RAILWAY gesetzt sind (ohne Werte auszugeben).
 * Lokal: node scripts/railway-check.mjs
 * Railway-CLI: railway run node scripts/railway-check.mjs
 */

const need = [
  "BITGET_API_KEY",
  "BITGET_SECRET_KEY",
  "BITGET_PASSPHRASE",
];

const optional = [
  "PAPER_TRADING",
  "BOT_INTERVAL_MS",
  "LEVERAGE",
  "TP_PERCENT",
];

const missing = need.filter((k) => !process.env[k]?.trim());

console.log("── Bitget-Bot Railway-Check ──\n");
if (missing.length) {
  console.error("❌ Fehlende Pflicht-Variablen:", missing.join(", "));
  console.error("   In Railway: Service → Variables → hinzufügen (oder railway variables set …)");
  process.exit(1);
}
console.log("✅ Pflicht-Variablen sind gesetzt (Werte werden nicht angezeigt).");

const warn = [];
if (process.env.SKIP_HEALTH_SERVER === "true") {
  warn.push("SKIP_HEALTH_SERVER=true — auf Railway wird das im Code ignoriert; besser Variable löschen.");
}
if (!process.env.PORT && !process.env.RAILWAY_ENVIRONMENT) {
  warn.push("Lokal: PORT nicht gesetzt (ok). Railway setzt PORT automatisch.");
}

optional.forEach((k) => {
  if (process.env[k] !== undefined) console.log(`   ${k}=…`);
});

if (warn.length) {
  console.log("\n⚠️  Hinweise:");
  warn.forEach((w) => console.log(`   - ${w}`));
}

console.log("\n✅ Bereit für Deploy. Healthcheck: GET /health auf $PORT");
process.exit(0);
