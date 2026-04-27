# Bitget-Bot — Steuerung für Claude Code / Agent

## Projekt

- **Pfad:** `C:\Users\gl_fa\trading\bitget-tv`
- **Einstieg:** `bot.js` (ESM, Node 18+)
- **Lokal:** `.env` aus `.env.example` kopieren.

## Befehle

| Aktion | Befehl |
|--------|--------|
| Abhängigkeiten | `npm install` |
| Dauerbetrieb (Loop) | `npm start` |
| Ein Durchlauf (Task Scheduler) | `npm run once` |
| Steuer-Zusammenfassung | `npm run tax-summary` |
| **Railway-Variablen prüfen (ohne Secrets)** | `npm run railway-check` |

## Railway — 24/7 im Hintergrund

**Wichtig:** Ein Agent kann **nicht** direkt in dein Railway-Dashboard einloggen. Du oder der Nutzer müssen Einstellungen in der Web-UI setzen oder die **Railway CLI** (`railway login`, `railway link`, `railway variables`) nutzen. Dieses Repo liefert **Config-as-Code** (`railway.json`) + Healthcheck, damit Deployments stabil werden.

### Checkliste (Dashboard)

1. **Service-Typ:** normaler **Web/Worker**-Service mit **Start Command** `node bot.js` (steht in `railway.json`).
2. **Kein Cron-Job** für diesen Service — der Bot hat eine **eigene Schleife** (`BOT_INTERVAL_MS`, Standard 60 s). Nur **ein** laufender Prozess.
3. **Variablen** (gleiche Namen wie lokal):
   - `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` (Pflicht)
   - optional: `PAPER_TRADING`, `LEVERAGE`, `TP_PERCENT`, `BOT_INTERVAL_MS`, …
4. **`SKIP_HEALTH_SERVER` auf Railway nicht setzen** (oder löschen). Der Code **erzwingt** auf Railway einen Listener auf **`PORT`** — nötig für den **Healthcheck** (`/health`).
5. **Deploy:** Push zu GitHub → Railway baut aus dem Repo; oder `railway up`.

### Was `railway.json` macht

- `healthcheckPath`: `/health` — Railway wartet auf HTTP 200, bevor der Deploy „live“ geht.
- `healthcheckTimeout`: 120 s — ggf. in Railway unter Settings erhöhen, wenn der Start langsam ist.
- `restartPolicyType`: `ON_FAILURE` — bei Crash Neustart.

### Nach dem Deploy prüfen

- Logs: Zeile `🩺 Health: http://0.0.0.0:…/health` und kein sofortiger Exit wegen fehlender Bitget-Keys.
- Lokal simulieren: `npm run railway-check` (mit gesetzten Umgebungsvariablen).

## Umgebung

- Pflicht: `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` (siehe `.env.example`).
- Live-Orders: `PAPER_TRADING=false` — nur mit ausdrücklicher Nutzer-Zustimmung.
- Lokal ohne Port: `SKIP_HEALTH_SERVER=true`.

## Agent-Regeln

- `.env` / API-Secrets niemals committen oder im Klartext posten.
- Vor Live-Trading den Nutzer fragen; Standard ist Paper-Trading.
- Logs: Konsole; `safety-check-log.json`, `trades.csv` im Projektordner.
